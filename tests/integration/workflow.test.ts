import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import type { PrismaClient } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { readEnv, type Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/prisma.js';
import { WhatsAppActions as A } from '../../src/modules/conversation/actions.js';
import {
  PaymentCreationUnknownError,
  PaymentCreationRejectedError,
} from '../../src/modules/payments/payment-provider.interface.js';
import { MockPaymentProvider } from '../../src/modules/payments/mock.provider.js';
import type { SheetOrder, SheetsService } from '../../src/modules/sheets/google-sheets.service.js';
import type { CustomerData, InboundMessage, Language, OrderData } from '../../src/types/domain.js';

type Runtime = Awaited<ReturnType<typeof buildApp>>;
interface Snapshot {
  customer: CustomerData;
  orders: (OrderData & {
    sheetSyncStatus: string;
    paymentAttempts: { id: string; externalPaymentId: string; status: string }[];
  })[];
  messages: {
    direction: string;
    content: string | null;
    whatsappMessageId: string;
    payload: { text?: string } | null;
  }[];
  handoffs: { id: string; status: string }[];
}
const secret = 'y'.repeat(32);
const adminToken = 'x'.repeat(32);
let runtime: Runtime;
let db: PrismaClient;
let postgres: EmbeddedPostgres;
let env: Env;
let directory: string;
let started = false;
const exported = new Map<string, SheetOrder>();
const failingSheets = new Set<string>();
const sync = vi.fn(async (order: SheetOrder) => {
  if (failingSheets.has(order.id))
    throw Object.assign(new Error('Simulated Sheets rate limit'), { code: 429 });
  exported.set(order.id, structuredClone(order));
  return `integration:Orders:${order.publicOrderId}`;
});
const sheets: SheetsService = { sync };
let phoneSequence = 0;
const phone = () => `7707100${String(++phoneSequence).padStart(4, '0')}`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port assigned');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'musicbox-integration-'));
  const port = await freePort();
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
  await postgres.createDatabase('integration');
  const url = `postgresql://musicbox:musicbox@127.0.0.1:${port}/integration`;
  await promisify(execFile)(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DIRECT_URL: '', DATABASE_URL: url },
      timeout: 60000,
    },
  );
  env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    INTEGRATION_MODE: 'demo',
    PAYMENT_PROVIDER: 'mock',
    ADMIN_TOKEN: adminToken,
    MOCK_PAYMENT_SECRET: secret,
    LOG_LEVEL: 'silent',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_MANAGER_CHAT_ID: '',
    WHATSAPP_APP_SECRET: 'meta-test-secret',
    WHATSAPP_VERIFY_TOKEN: 'meta-verification-token',
    WHATSAPP_PHONE_NUMBER_ID: '123456789',
  });
  db = createDatabase(url);
  runtime = await buildApp({ db, env, sheets, startWorker: false, logger: false });
});

