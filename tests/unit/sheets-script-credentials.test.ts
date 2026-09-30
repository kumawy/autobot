import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  credentials: vi.fn(),
  sheetOptions: vi.fn(),
  sheetCheck: vi.fn(),
  jwt: vi.fn(),
  sheetsApi: vi.fn(),
  metadata: vi.fn(),
  values: vi.fn(),
  migrate: vi.fn(),
  disconnect: vi.fn(),
  query: vi.fn(),
  write: vi.fn(),
  env: {
    DATABASE_URL: 'postgresql://unit:unit@localhost:5432/test',
    GOOGLE_APPLICATION_CREDENTIALS: '/not-read/test-service-account.json',
    GOOGLE_SHEETS_SPREADSHEET_ID: 'test-spreadsheet',
    GOOGLE_SHEETS_SHEET_ID: 0,
    GOOGLE_SHEETS_RANGE: 'Orders!A:Y',
    PRODUCT_PRICE_KZT: 20000,
  },
}));
vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/config/env.js', () => ({ readEnv: () => state.env }));
vi.mock('../../src/db/prisma.js', () => ({
  createDatabase: () => ({ $disconnect: state.disconnect, $queryRaw: state.query }),
}));
vi.mock('../../src/modules/sheets/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/modules/sheets/credentials.js')>()),
  loadGoogleSheetsCredentials: state.credentials,
}));
vi.mock('../../src/modules/sheets/google-sheets.service.js', () => ({
  GoogleSheetsService: class {
    constructor(options: unknown) {
      state.sheetOptions(options);
    }
    checkSetup = state.sheetCheck;
  },
}));
vi.mock('../../src/modules/sheets/legacy-migration.js', () => ({
  migrateLegacySheetRows: state.migrate,
}));
vi.mock('../../src/modules/knowledge/catalog.service.js', () => ({
  CatalogService: class {
    productionReadiness() {
      return { ready: true };
    }
  },
}));
vi.mock('../../src/config/business.config.js', () => ({
  loadBusinessData: () => ({}),
  businessGateReport: () => ({ ready: true, issues: [] }),
}));
vi.mock('node:fs/promises', () => ({
  writeFile: state.write,
  mkdir: vi.fn(),
  chmod: vi.fn(),
}));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      JWT: class {
        constructor(options: unknown) {
          state.jwt(options);
        }
      },
    },
    sheets: (...args: unknown[]) => {
      state.sheetsApi(...args);
      return { spreadsheets: { get: state.metadata, values: { get: state.values } } };
    },
  },
}));

const credentials = {
  serviceAccountEmail: 'test@example.test',
  privateKey: 'unit-test-private-key',
};
let originalExitCode: typeof process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  originalExitCode = process.exitCode;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No network in unit tests')));
  for (const key of [
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_MANAGER_CHAT_ID',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_WABA_ID',
    'WHATSAPP_GRAPH_API_VERSION',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
    'AI_PROVIDER',
    'GOOGLE_SHEETS_PROVIDER',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('DATABASE_URL', state.env.DATABASE_URL);
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', state.env.GOOGLE_APPLICATION_CREDENTIALS);
  vi.stubEnv('GOOGLE_SHEETS_SPREADSHEET_ID', state.env.GOOGLE_SHEETS_SPREADSHEET_ID);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('INTEGRATION_MODE', 'live');
  vi.stubEnv('PAYMENT_PROVIDER', 'freedompay');
  vi.stubEnv('FREEDOMPAY_TEST_MODE', 'false');
  vi.stubEnv('GOOGLE_SHEETS_ENABLED', 'true');
  state.credentials.mockReturnValue(credentials);
  state.sheetCheck.mockResolvedValue({ ready: true, issues: [] });
  state.query.mockResolvedValue([{ count: 0n }]);
  state.metadata.mockResolvedValue({
    data: { sheets: [{ properties: { sheetId: 0, title: 'Orders', sheetType: 'GRID' } }] },
  });
  state.values.mockResolvedValue({ data: { values: [['test-order-id']] } });
  state.migrate.mockResolvedValue({ applied: false, matches: [], conflicts: [], nextRowIndex: 2 });
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function productionReport() {
  return JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as {
    ready: boolean;
    checks: { check: string; status: string }[];
  };
}

describe('Google credential-file support in operational scripts', () => {
  it('checks Sheets using the file helper without false missing-inline-credential findings', async () => {
    await import('../../scripts/check-production.js');
    expect(state.credentials).toHaveBeenCalledWith(
      expect.objectContaining({
        GOOGLE_APPLICATION_CREDENTIALS: state.env.GOOGLE_APPLICATION_CREDENTIALS,
      }),
    );
    expect(state.sheetOptions).toHaveBeenCalledWith(expect.objectContaining(credentials));
    const report = productionReport();
    expect(report.checks).toContainEqual(
      expect.objectContaining({ check: 'sheets', status: 'OK' }),
    );
    expect(
      report.checks.some((item) =>
        [
          'GOOGLE_SERVICE_ACCOUNT_EMAIL',
          'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
          'google-credentials',
        ].includes(item.check),
      ),
    ).toBe(false);
    expect(report.ready).toBe(false);
    expect(JSON.stringify(report)).not.toContain(credentials.privateKey);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports invalid credential files without external calls, secrets, or inline fallback', async () => {
    state.credentials.mockImplementation(() => {
      throw new Error('private key and path must not be printed');
    });
    await import('../../scripts/check-production.js');
    expect(productionReport().checks).toContainEqual(
      expect.objectContaining({ check: 'google-credentials', status: 'INVALID_CONFIGURATION' }),
    );
    expect(state.sheetOptions).not.toHaveBeenCalled();
    expect(JSON.stringify(productionReport())).not.toContain('private key and path');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['AI_PROVIDER', 'GOOGLE_SHEETS_PROVIDER'])(
    'reports fake production provider: %s',
    async (key) => {
      vi.stubEnv(key, 'demo');
      await import('../../scripts/check-production.js');
      expect(productionReport().checks).toContainEqual(
        expect.objectContaining({ check: 'runtime', status: 'INVALID_CONFIGURATION' }),
      );
    },
  );

  it('migrates with the shared credentials and keeps readonly Google scope', async () => {
    await import('../../scripts/migrate-sheets.js');
    expect(state.credentials).toHaveBeenCalledWith(state.env);
    expect(state.jwt).toHaveBeenCalledWith({
      email: credentials.serviceAccountEmail,
      key: credentials.privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    expect(state.migrate).toHaveBeenCalledWith(
      expect.objectContaining({ rows: [['test-order-id']], apply: false }),
    );
    expect(state.disconnect).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops migration safely before Google or database changes for bad credentials', async () => {
    state.credentials.mockImplementation(() => {
      throw new Error('private key must not be printed');
    });
    await import('../../scripts/migrate-sheets.js');
    expect(state.sheetsApi).not.toHaveBeenCalled();
    expect(state.migrate).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
    expect(state.disconnect).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({ error: 'SHEET_MIGRATION_FAILED' }));
  });
});
