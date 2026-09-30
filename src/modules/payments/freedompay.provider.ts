import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  PaymentProviderError,
  PaymentCreationUnknownError,
  PaymentCreationRejectedError,
  exactDecimal,
  validatePaymentInput,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type PaymentAcknowledgement,
  type PaymentEventStatus,
  type PaymentProvider,
  type PaymentWebhookInput,
  type VerifiedPaymentEvent,
} from './payment-provider.interface.js';

type Parameter = string | number | boolean | Parameter[] | { [key: string]: Parameter };
export type FreedomPayParameters = Record<string, Parameter>;

export interface FreedomPayOptions {
  merchantId: string;
  secretKey: string;
  baseUrl: string;
  appBaseUrl: string;
  testMode?: boolean;
  timeoutMs?: number;
  beforeStatusRequest?: () => Promise<void>;
}

const MAX_RESPONSE_BYTES = 128 * 1024;
const CALLBACK_PATH = '/webhooks/payment/freedompay';
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateTree(value: unknown, depth = 0): asserts value is Parameter {
  if (depth > 16) throw new PaymentProviderError('Payment payload is too deeply nested');
  if (typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) validateTree(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (
        BLOCKED_KEYS.has(key) ||
        key.startsWith('@_') ||
        key.startsWith('#') ||
        key.startsWith('?')
      ) {
        throw new PaymentProviderError('Unsupported payment payload field');
      }
      validateTree(item, depth + 1);
    }
    return;
  }
  throw new PaymentProviderError('Invalid payment payload value');
}

/** Every field is signed, including unknown fields. Equal XML tags retain their order. */
function signatureValues(value: Parameter): string[] {
  if (Array.isArray(value)) return value.flatMap(signatureValues);
  if (typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .flatMap((key) => signatureValues(value[key]!));
  }
  return [typeof value === 'boolean' ? (value ? '1' : '') : String(value)];
}

export function freedomPaySignature(
  scriptOrUrl: string,
  parameters: FreedomPayParameters,
  secretKey: string,
): string {
  validateTree(parameters);
  const script = scriptOrUrl.split('?')[0]!.split('/').pop();
  if (!script) throw new PaymentProviderError('Payment signature requires a script basename');
  const signed = Object.fromEntries(Object.entries(parameters).filter(([key]) => key !== 'pg_sig'));
  return createHash('md5')
    .update([script, ...signatureValues(signed), secretKey].join(';'))
    .digest('hex');
}

function scalar(
  parameters: FreedomPayParameters,
  key: string,
  required = true,
): string | undefined {
  const value = parameters[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && value.length === 0)) {
    throw new PaymentProviderError(`Invalid or missing ${key}`);
  }
  return value;
}

function requiredScalar(parameters: FreedomPayParameters, key: string): string {
  return scalar(parameters, key)!;
}

function parseXml(xml: string): FreedomPayParameters {
  if (Buffer.byteLength(xml) > MAX_RESPONSE_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new PaymentProviderError('Unsafe payment XML');
  }
  if (XMLValidator.validate(xml) !== true) throw new PaymentProviderError('Invalid payment XML');
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    ignoreDeclaration: true,
  }).parse(xml);
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1) {
    throw new PaymentProviderError('Invalid payment XML root');
  }
  const root: unknown = parsed.response ?? parsed.request;
  if (!isRecord(root)) throw new PaymentProviderError('Invalid payment XML root');
  // Preserve text inside leaf tags for signatures, but ignore indentation between tags.
  const removeIndentation = (value: unknown, depth = 0): void => {
    if (depth > 16) throw new PaymentProviderError('Payment payload is too deeply nested');
    if (Array.isArray(value)) {
      value.forEach((item) => removeIndentation(item, depth + 1));
    } else if (isRecord(value)) {
      if (typeof value['#text'] === 'string' && /^\s*$/.test(value['#text'])) delete value['#text'];
      Object.values(value).forEach((item) => removeIndentation(item, depth + 1));
    }
  };
  removeIndentation(root);
  validateTree(root);
  return root as FreedomPayParameters;
}

