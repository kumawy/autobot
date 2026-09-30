import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { readEnv, type Env } from '../../src/config/env.js';
import { buildApp } from '../../src/app.js';
import {
  DemoSheetsService,
  GoogleSheetsService,
} from '../../src/modules/sheets/google-sheets.service.js';

const aiConstructors = vi.hoisted(() => ({ demo: vi.fn(), openai: vi.fn() }));
vi.mock('../../src/modules/ai/ai.service.js', () => ({
  DemoAiService: class {
    constructor(options: unknown) {
      aiConstructors.demo(options);
    }
    async answer() {
      return { text: 'offline demo response' };
    }
  },
  OpenAiService: class {
    constructor(options: unknown) {
      aiConstructors.openai(options);
    }
    async answer() {
      return { text: 'offline mocked OpenAI response' };
    }
  },
}));

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  ADMIN_TOKEN: 'a'.repeat(32),
  MOCK_PAYMENT_SECRET: 'm'.repeat(32),
  LOG_LEVEL: 'silent',
};
const realProviders = {
  AI_PROVIDER: 'openai',
  OPENAI_API_KEY: 'test-only-openai-secret',
  OPENAI_MODEL: 'owner-selected-model',
  GOOGLE_SHEETS_PROVIDER: 'google',
  GOOGLE_SHEETS_ENABLED: 'true',
  GOOGLE_SHEETS_SPREADSHEET_ID: 'test-spreadsheet-id',
  GOOGLE_SHEETS_SHEET_ID: '12',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'unit-test@example.iam.gserviceaccount.com',
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey,
};
const live = {
  ...base,
  ...realProviders,
  INTEGRATION_MODE: 'live',
  APP_BASE_URL: 'https://shop.example.test',
  WHATSAPP_ACCESS_TOKEN: 'test-meta-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234',
  WHATSAPP_WABA_ID: '5678',
  WHATSAPP_VERIFY_TOKEN: 'v'.repeat(32),
  WHATSAPP_APP_SECRET: 'test-meta-secret',
  WHATSAPP_GRAPH_API_VERSION: 'v99.0',
  PAYMENT_PROVIDER: 'freedompay',
  FREEDOMPAY_MERCHANT_ID: 'test-merchant',
  FREEDOMPAY_SECRET_KEY: 'test-freedompay-secret',
  FREEDOMPAY_TEST_MODE: 'false',
  TELEGRAM_ENABLED: 'false',
};

describe('independent integration providers', () => {
  it('preserves offline defaults and derives live defaults', () => {
    expect(readEnv(base)).toMatchObject({ AI_PROVIDER: 'demo', GOOGLE_SHEETS_PROVIDER: 'demo' });
    expect(
      readEnv({ ...live, AI_PROVIDER: undefined, GOOGLE_SHEETS_PROVIDER: undefined }),
    ).toMatchObject({ AI_PROVIDER: 'openai', GOOGLE_SHEETS_PROVIDER: 'google' });
  });

  it('enables real AI and Sheets in the simulator without Meta or Telegram credentials', () => {
    expect(readEnv({ ...base, ...realProviders, TELEGRAM_ENABLED: 'false' })).toMatchObject({
      INTEGRATION_MODE: 'demo',
      AI_PROVIDER: 'openai',
      GOOGLE_SHEETS_PROVIDER: 'google',
      DEV_ROUTES_ENABLED: true,
      PAYMENT_PROVIDER: 'mock',
      TELEGRAM_ENABLED: false,
      MANAGER_HANDOFF_ENABLED: false,
    });
  });

  it.each([
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'GOOGLE_SHEETS_SPREADSHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
  ])('requires real-provider credentials in demo: %s', (key) => {
    expect(() => readEnv({ ...base, ...realProviders, [key]: ' ' })).toThrow(`Missing ${key}`);
  });

  it('accepts a credential-file path instead of inline Google credentials', () => {
    expect(
      readEnv({
        ...base,
        GOOGLE_SHEETS_PROVIDER: 'google',
        GOOGLE_SHEETS_SPREADSHEET_ID: 'test-id',
        GOOGLE_APPLICATION_CREDENTIALS: '/test-only/credentials.json',
        GOOGLE_SHEETS_OWNER_EMAIL: 'owner@example.test',
      }),
    ).toMatchObject({
      GOOGLE_APPLICATION_CREDENTIALS: '/test-only/credentials.json',
      GOOGLE_SHEETS_OWNER_EMAIL: 'owner@example.test',
    });
  });

  it('does not require unused Google or OpenAI credentials', () => {
    expect(() =>
      readEnv({ ...base, GOOGLE_SHEETS_PROVIDER: 'google', GOOGLE_SHEETS_ENABLED: 'false' }),
    ).not.toThrow();
    expect(() =>
      readEnv({
        ...live,
        AI_PROVIDER: 'demo',
        OPENAI_API_KEY: '',
        OPENAI_MODEL: '',
        GOOGLE_SHEETS_PROVIDER: 'demo',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: '',
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '',
        GOOGLE_SHEETS_SPREADSHEET_ID: '',
      }),
    ).not.toThrow();
  });

  it('rejects fake enabled providers in production but permits disabled Sheets', () => {
    expect(() => readEnv({ ...live, NODE_ENV: 'production' })).not.toThrow();
    expect(() => readEnv({ ...live, NODE_ENV: 'production', AI_PROVIDER: 'demo' })).toThrow(
      'Production requires the OpenAI',
    );
    expect(() =>
      readEnv({ ...live, NODE_ENV: 'production', GOOGLE_SHEETS_PROVIDER: 'demo' }),
    ).toThrow('Production requires the Google');
    expect(() =>
      readEnv({
        ...live,
        NODE_ENV: 'production',
        GOOGLE_SHEETS_PROVIDER: 'demo',
        GOOGLE_SHEETS_ENABLED: 'false',
      }),
    ).not.toThrow();
  });

  it.each([{ AI_PROVIDER: 'invalid' }, { GOOGLE_SHEETS_PROVIDER: 'invalid' }])(
    'rejects invalid provider values',
    (input) => {
      expect(() => readEnv({ ...base, ...input })).toThrow();
    },
  );
});

