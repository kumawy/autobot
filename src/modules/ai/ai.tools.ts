import type { FunctionTool } from 'openai/resources/responses/responses.js';
import { z } from 'zod';
import type { CatalogService, Language } from '../knowledge/catalog.service.js';
import { handoffReasons, type AiAnswer, type AiServerContext } from './ai.types.js';

const descriptions = {
  get_product_info: 'Read the configured product facts and application-controlled price.',
  list_available_discs:
    'Read currently available melodies. Never suggest a melody absent from this list.',
  get_delivery_info: 'Read delivery rules; null means unknown and requires a manager.',
  get_payment_info: 'Read payment instructions only; this never checks or confirms a payment.',
  show_main_menu: 'Ask the application to show the main menu.',
  start_order: 'Ask the application to begin the order form, only on explicit customer intent.',
};

export const aiTools: FunctionTool[] = [
  ...Object.entries(descriptions).map(([name, description]): FunctionTool => ({
    type: 'function',
    name,
    description,
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  })),
  {
    type: 'function',
    name: 'request_human_handoff',
    description:
      'Pass the conversation to a manager when information is unknown or help is required.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', enum: [...handoffReasons] } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

export interface ToolResult {
  output: unknown;
  action?: AiAnswer;
}

/** Explicit dispatch prevents a model from calling arbitrary methods or business services. */
export function executeAiTool(
  name: string,
  argumentsJson: string,
  catalog: CatalogService,
  language: Language,
  context?: AiServerContext,
): ToolResult {
  if (
    context &&
    (!context.customerId ||
      context.state === 'HUMAN_HANDOFF' ||
      (context.orderId && context.orderCustomerId !== context.customerId))
  )
    throw new Error('AI_CONTEXT_FORBIDDEN');
  if (
    ['start_order', 'show_main_menu'].includes(name) &&
    (!context || !['MAIN_MENU', 'AI_QA', 'PRODUCT_VIEW', 'DISC_LIST'].includes(context.state))
  )
    throw new Error('AI_CONTROL_STATE_FORBIDDEN');
  const args: unknown = JSON.parse(argumentsJson);
  if (name === 'request_human_handoff') {
    if (!context) throw new Error('AI_CONTROL_STATE_FORBIDDEN');
    const result = z
      .object({ reason: z.enum(handoffReasons) })
      .strict()
      .parse(args);
    return {
      output: { requested: true },
      action: { action: 'request_human_handoff', reason: result.reason },
    };
  }
  z.object({}).strict().parse(args);
  switch (name) {
    case 'get_product_info':
      return { output: catalog.product(language) };
    case 'list_available_discs':
      return { output: catalog.discs() };
    case 'get_delivery_info':
      return { output: { deliveryInfo: catalog.product(language).deliveryInfo } };
    case 'get_payment_info':
      return {
        output: {
          hostedPaymentPage: true,
          statusAvailable: false,
          confirmation:
            'Only verified server-to-server callback or verified server status response',
          cardDetailsInChat: false,
        },
      };
    case 'show_main_menu':
      return { output: { requested: true }, action: { action: 'show_main_menu' } };
    case 'start_order':
      return { output: { requested: true }, action: { action: 'start_order' } };
    default:
      throw new Error('AI tool is not allowlisted');
  }
}
