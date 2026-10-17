import { z } from 'zod';
import type { ConversationState, Customer, Order, PrismaClient } from '@prisma/client';
import { lock, type Tx } from '../../db/prisma.js';
import { enqueue } from '../../jobs/outbox.js';
import { safeCustomerText, safeEqual } from '../../utils/security.js';
import { safeConsultationText } from '../ai/consultation-history.js';

const telegramUpdate = z.object({
  update_id: z.number().int().nonnegative(),
  message: z
    .object({
      message_id: z.number().int(),
      chat: z.object({ id: z.number().int() }),
      from: z
        .object({ id: z.number().int().positive(), is_bot: z.boolean().optional() })
        .optional(),
      text: z.string().max(4096).optional(),
      reply_to_message: z.object({ message_id: z.number().int() }).optional(),
    })
    .optional(),
});
export class TelegramAuthorizationError extends Error {
  readonly statusCode = 403;
  constructor() {
    super('Telegram update rejected');
    this.name = 'TelegramAuthorizationError';
  }
}
export interface HandoffOptions {
  db: PrismaClient;
  chatId: string;
  allowedManagerIds: string[];
  webhookSecret: string;
}

export class HandoffService {
  constructor(private readonly options: HandoffOptions) {
    if (options.allowedManagerIds.some((id) => !/^\d+$/.test(id)))
      throw new Error('Managers must be numeric Telegram user IDs');
  }

  private async cancelBotReplies(tx: Tx, customerId: string) {
    const pending = await tx.outboxJob.findMany({
      where: { customerId, kind: 'WHATSAPP', status: { in: ['PENDING', 'RETRY', 'BLOCKED'] } },
    });
    const stale = pending.filter((job) => {
      const p = job.payload as { origin?: string; consultation?: boolean; handoffNotice?: boolean };
      return !p.handoffNotice && (p.origin === 'bot' || p.consultation);
    });
    if (stale.length)
      await tx.outboxJob.updateMany({
        where: { id: { in: stale.map((job) => job.id) } },
        data: { status: 'DONE', completedAt: new Date(), lastError: 'HUMAN_HANDOFF' },
      });
  }

