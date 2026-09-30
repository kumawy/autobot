import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWebhook } from '../../src/modules/whatsapp/whatsapp.parser.js';
import { WhatsAppClient } from '../../src/modules/whatsapp/whatsapp.client.js';
import {
  TelegramService,
  DemoNotificationService,
} from '../../src/modules/notifications/telegram.service.js';
import { decideWhatsAppSend, parseTemplateRegistry } from '../../src/modules/whatsapp/policy.js';

const envelope = (messages: unknown[] = [], statuses: unknown[] = [], phoneId = 'phone-id') => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneId }, messages, statuses } }] }],
});
const baseMessage = { id: 'wamid.test', from: '77001234567', timestamp: '1750000000' };

describe('WhatsApp webhook parser', () => {
  it('parses text without retaining the raw webhook payload', () => {
    const result = parseWebhook(
      envelope([{ ...baseMessage, type: 'text', text: { body: 'Сколько стоит?' } }]),
      'phone-id',
    );
    expect(result.messages).toEqual([
      { ...baseMessage, timestamp: 1750000000, type: 'text', text: 'Сколько стоит?' },
    ]);
    expect(result.statuses).toEqual([]);
  });
  it('routes reply buttons, lists, and legacy buttons by stable machine IDs', () => {
    const result = parseWebhook(
      envelope([
        {
          ...baseMessage,
          id: '1',
          type: 'interactive',
          interactive: { button_reply: { id: 'LANG_RU', title: 'anything' } },
        },
        {
          ...baseMessage,
          id: '2',
          type: 'interactive',
          interactive: { list_reply: { id: 'DISC_disc_001', title: 'anything' } },
        },
        {
          ...baseMessage,
          id: '3',
          type: 'button',
          button: { payload: 'MENU_ORDER', text: 'anything' },
        },
      ]),
    );
    expect(result.messages.map((message) => message.actionId)).toEqual([
      'LANG_RU',
      'DISC_disc_001',
      'MENU_ORDER',
    ]);
    expect(result.messages.map((message) => message.type)).toEqual([
      'interactive',
      'interactive',
      'button',
    ]);
  });
  it('accepts unsupported media safely and handles delivery-status-only webhooks', () => {
    const media = parseWebhook(
      envelope([{ ...baseMessage, type: 'audio', audio: { id: 'media-id' } }]),
    );
    expect(media.messages[0]).toMatchObject({ type: 'unsupported' });
    expect(media.messages[0]).not.toHaveProperty('audio');
    const status = parseWebhook(envelope([], [{ id: 'wamid.sent', status: 'delivered' }]));
    expect(status.messages).toEqual([]);
    expect(status.statuses).toEqual([
      {
        id: 'wamid.sent',
        status: 'delivered',
        externalEventKey: 'status:wamid.sent:delivered:unknown:',
      },
    ]);
  });
  it('ignores events for a different configured phone and rejects malformed senders', () => {
    expect(
      parseWebhook(
        envelope([{ ...baseMessage, type: 'text', text: { body: 'Hello' } }]),
        'different',
      ).messages,
    ).toEqual([]);
    expect(() =>
      parseWebhook(
        envelope([{ ...baseMessage, from: 'not-a-phone', type: 'text', text: { body: 'x' } }]),
      ),
    ).toThrow();
  });
  it('redacts credentials before they enter inbox persistence', () => {
    const result = parseWebhook(
      envelope([{ ...baseMessage, type: 'text', text: { body: '4242 4242 4242 4242' } }]),
    );
    expect(result.messages[0]?.text).toBe('[PAYMENT_CREDENTIALS_REDACTED]');
  });
  it('preserves distinct durable status keys, opaque correlation and reply context', () => {
    const parsed = parseWebhook(
      envelope(
        [
          {
            ...baseMessage,
            type: 'interactive',
            context: { id: 'outgoing-1' },
            interactive: { button_reply: { id: 'token-123' } },
          },
        ],
        [
          {
            id: 'sent-1',
            status: 'sent',
            timestamp: '1750000000',
            biz_opaque_callback_data: 'job-1',
          },
          {
            id: 'sent-1',
            status: 'delivered',
            timestamp: '1750000001',
            biz_opaque_callback_data: 'job-1',
          },
        ],
      ),
    );
    expect(parsed.statuses[0]?.externalEventKey).not.toBe(parsed.statuses[1]?.externalEventKey);
    expect(parsed.statuses[1]).toMatchObject({ correlationId: 'job-1', timestamp: 1750000001 });
    expect(parsed.messages[0]).toMatchObject({ replyToMessageId: 'outgoing-1' });
  });
  it('never truncates action IDs or consumes text/action payloads from another message type', () => {
    expect(() =>
      parseWebhook(
        envelope([
          {
            ...baseMessage,
            type: 'interactive',
            interactive: { button_reply: { id: 'a'.repeat(257) } },
          },
        ]),
      ),
    ).toThrow();
    const result = parseWebhook(
      envelope([
        {
          ...baseMessage,
          type: 'text',
          text: { body: 'Hello' },
          interactive: { button_reply: { id: 'forged' } },
        },
        {
          ...baseMessage,
          id: '2',
          type: 'image',
          text: { body: 'Must not become an address' },
          context: { id: 'wamid.origin' },
        },
        { ...baseMessage, id: '3', type: 'interactive', interactive: { type: 'nfm_reply' } },
      ]),
    );
    expect(result.messages[0]).not.toHaveProperty('actionId');
    expect(result.messages[1]).toMatchObject({
      type: 'unsupported',
      mediaType: 'image',
      replyToMessageId: 'wamid.origin',
    });
    expect(result.messages[1]).not.toHaveProperty('text');
    expect(result.messages[2]).toMatchObject({ type: 'unsupported', mediaType: 'interactive' });
  });
  it('rejects ambiguous interactive replies rather than selecting a different action', () => {
    expect(() =>
      parseWebhook(
        envelope([
          {
            ...baseMessage,
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: 'a' },
              list_reply: { id: 'b' },
            },
          },
        ]),
      ),
    ).toThrow('AMBIGUOUS_INTERACTIVE_REPLY');
  });
});

