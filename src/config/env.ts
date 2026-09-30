import 'dotenv/config';
import { z } from 'zod';
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
  INTEGRATION_MODE: z.enum(['demo', 'live']).default('demo'),
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
  OPENAI_API_KEY: optional,
  OPENAI_MODEL: optional,
  FREEDOMPAY_MERCHANT_ID: optional,
  FREEDOMPAY_SECRET_KEY: optional,
  FREEDOMPAY_BASE_URL: z.url().default('https://api.freedompay.kz'),
  FREEDOMPAY_TEST_MODE: flag(true),
  GOOGLE_SHEETS_SPREADSHEET_ID: optional,
  GOOGLE_SHEETS_RANGE: z.string().default('Orders!A:Y'),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: optional,
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: optional,
  GOOGLE_SHEETS_SHEET_ID: z.coerce.number().int().nonnegative().default(0),
  TELEGRAM_BOT_TOKEN: optional,
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
  const env = schema.parse(input);
  if (env.INTEGRATION_MODE === 'live') {
    for (const key of [
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_VERIFY_TOKEN',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_GRAPH_API_VERSION',
      'OPENAI_API_KEY',
      'OPENAI_MODEL',
      'GOOGLE_SHEETS_SPREADSHEET_ID',
      'GOOGLE_SERVICE_ACCOUNT_EMAIL',
      'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
    ] as const)
      if (!env[key]) throw new Error(`Missing ${key} for live integrations`);
    if (!/^v\d+\.\d+$/.test(env.WHATSAPP_GRAPH_API_VERSION))
      throw new Error('Invalid WHATSAPP_GRAPH_API_VERSION');
  }
  if (
    env.PAYMENT_PROVIDER === 'freedompay' &&
    (!env.FREEDOMPAY_MERCHANT_ID || !env.FREEDOMPAY_SECRET_KEY)
  )
    throw new Error('Freedom Pay credentials required');
  if (Boolean(env.TELEGRAM_BOT_TOKEN) !== Boolean(env.TELEGRAM_MANAGER_CHAT_ID))
    throw new Error('Configure both Telegram settings');
  if (env.NODE_ENV === 'production') {
    if (
      env.INTEGRATION_MODE !== 'live' ||
      env.PAYMENT_PROVIDER !== 'freedompay' ||
      env.FREEDOMPAY_TEST_MODE
    )
      throw new Error('Production requires live integrations and real Freedom Pay');
    if (!env.APP_BASE_URL.startsWith('https://') || !env.FREEDOMPAY_BASE_URL.startsWith('https://'))
      throw new Error('Production requires HTTPS');
    if (env.ADMIN_TOKEN.startsWith('local-') || env.WHATSAPP_VERIFY_TOKEN.length < 24)
      throw new Error('Use strong production secrets');
  }
  return env;
}
