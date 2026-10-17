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

const quantityWords: Record<string, number> = {
  один: 1,
  одна: 1,
  одну: 1,
  одно: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  бір: 1,
  екі: 2,
  үш: 3,
  төрт: 4,
  бес: 5,
  алты: 6,
  жеті: 7,
  сегіз: 8,
  тоғыз: 9,
  он: 10,
};
const quantityToken = `(?:[1-9]\\d*|${Object.keys(quantityWords).join('|')})`;
const quantityPhrase = new RegExp(
  `^(?:(?:хочу(?: заказать)?|нужен|нужна|нужно|нужны|возьму|беру|закажу|давайте|мне(?: нужен| нужна| нужно| нужны)?|маған) )?(${quantityToken})(?: (?:комплект(?:а|ов)?|набор(?:а|ов)?|штук(?:а|и|у)?|шт\\.?|жиынтық|дана))?(?:,? (?:пожалуйста|аламын|алғым келеді))?[.!]?$`,
  'u',
);

/** Parse a complete quantity answer; never extract a count from a question or longer message. */
export function parseOrderQuantity(text: string, maxQuantity: number): number | null {
  if (!Number.isSafeInteger(maxQuantity) || maxQuantity < 1 || !validText(text, 1, 300))
    return null;
  const normalized = text.trim().toLocaleLowerCase('ru').replace(/\s+/gu, ' ');
  const token = quantityPhrase.exec(normalized)?.[1];
  if (!token) return null;
  const quantity = quantityWords[token] ?? Number(token);
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= maxQuantity
    ? quantity
    : null;
}

export function validText(value: string | null, min: number, max: number): boolean {
  return Boolean(
    value &&
    value.trim().length >= min &&
    value.trim().length <= max &&
    !Array.from(value).some(
      (character) =>
        (character.charCodeAt(0) < 32 && character !== '\n' && character !== '\r') ||
        character.charCodeAt(0) === 127,
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
