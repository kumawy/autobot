import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { config, parse } from 'dotenv';

const envFile = '.env.baileys.local';
const postgresPort = 55435;
const databaseDir = '.local/postgres-baileys';
const dbUrl = `postgresql://musicbox:musicbox@127.0.0.1:${postgresPort}/musicbox`;

if (!existsSync(envFile)) {
  const connected = existsSync('.env.connected.local')
    ? parse(readFileSync('.env.connected.local'))
    : {};
  const useOpenAI = Boolean(connected.OPENAI_API_KEY?.trim() && connected.OPENAI_MODEL?.trim());
  const overrides: Record<string, string> = {
    HOST: '127.0.0.1',
    WHATSAPP_BAILEYS_BUTTONS: 'true',
    PORT: '3002',
    APP_BASE_URL: 'http://localhost:3002',
    DATABASE_URL: dbUrl,
    DIRECT_URL: dbUrl,
    ADMIN_TOKEN: randomBytes(32).toString('hex'),
    MOCK_PAYMENT_SECRET: randomBytes(32).toString('hex'),
    WHATSAPP_AUTH_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    AI_PROVIDER: useOpenAI ? 'openai' : 'demo',
    OPENAI_API_KEY: useOpenAI ? connected.OPENAI_API_KEY! : '',
    OPENAI_MODEL: useOpenAI ? connected.OPENAI_MODEL! : '',
  };
  for (const key of ['BUSINESS_NAME', 'BUSINESS_PHONE', 'MANAGER_NAME', 'PRODUCT_PRICE_KZT'])
    if (connected[key]) overrides[key] = connected[key];
  let content = readFileSync('baileys.env.example', 'utf8').replace(
    /^#.*$/m,
    '# Private local WhatsApp profile. Keep this file and its encryption key for restarts.',
  );
  for (const [key, value] of Object.entries(overrides)) {
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    content = pattern.test(content)
      ? content.replace(pattern, () => line)
      : `${content}\n${line}\n`;
  }
  writeFileSync(envFile, content, { mode: 0o600, flag: 'wx' });
  console.log(
    `Создан ${envFile}. ${useOpenAI ? 'Используются настройки OpenAI из .env.connected.local.' : 'AI работает в demo; для OpenAI заполните ключ и модель в этом файле.'}`,
  );
}

process.env.DOTENV_CONFIG_PATH = envFile;
config({ path: envFile, quiet: true, override: true });
const { readEnv } = await import('../src/config/env.js');
const env = readEnv();
if (
  env.NODE_ENV !== 'development' ||
  env.INTEGRATION_MODE !== 'staging' ||
  env.WHATSAPP_TRANSPORT !== 'baileys' ||
  env.PAYMENT_PROVIDER !== 'mock' ||
  env.DEV_ROUTES_ENABLED ||
  env.HOST !== '127.0.0.1' ||
  env.APP_BASE_URL !== `http://localhost:${env.PORT}` ||
  env.DATABASE_URL !== dbUrl ||
  (env.DIRECT_URL && env.DIRECT_URL !== dbUrl)
)
  throw new Error(
    'whatsapp:local requires development + staging + Baileys + mock, HOST=127.0.0.1, APP_BASE_URL=http://localhost:PORT and its managed local database on port 55435. Use npm run dev for another configuration.',
  );

async function checkPort(port: number) {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () =>
      reject(new Error(`Порт ${port} уже занят. Остановите прежний локальный запуск.`)),
    );
    probe.listen(port, '127.0.0.1', () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
}
await checkPort(env.PORT);
await checkPort(postgresPort);
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
let child: ReturnType<typeof spawn> | undefined;
let started = false;
let shutdown: Promise<void> | undefined;
function cleanup(): Promise<void> {
  if (shutdown) return shutdown;
  shutdown = (async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    if (started) await pg.stop();
  })();
  return shutdown;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void cleanup().then(() => process.exit(0));
  });
async function run(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Command failed (${code})`)),
    );
  });
}
try {
  if (!existsSync(`${databaseDir}/PG_VERSION`)) await pg.initialise();
  await pg.start();
  started = true;
  const client = pg.getPgClient();
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = 'musicbox'");
    if (!exists.rowCount) await pg.createDatabase('musicbox');
  } finally {
    await client.end();
  }
  await run(['node_modules/prisma/build/index.js', 'generate']);
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  await run(['--import', 'tsx', 'scripts/seed.ts']);
  console.log(`Подключение WhatsApp: ${env.APP_BASE_URL}/whatsapp/connect`);
  console.log(`Ключ администратора: значение ADMIN_TOKEN в ${envFile} (не публикуйте его).`);
  console.log('Для остановки: Ctrl+C. Сессия и заказы сохраняются. Оплата тестовая.');
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    stdio: 'inherit',
    env: process.env,
  });
  child.once('error', (error) => {
    console.error('Не удалось запустить приложение:', error.message);
    void cleanup().then(() => process.exit(1));
  });
  child.once('exit', (code) => {
    if (!shutdown) void cleanup().then(() => process.exit(code ?? 1));
  });
} catch (error) {
  await cleanup();
  throw error;
}
