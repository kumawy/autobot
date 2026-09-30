import { createHash } from 'node:crypto';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FreedomPayProvider,
  freedomPaySignature,
  type FreedomPayParameters,
} from '../../src/modules/payments/freedompay.provider.js';
import { MockPaymentProvider } from '../../src/modules/payments/mock.provider.js';
import {
  exactDecimal,
  PaymentCreationUnknownError,
  PaymentCreationRejectedError,
} from '../../src/modules/payments/payment-provider.interface.js';
import type {
  CreatePaymentInput,
  PaymentWebhookInput,
} from '../../src/modules/payments/payment-provider.interface.js';

const secret = 'test-secret-only-for-fixtures';
const options = {
  merchantId: '999',
  secretKey: secret,
  baseUrl: 'https://api.freedompay.kz',
  appBaseUrl: 'https://shop.example',
  testMode: true,
};
const payment: CreatePaymentInput = {
  orderId: 'd617cfe6-c01b-47e6-941d-dc88c2f0b6b2',
  publicOrderId: 'MB-20261001-1042',
  attemptId: '312793f0-1412-4c2d-9061-faf0d06b7437',
  merchantReference: 'attempt_reference_312793f0',
  amount: 20_000,
  currency: 'KZT',
  description: 'Музыкальная шкатулка',
};
const callbackFields: Record<string, string> = {
  pg_order_id: payment.merchantReference!,
  pg_payment_id: '4567788',
  pg_amount: '20000.00',
  pg_currency: 'KZT',
  pg_result: '1',
  pg_captured: '1',
  pg_testing_mode: '1',
  pg_salt: 'unique-salt',
};

function signed(fields: FreedomPayParameters, script: string): FreedomPayParameters {
  return { ...fields, pg_sig: freedomPaySignature(script, fields, secret) };
}