const runtimes: Awaited<ReturnType<typeof buildApp>>[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.app.close();
});
async function setup(env: Env) {
  const query = vi.fn();
  const runtime = await buildApp({
    env,
    logger: false,
    db: { $queryRaw: query } as unknown as PrismaClient,
  });
  runtimes.push(runtime);
  return { ...runtime, query };
}

describe('simulator integration metadata and adapter selection', () => {
  it('reports offline defaults with no database query or credential exposure', async () => {
    const { app, sheets, query } = await setup(
      readEnv({ ...base, ...realProviders, AI_PROVIDER: 'demo', GOOGLE_SHEETS_PROVIDER: 'demo' }),
    );
    const response = await app.inject({ method: 'GET', url: '/dev/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ai: { provider: 'demo', model: null },
      sheets: { provider: 'demo', enabled: true, url: null },
      whatsapp: { provider: 'demo' },
      telegram: { enabled: true, provider: 'demo' },
      managerHandoffEnabled: true,
      paymentProvider: 'mock',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain(realProviders.OPENAI_API_KEY);
    expect(response.body).not.toContain(realProviders.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
    expect(query).not.toHaveBeenCalled();
    expect(aiConstructors.demo).toHaveBeenCalledOnce();
    expect(aiConstructors.openai).not.toHaveBeenCalled();
    expect(sheets).toBeInstanceOf(DemoSheetsService);
  });

  it('selects real AI and Sheets while keeping transport/payment simulated', async () => {
    const { app, sheets, query } = await setup(
      readEnv({ ...base, ...realProviders, TELEGRAM_ENABLED: 'false' }),
    );
    const response = await app.inject({ method: 'GET', url: '/dev/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ai: { provider: 'openai', model: realProviders.OPENAI_MODEL },
      sheets: {
        provider: 'google',
        enabled: true,
        url: 'https://docs.google.com/spreadsheets/d/test-spreadsheet-id/edit#gid=12',
      },
      whatsapp: { provider: 'demo' },
      telegram: { enabled: false, provider: 'demo' },
      managerHandoffEnabled: false,
      paymentProvider: 'mock',
    });
    expect(query).not.toHaveBeenCalled();
    expect(aiConstructors.demo).not.toHaveBeenCalled();
    expect(aiConstructors.openai).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: realProviders.OPENAI_API_KEY,
        model: realProviders.OPENAI_MODEL,
      }),
    );
    expect(sheets).toBeInstanceOf(GoogleSheetsService);
    expect(response.body).not.toContain(realProviders.OPENAI_API_KEY);
    expect(response.body).not.toContain(realProviders.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
    expect(response.body).not.toContain(realProviders.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  });

  it('does not load unused credential files and returns no disabled Sheets link', async () => {
    const { app, sheets } = await setup(
      readEnv({
        ...base,
        GOOGLE_SHEETS_PROVIDER: 'google',
        GOOGLE_SHEETS_ENABLED: 'false',
        GOOGLE_APPLICATION_CREDENTIALS: '/does-not-exist/test-only.json',
      }),
    );
    const response = await app.inject({ method: 'GET', url: '/dev/config' });
    expect(response.json().sheets).toEqual({ provider: 'google', enabled: false, url: null });
    expect(response.body).not.toContain('/does-not-exist/');
    expect(sheets).toBeInstanceOf(DemoSheetsService);
  });

  it.each([
    { host: 'external.example.test' },
    { host: 'localhost:3000', origin: 'https://external.example.test' },
  ])('keeps existing local and same-origin guards', async (headers) => {
    const { app } = await setup(readEnv(base));
    expect((await app.inject({ method: 'GET', url: '/dev/config', headers })).statusCode).toBe(403);
  });

  it.each(['disabled', 'staging', 'production'])(
    'does not expose demo metadata in %s mode',
    async (mode) => {
      const env =
        mode === 'disabled'
          ? readEnv({ ...base, DEV_ROUTES_ENABLED: 'false' })
          : mode === 'staging'
            ? readEnv({
                ...live,
                INTEGRATION_MODE: 'staging',
                PAYMENT_PROVIDER: 'mock',
                APP_BASE_URL: 'https://staging.example.test',
              })
            : readEnv({ ...live, NODE_ENV: 'production' });
      const { app } = await setup(env);
      expect((await app.inject({ method: 'GET', url: '/dev/config' })).statusCode).toBe(404);
    },
  );
});
