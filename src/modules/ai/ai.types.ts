import type { Language } from '../knowledge/catalog.service.js';
import type { ConversationState } from '../../types/domain.js';
export interface AiServerContext {
  customerId: string;
  state: ConversationState;
  orderId?: string | null;
  orderCustomerId?: string | null;
  conversationVersion?: number;
}

export type AiAction = 'show_main_menu' | 'start_order' | 'request_human_handoff';
export const handoffReasons = [
  'MANAGER_REQUESTED',
  'UNKNOWN_INFORMATION',
  'COMPLAINT',
  'REFUND_REQUEST',
  'PAYMENT_PROBLEM',
  'CUSTOM_ORDER',
  'BULK_ORDER',
  'AI_UNCERTAIN',
] as const;
export type HandoffReason = (typeof handoffReasons)[number];
export interface AiInput {
  language: Language;
  text: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  context?: AiServerContext;
}
export interface AiAnswer {
  text?: string;
  action?: AiAction;
  reason?: string;
}
export interface AiService {
  answer(input: AiInput): Promise<AiAnswer>;
}
