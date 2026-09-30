import type { ConversationState, OrderData } from '../../types/domain.js';
import { normalizePhone } from '../../utils/phone.js';
import { validText } from '../orders/order.validator.js';

export const orderInputStates = new Set<ConversationState>([
  'ORDER_NAME',
  'ORDER_PHONE',
  'ORDER_CITY',
  'ORDER_ADDRESS',
  'ORDER_DISC',
  'ORDER_QUANTITY',
]);
export const immutableOrderStatuses = new Set([
  'PAID',
  'PROCESSING',
  'SHIPPED',
  'COMPLETED',
  'CANCELLED',
  'REFUND_PENDING',
  'REFUNDED',
]);

export function isEditableOrder(
  order: OrderData | null,
): order is OrderData & { paymentStatus: 'NOT_CREATED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' } {
  return Boolean(
    order &&
    !order.checkoutFrozenAt &&
    !immutableOrderStatuses.has(order.orderStatus) &&
    order.paymentStatus !== 'PAID' &&
    order.paymentStatus !== 'REFUNDED' &&
    ['NOT_CREATED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(order.paymentStatus),
  );
}

export function firstMissingField(order: OrderData, maxQuantity: number): ConversationState | null {
  if (!validText(order.recipientName, 2, 80)) return 'ORDER_NAME';
  if (!order.recipientPhone || !normalizePhone(order.recipientPhone)) return 'ORDER_PHONE';
  if (!validText(order.city, 2, 100)) return 'ORDER_CITY';
  if (!validText(order.address, 5, 300)) return 'ORDER_ADDRESS';
  if (!(order.selectedDiscIds?.length ?? (order.discId ? 1 : 0))) return 'ORDER_DISC';
  if (!Number.isSafeInteger(order.quantity) || order.quantity < 1 || order.quantity > maxQuantity)
    return 'ORDER_QUANTITY';
  return null;
}