  async open(
    tx: Tx,
    input: {
      customerId: string;
      orderId?: string;
      reason: string;
      previousState?: ConversationState;
    },
  ) {
    await lock(tx, `customer:${input.customerId}`);
    const existing = await tx.handoff.findFirst({
      where: { customerId: input.customerId, status: { in: ['OPEN', 'ASSIGNED'] } },
    });
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: input.customerId } });
    await this.cancelBotReplies(tx, customer.id);
    if (existing) {
      if (customer.conversationState !== 'HUMAN_HANDOFF')
        await tx.customer.update({
          where: { id: customer.id },
          data: { conversationState: 'HUMAN_HANDOFF', conversationVersion: { increment: 1 } },
        });
      return existing;
    }
    const ticket = await tx.handoff.create({
      data: {
        customerId: input.customerId,
        reason: input.reason,
        previousState: input.previousState ?? customer.conversationState,
      },
    });
    await tx.customer.update({
      where: { id: customer.id },
      data: { conversationState: 'HUMAN_HANDOFF', conversationVersion: { increment: 1 } },
    });
    const consultation = await tx.message.findMany({
      where: {
        customerId: customer.id,
        type: 'text',
        payload: { path: ['consultation'], equals: true },
      },
      orderBy: { createdAt: 'desc' },
      take: 6,
    });
    const context = consultation.reverse().flatMap((message) => {
      const text = safeConsultationText(message.content);
      return text
        ? [`${message.direction === 'inbound' ? 'Клиент' : 'Бот'}: ${text.slice(0, 350)}`]
        : [];
    });
    const order = input.orderId
      ? await tx.order.findFirst({ where: { id: input.orderId, customerId: customer.id } })
      : null;
    const orderContext = order
      ? [
          `Заказ: ${order.publicOrderId}`,
          `Статус: ${order.orderStatus}; оплата: ${order.paymentStatus}`,
          `Количество комплектов: ${order.quantity}`,
          `Выбранные мелодии: ${safeCustomerText(order.discTitle ?? order.selectedDiscIds.join(', ')).slice(0, 300) || 'ещё не выбраны'}`,
        ].join('\n')
      : 'Заказ ещё не создан.';
    await enqueue(tx, {
      key: `handoff:${ticket.id}:open`,
      kind: 'TELEGRAM',
      customerId: customer.id,
      orderId: input.orderId,
      payload: {
        ticketId: ticket.id,
        customerId: customer.id,
        sourceMessageId: `ticket:${ticket.id}`,
        text: `💬 Обращение ${ticket.id}\nПричина: ${input.reason}\nЯзык: ${customer.preferredLanguage ?? 'не выбран'}\n/claim ${ticket.id}\nОтветьте Reply на это сообщение после принятия обращения.\n\n${orderContext}${context.length ? `\n\nПоследняя консультация:\n${context.join('\n')}` : ''}`,
      },
    });
    await tx.auditLog.create({
      data: {
        event: 'handoff_opened',
        customerId: customer.id,
        orderId: input.orderId,
        details: { ticketId: ticket.id },
      },
    });
    return ticket;
  }

  async forward(
    tx: Tx,
    input: { customerId: string; sourceMessageId: string; text?: string; mediaType?: string },
  ) {
    await lock(tx, `customer:${input.customerId}`);
    const ticket = await tx.handoff.findFirst({
      where: { customerId: input.customerId, status: { in: ['OPEN', 'ASSIGNED'] } },
    });
    if (!ticket) return;
    const content = input.text
      ? safeCustomerText(input.text)
      : `Формат ${input.mediaType ?? 'неизвестный'} не поддерживается мостом. Попросите клиента написать текстом.`;
    await enqueue(tx, {
      key: `handoff:${ticket.id}:incoming:${input.sourceMessageId}`,
      kind: 'TELEGRAM',
      customerId: input.customerId,
      payload: {
        ticketId: ticket.id,
        customerId: input.customerId,
        sourceMessageId: input.sourceMessageId,
        text: `Обращение ${ticket.id}\nКлиент:\n${content}`,
      },
    });
  }

  async bindTelegramMessage(input: {
    ticketId: string;
    customerId: string;
    chatId: string;
    messageId: string;
    sourceMessageId?: string;
  }) {
    if (input.chatId !== this.options.chatId) throw new TelegramAuthorizationError();
    const ticket = await this.options.db.handoff.findUniqueOrThrow({
      where: { id: input.ticketId },
    });
    if (ticket.customerId !== input.customerId) throw new TelegramAuthorizationError();
    await this.options.db.telegramMessageBinding.upsert({
      where: { chatId_messageId: { chatId: input.chatId, messageId: input.messageId } },
      create: {
        chatId: input.chatId,
        messageId: input.messageId,
        ticketId: input.ticketId,
        customerId: input.customerId,
        source: input.sourceMessageId ?? 'ticket',
      },
      update: {},
    });
  }

  async close(tx: Tx, ticketId: string, actorId?: string): Promise<boolean> {
    const initial = await tx.handoff.findUniqueOrThrow({ where: { id: ticketId } });
    await lock(tx, `customer:${initial.customerId}`);
    const ticket = await tx.handoff.findUniqueOrThrow({ where: { id: ticketId } });
    if (actorId && /^\d+$/.test(actorId) && ticket.assignedManagerId !== actorId)
      throw new TelegramAuthorizationError();
    if (ticket.status === 'CLOSED') return false;
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: ticket.customerId } });
    if (customer.currentOrderId) await lock(tx, `order:${customer.currentOrderId}`);
    const order = customer.currentOrderId
      ? await tx.order.findUnique({ where: { id: customer.currentOrderId } })
      : null;
    await tx.handoff.update({
      where: { id: ticket.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    await tx.customer.update({
      where: { id: customer.id },
      data: {
        conversationState: resumedState(customer, order, ticket.previousState),
        conversationVersion: { increment: 1 },
        editingField: null,
      },
    });
    // A closed ticket never delivers an operator answer which was queued earlier.
    await tx.outboxJob.updateMany({
      where: {
        kind: 'WHATSAPP',
        status: { in: ['PENDING', 'RETRY', 'BLOCKED'] },
        payload: { path: ['ticketId'], equals: ticket.id },
      },
      data: { status: 'DONE', completedAt: new Date(), lastError: 'TICKET_CLOSED' },
    });
    await tx.auditLog.create({
      data: {
        event: 'handoff_closed',
        customerId: customer.id,
        details: { ticketId: ticket.id, actorId: actorId ?? 'administrator_or_customer' },
      },
    });
    await enqueue(tx, {
      key: `handoff:${ticket.id}:closed`,
      kind: 'WHATSAPP',
      customerId: customer.id,
      payload: {
        type: 'text',
        purpose: 'reply',
        text:
          customer.preferredLanguage === 'kk'
            ? 'Автоматты көмекші қайта қосылды. Жалғастыру үшін мәзірді ашыңыз.'
            : 'Автоматический помощник снова доступен. Откройте меню, чтобы продолжить.',
      },
    });
    return true;
  }

  async handleUpdate(
    body: unknown,
    secret: string | undefined,
  ): Promise<{ duplicate: boolean; action: string }> {
    if (!secret || !this.options.webhookSecret || !safeEqual(secret, this.options.webhookSecret))
      throw new TelegramAuthorizationError();
    const update = telegramUpdate.parse(body);
    const message = update.message;
    if (
      message &&
      (String(message.chat.id) !== this.options.chatId ||
        !message.from ||
        message.from.is_bot ||
        !this.options.allowedManagerIds.includes(String(message.from.id)))
    )
      throw new TelegramAuthorizationError();
    return this.options.db.$transaction(async (tx) => {
      await lock(tx, `telegram-update:${update.update_id}`);
      const externalEventId = String(update.update_id);
      if (
        await tx.webhookEvent.findUnique({
          where: { provider_externalEventId: { provider: 'telegram', externalEventId } },
        })
      )
        return { duplicate: true, action: 'DUPLICATE' };
      let action = 'IGNORED';
      const actorId = message?.from ? String(message.from.id) : '';
      if (message) {
        const text = safeCustomerText(message.text ?? '');
        const command = /^\/(claim|close)(?:@[A-Za-z0-9_]+)?\s+([0-9a-f-]{36})\s*$/i.exec(text);
        if (command) {
          const ticket = await tx.handoff.findUnique({ where: { id: command[2]! } });
          if (!ticket) action = 'TICKET_NOT_FOUND';
          else if (command[1]!.toLowerCase() === 'close') {
            if (ticket.assignedManagerId !== actorId || ticket.status !== 'ASSIGNED')
              action = 'TICKET_NOT_ASSIGNED';
            else {
              await this.close(tx, ticket.id, actorId);
              action = 'CLOSED';
            }
          } else {
            await lock(tx, `customer:${ticket.customerId}`);
            const claimed = await tx.handoff.updateMany({
              where: { id: ticket.id, status: 'OPEN', assignedManagerId: null },
              data: { status: 'ASSIGNED', assignedManagerId: actorId },
            });
            const current = await tx.handoff.findUniqueOrThrow({ where: { id: ticket.id } });
            action =
              claimed.count ||
              (current.status === 'ASSIGNED' && current.assignedManagerId === actorId)
                ? 'CLAIMED'
                : 'TICKET_UNAVAILABLE';
          }
        } else if (!message.text) action = 'UNSUPPORTED_MEDIA';
        else if (!message.reply_to_message) action = 'REPLY_REQUIRED';
        else {
          const binding = await tx.telegramMessageBinding.findUnique({
            where: {
              chatId_messageId: {
                chatId: this.options.chatId,
                messageId: String(message.reply_to_message.message_id),
              },
            },
          });
          if (!binding) action = 'BINDING_NOT_FOUND';
          else {
            await lock(tx, `customer:${binding.customerId}`);
            const ticket = await tx.handoff.findUniqueOrThrow({ where: { id: binding.ticketId } });
            if (
              ticket.status !== 'ASSIGNED' ||
              ticket.assignedManagerId !== actorId ||
              ticket.customerId !== binding.customerId
            )
              action = 'TICKET_NOT_ASSIGNED';
            else {
              await enqueue(tx, {
                key: `telegram:${update.update_id}:operator`,
                kind: 'WHATSAPP',
                customerId: ticket.customerId,
                payload: {
                  type: 'text',
                  text,
                  purpose: 'operator_reply',
                  ticketId: ticket.id,
                  managerId: actorId,
                  sourceMessageId: String(message.message_id),
                },
              });
              action = 'QUEUED';
            }
          }
        }
        const notices: Record<string, string> = {
          CLAIMED: 'Обращение назначено вам.',
          CLOSED: 'Обращение закрыто.',
          QUEUED: 'Ответ поставлен в очередь. Это ещё не подтверждение принятия API или доставки.',
          UNSUPPORTED_MEDIA: 'Поддерживаются только текстовые ответы.',
          REPLY_REQUIRED: 'Ответьте через Reply на сообщение обращения после /claim.',
          TICKET_NOT_ASSIGNED: 'Обращение закрыто или назначено другому менеджеру.',
          TICKET_UNAVAILABLE: 'Обращение уже принято другим менеджером или закрыто.',
          BINDING_NOT_FOUND: 'Сообщение Reply не связано с обращением.',
          TICKET_NOT_FOUND: 'Обращение не найдено.',
        };
        await enqueue(tx, {
          key: `telegram:${update.update_id}:notice`,
          kind: 'TELEGRAM',
          payload: { text: notices[action] ?? 'Обновление обработано.' },
        });
      }
      await tx.webhookEvent.create({
        data: {
          provider: 'telegram',
          externalEventId,
          eventType: 'update',
          status: 'PROCESSED',
          authenticatedAt: new Date(),
          processedAt: new Date(),
          payload: { action, actorId, messageId: message?.message_id ?? null },
        },
      });
      await tx.auditLog.create({
        data: {
          event: 'telegram_operator_update',
          details: { updateId: update.update_id, action, actorId },
        },
      });
      return { duplicate: false, action };
    });
  }
}

function resumedState(
  customer: Customer,
  order: Order | null,
  previousState: ConversationState | null,
): ConversationState {
  if (!customer.preferredLanguage) return 'AWAITING_LANGUAGE';
  if (!order || order.orderStatus === 'CANCELLED' || order.fulfillmentHold || order.reviewRequired)
    return 'MAIN_MENU';
  if (['PAID', 'REFUNDED', 'REFUND_PENDING'].includes(order.paymentStatus)) return 'PAID';
  if (['PENDING', 'CREATING', 'CREATION_UNKNOWN'].includes(order.paymentStatus))
    return 'PAYMENT_PENDING';
  // The draft's default quantity and incomplete contact fields cannot reveal
  // whether selection, quantity or consent was the interrupted step.
  if (
    !order.checkoutFrozenAt &&
    ['DRAFT', 'AWAITING_CONFIRMATION'].includes(order.orderStatus) &&
    previousState &&
    [
      'ORDER_DISC',
      'ORDER_QUANTITY',
      'ORDER_CITY',
      'ORDER_CONSENT',
      'ORDER_NAME',
      'ORDER_PHONE',
      'ORDER_ADDRESS',
      'ORDER_CONFIRMATION',
    ].includes(previousState)
  )
    return previousState;
  if (!order.selectedDiscIds.length && !order.discId) return 'ORDER_DISC';
  if (order.quantityConfirmed === false) return 'ORDER_QUANTITY';
  if (!order.city) return 'ORDER_CITY';
  if (!order.recipientName) return 'ORDER_NAME';
  if (!order.recipientPhone) return 'ORDER_PHONE';
  if (!order.address) return 'ORDER_ADDRESS';
  if (order.orderStatus === 'AWAITING_CONFIRMATION') return 'ORDER_CONFIRMATION';
  if (order.checkoutFrozenAt) return 'ORDER_CONFIRMATION';
  if (order.orderStatus === 'DRAFT') return 'ORDER_QUANTITY';
  return 'MAIN_MENU';
}
