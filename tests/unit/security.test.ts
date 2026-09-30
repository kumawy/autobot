import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  errorCode,
  escapeHtml,
  safeCustomerText,
  safeEqual,
  verifyMetaSignature,
} from '../../src/utils/security.js';
import { readEnv } from '../../src/config/env.js';

describe('Meta signature verification', () => {
  const secret = 'test-meta-secret';
  const raw = '{ "object": "whatsapp_business_account", "entry": [] }';
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

  it('authenticates the exact raw bytes, not a reserialized JSON object', () => {
    expect(verifyMetaSignature(raw, signature, secret)).toBe(true);
    expect(verifyMetaSignature(JSON.stringify(JSON.parse(raw)), signature, secret)).toBe(false);
    expect(verifyMetaSignature(raw + '\n', signature, secret)).toBe(false);
  });

  it('rejects absent, malformed, wrong-key and wrong-size signatures', () => {
    expect(verifyMetaSignature(raw, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(raw, signature, '')).toBe(false);
    expect(verifyMetaSignature(raw, signature, 'wrong')).toBe(false);
    expect(verifyMetaSignature(raw, 'sha256=12', secret)).toBe(false);
    expect(safeEqual('expected', 'wrong-length')).toBe(false);
    expect(safeEqual('same', 'same')).toBe(true);
  });
});

describe('customer text and error privacy', () => {
  it.each([
    '4242 4242 4242 4242',
    'CVV: 123',
    'sms-код: 654321',
    'пароль: qwerty-secret',
    'пин-код: 1234',
  ])('does not persist payment credentials: %s', (text) => {
    expect(safeCustomerText(text)).toBe('[PAYMENT_CREDENTIALS_REDACTED]');
  });
  it('retains legitimate recipient phones and ordinary product questions', () => {
    expect(safeCustomerText('+77001234567')).toBe('+77001234567');
    expect(safeCustomerText('Сколько стоит шкатулка?')).toBe('Сколько стоит шкатулка?');
  });
  it('removes control characters and bounds persisted text', () => {
    expect(safeCustomerText('Имя\u0000\u0007\nГород')).toBe('Имя\nГород');
    expect(safeCustomerText('a'.repeat(5000))).toHaveLength(4000);
  });
  it('does not include exception details in persisted error codes', () => {
    expect(errorCode(new Error('secret token and customer phone'))).toBe('Error');
    expect(errorCode({ message: 'secret' })).toBe('ExternalServiceError');
    expect(escapeHtml('<script a="x">&\'')).toBe('&lt;script a=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('environment startup guards', () => {
  const base = {
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
    ADMIN_TOKEN: 'test-admin-token-with-long-random-value',
    MOCK_PAYMENT_SECRET: 'test-mock-secret-with-long-random-value',
  };
  it('runs offline by default but disallows demo integrations in production', () => {
    expect(readEnv(base).INTEGRATION_MODE).toBe('demo');
    expect(() => readEnv({ ...base, NODE_ENV: 'production' })).toThrow('Production requires live');
  });
  it('fails closed for missing live credentials and malformed flags', () => {
    expect(() => readEnv({ ...base, INTEGRATION_MODE: 'live' })).toThrow('Missing');
    expect(() => readEnv({ ...base, PROCESS_FIRST_MESSAGE_AFTER_LANGUAGE: 'yes' })).toThrow();
    expect(() => readEnv({ ...base, PAYMENT_PROVIDER: 'freedompay' })).toThrow(
      'credentials required',
    );
  });
});