describe('WhatsApp Cloud API client payloads', () => {
  const http = vi.fn();
  const client = new WhatsAppClient({
    accessToken: 'test-token',
    phoneNumberId: 'phone-id',
    graphApiVersion: 'v-test',
  });
  beforeEach(() => {
    http.mockReset();
    http.mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.sent' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', http);
  });
  afterEach(() => vi.unstubAllGlobals());
  const sent = () => JSON.parse(String(http.mock.calls[0]?.[1]?.body));

  it('uses the configured Graph API version and bounds text', async () => {
    await expect(client.sendText('77001234567', 'a'.repeat(4500))).resolves.toBe('wamid.sent');
    expect(http.mock.calls[0]?.[0]).toBe('https://graph.facebook.com/v-test/phone-id/messages');
    expect(sent()).toMatchObject({
      messaging_product: 'whatsapp',
      type: 'text',
      to: '77001234567',
      text: { preview_url: false },
    });
    expect(sent().text.body).toHaveLength(4096);
  });
  it('preserves stable button IDs and applies Meta title/body limits', async () => {
    await client.sendButtons('77001234567', 'b'.repeat(2000), [
      { id: 'MENU_ORDER', title: 't'.repeat(30) },
    ]);
    expect(sent().interactive.body.text).toHaveLength(1024);
    expect(sent().interactive.action.buttons[0].reply).toEqual({
      id: 'MENU_ORDER',
      title: 't'.repeat(20),
    });
    expect(() => client.sendButtons('x', 'text', [])).toThrow('1–3');
    expect(() =>
      client.sendButtons(
        'x',
        'text',
        Array.from({ length: 4 }, () => ({ id: 'id', title: 'title' })),
      ),
    ).toThrow('1–3');
  });
  it('bounds list rows, titles, descriptions, and call-to-action labels', async () => {
    await client.sendList('77001234567', 'l'.repeat(2000), 'b'.repeat(25), [
      { id: 'DISC_disc_001', title: 't'.repeat(35), description: 'd'.repeat(90) },
    ]);
    const interactive = sent().interactive;
    expect(interactive.body.text).toHaveLength(1024);
    expect(interactive.action.button).toHaveLength(20);
    expect(interactive.action.sections[0].rows[0]).toEqual({
      id: 'DISC_disc_001',
      title: 't'.repeat(24),
      description: 'd'.repeat(72),
    });
    expect(() => client.sendList('x', 'text', 'list', [])).toThrow('1–10');
    expect(() =>
      client.sendList(
        'x',
        'text',
        'list',
        Array.from({ length: 11 }, () => ({ id: 'id', title: 'title' })),
      ),
    ).toThrow('1–10');
  });
  it('encodes approved templates with selected language and text parameters', async () => {
    await client.sendTemplate('77001234567', 'payment_received', 'kk', ['MB-TEST']);
    expect(sent().template).toEqual({
      name: 'payment_received',
      language: { code: 'kk' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'MB-TEST' }] }],
    });
  });
  it('does not expose API response bodies or credentials in transport errors', async () => {
    http.mockResolvedValueOnce(new Response('sensitive response body', { status: 429 }));
    await expect(client.sendText('77001234567', 'text')).rejects.toThrow('WhatsApp HTTP 429');
    http.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 'sensitive-token', message: 'private provider detail' } }),
        { status: 400 },
      ),
    );
    await expect(client.sendText('77001234567', 'text')).rejects.toMatchObject({
      code: 'WhatsApp HTTP 400',
      outcome: 'REJECTED',
      retryable: false,
    });
  });
  it('requires a send acknowledgement while allowing read receipt acknowledgements', async () => {
    http.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await expect(client.sendText('77001234567', 'text')).rejects.toThrow();
    http.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await expect(client.markAsRead('wamid.inbound')).resolves.toBeUndefined();
  });
  it('distinguishes an ambiguous send from a rate-limit rejection and preserves correlation', async () => {
    http.mockRejectedValueOnce(new Error('socket closed after write'));
    await expect(client.sendText('77001234567', 'text')).rejects.toMatchObject({
      outcome: 'UNKNOWN',
      retryable: false,
    });
    http.mockResolvedValueOnce(
      new Response('{}', { status: 429, headers: { 'Retry-After': '90' } }),
    );
    await expect(client.sendText('77001234567', 'text')).rejects.toMatchObject({
      outcome: 'REJECTED',
      retryable: true,
      retryAfterMs: 90000,
    });
    await client.send('77001234567', { type: 'text', text: 'text' }, { correlationId: 'job-123' });
    expect(JSON.parse(String(http.mock.calls[2]?.[1]?.body)).biz_opaque_callback_data).toBe(
      'job-123',
    );
  });
  it.each([
    null,
    [],
    { messages: [null] },
    { messages: [{ id: 42 }] },
    { messages: [{ id: '   ' }] },
  ])('normalizes malformed successful acknowledgements to UNKNOWN: %j', async (body) => {
    http.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    await expect(client.sendText('77001234567', 'text')).rejects.toMatchObject({
      code: 'WHATSAPP_ACK_UNKNOWN',
      outcome: 'UNKNOWN',
      retryable: false,
    });
  });
  it('aborts an unanswered send at the configured deadline and leaves the outcome unknown', async () => {
    const timeoutClient = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: 'phone-id',
      graphApiVersion: 'v-test',
      timeoutMs: 10,
    });
    http.mockImplementationOnce(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal!;
          signal.addEventListener('abort', () => reject(new Error('private timeout details')), {
            once: true,
          });
        }),
    );
    await expect(timeoutClient.sendText('77001234567', 'text')).rejects.toMatchObject({
      code: 'WHATSAPP_SEND_UNKNOWN',
      outcome: 'UNKNOWN',
      retryable: false,
    });
    expect((http.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });
  it('rejects unsafe correlation before sending and keeps a 5xx result ambiguous', async () => {
    await expect(
      client.sendText('77001234567', 'text', { correlationId: 'secret with whitespace' }),
    ).rejects.toMatchObject({ code: 'INVALID_CORRELATION', outcome: 'REJECTED' });
    expect(http).not.toHaveBeenCalled();
    http.mockResolvedValueOnce(new Response('provider-private-body', { status: 503 }));
    await expect(client.sendText('77001234567', 'text')).rejects.toMatchObject({
      code: 'WHATSAPP_HTTP_503',
      outcome: 'UNKNOWN',
      retryable: false,
    });
  });
});

