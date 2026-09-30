import { randomInt } from 'node:crypto';
import { DeliveryError, retryAfterMilliseconds } from './delivery-error.js';
export interface TelegramSendReceipt {
  chatId: string;
  messageId: string;
}
export interface NotificationService {
  send(text: string): Promise<TelegramSendReceipt | void>;
}
export class TelegramService implements NotificationService {
  constructor(private options: { botToken: string; chatId: string }) {}
  async send(text: string): Promise<TelegramSendReceipt> {
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.options.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.options.chatId,
          text: text.slice(0, 4000),
          protect_content: true,
        }),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new DeliveryError('TELEGRAM_SEND_UNKNOWN', { outcome: 'UNKNOWN' });
    }
    if (response.status >= 500)
      throw new DeliveryError(`TELEGRAM_HTTP_${response.status}`, { outcome: 'UNKNOWN' });
    let body: {
      ok?: boolean;
      error_code?: number;
      parameters?: { retry_after?: number };
      result?: { message_id?: number; chat?: { id?: number } };
    };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      if (!response.ok)
        throw new DeliveryError(`TELEGRAM_REJECTED_${response.status}`, {
          outcome: 'REJECTED',
          retryable: response.status === 429,
          retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')),
        });
      throw new DeliveryError('TELEGRAM_ACK_UNKNOWN', { outcome: 'UNKNOWN' });
    }
    if (!response.ok || body.ok !== true) {
      const code = body.error_code ?? response.status;
      throw new DeliveryError(`TELEGRAM_REJECTED_${code}`, {
        outcome: 'REJECTED',
        retryable: code === 429,
        retryAfterMs: retryAfterMilliseconds(
          body.parameters?.retry_after !== undefined
            ? String(body.parameters.retry_after)
            : response.headers.get('retry-after'),
        ),
      });
    }
    if (
      !Number.isSafeInteger(body.result?.message_id) ||
      !Number.isSafeInteger(body.result?.chat?.id)
    ) {
      throw new DeliveryError('TELEGRAM_ACK_UNKNOWN', { outcome: 'UNKNOWN' });
    }
    const chatId = String(body.result!.chat!.id);
    if (chatId !== this.options.chatId)
      throw new DeliveryError('TELEGRAM_CHAT_MISMATCH', { outcome: 'UNKNOWN' });
    return { chatId, messageId: String(body.result!.message_id) };
  }
}
export class DemoNotificationService implements NotificationService {
  constructor(private chatId = 'demo') {}
  async send(_text: string): Promise<TelegramSendReceipt> {
    return { chatId: this.chatId, messageId: String(randomInt(1, 2 ** 48 - 1)) };
  }
}