function parseWebhook(input: PaymentWebhookInput): FreedomPayParameters {
  if (Buffer.byteLength(input.rawBody) > MAX_RESPONSE_BYTES) {
    throw new PaymentProviderError('Payment callback is too large');
  }
  const contentType = input.headers['content-type'];
  if (Array.isArray(contentType)) throw new PaymentProviderError('Ambiguous payment content type');
  if (input.rawBody.trimStart().startsWith('<')) return parseXml(input.rawBody);
  if (contentType?.includes('application/x-www-form-urlencoded') && input.rawBody) {
    const fields: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of new URLSearchParams(input.rawBody)) {
      if (Object.hasOwn(fields, key))
        throw new PaymentProviderError('Duplicate payment callback field');
      fields[key] = value;
    }
    // XML transport is encoded as a single pg_xml form field.
    if (Object.keys(fields).length === 1 && fields.pg_xml) return parseXml(fields.pg_xml);
    validateTree(fields);
    return fields;
  }
  if (!isRecord(input.body)) throw new PaymentProviderError('Invalid payment callback');
  validateTree(input.body);
  return input.body as FreedomPayParameters;
}

function eventStatus(parameters: FreedomPayParameters, webhook: boolean): PaymentEventStatus {
  const value = scalar(parameters, webhook ? 'pg_result' : 'pg_payment_status', false);
  let status: PaymentEventStatus;
  if (webhook) {
    status =
      value === '1'
        ? 'PAID'
        : value === '0'
          ? 'FAILED'
          : value === '2'
            ? 'PENDING'
            : 'REVIEW_REQUIRED';
  } else {
    const statuses: Record<string, PaymentEventStatus> = {
      success: 'PAID',
      ok: 'PAID',
      failed: 'FAILED',
      error: 'FAILED',
      failure: 'FAILED',
      cancelled: 'CANCELLED',
      canceled: 'CANCELLED',
      partial: 'PENDING',
      pending: 'PENDING',
      process: 'PENDING',
      incomplete: 'EXPIRED',
      new: 'PENDING',
      refunded: 'REFUNDED',
      revoked: 'REFUNDED',
    };
    status = statuses[value ?? ''] ?? 'REVIEW_REQUIRED';
  }
  const captured = scalar(parameters, 'pg_captured', false);
  if (captured !== undefined && captured !== '0' && captured !== '1') return 'REVIEW_REQUIRED';
  if (status === 'PAID' && captured === '0') return 'PENDING';
  if (webhook && status === 'PAID' && captured === undefined) return 'REVIEW_REQUIRED';
  // Only the configured one-step flow is supported; card success without capture proof is uncertain.
  if (
    status === 'PAID' &&
    scalar(parameters, 'pg_payment_method', false) === 'bankcard' &&
    captured !== '1'
  )
    return 'REVIEW_REQUIRED';
  return status;
}

export class FreedomPayProvider implements PaymentProvider {
  readonly name = 'freedompay';
  readonly merchantId: string;
  private readonly options: Required<FreedomPayOptions>;
  private readonly callbackUrl: URL;

