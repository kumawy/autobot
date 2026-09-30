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
import {
  GoogleSheetsService,
  SHEET_HEADERS,
  type SheetOrder,
} from '../../src/modules/sheets/google-sheets.service.js';
import { HandoffService } from '../../src/modules/notifications/handoff.service.js';
import { migrateLegacySheetRows } from '../../src/modules/sheets/legacy-migration.js';

const api = vi.hoisted(() => ({
  metadata: vi.fn(),
  batchUpdate: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  append: vi.fn(),
}));
vi.mock('googleapis', () => ({
  google: {
    sheets: () => ({
      spreadsheets: {
        get: api.metadata,
        batchUpdate: api.batchUpdate,
        values: { get: api.get, update: api.update, append: api.append },
      },
    }),
    auth: { JWT: class {} },
  },
}));
let db: PrismaClient;
let postgres: EmbeddedPostgres;
let directory: string;
let started = false;
const rows = new Map<string, (string | number)[]>();
let phoneSequence = 0;
let updateSequence = 0;
const chatId = '-100123';
const webhookSecret = 'telegram-test-secret';
const handoff = () =>
  new HandoffService({ db, chatId, allowedManagerIds: ['11', '22'], webhookSecret });
const sheets = () =>
  new GoogleSheetsService({
    db,
    sheetId: 7,
    spreadsheetId: 'spreadsheet',
    range: 'Orders!A:Y',
    serviceAccountEmail: 'service@example.test',
    privateKey: 'test',
  });
