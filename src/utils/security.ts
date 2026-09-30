import { createHmac, timingSafeEqual } from 'node:crypto';
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function verifyMetaSignature(
  raw: string,
  signature: string | undefined,
  secret: string,
): boolean {
  return Boolean(
    secret &&
    signature &&
    safeEqual(signature, `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`),
  );
}
// Do not persist obvious card numbers or credentials pasted into a chat.
export function safeCustomerText(value: string): string {
  if (
    /\b(?:\d[ -]?){13,19}\b/.test(value) ||
    /(?:cvv|cvc|pin|пин|otp|sms|смс|парол|password|құпиясөз)/iu.test(value)
  )
    return '[PAYMENT_CREDENTIALS_REDACTED]';
  // eslint-disable-next-line no-control-regex -- intentional removal of control bytes
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 4000);
}
export function errorCode(error: unknown): string {
  return error instanceof Error ? error.name : 'ExternalServiceError';
}
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