  constructor(options: FreedomPayOptions) {
    if (!options.merchantId || !options.secretKey)
      throw new PaymentProviderError('Freedom Pay credentials are required');
    const base = new URL(options.baseUrl);
    const app = new URL(options.appBaseUrl);
    if (
      base.protocol !== 'https:' ||
      app.protocol !== 'https:' ||
      base.username ||
      base.password ||
      app.username ||
      app.password
    ) {
      throw new PaymentProviderError(
        'Freedom Pay requires HTTPS URLs without embedded credentials',
      );
    }
    this.merchantId = options.merchantId;
    this.options = {
      ...options,
      testMode: options.testMode ?? true,
      timeoutMs: options.timeoutMs ?? 10_000,
      beforeStatusRequest: options.beforeStatusRequest ?? (async () => {}),
    };
    this.callbackUrl = new URL(CALLBACK_PATH, options.appBaseUrl);
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    validatePaymentInput(input);
    const parameters: Record<string, string> = {
      pg_order_id: input.merchantReference ?? input.attemptId,
      pg_merchant_id: this.merchantId,
      pg_amount: String(input.amount),
      pg_currency: input.currency,
      pg_description: input.description,
      pg_idempotency_key: `init:${input.attemptId}`,
      pg_result_url: this.callbackUrl.toString(),
      pg_check_url: '',
      pg_request_method: 'POST',
      pg_success_url: new URL('/payment/success', this.options.appBaseUrl).toString(),
      pg_failure_url: new URL('/payment/failure', this.options.appBaseUrl).toString(),
      pg_success_url_method: 'GET',
      pg_failure_url_method: 'GET',
      pg_testing_mode: this.options.testMode ? '1' : '0',
      pg_auto_clearing: '1',
      pg_salt: randomBytes(16).toString('hex'),
      merchant_attempt_id: input.attemptId,
    };
    try {
      const result = await this.request('init_payment.php', parameters);
      const externalPaymentId = this.paymentId(result);
      const paymentUrl = requiredScalar(result, 'pg_redirect_url');
      const redirect = new URL(paymentUrl);
      if (redirect.protocol !== 'https:' || redirect.username || redirect.password)
        throw new PaymentProviderError('Provider returned an unsafe payment URL');
      return { externalPaymentId, paymentUrl };
    } catch (error) {
      if (error instanceof PaymentCreationRejectedError) throw error;
      throw new PaymentCreationUnknownError();
    }
  }

