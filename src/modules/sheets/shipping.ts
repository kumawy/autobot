import type { PrismaClient, SheetBinding } from '@prisma/client';
import { lock } from '../../db/prisma.js';
import { enqueue } from '../../jobs/outbox.js';
import type { sheets_v4 } from 'googleapis';

export const SHIPPING_HEADERS = ['Трек-номер', 'Посылка отправлена', 'Уведомление клиенту'];
export const shippingJobKey = (orderId: string) => `shipped:${orderId}`;
export const shippingInputRange = (sheetId: number): sheets_v4.Schema$GridRange => ({
  sheetId,
  startRowIndex: 1,
  startColumnIndex: 25,
  endColumnIndex: 27,
});
export function hasShippingInputRange(
  ranges: sheets_v4.Schema$GridRange[] | null | undefined,
  sheetId: number,
): boolean {
  const range = ranges?.[0];
  return (
    ranges?.length === 1 &&
    range?.sheetId === sheetId &&
    range.startRowIndex === 1 &&
    range.endRowIndex == null &&
    range.startColumnIndex === 25 &&
    range.endColumnIndex === 27
  );
}

// Identifiers remain text. Formula cells, URLs and arbitrary chat content are never accepted.
export function parseTrackingNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{8,40}$/.test(normalized) ? normalized : null;
}

export function shipmentText(language: string | null, orderId: string, tracking: string): string {
  return language === 'kk'
    ? `${orderId} тапсырысы Қазпошта арқылы жіберілді 📦\nТрек-нөмір: ${tracking}\nСәлемдемені https://qazpost.kz сайтында бақылай аласыз.`
    : `Заказ ${orderId} отправлен через Казпочту 📦\nТрек-номер: ${tracking}\nОтследить посылку можно на https://qazpost.kz`;
}

/** An immutable shipping confirmation and its notification are committed together. */
export async function acceptSheetShipment(
  db: PrismaClient,
  input: {
    binding: SheetBinding;
    publicOrderId: unknown;
    tracking: unknown;
    confirmed: unknown;
  },
): Promise<string | null> {
  return db.$transaction(async (tx) => {
    await lock(tx, `order:${input.binding.orderId}`);
    const binding = await tx.sheetBinding.findUnique({ where: { id: input.binding.id } });
    const order = await tx.order.findUnique({
      where: { id: input.binding.orderId },
      include: { customer: true },
    });
    if (
      !binding ||
      !order ||
      binding.syncedOrderVersion < 1 ||
      binding.spreadsheetId !== input.binding.spreadsheetId ||
      binding.sheetId !== input.binding.sheetId ||
      binding.rowIndex !== input.binding.rowIndex ||
      input.publicOrderId !== order.publicOrderId
    )
      return 'Ошибка: строка не соответствует заказу. Обратитесь к администратору';
    const tracking = parseTrackingNumber(input.tracking);
    if (order.trackingNumber) {
      if (tracking !== order.trackingNumber || input.confirmed !== true)
        return `Ошибка: отправка уже сохранена (${order.trackingNumber}). Исправление — через администратора`;
      return null;
    }
    if (input.confirmed !== true) {
      if (input.confirmed != null && input.confirmed !== '' && input.confirmed !== false)
        return 'Ошибка: используйте галочку «Посылка отправлена»';
      return input.tracking ? 'Ожидает отметки об отправке' : '';
    }
    if (!tracking) return 'Ошибка: введите трек-номер текстом (8–40 букв/цифр)';
    if (
      order.paymentStatus !== 'PAID' ||
      !order.paidAt ||
      !['PAID', 'PROCESSING'].includes(order.orderStatus) ||
      order.fulfillmentHold ||
      order.reviewRequired
    )
      return 'Ошибка: заказ не разрешён к отправке. Проверьте оплату и статус';
    await lock(tx, `shipping-tracking:${tracking}`);
    if (await tx.order.findUnique({ where: { trackingNumber: tracking } }))
      return 'Ошибка: трек-номер уже используется в другом заказе';
    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        trackingNumber: tracking,
        shippedAt: new Date(),
        orderStatus: 'SHIPPED',
        version: { increment: 1 },
        sheetSyncStatus: 'PENDING',
      },
    });
    await enqueue(tx, {
      key: shippingJobKey(order.id),
      kind: 'WHATSAPP',
      customerId: order.customerId,
      orderId: order.id,
      payload: {
        type: 'text',
        purpose: 'order_shipped',
        text: shipmentText(order.customer.preferredLanguage, order.publicOrderId, tracking),
        templateParameters: [order.publicOrderId, tracking],
      },
    });
    await enqueue(tx, {
      key: `sheet:${order.id}:v${updated.version}`,
      kind: 'SHEETS',
      orderId: order.id,
      payload: {},
    });
    await tx.auditLog.create({
      data: {
        event: 'shipment_confirmed_from_sheet',
        orderId: order.id,
        customerId: order.customerId,
        details: { bindingId: binding.id, rowIndex: binding.rowIndex, trackingNumber: tracking },
      },
    });
    return null;
  });
}

export async function shipmentNotificationStatus(
  db: PrismaClient,
  orderId: string,
  demo: boolean,
): Promise<string> {
  const job = await db.outboxJob.findUnique({ where: { dedupeKey: shippingJobKey(orderId) } });
  if (!job) return 'Ошибка: уведомление не найдено';
  const receipt = await db.message.findUnique({ where: { outboxJobId: job.id } });
  if (['DELIVERED', 'READ'].includes(receipt?.deliveryStatus ?? '')) return 'Доставлено клиенту';
  if (receipt?.deliveryStatus === 'SENT') return 'Отправлено';
  if (['PENDING', 'PROCESSING', 'RETRY'].includes(job.status)) return 'Ожидает отправки';
  if (receipt?.deliveryStatus === 'FAILED') return 'Ошибка: WhatsApp не доставил сообщение';
  if (job.status === 'UNKNOWN') return 'Проверка: результат отправки неизвестен. Повтор запрещён';
  if (job.status === 'BLOCKED') {
    if (job.lastError === 'BLOCKED_CONSENT') return 'Ошибка: нет согласия на уведомления';
    if (job.lastError === 'BLOCKED_TEMPLATE')
      return 'Ошибка: не настроен шаблон WhatsApp об отправке';
    if (job.lastError === 'SHIPMENT_NOT_SENDABLE') return 'Ошибка: заказ требует проверки';
    return 'Ошибка: отправка уведомления заблокирована';
  }
  if (job.status === 'DEAD') return 'Ошибка: уведомление не отправлено';
  if (job.status === 'DONE')
    return demo
      ? 'Демо: уведомление записано, WhatsApp не отправлялся'
      : 'Принято WhatsApp, доставка ещё не подтверждена';
  return 'Ожидает отправки';
}
