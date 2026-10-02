import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import type { PrismaClient } from '@prisma/client';
import { createDatabase } from '../../src/db/prisma.js';
import { readEnv } from '../../src/config/env.js';
import { buildApp } from '../../src/app.js';
import {
  acceptSheetShipment,
  shipmentNotificationStatus,
  shippingJobKey,
} from '../../src/modules/sheets/shipping.js';
import { parseTemplateRegistry } from '../../src/modules/whatsapp/policy.js';
import { DeliveryError } from '../../src/modules/notifications/delivery-error.js';
import type { WhatsAppTransport } from '../../src/modules/whatsapp/whatsapp.client.js';

let db: PrismaClient;
let postgres: EmbeddedPostgres;
let directory: string;
let url: string;
let started = false;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'musicbox-shipping-'));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'postgres'),
    port,
    user: 'musicbox',
    password: 'musicbox',
    persistent: false,
    postgresFlags: ['-h', '127.0.0.1'],
    onLog: () => {},
    onError: () => {},
  });
  await postgres.initialise();
  await postgres.start();
  started = true;
  await postgres.createDatabase('shipping_test');
  url = `postgresql://musicbox:musicbox@127.0.0.1:${port}/shipping_test`;
  await promisify(execFile)(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    {
      env: { ...process.env, DIRECT_URL: '', DATABASE_URL: url },
      timeout: 60000,
    },
  );
  db = createDatabase(url);
});
beforeEach(async () => {
  // This database is created solely for this test file; no configured application DB is used.
  await db.$executeRawUnsafe(
    'TRUNCATE "Customer", "SheetBinding", "OutboxJob", "AuditLog" CASCADE',
  );
});
afterAll(async () => {
  if (db) await db.$disconnect();
  if (started) await postgres.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(language: 'ru' | 'kk' = 'ru') {
  const customer = await db.customer.create({
    data: {
      whatsappId: randomUUID(),
      preferredLanguage: language,
      notificationConsent: true,
      lastInboundAt: new Date(),
    },
  });
  const order = await db.order.create({
    data: {
      customerId: customer.id,
      publicOrderId: `MB-${randomUUID()}`,
      productId: 'music-box',
      productName: 'Шкатулка',
      totalAmount: 20000,
      unitPrice: 20000,
      paymentStatus: 'PAID',
      orderStatus: 'PAID',
      paidAt: new Date(),
    },
  });
  const binding = await db.sheetBinding.create({
    data: {
      orderId: order.id,
      spreadsheetId: 'test',
      sheetId: 7,
      rowIndex: (await db.sheetBinding.count()) + 2,
      syncedOrderVersion: 1,
    },
  });
  return {
    customer,
    order,
    input: {
      binding,
      publicOrderId: order.publicOrderId,
      tracking: 'AP123456789KZ',
      confirmed: true,
    },
  };
}
const registry = JSON.stringify({
  order_shipped: {
    ru: {
      name: 'shipped_ru',
      locale: 'ru',
      available: true,
      parameters: ['orderId', 'trackingNumber'],
    },
    kk: {
      name: 'shipped_kk',
      locale: 'kk',
      available: true,
      parameters: ['orderId', 'trackingNumber'],
    },
  },
});
async function runtime(
  templates = registry,
  send = vi.fn<WhatsAppTransport['send']>(async () => `message-${randomUUID()}`),
) {
  const env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    INTEGRATION_MODE: 'demo',
    ADMIN_TOKEN: 'a'.repeat(32),
    MOCK_PAYMENT_SECRET: 'b'.repeat(32),
    WHATSAPP_TEMPLATE_REGISTRY: templates,
    LOG_LEVEL: 'silent',
    TELEGRAM_ENABLED: 'false',
    MANAGER_HANDOFF_ENABLED: 'false',
  });
  const app = await buildApp({
    db,
    env,
    logger: false,
    startWorker: false,
    whatsapp: { send, markAsRead: async () => {} },
    sheets: { sync: async () => 'test:row' },
  });
  return { ...app, send };
}

