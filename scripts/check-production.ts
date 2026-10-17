import 'dotenv/config';
import { readEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/prisma.js';
import { loadBusinessData, businessGateReport } from '../src/config/business.config.js';
import { CatalogService } from '../src/modules/knowledge/catalog.service.js';
import { GoogleSheetsService } from '../src/modules/sheets/google-sheets.service.js';
import { loadGoogleSheetsCredentials } from '../src/modules/sheets/credentials.js';
import { parseTemplateRegistry } from '../src/modules/whatsapp/policy.js';
type Status =
  | 'OK'
  | 'MISSING_CONFIGURATION'
  | 'INVALID_CONFIGURATION'
  | 'ACCESS_FAILED'
  | 'MANUAL_TEST_REQUIRED';
const report: { check: string; status: Status; detail: string }[] = [];
const add = (check: string, status: Status, detail: string) =>
  report.push({ check, status, detail });
const raw: NodeJS.ProcessEnv = {
  ...process.env,
  TELEGRAM_ALLOWED_MANAGER_IDS:
    process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_MANAGER_IDS,
};
const baileys = raw.WHATSAPP_TRANSPORT === 'baileys';
const required = [
  'DATABASE_URL',
  'ADMIN_TOKEN',
  ...(baileys
    ? ['WHATSAPP_AUTH_ENCRYPTION_KEY']
    : [
        'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_PHONE_NUMBER_ID',
        'WHATSAPP_WABA_ID',
        'WHATSAPP_VERIFY_TOKEN',
        'WHATSAPP_APP_SECRET',
        'WHATSAPP_GRAPH_API_VERSION',
      ]),
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'FREEDOMPAY_MERCHANT_ID',
  'FREEDOMPAY_SECRET_KEY',
  ...(raw.GOOGLE_SHEETS_ENABLED === 'false' ? [] : ['GOOGLE_SHEETS_SPREADSHEET_ID']),
  ...(raw.TELEGRAM_ENABLED === 'false' || !raw.TELEGRAM_BOT_TOKEN
    ? []
    : [
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_MANAGER_CHAT_ID',
        'TELEGRAM_ALLOWED_MANAGER_IDS',
        'TELEGRAM_WEBHOOK_SECRET',
      ]),
];
for (const key of required) if (!raw[key]) add(key, 'MISSING_CONFIGURATION', 'Not configured');
let sheetsCredentials: ReturnType<typeof loadGoogleSheetsCredentials> | undefined;
if (raw.GOOGLE_SHEETS_ENABLED !== 'false') {
  if (
    raw.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
    (raw.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() && raw.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim())
  ) {
    try {
      sheetsCredentials = loadGoogleSheetsCredentials(raw);
    } catch {
      add('google-credentials', 'INVALID_CONFIGURATION', 'Google credentials could not be loaded');
    }
  } else {
    add(
      'google-credentials',
      'MISSING_CONFIGURATION',
      'Configure a service-account file or service-account email and private key',
    );
  }
}
if (baileys && !/^[a-fA-F0-9]{64}$/.test(raw.WHATSAPP_AUTH_ENCRYPTION_KEY ?? ''))
  add('baileys-auth-key', 'INVALID_CONFIGURATION', '32-byte encryption key in hex is required');
if (
  raw.NODE_ENV !== 'production' ||
  raw.INTEGRATION_MODE !== 'live' ||
  raw.PAYMENT_PROVIDER !== 'freedompay' ||
  raw.FREEDOMPAY_TEST_MODE !== 'false' ||
  (raw.AI_PROVIDER && raw.AI_PROVIDER !== 'openai') ||
  (raw.GOOGLE_SHEETS_ENABLED !== 'false' &&
    raw.GOOGLE_SHEETS_PROVIDER &&
    raw.GOOGLE_SHEETS_PROVIDER !== 'google')
)
  add(
    'runtime',
    'INVALID_CONFIGURATION',
    'Production requires real providers, live integrations, Freedom Pay and test mode disabled',
  );
for (const key of ['APP_BASE_URL', 'FREEDOMPAY_BASE_URL'])
  if (!raw[key]?.startsWith('https://')) add(key, 'INVALID_CONFIGURATION', 'HTTPS required');
if (process.version !== 'v24.21.0')
  add('node', 'INVALID_CONFIGURATION', 'Use Node v24.21.0 from .nvmrc');
else add('node', 'OK', 'Pinned runtime');
let env: ReturnType<typeof readEnv> | undefined;
try {
  env = readEnv({
    ...raw,
    NODE_ENV: 'development',
    INTEGRATION_MODE: 'demo',
    WHATSAPP_TRANSPORT: 'cloud',
    PAYMENT_PROVIDER: 'mock',
    ADMIN_TOKEN: raw.ADMIN_TOKEN || 'check-only-placeholder-secret',
    MOCK_PAYMENT_SECRET: raw.MOCK_PAYMENT_SECRET || 'check-only-placeholder-secret',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_MANAGER_CHAT_ID: '',
  });
} catch {
  add('environment', 'INVALID_CONFIGURATION', 'Invalid environment values');
}
try {
  const catalog = new CatalogService({ productPrice: env?.PRODUCT_PRICE_KZT ?? 20000 });
  const gate = businessGateReport(loadBusinessData(), {
    mode: 'live',
    catalogReady: catalog.productionReadiness().ready,
  });
  add(
    'business',
    gate.ready ? 'OK' : 'INVALID_CONFIGURATION',
    gate.issues.join('; ') || 'Approved',
  );
} catch {
  add('business', 'INVALID_CONFIGURATION', 'Business/catalog data missing or invalid');
}
if (raw.RETENTION_APPROVED !== 'true')
  add(
    'retention',
    'MANUAL_TEST_REQUIRED',
    'Owner must approve retention, staff access, deletion/correction process and hosting',
  );
async function readJson(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('access');
  return (await response.json()) as Record<string, unknown>;
}
if (env && raw.DATABASE_URL) {
  const db = createDatabase(env.DATABASE_URL);
  try {
    await db.$queryRaw`SELECT 1`;
    add('database', 'OK', 'Connected');
    if (raw.GOOGLE_SHEETS_SPREADSHEET_ID && sheetsCredentials) {
      try {
        const sheets = new GoogleSheetsService({
          db,
          spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
          sheetId: env.GOOGLE_SHEETS_SHEET_ID,
          range: env.GOOGLE_SHEETS_RANGE,
          shippingEnabled: env.GOOGLE_SHEETS_SHIPPING_ENABLED,
          ...sheetsCredentials,
        });
        const result = await sheets.checkSetup();
        add(
          'sheets',
          result.ready
            ? 'OK'
            : result.issues.includes('SHEET_ACCESS_FAILED')
              ? 'ACCESS_FAILED'
              : 'INVALID_CONFIGURATION',
          result.issues.join('; ') || 'Protected technical sheet and headers verified',
        );
      } catch {
        add('sheets', 'ACCESS_FAILED', 'Setup could not be verified');
      }
    }
    const legacyRows = await db.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM "Order" o WHERE o."sheetSyncStatus"='LEGACY_RECONCILIATION_REQUIRED' OR (o."sheetRowReference" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "SheetBinding" b WHERE b."orderId"=o.id))`;
    const legacy = Number(legacyRows[0]?.count ?? 0);
    if (legacy)
      add(
        'sheet-migration',
        'INVALID_CONFIGURATION',
        `${legacy} historical rows require reconciliation`,
      );
  } catch {
    add('database', 'ACCESS_FAILED', 'Cannot access DB or required migrations missing');
  } finally {
    await db.$disconnect();
  }
}
if (!baileys)
  try {
    const registry = parseTemplateRegistry(raw.WHATSAPP_TEMPLATE_REGISTRY ?? '{}');
    const purposes = [
      'order_paid',
      'payment_review',
      'support_reopen',
      ...(raw.GOOGLE_SHEETS_SHIPPING_ENABLED === 'true' ? ['order_shipped' as const] : []),
    ] as const;
    for (const purpose of purposes)
      for (const language of ['ru', 'kk'] as const)
        if (!registry[purpose]?.[language]?.available)
          add(
            `template:${purpose}:${language}`,
            'MISSING_CONFIGURATION',
            'Approved locale must be configured',
          );
    if (raw.WHATSAPP_ACCESS_TOKEN && raw.WHATSAPP_WABA_ID && raw.WHATSAPP_GRAPH_API_VERSION) {
      try {
        const response = await readJson(
          `https://graph.facebook.com/${raw.WHATSAPP_GRAPH_API_VERSION}/${raw.WHATSAPP_WABA_ID}/message_templates?fields=name,language,status&limit=100`,
          { Authorization: `Bearer ${raw.WHATSAPP_ACCESS_TOKEN}` },
        );
        const templates = response.data as { name: string; language: string; status: string }[];
        for (const group of Object.values(registry))
          for (const item of Object.values(group)) {
            if (!item) continue;
            const ok = templates.some(
              (t) => t.name === item.name && t.language === item.locale && t.status === 'APPROVED',
            );
            add(
              `meta-template:${item.name}:${item.locale}`,
              ok ? 'OK' : 'INVALID_CONFIGURATION',
              ok
                ? 'Approved in account'
                : 'Not found approved in first100 templates; inspect pagination/account manually',
            );
          }
      } catch {
        add('meta', 'ACCESS_FAILED', 'Template account access failed');
      }
    }
  } catch {
    add('templates', 'INVALID_CONFIGURATION', 'Invalid template registry JSON');
  }
