/** Payment amounts are whole KZT, never floating point minor units. */
export interface CreatePaymentInput {
  orderId: string;
  publicOrderId: string;
  attemptId: string;
  amount: number;
  currency: 'KZT';
  description: string;
  merchantReference?: string;
  orderVersion?: number;
}

export interface CreatePaymentResult {
  externalPaymentId: string;
  paymentUrl: string;
}

export type PaymentEventStatus =
  'PAID' | 'FAILED' | 'PENDING' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED' | 'REVIEW_REQUIRED';
export type PaymentOperation = 'PAYMENT' | 'REFUND' | 'REVERSAL';

/** Authenticated provider data. The service must still compare it with the DB order. */
export interface VerifiedPaymentEvent {
  eventId: string;
  externalPaymentId: string;
  orderId?: string;
  merchantReference?: string;
  merchantId?: string;
  /** Provider decimals remain strings; no parseFloat/rounding is used for comparisons. */
  amount?: number | string;
  currency?: string;
  status: PaymentEventStatus;
  provider: string;
  operation?: PaymentOperation;
  operationId?: string;
  providerStatus?: string;
  needsReconciliation?: boolean;
  verificationIssue?: string;
  relatedEvents?: VerifiedPaymentEvent[];
}

export interface PaymentWebhookInput {
  body: unknown;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface PaymentAcknowledgement {
  body: string;
  contentType: string;
  statusCode?: number;
}

export interface PaymentProvider {
  readonly name: string;
  readonly merchantId?: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyWebhook(input: PaymentWebhookInput): Promise<VerifiedPaymentEvent>;
  getPaymentStatus(externalPaymentId: string): Promise<VerifiedPaymentEvent>;
  getPaymentStatusByReference?(merchantReference: string): Promise<VerifiedPaymentEvent>;
  acknowledge(input: unknown, accepted: boolean): PaymentAcknowledgement;
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly code = 'PAYMENT_PROVIDER_ERROR',
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

/** Creation may have reached the provider. Do not create again until reconciliation. */
export class PaymentCreationUnknownError extends PaymentProviderError {
  constructor(message = 'Payment creation outcome is unknown') {
    super(message, 'CREATION_UNKNOWN');
    this.name = 'PaymentCreationUnknownError';
  }
}

/** Signed rejection proves no usable payment was created; transport errors do not. */
export class PaymentCreationRejectedError extends PaymentProviderError {
  constructor(message = 'Payment creation was rejected') {
    super(message, 'CREATION_REJECTED');
    this.name = 'PaymentCreationRejectedError';
  }
}

/** Canonical decimal without exponent, sign loss, rounding, or binary-float conversion. */
export function exactDecimal(value: string | number): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new PaymentProviderError(
      'Numeric provider amounts must be safe integers',
      'INVALID_AMOUNT',
    );
  }
  const source = String(value);
  if (!/^-?\d{1,30}(?:\.\d{1,12})?$/.test(source)) {
    throw new PaymentProviderError('Invalid exact payment amount', 'INVALID_AMOUNT');
  }
  const negative = source.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? source.slice(1) : source).split('.');
  const whole = integer.replace(/^0+(?=\d)/, '');
  const decimal = fraction.replace(/0+$/, '');
  return `${negative && (whole !== '0' || decimal) ? '-' : ''}${whole}${decimal ? `.${decimal}` : ''}`;
}

export function validatePaymentInput(input: CreatePaymentInput): void {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.currency !== 'KZT') {
    throw new PaymentProviderError('Payment requires a positive integer amount in KZT');
  }
  if (!input.orderId || input.orderId.length > 50 || !input.attemptId || !input.description) {
    throw new PaymentProviderError('Invalid payment order, attempt, or description');
  }
  if (input.merchantReference && !/^[A-Za-z0-9:_-]{1,50}$/.test(input.merchantReference)) {
    throw new PaymentProviderError('Invalid merchant reference');
  }
}
