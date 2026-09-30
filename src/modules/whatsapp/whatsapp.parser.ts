import { z } from 'zod';
import type { InboundMessage } from '../../types/domain.js';
import { safeCustomerText } from '../../utils/security.js';
const message = z.object({
  id: z.string().min(1).max(300),
  from: z.string().regex(/^\d{7,15}$/),
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ id: z.string() }).optional(),
      list_reply: z.object({ id: z.string() }).optional(),
    })
    .optional(),
  button: z.object({ payload: z.string() }).optional(),
  context: z.object({ id: z.string().max(300) }).optional(),
});
const statusSchema = z.object({
  id: z.string().min(1).max(300),
  status: z.string().min(1).max(40),
  timestamp: z.string().optional(),
  recipient_id: z.string().optional(),
  biz_opaque_callback_data: z.string().max(128).optional(),
  errors: z.array(z.object({ code: z.number().int() })).optional(),
});
export interface WhatsAppStatus {
  id: string;
  status: string;
  externalEventKey: string;
  timestamp?: number;
  recipientId?: string;
  correlationId?: string;
  errorCode?: string;
}
const envelope = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
            messages: z.array(z.unknown()).optional(),
            statuses: z.array(statusSchema).optional(),
          }),
        }),
      ),
    }),
  ),
});
export function parseWebhook(
  body: unknown,
  phoneNumberId?: string,
): { messages: InboundMessage[]; statuses: WhatsAppStatus[] } {
  const payload = envelope.parse(body);
  const messages: InboundMessage[] = [];
  const statuses: WhatsAppStatus[] = [];
  for (const entry of payload.entry)
    for (const { value } of entry.changes) {
      if (phoneNumberId && value.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const status of value.statuses ?? []) {
        const timestamp = timestampSeconds(status.timestamp);
        const errorCode = status.errors?.[0]?.code?.toString();
        statuses.push({
          id: status.id,
          status: status.status,
          externalEventKey: `status:${status.id}:${status.status}:${timestamp ?? 'unknown'}:${errorCode ?? ''}`,
          ...(timestamp ? { timestamp } : {}),
          ...(status.recipient_id ? { recipientId: status.recipient_id } : {}),
          ...(status.biz_opaque_callback_data
            ? { correlationId: status.biz_opaque_callback_data }
            : {}),
          ...(errorCode ? { errorCode } : {}),
        });
      }
      for (const raw of value.messages ?? []) {
        const m = message.parse(raw);
        const actionId =
          m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload;
        const type =
          m.type === 'text'
            ? 'text'
            : m.type === 'interactive'
              ? 'interactive'
              : m.type === 'button'
                ? 'button'
                : 'unsupported';
        messages.push({
          id: m.id,
          from: m.from,
          type,
          ...(m.text ? { text: safeCustomerText(m.text.body) } : {}),
          ...(actionId ? { actionId: actionId.slice(0, 256) } : {}),
          ...(timestampSeconds(m.timestamp) ? { timestamp: timestampSeconds(m.timestamp) } : {}),
          ...(m.context?.id ? { replyToMessageId: m.context.id } : {}),
          ...(type === 'unsupported' ? { mediaType: m.type } : {}),
        });
      }
    }
  return { messages, statuses };
}

function timestampSeconds(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 && result <= Math.floor(Date.now() / 1000) + 300
    ? result
    : undefined;
}
