/** A remote send may have succeeded even when no usable acknowledgement returned. */
export class DeliveryError extends Error {
  readonly outcome: 'REJECTED' | 'UNKNOWN';
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly code: string;
  constructor(
    code: string,
    options: { outcome: 'REJECTED' | 'UNKNOWN'; retryable?: boolean; retryAfterMs?: number },
  ) {
    super(code);
    this.name = 'DeliveryError';
    this.code = code;
    this.outcome = options.outcome;
    this.retryable = options.outcome === 'REJECTED' && options.retryable === true;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 86_400_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - now, 0), 86_400_000) : undefined;
}