const metadata = () => ({
  data: {
    sheets: [
      {
        properties: {
          sheetId: 7,
          title: 'Orders',
          sheetType: 'GRID',
          gridProperties: { rowCount: 1000, columnCount: 25 },
        },
        protectedRanges: [{ range: { sheetId: 7 }, warningOnly: false }],
      },
    ],
  },
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'musicbox-bridges-'));
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
  await postgres.createDatabase('bridges');
  const url = `postgresql://musicbox:musicbox@127.0.0.1:${port}/bridges`;
  await promisify(execFile)(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { env: { ...process.env, DATABASE_URL: url }, timeout: 60000 },
  );
  db = createDatabase(url);
});
afterAll(async () => {
  if (db) await db.$disconnect();
  if (started) await postgres.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  rows.set("'Orders'!A1:Y1", [...SHEET_HEADERS]);
  api.metadata.mockImplementation(async () => metadata());
  api.batchUpdate.mockResolvedValue({ data: {} });
  api.get.mockImplementation(async ({ range }: { range: string }) => ({
    data: { values: rows.has(range) ? [rows.get(range)] : [] },
  }));
  api.update.mockImplementation(
    async ({
      range,
      requestBody,
    }: {
      range: string;
      requestBody: { values: (string | number)[][] };
    }) => {
      rows.set(range, [...requestBody.values[0]!]);
      return { data: { updatedRange: range } };
    },
  );
});
async function customer() {
  return db.customer.create({
    data: {
      whatsappId: `7707999${String(++phoneSequence).padStart(4, '0')}`,
      preferredLanguage: 'ru',
      conversationState: 'MAIN_MENU',
    },
  });
}
async function order(): Promise<SheetOrder> {
  const owner = await customer();
  return db.order.create({
    data: {
      customerId: owner.id,
      publicOrderId: `MB-${randomUUID()}`,
      productId: 'music-box-set',
      productName: 'Verified product',
      discTitle: 'Song',
      unitPrice: 20000,
      quantity: 1,
      totalAmount: 20000,
      subtotalAmount: 20000,
      paymentStatus: 'PAID',
      orderStatus: 'PAID',
      paidAt: new Date(),
      sheetSyncStatus: 'PENDING',
      version: 1,
    },
    include: { customer: true },
  });
}
function telegram(text: string | undefined, manager = 11, replyTo?: number) {
  return {
    update_id: ++updateSequence,
    message: {
      message_id: updateSequence + 1000,
      chat: { id: Number(chatId) },
      from: { id: manager, is_bot: false },
      ...(text === undefined ? {} : { text }),
      ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  };
}

describe('fixed-row Sheets with real PostgreSQL allocation', () => {
  it('concurrent paid orders reserve distinct persistent rows and only use RAW update', async () => {
    const first = await order();
    const second = await order();
    const references = await Promise.all([sheets().sync(first), sheets().sync(second)]);
    expect(new Set(references).size).toBe(2);
    const bindings = await db.sheetBinding.findMany({
      where: { orderId: { in: [first.id, second.id] } },
    });
    expect(new Set(bindings.map((binding) => binding.rowIndex)).size).toBe(2);
    expect(api.append).not.toHaveBeenCalled();
    for (const call of api.update.mock.calls) expect(call[0].valueInputOption).toBe('RAW');
  });
  it('reuses its allocated row when Google wrote successfully but acknowledgement was lost', async () => {
    const value = await order();
    api.update.mockImplementationOnce(async ({ range, requestBody }) => {
      rows.set(range, requestBody.values[0]);
      throw new Error('acknowledgement lost');
    });
    await expect(sheets().sync(value)).rejects.toThrow('acknowledgement lost');
    const binding = await db.sheetBinding.findUniqueOrThrow({ where: { orderId: value.id } });
    await sheets().sync(value);
    expect(await db.sheetBinding.count({ where: { orderId: value.id } })).toBe(1);
    expect(rows.get(`'Orders'!A${binding.rowIndex}:Y${binding.rowIndex}`)?.[0]).toBe(
      value.publicOrderId,
    );
    expect([...rows.values()].filter((row) => row[0] === value.publicOrderId)).toHaveLength(1);
  });
  it('never overwrites another order at a reserved row', async () => {
    const value = await order();
    await sheets().sync(value);
    const binding = await db.sheetBinding.findUniqueOrThrow({ where: { orderId: value.id } });
    rows.set(`'Orders'!A${binding.rowIndex}:Y${binding.rowIndex}`, ['MB-OTHER']);
    api.update.mockClear();
    await expect(sheets().sync(value)).rejects.toThrow('SHEET_STRUCTURE_CHANGED');
    expect(api.update).not.toHaveBeenCalled();
  });
  it('detects edits during sync and reads the newest snapshot on retry', async () => {
    const value = await order();
    api.update.mockImplementationOnce(async ({ range, requestBody }) => {
      rows.set(range, requestBody.values[0]);
      await db.order.update({
        where: { id: value.id },
        data: { version: { increment: 1 }, orderStatus: 'PROCESSING' },
      });
      return { data: { updatedRange: range } };
    });
    await sheets().sync(value);
    expect((await db.order.findUniqueOrThrow({ where: { id: value.id } })).sheetSyncStatus).toBe(
      'PENDING',
    );
    expect(await db.outboxJob.count({ where: { dedupeKey: `sheet:${value.id}:2` } })).toBe(1);
    await sheets().sync(value);
    const binding = await db.sheetBinding.findUniqueOrThrow({ where: { orderId: value.id } });
    expect(binding.syncedOrderVersion).toBe(2);
    expect(rows.get(`'Orders'!A${binding.rowIndex}:Y${binding.rowIndex}`)?.[18]).toBe('PROCESSING');
  });
  it('fences a stale worker after an HTTP result without losing the persistent binding', async () => {
    const value = await order();
    const job = await db.outboxJob.create({
      data: {
        kind: 'SHEETS',
        dedupeKey: randomUUID(),
        payload: {},
        orderId: value.id,
        status: 'PROCESSING',
        lockToken: 'current-token',
        lockedUntil: new Date(Date.now() + 30000),
      },
    });
    await expect(
      sheets().sync(value, { jobId: job.id, lockToken: 'expired-token' }),
    ).rejects.toThrow('SHEET_LEASE_LOST');
    expect(
      (await db.sheetBinding.findUniqueOrThrow({ where: { orderId: value.id } }))
        .syncedOrderVersion,
    ).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: value.id } })).sheetSyncStatus).toBe(
      'PENDING',
    );
  });
  it('extends grid capacity and refuses unprotected or changed sheet structures', async () => {
    const value = await order();
    api.metadata.mockResolvedValueOnce({
      data: {
        sheets: [
          {
            properties: {
              sheetId: 7,
              title: 'Orders',
              sheetType: 'GRID',
              gridProperties: { rowCount: 1, columnCount: 20 },
            },
            protectedRanges: [{ range: { sheetId: 7 }, warningOnly: false }],
          },
        ],
      },
    });
    await sheets().sync(value);
    expect(api.batchUpdate.mock.calls[0]?.[0].requestBody.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appendDimension: expect.objectContaining({ dimension: 'ROWS' }),
        }),
        expect.objectContaining({
          appendDimension: expect.objectContaining({ dimension: 'COLUMNS' }),
        }),
      ]),
    );
    api.metadata.mockResolvedValueOnce({
      data: {
        sheets: [
          { properties: { sheetId: 7, title: 'Orders', sheetType: 'GRID' }, protectedRanges: [] },
        ],
      },
    });
    await expect(sheets().sync(value)).rejects.toThrow('SHEET_NOT_PROTECTED');
    rows.set("'Orders'!A1:Y1", ['wrong header']);
    await expect(sheets().sync(value)).rejects.toThrow('SHEET_HEADER_MISMATCH');
  });
  it('periodic reconciliation repairs a delayed older snapshot in the same row', async () => {
    const value = await order();
    await sheets().sync(value);
    const binding = await db.sheetBinding.findUniqueOrThrow({ where: { orderId: value.id } });
    const range = `'Orders'!A${binding.rowIndex}:Y${binding.rowIndex}`;
    const old = [...rows.get(range)!];
    await db.order.update({
      where: { id: value.id },
      data: { version: 2, orderStatus: 'SHIPPED' },
    });
    await sheets().sync(value);
    rows.set(range, old); // older request finishes late remotely
    await sheets().sync(value);
    expect(rows.get(range)?.[18]).toBe('SHIPPED');
    expect(rows.get(range)?.[24]).toBe(2);
  });
});

