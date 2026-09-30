import { afterAll, beforeAll, beforeEach, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import type { PrismaClient } from '@prisma/client';
import { buildApp, type AppOptions } from '../../src/app.js';
import { createDatabase, json } from '../../src/db/prisma.js';
import { readEnv, type Env } from '../../src/config/env.js';
import { enqueue } from '../../src/jobs/outbox.js';
import { claimJob, recoverLeases } from '../../src/jobs/leases.js';
import { DeliveryError } from '../../src/modules/notifications/delivery-error.js';
import type { WhatsAppTransport } from '../../src/modules/whatsapp/whatsapp.client.js';
import { prepareCheckout } from '../../src/modules/orders/checkout.js';
import type { OrderData } from '../../src/types/domain.js';
let db: PrismaClient, env: Env, pg: EmbeddedPostgres, directory: string, port: number;
let runtime: Awaited<ReturnType<typeof buildApp>>;
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const p = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return p;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'queues-v11-'));
  port = await freePort();
  pg = new EmbeddedPostgres({
    databaseDir: join(directory, 'pg'),
    port,
    user: 'test',
    password: 'test',
    persistent: true,
    postgresFlags: ['-h', '127.0.0.1'],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('queue_test');
  env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://test:test@127.0.0.1:${port}/queue_test`,
    ADMIN_TOKEN: 'a'.repeat(32),
    MOCK_PAYMENT_SECRET: 'm'.repeat(32),
    LOG_LEVEL: 'silent',
  });
  await promisify(execFile)(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { env: { ...process.env, DIRECT_URL: '', DATABASE_URL: env.DATABASE_URL }, timeout: 60000 },
  );
  db = createDatabase(env.DATABASE_URL);
});
beforeEach(async () => {
  if (runtime) await runtime.app.close();
  await db.$executeRawUnsafe(
    'TRUNCATE "Customer","Order","PaymentAttempt","Message","WebhookEvent","OutboxJob","Handoff","AuditLog","PaymentIncident","SheetCursor","SheetBinding","TelegramMessageBinding","ActionToken","WorkerHeartbeat" RESTART IDENTITY CASCADE',
  );
  runtime = await buildApp({ db, env, startWorker: false, logger: false });
});
afterAll(async () => {
  if (runtime) await runtime.app.close();
  if (db) await db.$disconnect();
  if (pg) await pg.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function replace(options: Partial<AppOptions>) {
  await runtime.app.close();
  runtime = await buildApp({ db, env, startWorker: false, logger: false, ...options });
}
async function customer() {
  return db.customer.create({
    data: {
      whatsappId: `77${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      preferredLanguage: 'ru',
      conversationState: 'MAIN_MENU',
    },
  });
}
async function queue(customerId: string, payload: unknown = { type: 'text', text: 'hello' }) {
  const key = randomUUID();
  await db.$transaction((tx) => enqueue(tx, { key, kind: 'WHATSAPP', customerId, payload }));
  return db.outboxJob.findUniqueOrThrow({ where: { dedupeKey: key } });
}
it('T13 claims one resource across two workers and fences a stale commit after lease recovery', async () => {
  const c = await customer();
  const j1 = await queue(c.id),
    j2 = await queue(c.id);
  const claims = await Promise.all([claimJob(db, 8), claimJob(db, 8)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const first = claims.find(Boolean)!;
  expect(first.id).toBe(j1.id);
  await db.outboxJob.update({
    where: { id: first.id },
    data: { lockedUntil: new Date(Date.now() - 1000) },
  });
  await recoverLeases(db);
  const replacement = await claimJob(db, 8);
  expect(replacement?.id).toBe(first.id);
  expect(replacement?.lockToken).not.toBe(first.lockToken);
  const stale = await db.outboxJob.updateMany({
    where: { id: first.id, lockToken: first.lockToken, status: 'PROCESSING' },
    data: { status: 'DONE' },
  });
  expect(stale.count).toBe(0);
  expect((await db.outboxJob.findUniqueOrThrow({ where: { id: j2.id } })).attempts).toBe(0);
});
it('expired send lease becomes UNKNOWN and is never automatically sent again', async () => {
  const c = await customer();
  await queue(c.id);
  const claimed = (await claimJob(db, 8))!;
  await db.outboxJob.update({
    where: { id: claimed.id },
    data: { dispatchStartedAt: new Date(), lockedUntil: new Date(Date.now() - 1000) },
  });
  await recoverLeases(db);
  expect((await db.outboxJob.findUniqueOrThrow({ where: { id: claimed.id } })).status).toBe(
    'UNKNOWN',
  );
  expect(await claimJob(db, 8)).toBeNull();
});
it('T19 ambiguous send stays UNKNOWN; business state and subsequent inbound processing continue', async () => {
  const send = vi.fn(async () => {
    throw new DeliveryError('TIMEOUT', { outcome: 'UNKNOWN' });
  });
  await replace({ whatsapp: { send, markAsRead: async () => {} } });
  const c = await customer();
  const job = await queue(c.id);
  await runtime.worker.drain();
  await runtime.worker.drain();
  expect(send).toHaveBeenCalledTimes(1);
  expect((await db.outboxJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('UNKNOWN');
  await runtime.inbox.receive([
    { id: randomUUID(), from: c.whatsappId, type: 'text', text: 'меню' },
  ]);
  await runtime.inbox.processOne();
  expect((await db.customer.findUniqueOrThrow({ where: { id: c.id } })).conversationVersion).toBe(
    1,
  );
  const rejected = await runtime.app.inject({
    method: 'POST',
    url: `/admin/jobs/${job.id}/retry`,
    headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    payload: {},
  });
  expect(rejected.statusCode).toBe(409);
  const accepted = await runtime.app.inject({
    method: 'POST',
    url: `/admin/jobs/${job.id}/retry`,
    headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    payload: { acknowledgeDuplicateRisk: true, actor: 'test', comment: 'provider checked' },
  });
  expect(accepted.statusCode).toBe(200);
  expect(await db.auditLog.count({ where: { event: 'manual_job_retry' } })).toBe(1);
});
it('explicit retryable rejection honors Retry-After, increments actual executions and stores no false SENT', async () => {
  const send = vi.fn(async () => {
    throw new DeliveryError('RATE_LIMIT', {
      outcome: 'REJECTED',
      retryable: true,
      retryAfterMs: 120000,
    });
  });
  await replace({ whatsapp: { send, markAsRead: async () => {} } });
  const c = await customer();
  const job = await queue(c.id);
  await runtime.worker.drain();
  await runtime.worker.drain();
  const current = await db.outboxJob.findUniqueOrThrow({ where: { id: job.id } });
  expect(current.status).toBe('RETRY');
  expect(current.attempts).toBe(1);
  expect(current.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(115000);
  expect(send).toHaveBeenCalledTimes(1);
});
it('T20 policy checks the window at dispatch and chooses only an explicitly approved locale template', async () => {
  const sent: unknown[] = [];
  const transport: WhatsAppTransport = {
    send: async (_to, message) => {
      sent.push(message);
      return randomUUID();
    },
    markAsRead: async () => {},
  };
  const registry = JSON.stringify({
    order_paid: { ru: { name: 'approved_paid_ru', locale: 'ru', available: true } },
  });
  await replace({ env: { ...env, WHATSAPP_TEMPLATE_REGISTRY: registry }, whatsapp: transport });
  const c = await customer();
  await db.customer.update({
    where: { id: c.id },
    data: { lastInboundAt: new Date(Date.now() - 86400000), notificationConsent: true },
  });
  await queue(c.id, {
    type: 'text',
    text: 'paid',
    purpose: 'order_paid',
    templateParameters: ['MB-test'],
  });
  await runtime.worker.drain();
  expect(sent).toEqual([
    { type: 'template', name: 'approved_paid_ru', language: 'ru', parameters: ['MB-test'] },
  ]);
  await db.customer.update({ where: { id: c.id }, data: { preferredLanguage: 'kk' } });
  const missing = await queue(c.id, {
    type: 'text',
    text: 'paid',
    purpose: 'order_paid',
    templateParameters: ['MB-test'],
  });
  await runtime.worker.drain();
  expect((await db.outboxJob.findUniqueOrThrow({ where: { id: missing.id } })).status).toBe(
    'BLOCKED',
  );
  expect(sent).toHaveLength(1);
  await db.customer.update({
    where: { id: c.id },
    data: { preferredLanguage: 'ru', optedOutAt: new Date(), notificationConsent: false },
  });
  await queue(c.id, {
    type: 'text',
    text: 'paid',
    purpose: 'order_paid',
    templateParameters: ['MB-test'],
  });
  await runtime.worker.drain();
  expect(sent).toHaveLength(1);
});
it('T02 delivery receipts are durable before send acknowledgement and never regress READ', async () => {
  const c = await customer();
  const job = await queue(c.id);
  let providerId = '';
  await replace({
    whatsapp: {
      send: async () => {
        providerId = randomUUID();
        await runtime.inbox.receive(
          [],
          [
            { id: providerId, status: 'read', externalEventKey: 'read', correlationId: job.id },
            { id: providerId, status: 'sent', externalEventKey: 'sent', correlationId: job.id },
          ],
        );
        await runtime.inbox.processOne();
        return providerId;
      },
      markAsRead: async () => {},
    },
  });
  const inboundAt = (await db.customer.findUniqueOrThrow({ where: { id: c.id } })).lastInboundAt;
  await runtime.worker.drain();
  const message = await db.message.findUniqueOrThrow({ where: { outboxJobId: job.id } });
  expect(message.deliveryStatus).toBe('READ');
  expect(message.whatsappMessageId).toBe(providerId);
  expect(await db.webhookEvent.count({ where: { eventType: 'status', status: 'PROCESSED' } })).toBe(
    2,
  );
  expect((await db.customer.findUniqueOrThrow({ where: { id: c.id } })).lastInboundAt).toEqual(
    inboundAt,
  );
});
it('T24 a late AI answer cannot commit after handoff changes the conversation version', async () => {
  let release!: (value: { text: string }) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  await replace({
    ai: {
      answer: async () => {
        started();
        return new Promise((resolve) => (release = resolve));
      },
    },
  });
  const c = await customer();
  await db.customer.update({ where: { id: c.id }, data: { conversationState: 'AI_QA' } });
  const id = randomUUID();
  await runtime.inbox.receive([
    { id, from: c.whatsappId, type: 'text', text: 'Почему эта шкатулка удобная?' },
  ]);
  const processing = runtime.inbox.processOne();
  await entered;
  await db.$transaction((tx) =>
    runtime.handoff.open(tx, {
      customerId: c.id,
      reason: 'User requested support',
      previousState: 'AI_QA',
    }),
  );
  release({ text: 'STALE_ANSWER' });
  await processing;
  await runtime.worker.drain();
  expect((await db.customer.findUniqueOrThrow({ where: { id: c.id } })).conversationState).toBe(
    'HUMAN_HANDOFF',
  );
  expect(await db.message.count({ where: { content: 'STALE_ANSWER' } })).toBe(0);
  expect(await db.webhookEvent.count({ where: { externalEventId: id, status: 'PROCESSED' } })).toBe(
    1,
  );
});
it('different customers make progress while another customer is awaiting AI', async () => {
  let release!: (value: { text: string }) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((r) => (entered = r));
  await replace({
    ai: {
      answer: async () => {
        entered();
        return new Promise((r) => (release = r));
      },
    },
  });
  const c1 = await customer(),
    c2 = await customer();
  await db.customer.update({ where: { id: c1.id }, data: { conversationState: 'AI_QA' } });
  await runtime.inbox.receive([
    { id: randomUUID(), from: c1.whatsappId, type: 'text', text: 'Что хорошего?' },
    { id: randomUUID(), from: c2.whatsappId, type: 'text', text: 'меню' },
  ]);
  const slow = runtime.inbox.processOne();
  await waiting;
  expect(await runtime.inbox.processOne()).toBe(true);
  expect((await db.customer.findUniqueOrThrow({ where: { id: c2.id } })).conversationVersion).toBe(
    1,
  );
  release({ text: 'done' });
  await slow;
});
it('T25 stale or foreign opaque buttons cannot affect a changed conversation', async () => {
  const c = await customer();
  await runtime.inbox.receive([
    { id: randomUUID(), from: c.whatsappId, type: 'text', text: 'меню' },
  ]);
  await runtime.worker.drain();
  const token = await db.actionToken.findFirstOrThrow({ where: { customerId: c.id } });
  await runtime.inbox.receive([
    { id: randomUUID(), from: c.whatsappId, type: 'text', text: 'меню' },
    { id: randomUUID(), from: c.whatsappId, type: 'interactive', actionId: token.token },
  ]);
  await runtime.worker.drain();
  expect(await db.order.count()).toBe(0);
  const other = await customer();
  await runtime.inbox.receive([
    { id: randomUUID(), from: other.whatsappId, type: 'interactive', actionId: token.token },
  ]);
  await runtime.worker.drain();
  expect(await db.order.count()).toBe(0);
});
it('T29 production mock cannot start, and live runtime never registers dev routes', async () => {
  expect(() =>
    readEnv({
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: env.DATABASE_URL,
      INTEGRATION_MODE: 'demo',
      PAYMENT_PROVIDER: 'mock',
      ADMIN_TOKEN: env.ADMIN_TOKEN,
      MOCK_PAYMENT_SECRET: env.MOCK_PAYMENT_SECRET,
    }),
  ).toThrow();
  // Build with test transports and a production-shaped validated configuration; no outbound API is called.
  const live = {
    ...env,
    NODE_ENV: 'production' as const,
    INTEGRATION_MODE: 'live' as const,
    PAYMENT_PROVIDER: 'freedompay' as const,
    FREEDOMPAY_TEST_MODE: false,
    APP_BASE_URL: 'https://example.test',
  };
  const app = await buildApp({
    db,
    env: live,
    provider: runtime.provider,
    ai: { answer: async () => ({ text: 'test' }) },
    sheets: { sync: async () => '' },
    whatsapp: { send: async () => '', markAsRead: async () => {} },
    notifications: { send: async () => {} },
    startWorker: false,
    logger: false,
  });
  try {
    expect((await app.app.inject({ method: 'GET', url: '/dev/state' })).statusCode).toBe(404);
    expect((await app.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  } finally {
    await app.app.close();
  }
});
it('T30 restores a stopped physical PostgreSQL backup into a separate local instance', async () => {
  const c = await customer();
  await runtime.app.close();
  await db.$disconnect();
  await pg.stop();
  const backup = join(directory, 'restored');
  await cp(join(directory, 'pg'), backup, { recursive: true });
  await pg.start();
  db = createDatabase(env.DATABASE_URL);
  const restoredPort = await freePort();
  const restored = new EmbeddedPostgres({
    databaseDir: backup,
    port: restoredPort,
    user: 'test',
    password: 'test',
    persistent: true,
    postgresFlags: ['-h', '127.0.0.1'],
    onLog: () => {},
    onError: () => {},
  });
  await restored.start();
  const restoredDb = createDatabase(`postgresql://test:test@127.0.0.1:${restoredPort}/queue_test`);
  try {
    expect((await restoredDb.customer.findUniqueOrThrow({ where: { id: c.id } })).whatsappId).toBe(
      c.whatsappId,
    );
    const migrations = await restoredDb.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    expect(Number(migrations[0]?.count)).toBeGreaterThanOrEqual(3);
  } finally {
    await restoredDb.$disconnect();
    await restored.stop();
  }
  runtime = await buildApp({ db, env, startWorker: false, logger: false });
});
it('T26 real checkout is blocked by demo business data while authenticated callbacks remain operational', async () => {
  const c = await customer();
  const order = await db.order.create({
    data: {
      publicOrderId: `MB-${randomUUID()}`,
      customerId: c.id,
      productId: 'musicbox',
      productName: 'Demo',
      unitPrice: 20000,
      subtotalAmount: 20000,
      totalAmount: 20000,
      paymentStatus: 'CREATING',
      orderStatus: 'AWAITING_PAYMENT',
    },
  });
  const attempt = await db.paymentAttempt.create({
    data: {
      orderId: order.id,
      provider: 'freedompay',
      merchantId: 'demo',
      amount: 20000,
      currency: 'KZT',
      status: 'CREATING',
      externalPaymentId: 'paid-test-id',
    },
  });
  const create = vi.fn(async () => ({
    externalPaymentId: 'never-created',
    paymentUrl: 'https://example.test/pay',
  }));
  const verified = {
    eventId: randomUUID(),
    provider: 'freedompay',
    externalPaymentId: 'paid-test-id',
    orderId: order.id,
    amount: 20000,
    currency: 'KZT',
    status: 'PAID' as const,
  };
  await replace({
    env: { ...env, PAYMENT_PROVIDER: 'freedompay' },
    provider: {
      name: 'freedompay',
      merchantId: 'demo',
      createPayment: create,
      getPaymentStatus: async () => verified,
      verifyWebhook: async () => verified,
      acknowledge: () => ({ body: '<response>ok</response>', contentType: 'application/xml' }),
    },
  });
  await db.$transaction((tx) =>
    enqueue(tx, {
      key: `create:${attempt.id}`,
      kind: 'CREATE_PAYMENT',
      customerId: c.id,
      orderId: order.id,
      payload: { attemptId: attempt.id },
    }),
  );
  await runtime.worker.drain();
  expect(create).not.toHaveBeenCalled();
  expect(
    (await db.outboxJob.findUniqueOrThrow({ where: { dedupeKey: `create:${attempt.id}` } })).status,
  ).toBe('BLOCKED');
  const callback = await runtime.app.inject({
    method: 'POST',
    url: '/webhooks/payment/freedompay',
    payload: { signedFixture: true },
  });
  expect(callback.statusCode).toBe(200);
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
    'PAID',
  );
});
it('authenticated multipart callback accepts bounded fields and rejects files or duplicate fields', async () => {
  const verify = vi.fn(async (_input: unknown) => {
    throw Object.assign(new Error('Only inspect parser'), { statusCode: 422 });
  });
  await replace({
    provider: {
      name: 'freedompay',
      createPayment: async () => ({ externalPaymentId: '', paymentUrl: '' }),
      getPaymentStatus: async () => {
        throw new Error('unused');
      },
      verifyWebhook: verify,
      acknowledge: () => ({ body: 'error', contentType: 'text/plain' }),
    },
  });
  const boundary = 'safe-boundary';
  await runtime.app.inject({
    method: 'POST',
    url: '/webhooks/payment/freedompay',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="pg_payment_id"\r\n\r\n123\r\n--${boundary}--\r\n`,
  });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(verify.mock.calls[0]?.[0]).toBeDefined();
  const rejected = await runtime.app.inject({
    method: 'POST',
    url: '/webhooks/payment/freedompay',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nnot permitted\r\n--${boundary}--\r\n`,
  });
  expect(rejected.statusCode).toBe(400);
  expect(verify).toHaveBeenCalledTimes(1);
});
it('an authoritative early READ resolves a send whose HTTP acknowledgement is lost', async () => {
  const c = await customer();
  const job = await queue(c.id);
  await replace({
    whatsapp: {
      send: async () => {
        await runtime.inbox.receive(
          [],
          [
            {
              id: 'read-before-timeout',
              status: 'read',
              externalEventKey: 'read-before-timeout:read',
              correlationId: job.id,
            },
          ],
        );
        await runtime.inbox.processOne();
        throw new DeliveryError('ACK_LOST', { outcome: 'UNKNOWN' });
      },
      markAsRead: async () => {},
    },
  });
  await runtime.worker.drain();
  expect(
    (await db.message.findUniqueOrThrow({ where: { outboxJobId: job.id } })).deliveryStatus,
  ).toBe('READ');
  expect((await db.outboxJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('DONE');
});

async function scopedPayment(
  provider: string,
  merchantId: string,
  status: 'CREATING' | 'PENDING' = 'CREATING',
) {
  const c = await customer();
  const order = await db.order.create({
    data: {
      customerId: c.id,
      publicOrderId: `MB-${randomUUID()}`,
      productId: 'music-box-set',
      productName: 'Demo',
      recipientName: 'Test recipient',
      recipientPhone: '+77070000001',
      city: 'Алматы',
      address: 'Test address',
      unitPrice: 20000,
      subtotalAmount: 20000,
      totalAmount: 20000,
      paymentStatus: status,
      orderStatus: 'AWAITING_PAYMENT',
      selectedDiscIds: runtime.catalog
        .discs(true)
        .slice(0, runtime.business.includedDiscCount)
        .map((disc) => disc.id),
    },
  });
  const checkout = structuredClone(order) as unknown as OrderData;
  prepareCheckout(checkout, runtime.business, runtime.catalog, env.MAX_ORDER_QUANTITY);
  await db.order.update({
    where: { id: order.id },
    data: {
      selectedDiscIds: checkout.selectedDiscIds,
      packageSnapshot: json(checkout.packageSnapshot),
      deliverySnapshot: json(checkout.deliverySnapshot),
      deliveryMode: checkout.deliveryMode,
      deliveryAmount: checkout.deliveryAmount,
      subtotalAmount: checkout.subtotalAmount,
      totalAmount: checkout.totalAmount,
      configVersion: checkout.configVersion,
    },
  });
  const attempt = await db.paymentAttempt.create({
    data: {
      orderId: order.id,
      provider,
      merchantId,
      amount: checkout.totalAmount,
      currency: 'KZT',
      status,
      externalPaymentId: status === 'PENDING' ? `payment-${randomUUID()}` : null,
      createdAt: new Date(Date.now() - 120000),
    },
  });
  return { c, order, attempt };
}
it.each([
  ['freedompay', 'demo', 'PAYMENT_PROVIDER_MISMATCH'],
  ['mock', 'another-merchant', 'PAYMENT_MERCHANT_MISMATCH'],
])(
  'never creates a persisted %s/%s attempt using current provider credentials',
  async (providerName, merchantId, code) => {
    const fixture = await scopedPayment(providerName, merchantId);
    const provider = runtime.provider;
    const create = vi.spyOn(provider, 'createPayment');
    await replace({ provider });
    const key = `foreign-create:${fixture.attempt.id}`;
    await db.$transaction((tx) =>
      enqueue(tx, {
        key,
        kind: 'CREATE_PAYMENT',
        customerId: fixture.c.id,
        orderId: fixture.order.id,
        payload: { attemptId: fixture.attempt.id },
      }),
    );
    await runtime.worker.processJob();
    expect(create).not.toHaveBeenCalled();
    expect(await db.outboxJob.findUniqueOrThrow({ where: { dedupeKey: key } })).toMatchObject({
      status: 'BLOCKED',
      lastError: code,
      dispatchStartedAt: null,
    });
    expect(
      await db.paymentAttempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } }),
    ).toMatchObject({
      provider: providerName,
      merchantId,
      externalPaymentId: null,
      status: 'CREATING',
    });
    expect(await db.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).toMatchObject({
      paymentStatus: 'CREATING',
      externalPaymentId: null,
      paymentProvider: null,
    });
  },
);
it('reconciliation maintenance selects only the active provider and merchant', async () => {
  const current = await scopedPayment('mock', 'demo', 'PENDING');
  const foreignProvider = await scopedPayment('freedompay', 'demo', 'PENDING');
  const foreignMerchant = await scopedPayment('mock', 'other-merchant', 'PENDING');
  const provider = runtime.provider;
  const query = vi.spyOn(provider, 'getPaymentStatus').mockResolvedValue({
    eventId: randomUUID(),
    provider: 'mock',
    merchantId: 'demo',
    merchantReference: current.attempt.merchantReference,
    externalPaymentId: current.attempt.externalPaymentId!,
    orderId: current.order.id,
    amount: current.attempt.amount,
    currency: 'KZT',
    status: 'PENDING',
  });
  await replace({ provider });
  await runtime.worker.drain();
  expect(query).toHaveBeenCalledExactlyOnceWith(current.attempt.externalPaymentId);
  const jobs = await db.outboxJob.findMany({ where: { kind: 'PAYMENT_RECONCILE' } });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.payload).toMatchObject({ attemptId: current.attempt.id });
  for (const foreign of [foreignProvider, foreignMerchant]) {
    expect(
      (await db.paymentAttempt.findUniqueOrThrow({ where: { id: foreign.attempt.id } }))
        .lastReconcileAt,
    ).toBeNull();
  }
});
it('an already queued reconciliation never queries with another merchant credentials', async () => {
  const fixture = await scopedPayment('mock', 'other-merchant', 'PENDING');
  const query = vi.spyOn(runtime.provider, 'getPaymentStatus');
  const key = `foreign-reconcile:${fixture.attempt.id}`;
  await db.$transaction((tx) =>
    enqueue(tx, {
      key,
      kind: 'PAYMENT_RECONCILE',
      orderId: fixture.order.id,
      payload: { attemptId: fixture.attempt.id },
    }),
  );
  await runtime.worker.processJob();
  expect(query).not.toHaveBeenCalled();
  expect(await db.outboxJob.findUniqueOrThrow({ where: { dedupeKey: key } })).toMatchObject({
    status: 'BLOCKED',
    lastError: 'PAYMENT_MERCHANT_MISMATCH',
    dispatchStartedAt: null,
  });
});
it.each([true, false])(
  'handoff disabled cancels queued bridge sends while payment notifications follow Telegram enabled=%s',
  async (telegramEnabled) => {
    const wa = vi.fn(async (_to: string, _message: unknown) => randomUUID());
    const telegram = vi.fn(async (_text: string) => ({
      chatId: '-100123456789',
      messageId: String(Date.now()),
    }));
    await replace({
      env: { ...env, TELEGRAM_ENABLED: telegramEnabled, MANAGER_HANDOFF_ENABLED: false },
      whatsapp: { send: wa, markAsRead: async () => {} },
      notifications: { send: telegram },
    });
    const c = await customer();
    await db.customer.update({ where: { id: c.id }, data: { conversationState: 'HUMAN_HANDOFF' } });
    const ticket = await db.handoff.create({
      data: {
        customerId: c.id,
        reason: 'Previously opened',
        status: 'ASSIGNED',
        assignedManagerId: '1001',
      },
    });
    const reply = await queue(c.id, {
      type: 'text',
      text: 'DO_NOT_SEND_OPERATOR',
      purpose: 'operator_reply',
      ticketId: ticket.id,
      managerId: '1001',
    });
    const reopen = await queue(c.id, {
      type: 'template',
      name: 'support_reopen',
      language: 'ru',
      parameters: [],
      purpose: 'support_reopen',
      ticketId: ticket.id,
    });
    await db.$transaction(async (tx) => {
      await enqueue(tx, {
        key: 'disabled-ticket-forward',
        kind: 'TELEGRAM',
        customerId: c.id,
        payload: { ticketId: ticket.id, text: 'DO_NOT_FORWARD_CUSTOMER' },
      });
      await enqueue(tx, {
        key: 'independent-payment-notification',
        kind: 'TELEGRAM',
        customerId: c.id,
        payload: { text: 'PAYMENT_NOTIFICATION' },
      });
    });
    const paid = await queue(c.id, { type: 'text', text: 'PAYMENT_OK', purpose: 'order_paid' });
    await runtime.worker.drain();
    for (const job of [reply, reopen])
      expect(await db.outboxJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        status: 'BLOCKED',
        lastError: 'MANAGER_HANDOFF_DISABLED',
        dispatchStartedAt: null,
      });
    expect(
      await db.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'disabled-ticket-forward' } }),
    ).toMatchObject({ status: 'BLOCKED', dispatchStartedAt: null });
    expect(await db.outboxJob.findUniqueOrThrow({ where: { id: paid.id } })).toMatchObject({
      status: 'DONE',
    });
    expect(wa).toHaveBeenCalledExactlyOnceWith(
      c.whatsappId,
      expect.objectContaining({ text: 'PAYMENT_OK' }),
      expect.anything(),
    );
    expect(telegram.mock.calls.some(([text]) => text === 'PAYMENT_NOTIFICATION')).toBe(
      telegramEnabled,
    );
    expect(telegram.mock.calls.some(([text]) => text === 'DO_NOT_FORWARD_CUSTOMER')).toBe(false);
    expect(await db.telegramMessageBinding.count({ where: { ticketId: ticket.id } })).toBe(0);
  },
);
