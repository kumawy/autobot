import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { redactSignalDiagnostics } from '../../src/modules/whatsapp/baileys-diagnostics.js';
import { readEnv } from '../../src/config/env.js';
import { encryptAuth, decryptAuth } from '../../src/modules/whatsapp/baileys-auth.js';
import {
  parseBaileysMessage,
  phoneFromJid,
  renderBaileysText,
} from '../../src/modules/whatsapp/baileys-codec.js';
import { decideWhatsAppSend } from '../../src/modules/whatsapp/policy.js';

const settings = {
  NODE_ENV: 'test',
  INTEGRATION_MODE: 'staging',
  WHATSAPP_TRANSPORT: 'baileys',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  APP_BASE_URL: 'https://example.test',
  ADMIN_TOKEN: 'a'.repeat(32),
  MOCK_PAYMENT_SECRET: 'm'.repeat(32),
  WHATSAPP_AUTH_ENCRYPTION_KEY: 'ab'.repeat(32),
  WHATSAPP_EXPECTED_NUMBER: '77001234567',
  AI_PROVIDER: 'demo',
};
describe('Baileys configuration and credential protection', () => {
  it('redacts actual libsignal session inspection without altering stored state', () => {
    const requireBaileys = createRequire(import.meta.resolve('@whiskeysockets/baileys'));
    const { SessionRecord } = requireBaileys('libsignal') as {
      SessionRecord: { createEntry: () => Record<string, unknown> };
    };
    const entry = SessionRecord.createEntry();
    entry.currentRatchet = {
      rootKey: Buffer.from('private-root-key-test'),
      ephemeralKeyPair: { privKey: Buffer.from('private-ratchet-test') },
    };
    const stored = JSON.stringify(entry);
    redactSignalDiagnostics();
    redactSignalDiagnostics();
    expect(inspect(entry)).toBe('[WhatsApp Signal session redacted]');
    expect(JSON.stringify(entry)).toBe(stored);
    expect(JSON.stringify(entry)).toContain('rootKey');
  });
  it('starts without Meta credentials and keeps mock payments and optional integrations disabled', () => {
    const env = readEnv(settings);
    expect(env.WHATSAPP_ACCESS_TOKEN).toBe('');
    expect(env.DEV_ROUTES_ENABLED).toBe(false);
    expect(env.GOOGLE_SHEETS_ENABLED).toBe(false);
    expect(env.TELEGRAM_ENABLED).toBe(false);
    expect(env.PAYMENT_PROVIDER).toBe('mock');
    expect(() => readEnv({ ...settings, WHATSAPP_TRANSPORT: 'cloud' })).toThrow(
      'WHATSAPP_ACCESS_TOKEN',
    );
    expect(() => readEnv({ ...settings, WHATSAPP_AUTH_ENCRYPTION_KEY: '' })).toThrow('32-byte');
    expect(() => readEnv({ ...settings, WHATSAPP_AUTH_ENCRYPTION_KEY: 'secret' })).toThrow(
      '32-byte',
    );
    expect(() => readEnv({ ...settings, WHATSAPP_EXPECTED_NUMBER: '+77001234567' })).toThrow(
      'without +',
    );
  });
  it('encrypts binary Signal keys, detects tampering and prevents copying credentials to another session', () => {
    const data = { privateKey: Buffer.from([1, 3, 5]), token: 'private-session-token' };
    const ciphertext = encryptAuth(data, settings.WHATSAPP_AUTH_ENCRYPTION_KEY, 'primary:creds');
    expect(ciphertext).not.toContain(data.token);
    expect(decryptAuth(ciphertext, settings.WHATSAPP_AUTH_ENCRYPTION_KEY, 'primary:creds')).toEqual(
      data,
    );
    expect(() => decryptAuth(ciphertext, 'cc'.repeat(32), 'primary:creds')).toThrow();
    expect(() =>
      decryptAuth(ciphertext, settings.WHATSAPP_AUTH_ENCRYPTION_KEY, 'other:creds'),
    ).toThrow();
    const corrupted = Buffer.from(ciphertext, 'base64');
    corrupted[30] = corrupted[30]! ^ 1;
    expect(() =>
      decryptAuth(
        corrupted.toString('base64'),
        settings.WHATSAPP_AUTH_ENCRYPTION_KEY,
        'primary:creds',
      ),
    ).toThrow();
  });
  it.each([
    ['http://localhost:3002', '127.0.0.1'],
    ['http://127.0.0.1:3002', '127.0.0.1'],
    ['http://[::1]:3002', '::1'],
  ])('accepts local Baileys origin %s only with a loopback listener', (APP_BASE_URL, HOST) => {
    expect(readEnv({ ...settings, APP_BASE_URL, HOST }).APP_BASE_URL).toBe(APP_BASE_URL);
  });
  it.each([
    ['http://localhost:3002', '0.0.0.0'],
    ['http://localhost:3002', '::'],
    ['http://192.168.1.5:3002', '127.0.0.1'],
    ['http://example.test', '127.0.0.1'],
    ['http://localhost.evil.test:3002', '127.0.0.1'],
    ['http://admin:secret@localhost:3002', '127.0.0.1'],
    ['http://localhost:3002/other', '127.0.0.1'],
    ['http://localhost:3002?token=secret', '127.0.0.1'],
  ])('rejects unsafe local origins/listeners: %s %s', (APP_BASE_URL, HOST) => {
    expect(() => readEnv({ ...settings, APP_BASE_URL, HOST })).toThrow('HTTPS');
  });
  it('keeps production closed for local Baileys', () => {
    expect(() =>
      readEnv({
        ...settings,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        APP_BASE_URL: 'http://localhost:3002',
      }),
    ).toThrow('HTTPS');
  });
});