describe('shipping confirmations and WhatsApp outbox', () => {
  it('atomically records one shipment and one notice across concurrent polls and repeated confirmations', async () => {
    const { order, input } = await fixture();
    expect(
      await Promise.all([acceptSheetShipment(db, input), acceptSheetShipment(db, input)]),
    ).toEqual([null, null]);
    expect(await acceptSheetShipment(db, input)).toBeNull();
    const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved).toMatchObject({
      trackingNumber: input.tracking,
      orderStatus: 'SHIPPED',
      version: order.version + 1,
    });
    expect(saved.shippedAt).toBeInstanceOf(Date);
    expect(await db.outboxJob.count({ where: { dedupeKey: shippingJobKey(order.id) } })).toBe(1);
    expect(await db.auditLog.count({ where: { event: 'shipment_confirmed_from_sheet' } })).toBe(1);
    expect(await shipmentNotificationStatus(db, order.id, false)).toBe('Ожидает отправки');
  });

  it.each([
    { tracking: '', confirmed: true },
    { tracking: '=A1', confirmed: true },
    { tracking: 123456789, confirmed: true },
    { confirmed: 'TRUE' },
    { publicOrderId: 'OTHER-ORDER' },
  ])('rejects invalid input %j without a notification', async (patch) => {
    const { input } = await fixture();
    expect(await acceptSheetShipment(db, { ...input, ...patch })).toMatch(/^Ошибка:/);
    expect(await db.outboxJob.count()).toBe(0);
  });

  it('waits for the checkbox without altering the order', async () => {
    const { order, input } = await fixture();
    expect(await acceptSheetShipment(db, { ...input, confirmed: false })).toBe(
      'Ожидает отметки об отправке',
    );
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).trackingNumber,
    ).toBeNull();
  });

  it.each([
    { fulfillmentHold: true },
    { reviewRequired: true },
    { paymentStatus: 'REFUNDED' as const },
    { paidAt: null },
    { orderStatus: 'CANCELLED' as const },
    { paymentStatus: 'PENDING' as const },
  ])('does not ship blocked or unpaid orders %j', async (patch) => {
    const { order, input } = await fixture();
    await db.order.update({ where: { id: order.id }, data: patch });
    expect(await acceptSheetShipment(db, input)).toMatch(/^Ошибка:/);
    expect(await db.outboxJob.count()).toBe(0);
  });

  it('prevents assigning the same tracking number to two orders concurrently', async () => {
    const a = await fixture();
    const b = await fixture();
    const results = await Promise.all([
      acceptSheetShipment(db, a.input),
      acceptSheetShipment(db, b.input),
    ]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.some((r) => r?.includes('уже используется'))).toBe(true);
  });

  it('changing or clearing confirmed tracking never sends a second notice', async () => {
    const { order, input } = await fixture();
    await acceptSheetShipment(db, input);
    expect(await acceptSheetShipment(db, { ...input, tracking: 'AP987654321KZ' })).toContain(
      'уже сохранена',
    );
    expect(await acceptSheetShipment(db, { ...input, confirmed: false })).toContain(
      'уже сохранена',
    );
    expect(await db.outboxJob.count({ where: { dedupeKey: shippingJobKey(order.id) } })).toBe(1);
  });

  it.each(['ru', 'kk'] as const)(
    'sends the approved %s template with order and tracking outside the window',
    async (language) => {
      const { customer, order, input } = await fixture(language);
      await db.customer.update({
        where: { id: customer.id },
        data: { lastInboundAt: new Date(Date.now() - 2 * 86400000) },
      });
      await acceptSheetShipment(db, input);
      const app = await runtime();
      try {
        await app.worker.drain();
        expect(app.send).toHaveBeenCalledTimes(1);
        expect(app.send.mock.calls[0]?.[1]).toEqual({
          type: 'template',
          name: `shipped_${language}`,
          language,
          parameters: [order.publicOrderId, input.tracking],
        });
        await acceptSheetShipment(db, input);
        await app.worker.drain();
        expect(app.send).toHaveBeenCalledTimes(1);
        expect(await shipmentNotificationStatus(db, order.id, false)).toContain('Принято WhatsApp');
        expect(await shipmentNotificationStatus(db, order.id, true)).toContain('Демо:');
        const job = await db.outboxJob.findUniqueOrThrow({
          where: { dedupeKey: shippingJobKey(order.id) },
        });
        await db.message.update({
          where: { outboxJobId: job.id },
          data: { deliveryStatus: 'DELIVERED' },
        });
        expect(await shipmentNotificationStatus(db, order.id, false)).toBe('Доставлено клиенту');
      } finally {
        await app.app.close();
      }
    },
  );

  it('reports missing templates without attempting a send', async () => {
    const { customer, order, input } = await fixture();
    await db.customer.update({ where: { id: customer.id }, data: { lastInboundAt: new Date(0) } });
    await acceptSheetShipment(db, input);
    const app = await runtime('{}');
    try {
      await app.worker.drain();
      expect(app.send).not.toHaveBeenCalled();
      expect(await shipmentNotificationStatus(db, order.id, false)).toContain('шаблон');
    } finally {
      await app.app.close();
    }
  });

  it('honours opt-out even inside the window', async () => {
    const { customer, order, input } = await fixture();
    await acceptSheetShipment(db, input);
    await db.customer.update({ where: { id: customer.id }, data: { optedOutAt: new Date() } });
    const app = await runtime();
    try {
      await app.worker.drain();
      expect(app.send).not.toHaveBeenCalled();
      expect(await shipmentNotificationStatus(db, order.id, false)).toContain('согласия');
    } finally {
      await app.app.close();
    }
  });

  it('does not send after a payment hold is applied to a queued shipment', async () => {
    const { order, input } = await fixture();
    await acceptSheetShipment(db, input);
    await db.order.update({ where: { id: order.id }, data: { fulfillmentHold: true } });
    const app = await runtime();
    try {
      await app.worker.drain();
      expect(app.send).not.toHaveBeenCalled();
      expect(await shipmentNotificationStatus(db, order.id, false)).toContain('проверки');
    } finally {
      await app.app.close();
    }
  });

  it('does not resend an ambiguous network outcome after repeated polling', async () => {
    const { order, input } = await fixture();
    await acceptSheetShipment(db, input);
    const send = vi.fn<WhatsAppTransport['send']>(async () => {
      throw new DeliveryError('TIMEOUT', { outcome: 'UNKNOWN' });
    });
    const app = await runtime(registry, send);
    try {
      await app.worker.drain();
      await acceptSheetShipment(db, input);
      await app.worker.drain();
      expect(send).toHaveBeenCalledTimes(1);
      expect(await shipmentNotificationStatus(db, order.id, false)).toContain('неизвестен');
    } finally {
      await app.app.close();
    }
  });

  it('rejects a shipment template with missing or reordered parameters', () => {
    expect(() =>
      parseTemplateRegistry(
        JSON.stringify({
          order_shipped: {
            ru: {
              name: 'bad',
              locale: 'ru',
              available: true,
              parameters: ['trackingNumber', 'orderId'],
            },
          },
        }),
      ),
    ).toThrow();
  });
});
