import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import { config } from 'dotenv';
const connected = process.argv.includes('--connected');
const envFile = connected ? '.env.connected.local' : '.env';
const postgresPort = connected ? 55433 : 55432;
const databaseDir = connected ? '.local/postgres-connected' : '.local/postgres';
const dbUrl = `postgresql://musicbox:musicbox@127.0.0.1:${postgresPort}/musicbox`;
if (!existsSync(envFile)) {
  let content = readFileSync('.env.example', 'utf8')
    .replace('local-change-this-token-before-deployment', randomBytes(32).toString('hex'))
    .replace('local-change-this-mock-secret-before-deployment', randomBytes(32).toString('hex'));
  if (connected) {
    const overrides: Record<string, string> = {
      PORT: '3001',
      APP_BASE_URL: 'http://localhost:3001',
      DATABASE_URL: dbUrl,
      AI_PROVIDER: 'openai',
      OPENAI_MODEL: 'gpt-4.1-mini',
      GOOGLE_SHEETS_PROVIDER: 'google',
      GOOGLE_SHEETS_ENABLED: 'false',
      TELEGRAM_ENABLED: 'false',
      MANAGER_HANDOFF_ENABLED: 'false',
      BUSINESS_NAME: 'Sandargift',
    };
    for (const [key, value] of Object.entries(overrides)) {
      const pattern = new RegExp(`^${key}=.*$`, 'm');
      content = pattern.test(content)
        ? content.replace(pattern, `${key}=${value}`)
        : `${content}\n${key}=${value}\n`;
    }
  }
  writeFileSync(envFile, content, { mode: 0o600 });
}
process.env.DOTENV_CONFIG_PATH = envFile;
config({ path: envFile, quiet: true });
if (
  process.env.NODE_ENV === 'production' ||
  process.env.INTEGRATION_MODE !== 'demo' ||
  process.env.PAYMENT_PROVIDER !== 'mock'
)
  throw new Error('npm run demo requires development + demo + mock');
if (process.env.DATABASE_URL !== dbUrl)
  throw new Error(
    `This demo manages only local PostgreSQL on port ${postgresPort}. Use npm run dev for your own database.`,
  );
if (connected && (process.env.AI_PROVIDER !== 'openai' || !process.env.OPENAI_API_KEY?.trim()))
  throw new Error(
    'Set OPENAI_API_KEY in .env.connected.local, then run npm run demo:connected again.',
  );
// Validate all selected integrations before starting PostgreSQL or writing demo data.
const { readEnv } = await import('../src/config/env.js');
readEnv();
mkdirSync('.local', { recursive: true });
const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'musicbox',
  password: 'musicbox',
  port: postgresPort,
  persistent: true,
  authMethod: 'scram-sha-256',
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: () => {},
  onError: () => {},
});
let server: ReturnType<typeof spawn> | undefined;
let worker: ReturnType<typeof spawn> | undefined;
let shutdown: Promise<void> | undefined;
function cleanup(): Promise<void> {
  if (shutdown) return shutdown;
  shutdown = (async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((resolve) => server!.once('exit', () => resolve()));
      server.kill('SIGTERM');
      await exited;
    }
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = new Promise<void>((resolve) => worker!.once('exit', () => resolve()));
      worker.kill('SIGTERM');
      await exited;
    }
    await pg.stop();
  })();
  return shutdown;
}
async function run(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, DIRECT_URL: dbUrl },
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Command failed (${code})`)),
    );
  });
}
try {
  if (!existsSync(`${databaseDir}/PG_VERSION`)) await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = 'musicbox'");
  await client.end();
  if (!exists.rowCount) await pg.createDatabase('musicbox');
  await run(['node_modules/prisma/build/index.js', 'generate']);
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  await run(['--import', 'tsx', 'scripts/seed.ts']);
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    stdio: 'inherit',
    env: process.env,
  });
  worker = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    stdio: 'inherit',
    env: process.env,
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void cleanup().then(() => process.exit(0));
    });
  server.on('exit', (code) => {
    if (!shutdown) void cleanup().then(() => process.exit(code ?? 0));
  });
} catch (error) {
  await cleanup();
  throw error;
}
