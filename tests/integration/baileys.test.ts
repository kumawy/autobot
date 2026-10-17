import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import type { PrismaClient } from '@prisma/client';
import type { WASocket, WAMessage, makeWASocket } from '@whiskeysockets/baileys';
import { normalizeMessageContent, type BinaryNode, type proto } from '@whiskeysockets/baileys';
import { buildApp } from '../../src/app.js';
import { readEnv, type Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/prisma.js';
import { enqueue } from '../../src/jobs/outbox.js';
import { BaileysAuthStore } from '../../src/modules/whatsapp/baileys-auth.js';
import { BaileysWhatsAppClient } from '../../src/modules/whatsapp/baileys.client.js';
import type { AiService } from '../../src/modules/ai/ai.service.js';
import { WhatsAppActions as A } from '../../src/modules/conversation/actions.js';
import { menuEntries } from '../../src/modules/whatsapp/baileys-codec.js';
import type { OutboundMessage } from '../../src/types/domain.js';

type Runtime = Awaited<ReturnType<typeof buildApp>>;
let runtime: Runtime;
let db: PrismaClient;
let pg: EmbeddedPostgres;
let directory: string;
let started = false;
let url: string;
let env: Env;
const account = '77005550000';
const recipient = '77005550001';
const sockets: {
  events: EventEmitter;
  socket: WASocket;
  config: Parameters<typeof makeWASocket>[0];
}[] = [];
const sent: { to: string; text?: string; id: string }[] = [];
const relayed: { content: proto.IMessage; id: string; nodes: BinaryNode[] }[] = [];
const admin = { authorization: `Bearer ${'a'.repeat(32)}` };
let sequence = 0;

function message(
  text: string,
  fromMe = false,
  id = `incoming-${++sequence}`,
  jid = `${recipient}@s.whatsapp.net`,
): WAMessage {
  return {
    key: { id, remoteJid: jid, fromMe },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}
const factory: typeof makeWASocket = (config) => {
  const events = new EventEmitter();
  const socket = {
    ev: events,
    user: { id: `${account}:2@s.whatsapp.net` },
    signalRepository: {
      lidMapping: { getPNForLID: vi.fn(async () => `${recipient}@s.whatsapp.net`) },
    },
    end: vi.fn(),
    relayMessage: vi.fn(
      async (
        to: string,
        content: proto.IMessage,
        options: { messageId: string; additionalNodes: BinaryNode[] },
      ) => {
        const text = normalizeMessageContent(content)?.interactiveMessage?.body?.text ?? undefined;
        sent.push({ to, text, id: options.messageId });
        relayed.push({ content, id: options.messageId, nodes: options.additionalNodes });
        const raw = { ...message('', true, options.messageId, to), message: content };
        events.emit('messages.upsert', { messages: [raw], type: 'append' });
        return options.messageId;
      },
    ),
    sendMessage: vi.fn(
      async (to: string, content: { text?: string }, options: { messageId: string }) => {
        sent.push({ to, text: content.text, id: options.messageId });
        // Simulate our own outgoing echo arriving BEFORE sendMessage's acknowledgement.
        const raw = message(content.text ?? 'image', true, options.messageId, to);
        events.emit('messages.upsert', { messages: [raw], type: 'append' });
        return raw;
      },
    ),
  } as unknown as WASocket;
  sockets.push({ events, socket, config });
  return socket;
};
function currentSocket() {
  return sockets.at(-1)!;
}
async function waitUntil(check: () => Promise<void> | void) {
  await vi.waitFor(check, { timeout: 5000, interval: 10 });
}
async function boot(ai?: AiService) {
  runtime = await buildApp({
    db,
    env,
    logger: false,
    startWorker: false,
    startWhatsApp: true,
    baileysSocketFactory: factory,
    ai,
  });
  await runtime.app.ready();
  currentSocket().events.emit('connection.update', { connection: 'open' });
  await waitUntil(() =>
    expect((runtime.whatsapp as BaileysWhatsAppClient).status().state).toBe('connected'),
  );
}
async function receive(raw: WAMessage) {
  currentSocket().events.emit('messages.upsert', { type: 'notify', messages: [raw] });
  if (raw.key.fromMe)
    await waitUntil(async () => {
      expect(await db.message.count({ where: { whatsappMessageId: raw.key.id! } })).toBe(1);
    });
  else
    await waitUntil(async () => {
      expect(await db.webhookEvent.count({ where: { externalEventId: raw.key.id! } })).toBe(1);
    });
}
async function text(value: string) {
  await receive(message(value));
  await runtime.worker.drain();
}
async function latestPrompt() {
  return db.message.findFirstOrThrow({
    where: {
      customer: { whatsappId: recipient },
      direction: 'outbound',
      deliveryStatus: { in: ['ACCEPTED', 'SENT', 'DELIVERED', 'READ'] },
    },
    orderBy: { createdAt: 'desc' },
  });
}
async function numberedAction(actionId: string) {
  const prompt = await latestPrompt();
  const entries = menuEntries(prompt.payload as unknown as OutboundMessage);
  const tokens = await db.actionToken.findMany({
    where: { token: { in: entries.map((entry) => entry.id) } },
  });
  const index = entries.findIndex(
    (entry) => tokens.find((token) => token.token === entry.id)?.actionId === actionId,
  );
  expect(index, `Action ${actionId} is absent from the latest prompt`).toBeGreaterThanOrEqual(0);
  await text(String(index + 1));
}
async function orderThroughCity() {
  await text('заказать');
  await numberedAction(`${A.DISC_PREFIX}${runtime.catalog.discs()[0]!.id}`);
  await numberedAction(A.DISC_DONE);
  await text('2');
  await text('Алматы');
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'musicbox-baileys-'));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  await pg.createDatabase('baileys_test');
  url = `postgresql://musicbox:musicbox@127.0.0.1:${port}/baileys_test`;
  await promisify(execFile)(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { env: { ...process.env, DIRECT_URL: '', DATABASE_URL: url }, timeout: 60000 },
  );
  db = createDatabase(url);
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "Customer", "WebhookEvent", "OutboxJob", "WhatsAppSession", "WhatsAppAuthRecord", "WorkerHeartbeat", "AuditLog" CASCADE',
  );
  sockets.length = 0;
  sent.length = 0;
  relayed.length = 0;
  env = readEnv({
    NODE_ENV: 'test',
    INTEGRATION_MODE: 'staging',
    WHATSAPP_TRANSPORT: 'baileys',
    WHATSAPP_AUTH_ENCRYPTION_KEY: 'ab'.repeat(32),
    WHATSAPP_EXPECTED_NUMBER: account,
    APP_BASE_URL: 'https://baileys.example.test',
    DATABASE_URL: url,
    ADMIN_TOKEN: 'a'.repeat(32),
    MOCK_PAYMENT_SECRET: 'm'.repeat(32),
    AI_PROVIDER: 'demo',
    LOG_LEVEL: 'silent',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected external request');
    }),
  );
  await boot();
});
afterEach(async () => {
  await runtime?.app.close();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await db?.$disconnect();
  if (started) await pg.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('Baileys gateway with PostgreSQL', () => {
  it.each([false, true])(
    'uses one numbered melody menu and keeps consent as the latest prompt (native buttons: %s)',
    async (nativeButtons) => {
      await runtime.app.close();
      env = { ...env, WHATSAPP_BAILEYS_BUTTONS: nativeButtons };
      await boot();
      await db.customer.create({
        data: { whatsappId: recipient, preferredLanguage: 'ru', conversationState: 'MAIN_MENU' },
      });
      await text('заказать');
      let prompt = await latestPrompt();
      expect(prompt.type).toBe('list');
      expect(menuEntries(prompt.payload as unknown as OutboundMessage).length).toBeLessThanOrEqual(
        10,
      );
      await numberedAction(`${A.DISC_PREFIX}${runtime.catalog.discs()[0]!.id}`);
      prompt = await latestPrompt();
      expect(prompt.type).toBe('list');
      expect(prompt.content).toContain('1/1');
      await numberedAction(`${A.DISC_REMOVE_PREFIX}0`);
      const customer = await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } });
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: customer.currentOrderId! } }))
          .selectedDiscIds,
      ).toEqual([]);
      await numberedAction(`${A.DISC_PREFIX}${runtime.catalog.discs()[0]!.id}`);
      await numberedAction(A.DISC_DONE);
      // A number absent from the current quantity shortcut must remain a quantity.
      await text('2');
      await text('Алматы');
      expect((await latestPrompt()).type).toBe('buttons');
      await numberedAction(A.NOTIFICATIONS_OPT_IN);
      expect(
        (await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } }))
          .notificationConsent,
      ).toBe(true);
      expect((await latestPrompt()).content).toContain('получателя');
      // The consent menu cannot capture numeric text after the name prompt.
      await text('1');
      expect(
        (await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } }))
          .conversationState,
      ).toBe('ORDER_NAME');
      await text('Арман');
      await text('+7 701 123 45 67');
      await text('Абая 10, квартира 12');
      const finished = await db.order.findUniqueOrThrow({
        where: { id: customer.currentOrderId! },
      });
      expect(finished).toMatchObject({ recipientName: 'Арман', quantity: 2, city: 'Алматы' });
      expect(
        (await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } }))
          .conversationState,
      ).toBe('ORDER_CONFIRMATION');
    },
  );

  it('lets the customer skip notifications without treating the choice as their name', async () => {
    await db.customer.create({
      data: { whatsappId: recipient, preferredLanguage: 'ru', conversationState: 'MAIN_MENU' },
    });
    await orderThroughCity();
    await numberedAction(A.NOTIFICATIONS_SKIP);
    const customer = await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } });
    expect(customer).toMatchObject({ notificationConsent: false, conversationState: 'ORDER_NAME' });
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: customer.currentOrderId! } })).recipientName,
    ).toBeNull();
  });

  it('keeps the first consultation question and excludes form values and prompts from AI history', async () => {
    await runtime.app.close();
    const answer = vi.fn<AiService['answer']>(async () => ({
      text: 'Механизм работает при вращении ручки.',
    }));
    await boot({ answer });
    await db.customer.create({
      data: { whatsappId: recipient, preferredLanguage: 'ru', conversationState: 'MAIN_MENU' },
    });
    const question = 'Как устроен механизм шкатулки?';
    await text(question);
    await text('А мелодию можно поменять?');
    expect(answer.mock.calls[1]![0].history).toEqual([
      { role: 'user', content: question },
      { role: 'assistant', content: 'Механизм работает при вращении ручки.' },
    ]);
    await orderThroughCity();
    await numberedAction(A.NOTIFICATIONS_SKIP);
    await text('Арман');
    await text('+7 701 123 45 67');
    await text('Абая 10, квартира 12');
    const customer = await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } });
    // Previously tagged rows are also filtered before building AI context.
    await db.message.createMany({
      data: ['Мой телефон +7 701 123 45 67', 'Мой адрес: улица Абая, квартира 12'].map(
        (content) => ({
          customerId: customer.id,
          direction: 'inbound',
          type: 'text',
          content,
          payload: { consultation: true },
        }),
      ),
    });
    await text('меню');
    await text('Какие цвета доступны?');
    const history = answer.mock.calls.at(-1)![0].history!;
    expect(history.some((entry) => entry.content === question)).toBe(true);
    expect(JSON.stringify(history)).not.toMatch(
      /Арман|701|Абая|получател|Проверьте заказ|Разрешить/iu,
    );
  });

  it('replays the original pre-language question in later consultation history, excluding the language choice', async () => {
    await runtime.app.close();
    const answer = vi.fn<AiService['answer']>(async () => ({
      text: 'Механизм работает при вращении ручки.',
    }));
    await boot({ answer });
    const question = 'Как устроен механизм шкатулки?';
    await text(question);
    await numberedAction(A.LANG_RU);
    await text('А мелодию можно поменять?');
    expect(answer.mock.calls.at(-1)![0].history).toEqual([
      { role: 'user', content: question },
      { role: 'assistant', content: 'Механизм работает при вращении ручки.' },
    ]);
  });

  it('maps a quoted numeric menu reply while leaving an unquoted reply to the latest plain prompt alone', async () => {
    const customer = await db.customer.create({
      data: { whatsappId: recipient, preferredLanguage: 'ru', conversationState: 'MAIN_MENU' },
    });
    await db.$transaction(async (tx) => {
      await enqueue(tx, {
        key: 'old-numbered-menu',
        kind: 'WHATSAPP',
        customerId: customer.id,
        payload: {
          type: 'buttons',
          text: 'Выберите',
          buttons: [{ id: A.MENU_PRODUCT, title: 'Товар' }],
        },
      });
    });
    await runtime.worker.drain();
    const menu = await latestPrompt();
    await db.$transaction(async (tx) => {
      await enqueue(tx, {
        key: 'current-plain-prompt',
        kind: 'WHATSAPP',
        customerId: customer.id,
        payload: { type: 'text', text: 'Напишите имя получателя.' },
      });
    });
    await runtime.worker.drain();
    const bare = message('1');
    await receive(bare);
    expect(
      (
        await db.webhookEvent.findUniqueOrThrow({
          where: {
            provider_externalEventId: { provider: 'whatsapp', externalEventId: bare.key.id! },
          },
        })
      ).payload,
    ).toMatchObject({ type: 'text', text: '1' });
    const quoted = {
      ...message('1'),
      message: {
        extendedTextMessage: { text: '1', contextInfo: { stanzaId: menu.whatsappMessageId! } },
      },
    };
    await receive(quoted);
    const entries = menuEntries(menu.payload as unknown as OutboundMessage);
    expect(
      (
        await db.webhookEvent.findUniqueOrThrow({
          where: {
            provider_externalEventId: { provider: 'whatsapp', externalEventId: quoted.key.id! },
          },
        })
      ).payload,
    ).toMatchObject({ type: 'interactive', actionId: entries[0]!.id });
  });

  it('returns a manager-interrupted draft to its consent step', async () => {
    await db.customer.create({
      data: { whatsappId: recipient, preferredLanguage: 'ru', conversationState: 'MAIN_MENU' },
    });
    await orderThroughCity();
    await text('менеджер');
    const customer = await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } });
    const result = await runtime.app.inject({
      method: 'POST',
      url: `/admin/customers/${customer.id}/release-handoff`,
      headers: admin,
    });
    expect(result.statusCode).toBe(200);
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).conversationState,
    ).toBe('ORDER_CONSENT');
  });

  it('keeps an unanswered quantity step across menu and manager detours', async () => {
    await db.customer.create({
      data: { whatsappId: recipient, preferredLanguage: 'ru', conversationState: 'MAIN_MENU' },
    });
    await text('заказать');
    await numberedAction(`${A.DISC_PREFIX}${runtime.catalog.discs()[0]!.id}`);
    await numberedAction(A.DISC_DONE);
    const customer = await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } });
    const before = await db.order.findUniqueOrThrow({ where: { id: customer.currentOrderId! } });
    expect(before).toMatchObject({ quantity: 1, quantityConfirmed: false });
    await text('меню');
    await text('менеджер');
    await text('вернуться к боту');
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).conversationState,
    ).toBe('ORDER_QUANTITY');
    expect((await db.order.findUniqueOrThrow({ where: { id: before.id } })).quantityConfirmed).toBe(
      false,
    );
    await text('2');
    expect(await db.order.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({
      quantity: 2,
      quantityConfirmed: true,
    });
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).conversationState,
    ).toBe('ORDER_CITY');
  });

  it('sends the manager safe consultation context and the selected order without form PII', async () => {
    await runtime.app.close();
    await boot({ answer: vi.fn(async () => ({ text: 'Мелодию можно выбрать из каталога.' })) });
    await db.customer.create({
      data: { whatsappId: recipient, preferredLanguage: 'ru', conversationState: 'MAIN_MENU' },
    });
    await text('Какие мелодии доступны?');
    await orderThroughCity();
    await numberedAction(A.NOTIFICATIONS_SKIP);
    await text('Арман');
    await text('+7 701 123 45 67');
    await text('Абая 10, квартира 12');
    await text('менеджер');
    const job = await db.outboxJob.findFirstOrThrow({
      where: {
        kind: 'TELEGRAM',
        payload: { path: ['sourceMessageId'], string_starts_with: 'ticket:' },
      },
    });
    const body = (job.payload as { text: string }).text;
    expect(body).toContain('Клиент: Какие мелодии доступны?');
    expect(body).toContain('Бот: Мелодию можно выбрать из каталога.');
    expect(body).toContain('Заказ:');
    expect(body).toContain('Количество комплектов: 2');
    expect(body).toContain('Interstellar');
    expect(body).not.toMatch(/Арман|701|Абая|Проверьте заказ/iu);
  });

  it.each(['ru', 'kk'])(
    'sends native language buttons and processes %s clicks through one-use tokens',
    async (language) => {
      await runtime.app.close();
      env = { ...env, WHATSAPP_BAILEYS_BUTTONS: true };
      await boot();
      await receive(message('Здравствуйте'));
      await runtime.worker.drain();
      const menu = relayed[0]!;
      const interactive = normalizeMessageContent(menu.content)!.interactiveMessage!;
      expect(interactive.body?.text).toContain('1.');
      expect(menu.nodes.map((node) => node.tag)).toEqual(['biz', 'bot']);
      const choices = interactive.nativeFlowMessage!.buttons!.map((button) =>
        JSON.parse(button.buttonParamsJson!),
      );
      const selected = choices.find((choice) =>
        choice.display_text.includes(language === 'ru' ? 'Русский' : 'Қазақша'),
      );
      expect(selected.id).toBeTruthy();
      expect(interactive.body?.text).not.toContain(selected.id);
      expect(await db.handoff.count()).toBe(0); // Relay echo is a bot send, not a manual reply.
      expect(
        normalizeMessageContent(await currentSocket().config.getMessage!({ id: menu.id }))
          ?.interactiveMessage,
      ).toBeTruthy();
      const otherClick = {
        ...message('', false, undefined, '77005550002@s.whatsapp.net'),
        message: {
          interactiveResponseMessage: {
            nativeFlowResponseMessage: {
              name: 'quick_reply',
              paramsJson: JSON.stringify({ id: selected.id }),
            },
            contextInfo: { stanzaId: menu.id },
          },
        },
      };
      await receive(otherClick);
      await runtime.worker.drain();
      expect(
        (await db.customer.findUniqueOrThrow({ where: { whatsappId: '77005550002' } }))
          .preferredLanguage,
      ).toBeNull();
      expect(
        (await db.actionToken.findUniqueOrThrow({ where: { token: selected.id } })).consumedAt,
      ).toBeNull();
      const click = { ...message(''), message: otherClick.message };
      await receive(click);
      await runtime.worker.drain();
      expect(
        (await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } }))
          .preferredLanguage,
      ).toBe(language);
      expect(
        (await db.actionToken.findUniqueOrThrow({ where: { token: selected.id } })).consumedAt,
      ).not.toBeNull();
      await receive(click);
      await runtime.worker.drain();
      expect(await db.webhookEvent.count({ where: { externalEventId: click.key.id! } })).toBe(1);
      await receive({ ...click, key: { ...click.key, id: `replayed-${language}` } });
      await runtime.worker.drain();
      expect(
        (await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } }))
          .preferredLanguage,
      ).toBe(language);
      expect(await db.handoff.count()).toBe(0);
    },
  );
  it('keeps numeric choices usable with native buttons and never repeats a relay with an unknown result', async () => {
    await runtime.app.close();
    env = { ...env, WHATSAPP_BAILEYS_BUTTONS: true };
    await boot();
    await receive(message('Здравствуйте'));
    await runtime.worker.drain();
    await receive(message('1'));
    await runtime.worker.drain();
    const customer = await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } });
    expect(customer.preferredLanguage).toBeTruthy();
    const relay = vi.mocked(currentSocket().socket.relayMessage);
    relay.mockRejectedValueOnce(new Error('Connection lost after write'));
    await db.$transaction((tx) =>
      enqueue(tx, {
        key: 'native-unknown',
        kind: 'WHATSAPP',
        customerId: customer.id,
        payload: {
          type: 'buttons',
          text: 'Выберите',
          buttons: [{ id: 'test', title: 'Русский' }],
          origin: 'bot',
        },
      }),
    );
    const previousCalls = relay.mock.calls.length;
    await runtime.worker.drain();
    expect(
      (await db.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'native-unknown' } })).status,
    ).toBe('UNKNOWN');
    await runtime.worker.drain();
    expect(relay.mock.calls.length).toBe(previousCalls + 1);
  });
  it('persists batches of Signal keys, updates/deletes them and fences a former owner', async () => {
    const store = new BaileysAuthStore(
      db,
      'auth-only',
      'owner-one',
      env.WHATSAPP_AUTH_ENCRYPTION_KEY,
    );
    expect(await store.acquire()).toBe(true);
    const { state } = await store.load();
    const keys = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [
        String(i),
        {
          private: Buffer.from([1, 3, i % 256]),
          public: Buffer.from([2, 4, i % 256]),
        },
      ]),
    );
    await state.keys.set({ 'pre-key': keys });
    expect((await state.keys.get('pre-key', ['1', '599']))['599']).toEqual(keys['599']);
    await state.keys.set({
      'pre-key': { '1': null, '599': { private: Buffer.from([9]), public: Buffer.from([8]) } },
    });
    expect(await state.keys.get('pre-key', ['1', '599'])).toEqual({
      '599': { private: Buffer.from([9]), public: Buffer.from([8]) },
    });
    await db.whatsAppSession.update({
      where: { id: 'auth-only' },
      data: { ownerToken: 'owner-two' },
    });
    await expect(state.keys.set({ 'pre-key': { '599': null } })).rejects.toThrow('OWNERSHIP_LOST');
    expect((await state.keys.get('pre-key', ['599']))['599']).toBeDefined();
  });

  it('does not automatically repeat a send whose acknowledgement is lost', async () => {
    const customer = await db.customer.create({
      data: { whatsappId: recipient, preferredLanguage: 'ru' },
    });
    await db.$transaction((tx) =>
      enqueue(tx, {
        key: 'uncertain-send',
        kind: 'WHATSAPP',
        customerId: customer.id,
        payload: { type: 'text', text: 'Возможно отправлено', origin: 'bot' },
      }),
    );
    vi.mocked(currentSocket().socket.sendMessage).mockRejectedValueOnce(new Error('Lost ACK'));
    await runtime.worker.drain();
    const job = await db.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'uncertain-send' } });
    expect(job.status).toBe('UNKNOWN');
    const record = await db.message.findUniqueOrThrow({ where: { outboxJobId: job.id } });
    expect(record.whatsappMessageId).toBeTruthy();
    await receive(message('Возможно отправлено', true, record.whatsappMessageId!));
    expect(await db.handoff.count()).toBe(0);
    await runtime.worker.drain();
    expect(currentSocket().socket.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('serves protected QR, blocks Meta injection and retains numbered language choices', async () => {
    currentSocket().events.emit('connection.update', { qr: 'test-private-pairing-code' });
    await waitUntil(() =>
      expect((runtime.whatsapp as BaileysWhatsAppClient).pairingQr()).toBe(
        'test-private-pairing-code',
      ),
    );
    expect((await runtime.app.inject({ url: '/admin/whatsapp/qr' })).statusCode).toBe(401);
    const qr = await runtime.app.inject({ url: '/admin/whatsapp/qr', headers: admin });
    expect(qr.json().dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(qr.headers['cache-control']).toBe('no-store');
    const page = await runtime.app.inject({ url: '/whatsapp/connect' });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('test-private-pairing-code');
    expect(
      (await runtime.app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: {} }))
        .statusCode,
    ).toBe(404);
    expect((await runtime.app.inject({ url: '/dev/state' })).statusCode).toBe(404);
    currentSocket().events.emit('connection.update', { connection: 'open' });
    await waitUntil(() => expect(runtime.whatsapp.isReady?.()).toBe(true));
    const first = message('Здравствуйте');
    await receive(first);
    await runtime.worker.drain();
    expect(sent[0]?.text).toContain('1.');
    expect(sent[0]?.text).toContain('Русский');
    expect(await db.handoff.count()).toBe(0); // Early echoes are recognized as bot sends.
    await receive(first);
    await runtime.worker.drain();
    expect(await db.webhookEvent.count({ where: { externalEventId: first.key.id! } })).toBe(1);
    const languageMenu = await db.message.findFirstOrThrow({
      where: { direction: 'outbound', type: 'buttons' },
    });
    const rows = (languageMenu.payload as { buttons: { title: string }[] }).buttons;
    const choice = rows.findIndex((row) => row.title.includes('Русский')) + 1;
    await receive(message(String(choice)));
    await runtime.worker.drain();
    expect(
      (await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } })).preferredLanguage,
    ).toBe('ru');
    expect(await db.handoff.count()).toBe(0);
    expect(
      await db.message.count({
        where: { direction: 'outbound', whatsappMessageId: { not: null } },
      }),
    ).toBe(sent.length);
  });

  it('pauses only the intended conversation, cancels pending bot answers and explicitly resumes', async () => {
    const customer = await db.customer.create({
      data: { whatsappId: recipient, preferredLanguage: 'ru', conversationState: 'AI_QA' },
    });
    const other = await db.customer.create({
      data: { whatsappId: '77005550002', preferredLanguage: 'ru', conversationState: 'AI_QA' },
    });
    await db.$transaction((tx) =>
      enqueue(tx, {
        key: 'pending-ai',
        kind: 'WHATSAPP',
        customerId: customer.id,
        payload: { type: 'text', text: 'Поздний ответ бота', origin: 'bot' },
      }),
    );
    const manual = message('Я менеджер, помогу вам.', true);
    await receive(manual);
    await waitUntil(async () =>
      expect(
        (await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).conversationState,
      ).toBe('HUMAN_HANDOFF'),
    );
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: other.id } })).conversationState,
    ).toBe('AI_QA');
    await receive(manual);
    expect(await db.handoff.count({ where: { customerId: customer.id } })).toBe(1);
    expect(
      (await db.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'pending-ai' } })).lastError,
    ).toBe('HUMAN_HANDOFF');
    await receive(message('Сколько стоит?'));
    await runtime.worker.drain();
    expect(sent).toHaveLength(0);
    const resume = await runtime.app.inject({
      method: 'POST',
      url: `/admin/customers/${customer.id}/release-handoff`,
      headers: admin,
    });
    expect(resume.statusCode).toBe(200);
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).conversationState,
    ).not.toBe('HUMAN_HANDOFF');
    await runtime.worker.drain();
    expect(sent.some((row) => row.text?.includes('снова доступен'))).toBe(true);
    expect(await db.handoff.count({ where: { customerId: customer.id, status: 'CLOSED' } })).toBe(
      1,
    );
  });

  it('invalidates an AI answer being prepared when the manager replies from the phone', async () => {
    await runtime.app.close();
    let startedAnswer!: () => void;
    const answering = new Promise<void>((resolve) => {
      startedAnswer = resolve;
    });
    let finishAnswer!: () => void;
    const pendingAnswer = new Promise<void>((resolve) => {
      finishAnswer = resolve;
    });
    await boot({
      answer: vi.fn(async () => {
        startedAnswer();
        await pendingAnswer;
        return { text: 'STALE_AI_ANSWER' };
      }),
    });
    await db.customer.create({
      data: { whatsappId: recipient, preferredLanguage: 'ru', conversationState: 'AI_QA' },
    });
    await receive(message('Какие мелодии есть?'));
    const processing = runtime.worker.drain();
    await answering;
    await receive(message('Уже отвечаю лично.', true));
    await waitUntil(async () =>
      expect(
        (await db.customer.findUniqueOrThrow({ where: { whatsappId: recipient } }))
          .conversationState,
      ).toBe('HUMAN_HANDOFF'),
    );
    finishAnswer();
    await processing;
    expect(sent.some((row) => row.text?.includes('STALE_AI_ANSWER'))).toBe(false);
    expect(await db.webhookEvent.count({ where: { status: 'PROCESSING' } })).toBe(0);
  });

  it('restores encrypted authentication after a restart and excludes a second owner', async () => {
    const credentials = currentSocket().config.auth!.creds;
    credentials.registered = true;
    currentSocket().events.emit('creds.update', {});
    await waitUntil(async () => {
      const record = await db.whatsAppAuthRecord.findUniqueOrThrow({
        where: { sessionId_key: { sessionId: 'primary', key: 'creds' } },
      });
      expect(record.value).not.toContain('registered');
      const copy = new BaileysAuthStore(
        db,
        'primary',
        randomUUID(),
        env.WHATSAPP_AUTH_ENCRYPTION_KEY,
      );
      expect(await copy.acquire()).toBe(false);
    });
    await runtime.app.close();
    await boot();
    expect(currentSocket().config.auth!.creds.registered).toBe(true);
    const contender = await buildApp({
      db,
      env,
      logger: false,
      startWhatsApp: true,
      baileysSocketFactory: factory,
    });
    try {
      await contender.app.ready();
      expect((contender.whatsapp as BaileysWhatsAppClient).status().state).toBe('session_busy');
    } finally {
      await contender.app.close();
    }
  });

  it('keeps queued messages without exhausting attempts while disconnected', async () => {
    const customer = await db.customer.create({
      data: { whatsappId: recipient, preferredLanguage: 'ru' },
    });
    await db.$transaction((tx) =>
      enqueue(tx, {
        key: 'offline-send',
        kind: 'WHATSAPP',
        customerId: customer.id,
        payload: { type: 'text', text: 'После восстановления' },
      }),
    );
    currentSocket().events.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await waitUntil(() =>
      expect((runtime.whatsapp as BaileysWhatsAppClient).status().state).toBe('logged_out'),
    );
    for (let i = 0; i < 10; i++) {
      await db.outboxJob.update({
        where: { dedupeKey: 'offline-send' },
        data: { nextAttemptAt: new Date() },
      });
      await runtime.worker.processJob();
    }
    const job = await db.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'offline-send' } });
    expect(job.status).toBe('RETRY');
    expect(job.attempts).toBe(0);
    expect(job.dispatchStartedAt).toBeNull();
    expect(sent).toHaveLength(0);
    await runtime.app.inject({ method: 'POST', url: '/admin/whatsapp/reconnect', headers: admin });
    expect(currentSocket().config.auth!.creds.registered).toBe(false);
    currentSocket().events.emit('connection.update', { connection: 'open' });
    await waitUntil(() => expect(runtime.whatsapp.isReady?.()).toBe(true));
    await db.outboxJob.update({ where: { id: job.id }, data: { nextAttemptAt: new Date() } });
    await runtime.worker.drain();
    expect(sent[0]?.text).toBe('После восстановления');
  });

  it('ignores old history and groups, resolves LIDs and maps delivery receipts', async () => {
    const old = message('Old history', false, 'old');
    old.messageTimestamp = 1000;
    currentSocket().events.emit('messages.upsert', {
      messages: [old, message('group', false, 'group', '123456789@g.us')],
      type: 'append',
    });
    await receive(message('Здравствуйте', false, 'lid-message', '123456789012345@lid'));
    await runtime.worker.drain();
    expect(
      await db.webhookEvent.count({ where: { externalEventId: { in: ['old', 'group'] } } }),
    ).toBe(0);
    expect(await db.customer.count({ where: { whatsappId: recipient } })).toBe(1);
    const id = sent[0]!.id;
    currentSocket().events.emit('message-receipt.update', [
      {
        key: { id, fromMe: true },
        receipt: {
          userJid: `${recipient}@s.whatsapp.net`,
          readTimestamp: Math.floor(Date.now() / 1000),
        },
      },
    ]);
    await waitUntil(async () =>
      expect(
        await db.webhookEvent.count({ where: { externalEventId: `baileys:${id}:read` } }),
      ).toBe(1),
    );
    await runtime.worker.drain();
    expect(
      (await db.message.findUniqueOrThrow({ where: { whatsappMessageId: id } })).deliveryStatus,
    ).toBe('READ');
  });
});
