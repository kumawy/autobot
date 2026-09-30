import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type Customer, type WebhookEvent } from '@prisma/client';
import type { ConversationService } from '../conversation/conversation.service.js';
import type { CatalogService } from '../knowledge/catalog.service.js';
import type {
  CustomerData,
  InboundMessage,
  OrderData,
  ConversationResult,
  OutboundMessage,
} from '../../types/domain.js';
import { json, lock, type Tx } from '../../db/prisma.js';
import { enqueue, retryDelay } from '../../jobs/outbox.js';
import { errorCode } from '../../utils/security.js';
import type { HandoffService } from '../notifications/handoff.service.js';
import type { WhatsAppStatus } from './whatsapp.parser.js';
import { LEASE_MS } from '../../jobs/leases.js';
const customerFields = [
  'preferredLanguage',
  'conversationState',
  'firstUnhandledMessage',
  'currentOrderId',
  'selectedDiscId',
  'selectedDiscIds',
  'editingField',
  'previousState',
  'privacyNoticeVersion',
  'privacyNoticeAt',
  'notificationConsent',
  'notificationConsentAt',
  'notificationConsentVersion',
  'notificationConsentSource',
  'notificationConsentScope',
  'optedOutAt',
] as const;
const orderFields = [
  'publicOrderId',
  'customerId',
  'recipientName',
  'recipientPhone',
  'city',
  'address',
  'productId',
  'discId',
  'quantity',
  'unitPrice',
  'totalAmount',
  'currency',
  'orderStatus',
  'paymentStatus',
  'paymentUrl',
  'contentVersion',
  'version',
  'selectedDiscIds',
  'packageSnapshot',
  'deliverySnapshot',
  'subtotalAmount',
  'deliveryAmount',
  'deliveryMode',
  'configVersion',
  'checkoutFrozenAt',
] as const;
function pick(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((k) => k in value).map((k) => [k, (value as Record<string, unknown>)[k]]),
  );
}
export class WhatsAppService {
  constructor(
    private db: PrismaClient,
    private conversation: ConversationService,
    private catalog: CatalogService,
    private providerName: string,
    private maxAttempts: number,
    private options: { handoff?: HandoffService; merchantId?: string } = {},
  ) {}
  async receive(messages: InboundMessage[], statuses: WhatsAppStatus[] = []): Promise<void> {
    const now = new Date();
    await this.db.webhookEvent.createMany({
      data: [
        ...messages.map((m) => ({
          provider: 'whatsapp',
          externalEventId: m.id,
          eventType: 'message',
          payload: json(m),
          payloadHash: createHash('sha256').update(JSON.stringify(m)).digest('hex'),
          authenticatedAt: now,
        })),
        ...statuses.map((s) => ({
          provider: 'whatsapp',
          externalEventId: s.externalEventKey,
          eventType: 'status',
          payload: json(s),
          payloadHash: createHash('sha256').update(JSON.stringify(s)).digest('hex'),
          authenticatedAt: now,
        })),
      ],
      skipDuplicates: true,
    });
  }
  private async claim() {
    return this.db.$transaction(async (tx) => {
      const events = await tx.$queryRaw<
        WebhookEvent[]
      >`SELECT e.* FROM "WebhookEvent" e WHERE provider='whatsapp' AND status IN ('RECEIVED','RETRY') AND "nextAttemptAt"<=now() AND attempts<${this.maxAttempts}
      AND ("eventType"='status' OR NOT EXISTS(SELECT 1 FROM "Customer" c WHERE c."whatsappId"=e.payload->>'from' AND c."processingUntil">now()))
      AND ("eventType"='status' OR NOT EXISTS(SELECT 1 FROM "WebhookEvent" prior WHERE prior.provider='whatsapp' AND prior."eventType"='message' AND prior.status IN ('RECEIVED','RETRY','PROCESSING') AND prior.payload->>'from'=e.payload->>'from' AND prior.sequence<e.sequence))
      ORDER BY sequence FOR UPDATE OF e SKIP LOCKED LIMIT 1`;
      const event = events[0];
      if (!event) return null;
      const token = randomUUID();
      let customer: Customer | null = null;
      if (event.eventType === 'message') {
        const m = event.payload as unknown as InboundMessage;
        await lock(tx, `customer-phone:${m.from}`);
        const receivedTimestamp =
          m.timestamp &&
          Number.isFinite(m.timestamp) &&
          m.timestamp > 0 &&
          m.timestamp * 1000 <= Date.now() + 300000
            ? Math.min(m.timestamp * 1000, Date.now())
            : 0;
        customer = await tx.customer.upsert({
          where: { whatsappId: m.from },
          create: { whatsappId: m.from, lastInboundAt: new Date(receivedTimestamp) },
          update: {},
        });
        if (customer.processingUntil && customer.processingUntil > new Date()) return null;
        const timestamp = receivedTimestamp;
        customer = await tx.customer.update({
          where: { id: customer.id },
          data: {
            processingToken: token,
            processingUntil: new Date(Date.now() + LEASE_MS),
            lastInboundAt: new Date(
              Math.max(
                customer.lastInboundAt.getTime() <= Date.now()
                  ? customer.lastInboundAt.getTime()
                  : 0,
                timestamp,
              ),
            ),
          },
        });
        // A new user message reopens the service window, but never revives stale AI/operator jobs.
        await tx.outboxJob.updateMany({
          where: {
            customerId: customer.id,
            kind: 'WHATSAPP',
            status: 'BLOCKED',
            lastError: 'BLOCKED_WINDOW',
          },
          data: { status: 'PENDING', nextAttemptAt: new Date() },
        });
      }
      const claimed = await tx.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: 'PROCESSING',
          lockToken: token,
          lockedUntil: new Date(Date.now() + LEASE_MS),
          attempts: { increment: 1 },
          customerId: customer?.id,
        },
      });
      return { event: claimed, customer, token };
    });
  }
  async processOne(): Promise<boolean> {
    const claimed = await this.claim();
    if (!claimed) return false;
    const { event, customer, token } = claimed;
    try {
      if (event.eventType === 'status') {
        await this.applyStatus(event, token);
        return true;
      }
      if (!customer) throw new Error('MISSING_CUSTOMER');
      const message = structuredClone(event.payload) as unknown as InboundMessage;
      const order = customer.currentOrderId
        ? await this.db.order.findUnique({ where: { id: customer.currentOrderId } })
        : null;
      let invalidAction = false;
      if (message.actionId) {
        const action = await this.db.actionToken.findUnique({ where: { token: message.actionId } });
        if (
          !action ||
          action.customerId !== customer.id ||
          action.expiresAt < new Date() ||
          action.consumedAt ||
          action.conversationVersion !== customer.conversationVersion ||
          action.orderId !== (order?.id ?? null) ||
          action.contentVersion !== (order?.contentVersion ?? null)
        )
          invalidAction = true;
        else message.actionId = action.actionId;
      }
      const history = await this.db.message.findMany({
        where: { customerId: customer.id, payload: { path: ['consultation'], equals: true } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      });
      let result: ConversationResult;
      if (invalidAction) {
        result = {
          customer: customer as CustomerData,
          order: order as OrderData | null,
          messages: [
            {
              type: 'text',
              text:
                customer.preferredLanguage === 'kk'
                  ? 'Бұл батырма ескірген. «Мәзір» деп жазыңыз.'
                  : 'Эта кнопка устарела. Напишите «меню», чтобы продолжить.',
            },
          ],
        };
      } else if (message.text === '[PAYMENT_CREDENTIALS_REDACTED]') {
        result = {
          customer: customer as CustomerData,
          order: order as OrderData | null,
          messages: [
            {
              type: 'text',
              text:
                customer.preferredLanguage === 'kk'
                  ? 'Карта деректерін және кодтарды жібермеңіз.'
                  : 'Не отправляйте реквизиты карты, пароли и коды подтверждения.',
            },
          ],
        };
      } else
        result = await this.conversation.handle({
          customer: customer as CustomerData,
          order: order as OrderData | null,
          message,
          history: history
            .reverse()
            .filter((m) => m.type === 'text' && m.content)
            .map((m) => ({
              role: m.direction === 'inbound' ? 'user' : 'assistant',
              content: m.content!,
            })),
        });
      await this.db.$transaction(async (tx) => {
        await lock(tx, `customer:${customer.id}`);
        if (order) await lock(tx, `order:${order.id}`);
        const current = await tx.customer.findUniqueOrThrow({ where: { id: customer.id } });
        const lease = await tx.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
        if (
          lease.lockToken !== token ||
          lease.status !== 'PROCESSING' ||
          !lease.lockedUntil ||
          lease.lockedUntil <= new Date() ||
          current.processingToken !== token
        )
          return;
        if (current.conversationVersion !== customer.conversationVersion) {
          await tx.webhookEvent.update({
            where: { id: event.id },
            data: {
              status: 'RETRY',
              nextAttemptAt: new Date(),
              lockToken: null,
              lockedUntil: null,
              lastError: 'CONVERSATION_CHANGED',
            },
          });
          await tx.customer.update({
            where: { id: customer.id },
            data: { processingToken: null, processingUntil: null },
          });
          return;
        }
        if (event.payload && !invalidAction && (event.payload as { actionId?: string }).actionId)
          await tx.actionToken.updateMany({
            where: { token: (event.payload as { actionId: string }).actionId, consumedAt: null },
            data: { consumedAt: new Date() },
          });
        await tx.message.upsert({
          where: { whatsappMessageId: message.id },
          create: {
            customerId: customer.id,
            whatsappMessageId: message.id,
            direction: 'inbound',
            type: message.type,
            content: message.text ?? message.actionId ?? null,
            payload: { consultation: customer.conversationState === 'AI_QA' },
          },
          update: {},
        });
        if (result.order) {
          const fields = pick(result.order, orderFields);
          const snapshot = result.order.packageSnapshot;
          const productName = order?.checkoutFrozenAt
            ? order.productName
            : (snapshot?.productNames[result.customer.preferredLanguage ?? 'ru'] ??
              this.catalog.product(result.customer.preferredLanguage ?? 'ru').name);
          const discTitle = order?.checkoutFrozenAt
            ? order.discTitle
            : (snapshot?.discs.map((d) => d.title).join('; ') ??
              this.catalog.disc(result.order.discId ?? '')?.title ??
              null);
          const data = {
            ...fields,
            subtotalAmount:
              result.order.subtotalAmount ?? result.order.unitPrice * result.order.quantity,
            productName,
            discTitle,
          } as Prisma.OrderUncheckedCreateInput;
          // Current financial state wins over a wizard result that was computed earlier.
          if (order) {
            const latest = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
            if (latest.version !== order.version) {
              await tx.webhookEvent.update({
                where: { id: event.id },
                data: {
                  status: 'RETRY',
                  lockToken: null,
                  lockedUntil: null,
                  nextAttemptAt: new Date(),
                },
              });
              await tx.customer.update({
                where: { id: customer.id },
                data: { processingToken: null, processingUntil: null },
              });
              return;
            }
          }
          await tx.order.upsert({
            where: { id: result.order.id },
            create: { ...data, id: result.order.id },
            update: data,
          });
        }
        const nextVersion = customer.conversationVersion + 1;
        await tx.customer.update({
          where: { id: customer.id },
          data: {
            ...pick(result.customer, customerFields),
            conversationVersion: nextVersion,
            processingToken: null,
            processingUntil: null,
          },
        });
        const enriched = result as ConversationResult & { resumeBot?: boolean };
        if (enriched.resumeBot) {
          const tickets = await tx.handoff.findMany({
            where: { customerId: customer.id, status: { in: ['OPEN', 'ASSIGNED'] } },
          });
          for (const ticket of tickets)
            await this.options.handoff?.close(tx, ticket.id, `customer:${customer.id}`);
        }
        if (result.handoff) {
          if (this.options.handoff)
            await this.options.handoff.open(tx, {
              customerId: customer.id,
              orderId: result.order?.id,
              reason: result.handoff.reason,
              previousState: customer.conversationState,
            });
          else
            await tx.handoff.create({
              data: {
                customerId: customer.id,
                reason: result.handoff.reason,
                previousState: customer.conversationState,
              },
            });
        }
        if (
          (customer.conversationState === 'HUMAN_HANDOFF' || result.handoff) &&
          !enriched.resumeBot
        )
          await this.options.handoff?.forward(tx, {
            customerId: customer.id,
            sourceMessageId: message.id,
            text: message.text,
            mediaType:
              message.type === 'unsupported' ? (message.mediaType ?? 'unsupported') : undefined,
          });
        const finalCustomer = await tx.customer.findUniqueOrThrow({ where: { id: customer.id } });
        for (const [index, output] of result.messages.entries()) {
          const encoded = await this.tokenize(
            tx,
            output,
            customer.id,
            result.customer.currentOrderId === result.order?.id ? result.order : null,
            finalCustomer.conversationVersion,
          );
          await enqueue(tx, {
            key: `reply:${event.id}:${index}`,
            kind: 'WHATSAPP',
            customerId: customer.id,
            orderId: result.order?.id,
            payload: {
              ...encoded,
              consultation: result.customer.conversationState === 'AI_QA',
              origin: 'bot',
              handoffNotice: finalCustomer.conversationState === 'HUMAN_HANDOFF',
              conversationVersion: finalCustomer.conversationVersion,
            },
          });
        }
        if (result.createPayment && result.order) {
          const existing = await tx.paymentAttempt.findFirst({
            where: {
              orderId: result.order.id,
              status: { in: ['CREATING', 'CREATION_UNKNOWN', 'PENDING', 'REVIEW_REQUIRED'] },
            },
          });
          if (!existing) {
            const attempt = await tx.paymentAttempt.create({
              data: {
                orderId: result.order.id,
                provider: this.providerName,
                merchantId: this.options.merchantId ?? 'demo',
                merchantReference: randomUUID(),
                amount: result.order.totalAmount,
                currency: 'KZT',
                orderVersion: result.order.contentVersion ?? 1,
                snapshot: json(result.order),
                status: 'CREATING',
              },
            });
            await tx.order.update({
              where: { id: result.order.id },
              data: { paymentStatus: 'CREATING' },
            });
            await enqueue(tx, {
              key: `create-payment:${attempt.id}`,
              kind: 'CREATE_PAYMENT',
              customerId: customer.id,
              orderId: result.order.id,
              payload: { attemptId: attempt.id },
            });
          }
        }
        await tx.webhookEvent.update({
          where: { id: event.id },
          data: {
            status: 'PROCESSED',
            processedAt: new Date(),
            lockToken: null,
            lockedUntil: null,
            lastError: null,
          },
        });
      });
    } catch (error) {
      await this.db.$transaction(async (tx) => {
        const changed = await tx.webhookEvent.updateMany({
          where: { id: event.id, lockToken: token, status: 'PROCESSING' },
          data: {
            status: event.attempts >= this.maxAttempts ? 'DEAD' : 'RETRY',
            lockToken: null,
            lockedUntil: null,
            nextAttemptAt: new Date(Date.now() + retryDelay(event.attempts)),
            lastError: errorCode(error),
          },
        });
        if (changed.count && customer)
          await tx.customer.updateMany({
            where: { id: customer.id, processingToken: token },
            data: { processingToken: null, processingUntil: null },
          });
      });
    }
    return true;
  }
  private async tokenize(
    tx: Tx,
    output: OutboundMessage,
    customerId: string,
    order: OrderData | null,
    version: number,
  ) {
    const result = structuredClone(output);
    const actions =
      result.type === 'buttons' ? result.buttons : result.type === 'list' ? result.rows : [];
    for (const action of actions) {
      const token = await tx.actionToken.create({
        data: {
          customerId,
          orderId: order?.id,
          contentVersion: order?.contentVersion,
          conversationVersion: version,
          actionId: action.id,
          expiresAt: new Date(Date.now() + 7 * 86400000),
        },
      });
      action.id = token.token;
    }
    return result;
  }
  private async applyStatus(event: WebhookEvent, token: string) {
    const receipt = event.payload as unknown as WhatsAppStatus;
    await this.db.$transaction(async (tx) => {
      const lease = await tx.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
      if (lease.lockToken !== token) return;
      const message = await tx.message.findFirst({
        where: {
          OR: [
            { whatsappMessageId: receipt.id },
            ...(receipt.correlationId ? [{ outboxJobId: receipt.correlationId }] : []),
          ],
        },
      });
      if (!message) {
        await tx.webhookEvent.update({
          where: { id: event.id },
          data: {
            status: 'RETRY',
            lockToken: null,
            lockedUntil: null,
            nextAttemptAt: new Date(Date.now() + 60000),
            lastError: 'MESSAGE_NOT_BOUND',
          },
        });
        return;
      }
      await lock(tx, `delivery:${message.id}`);
      const current = await tx.message.findUniqueOrThrow({ where: { id: message.id } });
      const rank: Record<string, number> = {
        PENDING: 0,
        UNKNOWN: 0,
        ACCEPTED: 1,
        SENT: 2,
        FAILED: 2.5,
        DELIVERED: 3,
        READ: 4,
      };
      const incoming = receipt.status.toUpperCase();
      const state = current.deliveryStatus?.toUpperCase() ?? 'PENDING';
      if ((rank[incoming] ?? 0) > (rank[state] ?? 0) || incoming === state) {
        const at = new Date(
          receipt.timestamp ? Math.min(receipt.timestamp * 1000, Date.now()) : Date.now(),
        );
        await tx.message.update({
          where: { id: message.id },
          data: {
            whatsappMessageId: receipt.id,
            deliveryStatus: incoming,
            ...(incoming === 'SENT'
              ? { sentAt: at }
              : incoming === 'DELIVERED'
                ? { deliveredAt: at }
                : incoming === 'READ'
                  ? { readAt: at }
                  : incoming === 'FAILED'
                    ? { failedAt: at, deliveryError: receipt.errorCode ?? 'DELIVERY_FAILED' }
                    : {}),
          },
        });
      }
      if (message.outboxJobId && ['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(incoming))
        await tx.outboxJob.updateMany({
          where: { id: message.outboxJobId, status: 'UNKNOWN' },
          data: { status: 'DONE', completedAt: new Date(), lastError: null },
        });
      if (message.ticketId && ['DELIVERED', 'READ', 'FAILED'].includes(incoming))
        await enqueue(tx, {
          key: `operator-delivery:${message.id}:${incoming === 'FAILED' ? 'failed' : 'delivered'}`,
          kind: 'TELEGRAM',
          customerId: message.customerId,
          payload: {
            text:
              incoming === 'FAILED'
                ? `Ответ по обращению ${message.ticketId} не доставлен. Код: ${receipt.errorCode ?? 'UNKNOWN'}`
                : `Ответ по обращению ${message.ticketId} доставлен клиенту.`,
          },
        });
      await tx.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'PROCESSED', processedAt: new Date(), lockToken: null, lockedUntil: null },
      });
    });
  }
}
