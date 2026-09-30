import { config } from 'dotenv';
import { checkOpenAiConnectivity } from './lib/openai-connectivity.js';

// This standalone command does not load application config or start the server/worker.
const explicitPath = process.env.DOTENV_CONFIG_PATH;
const loaded = config({ path: explicitPath ?? '.env', quiet: true });
if (explicitPath && loaded.error) {
  process.stderr.write('OPENAI_ENV_FILE_UNAVAILABLE\n');
  process.exitCode = 1;
} else {
  const result = await checkOpenAiConnectivity({
    nodeEnv: process.env.NODE_ENV,
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  });
  if (result.ok) process.stdout.write(`${result.text}\n`);
  else {
    process.stderr.write(`${result.code}\n`);
    process.exitCode = 1;
  }
}