describe('WhatsApp policy at actual dispatch time', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const customer = {
    lastInboundAt: new Date('2026-09-29T12:00:00Z'),
    preferredLanguage: 'kk' as const,
    conversationState: 'MAIN_MENU',
    notificationConsent: true,
    optedOutAt: null,
  };
  const registry = parseTemplateRegistry(
    JSON.stringify({
      order_paid: {
        ru: { name: 'paid_ru', locale: 'ru', available: true },
        kk: { name: 'paid_actual', locale: 'approved_locale', available: true },
      },
      support_reopen: {
        kk: { name: 'support_actual', locale: 'approved_locale', available: true },
      },
    }),
  );
  const message = { type: 'text' as const, text: 'Оплата получена' };
  it('uses an approved mapped locale outside the window without assuming kk support', () => {
    expect(
      decideWhatsAppSend({
        customer,
        message,
        purpose: 'order_paid',
        templateParameters: ['MB-1'],
        registry,
        now,
      }),
    ).toEqual({
      allowed: true,
      message: {
        type: 'template',
        name: 'paid_actual',
        language: 'approved_locale',
        parameters: ['MB-1'],
      },
    });
    expect(
      decideWhatsAppSend({ customer, message, purpose: 'order_paid', registry: {}, now }),
    ).toEqual({ allowed: false, code: 'BLOCKED_TEMPLATE' });
  });
  it('blocks proactive messages without consent but permits current transactional responses', () => {
    expect(
      decideWhatsAppSend({
        customer: { ...customer, notificationConsent: false },
        message,
        purpose: 'order_paid',
        registry,
        now,
      }),
    ).toMatchObject({ allowed: false, code: 'BLOCKED_CONSENT' });
    expect(
      decideWhatsAppSend({
        customer: { ...customer, notificationConsent: false, lastInboundAt: now },
        message,
        purpose: 'order_paid',
        registry,
        now,
      }),
    ).toEqual({ allowed: true, message });
  });
  it('keeps operator text blocked while offering only a support invitation template', () => {
    const result = decideWhatsAppSend({
      customer,
      message: { type: 'text', text: 'arbitrary operator promise' },
      purpose: 'operator_reply',
      registry,
      now,
    });
    expect(result).toEqual({
      allowed: false,
      code: 'BLOCKED_WINDOW',
      reopen: {
        type: 'template',
        name: 'support_actual',
        language: 'approved_locale',
        parameters: [],
      },
    });
  });
  it('rejects delayed AI and closed-ticket messages, with a window safety margin', () => {
    expect(
      decideWhatsAppSend({
        customer: { ...customer, conversationState: 'HUMAN_HANDOFF' },
        message,
        registry,
        isAiReply: true,
        now,
      }),
    ).toMatchObject({ code: 'STALE_AI' });
    expect(
      decideWhatsAppSend({
        customer,
        message,
        registry,
        purpose: 'operator_reply',
        operatorTicketOpen: false,
        now,
      }),
    ).toMatchObject({ code: 'STALE_OPERATOR' });
    expect(
      decideWhatsAppSend({
        customer: { ...customer, lastInboundAt: new Date(now.getTime() - 86_370_000) },
        message,
        registry,
        now,
      }),
    ).toMatchObject({ allowed: false, code: 'BLOCKED_WINDOW' });
  });
  it('validates configured template purpose and fixed parameter shape', () => {
    expect(() =>
      parseTemplateRegistry(
        JSON.stringify({
          support_reopen: {
            ru: { name: 'support', locale: 'ru', available: true, parameters: ['orderId'] },
          },
        }),
      ),
    ).toThrow();
    expect(
      decideWhatsAppSend({
        customer,
        message: {
          type: 'template',
          name: 'support_actual',
          language: 'approved_locale',
          parameters: ['operator message'],
        },
        purpose: 'support_reopen',
        registry,
        now,
      }),
    ).toMatchObject({ allowed: false, code: 'BLOCKED_TEMPLATE' });
    expect(
      decideWhatsAppSend({
        customer,
        message: { type: 'template', name: 'support_actual', language: 'approved_locale' },
        purpose: 'order_paid',
        registry,
        now,
      }),
    ).toMatchObject({ allowed: false, code: 'BLOCKED_TEMPLATE' });
  });
});

