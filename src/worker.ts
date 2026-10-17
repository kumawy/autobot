import { buildApp } from './app.js';
import { readEnv } from './config/env.js';
const env = readEnv();
if (env.WHATSAPP_TRANSPORT === 'baileys')
  throw new Error('Baileys runs app + worker together: use npm start, not a separate worker');
const runtime = await buildApp({ env, startWorker: false });
runtime.worker.start();
const keepAlive = setInterval(() => {}, 60000);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(
    signal,
    () =>
      void runtime.app.close().then(() => {
        clearInterval(keepAlive);
        process.exit(0);
      }),
  );
console.log('Outbox/inbox worker started');
