import { randomUUID } from 'node:crypto';
import type { OutboxJob, PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.js';
import { businessGateReport, loadBusinessData } from '../config/business.config.js';
import type { WhatsAppService } from '../modules/whatsapp/whatsapp.service.js';
import type { WhatsAppTransport } from '../modules/whatsapp/whatsapp.client.js';
import { bindOutboundActions } from '../modules/whatsapp/action-tokens.js';
import { assertCheckoutReady } from '../modules/orders/checkout.js';
import {
  decideWhatsAppSend,
  parseTemplateRegistry,
  type SendPurpose,
} from '../modules/whatsapp/policy.js';
import {
  SheetStructureError,
  type SheetsService,
} from '../modules/sheets/google-sheets.service.js';
import type { NotificationService } from '../modules/notifications/telegram.service.js';
import type { HandoffService } from '../modules/notifications/handoff.service.js';
import { DeliveryError } from '../modules/notifications/delivery-error.js';
import {
  PaymentCreationRejectedError,
  PaymentProviderError,
  type PaymentProvider,
} from '../modules/payments/payment-provider.interface.js';
import { PaymentService } from '../modules/payments/payment.service.js';
import type { CatalogService } from '../modules/knowledge/catalog.service.js';
import type { OutboundMessage } from '../types/domain.js';
import { json, lock, type Tx } from '../db/prisma.js';
import { enqueue, retryDelay } from './outbox.js';
import { claimJob, recoverLeases } from './leases.js';
import { errorCode } from '../utils/security.js';
class BlockedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class Worker {
  readonly id = `worker:${randomUUID()}`;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMaintenance = 0;
  constructor(
    private deps: {
      db: PrismaClient;
      env: Env;
      inbox: WhatsAppService;
      whatsapp: WhatsAppTransport;
      sheets: SheetsService;
      notifications: NotificationService;
      provider: PaymentProvider;
      catalog?: CatalogService;
      handoff?: HandoffService;
      onError?: (error: unknown) => void;
    },
  ) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.drain().catch((e) => this.deps.onError?.(e)),
      this.deps.env.WORKER_INTERVAL_MS,
    );
    this.timer.unref();
    void this.drain().catch((e) => this.deps.onError?.(e));
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
  async drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      await recoverLeases(this.deps.db, this.deps.env.MAX_RETRY_ATTEMPTS);
      await this.deps.db.workerHeartbeat.upsert({
        where: { id: this.id },
        create: { id: this.id },
        update: { lastSeenAt: new Date() },
      });
      if (Date.now() - this.lastMaintenance > 60000) {
        await this.maintenance();
        this.lastMaintenance = Date.now();
        // A sheet outage must not stop payment processing or customer conversations.
        if (this.deps.env.GOOGLE_SHEETS_ENABLED && this.deps.env.GOOGLE_SHEETS_SHIPPING_ENABLED)
          try {
            await this.deps.sheets.pollShipments?.();
          } catch (error) {
            this.deps.onError?.(error);
          }
      }
      let lastHeartbeat = Date.now();
      for (let i = 0; i < 100; i++) {
        if (Date.now() - lastHeartbeat > 30000) {
          await this.deps.db.workerHeartbeat.update({
            where: { id: this.id },
            data: { lastSeenAt: new Date() },
          });
          lastHeartbeat = Date.now();
        }
        const incoming = await this.deps.inbox.processOne();
        const outgoing = await this.processJob();
        if (!incoming && !outgoing) break;
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async maintenance() {
    const { db, env } = this.deps;
    const attempts = this.deps.provider.merchantId
      ? await db.paymentAttempt.findMany({
          where: {
            provider: this.deps.provider.name,
            merchantId: this.deps.provider.merchantId,
            status: { in: ['PENDING', 'CREATION_UNKNOWN'] },
            OR: [
              { lastReconcileAt: null },
              { lastReconcileAt: { lt: new Date(Date.now() - env.PAYMENT_RECONCILE_INTERVAL_MS) } },
            ],
            createdAt: { lt: new Date(Date.now() - 60000) },
          },
          take: env.PAYMENT_RECONCILE_BATCH_SIZE,
        })
      : [];
    await db.$transaction(async (tx) => {
      for (const attempt of attempts)
        await enqueue(tx, {
          key: `reconcile:${attempt.id}:${Math.floor(Date.now() / env.PAYMENT_RECONCILE_INTERVAL_MS)}`,
          kind: 'PAYMENT_RECONCILE',
          orderId: attempt.orderId,
          payload: { attemptId: attempt.id },
        });
      const events = await tx.webhookEvent.findMany({
        where: {
          provider: this.deps.provider.name,
          status: { in: ['RECEIVED', 'RETRY'] },
          nextAttemptAt: { lte: new Date() },
          createdAt: { lt: new Date(Date.now() - 60000) },
        },
        take: env.PAYMENT_RECONCILE_BATCH_SIZE,
        orderBy: { sequence: 'asc' },
      });
      for (const event of events)
        await enqueue(tx, {
          key: `payment-event:${event.id}:${Math.floor(Date.now() / env.PAYMENT_RECONCILE_INTERVAL_MS)}`,
          kind: 'PAYMENT_EVENT',
          orderId: event.orderId ?? undefined,
          payload: { eventId: event.id },
        });
      const lag = env.GOOGLE_SHEETS_ENABLED
        ? await tx.order.findMany({
            where: {
              paymentStatus: { in: ['PAID', 'REFUNDED'] },
              sheetSyncStatus: { not: 'LEGACY_RECONCILIATION_REQUIRED' },
            },
            take: 100,
            orderBy: { sheetSyncedAt: 'asc' },
          })
        : [];
      for (const order of lag) {
        const binding = await tx.sheetBinding.findUnique({ where: { orderId: order.id } });
        if (
          order.sheetSyncStatus === 'PENDING' ||
          (binding && binding.syncedOrderVersion < order.version) ||
          (order.sheetSyncedAt && order.sheetSyncedAt.getTime() < Date.now() - 3600000)
        )
          await enqueue(tx, {
            key: `sheet:${order.id}:v${order.version}:reconcile:${Math.floor(Date.now() / 3600000)}`,
            kind: 'SHEETS',
            orderId: order.id,
            payload: {},
          });
      }
      if (env.RETENTION_APPROVED) {
        await tx.message.updateMany({
          where: {
            createdAt: { lt: new Date(Date.now() - env.MESSAGE_RETENTION_DAYS * 86400000) },
            content: { not: null },
          },
          data: { content: null, payload: PrismaJsonNull },
        });
        // Financial events and dedupe identifiers are retained; only completed nonfinancial payloads expire.
        await tx.webhookEvent.updateMany({
          where: {
            provider: { in: ['whatsapp', 'telegram'] },
            status: 'PROCESSED',
            createdAt: { lt: new Date(Date.now() - env.WEBHOOK_RETENTION_DAYS * 86400000) },
          },
          data: { payload: { retainedKeyOnly: true } },
        });
        await tx.actionToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      }
    });
  }
  private async finish(job: OutboxJob, fn?: (tx: Tx) => Promise<void>) {
    return this.deps.db.$transaction(async (tx) => {
      const owned = await tx.outboxJob.updateMany({
        where: {
          id: job.id,
          lockToken: job.lockToken,
          status: 'PROCESSING',
          lockedUntil: { gt: new Date() },
        },
        data: {
          status: 'DONE',
          completedAt: new Date(),
          lockToken: null,
          lockedUntil: null,
          lastError: null,
        },
      });
      if (!owned.count) return false;
      if (fn) await fn(tx);
      return true;
    });
  }
  private async dispatch(job: OutboxJob) {
    const r = await this.deps.db.outboxJob.updateMany({
      where: {
        id: job.id,
        lockToken: job.lockToken,
        status: 'PROCESSING',
        lockedUntil: { gt: new Date() },
      },
      data: { dispatchStartedAt: new Date() },
    });
    if (!r.count) throw new BlockedError('LEASE_LOST');
  }
  private assertPaymentProvider(attempt: { provider: string; merchantId: string }) {
    if (attempt.provider !== this.deps.provider.name)
      throw new BlockedError('PAYMENT_PROVIDER_MISMATCH');
    if (!this.deps.provider.merchantId || attempt.merchantId !== this.deps.provider.merchantId)
      throw new BlockedError('PAYMENT_MERCHANT_MISMATCH');
  }
  async processJob(): Promise<boolean> {
    const { db, env, provider } = this.deps;
    const job = await claimJob(db, env.MAX_RETRY_ATTEMPTS);
    if (!job) return false;
    if (job.kind === 'WHATSAPP' && this.deps.whatsapp.isReady?.() === false) {
      // A disconnected phone is not a failed send. Keep the queue until pairing/reconnection.
      await db.outboxJob.updateMany({
        where: { id: job.id, lockToken: job.lockToken, status: 'PROCESSING' },
        data: {
          status: 'RETRY',
          attempts: { decrement: 1 },
          nextAttemptAt: new Date(Date.now() + 30000),
          lockedUntil: null,
          lockToken: null,
          lastError: 'WHATSAPP_DISCONNECTED',
        },
      });
      return false;
    }
    try {
      if (job.kind === 'WHATSAPP') {
        const customer = await db.customer.findUniqueOrThrow({ where: { id: job.customerId! } });
        const payload = job.payload as unknown as OutboundMessage & {
          paidConfirmation?: boolean;
          consultation?: boolean;
          purpose?: SendPurpose;
          ticketId?: string;
          managerId?: string;
          origin?: string;
          handoffNotice?: boolean;
          conversationVersion?: number;
          templateParameters?: string[];
        };
        if (
          (!env.MANAGER_HANDOFF_ENABLED || !env.TELEGRAM_ENABLED) &&
          (payload.purpose === 'operator_reply' || payload.purpose === 'support_reopen')
        )
          throw new BlockedError('MANAGER_HANDOFF_DISABLED');
        const ticket = payload.ticketId
          ? await db.handoff.findUnique({ where: { id: payload.ticketId } })
          : null;
        const order = job.orderId
          ? await db.order.findUnique({ where: { id: job.orderId } })
          : null;
        if (
          payload.purpose === 'order_shipped' &&
          (!order?.trackingNumber ||
            !order.shippedAt ||
            order.paymentStatus !== 'PAID' ||
            !['SHIPPED', 'COMPLETED'].includes(order.orderStatus) ||
            order.fulfillmentHold ||
            order.reviewRequired)
        )
          throw new BlockedError('SHIPMENT_NOT_SENDABLE');
        const decision = decideWhatsAppSend({
          customer,
          message: payload,
          purpose: payload.purpose ?? (payload.paidConfirmation ? 'order_paid' : 'reply'),
          templateParameters: order
            ? payload.purpose === 'order_shipped'
              ? [order.publicOrderId, order.trackingNumber!]
              : [order.publicOrderId]
            : (payload.templateParameters ?? []),
          registry: parseTemplateRegistry(env.WHATSAPP_TEMPLATE_REGISTRY),
          transport: env.WHATSAPP_TRANSPORT,
          isAiReply:
            !payload.handoffNotice && (payload.consultation === true || payload.origin === 'bot'),
          windowSafetySeconds: env.WHATSAPP_WINDOW_SAFETY_SECONDS,
          operatorTicketOpen: ticket
            ? ['OPEN', 'ASSIGNED'].includes(ticket.status) &&
              ticket.assignedManagerId === payload.managerId
            : false,
        });
        if (!decision.allowed) {
          if (decision.reopen)
            await db.$transaction((tx) =>
              enqueue(tx, {
                key: `reopen:${payload.ticketId}`,
                kind: 'WHATSAPP',
                customerId: customer.id,
                payload: {
                  ...decision.reopen,
                  purpose: 'support_reopen',
                  ticketId: payload.ticketId,
                },
              }),
            );
          throw new BlockedError(decision.code);
        }
        const message = await db.$transaction(async (tx) => {
          const bound = await bindOutboundActions(tx, decision.message, customer.id);
          await tx.outboxJob.updateMany({
            where: { id: job.id, lockToken: job.lockToken },
            data: { payload: json({ ...payload, ...bound }) },
          });
          return bound;
        });
        await db.message.upsert({
          where: { outboxJobId: job.id },
          create: {
            outboxJobId: job.id,
            customerId: customer.id,
            direction: 'outbound',
            type: message.type,
            content:
              'text' in message ? message.text : message.type === 'image' ? message.caption : null,
            payload: json({
              ...message,
              consultation: payload.consultation === true,
              origin: payload.origin,
              handoffNotice: payload.handoffNotice,
              conversationVersion: payload.conversationVersion,
            }),
            deliveryStatus: 'PENDING',
            ticketId: payload.ticketId,
            managerId: payload.managerId,
          },
          update: {},
        });
        // Final state check is adjacent to dispatch; the remote send is never inside a DB transaction.
        const current = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
        if (
          !payload.handoffNotice &&
          (payload.consultation || payload.origin === 'bot') &&
          (current.conversationState === 'HUMAN_HANDOFF' ||
            (payload.conversationVersion !== undefined &&
              payload.conversationVersion !== current.conversationVersion))
        )
          throw new BlockedError('STALE_AI');
        if (payload.purpose === 'operator_reply' && payload.ticketId) {
          const active = await db.handoff.findUnique({ where: { id: payload.ticketId } });
          if (active?.status !== 'ASSIGNED' || active.assignedManagerId !== payload.managerId)
            throw new BlockedError('STALE_OPERATOR');
        }
        await this.dispatch(job);
        const externalId = await this.deps.whatsapp.send(customer.whatsappId, message, {
          correlationId: job.id,
        });
        await this.finish(job, async (tx) => {
          const existing = await tx.message.findUniqueOrThrow({ where: { outboxJobId: job.id } });
          await tx.message.update({
            where: { id: existing.id },
            data: {
              whatsappMessageId: externalId,
              acceptedAt: new Date(),
              ...(['PENDING', 'UNKNOWN', 'BLOCKED'].includes(existing.deliveryStatus ?? 'PENDING')
                ? { deliveryStatus: 'ACCEPTED' }
                : {}),
            },
          });
          await tx.webhookEvent.updateMany({
            where: {
              provider: 'whatsapp',
              eventType: 'status',
              status: 'RETRY',
              lastError: 'MESSAGE_NOT_BOUND',
              payload: { path: ['id'], equals: externalId },
            },
            data: { nextAttemptAt: new Date() },
          });
          if (payload.purpose === 'operator_reply')
            await enqueue(tx, {
              key: `operator-accepted:${job.id}`,
              kind: 'TELEGRAM',
              customerId: customer.id,
              payload: {
                text: `Ответ по обращению ${payload.ticketId} принят WhatsApp. Доставка ещё не подтверждена.`,
              },
            });
        });
      } else if (job.kind === 'CREATE_PAYMENT') {
        const { attemptId } = job.payload as { attemptId: string };
        const attempt = await db.paymentAttempt.findUniqueOrThrow({
          where: { id: attemptId },
          include: { order: { include: { customer: true } } },
        });
        if (
          attempt.status !== 'CREATING' ||
          attempt.order.paymentStatus === 'PAID' ||
          attempt.order.orderStatus === 'CANCELLED'
        ) {
          await this.finish(job);
          return true;
        }
        this.assertPaymentProvider(attempt);
        if (provider.name !== 'mock') {
          let readiness;
          try {
            readiness = businessGateReport(loadBusinessData(), {
              mode: 'live',
              catalogReady: this.deps.catalog?.productionReadiness().ready ?? false,
            });
          } catch {
            throw new BlockedError('BUSINESS_DATA_INVALID');
          }
          if (!readiness.ready) throw new BlockedError('BUSINESS_DATA_NOT_APPROVED');
        }
        if (this.deps.catalog) {
          try {
            assertCheckoutReady(
              attempt.order as unknown as import('../types/domain.js').OrderData,
              {
                business: loadBusinessData(),
                catalog: this.deps.catalog,
                mode: provider.name === 'mock' ? 'demo' : 'live',
              },
            );
          } catch {
            throw new BlockedError('CHECKOUT_INVALID');
          }
        }
        if (attempt.order.reviewRequired || attempt.order.fulfillmentHold)
          throw new BlockedError('PAYMENT_REVIEW_REQUIRED');
        if (
          attempt.order.contentVersion !== attempt.orderVersion ||
          attempt.order.totalAmount !== attempt.amount
        )
          throw new BlockedError('CHECKOUT_SNAPSHOT_CHANGED');
        const ids = attempt.order.selectedDiscIds.length
          ? attempt.order.selectedDiscIds
          : attempt.order.discId
            ? [attempt.order.discId]
            : [];
        if (this.deps.catalog && ids.some((id) => !this.deps.catalog!.disc(id)?.available))
          throw new BlockedError('DISC_UNAVAILABLE');
        await this.dispatch(job);
        const payment = await provider.createPayment({
          orderId: attempt.orderId,
          publicOrderId: attempt.order.publicOrderId,
          attemptId,
          merchantReference: attempt.merchantReference,
          orderVersion: attempt.orderVersion,
          amount: attempt.amount,
          currency: 'KZT',
          description: attempt.order.productName,
        });
        await this.finish(job, async (tx) => {
          await lock(tx, `order:${attempt.orderId}`);
          const current = await tx.order.findUniqueOrThrow({ where: { id: attempt.orderId } });
          const updated = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
          if (
            current.contentVersion !== attempt.orderVersion ||
            current.totalAmount !== attempt.amount ||
            (updated.externalPaymentId && updated.externalPaymentId !== payment.externalPaymentId)
          ) {
            const reason =
              updated.externalPaymentId && updated.externalPaymentId !== payment.externalPaymentId
                ? 'CREATION_PAYMENT_ID_MISMATCH'
                : 'ORDER_VERSION_MISMATCH';
            const incident = await tx.paymentIncident.upsert({
              where: { incidentKey: `create-conflict:${attempt.id}` },
              create: {
                incidentKey: `create-conflict:${attempt.id}`,
                orderId: attempt.orderId,
                attemptId: attempt.id,
                reason,
                expectedAmount: String(attempt.amount),
                actualAmount: String(current.totalAmount),
                details: { createdPaymentId: payment.externalPaymentId },
              },
              update: {},
            });
            await tx.order.update({
              where: { id: attempt.orderId },
              data: {
                reviewRequired: true,
                fulfillmentHold: true,
                version: { increment: 1 },
                sheetSyncStatus: current.paidAt ? 'PENDING' : current.sheetSyncStatus,
              },
            });
            if (updated.status !== 'PAID')
              await tx.paymentAttempt.update({
                where: { id: attempt.id },
                data: { status: 'REVIEW_REQUIRED' },
              });
            await enqueue(tx, {
              key: `creation-conflict:${incident.id}`,
              kind: 'TELEGRAM',
              orderId: attempt.orderId,
              payload: { text: `Платёж требует ручной сверки: ${incident.id} (${reason})` },
            });
            return;
          }
          await tx.paymentAttempt.update({
            where: { id: attempt.id },
            data: {
              ...payment,
              ...(['CREATING', 'CREATION_UNKNOWN'].includes(updated.status)
                ? { status: 'PENDING' }
                : {}),
            },
          });
          if (current.paymentStatus === 'PAID' || current.orderStatus === 'CANCELLED') return;
          await tx.order.update({
            where: { id: attempt.orderId },
            data: {
              ...payment,
              paymentProvider: provider.name,
              paymentStatus: 'PENDING',
              checkoutFrozenAt: current.checkoutFrozenAt ?? new Date(),
              version: { increment: 1 },
            },
          });
          await enqueue(tx, {
            key: `payment-link:${attempt.id}`,
            kind: 'WHATSAPP',
            customerId: attempt.order.customerId,
            orderId: attempt.orderId,
            payload: {
              type: 'text',
              text:
                attempt.order.customer.preferredLanguage === 'kk'
                  ? `${attempt.order.publicOrderId}\nСома: ${attempt.amount} ₸\nТөлеу: ${payment.paymentUrl}`
                  : `Заказ ${attempt.order.publicOrderId}\nСумма: ${attempt.amount} ₸\nОплатить: ${payment.paymentUrl}`,
            },
          });
        });
      } else if (job.kind === 'PAYMENT_RECONCILE') {
        const { attemptId } = job.payload as { attemptId: string };
        this.assertPaymentProvider(
          await db.paymentAttempt.findUniqueOrThrow({
            where: { id: attemptId },
            select: { provider: true, merchantId: true },
          }),
        );
        await new PaymentService(db).reconcileAttempt(provider, attemptId, undefined, {
          jobId: job.id,
          lockToken: job.lockToken!,
        });
        await this.finish(job);
      } else if (job.kind === 'PAYMENT_EVENT') {
        const { eventId } = job.payload as { eventId: string };
        const ack = await new PaymentService(db).replayReceivedEvent(eventId, provider, {
          jobId: job.id,
          lockToken: job.lockToken!,
        });
        if (ack.statusCode >= 500)
          throw new PaymentProviderError(
            'Payment event needs reconciliation',
            'PAYMENT_EVENT_DEFERRED',
          );
        await this.finish(job);
      } else if (job.kind === 'SHEETS') {
        if (!env.GOOGLE_SHEETS_ENABLED) throw new BlockedError('GOOGLE_SHEETS_DISABLED');
        const order = await db.order.findUniqueOrThrow({
          where: { id: job.orderId! },
          include: { customer: true },
        });
        if (!['PAID', 'REFUNDED'].includes(order.paymentStatus))
          throw new BlockedError('UNPAID_EXPORT');
        if (order.sheetSyncStatus === 'LEGACY_RECONCILIATION_REQUIRED')
          throw new BlockedError('LEGACY_SHEET_RECONCILIATION_REQUIRED');
        await this.dispatch(job);
        const reference = await this.deps.sheets.sync(order, {
          jobId: job.id,
          lockToken: job.lockToken!,
        });
        await this.finish(job, async (tx) => {
          await tx.order.updateMany({
            where: { id: order.id, version: order.version },
            data: {
              sheetSyncStatus: 'SYNCED',
              sheetRowReference: reference,
              sheetSyncedAt: new Date(),
            },
          });
          const latest = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
          if (latest.version !== order.version)
            await enqueue(tx, {
              key: `sheet:${order.id}:v${latest.version}`,
              kind: 'SHEETS',
              orderId: order.id,
              payload: {},
            });
        });
      } else if (job.kind === 'TELEGRAM') {
        if (!env.TELEGRAM_ENABLED) throw new BlockedError('TELEGRAM_DISABLED');
        const payload = job.payload as {
          text: string;
          ticketId?: string;
          sourceMessageId?: string;
        };
        if (payload.ticketId && !env.MANAGER_HANDOFF_ENABLED)
          throw new BlockedError('MANAGER_HANDOFF_DISABLED');
        await this.dispatch(job);
        const receipt = await this.deps.notifications.send(payload.text);
        await this.finish(job, async (tx) => {
          if (receipt && payload.ticketId && job.customerId)
            await tx.telegramMessageBinding.upsert({
              where: {
                chatId_messageId: { chatId: receipt.chatId, messageId: String(receipt.messageId) },
              },
              create: {
                chatId: receipt.chatId,
                messageId: String(receipt.messageId),
                ticketId: payload.ticketId,
                customerId: job.customerId,
                source: payload.sourceMessageId ?? job.id,
              },
              update: {},
            });
        });
      } else throw new BlockedError('UNKNOWN_JOB_KIND');
    } catch (error) {
      const fresh = await db.outboxJob.findUnique({ where: { id: job.id } });
      if (fresh?.lockToken !== job.lockToken || fresh.status !== 'PROCESSING') return true;
      if (job.kind === 'WHATSAPP') {
        const receipt = await db.message.findUnique({ where: { outboxJobId: job.id } });
        if (
          receipt &&
          ['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(receipt.deliveryStatus ?? '') &&
          receipt.whatsappMessageId
        ) {
          await this.finish(job);
          return true;
        }
      }
      const dispatched = !!fresh.dispatchStartedAt;
      const ambiguous =
        dispatched &&
        ((error instanceof DeliveryError && error.outcome === 'UNKNOWN') ||
          (['WHATSAPP', 'TELEGRAM'].includes(job.kind) &&
            !(error instanceof DeliveryError) &&
            !(error instanceof BlockedError)) ||
          (job.kind === 'CREATE_PAYMENT' && !(error instanceof PaymentCreationRejectedError)));
      const code =
        error instanceof BlockedError ||
        error instanceof DeliveryError ||
        error instanceof SheetStructureError ||
        error instanceof PaymentProviderError
          ? error.code
          : errorCode(error);
      const blocked =
        error instanceof BlockedError ||
        (error instanceof SheetStructureError && error.code !== 'SHEET_LEASE_LOST') ||
        (error instanceof DeliveryError && !error.retryable && !ambiguous) ||
        code.includes('SHEET_STRUCTURE_CHANGED');
      const retryAfter =
        error instanceof DeliveryError || error instanceof PaymentProviderError
          ? error.retryAfterMs
          : undefined;
      const status =
        error instanceof PaymentCreationRejectedError
          ? 'DONE'
          : ambiguous
            ? 'UNKNOWN'
            : blocked
              ? 'BLOCKED'
              : job.attempts >= env.MAX_RETRY_ATTEMPTS
                ? 'DEAD'
                : 'RETRY';
      await db.$transaction(async (tx) => {
        const owned = await tx.outboxJob.updateMany({
          where: { id: job.id, lockToken: job.lockToken, status: 'PROCESSING' },
          data: {
            status,
            lastError: code,
            lockToken: null,
            lockedUntil: null,
            nextAttemptAt: new Date(
              Date.now() +
                Math.max(retryAfter ?? 0, retryDelay(job.attempts) * (1 + Math.random() * 0.1)),
            ),
          },
        });
        if (!owned.count) return;
        if (job.kind === 'WHATSAPP')
          await tx.message.updateMany({
            where: {
              outboxJobId: job.id,
              deliveryStatus: { in: ['PENDING', 'UNKNOWN', 'BLOCKED'] },
            },
            data: {
              deliveryStatus: ambiguous ? 'UNKNOWN' : blocked ? 'BLOCKED' : 'FAILED',
              deliveryError: code,
            },
          });
        if (job.kind === 'CREATE_PAYMENT') {
          const { attemptId } = job.payload as { attemptId: string };
          if (ambiguous) {
            await tx.paymentAttempt.updateMany({
              where: { id: attemptId, status: 'CREATING' },
              data: { status: 'CREATION_UNKNOWN' },
            });
            await tx.order.updateMany({
              where: { id: job.orderId!, paymentStatus: 'CREATING' },
              data: { paymentStatus: 'CREATION_UNKNOWN' },
            });
            await enqueue(tx, {
              key: `reconcile:${attemptId}:unknown`,
              kind: 'PAYMENT_RECONCILE',
              orderId: job.orderId!,
              payload: { attemptId },
            });
          } else if (error instanceof PaymentCreationRejectedError) {
            await tx.paymentAttempt.updateMany({
              where: { id: attemptId, status: 'CREATING' },
              data: { status: 'FAILED' },
            });
            await tx.order.updateMany({
              where: { id: job.orderId!, paymentStatus: 'CREATING' },
              data: {
                paymentStatus: 'FAILED',
                orderStatus: 'AWAITING_CONFIRMATION',
                version: { increment: 1 },
              },
            });
            const customer = job.customerId
              ? await tx.customer.findUnique({ where: { id: job.customerId } })
              : null;
            if (
              customer &&
              customer.currentOrderId === job.orderId &&
              customer.conversationState !== 'HUMAN_HANDOFF'
            ) {
              await tx.customer.update({
                where: { id: customer.id },
                data: {
                  conversationState: 'ORDER_CONFIRMATION',
                  conversationVersion: { increment: 1 },
                },
              });
              await enqueue(tx, {
                key: `creation-rejected:${attemptId}`,
                kind: 'WHATSAPP',
                customerId: customer.id,
                orderId: job.orderId!,
                payload: {
                  type: 'buttons',
                  text:
                    customer.preferredLanguage === 'kk'
                      ? 'Төлем жасалмады. Қайтадан растаңыз.'
                      : 'Провайдер отклонил создание оплаты. Подтвердите повторную попытку.',
                  buttons: [
                    {
                      id: 'ORDER_CONFIRM',
                      title: customer.preferredLanguage === 'kk' ? 'Қайталау' : 'Повторить',
                    },
                  ],
                },
              });
            }
          }
        }
        if (job.kind === 'SHEETS' && job.orderId)
          await tx.order.updateMany({
            where: { id: job.orderId, sheetSyncStatus: { not: 'LEGACY_RECONCILIATION_REQUIRED' } },
            data: { sheetSyncStatus: blocked ? 'BLOCKED' : 'PENDING' },
          });
        if (
          env.TELEGRAM_ENABLED &&
          job.kind !== 'TELEGRAM' &&
          ['UNKNOWN', 'BLOCKED', 'DEAD'].includes(status)
        )
          await enqueue(tx, {
            key: `job-warning:${job.id}:${status}`,
            kind: 'TELEGRAM',
            customerId: job.customerId ?? undefined,
            orderId: job.orderId ?? undefined,
            payload: {
              text: `Требуется проверка задания ${job.id}: ${job.kind}, ${status}, ${code}. Автоматический повтор может быть запрещён.`,
            },
          });
        await tx.auditLog.create({
          data: {
            event: 'outbox_error',
            customerId: job.customerId,
            orderId: job.orderId,
            details: { jobId: job.id, status, attempts: job.attempts, code },
          },
        });
      });
    }
    return true;
  }
}
import { Prisma } from '@prisma/client';
const PrismaJsonNull = Prisma.JsonNull;
