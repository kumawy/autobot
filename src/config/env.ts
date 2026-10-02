import 'dotenv/config';
import { z } from 'zod';
import { validateDatabaseUrl } from '../db/database-url.js';
const flag = (fallback: boolean) =>
  z.preprocess(
    (v) =>
      v === undefined || v === ''
        ? fallback
        : v === 'true' || v === true
          ? true
          : v === 'false' || v === false
            ? false
            : v,
    z.boolean(),
  );
const optional = z.string().default('');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: optional,
  INTEGRATION_MODE: z.enum(['demo', 'staging', 'live']).default('demo'),
  DEV_ROUTES_ENABLED: flag(false),
  PAYMENT_PROVIDER: z.enum(['mock', 'freedompay']).default('mock'),
  ADMIN_TOKEN: z.string().min(24),
  MOCK_PAYMENT_SECRET: z.string().min(24),
  WHATSAPP_ACCESS_TOKEN: optional,
  WHATSAPP_PHONE_NUMBER_ID: optional,
  WHATSAPP_WABA_ID: optional,
  WHATSAPP_VERIFY_TOKEN: optional,
  WHATSAPP_APP_SECRET: optional,
  WHATSAPP_GRAPH_API_VERSION: optional,
  WHATSAPP_PAID_TEMPLATE: optional,
  WHATSAPP_WINDOW_SAFETY_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  WHATSAPP_TEMPLATE_REGISTRY: z.string().default('{}'),
  AI_PROVIDER: z.enum(['demo', 'openai']),
  OPENAI_API_KEY: optional,
  OPENAI_MODEL: optional,
  FREEDOMPAY_MERCHANT_ID: optional,
  FREEDOMPAY_SECRET_KEY: optional,
  FREEDOMPAY_BASE_URL: z.url().default('https://api.freedompay.kz'),
  FREEDOMPAY_TEST_MODE: flag(true),
  GOOGLE_SHEETS_SPREADSHEET_ID: optional,
  GOOGLE_SHEETS_ENABLED: flag(false),
  GOOGLE_SHEETS_SHIPPING_ENABLED: flag(false),
  GOOGLE_SHEETS_PROVIDER: z.enum(['demo', 'google']),
  GOOGLE_SHEETS_RANGE: z.string().default('Orders!A:Y'),
  GOOGLE_APPLICATION_CREDENTIALS: optional,
  GOOGLE_SERVICE_ACCOUNT_EMAIL: optional,
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: optional,
  GOOGLE_SHEETS_OWNER_EMAIL: optional,
  GOOGLE_SHEETS_SHEET_ID: z.coerce.number().int().nonnegative().default(0),
  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_ENABLED: flag(false),
  MANAGER_HANDOFF_ENABLED: flag(false),
  TELEGRAM_ALLOWED_USER_IDS: optional,
  TELEGRAM_ALLOWED_MANAGER_IDS: optional,
  TELEGRAM_WEBHOOK_SECRET: optional,
  AI_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(4).default(4),
  RETENTION_APPROVED: flag(false),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  TELEGRAM_MANAGER_CHAT_ID: optional,
  PRODUCT_PRICE_KZT: z.coerce.number().int().positive().max(10000000).default(20000),
  MAX_ORDER_QUANTITY: z.coerce.number().int().min(1).max(100).default(10),
  PROCESS_FIRST_MESSAGE_AFTER_LANGUAGE: flag(true),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  PAYMENT_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(60000).default(300000),
  PAYMENT_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  PAYMENT_PROVIDER_MIN_INTERVAL_MS: z.coerce.number().int().min(1500).default(2000),
  MAX_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  BUSINESS_NAME: z.string().default('Music Box Demo'),
  BUSINESS_PHONE: optional,
  MANAGER_NAME: optional,
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});
export type Env = z.infer<typeof schema>;
export function readEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const mode = input.INTEGRATION_MODE || 'demo';
  const configured = (key: string, fallback: boolean) => input[key] || String(fallback);
  const telegramEnabled = configured(
    'TELEGRAM_ENABLED',
    mode === 'demo' || (mode === 'live' && Boolean(input.TELEGRAM_BOT_TOKEN)),
  );
  const env = schema.parse({
    ...input,
    AI_PROVIDER: input.AI_PROVIDER || (mode === 'demo' ? 'demo' : 'openai'),
    DEV_ROUTES_ENABLED: configured('DEV_ROUTES_ENABLED', mode === 'demo'),
    GOOGLE_SHEETS_ENABLED: configured('GOOGLE_SHEETS_ENABLED', mode !== 'staging'),
    GOOGLE_SHEETS_PROVIDER: input.GOOGLE_SHEETS_PROVIDER || (mode === 'demo' ? 'demo' : 'google'),
    TELEGRAM_ENABLED: telegramEnabled,
    MANAGER_HANDOFF_ENABLED: configured('MANAGER_HANDOFF_ENABLED', telegramEnabled === 'true'),
    TELEGRAM_ALLOWED_MANAGER_IDS:
      input.TELEGRAM_ALLOWED_USER_IDS || input.TELEGRAM_ALLOWED_MANAGER_IDS || '',
  });
  validateDatabaseUrl(env.DATABASE_URL);
  if (env.DIRECT_URL) validateDatabaseUrl(env.DIRECT_URL, 'migration');
  if (env.INTEGRATION_MODE !== 'demo') {
    for (const key of [
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_WABA_ID',
      'WHATSAPP_VERIFY_TOKEN',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_GRAPH_API_VERSION',
    ] as const)
      if (!env[key].trim()) throw new Error(`Missing ${key} for live integrations`);
    if (!/^v\d+\.\d+$/.test(env.WHATSAPP_GRAPH_API_VERSION))
      throw new Error('Invalid WHATSAPP_GRAPH_API_VERSION');
    if (env.TELEGRAM_ENABLED)
      for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_MANAGER_CHAT_ID'] as const)
        if (!env[key].trim()) throw new Error(`Missing ${key} for enabled Telegram`);
    if (env.TELEGRAM_ENABLED && !/^-?[1-9]\d*$/.test(env.TELEGRAM_MANAGER_CHAT_ID))
      throw new Error('Telegram manager chat must be a numeric ID');
    if (env.MANAGER_HANDOFF_ENABLED) {
      if (!env.TELEGRAM_ENABLED) throw new Error('Manager handoff requires enabled Telegram');
      const managers = env.TELEGRAM_ALLOWED_MANAGER_IDS.split(',').map((id) => id.trim());
      if (
        managers.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) ||
        !env.TELEGRAM_WEBHOOK_SECRET.trim()
      )
        throw new Error('Manager handoff requires Telegram manager IDs and webhook secret');
      env.TELEGRAM_ALLOWED_MANAGER_IDS = managers.join(',');
    }
  }
  if (env.AI_PROVIDER === 'openai')
    for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL'] as const)
      if (!env[key].trim()) throw new Error(`Missing ${key} for OpenAI provider`);
  if (env.GOOGLE_SHEETS_ENABLED && env.GOOGLE_SHEETS_PROVIDER === 'google') {
    if (!env.GOOGLE_SHEETS_SPREADSHEET_ID.trim())
      throw new Error('Missing GOOGLE_SHEETS_SPREADSHEET_ID for enabled Google Sheets');
    if (!env.GOOGLE_APPLICATION_CREDENTIALS.trim())
      for (const key of [
        'GOOGLE_SERVICE_ACCOUNT_EMAIL',
        'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
      ] as const)
        if (!env[key].trim()) throw new Error(`Missing ${key} for enabled Google Sheets`);
  }
  if (env.MANAGER_HANDOFF_ENABLED && !env.TELEGRAM_ENABLED)
    throw new Error('Manager handoff requires enabled Telegram');
  if (env.INTEGRATION_MODE === 'staging' && env.PAYMENT_PROVIDER !== 'mock')
    throw new Error('Staging requires mock payments');
  if (env.INTEGRATION_MODE === 'staging') {
    const base = new URL(env.APP_BASE_URL);
    if (
      !input.APP_BASE_URL ||
      base.protocol !== 'https:' ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== '/' ||
      ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    )
      throw new Error('Staging requires an explicit public HTTPS APP_BASE_URL origin');
  }
  if (env.INTEGRATION_MODE !== 'demo' && env.DEV_ROUTES_ENABLED)
    throw new Error('Development simulator requires demo integration mode');
  if (
    env.PAYMENT_PROVIDER === 'freedompay' &&
    (!env.FREEDOMPAY_MERCHANT_ID || !env.FREEDOMPAY_SECRET_KEY)
  )
    throw new Error('Freedom Pay credentials required');
  if (env.NODE_ENV === 'production') {
    if (
      env.INTEGRATION_MODE !== 'live' ||
      env.PAYMENT_PROVIDER !== 'freedompay' ||
      env.FREEDOMPAY_TEST_MODE
    )
      throw new Error('Production requires live integrations and real Freedom Pay');
    if (env.AI_PROVIDER !== 'openai') throw new Error('Production requires the OpenAI provider');
    if (env.GOOGLE_SHEETS_ENABLED && env.GOOGLE_SHEETS_PROVIDER !== 'google')
      throw new Error('Production requires the Google provider for enabled Sheets');
    if (input.DEV_ROUTES_ENABLED === 'true')
      throw new Error('Development routes are forbidden in production');
    env.DEV_ROUTES_ENABLED = false;
    if (!env.APP_BASE_URL.startsWith('https://') || !env.FREEDOMPAY_BASE_URL.startsWith('https://'))
      throw new Error('Production requires HTTPS');
    if (env.ADMIN_TOKEN.startsWith('local-') || env.WHATSAPP_VERIFY_TOKEN.length < 24)
      throw new Error('Use strong production secrets');
  }
  return env;
}