afterAll(async () => {
  if (runtime) await runtime.app.close();
  if (db) await db.$disconnect();
  if (started) await postgres.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function send(from: string, input: Partial<InboundMessage>): Promise<Snapshot> {
  const response = await runtime.app.inject({
    method: 'POST',
    url: '/dev/simulate-whatsapp',
    payload: { from, type: 'text', ...input },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Snapshot>();
}
const text = (from: string, value: string, id?: string) =>
  send(from, { type: 'text', text: value, ...(id ? { id } : {}) });
async function actionToken(from: string, actionId: string) {
  const customer = await db.customer.findUniqueOrThrow({ where: { whatsappId: from } });
  const token = await db.actionToken.findFirst({
    where: {
      customerId: customer.id,
      actionId,
      conversationVersion: customer.conversationVersion,
      consumedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });
  return token?.token ?? actionId;
}
const click = async (from: string, actionId: string, id?: string) =>
  send(from, {
    type: 'interactive',
    actionId: await actionToken(from, actionId),
    ...(id ? { id } : {}),
  });
async function snapshot(from: string): Promise<Snapshot> {
  const response = await runtime.app.inject({ method: 'GET', url: `/dev/state?from=${from}` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Snapshot>();
}
async function recipient(from: string, language: Language = 'ru'): Promise<Snapshot> {
  await text(from, 'Здравствуйте');
  await click(from, language === 'ru' ? A.LANG_RU : A.LANG_KK);
  await click(from, A.MENU_ORDER);
  await click(from, `${A.DISC_PREFIX}${runtime.catalog.discs()[0]!.id}`);
  await click(from, A.DISC_DONE);
  await text(from, '2');
  await text(from, 'Алматы');
  return click(from, A.NOTIFICATIONS_SKIP);
}
async function confirmation(from: string, language: Language = 'ru'): Promise<Snapshot> {
  await recipient(from, language);
  await text(from, 'Арман');
  await text(from, '+7 (701) 123-45-67');
  return text(from, 'Абая 10, квартира 12');
}
async function pending(from: string, language: Language = 'ru'): Promise<Snapshot> {
  await confirmation(from, language);
  return click(from, A.ORDER_CONFIRM);
}
async function pay(attemptId: string, status: 'SUCCESS' | 'FAILED' = 'SUCCESS') {
  return runtime.app.inject({
    method: 'POST',
    url: `/dev/mock-payment/${attemptId}`,
    payload: { status },
  });
}
function paymentBody(
  order: Snapshot['orders'][number],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    externalPaymentId: order.paymentAttempts.at(-1)!.externalPaymentId,
    orderId: order.id,
    amount: order.totalAmount,
    currency: 'KZT',
    status: 'PAID',
    provider: 'mock',
    ...overrides,
  };
}
async function callback(body: Record<string, unknown>, signature?: string) {
  const payload = JSON.stringify(body);
  return runtime.app.inject({
    method: 'POST',
    url: '/dev/webhooks/payment/mock',
    payload,
    headers: {
      'content-type': 'application/json',
      'x-mock-signature': signature ?? createHmac('sha256', secret).update(payload).digest('hex'),
    },
  });
}

describe('PostgreSQL-backed WhatsApp sales workflow', () => {
  it('authenticates the real WhatsApp webhook transport before persisting an event', async () => {
    const from = phone();
    const id = `wamid.${randomUUID()}`;
    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID },
                messages: [
                  {
                    id,
                    from,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Здравствуйте' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const rejected = await runtime.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=invalid' },
      payload,
    });
    expect(rejected.statusCode).toBe(401);
    expect(await db.webhookEvent.count({ where: { externalEventId: id } })).toBe(0);
    const signature = `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET).update(payload).digest('hex')}`;
    const accepted = await runtime.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      payload,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    await runtime.worker.drain();
    expect((await snapshot(from)).customer.conversationState).toBe('AWAITING_LANGUAGE');
    const handshake = await runtime.app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${env.WHATSAPP_VERIFY_TOKEN}&hub.challenge=test-challenge`,
    });
    expect(handshake.body).toBe('test-challenge');
  });

  it.each(['ru', 'kk'] as const)(
    'completes the %s order/payment/export workflow and ignores repeated payment callbacks',
    async (language) => {
      const from = phone();
      const ready = await pending(from, language);
      const order = ready.orders[0]!;
      expect(ready.customer.preferredLanguage).toBe(language);
      expect(ready.customer.conversationState).toBe('PAYMENT_PENDING');
      expect(order).toMatchObject({
        quantity: 2,
        totalAmount: 40000,
        currency: 'KZT',
        paymentStatus: 'PENDING',
        sheetSyncStatus: 'NOT_REQUIRED',
      });
      expect(order.paymentAttempts).toHaveLength(1);
      expect(order.paymentUrl).toContain('/dev/mock-payment/');
      expect(exported.has(order.id)).toBe(false);
      const receiptClaim = await text(from, language === 'ru' ? 'Я оплатил' : 'Төледім');
      expect(receiptClaim.orders[0]?.paymentStatus).toBe('PENDING');
      expect(exported.has(order.id)).toBe(false);
      const first = await pay(order.paymentAttempts[0]!.id);
      expect(first.statusCode, first.body).toBe(200);
      const paid = await snapshot(from);
      expect(paid.orders[0]).toMatchObject({
        paymentStatus: 'PAID',
        orderStatus: 'PAID',
        sheetSyncStatus: 'SYNCED',
      });
      expect(paid.customer.conversationState).toBe('PAID');
      expect(exported.get(order.id)?.totalAmount).toBe(40000);
      const second = await pay(order.paymentAttempts[0]!.id);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().duplicate).toBe(true);
      expect(await db.outboxJob.count({ where: { dedupeKey: `paid:${order.id}` } })).toBe(1);
      expect(sync.mock.calls.filter(([item]) => item.id === order.id)).toHaveLength(1);
      const final = await snapshot(from);
      expect(
        final.messages.filter(
          (message) =>
            message.direction === 'outbound' &&
            message.content?.includes(language === 'ru' ? 'Оплата получена' : 'Төлем қабылданды'),
        ),
      ).toHaveLength(1);
    },
  );

  it('replays an initial question once, shows demo product and available disc buttons', async () => {
    const from = phone();
    const initial = await text(from, 'Сколько стоит?');
    expect(initial.customer.firstUnhandledMessage).toBe('Сколько стоит?');
    expect(initial.customer.conversationState).toBe('AWAITING_LANGUAGE');
    const selected = await click(from, A.LANG_RU);
    expect(selected.customer.firstUnhandledMessage).toBeNull();
    expect(
      selected.messages.filter(
        (message) => message.direction === 'outbound' && message.content?.includes('20'),
      ),
    ).toHaveLength(1);
    const product = await click(from, A.MENU_PRODUCT);
    expect(product.customer.conversationState).toBe('PRODUCT_VIEW');
    expect(product.messages.at(-1)?.content).toContain('Демонстрационный каталог');
    const discs = await click(from, A.PRODUCT_DISCS);
    expect(discs.customer.conversationState).toBe('DISC_LIST');
    expect(await actionToken(from, `${A.DISC_PREFIX}${runtime.catalog.discs()[0]!.id}`)).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('deduplicates concurrent inbound webhooks and concurrent confirmation clicks', async () => {
    const from = phone();
    const inboundId = `integration.${randomUUID()}`;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        runtime.app.inject({
          method: 'POST',
          url: '/dev/simulate-whatsapp',
          payload: { from, type: 'text', text: 'Здравствуйте', id: inboundId },
        }),
      ),
    );
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    await runtime.worker.drain();
    expect(await db.message.count({ where: { whatsappMessageId: inboundId } })).toBe(1);
    const initial = await snapshot(from);
    expect(initial.messages.filter((message) => message.direction === 'outbound')).toHaveLength(1);
    await confirmation(from);
    const confirmToken = await actionToken(from, A.ORDER_CONFIRM);
    const confirmations = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        runtime.app.inject({
          method: 'POST',
          url: '/dev/simulate-whatsapp',
          payload: {
            from,
            type: 'interactive',
            actionId: confirmToken,
            id: `${inboundId}.confirm.${index}`,
          },
        }),
      ),
    );
    for (const response of confirmations) expect(response.statusCode, response.body).toBe(200);
    await runtime.worker.drain();
    const result = await snapshot(from);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]?.paymentAttempts).toHaveLength(1);
    expect(result.orders[0]?.paymentStatus).toBe('PENDING');
  });

  it('rejects invalid signatures, wrong amount/currency and mismatched order before any export', async () => {
    const from = phone();
    const order = (await pending(from)).orders[0]!;
    expect((await callback(paymentBody(order), '0'.repeat(64))).statusCode).toBe(400);
    expect((await callback(paymentBody(order, { amount: 1 }))).statusCode).toBe(200);
    expect((await callback(paymentBody(order, { currency: 'USD' }))).statusCode).toBe(200);
    expect((await callback(paymentBody(order, { orderId: randomUUID() }))).statusCode).toBe(200);
    await runtime.worker.drain();
    expect((await snapshot(from)).orders[0]?.paymentStatus).not.toBe('PAID');
    expect(
      await db.paymentIncident.count({ where: { orderId: order.id, status: 'OPEN' } }),
    ).toBeGreaterThan(0);
    expect(exported.has(order.id)).toBe(false);
    expect(await db.outboxJob.count({ where: { dedupeKey: `paid:${order.id}` } })).toBe(0);
  });

  it('serializes concurrent valid payment callbacks into one receipt and one export', async () => {
    const from = phone();
    const order = (await pending(from)).orders[0]!;
    const body = paymentBody(order);
    const responses = await Promise.all(Array.from({ length: 5 }, () => callback(body)));
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    expect(responses.filter((response) => response.json().duplicate === false)).toHaveLength(1);
    await runtime.worker.drain();
    expect((await snapshot(from)).orders[0]?.paymentStatus).toBe('PAID');
    expect(sync.mock.calls.filter(([item]) => item.id === order.id)).toHaveLength(1);
    expect(await db.outboxJob.count({ where: { dedupeKey: `paid:${order.id}` } })).toBe(1);
  });

  it('requires a new confirmation after a failed payment and ignores an old-attempt failure', async () => {
    const from = phone();
    const order = (await pending(from)).orders[0]!;
    const firstAttempt = order.paymentAttempts[0]!;
    const failed = await pay(firstAttempt.id, 'FAILED');
    expect(failed.statusCode, failed.body).toBe(200);
    const afterFailure = await snapshot(from);
    expect(afterFailure.orders[0]?.paymentStatus).toBe('FAILED');
    expect(afterFailure.customer.conversationState).toBe('ORDER_CONFIRMATION');
    const retry = await click(from, A.ORDER_CONFIRM);
    expect(retry.orders[0]?.paymentAttempts).toHaveLength(2);
    expect(retry.orders[0]?.paymentStatus).toBe('PENDING');
    const lateFailure = await callback(
      paymentBody(order, { externalPaymentId: firstAttempt.externalPaymentId, status: 'FAILED' }),
    );
    expect(lateFailure.statusCode, lateFailure.body).toBe(200);
    expect((await snapshot(from)).orders[0]?.paymentStatus).toBe('PENDING');
    const latest = retry.orders[0]!.paymentAttempts.find(
      (attempt) => attempt.id !== firstAttempt.id,
    )!;
    expect((await pay(latest.id)).statusCode).toBe(200);
    expect((await pay(firstAttempt.id, 'FAILED')).statusCode).toBe(200);
    expect((await snapshot(from)).orders[0]?.paymentStatus).toBe('PAID');
  });

  it('edits the quantity, cancels before payment and never exports a cancelled draft', async () => {
    const from = phone();
    await confirmation(from);
    await click(from, A.ORDER_EDIT);
    await click(from, A.EDIT_QUANTITY);
    const changed = await text(from, '3');
    expect(changed.orders[0]?.totalAmount).toBe(60000);
    await text(from, 'отменить заказ');
    const cancelled = await click(from, A.CANCEL_CONFIRM);
    const order = cancelled.orders[0]!;
    expect(order.orderStatus).toBe('CANCELLED');
    expect(cancelled.customer.currentOrderId).toBeNull();
    expect(order.paymentAttempts).toHaveLength(0);
    const resync = await runtime.app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/resync-sheet`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(resync.statusCode).toBe(409);
    expect(exported.has(order.id)).toBe(false);
    expect((await click(from, A.ORDER_CONFIRM)).orders[0]?.paymentAttempts).toHaveLength(0);
  });

  it('keeps a cancelled order closed when a late failure callback arrives', async () => {
    const from = phone();
    const order = (await pending(from)).orders[0]!;
    expect((await pay(order.paymentAttempts[0]!.id, 'FAILED')).statusCode).toBe(200);
    await text(from, 'отменить заказ');
    const cancelled = await click(from, A.CANCEL_CONFIRM);
    const outgoing = cancelled.messages.filter(
      (message) => message.direction === 'outbound',
    ).length;
    const late = await callback(paymentBody(order, { status: 'FAILED' }));
    expect(late.statusCode, late.body).toBe(200);
    await runtime.worker.drain();
    const after = await snapshot(from);
    expect(after.orders[0]).toMatchObject({ orderStatus: 'CANCELLED', paymentStatus: 'CANCELLED' });
    expect(after.customer.currentOrderId).toBeNull();
    expect(after.messages.filter((message) => message.direction === 'outbound')).toHaveLength(
      outgoing,
    );
    expect(exported.has(order.id)).toBe(false);
  });

  it('records a late captured payment for a cancelled order for manual refund review without a normal receipt', async () => {
    const from = phone();
    const order = (await pending(from)).orders[0]!;
    expect((await pay(order.paymentAttempts[0]!.id, 'FAILED')).statusCode).toBe(200);
    await text(from, 'отменить заказ');
    await click(from, A.CANCEL_CONFIRM);
    const body = paymentBody(order);
    const paid = await callback(body);
    expect(paid.statusCode, paid.body).toBe(200);
    await runtime.worker.drain();
    const reconciled = await snapshot(from);
    expect(reconciled.orders[0]).toMatchObject({
      paymentStatus: 'PAID',
      orderStatus: 'CANCELLED',
      sheetSyncStatus: 'SYNCED',
    });
    expect(
      await db.paymentIncident.count({ where: { orderId: order.id, reason: 'LATE_PAYMENT' } }),
    ).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).fulfillmentHold).toBe(
      true,
    );
    expect(exported.get(order.id)?.orderStatus).toBe('CANCELLED');
    expect(await db.outboxJob.count({ where: { dedupeKey: `paid:${order.id}` } })).toBe(0);
    expect(
      reconciled.messages.some(
        (message) =>
          message.direction === 'outbound' && message.content?.includes('Оплата получена'),
      ),
    ).toBe(false);
    expect((await callback(body)).json().duplicate).toBe(true);
    expect(
      await db.paymentIncident.count({ where: { orderId: order.id, reason: 'LATE_PAYMENT' } }),
    ).toBe(1);
  });

  it('preserves PAID and a durable retry after Sheets API code 429, then reconciles one export', async () => {
    const from = phone();
    const order = (await pending(from)).orders[0]!;
    failingSheets.add(order.id);
    expect((await pay(order.paymentAttempts[0]!.id)).statusCode).toBe(200);
    const failed = await snapshot(from);
    expect(failed.orders[0]).toMatchObject({ paymentStatus: 'PAID', sheetSyncStatus: 'PENDING' });
    expect(exported.has(order.id)).toBe(false);
    expect(
      await db.outboxJob.count({ where: { orderId: order.id, kind: 'SHEETS', status: 'RETRY' } }),
      JSON.stringify(
        await db.outboxJob.findMany({
          where: { orderId: order.id },
          select: { kind: true, status: true, lastError: true, attempts: true },
        }),
      ),
    ).toBe(1);
    const failedJob = await db.outboxJob.findFirstOrThrow({
      where: { orderId: order.id, kind: 'SHEETS', status: 'RETRY' },
    });
    expect(failedJob.attempts).toBe(1);
    expect(failedJob.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    const unauthorized = await runtime.app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/resync-sheet`,
    });
    expect(unauthorized.statusCode).toBe(401);
    failingSheets.delete(order.id);
    const resync = await runtime.app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/resync-sheet`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(resync.statusCode, resync.body).toBe(200);
    await runtime.worker.drain();
    expect((await snapshot(from)).orders[0]).toMatchObject({
      paymentStatus: 'PAID',
      sheetSyncStatus: 'SYNCED',
    });
    expect(exported.has(order.id)).toBe(true);
    expect(
      await db.outboxJob.count({ where: { orderId: order.id, kind: 'SHEETS', status: 'DONE' } }),
    ).toBe(1);
    expect(sync.mock.calls.filter(([item]) => item.id === order.id)).toHaveLength(2);
  });

  it('freezes an unknown-information handoff and resumes only through authenticated admin action', async () => {
    const from = phone();
    await text(from, 'Здравствуйте');
    await click(from, A.LANG_KK);
    const handedOff = await text(from, 'Кепілдік бар ма?');
    expect(handedOff.customer.conversationState).toBe('HUMAN_HANDOFF');
    expect(handedOff.handoffs).toHaveLength(1);
    const sentBefore = handedOff.messages.filter(
      (message) => message.direction === 'outbound',
    ).length;
    const frozen = await click(from, A.MENU_ORDER);
    expect(frozen.orders).toHaveLength(0);
    expect(frozen.customer.conversationState).toBe('HUMAN_HANDOFF');
    expect(
      frozen.messages.filter((message) => message.direction === 'outbound').length,
    ).toBeGreaterThanOrEqual(sentBefore);
    const response = await runtime.app.inject({
      method: 'POST',
      url: `/admin/customers/${handedOff.customer.id}/release-handoff`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    await runtime.worker.drain();
    const resumed = await text(from, 'мәзір');
    expect(resumed.customer.conversationState).toBe('MAIN_MENU');
    expect(resumed.handoffs[0]?.status).toBe('CLOSED');
  });

  it('restores draft fields and unprocessed inbound events after restarting the application', async () => {
    const from = phone();
    await recipient(from);
    const draft = await text(from, 'Арман');
    const pendingId = `restart.${randomUUID()}`;
    await runtime.inbox.receive([{ id: pendingId, from, type: 'text', text: '+77011234567' }]);
    await runtime.app.close();
    runtime = await buildApp({ db, env, sheets, startWorker: false, logger: false });
    await runtime.worker.drain();
    const restored = await snapshot(from);
    expect(restored.orders[0]?.id).toBe(draft.orders[0]?.id);
    expect(restored.orders[0]?.recipientName).toBe('Арман');
    expect(restored.orders[0]?.recipientPhone).toBe('+77011234567');
    expect(restored.customer.conversationState).toBe('ORDER_ADDRESS');
    expect(await db.message.count({ where: { whatsappMessageId: pendingId } })).toBe(1);
  });

  it('uses database locks to preserve message order across two independent workers', async () => {
    const from = phone();
    await recipient(from);
    const second = await buildApp({ db, env, sheets, startWorker: false, logger: false });
    try {
      const messages: InboundMessage[] = [
        { id: randomUUID(), from, type: 'text', text: 'Арман' },
        { id: randomUUID(), from, type: 'text', text: '+77011234567' },
      ];
      await runtime.inbox.receive(messages.map((m) => ({ ...m, timestamp: Date.now() / 1000 })));
      await Promise.all([runtime.worker.drain(), second.worker.drain()]);
      await runtime.worker.drain();
      const result = await snapshot(from);
      expect(result.customer.conversationState).toBe('ORDER_ADDRESS');
      expect(result.orders).toHaveLength(1);
      expect(result.orders[0]?.recipientName).toBe('Арман');
      expect(result.orders[0]?.recipientPhone).toBe('+77011234567');
      const received = result.messages
        .filter((message) => message.direction === 'inbound')
        .map((message) => message.whatsappMessageId)
        .slice(-messages.length);
      expect(received).toEqual(messages.map((message) => message.id));
      expect(
        result.messages.filter((message) => message.direction === 'outbound').length,
      ).toBeGreaterThanOrEqual(4);
    } finally {
      await second.app.close();
    }
  });

  it('can verify a persisted mock payment after the provider process memory is lost', async () => {
    const from = phone();
    const order = (await pending(from)).orders[0]!;
    await runtime.app.close();
    runtime = await buildApp({ db, env, sheets, startWorker: false, logger: false });
    expect(runtime.provider).toBeInstanceOf(MockPaymentProvider);
    const response = await pay(order.paymentAttempts[0]!.id);
    expect(response.statusCode, response.body).toBe(200);
    expect((await snapshot(from)).orders[0]?.paymentStatus).toBe('PAID');
  });
});

it('supports same-origin checkout forms while rejecting cross-origin payment simulation', async () => {
  const from = phone();
  const order = (await pending(from)).orders[0]!;
  const path = `/dev/mock-payment/${order.paymentAttempts[0]!.id}`;
  const page = await runtime.app.inject({ method: 'GET', url: path });
  expect(page.statusCode).toBe(200);
  expect(page.headers['referrer-policy']).toBe('same-origin');
  expect(page.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  const rejected = await runtime.app.inject({
    method: 'POST',
    url: path,
    headers: { origin: 'https://untrusted.example' },
    payload: { status: 'SUCCESS' },
  });
  expect(rejected.statusCode).toBe(403);
  expect((await snapshot(from)).orders[0]?.paymentStatus).toBe('PENDING');
  const accepted = await runtime.app.inject({
    method: 'POST',
    url: path,
    headers: {
      origin: env.APP_BASE_URL,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
    },
    payload: 'status=SUCCESS',
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(accepted.headers['content-type']).toContain('text/html');
  expect((await snapshot(from)).orders[0]?.paymentStatus).toBe('PAID');
});

it('never recreates an ambiguous payment and recovers a provably rejected creation to confirmation', async () => {
  const from = phone();
  await confirmation(from);
  const provider = runtime.provider;
  const create = vi
    .spyOn(provider, 'createPayment')
    .mockRejectedValueOnce(new PaymentCreationUnknownError());
  const result = await click(from, A.ORDER_CONFIRM);
  const order = result.orders[0]!;
  expect(order.paymentAttempts).toHaveLength(1);
  expect(order.paymentAttempts[0]?.status).toBe('CREATION_UNKNOWN');
  expect(order.paymentStatus).toBe('CREATION_UNKNOWN');
  await runtime.worker.drain();
  await text(from, 'меню');
  await runtime.worker.drain();
  expect(create).toHaveBeenCalledTimes(1);
  create.mockRestore();
  const other = phone();
  await confirmation(other);
  const rejected = vi
    .spyOn(provider, 'createPayment')
    .mockRejectedValueOnce(new PaymentCreationRejectedError());
  const after = await click(other, A.ORDER_CONFIRM);
  expect(after.orders[0]?.paymentAttempts[0]?.status).toBe('FAILED');
  expect(after.customer.conversationState).toBe('ORDER_CONFIRMATION');
  expect(after.orders[0]?.paymentStatus).toBe('FAILED');
  rejected.mockRestore();
  const retry = await click(other, A.ORDER_CONFIRM);
  expect(retry.orders[0]?.paymentAttempts).toHaveLength(2);
  expect(retry.orders[0]?.paymentStatus).toBe('PENDING');
});
