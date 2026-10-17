export type Language = 'ru' | 'kk';
export type ConversationState =
  | 'AWAITING_LANGUAGE'
  | 'MAIN_MENU'
  | 'PRODUCT_VIEW'
  | 'DISC_LIST'
  | 'AI_QA'
  | 'ORDER_NAME'
  | 'ORDER_PHONE'
  | 'ORDER_CITY'
  | 'ORDER_ADDRESS'
  | 'ORDER_DISC'
  | 'ORDER_QUANTITY'
  | 'ORDER_CONSENT'
  | 'ORDER_CONFIRMATION'
  | 'CANCEL_CONFIRMATION'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'HUMAN_HANDOFF';
export type OrderStatus =
  | 'DRAFT'
  | 'AWAITING_CONFIRMATION'
  | 'AWAITING_PAYMENT'
  | 'PAID'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'REFUNDED';
export type PaymentStatus =
  | 'NOT_CREATED'
  | 'CREATING'
  | 'CREATION_UNKNOWN'
  | 'PENDING'
  | 'PAID'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REVIEW_REQUIRED'
  | 'REFUND_PENDING'
  | 'REFUNDED';
export interface CustomerData {
  id: string;
  whatsappId: string;
  preferredLanguage: Language | null;
  conversationState: ConversationState;
  firstUnhandledMessage: string | null;
  currentOrderId: string | null;
  selectedDiscId: string | null;
  editingField: string | null;
  conversationVersion?: number;
  previousState?: ConversationState | null;
  selectedDiscIds?: string[];
  privacyNoticeVersion?: string | null;
  privacyNoticeAt?: Date | string | null;
  notificationConsent?: boolean;
  notificationConsentAt?: Date | string | null;
  notificationConsentVersion?: string | null;
  notificationConsentSource?: string | null;
  notificationConsentScope?: string | null;
  optedOutAt?: Date | string | null;
}
export interface OrderData {
  id: string;
  publicOrderId: string;
  customerId: string;
  recipientName: string | null;
  recipientPhone: string | null;
  city: string | null;
  address: string | null;
  productId: string;
  discId: string | null;
  quantity: number;
  quantityConfirmed?: boolean;
  unitPrice: number;
  totalAmount: number;
  currency: string;
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentUrl: string | null;
  selectedDiscIds?: string[];
  packageSnapshot?: PackageSnapshot | null;
  deliverySnapshot?: DeliverySnapshot | null;
  subtotalAmount?: number;
  deliveryAmount?: number;
  deliveryMode?: string;
  configVersion?: string | null;
  contentVersion?: number;
  version?: number;
  checkoutFrozenAt?: Date | string | null;
}
export interface PackageSnapshot {
  packageMode: 'FIXED_SET' | 'SELECTABLE_DISCS';
  includedDiscCount: number;
  allowRepeatedDiscs: boolean;
  productNames: Record<Language, string>;
  discs: { id: string; title: string }[];
  configVersion: string;
  demo: boolean;
}
export interface DeliverySnapshot {
  mode: 'INCLUDED' | 'FIXED_PREPAID' | 'PAID_SEPARATELY';
  amount: number;
  city: string;
  terms: Record<Language, string>;
  configVersion: string;
}
export interface InboundMessage {
  id: string;
  from: string;
  type: 'text' | 'interactive' | 'button' | 'unsupported';
  text?: string;
  actionId?: string;
  timestamp?: number;
  replyToMessageId?: string;
  mediaType?: string;
}
export type OutboundMessage =
  | { type: 'text'; text: string }
  | { type: 'buttons'; text: string; buttons: { id: string; title: string }[] }
  | {
      type: 'list';
      text: string;
      button: string;
      rows: { id: string; title: string; description?: string }[];
    }
  | { type: 'image'; url: string; caption?: string }
  | { type: 'template'; name: string; language: string; parameters?: string[] };
export interface ConversationResult {
  customer: CustomerData;
  order: OrderData | null;
  messages: OutboundMessage[];
  createPayment?: boolean;
  handoff?: { reason: string };
  resumeBot?: boolean;
  /** Only free consultation text belongs in AI history, never order fields or summaries. */
  consultation?: boolean;
  consultationMessageIndexes?: number[];
}
