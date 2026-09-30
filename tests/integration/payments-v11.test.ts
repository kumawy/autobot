import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import type { PrismaClient, PaymentAttempt, PaymentStatus, OrderStatus } from '@prisma/client';
import { XMLBuilder } from 'fast-xml-parser';
import { createDatabase, json } from '../../src/db/prisma.js';
import { PaymentService } from '../../src/modules/payments/payment.service.js';
import {
  FreedomPayProvider,
  freedomPaySignature,
} from '../../src/modules/payments/freedompay.provider.js';
import type {
  PaymentProvider,
  VerifiedPaymentEvent,
} from '../../src/modules/payments/payment-provider.interface.js';

let db: PrismaClient;
let service: PaymentService;
let postgres: EmbeddedPostgres;
let directory: string;
let started = false;
let paymentSequence = 70000000;
const freedomSecret = 'integration-freedom-key-not-real';
const freedom = new FreedomPayProvider({
  merchantId: '999',
  secretKey: freedomSecret,
  baseUrl: 'https://api.freedompay.kz',
  appBaseUrl: 'https://shop.example',
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'musicbox-payments-v11-'));
  postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'postgres'),
    port: await freePort(),
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
  await postgres.createDatabase('payments');
  const client = postgres.getPgClient();
  await client.connect();
  const address = await client.query<{ port: string }>('SHOW port');
  await client.end();
  const url = `postgresql://musicbox:musicbox@127.0.0.1:${address.rows[0]!.port}/payments`;
  await promisify(execFile)(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DIRECT_URL: '', DATABASE_URL: url },
      timeout: 60000,
    },
  );
  db = createDatabase(url);
  service = new PaymentService(db);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  if (db) await db.$disconnect();
  if (started) await postgres.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(
  options: {
    status?: PaymentStatus;
    orderStatus?: OrderStatus;
    provider?: string;
    merchantId?: string;
    external?: boolean;
    contentVersion?: number;
    legacy?: boolean;
  } = {},
) {
  const customer = await db.customer.create({
    data: {
      whatsappId: `payment-test-${randomUUID()}`,
      preferredLanguage: 'ru',
      conversationState: 'PAYMENT_PENDING',
    },
  });
  const order = await db.order.create({
    data: {
      customerId: customer.id,
      publicOrderId: `TEST-${randomUUID()}`,
      productId: 'test',
      productName: 'Шкатулка',
      unitPrice: 20000,
      subtotalAmount: 20000,
      totalAmount: 20000,
      orderStatus: options.orderStatus ?? 'AWAITING_PAYMENT',
      paymentStatus: options.status ?? 'PENDING',
      contentVersion: options.contentVersion ?? 1,
      checkoutFrozenAt: new Date(),
    },
  });
  await db.customer.update({ where: { id: customer.id }, data: { currentOrderId: order.id } });
  const attempt = await db.paymentAttempt.create({
    data: {
      orderId: order.id,
      provider: options.provider ?? 'mock',
      merchantId: options.merchantId ?? 'demo',
      merchantReference: randomUUID(),
      orderVersion: 1,
      amount: 20000,
      currency: 'KZT',
      status: options.status ?? 'PENDING',
      externalPaymentId: options.external === false ? null : String(++paymentSequence),
      paymentUrl: options.external === false ? null : 'https://checkout.example/pay',
      snapshot: {
        amount: 20000,
        currency: 'KZT',
        orderVersion: 1,
        ...(options.legacy ? { legacyMigration: true, legacyMerchantReference: order.id } : {}),
      },
    },
  });
  return { customer, order, attempt };
}
function result(
  attempt: PaymentAttempt,
  overrides: Partial<VerifiedPaymentEvent> = {},
): VerifiedPaymentEvent {
  const status = overrides.status ?? 'PAID';
  return {
    eventId: `${attempt.provider}:${attempt.merchantId}:${attempt.externalPaymentId}:PAYMENT:${status}`,
    provider: attempt.provider,
    externalPaymentId: attempt.externalPaymentId!,
    merchantId: attempt.merchantId,
    merchantReference: attempt.merchantReference,
    amount: '20000.00',
    currency: 'KZT',
    status,
    operation: 'PAYMENT',
    ...overrides,
  };
}
async function secondAttempt(first: PaymentAttempt) {
  return db.paymentAttempt.create({
    data: {
      orderId: first.orderId,
      provider: first.provider,
      merchantId: first.merchantId,
      merchantReference: randomUUID(),
      orderVersion: 1,
      amount: first.amount,
      currency: first.currency,
      externalPaymentId: String(++paymentSequence),
      status: 'PENDING',
      paymentUrl: 'https://checkout.example/another',
      createdAt: new Date(first.createdAt.getTime() + 1000),
    },
  });
}
function callback(
  attempt: PaymentAttempt,
  overrides: Record<string, string> = {},
  omitCurrency = false,
) {
  const fields: Record<string, string> = {
    pg_payment_id: attempt.externalPaymentId!,
    pg_order_id: attempt.merchantReference,
    pg_amount: '20000.00',
    pg_currency: 'KZT',
    pg_result: '1',
    pg_captured: '1',
    pg_testing_mode: '1',
    pg_salt: randomUUID(),
    ...overrides,
  };
  if (omitCurrency) delete fields.pg_currency;
  fields.pg_sig = freedomPaySignature('freedompay', fields, freedomSecret);
  return {
    body: fields,
    rawBody: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}
function statusResponse(attempt: PaymentAttempt, overrides: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    pg_status: 'ok',
    pg_payment_id: attempt.externalPaymentId!,
    pg_amount: '20000',
    pg_currency: 'KZT',
    pg_payment_status: 'success',
    pg_captured: '1',
    pg_salt: randomUUID(),
    ...overrides,
  };
  fields.pg_sig = freedomPaySignature('get_status3.php', fields, freedomSecret);
  return new Response(new XMLBuilder().build({ response: fields }));
}

