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
import { DemoAiService } from '../../src/modules/ai/ai.service.js';
import { CatalogService } from '../../src/modules/knowledge/catalog.service.js';
import { WhatsAppActions as A } from '../../src/modules/conversation/actions.js';
import type { Language } from '../../src/types/domain.js';

type Runtime = Awaited<ReturnType<typeof buildApp>>;
type MetaMessage = {
  id: string;
  from: string;
  type: string;
  timestamp: string;
  [key: string]: unknown;
};
let runtime: Runtime;
let db: PrismaClient;
let pg: EmbeddedPostgres;
let env: Env;
let directory: string;
let started = false;
let sequence = 0;
const phone = () => `7707309${String(++sequence).padStart(4, '0')}`;
const sent: { url: string; body: Record<string, unknown>; id: string }[] = [];
const http = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const target = String(url);
  // There is no real network fallback: an unexpected integration fails the test.
  expect(target).toBe('https://graph.facebook.com/v99.0/staging-phone/messages');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer staging-meta-token');
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const id = `wamid.staging.${sent.length + 1}`;
  sent.push({ url: target, body, id });
  return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id }] }), {
    status: 200,
  });
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function startApp() {
  const catalog = new CatalogService({ productPrice: 20000 });
  // Only AI is injected. WhatsApp remains the actual Cloud API adapter with mocked fetch.
  runtime = await buildApp({
    db,
    env,
    ai: new DemoAiService({ catalog }),
    startWorker: false,
    logger: false,
  });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', http);
  directory = await mkdtemp(join(tmpdir(), 'musicbox-staging-'));
  const port = await freePort();
  pg = new EmbeddedPostgres({
    databaseDir: join(directory, 'postgres'),
    port,
    user: 'musicbox',
    password: 'musicbox',
    persistent: false,
    postgresFlags: ['-h', '127.0.0.1'],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  started = true;
  await pg.createDatabase('staging_test');
  const url = `postgresql://musicbox:musicbox@127.0.0.1:${port}/staging_test`;
  await promisify(execFile)(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    {
      env: { ...process.env, DIRECT_URL: '', DATABASE_URL: url },
      timeout: 60000,
    },
  );
  env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    DIRECT_URL: '',
    APP_BASE_URL: 'https://staging.example.test',
    INTEGRATION_MODE: 'staging',
    PAYMENT_PROVIDER: 'mock',
    ADMIN_TOKEN: 'a'.repeat(32),
    MOCK_PAYMENT_SECRET: 'm'.repeat(32),
    WHATSAPP_ACCESS_TOKEN: 'staging-meta-token',
    WHATSAPP_PHONE_NUMBER_ID: 'staging-phone',
    WHATSAPP_WABA_ID: 'staging-waba',
    WHATSAPP_VERIFY_TOKEN: 'staging-verify-token',
    WHATSAPP_APP_SECRET: 'staging-app-secret',
    WHATSAPP_GRAPH_API_VERSION: 'v99.0',
    OPENAI_API_KEY: 'staging-openai-placeholder',
    OPENAI_MODEL: 'dummy-model',
    GOOGLE_SHEETS_ENABLED: 'false',
    TELEGRAM_ENABLED: 'false',
    MANAGER_HANDOFF_ENABLED: 'false',
    LOG_LEVEL: 'silent',
  });
  db = createDatabase(url);
  await startApp();
});

