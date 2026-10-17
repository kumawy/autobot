import {
  normalizeMessageContent,
  jidNormalizedUser,
  proto,
  type BinaryNode,
  type WAMessage,
} from '@whiskeysockets/baileys';
import type { InboundMessage, OutboundMessage } from '../../types/domain.js';
import { safeCustomerText } from '../../utils/security.js';

export function phoneFromJid(jid?: string | null): string | null {
  if (!jid) return null;
  const match = /^(\d{7,15})@s\.whatsapp\.net$/.exec(jidNormalizedUser(jid));
  return match?.[1] ?? null;
}
export function parseBaileysMessage(raw: WAMessage, phone: string): InboundMessage | null {
  if (!raw.key.id || !raw.message) return null;
  const content = normalizeMessageContent(raw.message);
  if (
    !content ||
    content.protocolMessage ||
    content.reactionMessage ||
    content.senderKeyDistributionMessage
  )
    return null;
  const text = content.conversation ?? content.extendedTextMessage?.text;
  const native = content.interactiveResponseMessage?.nativeFlowResponseMessage;
  let nativeActionId: string | undefined;
  if (native) {
    if (native.name !== 'quick_reply' || !native.paramsJson || native.paramsJson.length > 4096)
      return null;
    try {
      const params: unknown = JSON.parse(native.paramsJson);
      if (!params || typeof params !== 'object' || !('id' in params)) return null;
      if (typeof params.id !== 'string' || !params.id.length || params.id.length > 256) return null;
      nativeActionId = params.id;
    } catch {
      return null;
    }
  }
  const context =
    content.extendedTextMessage?.contextInfo ??
    content.interactiveResponseMessage?.contextInfo ??
    content.buttonsResponseMessage?.contextInfo ??
    content.listResponseMessage?.contextInfo ??
    content.templateButtonReplyMessage?.contextInfo;
  const actionId =
    content.buttonsResponseMessage?.selectedButtonId ??
    content.listResponseMessage?.singleSelectReply?.selectedRowId ??
    content.templateButtonReplyMessage?.selectedId ??
    nativeActionId;
  const timestamp = Number(raw.messageTimestamp);
  return {
    id: raw.key.id,
    from: phone,
    type: actionId ? 'interactive' : typeof text === 'string' ? 'text' : 'unsupported',
    ...(typeof text === 'string' ? { text: safeCustomerText(text) } : {}),
    ...(actionId ? { actionId } : {}),
    ...(context?.stanzaId ? { replyToMessageId: context.stanzaId } : {}),
    ...(Number.isFinite(timestamp) && timestamp > 0 ? { timestamp } : {}),
    ...(typeof text !== 'string' && !actionId
      ? {
          mediaType: Object.keys(content).find((key) => key.endsWith('Message')) ?? 'unknown',
        }
      : {}),
  };
}

// Native-flow rendering is experimental. Wire node names follow the observed protocol:
// https://github.com/zqdevelopers/zq_baileys_helper . No third-party helper is installed.
export function baileysButtonNodes(): BinaryNode[] {
  const flow: BinaryNode = { tag: 'native_flow', attrs: { name: 'mixed', v: '9' } };
  const interactive: BinaryNode = {
    tag: 'interactive',
    attrs: { type: 'native_flow', v: '1' },
    content: [flow],
  };
  return [
    { tag: 'biz', attrs: {}, content: [interactive] },
    { tag: 'bot', attrs: { biz_bot: '1' } },
  ];
}
export function baileysButtonContent(
  message: Extract<OutboundMessage, { type: 'buttons' }>,
): proto.IMessage {
  return {
    documentWithCaptionMessage: {
      message: {
        interactiveMessage: {
          body: { text: renderBaileysText(message) },
          nativeFlowMessage: {
            buttons: message.buttons.map(({ id, title }) => ({
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({ id, display_text: title }),
            })),
            messageVersion: 1,
          },
        },
      },
    },
  };
}
export function menuEntries(message: OutboundMessage) {
  return message.type === 'buttons' ? message.buttons : message.type === 'list' ? message.rows : [];
}
export function renderBaileysText(message: OutboundMessage): string {
  if (message.type === 'template') throw new Error('BAILEYS_TEMPLATES_UNSUPPORTED');
  if (message.type === 'image') return message.caption ?? '';
  const rows = menuEntries(message);
  return rows.length
    ? [
        message.text,
        ...rows.map(
          (row, index) =>
            `${index + 1}. ${row.title}${'description' in row && row.description ? ` — ${row.description}` : ''}`,
        ),
        'Ответьте цифрой / Нөмірін жазыңыз.',
      ].join('\n')
    : message.text;
}