  async verifyWebhook(input: PaymentWebhookInput): Promise<VerifiedPaymentEvent> {
    const parameters = parseWebhook(input);
    if (Object.keys(parameters).length > 100)
      throw new PaymentProviderError('Too many payment callback fields');
    this.verifySignature(this.callbackUrl.pathname, parameters);
    try {
      return this.toEvent(parameters, true);
    } catch {
      // Authentic but malformed business fields are a durable unknown-payment incident.
      const stable = Object.fromEntries(
        Object.entries(parameters)
          .filter(([key]) => !['pg_sig', 'pg_salt'].includes(key))
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      const identity = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
      return {
        eventId: `freedompay:${this.merchantId}:malformed:${identity}`,
        externalPaymentId:
          typeof parameters.pg_payment_id === 'string' && parameters.pg_payment_id.length > 0
            ? parameters.pg_payment_id
            : `unidentified:${identity}`,
        provider: this.name,
        merchantId: this.merchantId,
        status: 'REVIEW_REQUIRED',
        operation: 'PAYMENT',
        verificationIssue: 'MALFORMED_SIGNED_RESULT',
        ...(typeof parameters.pg_order_id === 'string'
          ? { merchantReference: parameters.pg_order_id }
          : {}),
        ...(typeof parameters.pg_amount === 'string' ? { amount: parameters.pg_amount } : {}),
        ...(typeof parameters.pg_currency === 'string' ? { currency: parameters.pg_currency } : {}),
      };
    }
  }

  async getPaymentStatus(externalPaymentId: string): Promise<VerifiedPaymentEvent> {
    if (!/^[1-9]\d*$/.test(externalPaymentId)) throw new PaymentProviderError('Invalid payment ID');
    await this.options.beforeStatusRequest();
    const parameters = await this.request('get_status3.php', {
      pg_merchant_id: this.merchantId,
      pg_payment_id: externalPaymentId,
      pg_salt: randomBytes(16).toString('hex'),
    });
    if (this.paymentId(parameters) !== externalPaymentId)
      throw new PaymentProviderError('Provider payment ID mismatch');
    return this.toEvent(parameters, false);
  }

  async getPaymentStatusByReference(merchantReference: string): Promise<VerifiedPaymentEvent> {
    if (!/^[A-Za-z0-9:_-]{1,50}$/.test(merchantReference))
      throw new PaymentProviderError('Invalid merchant reference');
    await this.options.beforeStatusRequest();
    const parameters = await this.request('get_status3.php', {
      pg_merchant_id: this.merchantId,
      pg_order_id: merchantReference,
      pg_salt: randomBytes(16).toString('hex'),
    });
    const returnedReference = scalar(parameters, 'pg_order_id', false);
    if (returnedReference && returnedReference !== merchantReference)
      throw new PaymentProviderError('Provider reference mismatch');
    // The authenticated status response belongs to this signed reference query even if not echoed.
    return { ...this.toEvent(parameters, false), merchantReference };
  }

  acknowledge(_input: unknown, accepted: boolean): PaymentAcknowledgement {
    const response: Record<string, string> = {
      pg_status: accepted ? 'ok' : 'error',
      pg_description: accepted ? 'Notification accepted' : 'Notification could not be processed',
      pg_salt: randomBytes(16).toString('hex'),
    };
    response.pg_sig = freedomPaySignature(
      this.callbackUrl.pathname,
      response,
      this.options.secretKey,
    );
    return {
      contentType: 'application/xml; charset=utf-8',
      statusCode: accepted ? 200 : 503,
      body: '<?xml version="1.0" encoding="UTF-8"?>' + new XMLBuilder().build({ response }),
    };
  }

  private toEvent(parameters: FreedomPayParameters, webhook: boolean): VerifiedPaymentEvent {
    const externalPaymentId = this.paymentId(parameters);
    const merchantId = scalar(parameters, 'pg_merchant_id', false) ?? this.merchantId;
    const merchantReference = scalar(parameters, 'pg_order_id', false);
    const rawAmount = scalar(parameters, 'pg_amount', false);
    let amount: string | undefined = rawAmount;
    let verificationIssue: string | undefined;
    if (rawAmount !== undefined) {
      try {
        amount = exactDecimal(rawAmount);
      } catch {
        verificationIssue = 'INVALID_PROVIDER_AMOUNT';
      }
    }
    const currency = scalar(parameters, 'pg_currency', false);
    const testing = scalar(parameters, 'pg_testing_mode', false);
    if (merchantId !== this.merchantId) verificationIssue = 'MERCHANT_MISMATCH';
    if (testing !== undefined && testing !== (this.options.testMode ? '1' : '0'))
      verificationIssue = 'TEST_MODE_MISMATCH';
    const status = eventStatus(parameters, webhook);
    const providerStatus =
      scalar(parameters, webhook ? 'pg_result' : 'pg_payment_status', false) ?? 'unknown';
    const event: VerifiedPaymentEvent = {
      eventId: `freedompay:${merchantId}:${externalPaymentId}:PAYMENT:${status}`,
      externalPaymentId,
      merchantId,
      merchantReference,
      amount,
      currency,
      status,
      provider: this.name,
      operation: 'PAYMENT',
      providerStatus,
      needsReconciliation:
        !amount ||
        !currency ||
        (webhook &&
          providerStatus === '1' &&
          scalar(parameters, 'pg_captured', false) === undefined),
      ...(verificationIssue ? { verificationIssue } : {}),
    };
    if (!webhook) {
      const related: VerifiedPaymentEvent[] = [];
      for (const [containerKey, itemKey, operation] of [
        ['pg_refund_payments', 'pg_refund_payment', 'REFUND'],
        ['pg_revoked_payments', 'pg_revoked_payment', 'REVERSAL'],
      ] as const) {
        const container = parameters[containerKey];
        if (!isRecord(container)) continue;
        const value = container[itemKey];
        for (const item of Array.isArray(value) ? value : value ? [value] : []) {
          if (!isRecord(item)) continue;
          const fields = item as FreedomPayParameters;
          const operationId = scalar(fields, 'pg_payment_id', false);
          if (!operationId) {
            event.verificationIssue = 'REFUND_ID_MISSING';
            continue;
          }
          const operationStatus = scalar(fields, 'pg_payment_status', false) ?? 'unknown';
          const refundStatus = ['success', 'ok'].includes(operationStatus)
            ? 'REFUNDED'
            : 'REVIEW_REQUIRED';
          related.push({
            eventId: `freedompay:${merchantId}:${externalPaymentId}:${operation}:${operationId}:${operationStatus}`,
            externalPaymentId,
            merchantId,
            merchantReference,
            provider: this.name,
            operation,
            operationId,
            providerStatus: operationStatus,
            status: refundStatus,
            amount: scalar(fields, 'pg_amount', false),
            currency,
          });
        }
      }
      for (const key of ['pg_refund_amount', 'pg_revoke_amount']) {
        const value = scalar(parameters, key, false);
        if (value !== undefined) {
          try {
            if (exactDecimal(value) !== '0') event.verificationIssue = 'REFUND_REQUIRES_REVIEW';
          } catch {
            event.verificationIssue = 'INVALID_REFUND_AMOUNT';
          }
        }
      }
      if (related.length) {
        event.relatedEvents = related;
        event.verificationIssue ??= 'REFUND_REQUIRES_REVIEW';
      }
    }
    return event;
  }

  private paymentId(parameters: FreedomPayParameters): string {
    const value = requiredScalar(parameters, 'pg_payment_id');
    if (!/^[1-9]\d*$/.test(value))
      throw new PaymentProviderError('Invalid payment ID', 'PAYMENT_NOT_FOUND');
    return value;
  }

  private verifySignature(script: string, parameters: FreedomPayParameters): void {
    requiredScalar(parameters, 'pg_salt');
    const signature = requiredScalar(parameters, 'pg_sig');
    if (!/^[a-f0-9]{32}$/.test(signature))
      throw new PaymentProviderError('Invalid payment signature', 'INVALID_SIGNATURE');
    const expected = freedomPaySignature(script, parameters, this.options.secretKey);
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')))
      throw new PaymentProviderError('Invalid payment signature', 'INVALID_SIGNATURE');
  }

  private async request(
    script: string,
    parameters: Record<string, string>,
  ): Promise<FreedomPayParameters> {
    parameters.pg_sig = freedomPaySignature(script, parameters, this.options.secretKey);
    const form = new FormData();
    for (const [key, value] of Object.entries(parameters)) form.set(key, value);
    const response = await fetch(
      new URL(
        script,
        this.options.baseUrl.endsWith('/') ? this.options.baseUrl : `${this.options.baseUrl}/`,
      ),
      {
        method: 'POST',
        headers: { accept: 'application/xml' },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs),
        redirect: 'error',
      },
    );
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const retryAfterMs = retry
        ? /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Number.isFinite(Date.parse(retry))
            ? Math.max(0, Date.parse(retry) - Date.now())
            : undefined
        : undefined;
      throw new PaymentProviderError(
        `Freedom Pay HTTP error ${response.status}`,
        'PROVIDER_HTTP_ERROR',
        retryAfterMs,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new PaymentProviderError('Empty payment provider response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES)
          throw new PaymentProviderError('Payment provider response is too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const result = parseXml(Buffer.concat(chunks).toString('utf8'));
    this.verifySignature(script, result);
    if (requiredScalar(result, 'pg_status') !== 'ok') {
      if (script === 'init_payment.php') throw new PaymentCreationRejectedError();
      throw new PaymentProviderError('Freedom Pay rejected status request', 'STATUS_UNAVAILABLE');
    }
    return result;
  }
}
