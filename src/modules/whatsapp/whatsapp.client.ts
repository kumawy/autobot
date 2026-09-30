import { randomUUID } from 'node:crypto';
import { DeliveryError, retryAfterMilliseconds } from '../notifications/delivery-error.js';
import type { OutboundMessage } from '../../types/domain.js';
export interface SendMetadata {
  correlationId?: string;
}
export interface WhatsAppTransport {
  send(to: string, message: OutboundMessage, metadata?: SendMetadata): Promise<string>;
  markAsRead(id: string): Promise<void>;
}
export class DemoWhatsAppClient implements WhatsAppTransport {
  async send(_to: string, _message: OutboundMessage) {
    return `demo.${randomUUID()}`;
  }
  async markAsRead(_id: string) {}
}
export class WhatsAppClient implements WhatsAppTransport {
  constructor(
    private options: {
      accessToken: string;
      phoneNumberId: string;
      graphApiVersion: string;
      timeoutMs?: number;
    },
  ) {}
  private async request(
    payload: Record<string, unknown>,
    metadata?: SendMetadata,
  ): Promise<string> {
    if (metadata?.correlationId && !/^[a-zA-Z0-9:._-]{1,128}$/.test(metadata.correlationId))
      throw new DeliveryError('INVALID_CORRELATION', { outcome: 'REJECTED' });
    let response: Response;
    try {
      response = await fetch(
        `https://graph.facebook.com/${this.options.graphApiVersion}/${encodeURIComponent(this.options.phoneNumberId)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.options.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            ...payload,
            ...(metadata?.correlationId
              ? { biz_opaque_callback_data: metadata.correlationId }
              : {}),
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 12000),
          redirect: 'error',
        },
      );
    } catch {
      throw new DeliveryError('WHATSAPP_SEND_UNKNOWN', { outcome: 'UNKNOWN' });
    }
    if (response.status >= 500)
      throw new DeliveryError(`WHATSAPP_HTTP_${response.status}`, { outcome: 'UNKNOWN' });
    if (!response.ok) {
      let code = String(response.status);
      try {
        const error = (await response.json()) as { error?: { code?: number } };
        if (error.error?.code) code += `_${error.error.code}`;
      } catch {
        /* Do not include provider response text. */
      }
      throw new DeliveryError(`WhatsApp HTTP ${code}`, {
        outcome: 'REJECTED',
        retryable: response.status === 429,
        retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')),
      });
    }
    let data: { messages?: { id?: string }[]; success?: boolean };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      throw new DeliveryError('WHATSAPP_ACK_UNKNOWN', { outcome: 'UNKNOWN' });
    }
    const id = data.messages?.[0]?.id;
    if (payload.status === 'read' && data.success === true) return '';
    if (!id || typeof id !== 'string')
      throw new DeliveryError('WHATSAPP_ACK_UNKNOWN', { outcome: 'UNKNOWN' });
    return id;
  }
  sendText(to: string, text: string, metadata?: SendMetadata) {
    return this.request(
      {
        to,
        type: 'text',
        text: { body: text.slice(0, 4096), preview_url: false },
      },
      metadata,
    );
  }
  sendButtons(
    to: string,
    text: string,
    buttons: { id: string; title: string }[],
    metadata?: SendMetadata,
  ) {
    if (buttons.length > 3 || !buttons.length)
      throw new DeliveryError('WhatsApp allows 1–3 buttons', { outcome: 'REJECTED' });
    return this.request(
      {
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: text.slice(0, 1024) },
          action: {
            buttons: buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      },
      metadata,
    );
  }
  sendList(
    to: string,
    text: string,
    button: string,
    rows: { id: string; title: string; description?: string }[],
    metadata?: SendMetadata,
  ) {
    if (rows.length > 10 || !rows.length)
      throw new DeliveryError('WhatsApp allows 1–10 rows', { outcome: 'REJECTED' });
    return this.request(
      {
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: text.slice(0, 1024) },
          action: {
            button: button.slice(0, 20),
            sections: [
              {
                rows: rows.map((r) => ({
                  ...r,
                  title: r.title.slice(0, 24),
                  ...(r.description ? { description: r.description.slice(0, 72) } : {}),
                })),
              },
            ],
          },
        },
      },
      metadata,
    );
  }
  sendImage(to: string, url: string, caption?: string, metadata?: SendMetadata) {
    return this.request(
      {
        to,
        type: 'image',
        image: { link: url, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
      },
      metadata,
    );
  }
  sendTemplate(
    to: string,
    name: string,
    language: string,
    parameters: string[] = [],
    metadata?: SendMetadata,
  ) {
    return this.request(
      {
        to,
        type: 'template',
        template: {
          name,
          language: { code: language },
          ...(parameters.length
            ? {
                components: [
                  { type: 'body', parameters: parameters.map((text) => ({ type: 'text', text })) },
                ],
              }
            : {}),
        },
      },
      metadata,
    );
  }
  async markAsRead(id: string) {
    await this.request({ status: 'read', message_id: id });
  }
  async send(to: string, message: OutboundMessage, metadata?: SendMetadata): Promise<string> {
    switch (message.type) {
      case 'text':
        return this.sendText(to, message.text, metadata);
      case 'buttons':
        return this.sendButtons(to, message.text, message.buttons, metadata);
      case 'list':
        return this.sendList(to, message.text, message.button, message.rows, metadata);
      case 'image':
        return this.sendImage(to, message.url, message.caption, metadata);
      case 'template':
        return this.sendTemplate(to, message.name, message.language, message.parameters, metadata);
    }
  }
}