function callback(fields: Record<string, string> = callbackFields): PaymentWebhookInput {
  const body = signed(fields, 'freedompay') as Record<string, string>;
  return {
    body,
    rawBody: new URLSearchParams(body).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

function xmlResponse(fields: FreedomPayParameters, script: string): Response {
  return new Response(
    new XMLBuilder({ format: true }).build({
      response: signed({ pg_status: 'ok', pg_salt: 'response-salt', ...fields }, script),
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/xml' },
    },
  );
}

function statusFields(overrides: FreedomPayParameters = {}): FreedomPayParameters {
  return {
    pg_payment_id: '4567788',
    pg_order_id: payment.merchantReference!,
    pg_amount: '20000',
    pg_currency: 'KZT',
    pg_payment_status: 'success',
    pg_captured: '1',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Freedom Pay signature and transport', () => {
  it('matches an independently calculated Merchant API vector and uses script basename', () => {
    const fields = {
      pg_order_id: '23',
      pg_merchant_id: '999',
      pg_amount: '25',
      pg_description: 'test',
      pg_salt: 'molbulak',
    };
    expect(
      freedomPaySignature(
        'https://api.freedompay.kz/init_payment.php?ignored=1',
        fields,
        'test-secret',
      ),
    ).toBe('d6ed3dffd433a81e074b94bced8064f7');
  });

  it('sorts nested fields while preserving repeated XML element order and signs unknown fields', () => {
    const fields = {
      z: 'last',
      items: [
        { z: 'B', a: 'A' },
        { z: 'D', a: 'C' },
      ],
      pg_salt: 'salt',
      pg_sig: 'excluded',
      custom: 'merchant-field',
    };
    const expected = createHash('md5')
      .update('status;merchant-field;A;B;C;D;salt;last;secret')
      .digest('hex');
    expect(freedomPaySignature('status', fields, 'secret')).toBe(expected);
    expect(freedomPaySignature('status', { ...fields, custom: 'changed' }, 'secret')).not.toBe(
      expected,
    );
  });

  it('creates only a hosted payment, authenticates the reply, and supplies a stable attempt key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      xmlResponse(
        {
          pg_payment_id: '4567788',
          pg_redirect_url: 'https://api.freedompay.kz/pay.html?a=1&b=2',
        },
        'init_payment.php',
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await new FreedomPayProvider(options).createPayment(payment);
    expect(result).toEqual({
      externalPaymentId: '4567788',
      paymentUrl: 'https://api.freedompay.kz/pay.html?a=1&b=2',
    });
    const [url, request] = fetchMock.mock.calls[0]! as [URL, RequestInit];
    expect(url.pathname).toBe('/init_payment.php');
    const fields = Object.fromEntries(request.body as FormData);
    expect(fields.pg_order_id).toBe(payment.merchantReference);
    expect(fields.pg_order_id).not.toBe(payment.orderId);
    expect(request.body).toBeInstanceOf(FormData);
    expect(fields.pg_idempotency_key).toBe(`init:${payment.attemptId}`);
    expect(fields.pg_result_url).toBe('https://shop.example/webhooks/payment/freedompay');
    expect(fields.pg_request_method).toBe('POST');
    expect(fields.pg_auto_clearing).toBe('1');
    expect(fields.pg_sig).toBe(
      freedomPaySignature('init_payment.php', fields as Record<string, string>, secret),
    );
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.redirect).toBe('error');
    expect(Object.keys(fields).some((key) => /card|cvv/i.test(key))).toBe(false);
  });

  it('rejects an unsigned provider reply even when its payment status is ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            '<response><pg_status>ok</pg_status><pg_payment_id>1</pg_payment_id><pg_redirect_url>https://example.com</pg_redirect_url></response>',
          ),
        ),
    );
    await expect(new FreedomPayProvider(options).createPayment(payment)).rejects.toBeInstanceOf(
      PaymentCreationUnknownError,
    );
  });

  it('rejects signed unsafe redirect URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          xmlResponse(
            { pg_payment_id: '4567788', pg_redirect_url: 'javascript:alert(1)' },
            'init_payment.php',
          ),
        ),
    );
    await expect(new FreedomPayProvider(options).createPayment(payment)).rejects.toBeInstanceOf(
      PaymentCreationUnknownError,
    );
  });

  it('rejects XML entity declarations before parsing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            '<!DOCTYPE response [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><response><pg_status>&xxe;</pg_status></response>',
          ),
        ),
    );
    await expect(new FreedomPayProvider(options).createPayment(payment)).rejects.toBeInstanceOf(
      PaymentCreationUnknownError,
    );
  });

  it('limits provider response size and propagates transport timeouts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(128 * 1024 + 1))));
    await expect(new FreedomPayProvider(options).createPayment(payment)).rejects.toBeInstanceOf(
      PaymentCreationUnknownError,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('Timed out', 'TimeoutError')),
    );
    await expect(new FreedomPayProvider(options).createPayment(payment)).rejects.toBeInstanceOf(
      PaymentCreationUnknownError,
    );
  });
});

