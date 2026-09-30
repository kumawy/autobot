import { describe, expect, it } from 'vitest';
import { readEnv } from '../../src/config/env.js';

const staging = {
  NODE_ENV: 'development',
  INTEGRATION_MODE: 'staging',
  APP_BASE_URL: 'https://staging.example.test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  ADMIN_TOKEN: 'a'.repeat(32),
  MOCK_PAYMENT_SECRET: 'm'.repeat(32),
  OPENAI_API_KEY: 'test-only-key',
  OPENAI_MODEL: 'owner-selected-model',
  WHATSAPP_ACCESS_TOKEN: 'test-only-token',
  WHATSAPP_PHONE_NUMBER_ID: '123456789',
  WHATSAPP_WABA_ID: '987654321',
  WHATSAPP_APP_SECRET: 'test-only-app-secret',
  WHATSAPP_VERIFY_TOKEN: 'v'.repeat(32),
  WHATSAPP_GRAPH_API_VERSION: 'v99.0',
};

describe('staging configuration', () => {
  it('enables Meta/OpenAI with mock payment and no optional integrations', () => {
    const env = readEnv(staging);
    expect(env.INTEGRATION_MODE).toBe('staging');
    expect(env.OPENAI_MODEL).toBe(staging.OPENAI_MODEL);
    expect(env.PAYMENT_PROVIDER).toBe('mock');
    expect(env.GOOGLE_SHEETS_ENABLED).toBe(false);
    expect(env.TELEGRAM_ENABLED).toBe(false);
    expect(env.MANAGER_HANDOFF_ENABLED).toBe(false);
    expect(env.DEV_ROUTES_ENABLED).toBe(false);
  });

  it.each([
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_WABA_ID',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_GRAPH_API_VERSION',
  ])('requires %s', (key) => {
    expect(() => readEnv({ ...staging, [key]: '' })).toThrow(`Missing ${key}`);
  });

  it('permits disabled optional integrations with incomplete settings', () => {
    expect(() =>
      readEnv({
        ...staging,
        GOOGLE_SHEETS_ENABLED: 'false',
        TELEGRAM_ENABLED: 'false',
        TELEGRAM_BOT_TOKEN: 'unused-partial-value',
      }),
    ).not.toThrow();
    expect(() => readEnv({ ...staging, GOOGLE_SHEETS_ENABLED: 'true' })).toThrow('Google Sheets');
    expect(() => readEnv({ ...staging, TELEGRAM_ENABLED: 'true' })).toThrow('Telegram');
    expect(() => readEnv({ ...staging, MANAGER_HANDOFF_ENABLED: 'true' })).toThrow(
      'enabled Telegram',
    );
  });

  it('accepts the new Telegram user ID name and keeps the old alias', () => {
    const telegram = {
      ...staging,
      TELEGRAM_ENABLED: 'true',
      MANAGER_HANDOFF_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'test-bot',
      TELEGRAM_MANAGER_CHAT_ID: '-1001',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
    };
    expect(
      readEnv({ ...telegram, TELEGRAM_ALLOWED_USER_IDS: '1001,1002' }).TELEGRAM_ALLOWED_MANAGER_IDS,
    ).toBe('1001,1002');
    expect(
      readEnv({ ...telegram, TELEGRAM_ALLOWED_MANAGER_IDS: '1003' }).TELEGRAM_ALLOWED_MANAGER_IDS,
    ).toBe('1003');
    for (const ids of [' , ', '-10', '01', '1001,', '9007199254740993'])
      expect(() => readEnv({ ...telegram, TELEGRAM_ALLOWED_USER_IDS: ids })).toThrow('manager IDs');
    expect(() =>
      readEnv({ ...telegram, TELEGRAM_ALLOWED_USER_IDS: '1001', TELEGRAM_WEBHOOK_SECRET: '   ' }),
    ).toThrow('webhook secret');
    expect(() =>
      readEnv({
        ...telegram,
        TELEGRAM_ALLOWED_USER_IDS: '1001',
        TELEGRAM_MANAGER_CHAT_ID: 'not-a-chat-id',
      }),
    ).toThrow('numeric ID');
  });

  it('preserves production guards and forbids real payments or simulator in staging', () => {
    expect(() => readEnv({ ...staging, NODE_ENV: 'production' })).toThrow(
      'Production requires live',
    );
    expect(() => readEnv({ ...staging, PAYMENT_PROVIDER: 'freedompay' })).toThrow(
      'Staging requires mock',
    );
    expect(() => readEnv({ ...staging, DEV_ROUTES_ENABLED: 'true' })).toThrow('requires demo');
  });
  it('requires an explicit public HTTPS origin before sending staging checkout links', () => {
    for (const url of [
      undefined,
      'http://staging.example.test',
      'https://localhost',
      'https://127.0.0.1',
      'https://secret:password@staging.example.test',
      'https://staging.example.test/path',
      'https://staging.example.test?token=value',
    ])
      expect(() => readEnv({ ...staging, APP_BASE_URL: url })).toThrow('public HTTPS APP_BASE_URL');
  });
});
