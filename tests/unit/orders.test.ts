import { describe, expect, it } from 'vitest';
import {
  calculateTotal,
  parseOrderQuantity,
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
  it('accepts multiline addresses while rejecting empty input and other control characters', () => {
    expect(validText('  ', 2, 80)).toBe(false);
    const address = 'Абая 10\r\nКвартира 12\nДомофон 7';
    expect(validText(address, 5, 300)).toBe(true);
    expect(validateOrder({ ...order, address })).toEqual({ valid: true, errors: [] });
    for (const control of ['\0', '\t', '\b', String.fromCharCode(27), String.fromCharCode(127)]) {
      expect(validText(`Абая${control}10`, 5, 300)).toBe(false);
    }
  });
});

describe('human quantity answers', () => {
  it.each([
    ['2', 2],
    ['2 комплекта', 2],
    ['Хочу 2', 2],
    ['хочу заказать два комплекта', 2],
    ['мне нужно 3 штуки', 3],
    ['хочу одну штуку', 1],
    ['две', 2],
    ['Возьму пять наборов.', 5],
    ['10 шт.', 10],
    ['екі', 2],
    ['маған екі жиынтық', 2],
    ['үш дана аламын', 3],
    ['бір алғым келеді', 1],
    ['  2   комплекта  ', 2],
    ['два комплекта, пожалуйста', 2],
  ])('parses only the complete quantity answer %s', (text, expected) => {
    expect(parseOrderQuantity(text as string, 10)).toBe(expected);
  });
  it.each([
    'можно 2 комплекта?',
    '2 комплекта сколько стоят',
    'сколько стоит доставка для 2 комплектов?',
    'хочу 2 или 3',
    '2 комплекта и 3 мелодии',
    '2-3',
    '2.5',
    '2,5',
    '0',
    '-2',
    '11',
    '',
    '9007199254740992',
    'Сколько стоит два комплекта?',
    'екі жиынтық қанша тұрады?',
    '2\u000bкомплекта',
  ])('rejects questions, ambiguous answers and invalid counts: %s', (text) => {
    expect(parseOrderQuantity(text, 10)).toBeNull();
  });
  it('uses the configured maximum quantity', () => {
    expect(parseOrderQuantity('15 комплектов', 20)).toBe(15);
    expect(parseOrderQuantity('3 комплекта', 2)).toBeNull();
    expect(parseOrderQuantity('2', NaN)).toBeNull();
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
