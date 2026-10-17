import { buildApp } from './app.js';
import { readEnv } from './config/env.js';
const config = readEnv();
const { app, env } = await buildApp({
  env: config,
  startWorker: config.WHATSAPP_TRANSPORT === 'baileys',
  startWhatsApp: config.WHATSAPP_TRANSPORT === 'baileys',
});
await app.listen({ host: env.HOST, port: env.PORT });
console.log(`Music Box: ${env.APP_BASE_URL} (${env.INTEGRATION_MODE})`);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
