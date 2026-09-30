import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '../../src/modules/payments/mock.provider.js';
const secret = 'staging-checkout-fixture-secret';
const attemptId = 'bce2ab94-e7d3-4b6a-bdc8-abc0c078bf09';
const options = {
  secret,
  appBaseUrl: 'https://staging.example',
  checkoutPath: '/mock-payment' as const,
};
afterEach(() => vi.useRealTimers());

describe('Staging mock checkout capabilities', () => {
  it('issues a per-attempt signed URL for 24h and preserves the existing demo route', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
    const payment = {
      orderId: 'order-id',
      publicOrderId: 'PUBLIC-1',
      attemptId,
      amount: 20000,
      currency: 'KZT' as const,
      description: 'Test',
    };
    const provider = new MockPaymentProvider(options);
    const created = await provider.createPayment(payment);
    const url = new URL(created.paymentUrl);
    expect(url.origin).toBe('https://staging.example');
    expect(url.pathname).toBe(`/mock-payment/${attemptId}`);
    expect(Number(url.searchParams.get('expires'))).toBe(Math.floor(Date.now() / 1000) + 86400);
    expect(
      provider.validateCheckoutToken(
        attemptId,
        url.searchParams.get('expires')!,
        url.searchParams.get('token')!,
      ),
    ).toBe(true);
    expect(
      (
        await new MockPaymentProvider({
          secret,
          appBaseUrl: 'http://localhost:3000',
        }).createPayment(payment)
      ).paymentUrl,
    ).toBe('http://localhost:3000/dev/mock-payment/order-id');
  });
  it('cannot move a capability to a different attempt, expiry, secret, or the callback namespace', () => {
    const provider = new MockPaymentProvider(options);
    const url = new URL(provider.checkoutUrl(attemptId));
    const expires = url.searchParams.get('expires')!;
    const token = url.searchParams.get('token')!;
    expect(provider.validateCheckoutToken('other-attempt', expires, token)).toBe(false);
    expect(provider.validateCheckoutToken(attemptId, String(Number(expires) + 1), token)).toBe(
      false,
    );
    expect(
      new MockPaymentProvider({
        ...options,
        secret: 'other-fixture-secret-value',
      }).validateCheckoutToken(attemptId, expires, token),
    ).toBe(false);
    const callbackHmac = createHmac('sha256', secret)
      .update(JSON.stringify({ attemptId, expires }))
      .digest('hex');
    expect(provider.validateCheckoutToken(attemptId, expires, callbackHmac)).toBe(false);
    expect(
      new MockPaymentProvider({ secret, appBaseUrl: options.appBaseUrl }).validateCheckoutToken(
        attemptId,
        expires,
        token,
      ),
    ).toBe(false);
  });
  it('rejects expired links, accepts valid links after provider restart, and has a strict expiry boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
    const url = new URL(new MockPaymentProvider(options).checkoutUrl(attemptId));
    const expires = url.searchParams.get('expires')!;
    const token = url.searchParams.get('token')!;
    const restarted = new MockPaymentProvider(options);
    vi.advanceTimersByTime(86400000 - 1000);
    expect(restarted.validateCheckoutToken(attemptId, expires, token)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(restarted.validateCheckoutToken(attemptId, expires, token)).toBe(false);
  });
  it.each([
    ['', ''],
    ['NaN', '0'.repeat(64)],
    ['99999999999999999', '0'.repeat(64)],
    ['1e12', '0'.repeat(64)],
    ['01000000000', '0'.repeat(64)],
    ['1234567890', 'invalid'],
  ])('rejects malformed query fields %#', (expires, token) => {
    expect(new MockPaymentProvider(options).validateCheckoutToken(attemptId, expires, token)).toBe(
      false,
    );
  });
  it('rejects unsafe route identifiers before signing', () => {
    const provider = new MockPaymentProvider(options);
    expect(() => provider.checkoutUrl('../other')).toThrow('valid attempt ID');
    expect(provider.validateCheckoutToken('../other', '1234567890', '0'.repeat(64))).toBe(false);
  });
});