afterAll(async () => {
  if (runtime) await runtime.app.close();
  if (db) await db.$disconnect();
  if (started) await pg.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const message = (from: string, text: string, id = randomUUID()): MetaMessage => ({
  id,
  from,
  type: 'text',
  timestamp: String(Math.floor(Date.now() / 1000)),
  text: { body: text },
});
const envelope = (messages: MetaMessage[], statuses: unknown[] = []) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: env.WHATSAPP_WABA_ID,
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID },
            messages,
            statuses,
          },
        },
      ],
    },
  ],
});
async function receive(messages: MetaMessage[], statuses: unknown[] = [], valid = true) {
  const payload = JSON.stringify(envelope(messages, statuses));
  return runtime.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    payload,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac(
        'sha256',
        valid ? env.WHATSAPP_APP_SECRET : 'wrong-secret',
      )
        .update(payload)
        .digest('hex')}`,
    },
  });
}
async function deliver(input: MetaMessage) {
  const response = await receive([input]);
  expect(response.statusCode, response.body).toBe(200);
  await runtime.worker.drain();
  return db.customer.findUniqueOrThrow({ where: { whatsappId: input.from } });
}
const text = (from: string, value: string) => deliver(message(from, value));
async function click(from: string, actionId: string, list = false) {
  const customer = await db.customer.findUniqueOrThrow({ where: { whatsappId: from } });
  const token = await db.actionToken.findFirstOrThrow({
    where: {
      customerId: customer.id,
      actionId,
      conversationVersion: customer.conversationVersion,
      consumedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });
  expect(token.token).not.toBe(actionId);
  const replyType = list ? 'list_reply' : 'button_reply';
  return deliver({
    ...message(from, ''),
    type: 'interactive',
    text: undefined,
    interactive: {
      type: replyType,
      [replyType]: { id: token.token, title: 'Untrusted translated title' },
    },
  });
}
async function messagesFor(from: string) {
  const customer = await db.customer.findUniqueOrThrow({ where: { whatsappId: from } });
  return db.message.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'asc' } });
}
async function begin(from: string, language: Language) {
  await text(from, language === 'ru' ? 'Сколько стоит?' : 'Бағасы қанша?');
  await click(from, language === 'ru' ? A.LANG_RU : A.LANG_KK);
  const messages = await messagesFor(from);
  expect(
    messages.some((m) => m.direction === 'outbound' && /20\s*000/u.test(m.content ?? '')),
  ).toBe(true);
  return click(from, A.MENU_ORDER);
}

describe('staging: signed Meta ingress and actual WhatsApp adapter', () => {
  it('acks only durable authenticated events before any worker, and deduplicates concurrent inbound deliveries', async () => {
    const from = phone();
    const incoming = message(from, 'Здравствуйте');
    const sendsBefore = sent.length;
    expect((await receive([incoming], [], false)).statusCode).toBe(401);
    expect(await db.webhookEvent.count({ where: { externalEventId: incoming.id } })).toBe(0);
    const responses = await Promise.all([receive([incoming]), receive([incoming])]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(
      await db.webhookEvent.findFirst({ where: { externalEventId: incoming.id } }),
    ).toMatchObject({ status: 'RECEIVED', attempts: 0 });
    expect(await db.customer.findUnique({ where: { whatsappId: from } })).toBeNull();
    expect(sent.length).toBe(sendsBefore);
    await runtime.worker.drain();
    const customer = await db.customer.findUniqueOrThrow({ where: { whatsappId: from } });
    expect(customer.conversationState).toBe('AWAITING_LANGUAGE');
    expect(await db.order.count({ where: { customerId: customer.id } })).toBe(0);
    const before = await messagesFor(from);
    expect(before.filter((m) => m.direction === 'inbound')).toHaveLength(1);
    expect(before.filter((m) => m.direction === 'outbound')).toHaveLength(1);
    expect(before.find((m) => m.direction === 'outbound')).toMatchObject({
      deliveryStatus: 'ACCEPTED',
    });
    expect(sent.length).toBe(sendsBefore + 1);
    expect(sent.at(-1)?.body).toMatchObject({
      messaging_product: 'whatsapp',
      to: from,
      type: 'interactive',
      biz_opaque_callback_data: expect.any(String),
    });
    await receive([incoming]);
    await runtime.worker.drain();
    expect(await messagesFor(from)).toHaveLength(before.length);
    expect(sent.length).toBe(sendsBefore + 1);
  });

  it('serves the verification challenge but exposes no local developer routes', async () => {
    const verified = await runtime.app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${env.WHATSAPP_VERIFY_TOKEN}&hub.challenge=challenge-123`,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.body).toBe('challenge-123');
    expect(
      (
        await runtime.app.inject({
          method: 'GET',
          url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123',
        })
      ).statusCode,
    ).toBe(403);
    for (const url of [
      '/dev/state?from=77001234567',
      '/dev/mock-payment/anything',
      '/simulator.js',
    ])
      expect((await runtime.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect(
      (
        await runtime.app.inject({
          method: 'POST',
          url: '/dev/simulate-whatsapp',
          payload: { from: phone(), text: 'hello' },
        })
      ).statusCode,
    ).toBe(404);
    expect((await runtime.app.inject({ method: 'GET', url: '/' })).json()).toMatchObject({
      status: 'running',
    });
  });

  it('deduplicates an order-start button before and after its opaque token is consumed', async () => {
    const from = phone();
    await text(from, 'Здравствуйте');
    const customer = await click(from, A.LANG_RU);
    const token = await db.actionToken.findFirstOrThrow({
      where: {
        customerId: customer.id,
        conversationVersion: customer.conversationVersion,
        actionId: A.MENU_ORDER,
        consumedAt: null,
      },
    });
    const incoming = {
      ...message(from, ''),
      type: 'interactive',
      text: undefined,
      interactive: { type: 'button_reply', button_reply: { id: token.token } },
    };
    const received = await Promise.all([receive([incoming]), receive([incoming])]);
    expect(received.map((response) => response.statusCode)).toEqual([200, 200]);
    await runtime.worker.drain();
    const started = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
    const messageCount = (await messagesFor(from)).length;
    const sendsBefore = sent.length;
    expect(started.conversationState).toBe('ORDER_NAME');
    expect(await db.order.count({ where: { customerId: customer.id } })).toBe(1);
    expect(
      (await db.actionToken.findUniqueOrThrow({ where: { token: token.token } })).consumedAt,
    ).not.toBeNull();
    await receive([incoming]);
    await runtime.worker.drain();
    expect(await db.order.count({ where: { customerId: customer.id } })).toBe(1);
    expect(await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).toMatchObject({
      currentOrderId: started.currentOrderId,
      conversationVersion: started.conversationVersion,
    });
    expect(await messagesFor(from)).toHaveLength(messageCount);
    expect(sent.length).toBe(sendsBefore);
  });

  it.each(['ru', 'kk'] as const)(
    'keeps %s drafts working when manager and external reporting are disabled',
    async (language) => {
      const from = phone();
      const started = await begin(from, language);
      expect(started.privacyNoticeVersion).toBe('DEMO-privacy-1');
      expect(started.notificationConsent).toBe(false);
      await text(from, 'Арман Тестовый');
      const orderBefore = await db.order.findUniqueOrThrow({
        where: { id: started.currentOrderId! },
      });
      const manager = await text(from, language === 'ru' ? 'Позовите менеджера' : 'Кеңесші керек');
      expect(manager.conversationState).toBe('ORDER_PHONE');
      expect(await db.order.findUniqueOrThrow({ where: { id: orderBefore.id } })).toMatchObject({
        recipientName: orderBefore.recipientName,
        totalAmount: 20000,
        paymentStatus: 'NOT_CREATED',
      });
      expect(await db.handoff.count({ where: { customerId: manager.id } })).toBe(0);
      expect((await messagesFor(from)).at(-1)?.content).toContain(
        language === 'ru' ? 'не подключён' : 'қосылмаған',
      );
      await text(from, '+77011234567');
      await text(from, 'Алматы');
      await text(from, 'Абая 10, тестовая квартира 1');
      await click(from, `${A.DISC_PREFIX}${runtime.catalog.discs()[0]!.id}`, true);
      await click(from, A.DISC_DONE);
      const confirmed = await click(from, A.ORDER_QUANTITY_ONE);
      expect(confirmed.conversationState).toBe('ORDER_CONFIRMATION');
      const order = await db.order.findUniqueOrThrow({ where: { id: confirmed.currentOrderId! } });
      expect(order).toMatchObject({
        totalAmount: 20000,
        subtotalAmount: 20000,
        deliveryAmount: 0,
        deliveryMode: 'PAID_SEPARATELY',
        quantity: 1,
        currency: 'KZT',
      });
      expect(order.selectedDiscIds).toEqual([runtime.catalog.discs()[0]!.id]);
      expect(
        await db.outboxJob.count({ where: { customerId: manager.id, kind: 'TELEGRAM' } }),
      ).toBe(0);
    },
  );

  it('recovers an acknowledged event and its existing order after rebuilding the application', async () => {
    const from = phone();
    const customer = await begin(from, 'ru');
    await text(from, 'Алия Тестовая');
    const before = await db.order.findUniqueOrThrow({ where: { id: customer.currentOrderId! } });
    const incoming = message(from, '+77011234567');
    expect((await receive([incoming])).statusCode).toBe(200);
    await runtime.app.close();
    await startApp();
    expect(await db.order.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    await runtime.worker.drain();
    const restored = await db.customer.findUniqueOrThrow({ where: { whatsappId: from } });
    expect(restored).toMatchObject({ currentOrderId: before.id, conversationState: 'ORDER_CITY' });
    expect(await db.order.count({ where: { customerId: restored.id } })).toBe(1);
    expect(await db.order.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({
      recipientName: 'Алия Тестовая',
      recipientPhone: '+77011234567',
    });
    expect(await db.message.count({ where: { whatsappMessageId: incoming.id } })).toBe(1);
  });

  it('closes a legacy manager ticket when handoff is disabled and resumes the preserved draft', async () => {
    const from = phone();
    const customer = await begin(from, 'ru');
    await text(from, 'Арман Тестовый');
    const before = await db.order.findUniqueOrThrow({ where: { id: customer.currentOrderId! } });
    await db.customer.update({
      where: { id: customer.id },
      data: { conversationState: 'HUMAN_HANDOFF', previousState: 'ORDER_PHONE' },
    });
    const ticket = await db.handoff.create({
      data: {
        customerId: customer.id,
        reason: 'LEGACY_MANAGER_REQUEST',
        previousState: 'ORDER_PHONE',
        status: 'ASSIGNED',
        assignedManagerId: 'old-manager',
      },
    });
    const resumed = await text(from, '+77011234567');
    expect(resumed).toMatchObject({
      conversationState: 'ORDER_PHONE',
      previousState: null,
      currentOrderId: before.id,
    });
    expect(await db.order.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({
      recipientName: before.recipientName,
      recipientPhone: null,
      contentVersion: before.contentVersion,
      totalAmount: before.totalAmount,
    });
    expect(await db.handoff.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      status: 'CLOSED',
      closedAt: expect.any(Date),
    });
    const replies = await messagesFor(from);
    expect(
      replies.some((m) => m.direction === 'outbound' && m.content?.includes('не подключён')),
    ).toBe(true);
    expect(
      replies.some((m) => m.direction === 'outbound' && m.content?.includes('номер телефона')),
    ).toBe(true);
    expect(
      await db.handoff.count({
        where: { customerId: customer.id, status: { in: ['OPEN', 'ASSIGNED'] } },
      }),
    ).toBe(0);
    expect((await text(from, '+77011234567')).conversationState).toBe('ORDER_CITY');
    expect(await db.order.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({
      recipientName: before.recipientName,
      recipientPhone: '+77011234567',
    });
  });

  it('uses signed staging mock checkout once, blocks disabled exports, and correlates Meta delivery status', async () => {
    const from = phone();
    await begin(from, 'ru');
    await text(from, 'Арман Тестовый');
    await text(from, '+77011234567');
    await text(from, 'Алматы');
    await text(from, 'Абая 10, тестовая квартира 1');
    await click(from, `${A.DISC_PREFIX}${runtime.catalog.discs()[0]!.id}`, true);
    await click(from, A.DISC_DONE);
    await click(from, A.ORDER_QUANTITY_ONE);
    const customer = await click(from, A.ORDER_CONFIRM);
    const pending = await db.order.findUniqueOrThrow({ where: { id: customer.currentOrderId! } });
    expect(pending).toMatchObject({ paymentStatus: 'PENDING', totalAmount: 20000 });
    expect(pending.checkoutFrozenAt).not.toBeNull();
    const attempts = await db.paymentAttempt.findMany({ where: { orderId: pending.id } });
    expect(attempts).toHaveLength(1);
    const checkout = new URL(pending.paymentUrl!);
    expect(checkout.origin).toBe(env.APP_BASE_URL);
    expect(checkout.pathname).toBe(`/mock-payment/${attempts[0]!.id}`);
    expect(checkout.searchParams.get('token')).toBeTruthy();
    const path = checkout.pathname + checkout.search;
    expect((await runtime.app.inject({ method: 'GET', url: checkout.pathname })).statusCode).toBe(
      403,
    );
    expect(
      (
        await runtime.app.inject({
          method: 'POST',
          url: `${checkout.pathname}?expires=1&token=bad`,
          payload: { status: 'SUCCESS' },
        })
      ).statusCode,
    ).toBe(403);
    const page = await runtime.app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Деньги не списываются');
    await text(from, 'я оплатил');
    expect((await db.order.findUniqueOrThrow({ where: { id: pending.id } })).paymentStatus).toBe(
      'PENDING',
    );
    const paid = await runtime.app.inject({
      method: 'POST',
      url: path,
      payload: { status: 'SUCCESS' },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    await runtime.worker.drain();
    const saved = await db.order.findUniqueOrThrow({ where: { id: pending.id } });
    expect(saved).toMatchObject({
      paymentStatus: 'PAID',
      totalAmount: 20000,
      sheetSyncStatus: 'BLOCKED',
      sheetRowReference: null,
    });
    expect(saved.paidAt).not.toBeNull();
    const paidMessage = (await messagesFor(from)).find(
      (m) => m.direction === 'outbound' && m.content?.startsWith('Оплата получена'),
    )!;
    expect(paidMessage).toMatchObject({ deliveryStatus: 'ACCEPTED' });
    const sentBeforeDuplicate = sent.length;
    expect(
      (await runtime.app.inject({ method: 'POST', url: path, payload: { status: 'SUCCESS' } }))
        .statusCode,
    ).toBe(200);
    await runtime.worker.drain();
    expect(sent.length).toBe(sentBeforeDuplicate);
    expect(
      (await messagesFor(from)).filter((m) => m.content?.startsWith('Оплата получена')),
    ).toHaveLength(1);
    expect(await db.paymentAttempt.count({ where: { orderId: pending.id, status: 'PAID' } })).toBe(
      1,
    );
    const disabledJobs = await db.outboxJob.findMany({
      where: { orderId: pending.id, kind: { in: ['SHEETS', 'TELEGRAM'] } },
    });
    expect(disabledJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'SHEETS',
          status: 'BLOCKED',
          lastError: 'GOOGLE_SHEETS_DISABLED',
        }),
        expect.objectContaining({
          kind: 'TELEGRAM',
          status: 'BLOCKED',
          lastError: 'TELEGRAM_DISABLED',
        }),
      ]),
    );
    expect(await db.sheetBinding.count({ where: { orderId: pending.id } })).toBe(0);
    expect(await db.telegramMessageBinding.count({ where: { customerId: customer.id } })).toBe(0);
    const delivered = {
      id: paidMessage.whatsappMessageId!,
      status: 'delivered',
      recipient_id: from,
      timestamp: String(Math.floor(Date.now() / 1000)),
      biz_opaque_callback_data: paidMessage.outboxJobId!,
    };
    expect((await receive([], [delivered])).statusCode).toBe(200);
    await runtime.worker.drain();
    expect(await db.message.findUniqueOrThrow({ where: { id: paidMessage.id } })).toMatchObject({
      deliveryStatus: 'DELIVERED',
      deliveredAt: expect.any(Date),
    });
    expect(
      http.mock.calls.every(([url]) => String(url).startsWith('https://graph.facebook.com/')),
    ).toBe(true);
  });
});
