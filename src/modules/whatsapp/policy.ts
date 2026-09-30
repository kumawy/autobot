import { z } from 'zod';
import type { OutboundMessage } from '../../types/domain.js';

const templateSchema = (parameters: 'orderId'[]) =>
  z
    .object({
      name: z.string().min(1).max(512),
      locale: z.string().min(2).max(20),
      available: z.boolean(),
      parameters: z.array(z.literal('orderId')).max(1).default(parameters),
    })
    .strict()
    .refine(
      (value) => JSON.stringify(value.parameters) === JSON.stringify(parameters),
      'Template parameters do not match purpose',
    );
const localized = (parameters: 'orderId'[]) =>
  z
    .object({
      ru: templateSchema(parameters).optional(),
      kk: templateSchema(parameters).optional(),
    })
    .strict();
const registrySchema = z
  .object({
    order_paid: localized(['orderId']).optional(),
    payment_review: localized(['orderId']).optional(),
    support_reopen: localized([]).optional(),
  })
  .strict();
export type TemplateRegistry = z.infer<typeof registrySchema>;
export type SendPurpose =
  'order_paid' | 'payment_review' | 'support_reopen' | 'operator_reply' | 'reply';
export function parseTemplateRegistry(raw: string): TemplateRegistry {
  return registrySchema.parse(JSON.parse(raw || '{}'));
}
export interface PolicyCustomer {
  lastInboundAt: Date;
  preferredLanguage: 'ru' | 'kk' | null;
  conversationState: string;
  notificationConsent: boolean;
  optedOutAt: Date | null;
}
export type SendDecision =
  | { allowed: true; message: OutboundMessage }
  | { allowed: false; code: string; reopen?: OutboundMessage };
export function decideWhatsAppSend(input: {
  customer: PolicyCustomer;
  message: OutboundMessage;
  purpose?: SendPurpose;
  templateParameters?: string[];
  registry: TemplateRegistry;
  windowSafetySeconds?: number;
  now?: Date;
  isAiReply?: boolean;
  operatorTicketOpen?: boolean;
}): SendDecision {
  const { customer, message, registry } = input;
  if (input.isAiReply && customer.conversationState === 'HUMAN_HANDOFF')
    return { allowed: false, code: 'STALE_AI' };
  const purpose = input.purpose ?? 'reply';
  if (purpose === 'operator_reply' && input.operatorTicketOpen === false)
    return { allowed: false, code: 'STALE_OPERATOR' };
  const initiated = !['reply', 'operator_reply'].includes(purpose) || message.type === 'template';
  const age = (input.now ?? new Date()).getTime() - customer.lastInboundAt.getTime();
  const withinWindow =
    Number.isFinite(age) &&
    age >= 0 &&
    age < 86_400_000 - Math.max(0, input.windowSafetySeconds ?? 60) * 1000;
  if (withinWindow && message.type !== 'template') return { allowed: true, message };
  if (initiated && (!customer.notificationConsent || customer.optedOutAt))
    return { allowed: false, code: 'BLOCKED_CONSENT' };
  const makeTemplate = (
    kind: 'order_paid' | 'payment_review' | 'support_reopen',
    parameters: string[],
  ): OutboundMessage | undefined => {
    if (!customer.preferredLanguage) return undefined;
    const value = registry[kind]?.[customer.preferredLanguage];
    return value?.available &&
      parameters.length === value.parameters.length &&
      parameters.every((value) => value.length > 0 && value.length <= 1024)
      ? { type: 'template', name: value.name, language: value.locale, parameters }
      : undefined;
  };
  if (message.type === 'template') {
    const kinds = purpose === 'reply' || purpose === 'operator_reply' ? [] : [purpose];
    const known = kinds.some((kind) => {
      const configured = customer.preferredLanguage
        ? registry[kind as 'order_paid' | 'payment_review' | 'support_reopen']?.[
            customer.preferredLanguage
          ]
        : undefined;
      return (
        configured?.available &&
        configured.name === message.name &&
        configured.locale === message.language &&
        (message.parameters?.length ?? 0) === configured.parameters.length &&
        (message.parameters ?? []).every((value) => value.length > 0 && value.length <= 1024)
      );
    });
    return known ? { allowed: true, message } : { allowed: false, code: 'BLOCKED_TEMPLATE' };
  }
  if (purpose === 'operator_reply') {
    const reopen =
      customer.notificationConsent && !customer.optedOutAt
        ? makeTemplate('support_reopen', [])
        : undefined;
    return { allowed: false, code: 'BLOCKED_WINDOW', ...(reopen ? { reopen } : {}) };
  }
  if (purpose === 'reply') return { allowed: false, code: 'BLOCKED_WINDOW' };
  const template = makeTemplate(purpose, input.templateParameters ?? []);
  return template
    ? { allowed: true, message: template }
    : { allowed: false, code: 'BLOCKED_TEMPLATE' };
}