describe('Freedom Pay callbacks and reconciliation', () => {
  it('returns a stable authenticated event and ignores a separately changed parsed body', async () => {
    const input = callback();
    input.body = { ...callbackFields, pg_amount: '1' };
    const event = await new FreedomPayProvider(options).verifyWebhook(input);
    expect(event).toMatchObject({
      eventId: 'freedompay:999:4567788:PAYMENT:PAID',
      externalPaymentId: '4567788',
      merchantReference: payment.merchantReference,
      amount: '20000',
      currency: 'KZT',
      status: 'PAID',
      provider: 'freedompay',
    });
    const repeated = callback({ ...callbackFields, pg_salt: 'new-retry-salt' });
    expect((await new FreedomPayProvider(options).verifyWebhook(repeated)).eventId).toBe(
      event.eventId,
    );
  });

  it('rejects tampered amounts and unknown extra fields without a matching signature', async () => {
    const altered = callback();
    altered.rawBody = altered.rawBody.replace('20000.00', '1.00');
    await expect(new FreedomPayProvider(options).verifyWebhook(altered)).rejects.toThrow(
      'signature',
    );
    const extra = callback();
    extra.rawBody += '&custom=unsigned';
    await expect(new FreedomPayProvider(options).verifyWebhook(extra)).rejects.toThrow('signature');
  });

  it('rejects duplicated critical form fields', async () => {
    const input = callback();
    input.rawBody += '&pg_amount=1';
    await expect(new FreedomPayProvider(options).verifyWebhook(input)).rejects.toThrow('Duplicate');
  });

  it.each([
    [{ pg_currency: 'USD' }, { currency: 'USD' }],
    [{ pg_amount: '20000.01' }, { amount: '20000.01' }],
    [{ pg_amount: '2e4' }, { amount: '2e4', verificationIssue: 'INVALID_PROVIDER_AMOUNT' }],
    [{ pg_result: 'true' }, { status: 'REVIEW_REQUIRED' }],
    [{ pg_testing_mode: '0' }, { verificationIssue: 'TEST_MODE_MISMATCH' }],
    [{ pg_merchant_id: 'another-merchant' }, { verificationIssue: 'MERCHANT_MISMATCH' }],
  ])('retains authentic anomalous data %o for durable review', async (overrides, expected) => {
    const event = await new FreedomPayProvider(options).verifyWebhook(
      callback({ ...callbackFields, ...overrides }),
    );
    expect(event).toMatchObject(expected);
  });

  it('keeps authorisations and unfinished transactions pending', async () => {
    const provider = new FreedomPayProvider(options);
    expect(
      (await provider.verifyWebhook(callback({ ...callbackFields, pg_captured: '0' }))).status,
    ).toBe('PENDING');
    expect(
      (await provider.verifyWebhook(callback({ ...callbackFields, pg_result: '2' }))).status,
    ).toBe('PENDING');
    expect(
      (await provider.verifyWebhook(callback({ ...callbackFields, pg_result: '0' }))).status,
    ).toBe('FAILED');
  });

  it('returns incomplete authenticated callbacks without HTTP so the inbox can be committed first', async () => {
    const { pg_currency: _, ...fields } = callbackFields;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const event = await new FreedomPayProvider(options).verifyWebhook(callback(fields));
    expect(event.currency).toBeUndefined();
    expect(event.needsReconciliation).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not require an invented order field from an authenticated status response', async () => {
    const { pg_order_id: _, ...withoutOrder } = statusFields();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(xmlResponse(withoutOrder, 'get_status3.php')));
    expect(await new FreedomPayProvider(options).getPaymentStatus('4567788')).toMatchObject({
      status: 'PAID',
      amount: '20000',
      currency: 'KZT',
    });
  });

  it('recovers creation by its unique reference without creating a second payment', async () => {
    const { pg_order_id: _, ...withoutOrder } = statusFields();
    const fetchMock = vi.fn().mockResolvedValue(xmlResponse(withoutOrder, 'get_status3.php'));
    vi.stubGlobal('fetch', fetchMock);
    const event = await new FreedomPayProvider(options).getPaymentStatusByReference(
      payment.merchantReference!,
    );
    expect(event.merchantReference).toBe(payment.merchantReference);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/get_status3.php');
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((request.body as FormData).get('pg_order_id')).toBe(payment.merchantReference);
    expect((request.body as FormData).get('pg_payment_id')).toBeNull();
  });

  it('fails status lookups closed when the authenticated transaction identity changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(xmlResponse(statusFields({ pg_payment_id: '123' }), 'get_status3.php')),
    );
    await expect(new FreedomPayProvider(options).getPaymentStatus('4567788')).rejects.toThrow(
      'ID mismatch',
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(xmlResponse(statusFields({ pg_order_id: 'other' }), 'get_status3.php')),
    );
    await expect(
      new FreedomPayProvider(options).getPaymentStatusByReference(payment.merchantReference!),
    ).rejects.toThrow('reference mismatch');
  });

  it('authenticates nested refund fields and does not fulfil refunded payments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        xmlResponse(
          statusFields({
            pg_refund_amount: '-20000',
            pg_refund_payments: {
              pg_refund_payment: [
                { pg_payment_id: '11', pg_amount: '-10000', pg_payment_status: 'success' },
                { pg_payment_id: '12', pg_amount: '-10000', pg_payment_status: 'success' },
              ],
            },
          }),
          'get_status3.php',
        ),
      ),
    );
    const event = await new FreedomPayProvider(options).getPaymentStatus('4567788');
    expect(event.status).toBe('PAID');
    expect(event.verificationIssue).toBe('REFUND_REQUIRES_REVIEW');
    expect(event.relatedEvents).toHaveLength(2);
    expect(event.relatedEvents?.[0]).toMatchObject({
      operation: 'REFUND',
      operationId: '11',
      status: 'REFUNDED',
      amount: '-10000',
    });
    expect(event.relatedEvents?.[0]?.eventId).not.toBe(event.relatedEvents?.[1]?.eventId);
  });

  it('acknowledges with correctly signed XML using the actual callback basename', () => {
    const provider = new FreedomPayProvider(options);
    for (const accepted of [true, false]) {
      const ack = provider.acknowledge({}, accepted);
      expect(ack.contentType).toContain('application/xml');
      const { response } = new XMLParser({ parseTagValue: false }).parse(ack.body) as {
        response: Record<string, string>;
      };
      expect(response.pg_status).toBe(accepted ? 'ok' : 'error');
      expect(response.pg_sig).toBe(freedomPaySignature('freedompay', response, secret));
    }
  });
});

