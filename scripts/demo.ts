import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import { config } from 'dotenv';
const dbUrl = 'postgresql://musicbox:musicbox@127.0.0.1:55432/musicbox';
if (!existsSync('.env')) {
  const content = readFileSync('.env.example', 'utf8')
    .replace('local-change-this-token-before-deployment', randomBytes(32).toString('hex'))
    .replace('local-change-this-mock-secret-before-deployment', randomBytes(32).toString('hex'));
  writeFileSync('.env', content, { mode: 0o600 });
}
config({ quiet: true });
if (
  process.env.NODE_ENV === 'production' ||
  process.env.INTEGRATION_MODE !== 'demo' ||
  process.env.PAYMENT_PROVIDER !== 'mock'
)
  throw new Error('npm run demo requires development + demo + mock');
if (process.env.DATABASE_URL !== dbUrl)
  throw new Error(
    'npm run demo manages only local PostgreSQL on port 55432. Use npm run dev for your own database.',
  );
mkdirSync('.local', { recursive: true });
const pg = new EmbeddedPostgres({
  databaseDir: '.local/postgres',
  user: 'musicbox',
  password: 'musicbox',
  port: 55432,
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
  if (!existsSync('.local/postgres/PG_VERSION')) await pg.initialise();
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