describe('P02/P03 durable financial decisions in PostgreSQL', () => {
  it('T05: concurrent repeats apply one capture and one logical customer confirmation', async () => {
    const { order, attempt, customer } = await fixture();
    const event = result(attempt);
    await Promise.all(Array.from({ length: 5 }, () => service.apply(event)));
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      paymentStatus: 'PAID',
      appliedPaymentAttemptId: attempt.id,
      fulfillmentHold: false,
    });
    expect(await db.outboxJob.count({ where: { dedupeKey: `paid:${order.id}` } })).toBe(1);
    expect(await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).toMatchObject({
      conversationVersion: 1,
    });
    expect(await db.paymentIncident.count({ where: { orderId: order.id } })).toBe(0);
  });
  it('T06: late failed and pending results never regress confirmed payment or shipped fulfillment', async () => {
    const { order, attempt } = await fixture();
    await service.apply(result(attempt));
    await db.order.update({ where: { id: order.id }, data: { orderStatus: 'SHIPPED' } });
    await service.apply(result(attempt, { status: 'FAILED' }));
    await service.apply(result(attempt, { status: 'PENDING' }));
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      paymentStatus: 'PAID',
      orderStatus: 'SHIPPED',
    });
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe(
      'PAID',
    );
  });
  it('T07: first successful old link is applied; distinct second receipt is recorded with hold and incident', async () => {
    const { order, attempt } = await fixture({ status: 'FAILED' });
    const newer = await secondAttempt(attempt);
    await service.apply(result(attempt));
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).appliedPaymentAttemptId,
    ).toBe(attempt.id);
    await service.apply(result(newer));
    await service.apply(result(newer));
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      appliedPaymentAttemptId: attempt.id,
      externalPaymentId: attempt.externalPaymentId,
      fulfillmentHold: true,
      reviewRequired: true,
    });
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: newer.id } })).status).toBe(
      'PAID',
    );
    expect(
      await db.paymentIncident.count({ where: { orderId: order.id, reason: 'DUPLICATE_PAYMENT' } }),
    ).toBe(1);
    expect(await db.outboxJob.count({ where: { dedupeKey: `paid:${order.id}` } })).toBe(1);
  });
  it('T08: paid cancellation remains cancelled with a financial receipt, hold and Sheets update, no fulfillment promise', async () => {
    const { order, attempt } = await fixture({ orderStatus: 'CANCELLED' });
    await service.apply(result(attempt));
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      orderStatus: 'CANCELLED',
      paymentStatus: 'PAID',
      appliedPaymentAttemptId: attempt.id,
      fulfillmentHold: true,
      sheetSyncStatus: 'PENDING',
    });
    expect(
      await db.paymentIncident.count({ where: { orderId: order.id, reason: 'LATE_PAYMENT' } }),
    ).toBe(1);
    expect(
      await db.outboxJob.count({ where: { orderId: order.id, kind: 'SHEETS' } }),
    ).toBeGreaterThan(0);
    expect(await db.outboxJob.count({ where: { dedupeKey: `paid:${order.id}` } })).toBe(0);
  });
  it.each([
    [{ amount: '20000.01' }, 'AMOUNT_MISMATCH'],
    [{ currency: 'USD' }, 'CURRENCY_MISMATCH'],
    [{ merchantId: 'another' }, 'MERCHANT_MISMATCH'],
    [{ amount: '2e4' }, 'INVALID_PROVIDER_AMOUNT'],
  ] as const)(
    'T09: authentic anomaly %o remains auditable and cannot pay an order',
    async (override, reason) => {
      const { order, attempt } = await fixture();
      await service.apply(result(attempt, override));
      expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
        paymentStatus: 'PENDING',
        fulfillmentHold: true,
      });
      expect(
        (await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      ).toBe('REVIEW_REQUIRED');
      const incident = await db.paymentIncident.findFirstOrThrow({ where: { orderId: order.id } });
      expect(incident.reason).toBe(reason);
      expect(incident.actualAmount).toBe('amount' in override ? override.amount : '20000');
    },
  );
  it('T09: immutable version disagreement requires review even when the amount is unchanged', async () => {
    const { order, attempt } = await fixture({ contentVersion: 2 });
    await service.apply(result(attempt));
    expect(
      await db.paymentIncident.findFirstOrThrow({ where: { orderId: order.id } }),
    ).toMatchObject({ reason: 'ORDER_VERSION_MISMATCH' });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).not.toBe(
      'PAID',
    );
  });
  it('T10: unknown genuine receipt creates an unlinked stable incident without matching by amount', async () => {
    const { order, attempt } = await fixture();
    const event = result(attempt, {
      externalPaymentId: String(++paymentSequence),
      merchantReference: 'unknown-reference',
      eventId: randomUUID(),
    });
    await service.apply(event);
    await service.apply(event);
    const incident = await db.paymentIncident.findFirstOrThrow({
      where: { reason: 'UNKNOWN_PAYMENT', details: { path: ['eventId'], equals: event.eventId } },
    });
    expect(incident.orderId).toBeNull();
    expect(incident.actualAmount).toBe('20000');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
      'PENDING',
    );
  });
  it('T11: signed callbacks return the exact committed acknowledgement on retries with different salts', async () => {
    const { order, attempt } = await fixture({ provider: 'freedompay', merchantId: '999' });
    const ack = await service.receiveWebhook(freedom, callback(attempt));
    const repeated = await service.receiveWebhook(freedom, callback(attempt));
    expect(repeated).toEqual(ack);
    expect(ack.statusCode).toBe(200);
    expect(ack.body).toContain('<pg_status>ok</pg_status>');
    expect(await db.webhookEvent.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({
      status: 'PROCESSED',
      acknowledgement: ack,
    });
    const tampered = callback(attempt);
    tampered.rawBody = tampered.rawBody.replace('20000.00', '1.00');
    const count = await db.webhookEvent.count();
    await expect(service.receiveWebhook(freedom, tampered)).rejects.toThrow('signature');
    expect(await db.webhookEvent.count()).toBe(count);
  });
  it('T11: callback is committed before a signed status lookup; missing currency is never guessed', async () => {
    const { attempt } = await fixture({ provider: 'freedompay', merchantId: '999' });
    const fetchMock = vi.fn(async () => {
      const received = await db.webhookEvent.findFirstOrThrow({ where: { attemptId: attempt.id } });
      expect(received.status).toBe('RECEIVED');
      expect(received.processedAt).toBeNull();
      return statusResponse(attempt);
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await service.receiveWebhook(freedom, callback(attempt, {}, true))).statusCode).toBe(
      200,
    );
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: attempt.orderId } })).paymentStatus,
    ).toBe('PAID');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('T11: transient reconciliation failure persists retry; later reconciliation completes the same saved callback', async () => {
    const { order, attempt } = await fixture({ provider: 'freedompay', merchantId: '999' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('temporary outage')));
    const input = callback(attempt, {}, true);
    const failed = await service.receiveWebhook(freedom, input);
    expect(failed.statusCode).toBe(503);
    expect(failed.body).toContain('<pg_status>error</pg_status>');
    expect(
      await db.webhookEvent.findFirstOrThrow({ where: { attemptId: attempt.id } }),
    ).toMatchObject({ status: 'RETRY', processedAt: null, acknowledgement: null });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
      'PENDING',
    );
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(attempt));
    vi.stubGlobal('fetch', fetchMock);
    await service.reconcileAttempt(freedom, attempt.id);
    const ack = await service.receiveWebhook(freedom, input);
    expect(ack.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
      'PAID',
    );
  });
  it('T04: unknown creation is looked up by immutable reference; no second create is performed', async () => {
    const { order, attempt } = await fixture({ status: 'CREATION_UNKNOWN', external: false });
    const provider: PaymentProvider = {
      name: 'mock',
      merchantId: 'demo',
      createPayment: vi.fn(),
      verifyWebhook: vi.fn(),
      getPaymentStatus: vi.fn(),
      getPaymentStatusByReference: vi.fn(async (reference) => ({
        ...result(attempt),
        externalPaymentId: String(++paymentSequence),
        merchantReference: reference,
      })),
      acknowledge: () => ({ body: 'accepted', contentType: 'text/plain', statusCode: 200 }),
    };
    await service.reconcileAttempt(provider, attempt.id);
    expect(provider.getPaymentStatusByReference).toHaveBeenCalledWith(attempt.merchantReference);
    expect(provider.createPayment).not.toHaveBeenCalled();
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
      'PAID',
    );
    expect(await db.paymentAttempt.count({ where: { orderId: order.id } })).toBe(1);
  });
  it('T12: distinct refund operations stay distinct, hold fulfillment and do not become failure/cancellation', async () => {
    const { order, attempt } = await fixture();
    await service.apply(result(attempt));
    await db.order.update({ where: { id: order.id }, data: { orderStatus: 'COMPLETED' } });
    const capture = result(attempt, {
      verificationIssue: 'REFUND_REQUIRES_REVIEW',
      relatedEvents: [
        result(attempt, {
          eventId: `refund:${attempt.id}:1`,
          operation: 'REFUND',
          operationId: '1',
          status: 'REFUNDED',
          amount: '-10000',
        }),
        result(attempt, {
          eventId: `refund:${attempt.id}:2`,
          operation: 'REFUND',
          operationId: '2',
          status: 'REFUNDED',
          amount: '-5000.01',
        }),
      ],
    });
    await service.apply(capture);
    await service.apply(capture);
    expect(
      await db.webhookEvent.count({ where: { attemptId: attempt.id, eventType: 'REFUND' } }),
    ).toBe(2);
    expect(
      await db.paymentIncident.count({
        where: { orderId: order.id, reason: 'REFUND_REVIEW_REQUIRED' },
      }),
    ).toBe(2);
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      paymentStatus: 'PAID',
      orderStatus: 'COMPLETED',
      fulfillmentHold: true,
    });
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe(
      'PAID',
    );
  });
  it('resolving one incident cannot release another open financial hold or forge a financial status', async () => {
    const { order, attempt } = await fixture();
    await service.apply(result(attempt, { amount: '20000.01' }));
    await service.apply(result(attempt, { eventId: randomUUID(), currency: 'USD' }));
    const incidents = await db.paymentIncident.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(incidents).toHaveLength(2);
    expect(
      await service.resolveIncident(incidents[0]!.id, {
        actor: 'manager-1',
        comment: 'Bank checked',
        releaseHold: true,
      }),
    ).toMatchObject({ hold: true });
    expect(
      await service.resolveIncident(incidents[1]!.id, {
        actor: 'manager-1',
        comment: 'Resolved manually',
        releaseHold: true,
      }),
    ).toMatchObject({ hold: false });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      paymentStatus: 'PENDING',
      reviewRequired: false,
      fulfillmentHold: false,
    });
    expect(
      await db.paymentIncident.findUniqueOrThrow({ where: { id: incidents[1]!.id } }),
    ).toMatchObject({ resolvedBy: 'manager-1', resolutionComment: 'Resolved manually' });
  });
});