describe('Mock payments', () => {
  it('creates stable pending payments and accepts only signed simulation payloads', async () => {
    const provider = new MockPaymentProvider({ secret, appBaseUrl: 'http://localhost:3000' });
    const created = await provider.createPayment(payment);
    expect(await provider.createPayment(payment)).toEqual(created);
    expect(created.paymentUrl).toBe(`http://localhost:3000/dev/mock-payment/${payment.orderId}`);
    expect((await provider.getPaymentStatus(created.externalPaymentId)).status).toBe('PENDING');
    const signedInput = provider.buildSignedPayload({
      externalPaymentId: created.externalPaymentId,
      orderId: payment.orderId,
      amount: 20000,
      currency: 'KZT',
      status: 'PAID',
    });
    expect((await provider.verifyWebhook(signedInput)).status).toBe('PAID');
    expect((await provider.getPaymentStatus(created.externalPaymentId)).status).toBe('PAID');
    await expect(
      provider.verifyWebhook({
        ...signedInput,
        rawBody: signedInput.rawBody.replace('20000', '1'),
      }),
    ).rejects.toThrow('signature');
    await expect(provider.verifyWebhook({ ...signedInput, headers: {} })).rejects.toThrow(
      'signature',
    );
  });

  it('rejects reused attempt IDs and invalid amounts', async () => {
    const provider = new MockPaymentProvider({ secret, appBaseUrl: 'http://localhost:3000' });
    await provider.createPayment(payment);
    await expect(provider.createPayment({ ...payment, orderId: 'another-order' })).rejects.toThrow(
      'reused',
    );
    await expect(provider.createPayment({ ...payment, amount: 1.5 })).rejects.toThrow('integer');
    await expect(provider.getPaymentStatus('not-created')).rejects.toThrow('Unknown');
  });
});

