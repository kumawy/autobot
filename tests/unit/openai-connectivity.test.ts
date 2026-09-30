import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkOpenAiConnectivity } from '../../scripts/lib/openai-connectivity.js';

const sdk = vi.hoisted(() => ({ construct: vi.fn(), create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    constructor(options: unknown) {
      sdk.construct(options);
    }
    responses = { create: sdk.create };
  },
}));
const options = { nodeEnv: 'development', apiKey: 'test-only-key', model: 'configured-test-model' };
beforeEach(() => {
  sdk.construct.mockReset();
  sdk.create.mockReset();
});

describe('explicit OpenAI staging connectivity check, offline SDK', () => {
  it.each(['production', 'test', 'invalid'])(
    'blocks %s before constructing any client',
    async (nodeEnv) => {
      expect(await checkOpenAiConnectivity({ ...options, nodeEnv })).toEqual({
        ok: false,
        code: 'DEVELOPMENT_ONLY',
      });
      expect(sdk.construct).not.toHaveBeenCalled();
      expect(sdk.create).not.toHaveBeenCalled();
    },
  );
  it('handles missing key or model without starting a request', async () => {
    expect(await checkOpenAiConnectivity({ ...options, apiKey: ' ' })).toEqual({
      ok: false,
      code: 'OPENAI_API_KEY_MISSING',
    });
    expect(await checkOpenAiConnectivity({ ...options, model: '' })).toEqual({
      ok: false,
      code: 'OPENAI_MODEL_MISSING',
    });
    expect(sdk.construct).not.toHaveBeenCalled();
  });
  it('uses the configured model and exactly one bounded Responses request without customer context', async () => {
    sdk.create.mockResolvedValue({ status: 'completed', output_text: ' OK\n' });
    expect(await checkOpenAiConnectivity(options)).toEqual({ ok: true, text: 'OK' });
    expect(sdk.construct).toHaveBeenCalledWith({
      apiKey: options.apiKey,
      baseURL: 'https://api.openai.com/v1',
      timeout: 10000,
      maxRetries: 0,
      logLevel: 'off',
    });
    expect(sdk.create).toHaveBeenCalledExactlyOnceWith({
      model: options.model,
      input: 'Ответь одним словом: OK',
      max_output_tokens: 16,
      store: false,
    });
  });
  it.each([
    [{ status: 401 }, 'OPENAI_AUTHENTICATION_FAILED'],
    [{ status: 403 }, 'OPENAI_ACCESS_DENIED'],
    [{ status: 404 }, 'OPENAI_MODEL_NOT_FOUND'],
    [{ status: 429 }, 'OPENAI_RATE_LIMIT_OR_QUOTA'],
    [{ status: 503 }, 'OPENAI_SERVICE_UNAVAILABLE'],
    [{ name: 'APIConnectionTimeoutError' }, 'OPENAI_REQUEST_TIMEOUT'],
    [{ name: 'APIConnectionError' }, 'OPENAI_NETWORK_UNAVAILABLE'],
    [{ name: 'UnexpectedError' }, 'OPENAI_REQUEST_FAILED'],
  ])('returns only a controlled code for %o', async (properties, code) => {
    const error = Object.assign(
      new Error(`Request failed with secret ${options.apiKey}`),
      properties,
      { headers: { authorization: options.apiKey }, body: 'private request body' },
    );
    sdk.create.mockRejectedValue(error);
    const result = await checkOpenAiConnectivity(options);
    expect(result).toEqual({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain(options.apiKey);
    expect(JSON.stringify(result)).not.toContain('private request body');
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });
  it('handles incomplete and empty output without reporting a successful model reply', async () => {
    sdk.create
      .mockResolvedValueOnce({ status: 'incomplete', output_text: 'Partial' })
      .mockResolvedValueOnce({ status: 'completed', output_text: ' ' });
    expect(await checkOpenAiConnectivity(options)).toEqual({
      ok: false,
      code: 'OPENAI_RESPONSE_INCOMPLETE',
    });
    expect(await checkOpenAiConnectivity(options)).toEqual({
      ok: false,
      code: 'OPENAI_RESPONSE_EMPTY',
    });
  });
  it('never prints the configured key if an unexpected response echoes it', async () => {
    sdk.create.mockResolvedValue({
      status: 'completed',
      output_text: `Unexpected ${options.apiKey}`,
    });
    expect(await checkOpenAiConnectivity(options)).toEqual({
      ok: true,
      text: 'Unexpected [REDACTED]',
    });
  });
});

describe('connectivity CLI safe failure paths without network', () => {
  let directory: string;
  let path: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openai-check-'));
    path = join(directory, 'empty.env');
    await writeFile(path, '', { mode: 0o600 });
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const run = async (env: NodeJS.ProcessEnv) => {
    try {
      const result = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'scripts/test-openai.ts'],
        {
          env: {
            ...process.env,
            OPENAI_API_KEY: '',
            OPENAI_MODEL: '',
            NODE_ENV: 'development',
            DOTENV_CONFIG_PATH: path,
            ...env,
          },
          timeout: 10000,
        },
      );
      return { code: 0, ...result };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  };
  it('refuses production even with supplied credentials and prints no raw configuration', async () => {
    expect(
      await run({
        NODE_ENV: 'production',
        OPENAI_API_KEY: 'test-private-value',
        OPENAI_MODEL: 'test-model',
      }),
    ).toEqual({ code: 1, stdout: '', stderr: 'DEVELOPMENT_ONLY\n' });
  });
  it('reports a missing key without loading a real env file', async () => {
    expect(await run({})).toEqual({ code: 1, stdout: '', stderr: 'OPENAI_API_KEY_MISSING\n' });
  });
  it('fails closed when an explicitly selected env file does not exist', async () => {
    expect(await run({ DOTENV_CONFIG_PATH: join(directory, 'missing.env') })).toEqual({
      code: 1,
      stdout: '',
      stderr: 'OPENAI_ENV_FILE_UNAVAILABLE\n',
    });
  });
});