describe('Financial recovery fencing and explicit legacy references', () => {
  it('does not commit a status result after another worker owns the lease', async () => {
    const { order, attempt } = await fixture();
    const job = await db.outboxJob.create({
      data: {
        dedupeKey: randomUUID(),
        kind: 'PAYMENT_RECONCILE',
        orderId: order.id,
        payload: { attemptId: attempt.id },
        status: 'PROCESSING',
        lockToken: 'stale-token',
        lockedUntil: new Date(Date.now() + 60000),
      },
    });
    const provider: PaymentProvider = {
      name: 'mock',
      createPayment: vi.fn(),
      verifyWebhook: vi.fn(),
      getPaymentStatus: vi.fn(async () => {
        await db.outboxJob.update({
          where: { id: job.id },
          data: { lockToken: 'replacement-token' },
        });
        return result(attempt);
      }),
      acknowledge: () => ({ body: 'ok', contentType: 'text/plain' }),
    };
    await expect(
      service.reconcileAttempt(provider, attempt.id, undefined, {
        jobId: job.id,
        lockToken: 'stale-token',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_LEASE_LOST' });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
      'PENDING',
    );
    expect(
      (await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).lastReconcileAt,
    ).toBeNull();
    const received = await db.webhookEvent.findFirstOrThrow({ where: { attemptId: attempt.id } });
    await service.replayReceivedEvent(received.id, provider, {
      jobId: job.id,
      lockToken: 'replacement-token',
    });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
      'PAID',
    );
  });
  it('replays an authenticated unlinked event after a crash, without needing a payment attempt', async () => {
    const event: VerifiedPaymentEvent = {
      eventId: randomUUID(),
      externalPaymentId: 'unknown-' + randomUUID(),
      provider: 'mock',
      merchantId: 'demo',
      status: 'PAID',
      amount: '20000',
      currency: 'KZT',
    };
    const inbox = await db.webhookEvent.create({
      data: {
        provider: 'mock',
        externalEventId: event.eventId,
        eventType: 'PAYMENT:PAID',
        payload: json(event),
        authenticatedAt: new Date(),
      },
    });
    const provider: PaymentProvider = {
      name: 'mock',
      createPayment: vi.fn(),
      verifyWebhook: vi.fn(),
      getPaymentStatus: vi.fn(),
      acknowledge: () => ({ body: 'committed', contentType: 'text/plain' }),
    };
    const ack = await service.replayReceivedEvent(inbox.id, provider);
    expect(ack.body).toBe('committed');
    expect(provider.verifyWebhook).not.toHaveBeenCalled();
    expect(provider.getPaymentStatus).not.toHaveBeenCalled();
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: inbox.id } })).toMatchObject({
      status: 'PROCESSED',
    });
    expect(
      await db.paymentIncident.findFirstOrThrow({
        where: { details: { path: ['eventId'], equals: event.eventId } },
      }),
    ).toMatchObject({ reason: 'UNKNOWN_PAYMENT', orderId: null });
  });
  it('accepts the old order reference only on an explicitly migrated attempt with an exact known payment ID', async () => {
    const legacy = await fixture({ legacy: true });
    await service.apply(result(legacy.attempt, { merchantReference: legacy.order.id }));
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: legacy.order.id } })).paymentStatus,
    ).toBe('PAID');
    const modern = await fixture();
    await service.apply(result(modern.attempt, { merchantReference: modern.order.id }));
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: modern.order.id } })).paymentStatus,
    ).not.toBe('PAID');
    expect(
      await db.paymentIncident.findFirstOrThrow({ where: { orderId: modern.order.id } }),
    ).toMatchObject({ reason: 'PAYMENT_IDENTITY_MISMATCH' });
    const unbound = await fixture({ legacy: true, external: false, status: 'CREATION_UNKNOWN' });
    await service.apply(
      result(unbound.attempt, {
        externalPaymentId: String(++paymentSequence),
        merchantReference: unbound.order.id,
        eventId: randomUUID(),
      }),
    );
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: unbound.order.id } })).paymentStatus,
    ).not.toBe('PAID');
  });
});