describe('WhatsApp Web message mapping', () => {
  it('maps native button clicks to action IDs, preserving menu context instead of trusting the display label', () => {
    expect(
      parseBaileysMessage(
        {
          key: { id: 'native-click', remoteJid: '77001234567@s.whatsapp.net' },
          message: {
            interactiveResponseMessage: {
              body: { text: 'Русский' },
              nativeFlowResponseMessage: {
                name: 'quick_reply',
                paramsJson: JSON.stringify({ id: 'private-action-token', display_text: 'Қазақша' }),
              },
              contextInfo: { stanzaId: 'language-menu-id' },
            },
          },
        },
        '77001234567',
      ),
    ).toMatchObject({
      type: 'interactive',
      actionId: 'private-action-token',
      replyToMessageId: 'language-menu-id',
    });
  });
  it.each(['{', 'null', '{"id":123}', '{"display_text":"Русский"}', '{"id":""}', 'x'.repeat(4097)])(
    'ignores malformed native button parameters',
    (paramsJson) => {
      expect(
        parseBaileysMessage(
          {
            key: { id: 'malformed' },
            message: {
              interactiveResponseMessage: {
                nativeFlowResponseMessage: { name: 'quick_reply', paramsJson },
              },
            },
          },
          '77001234567',
        ),
      ).toBeNull();
    },
  );
  it('uses phone-number JIDs and refuses to treat opaque LIDs or groups as phone numbers', () => {
    expect(phoneFromJid('77001234567:2@s.whatsapp.net')).toBe('77001234567');
    expect(phoneFromJid('123456789012345@lid')).toBeNull();
    expect(phoneFromJid('77001234567@g.us')).toBeNull();
  });
  it('unwraps temporary messages, preserves quote context and redacts payment credentials', () => {
    const parsed = parseBaileysMessage(
      {
        key: { id: 'one', remoteJid: '77001234567@s.whatsapp.net' },
        messageTimestamp: 1750000000,
        message: {
          ephemeralMessage: {
            message: {
              extendedTextMessage: {
                text: '4242 4242 4242 4242',
                contextInfo: { stanzaId: 'menu-one' },
              },
            },
          },
        },
      },
      '77001234567',
    );
    expect(parsed).toMatchObject({
      text: '[PAYMENT_CREDENTIALS_REDACTED]',
      replyToMessageId: 'menu-one',
    });
    expect(
      parseBaileysMessage(
        { key: { id: 'system' }, message: { protocolMessage: {} } },
        '77001234567',
      ),
    ).toBeNull();
  });
  it('renders numbered menus without exposing action tokens and refuses Cloud templates', () => {
    const text = renderBaileysText({
      type: 'buttons',
      text: 'Язык',
      buttons: [
        { id: 'private-one-use-token', title: 'Русский' },
        { id: 'token-2', title: 'Қазақша' },
      ],
    });
    expect(text).toContain('1. Русский');
    expect(text).toContain('2. Қазақша');
    expect(text).not.toContain('private-one-use-token');
    expect(() => renderBaileysText({ type: 'template', name: 'paid', language: 'ru' })).toThrow(
      'TEMPLATES_UNSUPPORTED',
    );
  });
  it('does not apply Cloud-only windows, but retains consent and human handoff checks', () => {
    const customer = {
      lastInboundAt: new Date(0),
      preferredLanguage: 'ru' as const,
      conversationState: 'AI_QA',
      notificationConsent: false,
      optedOutAt: null,
    };
    const input = { customer, message: { type: 'text' as const, text: 'Ответ' }, registry: {} };
    expect(decideWhatsAppSend(input)).toMatchObject({ allowed: false, code: 'BLOCKED_WINDOW' });
    expect(decideWhatsAppSend({ ...input, transport: 'baileys' })).toMatchObject({ allowed: true });
    expect(
      decideWhatsAppSend({ ...input, transport: 'baileys', purpose: 'order_paid' }),
    ).toMatchObject({ allowed: false, code: 'BLOCKED_CONSENT' });
    expect(
      decideWhatsAppSend({
        ...input,
        transport: 'baileys',
        isAiReply: true,
        customer: { ...customer, conversationState: 'HUMAN_HANDOFF' },
      }),
    ).toMatchObject({ allowed: false, code: 'STALE_AI' });
  });
});