describe('Telegram delivery acknowledgement', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('returns actual binding identifiers without enabling parse mode', async () => {
    const http = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 22, chat: { id: -100 } } })),
      );
    vi.stubGlobal('fetch', http);
    expect(
      await new TelegramService({ botToken: 'test', chatId: '-100' }).send('<user content>'),
    ).toEqual({ chatId: '-100', messageId: '22' });
    const body = JSON.parse(String(http.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty('parse_mode');
    expect(body.protect_content).toBe(true);
  });
  it('treats network timeouts as unknown and honors Telegram flood-control delay', async () => {
    const http = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 20 } }),
          { status: 429 },
        ),
      );
    vi.stubGlobal('fetch', http);
    const telegram = new TelegramService({ botToken: 'test', chatId: '-100' });
    await expect(telegram.send('text')).rejects.toMatchObject({
      outcome: 'UNKNOWN',
      retryable: false,
    });
    await expect(telegram.send('text')).rejects.toMatchObject({
      outcome: 'REJECTED',
      retryAfterMs: 20000,
      retryable: true,
    });
  });
  it('retains definite rate-limit rejection even without a JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('gateway flood limit', { status: 429, headers: { 'Retry-After': '15' } }),
        ),
    );
    await expect(
      new TelegramService({ botToken: 'test', chatId: '-100' }).send('text'),
    ).rejects.toMatchObject({ outcome: 'REJECTED', retryAfterMs: 15000, retryable: true });
  });
  it('uses numeric message IDs for the local Reply simulation', async () => {
    const receipt = await new DemoNotificationService('-100').send('text');
    expect(receipt.chatId).toBe('-100');
    expect(Number.isSafeInteger(Number(receipt.messageId))).toBe(true);
    expect(Number(receipt.messageId)).toBeGreaterThan(0);
  });
});
