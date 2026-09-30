import type { OrderData } from '../../types/domain.js';
import { normalizePhone } from '../../utils/phone.js';

export function calculateTotal(quantity: number, unitPrice = 20_000, maxQuantity = 10): number {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > maxQuantity) {
    throw new Error(`Quantity must be an integer between 1 and ${maxQuantity}`);
  }
  if (
    !Number.isSafeInteger(unitPrice) ||
    unitPrice <= 0 ||
    !Number.isSafeInteger(unitPrice * quantity)
  ) {
    throw new Error('Invalid unit price or total');
  }
  return quantity * unitPrice;
}

export function validText(value: string | null, min: number, max: number): boolean {
  return Boolean(
    value &&
    value.trim().length >= min &&
    value.trim().length <= max &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ),
  );
}

export function validateOrder(
  order: OrderData,
  maxQuantity = 10,
  unitPrice = 20_000,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!validText(order.recipientName, 2, 80)) errors.push('recipientName');
  if (!order.recipientPhone || normalizePhone(order.recipientPhone) !== order.recipientPhone)
    errors.push('recipientPhone');
  if (!validText(order.city, 2, 100)) errors.push('city');
  if (!validText(order.address, 5, 300)) errors.push('address');
  if (!order.productId) errors.push('productId');
  if (!(order.selectedDiscIds?.length ?? (order.discId ? 1 : 0))) errors.push('discId');
  if (order.currency !== 'KZT') errors.push('currency');
  if (order.unitPrice !== unitPrice) errors.push('unitPrice');
  try {
    const subtotal = calculateTotal(order.quantity, unitPrice, maxQuantity);
    if (order.subtotalAmount !== undefined && order.subtotalAmount !== subtotal)
      errors.push('subtotalAmount');
    const delivery = order.deliveryAmount ?? 0;
    if (!Number.isSafeInteger(delivery) || delivery < 0) errors.push('deliveryAmount');
    if (order.totalAmount !== subtotal + delivery) errors.push('totalAmount');
  } catch {
    errors.push('quantity');
  }
  return { valid: errors.length === 0, errors };
}
