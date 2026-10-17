import { randomUUID } from 'node:crypto';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  generateMessageIDV2,
  generateWAMessageFromContent,
  proto,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import type { PrismaClient } from '@prisma/client';
import type { Env } from '../../config/env.js';
import type { OutboundMessage } from '../../types/domain.js';
import type { WhatsAppTransport, SendMetadata } from './whatsapp.client.js';
import type { WhatsAppService } from './whatsapp.service.js';
import { BaileysAuthStore } from './baileys-auth.js';
import {
  menuEntries,
  parseBaileysMessage,
  phoneFromJid,
  renderBaileysText,
  baileysButtonContent,
  baileysButtonNodes,
} from './baileys-codec.js';
import { DeliveryError } from '../notifications/delivery-error.js';
import { json } from '../../db/prisma.js';
import { redactSignalDiagnostics } from './baileys-diagnostics.js';

export type BaileysState =
  | 'stopped'
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'reconnecting'
  | 'logged_out'
  | 'number_mismatch'
  | 'session_busy'
  | 'storage_error';
export class BaileysWhatsAppClient implements WhatsAppTransport {
  private socket: WASocket | null = null;
  private state: BaileysState = 'stopped';
  private qr: string | null = null;
  private number: string | null = null;
  private active = false;
  private owned = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private attempts = 0;
  private connecting: Promise<void> | null = null;
  private events: Promise<void> = Promise.resolve();
  private store: BaileysAuthStore;
  private activatedAt = 0;
  constructor(
    private options: {
      db: PrismaClient;
      env: Env;
      inbox: WhatsAppService;
      onState?: (state: BaileysState) => void;
      onError?: (error: unknown) => void;
      socketFactory?: typeof makeWASocket;
    },
  ) {
    redactSignalDiagnostics();
    this.store = new BaileysAuthStore(
      options.db,
      options.env.WHATSAPP_SESSION_ID,
      randomUUID(),
      options.env.WHATSAPP_AUTH_ENCRYPTION_KEY,
    );
  }
  status() {
    return { transport: 'baileys', state: this.state, number: this.number, qrAvailable: !!this.qr };
  }
  isReady() {
    return this.state === 'connected';
  }
  pairingQr() {
    return this.qr;
  }
  private transition(state: BaileysState) {
    this.state = state;
    if (state !== 'qr') this.qr = null;
    this.options.onState?.(state);
  }
  async start() {
    if (this.active) return;
    this.active = true;
    this.leaseTimer = setInterval(() => {
      if (this.owned)
        void this.store.assertOwnership().catch((error) => this.storageFailure(error));
    }, 15000);
    this.leaseTimer.unref();
    await this.connect();
  }
  private enqueueEvent(fn: () => Promise<void>) {
    this.events = this.events.then(fn).catch((error) => this.storageFailure(error));
  }
  private storageFailure(error: unknown) {
    this.options.onError?.(error);
    this.closeSocket();
    this.owned = false;
    this.transition('storage_error');
    this.scheduleReconnect();
  }
  private closeSocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    for (const event of [
      'connection.update',
      'messages.upsert',
      'messages.update',
      'message-receipt.update',
      'creds.update',
    ] as const)
      socket.ev.removeAllListeners(event);
    socket.end(new Error('GATEWAY_RECONNECT'));
  }
  private scheduleReconnect() {
    if (
      !this.active ||
      this.reconnectTimer ||
      ['logged_out', 'number_mismatch'].includes(this.state)
    )
      return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }
  private async connect(): Promise<void> {
    if (!this.active) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectSocket().catch((error) => this.storageFailure(error));
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }
  private async connectSocket() {
    this.closeSocket();
    await this.events;
    if (!(await this.store.acquire())) {
      this.owned = false;
      this.transition('session_busy');
      this.scheduleReconnect();
      return;
    }
    this.owned = true;
    const auth = await this.store.load();
    const session = await this.options.db.whatsAppSession.findUniqueOrThrow({
      where: { id: this.store.sessionId },
    });
    this.activatedAt = session.activatedAt?.getTime() ?? 0;
    if (!this.active) return;
    this.transition('connecting');
    const socket = (this.options.socketFactory ?? makeWASocket)({
      auth: auth.state,
      browser: Browsers.ubuntu('Music Box'),
      logger: pino({ level: 'silent' }), // Protocol logs can contain credentials and message bodies.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      connectTimeoutMs: 20000,
      defaultQueryTimeoutMs: 15000,
      getMessage: async (key) => {
        if (!key.id) return undefined;
        const row = await this.options.db.message.findUnique({
          where: { whatsappMessageId: key.id },
        });
        const content = (row?.payload as { baileysContent?: Record<string, unknown> } | null)
          ?.baileysContent;
        return content ? proto.Message.fromObject(content) : undefined;
      },
    });
    this.socket = socket;
    socket.ev.on('creds.update', () => this.enqueueEvent(auth.saveCreds));
    socket.ev.on('connection.update', (update) =>
      this.enqueueEvent(async () => {
        if (this.socket !== socket || !this.active) return;
        if (update.qr) {
          this.qr = update.qr;
          this.state = 'qr';
          this.options.onState?.('qr');
        }
        if (update.connection === 'open') {
          this.number = phoneFromJid(socket.user?.id);
          if (
            this.options.env.WHATSAPP_EXPECTED_NUMBER &&
            this.number !== this.options.env.WHATSAPP_EXPECTED_NUMBER
          ) {
            this.closeSocket();
            this.transition('number_mismatch');
            return;
          }
          if (!this.activatedAt) {
            this.activatedAt = Date.now();
            await this.options.db.whatsAppSession.update({
              where: { id: this.store.sessionId },
              data: { activatedAt: new Date(this.activatedAt) },
            });
          }
          this.attempts = 0;
          this.transition('connected');
        }
        if (update.connection === 'close') {
          const code = (
            update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
          )?.output?.statusCode;
          this.closeSocket();
          this.transition(code === DisconnectReason.loggedOut ? 'logged_out' : 'reconnecting');
          this.scheduleReconnect();
        }
      }),
    );
    socket.ev.on('messages.upsert', ({ messages }) =>
      this.enqueueEvent(async () => {
        if (this.socket !== socket || !this.active) return;
        for (const message of messages) await this.handleMessage(message, socket);
      }),
    );
    socket.ev.on('messages.update', (updates) =>
      this.enqueueEvent(async () => {
        if (this.socket !== socket || !this.active) return;
        const statuses = updates.flatMap(({ key, update }) => {
          const status =
            update.status === proto.WebMessageInfo.Status.READ
              ? 'read'
              : update.status === proto.WebMessageInfo.Status.DELIVERY_ACK
                ? 'delivered'
                : update.status === proto.WebMessageInfo.Status.SERVER_ACK
                  ? 'sent'
                  : undefined;
          if (!key.fromMe || !key.id || !status) return [];
          return [
            {
              id: key.id,
              status,
              externalEventKey: `baileys:${key.id}:${status}`,
              timestamp: Math.floor(Date.now() / 1000),
            },
          ];
        });
        if (statuses.length) await this.options.inbox.receive([], statuses);
      }),
    );
    socket.ev.on('message-receipt.update', (receipts) =>
      this.enqueueEvent(async () => {
        if (this.socket !== socket || !this.active) return;
        const statuses = receipts.flatMap(({ key, receipt }) => {
          const status = receipt.readTimestamp
            ? 'read'
            : receipt.receiptTimestamp
              ? 'delivered'
              : undefined;
          if (!key.fromMe || !key.id || !status) return [];
          return [
            {
              id: key.id,
              status,
              externalEventKey: `baileys:${key.id}:${status}`,
              timestamp: Number(receipt.readTimestamp ?? receipt.receiptTimestamp),
            },
          ];
        });
        if (statuses.length) await this.options.inbox.receive([], statuses);
      }),
    );
  }
  private async handleMessage(raw: WAMessage, socket: WASocket) {
    const jid = raw.key.remoteJid;
    if (!jid || !/(@s\.whatsapp\.net|@lid)$/.test(jid)) return; // No groups, broadcasts or status.
    const pn =
      phoneFromJid(jid) ??
      phoneFromJid(raw.key.remoteJidAlt) ??
      (jid.endsWith('@lid')
        ? phoneFromJid(await socket.signalRepository.lidMapping.getPNForLID(jid))
        : null);
    if (!pn || pn === this.number) return;
    const message = parseBaileysMessage(raw, pn);
    if (
      !message ||
      !this.activatedAt ||
      (message.timestamp && message.timestamp * 1000 < this.activatedAt - 1000)
    )
      return;
    await this.store.assertOwnership();
    if (raw.key.fromMe) {
      await this.options.inbox.receiveManualReply(message);
      return;
    }
    if (message.type === 'text' && /^\d{1,2}$/.test(message.text?.trim() ?? '')) {
      // Only the latest delivered prompt owns an unquoted numeric reply. Looking
      // backwards for a menu would turn quantities or form values into old actions.
      const last = await this.options.db.message.findFirst({
        where: {
          customer: { whatsappId: pn },
          direction: 'outbound',
          ...(message.replyToMessageId
            ? { whatsappMessageId: message.replyToMessageId }
            : {
                deliveryStatus: { in: ['ACCEPTED', 'SENT', 'DELIVERED', 'READ'] },
              }),
        },
        orderBy: { createdAt: 'desc' },
      });
      if (last?.payload) {
        const rows = menuEntries(last.payload as unknown as OutboundMessage);
        const selected = rows[Number(message.text!.trim()) - 1];
        if (selected) {
          const token = await this.options.db.actionToken.findUnique({
            where: { token: selected.id },
          });
          const customer = await this.options.db.customer.findUnique({ where: { whatsappId: pn } });
          if (
            message.replyToMessageId ||
            (token &&
              customer &&
              token.conversationVersion === customer.conversationVersion &&
              !token.consumedAt &&
              token.expiresAt > new Date())
          ) {
            message.type = 'interactive';
            message.actionId = selected.id;
          }
        }
      }
    }
    await this.options.inbox.receive([message]);
  }
  async send(to: string, message: OutboundMessage, metadata?: SendMetadata): Promise<string> {
    if (!/^\d{7,15}$/.test(to) || !metadata?.correlationId || message.type === 'template')
      throw new DeliveryError('BAILEYS_INVALID_SEND', { outcome: 'REJECTED' });
    const socket = this.socket;
    if (this.state !== 'connected' || !socket)
      throw new DeliveryError('BAILEYS_NOT_CONNECTED', {
        outcome: 'REJECTED',
        retryable: true,
        retryAfterMs: 30000,
      });
    await this.store.assertOwnership();
    const row = await this.options.db.message.findUniqueOrThrow({
      where: { outboxJobId: metadata.correlationId },
      include: { customer: true },
    });
    if (row.customer.whatsappId !== to)
      throw new DeliveryError('BAILEYS_RECIPIENT_MISMATCH', { outcome: 'REJECTED' });
    const source = row.payload as {
      origin?: string;
      consultation?: boolean;
      handoffNotice?: boolean;
      conversationVersion?: number;
    };
    if (
      !source.handoffNotice &&
      (source.origin === 'bot' || source.consultation) &&
      (row.customer.conversationState === 'HUMAN_HANDOFF' ||
        (source.conversationVersion !== undefined &&
          source.conversationVersion !== row.customer.conversationVersion))
    )
      throw new DeliveryError('STALE_AI', { outcome: 'REJECTED' });
    const id = row.whatsappMessageId ?? generateMessageIDV2(socket.user?.id);
    await this.options.db.message.update({
      where: { id: row.id },
      data: { whatsappMessageId: id },
    });
    const payload =
      message.type === 'image'
        ? {
            image: { url: message.url },
            caption: message.caption,
          }
        : { text: renderBaileysText(message) };
    const native =
      this.options.env.WHATSAPP_BAILEYS_BUTTONS &&
      message.type === 'buttons' &&
      message.buttons.length >= 1 &&
      message.buttons.length <= 3
        ? generateWAMessageFromContent(`${to}@s.whatsapp.net`, baileysButtonContent(message), {
            userJid: socket.user?.id ?? '',
            messageId: id,
          })
        : null;
    let sent: WAMessage | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      sent = await Promise.race([
        native
          ? socket
              .relayMessage(`${to}@s.whatsapp.net`, native.message!, {
                messageId: id,
                additionalNodes: baileysButtonNodes(),
              })
              .then((relayedId) => {
                if (relayedId !== id) throw new Error('BAILEYS_ACK_UNKNOWN');
                return native;
              })
          : socket.sendMessage(`${to}@s.whatsapp.net`, payload, { messageId: id }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('BAILEYS_SEND_TIMEOUT')), 20000);
        }),
      ]);
    } catch {
      throw new DeliveryError('BAILEYS_SEND_UNKNOWN', { outcome: 'UNKNOWN' });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (sent?.key.id !== id) throw new DeliveryError('BAILEYS_ACK_UNKNOWN', { outcome: 'UNKNOWN' });
    if (sent.message)
      await this.options.db.message.update({
        where: { id: row.id },
        data: {
          payload: json({
            ...(row.payload as Record<string, unknown>),
            baileysContent: proto.Message.toObject(proto.Message.fromObject(sent.message), {
              bytes: String,
              longs: String,
            }),
          }),
        },
      });
    return id;
  }
  async markAsRead(_id: string) {} // Receiving a message must not mark a manager's conversation read.
  async reconnect() {
    if (!this.active) return this.start();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeSocket();
    await this.events;
    if (['logged_out', 'number_mismatch'].includes(this.state)) {
      if (!this.owned) throw new Error('BAILEYS_SESSION_NOT_OWNED');
      await this.store.reset();
      this.number = null;
    }
    await this.connect();
  }
  async stop() {
    this.active = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.reconnectTimer = null;
    this.leaseTimer = null;
    this.closeSocket();
    await this.connecting;
    await this.events;
    if (this.owned) await this.store.release();
    this.owned = false;
    this.transition('stopped');
  }
}
