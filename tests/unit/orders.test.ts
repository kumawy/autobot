import { describe, expect, it } from 'vitest';
import {
  calculateTotal,
  validateOrder,
  validText,
} from '../../src/modules/orders/order.validator.js';
import { normalizePhone } from '../../src/utils/phone.js';
import type { OrderData } from '../../src/types/domain.js';

const order: OrderData = {
  id: 'o1',
  publicOrderId: 'MB-TEST',
  customerId: 'c1',
  recipientName: 'Арман',
  recipientPhone: '+77011234567',
  city: 'Алматы',
  address: 'Абая 10, квартира 12',
  productId: 'music-box-set',
  discId: 'disc_001',
  quantity: 2,
  unitPrice: 20000,
  totalAmount: 40000,
  currency: 'KZT',
  orderStatus: 'AWAITING_CONFIRMATION',
  paymentStatus: 'NOT_CREATED',
  paymentUrl: null,
};

describe('order amounts and required details', () => {
  it('calculates integer KZT totals from quantity and configured price', () => {
    expect(calculateTotal(1)).toBe(20000);
    expect(calculateTotal(10)).toBe(200000);
    expect(calculateTotal(3, 25000, 5)).toBe(75000);
  });
  it.each([0, -1, 1.5, 11, NaN, Infinity])('rejects invalid quantity %s', (quantity) => {
    expect(() => calculateTotal(quantity)).toThrow();
  });
  it('rejects overflow and invalid prices', () => {
    expect(() => calculateTotal(2, Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => calculateTotal(1, -20000)).toThrow();
  });
  it('validates complete orders and rejects changed financial fields', () => {
    expect(validateOrder(order)).toEqual({ valid: true, errors: [] });
    expect(validateOrder({ ...order, totalAmount: 1 }).errors).toContain('totalAmount');
    expect(validateOrder({ ...order, unitPrice: 1, totalAmount: 2 }).valid).toBe(false);
    expect(validateOrder({ ...order, currency: 'USD' }).errors).toContain('currency');
  });
  it.each(['recipientName', 'recipientPhone', 'city', 'address', 'discId'] as const)(
    'requires %s',
    (field) => {
      expect(validateOrder({ ...order, [field]: null }).errors).toContain(field);
    },
  );
  it('does not accept whitespace or multiline control characters in collected fields', () => {
    expect(validText('  ', 2, 80)).toBe(false);
    expect(validText('Арман\nАдрес', 2, 80)).toBe(false);
  });
});

describe('recipient phone normalization', () => {
  it.each(['+7 (701) 123-45-67', '87011234567', '77011234567'])(
    'normalizes %s to E.164',
    (phone) => {
      expect(normalizePhone(phone)).toBe('+77011234567');
    },
  );
  it('accepts a valid international recipient number', () => {
    expect(normalizePhone('+1 415 555 2671')).toBe('+14155552671');
  });
  it.each(['12345', '', 'call +77011234567', '+77011234567 ext 2', '+70000000000'])(
    'rejects malformed numbers: %s',
    (phone) => {
      expect(normalizePhone(phone)).toBeNull();
    },
  );
});
