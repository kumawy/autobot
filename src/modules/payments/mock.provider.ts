import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  PaymentProviderError,
  exactDecimal,
  validatePaymentInput,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type PaymentAcknowledgement,
  type PaymentProvider,
  type PaymentWebhookInput,
  type VerifiedPaymentEvent,
} from './payment-provider.interface.js';

const eventSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    externalPaymentId: z.string().min(1).max(200),
    orderId: z.string().min(1).max(50).optional(),
    merchantId: z.string().min(1).max(100).optional(),
    merchantReference: z.string().min(1).max(50).optional(),
    operation: z.enum(['PAYMENT', 'REFUND', 'REVERSAL']).optional(),
    operationId: z.string().optional(),
    providerStatus: z.string().optional(),
    amount: z.union([z.number().int().safe(), z.string().max(64)]).optional(),
    currency: z.string().min(1).max(10).optional(),
    status: z.enum([
      'PAID',
      'FAILED',
      'PENDING',
      'CANCELLED',
      'EXPIRED',
      'REFUNDED',
      'REVIEW_REQUIRED',
    ]),
    provider: z.literal('mock'),
  })
  .strict();

export interface MockPaymentOptions {
  secret: string;
  appBaseUrl: string;
  checkoutPath?: '/dev/mock-payment' | '/mock-payment';
}

export type MockPaymentPayloadInput = Omit<VerifiedPaymentEvent, 'provider' | 'eventId'> & {
  eventId?: string;
};

/** For local demo and isolated staging only. Runtime configuration must forbid production. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly merchantId = 'demo';
  private readonly payments = new Map<string, VerifiedPaymentEvent>();
  private readonly options: MockPaymentOptions;

  constructor(options: MockPaymentOptions) {
    if (options.secret.length < 16)
      throw new PaymentProviderError('Mock payment secret must contain at least 16 characters');
    this.options = options;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    validatePaymentInput(input);
    const externalPaymentId = `mock_${input.attemptId}`;
    const existing = this.payments.get(externalPaymentId);
    if (
      existing &&
      (existing.orderId !== input.orderId ||
        existing.amount === undefined ||
        exactDecimal(existing.amount) !== exactDecimal(input.amount))
    ) {
      throw new PaymentProviderError('Mock payment idempotency key was reused for another order');
    }
    if (!existing) {
      this.payments.set(externalPaymentId, {
        eventId: `mock:${externalPaymentId}:PENDING`,
        externalPaymentId,
        orderId: input.orderId,
        merchantId: this.merchantId,
        merchantReference: input.merchantReference ?? input.attemptId,
        amount: input.amount,
        currency: input.currency,
        status: 'PENDING',
        provider: this.name,
      });
    }
    return {
      externalPaymentId,
      paymentUrl:
        this.options.checkoutPath === '/mock-payment'
          ? this.checkoutUrl(input.attemptId)
          : new URL(
              `/dev/mock-payment/${encodeURIComponent(input.orderId)}`,
              this.options.appBaseUrl,
            ).toString(),
    };
  }

  /** A time-limited capability for the staging checkout page; independent of callback signatures. */
  checkoutUrl(attemptId: string): string {
    if (
      this.options.checkoutPath !== '/mock-payment' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(attemptId)
    ) {
      throw new PaymentProviderError(
        'Signed mock checkout requires a staging route and valid attempt ID',
      );
    }
    const expires = String(Math.floor(Date.now() / 1000) + 86400);
    const url = new URL(`/mock-payment/${encodeURIComponent(attemptId)}`, this.options.appBaseUrl);
    url.searchParams.set('expires', expires);
    url.searchParams.set('token', this.checkoutToken(attemptId, expires));
    return url.toString();
  }

  validateCheckoutToken(attemptId: string, expires: string, token: string): boolean {
    if (
      this.options.checkoutPath !== '/mock-payment' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(attemptId) ||
      !/^[1-9]\d{0,11}$/.test(expires) ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      return false;
    const expiration = Number(expires);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expiration) || expiration <= now || expiration > now + 86460)
      return false;
    return timingSafeEqual(
      Buffer.from(token, 'hex'),
      Buffer.from(this.checkoutToken(attemptId, expires), 'hex'),
    );
  }

  private checkoutToken(attemptId: string, expires: string): string {
    return createHmac('sha256', this.options.secret)
      .update(JSON.stringify(['musicbox:mock-checkout:v1', attemptId, expires]))
      .digest('hex');
  }

  buildSignedPayload(input: MockPaymentPayloadInput): PaymentWebhookInput {
    const body = eventSchema.parse({
      ...this.payments.get(input.externalPaymentId),
      merchantId: this.merchantId,
      ...input,
      provider: this.name,
      eventId:
        input.eventId ??
        `mock:${this.merchantId}:${input.externalPaymentId}:${input.operation ?? 'PAYMENT'}:${input.operationId ?? 'capture'}:${input.status}`,
    });
    const rawBody = JSON.stringify(body);
    const signature = createHmac('sha256', this.options.secret).update(rawBody).digest('hex');
    return {
      body,
      rawBody,
      headers: { 'content-type': 'application/json', 'x-mock-signature': signature },
    };
  }

  async verifyWebhook(input: PaymentWebhookInput): Promise<VerifiedPaymentEvent> {
    const signature = input.headers['x-mock-signature'];
    if (
      typeof signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      Buffer.byteLength(input.rawBody) > 8192
    ) {
      throw new PaymentProviderError('Invalid mock payment signature');
    }
    const expected = createHmac('sha256', this.options.secret).update(input.rawBody).digest();
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected))
      throw new PaymentProviderError('Invalid mock payment signature');
    // Use the authenticated bytes, never a separately parsed mutable body.
    const event = eventSchema.parse(JSON.parse(input.rawBody));
    this.payments.set(event.externalPaymentId, event);
    return event;
  }

  async getPaymentStatus(externalPaymentId: string): Promise<VerifiedPaymentEvent> {
    const event = this.payments.get(externalPaymentId);
    if (!event)
      throw new PaymentProviderError(
        'Unknown mock payment; use persisted order state after restart',
        'STATUS_UNAVAILABLE',
      );
    return { ...event };
  }

  async getPaymentStatusByReference(merchantReference: string): Promise<VerifiedPaymentEvent> {
    const event = [...this.payments.values()].find(
      (item) => item.merchantReference === merchantReference,
    );
    if (!event)
      throw new PaymentProviderError('Unknown mock merchant reference', 'STATUS_UNAVAILABLE');
    return { ...event };
  }

  acknowledge(_input: unknown, accepted: boolean): PaymentAcknowledgement {
    return { contentType: 'application/json; charset=utf-8', body: JSON.stringify({ accepted }) };
  }
}
