import OpenAI from 'openai';

export type OpenAiCheckCode =
  | 'DEVELOPMENT_ONLY'
  | 'OPENAI_API_KEY_MISSING'
  | 'OPENAI_MODEL_MISSING'
  | 'OPENAI_AUTHENTICATION_FAILED'
  | 'OPENAI_ACCESS_DENIED'
  | 'OPENAI_MODEL_NOT_FOUND'
  | 'OPENAI_RATE_LIMIT_OR_QUOTA'
  | 'OPENAI_SERVICE_UNAVAILABLE'
  | 'OPENAI_REQUEST_TIMEOUT'
  | 'OPENAI_NETWORK_UNAVAILABLE'
  | 'OPENAI_RESPONSE_INCOMPLETE'
  | 'OPENAI_RESPONSE_EMPTY'
  | 'OPENAI_REQUEST_FAILED';

export type OpenAiCheckResult = { ok: true; text: string } | { ok: false; code: OpenAiCheckCode };

function errorCode(error: unknown): OpenAiCheckCode {
  if (!error || typeof error !== 'object') return 'OPENAI_REQUEST_FAILED';
  const failure = error as { status?: unknown; name?: unknown };
  if (failure.status === 401) return 'OPENAI_AUTHENTICATION_FAILED';
  if (failure.status === 403) return 'OPENAI_ACCESS_DENIED';
  if (failure.status === 404) return 'OPENAI_MODEL_NOT_FOUND';
  if (failure.status === 429) return 'OPENAI_RATE_LIMIT_OR_QUOTA';
  if (typeof failure.status === 'number' && failure.status >= 500)
    return 'OPENAI_SERVICE_UNAVAILABLE';
  if (['APIConnectionTimeoutError', 'TimeoutError', 'AbortError'].includes(String(failure.name)))
    return 'OPENAI_REQUEST_TIMEOUT';
  if (failure.name === 'APIConnectionError') return 'OPENAI_NETWORK_UNAVAILABLE';
  return 'OPENAI_REQUEST_FAILED';
}

/** Called only by the explicit staging command; tests replace the SDK and never use a live key. */
export async function checkOpenAiConnectivity(options: {
  nodeEnv?: string;
  apiKey?: string;
  model?: string;
}): Promise<OpenAiCheckResult> {
  if ((options.nodeEnv ?? 'development') !== 'development')
    return { ok: false, code: 'DEVELOPMENT_ONLY' };
  const apiKey = options.apiKey?.trim();
  const model = options.model?.trim();
  if (!apiKey) return { ok: false, code: 'OPENAI_API_KEY_MISSING' };
  if (!model) return { ok: false, code: 'OPENAI_MODEL_MISSING' };
  try {
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://api.openai.com/v1',
      timeout: 10000,
      maxRetries: 0,
      logLevel: 'off',
    });
    const response = await client.responses.create({
      model,
      input: 'Ответь одним словом: OK',
      max_output_tokens: 16,
      store: false,
    });
    if (response.status !== 'completed') return { ok: false, code: 'OPENAI_RESPONSE_INCOMPLETE' };
    const text = response.output_text.trim();
    if (!text) return { ok: false, code: 'OPENAI_RESPONSE_EMPTY' };
    // Never print the configured credential, even if an unexpected response echoes it.
    return { ok: true, text: text.replaceAll(apiKey, '[REDACTED]') };
  } catch (error) {
    // SDK messages, headers, request bodies and stacks can contain secrets. Print only a known code.
    return { ok: false, code: errorCode(error) };
  }
}