describe('Exact money and ambiguous provider outcomes', () => {
  it.each([
    ['00020000.00', '20000'],
    ['20000.01', '20000.01'],
    ['-10000.0100', '-10000.01'],
    ['-0.000', '0'],
    ['9007199254740993.01', '9007199254740993.01'],
  ])('preserves exact decimal %s', (input, expected) => expect(exactDecimal(input)).toBe(expected));
  it.each(['2e4', '20,000', ' 20000', 'NaN', 'Infinity', '', '+20000', '20000.0000000000001'])(
    'rejects ambiguous money %s',
    (value) => {
      expect(() => exactDecimal(value)).toThrow();
    },
  );
  it('does not accept binary floating point payment amounts', () => {
    expect(() => exactDecimal(20000.01)).toThrow();
    expect(() => exactDecimal(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
  it('distinguishes signed creation rejection from unknown timeout/invalid response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          xmlResponse({ pg_status: 'error', pg_error_code: '1' }, 'init_payment.php'),
        ),
    );
    await expect(new FreedomPayProvider(options).createPayment(payment)).rejects.toBeInstanceOf(
      PaymentCreationRejectedError,
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    await expect(new FreedomPayProvider(options).createPayment(payment)).rejects.toBeInstanceOf(
      PaymentCreationUnknownError,
    );
  });
  it('exposes Retry-After to reconciliation without treating API errors as payment failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '120' } })),
    );
    await expect(new FreedomPayProvider(options).getPaymentStatus('4567788')).rejects.toMatchObject(
      { code: 'PROVIDER_HTTP_ERROR', retryAfterMs: 120000 },
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          xmlResponse({ pg_status: 'error', pg_payment_status: 'success' }, 'get_status3.php'),
        ),
    );
    await expect(new FreedomPayProvider(options).getPaymentStatus('4567788')).rejects.toMatchObject(
      { code: 'STATUS_UNAVAILABLE' },
    );
  });
  it('does not treat API success, card authorization or unknown financial status as paid', async () => {
    for (const fields of [
      { pg_payment_status: 'mystery' },
      { pg_payment_status: 'success', pg_captured: '0' },
      { pg_payment_status: 'pending' },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            xmlResponse(statusFields(fields as FreedomPayParameters), 'get_status3.php'),
          ),
      );
      expect((await new FreedomPayProvider(options).getPaymentStatus('4567788')).status).not.toBe(
        'PAID',
      );
    }
  });
  it('retains a signed malformed result for the unknown-payment incident instead of losing it', async () => {
    const { pg_payment_id: _, ...fields } = callbackFields;
    const result = await new FreedomPayProvider(options).verifyWebhook(callback(fields));
    expect(result).toMatchObject({
      status: 'REVIEW_REQUIRED',
      verificationIssue: 'MALFORMED_SIGNED_RESULT',
    });
    expect(result.externalPaymentId).toMatch(/^unidentified:/);
  });
  it('rejects a callback signed for a different script even if proxy headers request that path', async () => {
    const body = signed(callbackFields, 'different.php') as Record<string, string>;
    await expect(
      new FreedomPayProvider(options).verifyWebhook({
        body,
        rawBody: new URLSearchParams(body).toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-uri': 'different.php',
        },
      }),
    ).rejects.toThrow('signature');
  });
});

describe('Freedom status request admission', () => {
  it('waits for the shared cadence gate before either signed status endpoint call', async () => {
    const beforeStatusRequest = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => {
      expect(beforeStatusRequest).toHaveBeenCalled();
      return xmlResponse(statusFields(), 'get_status3.php');
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new FreedomPayProvider({ ...options, beforeStatusRequest });
    await provider.getPaymentStatus('4567788');
    await provider.getPaymentStatusByReference(payment.merchantReference!);
    expect(beforeStatusRequest).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    beforeStatusRequest.mockRejectedValueOnce(new Error('cadence queue full'));
    await expect(provider.getPaymentStatus('4567788')).rejects.toThrow('cadence queue full');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('defers a callback without capture proof to a signed status query', async () => {
    const { pg_captured: _, ...fields } = callbackFields;
    const event = await new FreedomPayProvider(options).verifyWebhook(callback(fields));
    expect(event).toMatchObject({ status: 'REVIEW_REQUIRED', needsReconciliation: true });
  });
});