if (baileys)
  add(
    'baileys-pairing',
    'MANUAL_TEST_REQUIRED',
    'Check QR pairing, expected number, reconnection and phone handoff at /whatsapp/connect',
  );
if (raw.OPENAI_API_KEY && raw.OPENAI_MODEL) {
  try {
    await readJson(`https://api.openai.com/v1/models/${encodeURIComponent(raw.OPENAI_MODEL)}`, {
      Authorization: `Bearer ${raw.OPENAI_API_KEY}`,
    });
    add('openai', 'OK', 'Model accessible');
  } catch {
    add('openai', 'ACCESS_FAILED', 'Model cannot be accessed');
  }
}
if (raw.TELEGRAM_BOT_TOKEN && raw.TELEGRAM_MANAGER_CHAT_ID) {
  try {
    const base = `https://api.telegram.org/bot${raw.TELEGRAM_BOT_TOKEN}`;
    const me = await readJson(`${base}/getMe`);
    if (me.ok !== true) throw new Error('access');
    const ids = (raw.TELEGRAM_ALLOWED_MANAGER_IDS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    for (const id of ids) {
      if (!/^\d+$/.test(id)) {
        add('telegram-manager', 'INVALID_CONFIGURATION', 'Managers must be numeric Telegram IDs');
        continue;
      }
      const member = await readJson(
        `${base}/getChatMember?chat_id=${encodeURIComponent(raw.TELEGRAM_MANAGER_CHAT_ID)}&user_id=${id}`,
      );
      const data = member.result as { status?: string } | undefined;
      add(
        `telegram-manager:${id}`,
        member.ok && data?.status && !['left', 'kicked'].includes(data.status)
          ? 'OK'
          : 'ACCESS_FAILED',
        'Membership checked',
      );
    }
    const webhook = await readJson(`${base}/getWebhookInfo`);
    const info = webhook.result as { url?: string };
    add(
      'telegram-webhook',
      info?.url === `${raw.APP_BASE_URL?.replace(/\/$/, '')}/webhooks/telegram`
        ? 'OK'
        : 'INVALID_CONFIGURATION',
      'Webhook URL must point to this installation',
    );
  } catch {
    add('telegram', 'ACCESS_FAILED', 'Bot/chat membership access failed');
  }
}
for (const check of [
  'freedompay-merchant-contract',
  'real-payment-and-refund-notification',
  'meta-ru-kk-delivery-and-opt-out',
  'telegram-end-to-end',
  'backup-restore',
])
  add(
    check,
    'MANUAL_TEST_REQUIRED',
    'Requires account evidence; local demo is not evidence of production readiness',
  );
console.log(
  JSON.stringify({ ready: report.every((row) => row.status === 'OK'), checks: report }, null, 2),
);
process.exitCode = report.every((row) => row.status === 'OK') ? 0 : 1;