describe('authorized Telegram handoff bridge', () => {
  it('creates one active ticket under concurrent requests and one atomic winner for claim', async () => {
    const owner = await customer();
    const bridge = handoff();
    const tickets = await Promise.all([
      db.$transaction((tx) =>
        bridge.open(tx, { customerId: owner.id, reason: 'UNKNOWN_INFORMATION' }),
      ),
      db.$transaction((tx) =>
        bridge.open(tx, { customerId: owner.id, reason: 'UNKNOWN_INFORMATION' }),
      ),
    ]);
    expect(tickets[0]!.id).toBe(tickets[1]!.id);
    const claims = await Promise.all([
      bridge.handleUpdate(telegram(`/claim ${tickets[0]!.id}`, 11), webhookSecret),
      bridge.handleUpdate(telegram(`/claim ${tickets[0]!.id}`, 22), webhookSecret),
    ]);
    expect(claims.filter((result) => result.action === 'CLAIMED')).toHaveLength(1);
  });
  it('routes two customers only through their bound tickets and assigned managers', async () => {
    const bridge = handoff();
    const owners = [await customer(), await customer()];
    const tickets = await Promise.all(
      owners.map((owner) =>
        db.$transaction((tx) =>
          bridge.open(tx, { customerId: owner.id, reason: 'MANAGER_REQUESTED' }),
        ),
      ),
    );
    for (let index = 0; index < tickets.length; index++) {
      const ticket = tickets[index]!;
      const manager = index ? 22 : 11;
      await bridge.bindTelegramMessage({
        ticketId: ticket.id,
        customerId: ticket.customerId,
        chatId,
        messageId: String(800 + index),
      });
      await bridge.handleUpdate(telegram(`/claim ${ticket.id}`, manager), webhookSecret);
      const update = telegram(`reply-${index}`, manager, 800 + index);
      expect((await bridge.handleUpdate(update, webhookSecret)).action).toBe('QUEUED');
      expect((await bridge.handleUpdate(update, webhookSecret)).duplicate).toBe(true);
      const outgoing = await db.outboxJob.findUniqueOrThrow({
        where: { dedupeKey: `telegram:${update.update_id}:operator` },
      });
      expect(outgoing.customerId).toBe(ticket.customerId);
      expect(await db.outboxJob.count({ where: { dedupeKey: outgoing.dedupeKey } })).toBe(1);
    }
    expect(
      (await bridge.handleUpdate(telegram('wrong manager', 22, 800), webhookSecret)).action,
    ).toBe('TICKET_NOT_ASSIGNED');
  });
  it('rejects forged secrets/users/chats before any action, and rejects unbound replies', async () => {
    const bridge = handoff();
    await expect(bridge.handleUpdate(telegram('bad', 33), webhookSecret)).rejects.toThrow(
      'rejected',
    );
    await expect(bridge.handleUpdate(telegram('bad'), 'wrong')).rejects.toThrow('rejected');
    const update = telegram('bad');
    update.message.chat.id = -999;
    await expect(bridge.handleUpdate(update, webhookSecret)).rejects.toThrow('rejected');
    expect((await bridge.handleUpdate(telegram('not a reply'), webhookSecret)).action).toBe(
      'REPLY_REQUIRED',
    );
    expect((await bridge.handleUpdate(telegram('unbound', 11, 999999), webhookSecret)).action).toBe(
      'BINDING_NOT_FOUND',
    );
  });
  it('closes tickets, cancels queued operator replies, restores current state and retains financial holds', async () => {
    const owner = await customer();
    const bridge = handoff();
    const ticket = await db.$transaction((tx) =>
      bridge.open(tx, { customerId: owner.id, reason: 'MANAGER_REQUESTED' }),
    );
    await bridge.bindTelegramMessage({
      ticketId: ticket.id,
      customerId: owner.id,
      chatId,
      messageId: '987',
    });
    await bridge.handleUpdate(telegram(`/claim ${ticket.id}`), webhookSecret);
    const reply = telegram('queued before closure', 11, 987);
    await bridge.handleUpdate(reply, webhookSecret);
    const paid = await db.order.create({
      data: {
        customerId: owner.id,
        publicOrderId: randomUUID(),
        productId: 'music-box-set',
        productName: 'Product',
        unitPrice: 20000,
        totalAmount: 20000,
        paymentStatus: 'PAID',
        fulfillmentHold: true,
        orderStatus: 'CANCELLED',
      },
    });
    await db.customer.update({ where: { id: owner.id }, data: { currentOrderId: paid.id } });
    await bridge.handleUpdate(telegram(`/close ${ticket.id}`), webhookSecret);
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: owner.id } })).conversationState,
    ).toBe('MAIN_MENU');
    expect((await db.order.findUniqueOrThrow({ where: { id: paid.id } })).fulfillmentHold).toBe(
      true,
    );
    expect(
      (
        await db.outboxJob.findUniqueOrThrow({
          where: { dedupeKey: `telegram:${reply.update_id}:operator` },
        })
      ).status,
    ).toBe('DONE');
    expect((await bridge.handleUpdate(telegram('late reply', 11, 987), webhookSecret)).action).toBe(
      'TICKET_NOT_ASSIGNED',
    );
  });
  it('forwards new client text and explicitly marks unsupported media', async () => {
    const owner = await customer();
    const bridge = handoff();
    const ticket = await db.$transaction((tx) =>
      bridge.open(tx, { customerId: owner.id, reason: 'UNKNOWN_INFORMATION' }),
    );
    await db.$transaction((tx) =>
      bridge.forward(tx, { customerId: owner.id, sourceMessageId: 'media-1', mediaType: 'audio' }),
    );
    const job = await db.outboxJob.findUniqueOrThrow({
      where: { dedupeKey: `handoff:${ticket.id}:incoming:media-1` },
    });
    expect(job.payload).toMatchObject({
      ticketId: ticket.id,
      text: expect.stringContaining('не поддерживается'),
    });
    expect((await bridge.handleUpdate(telegram(undefined), webhookSecret)).action).toBe(
      'UNSUPPORTED_MEDIA',
    );
  });
});

