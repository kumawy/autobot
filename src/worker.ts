import { buildApp } from './app.js';
const runtime = await buildApp({ startWorker: false });
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
