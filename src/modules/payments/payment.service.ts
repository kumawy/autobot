import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient, PaymentAttempt, Order, Customer } from '@prisma/client';
import { lock, json, type Tx } from '../../db/prisma.js';
import { enqueue } from '../../jobs/outbox.js';
import {
  exactDecimal,
  PaymentProviderError,
  type PaymentProvider,
  type PaymentAcknowledgement,
  type PaymentWebhookInput,
  type VerifiedPaymentEvent,
} from './payment-provider.interface.js';

export class PaymentValidationError extends Error {
  override name = 'PaymentValidationError';
}
type Attempt = PaymentAttempt & { order: Order & { customer: Customer } };
export interface PaymentLease {
  jobId: string;
  lockToken: string;
}

type ApplyResult = { duplicate: boolean; incidentId?: string; ack?: PaymentAcknowledgement };
const includeOrder = { order: { include: { customer: true } } } as const;
const fulfilledStages = ['PROCESSING', 'SHIPPED', 'COMPLETED'];
const refundIssues = new Set([
  'REFUND_REQUIRES_REVIEW',
  'REFUND_ID_MISSING',
  'INVALID_REFUND_AMOUNT',
]);

function fingerprint(event: VerifiedPaymentEvent): string {
  // Request salt and transport encodings are deliberately absent from this normalized value.
  const normalized = {
    provider: event.provider,
    merchantId: event.merchantId,
    externalPaymentId: event.externalPaymentId,
    merchantReference: event.merchantReference,
    orderId: event.orderId,
    amount: decimalOrRaw(event.amount),
    currency: event.currency,
    status: event.status,
    operation: event.operation ?? 'PAYMENT',
    operationId: event.operationId,
    verificationIssue: event.verificationIssue,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
function savedAck(value: Prisma.JsonValue | null): PaymentAcknowledgement | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return typeof value.body === 'string' && typeof value.contentType === 'string'
    ? {
        body: value.body,
        contentType: value.contentType,
        statusCode: typeof value.statusCode === 'number' ? value.statusCode : 200,
      }
    : undefined;
}
function decimalOrRaw(amount: number | string | undefined): string | undefined {
  if (amount === undefined) return undefined;
  try {
    return exactDecimal(amount);
  } catch {
    return String(amount);
  }
}

function referenceMatches(attempt: PaymentAttempt, event: VerifiedPaymentEvent): boolean {
  if (!event.merchantReference || event.merchantReference === attempt.merchantReference)
    return true;
  const snapshot = attempt.snapshot;
  return (
    !!attempt.externalPaymentId &&
    event.externalPaymentId === attempt.externalPaymentId &&
    !!snapshot &&
    typeof snapshot === 'object' &&
    !Array.isArray(snapshot) &&
    snapshot.legacyMigration === true &&
    typeof snapshot.legacyMerchantReference === 'string' &&
    snapshot.legacyMerchantReference === event.merchantReference
  );
}

/** Every trusted result, including reconciliation, enters this one financial transition path. */
export class PaymentService {
  constructor(private db: PrismaClient) {}

  async apply(event: VerifiedPaymentEvent, requestId?: string): Promise<ApplyResult> {
    return this.applyVerifiedPaymentResult(event, requestId);
  }

  async receiveWebhook(
    provider: PaymentProvider,
    input: PaymentWebhookInput,
    requestId?: string,
  ): Promise<PaymentAcknowledgement & { statusCode: number }> {
    const event = await provider.verifyWebhook(input);
    return this.acceptAuthenticated(provider, event, input.body, requestId);
  }

  async replayReceivedEvent(
    eventId: string,
    provider: PaymentProvider,
    lease?: PaymentLease,
  ): Promise<PaymentAcknowledgement & { statusCode: number }> {
    const inbox = await this.db.webhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    if (inbox.provider !== provider.name || !inbox.authenticatedAt)
      throw new PaymentValidationError('Event is not an authenticated provider inbox record');
    return this.acceptAuthenticated(
      provider,
      inbox.payload as unknown as VerifiedPaymentEvent,
      undefined,
      undefined,
      lease,
    );
  }

  private async acceptAuthenticated(
    provider: PaymentProvider,
    event: VerifiedPaymentEvent,
    input: unknown,
    requestId?: string,
    lease?: PaymentLease,
  ): Promise<PaymentAcknowledgement & { statusCode: number }> {
    if (event.provider !== provider.name)
      throw new PaymentValidationError('Provider identity mismatch');
    const received = await this.persistReceived(event);
    if (received.ack) return { ...received.ack, statusCode: received.ack.statusCode ?? 200 };
    if (received.processed) {
      const ack = provider.acknowledge(input, true);
      const applied = await this.applyVerifiedPaymentResult(event, requestId, ack, lease);
      return {
        ...(applied.ack ?? ack),
        statusCode: applied.ack?.statusCode ?? ack.statusCode ?? 200,
      };
    }
    let complete = event;
    if (event.needsReconciliation || event.amount === undefined || !event.currency) {
      // Unknown payments are recorded as incidents without guessing which order owns them.
      const attempt = await this.findAttempt(this.db, event);
      if (attempt) {
        try {
          const result = await provider.getPaymentStatus(event.externalPaymentId);
          complete = this.mergeReconciliation(event, result, attempt);
          if (complete.needsReconciliation)
            throw new PaymentProviderError(
              'Incomplete authenticated payment status',
              'STATUS_INCOMPLETE',
            );
        } catch (error) {
          await this.defer(event, attempt, error, lease);
          const ack = provider.acknowledge(input, false);
          return { ...ack, statusCode: ack.statusCode ?? 503 };
        }
      }
    }
    const ack = provider.acknowledge(input, true);
    const applied = await this.applyVerifiedPaymentResult(complete, requestId, ack, lease);
    return {
      ...(applied.ack ?? ack),
      statusCode: applied.ack?.statusCode ?? ack.statusCode ?? 200,
    };
  }

  async reconcileAttempt(
    provider: PaymentProvider,
    attemptId: string,
    requestId?: string,
    lease?: PaymentLease,
  ): Promise<ApplyResult> {
    const attempt = await this.db.paymentAttempt.findUnique({
      where: { id: attemptId },
      include: includeOrder,
    });
    if (!attempt || attempt.provider !== provider.name)
      throw new PaymentValidationError('Payment attempt/provider mismatch');
    // A network call must never run under a transaction or an advisory database lock.
    let event: VerifiedPaymentEvent;
    try {
      if (attempt.externalPaymentId)
        event = await provider.getPaymentStatus(attempt.externalPaymentId);
      else if (provider.getPaymentStatusByReference)
        event = await provider.getPaymentStatusByReference(attempt.merchantReference);
      else
        throw new PaymentProviderError(
          'Provider cannot reconcile creation by reference',
          'REFERENCE_LOOKUP_UNAVAILABLE',
        );
    } catch (error) {
      await this.db.$transaction(async (tx) => {
        await this.assertLease(tx, lease);
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { lastReconcileAt: new Date() },
        });
      });
      // A missing/temporarily unavailable query never proves that a dispatched creation failed.
      throw error;
    }
    if (
      event.provider !== attempt.provider ||
      (event.merchantId && event.merchantId !== attempt.merchantId) ||
      (attempt.externalPaymentId && event.externalPaymentId !== attempt.externalPaymentId) ||
      !referenceMatches(attempt, event)
    ) {
      event = {
        ...event,
        verificationIssue: 'RECONCILIATION_IDENTITY_MISMATCH',
        orderId: attempt.orderId,
      };
    } else {
      event = {
        ...event,
        merchantReference: event.merchantReference ?? attempt.merchantReference,
        merchantId: attempt.merchantId,
      };
    }
    if (event.needsReconciliation || event.amount === undefined || !event.currency) {
      throw new PaymentProviderError(
        'Incomplete authenticated payment status',
        'STATUS_INCOMPLETE',
      );
    }
    const result = await this.applyVerifiedPaymentResult(
      event,
      requestId,
      provider.acknowledge(undefined, true),
      lease,
      attempt.id,
    );
    const deferred = await this.db.webhookEvent.findMany({
      where: {
        provider: provider.name,
        attemptId,
        processedAt: null,
        status: { in: ['RECEIVED', 'RETRY'] },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    for (const item of deferred) {
      const original = item.payload as unknown as VerifiedPaymentEvent;
      const enriched = this.mergeReconciliation(original, event, attempt);
      const ack = provider.acknowledge(undefined, true);
      await this.applyVerifiedPaymentResult(enriched, requestId, ack, lease);
    }
    return result;
  }

  async applyVerifiedPaymentResult(
    event: VerifiedPaymentEvent,
    requestId?: string,
    ack?: PaymentAcknowledgement,
    lease?: PaymentLease,
    reconciledAttemptId?: string,
  ): Promise<ApplyResult> {
    const received = await this.persistReceived(event);
    return this.db.$transaction(
      async (tx) => {
        await this.assertLease(tx, lease);
        await lock(tx, `payment-event:${event.provider}:${event.eventId}`);
        if (reconciledAttemptId) {
          const tracked = await tx.paymentAttempt.findUniqueOrThrow({
            where: { id: reconciledAttemptId },
            select: { orderId: true },
          });
          await lock(tx, `order:${tracked.orderId}`);
          await tx.paymentAttempt.update({
            where: { id: reconciledAttemptId },
            data: { lastReconcileAt: new Date() },
          });
        }
        const inbox = await tx.webhookEvent.findUniqueOrThrow({ where: { id: received.id } });
        if (inbox.processedAt) {
          // Different authenticated financial data with the same operation ID must not disappear.
          const previous = inbox.payload as unknown as VerifiedPaymentEvent;
          if (
            inbox.payloadHash !== fingerprint(event) &&
            fingerprint(previous) !== fingerprint(event)
          ) {
            const attempt = await this.findAttempt(tx, event);
            if (attempt) await lock(tx, `order:${attempt.orderId}`);
            const conflictId = `${event.eventId}:conflict:${fingerprint(event)}`;
            await tx.webhookEvent.upsert({
              where: {
                provider_externalEventId: { provider: event.provider, externalEventId: conflictId },
              },
              create: {
                provider: event.provider,
                externalEventId: conflictId,
                eventType: 'CONFLICTING_PAYMENT_RESULT',
                payload: json(event),
                payloadHash: fingerprint(event),
                authenticatedAt: new Date(),
                status: 'PROCESSED',
                processedAt: new Date(),
                attemptId: attempt?.id,
                orderId: attempt?.orderId,
              },
              update: {},
            });
            const incidentId = await this.incident(
              tx,
              event,
              attempt,
              event.verificationIssue && refundIssues.has(event.verificationIssue)
                ? event.verificationIssue
                : 'CONFLICTING_PAYMENT_RESULT',
              requestId,
            );
            await this.applyRelated(tx, event.relatedEvents ?? [], attempt, requestId);
            const response = savedAck(inbox.acknowledgement) ?? ack;
            if (response && !inbox.acknowledgement)
              await tx.webhookEvent.update({
                where: { id: inbox.id },
                data: { acknowledgement: json(response) },
              });
            return { duplicate: true, incidentId, ack: response };
          }
          const response = savedAck(inbox.acknowledgement) ?? ack;
          if (response && !inbox.acknowledgement)
            await tx.webhookEvent.update({
              where: { id: inbox.id },
              data: { acknowledgement: json(response) },
            });
          if (event.relatedEvents?.length) {
            const attempt = await this.findAttempt(tx, event);
            if (attempt) await lock(tx, `order:${attempt.orderId}`);
            await this.applyRelated(tx, event.relatedEvents, attempt, requestId);
          }
          return { duplicate: true, ack: response };
        }
        let attempt = await this.findAttempt(tx, event);
        if (attempt) {
          await lock(tx, `order:${attempt.orderId}`);
          // Re-read after locking: another callback may have paid this order while we waited.
          attempt = await tx.paymentAttempt.findUniqueOrThrow({
            where: { id: attempt.id },
            include: includeOrder,
          });
        }
        const decision = await this.transition(tx, event, attempt, requestId);
        await tx.webhookEvent.update({
          where: { id: inbox.id },
          data: {
            payload: json(event),
            status: 'PROCESSED',
            processedAt: new Date(),
            lastError: null,
            attemptId: attempt?.id,
            orderId: attempt?.orderId,
            customerId: attempt?.order.customerId,
            ...(ack ? { acknowledgement: json(ack) } : {}),
          },
        });
        const refreshed = attempt
          ? await tx.paymentAttempt.findUniqueOrThrow({
              where: { id: attempt.id },
              include: includeOrder,
            })
          : null;
        await this.applyRelated(tx, event.relatedEvents ?? [], refreshed, requestId);
        return { duplicate: false, ...decision, ack };
      },
      { timeout: 15000 },
    );
  }

  private async applyRelated(
    tx: Tx,
    events: VerifiedPaymentEvent[],
    attempt: Attempt | null,
    requestId?: string,
  ): Promise<void> {
    for (const related of events) {
      // Status responses can carry several refund operations. Preserve each separately.
      const seen = await tx.webhookEvent.findUnique({
        where: {
          provider_externalEventId: {
            provider: related.provider,
            externalEventId: related.eventId,
          },
        },
      });
      if (seen?.processedAt) {
        if (fingerprint(seen.payload as unknown as VerifiedPaymentEvent) !== fingerprint(related))
          await this.incident(tx, related, attempt, 'CONFLICTING_PAYMENT_RESULT', requestId);
        continue;
      }
      await this.transition(tx, related, attempt, requestId);
      await tx.webhookEvent.upsert({
        where: {
          provider_externalEventId: {
            provider: related.provider,
            externalEventId: related.eventId,
          },
        },
        create: {
          provider: related.provider,
          externalEventId: related.eventId,
          eventType: related.operation ?? related.status,
          payload: json(related),
          payloadHash: fingerprint(related),
          authenticatedAt: new Date(),
          status: 'PROCESSED',
          processedAt: new Date(),
          attemptId: attempt?.id,
          orderId: attempt?.orderId,
        },
        update: { status: 'PROCESSED', processedAt: new Date() },
      });
    }
  }

  async resolveIncident(
    id: string,
    input: { actor: string; comment: string; releaseHold?: boolean },
  ): Promise<{ resolved: boolean; hold: boolean }> {
    if (!input.actor.trim() || !input.comment.trim())
      throw new PaymentValidationError('Actor and resolution comment are required');
    return this.db.$transaction(async (tx) => {
      const incident = await tx.paymentIncident.findUnique({ where: { id } });
      if (!incident) throw new PaymentValidationError('Unknown payment incident');
      if (incident.orderId) await lock(tx, `order:${incident.orderId}`);
      else await lock(tx, `payment-incident:${incident.id}`);
      const fresh = await tx.paymentIncident.findUniqueOrThrow({ where: { id } });
      if (fresh.status !== 'RESOLVED')
        await tx.paymentIncident.update({
          where: { id },
          data: {
            status: 'RESOLVED',
            resolvedAt: new Date(),
            resolvedBy: input.actor.trim(),
            resolutionComment: input.comment.trim(),
          },
        });
      let hold = false;
      if (incident.orderId) {
        const open = await tx.paymentIncident.count({
          where: { orderId: incident.orderId, status: 'OPEN' },
        });
        const order = await tx.order.findUniqueOrThrow({ where: { id: incident.orderId } });
        hold = open > 0 || (!input.releaseHold && order.fulfillmentHold);
        const updated = await tx.order.update({
          where: { id: order.id },
          data: {
            reviewRequired: open > 0,
            fulfillmentHold: hold,
            version: { increment: 1 },
            ...(order.paidAt ? { sheetSyncStatus: 'PENDING' } : {}),
          },
        });
        await this.syncSheet(tx, updated);
      }
      await tx.auditLog.create({
        data: {
          event: 'payment_incident_resolved',
          orderId: incident.orderId,
          details: json({ incidentId: id, actor: input.actor, comment: input.comment, hold }),
        },
      });
      return { resolved: true, hold };
    });
  }

  private async persistReceived(
    event: VerifiedPaymentEvent,
  ): Promise<{ id: string; ack?: PaymentAcknowledgement; processed: boolean }> {
    if (!event.eventId || !event.externalPaymentId || !event.provider)
      throw new PaymentValidationError('Incomplete provider identity');
    return this.db.$transaction(async (tx) => {
      await lock(tx, `payment-event:${event.provider}:${event.eventId}`);
      const existing = await tx.webhookEvent.findUnique({
        where: {
          provider_externalEventId: { provider: event.provider, externalEventId: event.eventId },
        },
      });
      if (existing) {
        const previous = existing.payload as unknown as VerifiedPaymentEvent;
        // Enrichment after an incomplete callback may legitimately add amount/currency.
        const same =
          existing.payloadHash === fingerprint(event) ||
          fingerprint(previous) === fingerprint(event);
        return {
          id: existing.id,
          processed: !!existing.processedAt,
          ack: same ? savedAck(existing.acknowledgement) : undefined,
        };
      }
      const attempt = await this.findAttempt(tx, event);
      const created = await tx.webhookEvent.create({
        data: {
          provider: event.provider,
          externalEventId: event.eventId,
          eventType: `${event.operation ?? 'PAYMENT'}:${event.status}`,
          payload: json(event),
          payloadHash: fingerprint(event),
          authenticatedAt: new Date(),
          status: 'RECEIVED',
          attemptId: attempt?.id,
          orderId: attempt?.orderId,
          customerId: attempt?.order.customerId,
        },
      });
      return { id: created.id, processed: false };
    });
  }

  private async findAttempt(
    db: Tx | PrismaClient,
    event: VerifiedPaymentEvent,
  ): Promise<Attempt | null> {
    const byId = await db.paymentAttempt.findFirst({
      where: { provider: event.provider, externalPaymentId: event.externalPaymentId },
      include: includeOrder,
    });
    if (byId) return byId;
    if (!event.merchantReference) return null;
    return db.paymentAttempt.findFirst({
      where: { provider: event.provider, merchantReference: event.merchantReference },
      include: includeOrder,
    });
  }

  private mergeReconciliation(
    original: VerifiedPaymentEvent,
    verified: VerifiedPaymentEvent,
    attempt?: PaymentAttempt,
  ): VerifiedPaymentEvent {
    const mismatch =
      original.provider !== verified.provider ||
      (original.status === 'PAID' &&
        verified.status !== 'PAID' &&
        verified.status !== 'REFUNDED') ||
      original.externalPaymentId !== verified.externalPaymentId ||
      (original.merchantId && verified.merchantId && original.merchantId !== verified.merchantId) ||
      (original.merchantReference &&
        verified.merchantReference &&
        original.merchantReference !== verified.merchantReference &&
        !(attempt && referenceMatches(attempt, original) && referenceMatches(attempt, verified))) ||
      (original.amount !== undefined &&
        verified.amount !== undefined &&
        decimalOrRaw(original.amount) !== decimalOrRaw(verified.amount)) ||
      (original.currency && verified.currency && original.currency !== verified.currency);
    return {
      ...original,
      amount: original.amount ?? verified.amount,
      currency: original.currency ?? verified.currency,
      merchantReference: original.merchantReference ?? verified.merchantReference,
      merchantId: original.merchantId ?? verified.merchantId,
      // Current signed status may advance an old incomplete callback, never infer payment from API pg_status.
      status: verified.status,
      providerStatus: verified.providerStatus,
      needsReconciliation: verified.amount === undefined || !verified.currency,
      relatedEvents: verified.relatedEvents,
      verificationIssue: mismatch
        ? 'RECONCILIATION_DATA_MISMATCH'
        : (original.verificationIssue ?? verified.verificationIssue),
    };
  }

  private async defer(
    event: VerifiedPaymentEvent,
    attempt: Attempt,
    error: unknown,
    lease?: PaymentLease,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.assertLease(tx, lease);
      const deferred = await tx.webhookEvent.updateMany({
        where: { provider: event.provider, externalEventId: event.eventId, processedAt: null },
        data: {
          status: 'RETRY',
          attemptId: attempt.id,
          orderId: attempt.orderId,
          attempts: { increment: 1 },
          lastError: error instanceof PaymentProviderError ? error.code : 'STATUS_LOOKUP_FAILED',
          nextAttemptAt: new Date(Date.now() + 60000),
        },
      });
      if (!deferred.count) return;
      await enqueue(tx, {
        key: `payment-reconcile:inbox:${event.provider}:${event.eventId}`,
        kind: 'PAYMENT_RECONCILE',
        orderId: attempt.orderId,
        payload: { attemptId: attempt.id },
      });
    });
  }

  private async transition(
    tx: Tx,
    event: VerifiedPaymentEvent,
    attempt: Attempt | null,
    requestId?: string,
  ): Promise<{ incidentId?: string }> {
    if (!attempt)
      return { incidentId: await this.incident(tx, event, null, 'UNKNOWN_PAYMENT', requestId) };
    const order = attempt.order;
    let invalid =
      event.verificationIssue && !refundIssues.has(event.verificationIssue)
        ? event.verificationIssue
        : undefined;
    if (
      event.provider !== attempt.provider ||
      (event.merchantId && event.merchantId !== attempt.merchantId)
    )
      invalid = 'MERCHANT_MISMATCH';
    if (
      (event.orderId && event.orderId !== attempt.orderId) ||
      !referenceMatches(attempt, event) ||
      (attempt.externalPaymentId && attempt.externalPaymentId !== event.externalPaymentId)
    )
      invalid = 'PAYMENT_IDENTITY_MISMATCH';
    if ((event.operation ?? 'PAYMENT') !== 'PAYMENT' || event.status === 'REFUNDED') {
      return {
        incidentId: await this.incident(
          tx,
          event,
          attempt,
          invalid ?? 'REFUND_REVIEW_REQUIRED',
          requestId,
        ),
      };
    }
    if (event.amount === undefined || !event.currency || event.needsReconciliation)
      invalid ??= 'INCOMPLETE_PAYMENT_DATA';
    else {
      try {
        if (
          exactDecimal(event.amount) !== exactDecimal(attempt.amount) ||
          exactDecimal(event.amount) !== exactDecimal(order.totalAmount)
        )
          invalid ??= 'AMOUNT_MISMATCH';
      } catch {
        invalid ??= 'INVALID_PROVIDER_AMOUNT';
      }
      if (event.currency !== attempt.currency || event.currency !== order.currency)
        invalid ??= 'CURRENCY_MISMATCH';
    }
    if (attempt.orderVersion !== order.contentVersion) invalid ??= 'ORDER_VERSION_MISMATCH';
    if (event.status === 'REVIEW_REQUIRED') invalid ??= 'UNSUPPORTED_PAYMENT_STATUS';
    if (invalid) {
      if (attempt.status !== 'PAID')
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: 'REVIEW_REQUIRED', providerStatus: event.providerStatus },
        });
      return { incidentId: await this.incident(tx, event, attempt, invalid, requestId) };
    }
    if (!attempt.externalPaymentId)
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: { externalPaymentId: event.externalPaymentId },
      });
    if (event.status === 'PAID') {
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'PAID',
          paidAt: attempt.paidAt ?? new Date(),
          providerStatus: event.providerStatus,
        },
      });
      if (order.appliedPaymentAttemptId && order.appliedPaymentAttemptId !== attempt.id) {
        return {
          incidentId: await this.incident(tx, event, attempt, 'DUPLICATE_PAYMENT', requestId),
        };
      }
      if (order.paymentStatus === 'PAID' && order.appliedPaymentAttemptId === attempt.id) {
        if (event.verificationIssue)
          return {
            incidentId: await this.incident(tx, event, attempt, event.verificationIssue, requestId),
          };
        return {};
      }
      const late =
        order.orderStatus === 'CANCELLED' ||
        order.orderStatus === 'REFUNDED' ||
        order.orderStatus === 'REFUND_PENDING';
      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: 'PAID',
          orderStatus:
            late || fulfilledStages.includes(order.orderStatus) ? order.orderStatus : 'PAID',
          paidAt: order.paidAt ?? new Date(),
          paymentProvider: event.provider,
          externalPaymentId: event.externalPaymentId,
          appliedPaymentAttemptId: attempt.id,
          checkoutFrozenAt: order.checkoutFrozenAt ?? new Date(),
          sheetSyncStatus: 'PENDING',
          version: { increment: 1 },
        },
      });
      await this.syncSheet(tx, updated);
      const reviewReason = late ? 'LATE_PAYMENT' : event.verificationIssue;
      if (reviewReason)
        return {
          incidentId: await this.incident(
            tx,
            event,
            { ...attempt, order: { ...updated, customer: order.customer } },
            reviewReason,
            requestId,
          ),
        };
      if (
        order.customer.currentOrderId === order.id &&
        order.customer.conversationState !== 'HUMAN_HANDOFF'
      ) {
        await tx.customer.update({
          where: { id: order.customerId },
          data: { conversationState: 'PAID', conversationVersion: { increment: 1 } },
        });
      }
      const text =
        order.customer.preferredLanguage === 'kk'
          ? `Төлем қабылданды ✅\n${order.publicOrderId} тапсырысы төленді. Рақмет!`
          : `Оплата получена ✅\nЗаказ ${order.publicOrderId} успешно оплачен. Спасибо за заказ!`;
      await enqueue(tx, {
        key: `paid:${order.id}`,
        kind: 'WHATSAPP',
        customerId: order.customerId,
        orderId: order.id,
        payload: {
          type: 'text',
          text,
          paidConfirmation: true,
          purpose: 'order_paid',
          templateParameters: [order.publicOrderId],
        },
      });
      await enqueue(tx, {
        key: `manager-paid:${order.id}`,
        kind: 'TELEGRAM',
        orderId: order.id,
        payload: {
          text: `💰 Оплачен заказ ${order.publicOrderId}\nКлиент: ${order.recipientName}\nТелефон: ${order.recipientPhone}\nГород: ${order.city}\nАдрес: ${order.address}\nСумма: ${order.totalAmount} ${order.currency}\nОплата: PAID`,
        },
      });
      await tx.auditLog.create({
        data: {
          event: 'payment_verified',
          customerId: order.customerId,
          orderId: order.id,
          requestId,
          details: json({ attemptId: attempt.id }),
        },
      });
      return {};
    }
    // Financial finality is monotonic. Late failures do not undo a confirmed receipt.
    if (attempt.status === 'PAID' || order.appliedPaymentAttemptId === attempt.id) return {};
    if (event.status === 'PENDING') {
      if (attempt.status === 'CREATION_UNKNOWN' && !attempt.paymentUrl) {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: 'REVIEW_REQUIRED', providerStatus: event.providerStatus },
        });
        return {
          incidentId: await this.incident(
            tx,
            event,
            attempt,
            'CREATION_RECOVERED_NO_URL',
            requestId,
          ),
        };
      }
      if (['CREATING', 'CREATION_UNKNOWN', 'NOT_CREATED', 'PENDING'].includes(attempt.status))
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: 'PENDING', providerStatus: event.providerStatus },
        });
      return {};
    }
    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status: event.status, providerStatus: event.providerStatus },
    });
    const latest = await tx.paymentAttempt.findFirst({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
    });
    if (
      latest?.id === attempt.id &&
      !order.paidAt &&
      !order.fulfillmentHold &&
      ['DRAFT', 'AWAITING_CONFIRMATION', 'AWAITING_PAYMENT'].includes(order.orderStatus)
    ) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: event.status,
          orderStatus: 'AWAITING_CONFIRMATION',
          paymentUrl: null,
          version: { increment: 1 },
        },
      });
      if (
        order.customer.currentOrderId === order.id &&
        order.customer.conversationState !== 'HUMAN_HANDOFF'
      )
        await tx.customer.update({
          where: { id: order.customerId },
          data: { conversationState: 'ORDER_CONFIRMATION', conversationVersion: { increment: 1 } },
        });
      await enqueue(tx, {
        key: `failed:${attempt.id}`,
        kind: 'WHATSAPP',
        customerId: order.customerId,
        orderId: order.id,
        payload: {
          type: 'buttons',
          text:
            order.customer.preferredLanguage === 'kk'
              ? 'Төлем аяқталмады. Қайта төлеуге болады.'
              : 'Оплата не завершена. Можно повторить попытку.',
          buttons: [
            {
              id: 'ORDER_CONFIRM',
              title: order.customer.preferredLanguage === 'kk' ? 'Қайталау' : 'Повторить',
            },
            {
              id: 'ORDER_CANCEL',
              title: order.customer.preferredLanguage === 'kk' ? 'Бас тарту' : 'Отменить',
            },
          ],
        },
      });
    }
    return {};
  }

  private async incident(
    tx: Tx,
    event: VerifiedPaymentEvent,
    attempt: Attempt | null,
    reason: string,
    requestId?: string,
  ): Promise<string> {
    const incidentKey = `${event.provider}:${event.merchantId ?? 'unknown'}:${event.externalPaymentId}:${event.operation ?? 'PAYMENT'}:${event.operationId ?? 'capture'}:${reason}`;
    await lock(tx, `payment-incident:${incidentKey}`);
    const existing = await tx.paymentIncident.findUnique({ where: { incidentKey } });
    if (existing) return existing.id;
    const incident = await tx.paymentIncident.create({
      data: {
        incidentKey,
        orderId: attempt?.orderId,
        attemptId: attempt?.id,
        reason,
        expectedAmount: attempt ? String(attempt.amount) : undefined,
        actualAmount: decimalOrRaw(event.amount),
        expectedCurrency: attempt?.currency,
        actualCurrency: event.currency,
        details: json({
          eventId: event.eventId,
          operation: event.operation ?? 'PAYMENT',
          operationId: event.operationId,
          status: event.status,
          providerStatus: event.providerStatus,
        }),
      },
    });
    if (attempt) {
      const order = await tx.order.update({
        where: { id: attempt.orderId },
        data: {
          reviewRequired: true,
          fulfillmentHold: true,
          version: { increment: 1 },
          ...(attempt.order.paidAt ? { sheetSyncStatus: 'PENDING' } : {}),
        },
      });
      await this.syncSheet(tx, order);
      const customer = attempt.order.customer;
      if (customer.currentOrderId === order.id) {
        if (customer.conversationState !== 'HUMAN_HANDOFF')
          await tx.customer.update({
            where: { id: customer.id },
            data: { conversationState: 'HUMAN_HANDOFF', conversationVersion: { increment: 1 } },
          });
        const open = await tx.handoff.findFirst({
          where: { customerId: customer.id, status: { in: ['OPEN', 'ASSIGNED'] } },
        });
        if (!open)
          await tx.handoff.create({
            data: {
              customerId: customer.id,
              reason: 'PAYMENT_PROBLEM',
              previousState: customer.conversationState,
            },
          });
      }
      await enqueue(tx, {
        key: `payment-review:${incident.id}`,
        kind: 'WHATSAPP',
        customerId: order.customerId,
        orderId: order.id,
        payload: {
          type: 'text',
          purpose: 'payment_review',
          templateParameters: [order.publicOrderId],
          text:
            customer.preferredLanguage === 'kk'
              ? `${order.publicOrderId} тапсырысы бойынша төлем тексерілуде. Менеджер сізбен байланысады.`
              : `Проверяем платёж по заказу ${order.publicOrderId}. Менеджер свяжется с вами.`,
        },
      });
    }
    await enqueue(tx, {
      key: `payment-incident:${incident.id}`,
      kind: 'TELEGRAM',
      orderId: attempt?.orderId,
      payload: {
        text: `⚠️ Платёж требует проверки: ${reason}\nЗаказ: ${attempt?.order.publicOrderId ?? 'НЕ НАЙДЕН'}\nПлатёж: ${event.externalPaymentId}\nСумма: ${decimalOrRaw(event.amount) ?? 'не передана'} ${event.currency ?? ''}\nИнцидент: ${incident.id}\nАвтоматический возврат не выполнялся.`,
      },
    });
    await tx.auditLog.create({
      data: {
        event: 'payment_incident_opened',
        orderId: attempt?.orderId,
        customerId: attempt?.order.customerId,
        requestId,
        details: json({ incidentId: incident.id, reason }),
      },
    });
    return incident.id;
  }

  private async assertLease(tx: Tx, lease?: PaymentLease): Promise<void> {
    if (!lease) return;
    const owned = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "OutboxJob" WHERE id=${lease.jobId} AND "lockToken"=${lease.lockToken} AND status='PROCESSING' AND "lockedUntil">now() FOR UPDATE`;
    if (!owned.length)
      throw new PaymentProviderError(
        'Payment worker lease is no longer current',
        'PAYMENT_LEASE_LOST',
      );
  }

  private async syncSheet(tx: Tx, order: Order): Promise<void> {
    if (!order.paidAt) return;
    await enqueue(tx, {
      key: `sheet:${order.id}:v${order.version}`,
      kind: 'SHEETS',
      orderId: order.id,
      payload: {},
    });
  }
}