describe('legacy Sheets migration with real PostgreSQL', () => {
  beforeEach(async () => {
    // Each migration report considers all historical orders; isolate this test's legacy cohort.
    await db.order.updateMany({
      where: { sheetSyncStatus: 'LEGACY_RECONCILIATION_REQUIRED' },
      data: { sheetSyncStatus: 'NOT_REQUIRED' },
    });
  });
  const target = () => ({ spreadsheetId: `migration-${randomUUID()}`, sheetId: 7 });
  async function legacy() {
    const value = await order();
    await db.order.update({
      where: { id: value.id },
      data: { sheetSyncStatus: 'LEGACY_RECONCILIATION_REQUIRED' },
    });
    return value;
  }
  function legacyRow(value: SheetOrder, amount: string | number = value.totalAmount): unknown[] {
    const row: unknown[] = Array.from({ length: 20 }, () => '');
    row[0] = value.publicOrderId;
    row[13] = amount;
    row[14] = value.currency;
    return row;
  }
  it('imports once, preserves an advanced cursor, and schedules only an export refresh', async () => {
    const value = await legacy();
    const destination = target();
    const reserved = await order();
    await db.sheetBinding.create({ data: { ...destination, orderId: value.id, rowIndex: 2 } });
    await db.sheetBinding.create({ data: { ...destination, orderId: reserved.id, rowIndex: 99 } });
    await db.sheetCursor.create({ data: { ...destination, nextRowIndex: 150 } });
    const input = { db, target: destination, rows: [legacyRow(value, '20000.00')], apply: true };
    const first = await migrateLegacySheetRows(input);
    expect(first).toMatchObject({ applied: true, nextRowIndex: 150, conflicts: [] });
    expect(first.matches).toHaveLength(1);
    expect(first.matches[0]?.bindingAction).toBe('REUSE');
    expect((await db.order.findUniqueOrThrow({ where: { id: value.id } })).sheetSyncStatus).toBe(
      'PENDING',
    );
    expect(
      (await db.sheetBinding.findUniqueOrThrow({ where: { orderId: value.id } }))
        .syncedOrderVersion,
    ).toBe(0);
    const jobs = await db.outboxJob.findMany({ where: { orderId: value.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe('SHEETS');
    expect(jobs[0]?.dedupeKey).toBe(`sheet:${value.id}:v1:legacy`);
    const repeated = await migrateLegacySheetRows(input);
    expect(repeated).toMatchObject({
      applied: true,
      nextRowIndex: 150,
      matches: [],
      conflicts: [],
    });
    expect(await db.sheetBinding.count({ where: { orderId: value.id } })).toBe(1);
    expect(await db.outboxJob.count({ where: { orderId: value.id } })).toBe(1);
  });
  it('reports every mismatch and applies none of the otherwise valid matches', async () => {
    const valid = await legacy();
    const wrong = await legacy();
    const destination = target();
    const result = await migrateLegacySheetRows({
      db,
      target: destination,
      rows: [legacyRow(valid), legacyRow(wrong, 1)],
      apply: true,
    });
    expect(result.applied).toBe(false);
    expect(result.conflicts).toContainEqual({
      orderId: wrong.id,
      reason: 'AMOUNT_OR_CURRENCY_MISMATCH',
      rows: [3],
    });
    expect(await db.sheetBinding.count({ where: { orderId: { in: [valid.id, wrong.id] } } })).toBe(
      0,
    );
    expect(await db.outboxJob.count({ where: { orderId: valid.id } })).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: valid.id } })).sheetSyncStatus).toBe(
      'LEGACY_RECONCILIATION_REQUIRED',
    );
    expect(
      await db.sheetCursor.findUnique({ where: { spreadsheetId_sheetId: destination } }),
    ).toBeNull();
  });
  it('rejects a foreign binding without overwriting or partially importing it', async () => {
    const value = await legacy();
    const occupant = await order();
    const destination = target();
    await db.sheetBinding.create({ data: { ...destination, orderId: occupant.id, rowIndex: 2 } });
    const result = await migrateLegacySheetRows({
      db,
      target: destination,
      rows: [legacyRow(value)],
      apply: true,
    });
    expect(result.applied).toBe(false);
    expect(result.conflicts).toContainEqual({
      orderId: value.id,
      reason: 'ROW_ALREADY_BOUND',
      rows: [2],
    });
    expect(await db.sheetBinding.findUnique({ where: { orderId: value.id } })).toBeNull();
    expect(
      (await db.sheetBinding.findUniqueOrThrow({ where: { orderId: occupant.id } })).rowIndex,
    ).toBe(2);
  });
  it('uses one binding under concurrent repeat applications and reserves beyond existing rows', async () => {
    const value = await legacy();
    const destination = target();
    const reserved = await order();
    await db.sheetBinding.create({ data: { ...destination, orderId: reserved.id, rowIndex: 50 } });
    const input = { db, target: destination, rows: [legacyRow(value)], apply: true };
    const results = await Promise.all([
      migrateLegacySheetRows(input),
      migrateLegacySheetRows(input),
    ]);
    expect(results.every((result) => result.applied && !result.conflicts.length)).toBe(true);
    expect(results.map((result) => result.matches.length).sort()).toEqual([0, 1]);
    expect(
      (await db.sheetCursor.findUniqueOrThrow({ where: { spreadsheetId_sheetId: destination } }))
        .nextRowIndex,
    ).toBe(51);
    expect(await db.outboxJob.count({ where: { orderId: value.id } })).toBe(1);
  });
  it('keeps historical row evidence protected after an incident replaces the legacy marker', async () => {
    const value = await order();
    const destination = target();
    await db.order.update({
      where: { id: value.id },
      data: { sheetRowReference: 'Orders!A2:T2', sheetSyncStatus: 'PENDING' },
    });
    const service = new GoogleSheetsService({
      db,
      ...destination,
      range: 'Orders!A:Y',
      serviceAccountEmail: 'service@example.test',
      privateKey: 'test',
    });
    await expect(service.sync(value)).rejects.toThrow('LEGACY_SHEET_RECONCILIATION_REQUIRED');
    expect(api.metadata).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
    expect(await db.sheetBinding.findUnique({ where: { orderId: value.id } })).toBeNull();
    expect(
      await db.sheetCursor.findUnique({ where: { spreadsheetId_sheetId: destination } }),
    ).toBeNull();
    const missing = await migrateLegacySheetRows({
      db,
      target: destination,
      rows: [],
      apply: false,
    });
    expect(missing.conflicts).toContainEqual({
      orderId: value.id,
      reason: 'MISSING_ORDER_ID',
      rows: [],
    });
    const input = { db, target: destination, rows: [legacyRow(value)], apply: true };
    const imported = await migrateLegacySheetRows(input);
    expect(imported).toMatchObject({ applied: true, conflicts: [] });
    expect(imported.matches).toHaveLength(1);
    expect(
      (await db.sheetBinding.findUniqueOrThrow({ where: { orderId: value.id } })).rowIndex,
    ).toBe(2);
    const repeated = await migrateLegacySheetRows({ ...input, apply: false });
    expect(repeated).toMatchObject({ applied: false, matches: [], conflicts: [] });
    rows.set("'Orders'!A2:Y2", legacyRow(value) as (string | number)[]);
    await expect(service.sync(value)).resolves.toBe("'Orders'!A2:Y2");
    expect(await db.sheetBinding.count({ where: { orderId: value.id } })).toBe(1);
    expect(
      await db.outboxJob.count({ where: { orderId: value.id, kind: { not: 'SHEETS' } } }),
    ).toBe(0);
  });
  it('dry-run catches duplicate and unknown IDs and never writes bindings', async () => {
    const value = await legacy();
    const destination = target();
    const result = await migrateLegacySheetRows({
      db,
      target: destination,
      rows: [legacyRow(value), legacyRow(value), ['foreign-order']],
      apply: false,
    });
    expect(result.applied).toBe(false);
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        { orderId: value.id, reason: 'DUPLICATE_ORDER_ID', rows: [2, 3] },
        { orderId: 'foreign-order', reason: 'UNKNOWN_ORDER_ID', rows: [4] },
      ]),
    );
    expect(await db.sheetBinding.findUnique({ where: { orderId: value.id } })).toBeNull();
  });
});
