import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { readEnv, type Env } from './config/env.js';
import { loadBusinessData, businessGateReport } from './config/business.config.js';
import { HandoffService } from './modules/notifications/handoff.service.js';
import { createDatabase, lock } from './db/prisma.js';
import { CatalogService } from './modules/knowledge/catalog.service.js';
import { DemoAiService, OpenAiService, type AiService } from './modules/ai/ai.service.js';
import { ConversationService } from './modules/conversation/conversation.service.js';
import { WhatsAppService } from './modules/whatsapp/whatsapp.service.js';
import {
  WhatsAppClient,
  DemoWhatsAppClient,
  type WhatsAppTransport,
} from './modules/whatsapp/whatsapp.client.js';
import { parseWebhook } from './modules/whatsapp/whatsapp.parser.js';
import { MockPaymentProvider } from './modules/payments/mock.provider.js';
import { FreedomPayProvider } from './modules/payments/freedompay.provider.js';
import { PaymentService, PaymentValidationError } from './modules/payments/payment.service.js';
import {
  PaymentProviderError,
  type PaymentProvider,
} from './modules/payments/payment-provider.interface.js';
import {
  GoogleSheetsService,
  DemoSheetsService,
  type SheetsService,
} from './modules/sheets/google-sheets.service.js';
import { loadGoogleSheetsCredentials } from './modules/sheets/credentials.js';
import {
  TelegramService,
  DemoNotificationService,
  type NotificationService,
} from './modules/notifications/telegram.service.js';
import { waitForProviderSlot } from './jobs/provider-cadence.js';
import { Worker } from './jobs/worker.js';
import { enqueue } from './jobs/outbox.js';
import {
  safeEqual,
  safeCustomerText,
  verifyMetaSignature,
  errorCode,
  escapeHtml,
} from './utils/security.js';
declare module 'fastify' {
  interface FastifyRequest {
    rawBody: string;
  }
}
export interface AppOptions {
  env?: Env;
  db?: PrismaClient;
  ai?: AiService;
  whatsapp?: WhatsAppTransport;
  provider?: PaymentProvider;
  sheets?: SheetsService;
  notifications?: NotificationService;
  startWorker?: boolean;
  logger?: boolean;
}
export async function buildApp(options: AppOptions = {}) {
  const env = options.env ?? readEnv();
  const db = options.db ?? createDatabase(env.DATABASE_URL);
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: env.LOG_LEVEL,
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body',
              'res.headers.set-cookie',
            ],
            serializers: { req: (r) => ({ method: r.method, url: r.url?.split('?')[0] }) },
          },
    bodyLimit: 256 * 1024,
    requestTimeout: 30000,
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(helmet, {
    hsts: env.NODE_ENV === 'production',
    referrerPolicy: { policy: 'same-origin' },
    contentSecurityPolicy: {
      directives: {
        upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  app.decorateRequest('rawBody', '');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
    }
  });
  app.addContentTypeParser(
    ['application/xml', 'text/xml'],
    { parseAs: 'string' },
    (req, body, done) => {
      req.rawBody = body as string;
      done(null, body);
    },
  );
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      req.rawBody = body as string;
      const params = new URLSearchParams(body as string);
      const values: Record<string, string> = Object.create(null);
      for (const [key, value] of params) {
        if (Object.hasOwn(values, key)) {
          done(Object.assign(new Error('Duplicate form field'), { statusCode: 400 }));
          return;
        }
        values[key] = value;
      }
      done(null, values);
    },
  );
  app.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer' },
    async (req: FastifyRequest, body: string | Buffer) => {
      const bytes = body as Buffer;
      const contentType = req.headers['content-type'] ?? '';
      const form = await new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': contentType },
      }).formData();
      const values: Record<string, string> = Object.create(null);
      let count = 0;
      for (const [key, value] of form.entries()) {
        if (
          ++count > 128 ||
          typeof value !== 'string' ||
          key.length > 128 ||
          value.length > 16384 ||
          Object.hasOwn(values, key)
        )
          throw Object.assign(new Error('Invalid payment form field'), { statusCode: 400 });
        values[key] = value;
      }
      req.rawBody = bytes.toString('utf8');
      return values;
    },
  );
  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof ZodError
        ? 400
        : error instanceof PaymentValidationError
          ? 409
          : error instanceof PaymentProviderError
            ? 400
            : typeof (error as { statusCode?: number }).statusCode === 'number'
              ? (error as { statusCode: number }).statusCode
              : 500;
    request.log.error({
      event: 'request_error',
      request_id: request.id,
      error: errorCode(error),
      status,
    });
    void reply.status(status).send({
      error:
        status >= 500
          ? 'Internal server error'
          : status === 429
            ? 'Too many requests'
            : 'Request rejected',
      requestId: request.id,
    });
  });
  const catalog = new CatalogService({ productPrice: env.PRODUCT_PRICE_KZT, tolerant: true });
  const business = loadBusinessData({ tolerant: true });
  const ai =
    options.ai ??
    (env.AI_PROVIDER === 'demo'
      ? new DemoAiService({ catalog })
      : new OpenAiService({
          catalog,
          apiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_MODEL,
          timeoutMs: 15000,
          maxTools: env.AI_MAX_TOOL_CALLS,
        }));
  const whatsapp =
    options.whatsapp ??
    (env.INTEGRATION_MODE === 'demo'
      ? new DemoWhatsAppClient()
      : new WhatsAppClient({
          accessToken: env.WHATSAPP_ACCESS_TOKEN,
          phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
          graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION,
        }));
  const provider: PaymentProvider =
    options.provider ??
    (env.PAYMENT_PROVIDER === 'mock'
      ? new MockPaymentProvider({
          secret: env.MOCK_PAYMENT_SECRET,
          appBaseUrl: env.APP_BASE_URL,
          checkoutPath: env.INTEGRATION_MODE === 'staging' ? '/mock-payment' : '/dev/mock-payment',
        })
      : new FreedomPayProvider({
          merchantId: env.FREEDOMPAY_MERCHANT_ID,
          secretKey: env.FREEDOMPAY_SECRET_KEY,
          baseUrl: env.FREEDOMPAY_BASE_URL,
          appBaseUrl: env.APP_BASE_URL,
          testMode: env.FREEDOMPAY_TEST_MODE,
          beforeStatusRequest: () =>
            waitForProviderSlot(db, 'freedompay', env.PAYMENT_PROVIDER_MIN_INTERVAL_MS),
        }));
  const sheets =
    options.sheets ??
    (!env.GOOGLE_SHEETS_ENABLED || env.GOOGLE_SHEETS_PROVIDER === 'demo'
      ? new DemoSheetsService(db)
      : new GoogleSheetsService({
          db,
          sheetId: env.GOOGLE_SHEETS_SHEET_ID,
          spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
          range: env.GOOGLE_SHEETS_RANGE,
          shippingEnabled: env.GOOGLE_SHEETS_SHIPPING_ENABLED,
          demoNotifications: env.INTEGRATION_MODE === 'demo',
          ...loadGoogleSheetsCredentials(env),
        }));
  const notifications =
    options.notifications ??
    (env.TELEGRAM_ENABLED && env.INTEGRATION_MODE !== 'demo'
      ? new TelegramService({
          botToken: env.TELEGRAM_BOT_TOKEN,
          chatId: env.TELEGRAM_MANAGER_CHAT_ID,
        })
      : new DemoNotificationService(env.TELEGRAM_MANAGER_CHAT_ID || '-100123456789'));
  const handoff = new HandoffService({
    db,
    chatId: env.TELEGRAM_MANAGER_CHAT_ID || '-100123456789',
    allowedManagerIds: (
      env.TELEGRAM_ALLOWED_MANAGER_IDS || (env.INTEGRATION_MODE === 'demo' ? '1001,1002' : '')
    )
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    webhookSecret:
      env.TELEGRAM_WEBHOOK_SECRET ||
      (env.INTEGRATION_MODE === 'demo' ? 'local-demo-webhook-secret-xxxxxxxx' : ''),
  });
  const conversation = new ConversationService({
    business,
    integrationMode: env.PAYMENT_PROVIDER === 'mock' ? 'demo' : 'live',
    catalog,
    ai,
    productPrice: env.PRODUCT_PRICE_KZT,
    maxQuantity: env.MAX_ORDER_QUANTITY,
    processFirstMessageAfterLanguage: env.PROCESS_FIRST_MESSAGE_AFTER_LANGUAGE,
    managerHandoffEnabled: env.MANAGER_HANDOFF_ENABLED,
  });
  const inbox = new WhatsAppService(
    db,
    conversation,
    catalog,
    provider.name,
    env.MAX_RETRY_ATTEMPTS,
    { handoff, merchantId: provider.merchantId },
  );
  const payments = new PaymentService(db);
  const worker = new Worker({
    db,
    env,
    inbox,
    whatsapp,
    sheets,
    notifications,
    provider,
    catalog,
    handoff,
    onError: (e) => app.log.error({ event: 'worker_error', error: errorCode(e) }),
  });
  for (const path of ['/health', '/ready'])
    app.get(path, async (_req, reply) => {
      try {
        await db.$queryRaw`SELECT 1`;
        return { status: 'ok', database: 'connected' };
      } catch {
        return reply.status(503).send({ status: 'degraded', database: 'disconnected' });
      }
    });
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const query = z
      .object({
        'hub.mode': z.string(),
        'hub.verify_token': z.string(),
        'hub.challenge': z.string().max(200),
      })
      .safeParse(req.query);
    if (!query.success) return reply.status(400).send({ error: 'Invalid verification request' });
    if (
      query.data['hub.mode'] !== 'subscribe' ||
      !env.WHATSAPP_VERIFY_TOKEN ||
      !safeEqual(query.data['hub.verify_token'], env.WHATSAPP_VERIFY_TOKEN)
    )
      return reply.status(403).send({ error: 'Forbidden' });
    return reply.type('text/plain').send(query.data['hub.challenge']);
  });
  app.post('/webhooks/whatsapp', async (req, reply) => {
    const signature = req.headers['x-hub-signature-256'];
    if (
      !verifyMetaSignature(
        req.rawBody,
        typeof signature === 'string' ? signature : undefined,
        env.WHATSAPP_APP_SECRET,
      )
    ) {
      req.log.warn({ event: 'whatsapp_signature_rejected', request_id: req.id });
      return reply.status(401).send({ error: 'Invalid signature' });
    }
    const parsed = parseWebhook(req.body, env.WHATSAPP_PHONE_NUMBER_ID || undefined);
    await inbox.receive(parsed.messages, parsed.statuses);
    return { received: true };
  });
  app.post('/webhooks/payment/freedompay', async (req, reply) => {
    if (provider.name !== 'freedompay') return reply.status(404).send({ error: 'Not configured' });
    try {
      const ack = await payments.receiveWebhook(
        provider,
        { body: req.body, rawBody: req.rawBody, headers: req.headers },
        req.id,
      );
      return reply
        .status(ack.statusCode ?? 200)
        .type(ack.contentType)
        .send(ack.body);
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      req.log.error({ event: 'payment_callback_retry', error: errorCode(error) });
      const ack = provider.acknowledge(req.body, false);
      return reply.status(503).type(ack.contentType).send(ack.body);
    }
  });
  app.get('/payment/success', async (_req, reply) =>
    reply
      .type('text/html')
      .send(
        paymentPage(
          'Спасибо. Проверяем статус оплаты.',
          'Вы получите подтверждение в WhatsApp. Эта страница не подтверждает оплату.',
        ),
      ),
  );
  app.get('/payment/failure', async (_req, reply) =>
    reply
      .type('text/html')
      .send(
        paymentPage(
          'Оплата не завершена.',
          'Вернитесь в WhatsApp и повторите попытку либо обратитесь к менеджеру.',
        ),
      ),
  );
  app.post('/webhooks/telegram', async (req, reply) => {
    if (!env.TELEGRAM_ENABLED || !env.MANAGER_HANDOFF_ENABLED)
      return reply.status(404).send({ error: 'Not configured' });
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (
      !env.TELEGRAM_WEBHOOK_SECRET ||
      typeof secret !== 'string' ||
      !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)
    )
      return reply.status(401).send({ error: 'Unauthorized' });
    return handoff.handleUpdate(req.body, secret);
  });
  // A capability for one mock attempt, separate from the local developer simulator.
  // Never register this checkout in production, regardless of provider injection.
  if (
    env.NODE_ENV !== 'production' &&
    env.INTEGRATION_MODE === 'staging' &&
    provider instanceof MockPaymentProvider
  ) {
    const checkout = provider;
    await app.register(async (mock) => {
      mock.addHook('onRequest', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        reply.header('Referrer-Policy', 'no-referrer');
        const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
        const query = z.object({ expires: z.string(), token: z.string() }).safeParse(req.query);
        if (
          !params.success ||
          !query.success ||
          !checkout.validateCheckoutToken(params.data.id, query.data.expires, query.data.token)
        )
          return reply.status(403).send({ error: 'Invalid or expired test payment link' });
        if (
          req.method === 'POST' &&
          req.headers.origin &&
          req.headers.origin !== new URL(env.APP_BASE_URL).origin
        )
          return reply.status(403).send({ error: 'Cross-origin request rejected' });
      });
      const attemptFor = async (params: unknown) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(params);
        const attempt = await db.paymentAttempt.findUnique({ where: { id } });
        if (!attempt || attempt.provider !== 'mock' || !attempt.externalPaymentId)
          throw Object.assign(new Error('Test payment not found'), { statusCode: 404 });
        return attempt;
      };
      mock.get('/mock-payment/:id', async (req, reply) => {
        const attempt = await attemptFor(req.params);
        return reply
          .type('text/html')
          .send(
            paymentPage(
              'Тестовая оплата / Сынақ төлемі',
              `${attempt.amount.toLocaleString('ru-RU')} ₸ · Это симуляция. Деньги не списываются. Ақша алынбайды.`,
              `<form method="post"><button name="status" value="SUCCESS">Успешная оплата</button> <button name="status" value="FAILED">Отказ</button></form>`,
            ),
          );
      });
      mock.post('/mock-payment/:id', async (req, reply) => {
        const attempt = await attemptFor(req.params);
        const { status } = z.object({ status: z.enum(['SUCCESS', 'FAILED']) }).parse(req.body);
        const event = await checkout.verifyWebhook(
          checkout.buildSignedPayload({
            externalPaymentId: attempt.externalPaymentId!,
            merchantReference: attempt.merchantReference,
            merchantId: attempt.merchantId,
            orderId: attempt.orderId,
            amount: attempt.amount,
            currency: attempt.currency,
            status: status === 'SUCCESS' ? 'PAID' : 'FAILED',
          }),
        );
        const result = await payments.apply(event, req.id);
        // The normal worker sends confirmation; the HTTP request never waits for Meta.
        if (req.headers.accept?.includes('text/html'))
          return reply
            .type('text/html')
            .send(
              paymentPage(
                'Тестовый callback обработан.',
                'Вернитесь в WhatsApp. Подтверждение отправит бот. Деньги не списывались.',
              ),
            );
        return { accepted: true, ...result };
      });
    });
  }
  async function releaseHandoff(id: string) {
    await db.$transaction(async (tx) => {
      const tickets = await tx.handoff.findMany({
        where: { customerId: id, status: { in: ['OPEN', 'ASSIGNED'] } },
      });
      for (const ticket of tickets) await handoff.close(tx, ticket.id, 'admin');
    });
  }
  await app.register(
    async (admin) => {
      admin.addHook('onRequest', async (req, reply) => {
        if (!safeEqual(req.headers.authorization ?? '', `Bearer ${env.ADMIN_TOKEN}`))
          return reply.status(401).send({ error: 'Unauthorized' });
      });
      const idSchema = z.object({ id: z.string().uuid() });
      admin.get('/status', async () => {
        const [jobs, inboxCounts, pendingPayments, incidents, handoffs, heartbeats, sheetLag] =
          await Promise.all([
            db.outboxJob.groupBy({ by: ['status'], _count: true }),
            db.webhookEvent.groupBy({ by: ['status'], _count: true }),
            db.paymentAttempt.count({
              where: {
                status: { in: ['CREATING', 'CREATION_UNKNOWN', 'PENDING', 'REVIEW_REQUIRED'] },
              },
            }),
            db.paymentIncident.findMany({
              where: { status: 'OPEN' },
              take: 100,
              orderBy: { createdAt: 'desc' },
            }),
            db.handoff.findMany({ where: { status: { in: ['OPEN', 'ASSIGNED'] } }, take: 100 }),
            db.workerHeartbeat.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 10 }),
            db.order.count({
              where: {
                paymentStatus: { in: ['PAID', 'REFUNDED'] },
                sheetSyncStatus: { not: 'SYNCED' },
              },
            }),
          ]);
        return {
          jobs,
          inbox: inboxCounts,
          pendingPayments,
          incidents,
          openHandoffs: handoffs,
          heartbeats,
          sheetLag,
          workerHealthy: heartbeats.some(
            (h) =>
              Date.now() - h.lastSeenAt.getTime() < 120000 &&
              h.lastSeenAt.getTime() <= Date.now() + 5000,
          ),
          checkout: businessGateReport(business, {
            mode: env.PAYMENT_PROVIDER === 'mock' ? 'demo' : 'live',
            catalogReady: catalog.productionReadiness().ready,
          }),
        };
      });
      admin.post('/incidents/:id/resolve', async (req) => {
        const { id } = idSchema.parse(req.params);
        const input = z
          .object({
            actor: z.string().min(1).max(100),
            comment: z.string().min(5).max(2000),
            releaseHold: z.boolean().default(false),
          })
          .parse(req.body);
        return payments.resolveIncident(id, input);
      });
      admin.post('/orders/:id/resync-sheet', async (req) => {
        const { id } = idSchema.parse(req.params);
        await db.$transaction(async (tx) => {
          await lock(tx, 'domain');
          const order = await tx.order.findUniqueOrThrow({ where: { id } });
          if (order.paymentStatus !== 'PAID') throw new PaymentValidationError('Only paid orders');
          if (order.sheetSyncStatus === 'SYNCED') return;
          const existing = await tx.outboxJob.findFirst({
            where: {
              orderId: id,
              kind: 'SHEETS',
              status: { in: ['RETRY', 'BLOCKED', 'DEAD', 'FAILED'] },
            },
            orderBy: { sequence: 'asc' },
          });
          if (existing)
            await tx.outboxJob.update({
              where: { id: existing.id },
              data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date() },
            });
          else
            await enqueue(tx, {
              key: `sheet:${id}:v${order.version}:manual:${randomUUID()}`,
              kind: 'SHEETS',
              orderId: id,
              payload: {},
            });
          await tx.auditLog.create({ data: { event: 'manual_sheet_retry', orderId: id } });
        });
        return { queued: true };
      });
      admin.post('/orders/:id/check-payment', async (req) => {
        const { id } = idSchema.parse(req.params);
        const order = await db.order.findUniqueOrThrow({ where: { id } });
        if (!order.externalPaymentId) throw new PaymentValidationError('Payment not created');
        const event = await provider.getPaymentStatus(order.externalPaymentId);
        return payments.apply(event, req.id);
      });
      admin.post('/customers/:id/release-handoff', async (req) => {
        await releaseHandoff(idSchema.parse(req.params).id);
        return { released: true };
      });
      admin.post('/inbox/:id/retry', async (req) => {
        const { id } = idSchema.parse(req.params);
        await db.$transaction(async (tx) => {
          const updated = await tx.webhookEvent.updateMany({
            where: {
              id,
              provider: 'whatsapp',
              processedAt: null,
              status: { in: ['DEAD', 'RETRY'] },
            },
            data: {
              status: 'RECEIVED',
              attempts: 0,
              nextAttemptAt: new Date(),
              lockToken: null,
              lockedUntil: null,
            },
          });
          await tx.auditLog.create({
            data: { event: 'manual_inbox_retry', details: { eventId: id, updated: updated.count } },
          });
        });
        return { queued: true };
      });
      admin.post('/jobs/:id/retry', async (req) => {
        const { id } = idSchema.parse(req.params);
        const input = z
          .object({
            acknowledgeDuplicateRisk: z.boolean().default(false),
            actor: z.string().min(1).default('admin'),
            comment: z.string().max(1000).default('Manual retry'),
          })
          .parse(req.body ?? {});
        return db.$transaction(async (tx) => {
          const job = await tx.outboxJob.findUniqueOrThrow({ where: { id } });
          if (job.status === 'PROCESSING' || job.status === 'DONE') return { queued: false };
          if (job.kind === 'CREATE_PAYMENT' && job.status === 'UNKNOWN')
            throw new PaymentValidationError('Reconcile payment creation; do not recreate');
          if (job.status === 'UNKNOWN' && !input.acknowledgeDuplicateRisk)
            throw new PaymentValidationError(
              'Unknown send may have succeeded; acknowledgeDuplicateRisk required',
            );
          await tx.outboxJob.update({
            where: { id },
            data: {
              status: 'PENDING',
              attempts: 0,
              nextAttemptAt: new Date(),
              lockToken: null,
              lockedUntil: null,
              dispatchStartedAt: null,
            },
          });
          await tx.auditLog.create({
            data: {
              event: 'manual_job_retry',
              orderId: job.orderId,
              customerId: job.customerId,
              details: { jobId: id, ...input, previousStatus: job.status },
            },
          });
          return { queued: true };
        });
      });
    },
    { prefix: '/admin' },
  );
  const demo =
    env.NODE_ENV !== 'production' && env.INTEGRATION_MODE === 'demo' && env.DEV_ROUTES_ENABLED;
  if (demo) {
    const fromSchema = z
      .string()
      .regex(/^\+?\d{7,15}$/)
      .transform((v) => v.replace(/^\+/, ''));
    const snapshot = async (from: string) => {
      const customer = await db.customer.findUnique({ where: { whatsappId: from } });
      if (!customer) return { customer: null, messages: [], orders: [], jobs: [], handoffs: [] };
      const [recent, orders, jobs, handoffs, incidents, telegramBindings, telegramMessages] =
        await Promise.all([
          db.message.findMany({
            where: { customerId: customer.id },
            orderBy: { createdAt: 'desc' },
            take: 150,
          }),
          db.order.findMany({
            where: { customerId: customer.id },
            include: { paymentAttempts: true },
            orderBy: { createdAt: 'desc' },
            take: 20,
          }),
          db.outboxJob.findMany({
            where: {
              OR: [
                { customerId: customer.id },
                {
                  orderId: {
                    in: (
                      await db.order.findMany({
                        where: { customerId: customer.id },
                        select: { id: true },
                      })
                    ).map((o) => o.id),
                  },
                },
              ],
            },
            select: { id: true, kind: true, status: true, attempts: true, lastError: true },
            orderBy: { sequence: 'desc' },
            take: 100,
          }),
          db.handoff.findMany({ where: { customerId: customer.id } }),
          db.paymentIncident.findMany({
            where: {
              orderId: {
                in: (
                  await db.order.findMany({
                    where: { customerId: customer.id },
                    select: { id: true },
                  })
                ).map((o) => o.id),
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
          }),
          db.telegramMessageBinding.findMany({
            where: { customerId: customer.id },
            orderBy: { createdAt: 'desc' },
            take: 50,
          }),
          db.outboxJob.findMany({
            where: { customerId: customer.id, kind: 'TELEGRAM' },
            select: { id: true, payload: true, status: true },
            take: 50,
            orderBy: { sequence: 'desc' },
          }),
        ]);
      return {
        customer,
        messages: recent.reverse(),
        orders,
        jobs: jobs.reverse(),
        handoffs,
        incidents,
        telegramBindings,
        telegramMessages,
        demoManagers: ['1001', '1002'],
      };
    };
    for (const [path, file, type] of [
      ['/', 'index.html', 'text/html'],
      ['/styles.css', 'styles.css', 'text/css'],
      ['/simulator.js', 'simulator.js', 'text/javascript'],
    ] as const)
      app.get(path, async (_req, reply) =>
        reply
          .type(type)
          .send(
            await readFile(
              new URL(`../public/${file}`, import.meta.url).pathname.replace(
                '/dist/public/',
                '/public/',
              ),
              'utf8',
            ),
          ),
      );
    await app.register(
      async (dev) => {
        dev.addHook('onRequest', async (req, reply) => {
          const origin = req.headers.origin;
          if (origin && origin !== env.APP_BASE_URL && origin !== `http://${req.headers.host}`)
            return reply.status(403).send({ error: 'Cross-origin request rejected' });
          const host = (req.headers.host ?? '').split(':')[0];
          if (!['localhost', '127.0.0.1', '['].includes(host!))
            return reply.status(403).send({ error: 'Demo endpoints are local only' });
        });
        dev.get('/config', async (_req, reply) =>
          reply.header('Cache-Control', 'no-store').send({
            ai: {
              provider: env.AI_PROVIDER,
              model: env.AI_PROVIDER === 'openai' ? env.OPENAI_MODEL : null,
            },
            sheets: {
              provider: env.GOOGLE_SHEETS_PROVIDER,
              enabled: env.GOOGLE_SHEETS_ENABLED,
              url:
                env.GOOGLE_SHEETS_ENABLED && env.GOOGLE_SHEETS_PROVIDER === 'google'
                  ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(env.GOOGLE_SHEETS_SPREADSHEET_ID)}/edit#gid=${env.GOOGLE_SHEETS_SHEET_ID}`
                  : null,
            },
            whatsapp: { provider: env.INTEGRATION_MODE === 'demo' ? 'demo' : 'meta' },
            telegram: {
              enabled: env.TELEGRAM_ENABLED,
              provider:
                env.TELEGRAM_ENABLED && env.INTEGRATION_MODE !== 'demo' ? 'telegram' : 'demo',
            },
            managerHandoffEnabled: env.MANAGER_HANDOFF_ENABLED,
            paymentProvider: env.PAYMENT_PROVIDER,
          }),
        );
        dev.get('/state', async (req) =>
          snapshot(fromSchema.parse((req.query as { from?: string }).from ?? '+77070000001')),
        );
        dev.post('/simulate-whatsapp', async (req) => {
          const input = z
            .object({
              from: fromSchema,
              type: z.enum(['text', 'interactive', 'button', 'unsupported']),
              text: z.string().max(4000).optional(),
              actionId: z.string().max(256).optional(),
              id: z.string().max(200).optional(),
            })
            .parse(req.body);
          if (
            (input.type === 'text' && !input.text?.trim()) ||
            (['interactive', 'button'].includes(input.type) && !input.actionId)
          )
            throw Object.assign(new Error('Message content required'), { statusCode: 400 });
          await inbox.receive([
            {
              ...input,
              id: input.id ?? `demo.${randomUUID()}`,
              ...(input.text ? { text: safeCustomerText(input.text) } : {}),
              timestamp: Date.now() / 1000,
            },
          ]);
          await worker.drain();
          return snapshot(input.from);
        });
        dev.post('/release-handoff', async (req) => {
          const { from } = z.object({ from: fromSchema }).parse(req.body);
          const customer = await db.customer.findUniqueOrThrow({ where: { whatsappId: from } });
          await releaseHandoff(customer.id);
          await worker.drain();
          return snapshot(from);
        });
        dev.post('/telegram', async (req) => {
          const input = z
            .object({
              managerId: z.enum(['1001', '1002']),
              text: z.string().min(1).max(4000),
              replyToMessageId: z.string().regex(/^\d+$/).optional(),
              updateId: z.number().int().nonnegative().optional(),
            })
            .parse(req.body);
          const now = Date.now();
          const result = await handoff.handleUpdate(
            {
              update_id: input.updateId ?? now,
              message: {
                message_id: Math.floor(now / 1000),
                chat: { id: Number(env.TELEGRAM_MANAGER_CHAT_ID || '-100123456789') },
                from: { id: Number(input.managerId), is_bot: false },
                text: input.text,
                ...(input.replyToMessageId
                  ? { reply_to_message: { message_id: Number(input.replyToMessageId) } }
                  : {}),
              },
            },
            env.TELEGRAM_WEBHOOK_SECRET || 'local-demo-webhook-secret-xxxxxxxx',
          );
          await worker.drain();
          return result;
        });
        const resolveAttempt = async (raw: unknown) => {
          const { id } = z.object({ id: z.string().uuid() }).parse(raw);
          const attempt =
            (await db.paymentAttempt.findUnique({ where: { id } })) ??
            (await db.paymentAttempt.findFirst({
              where: { orderId: id },
              orderBy: { createdAt: 'desc' },
            }));
          if (!attempt?.externalPaymentId) throw new PaymentValidationError('No payment attempt');
          return attempt;
        };
        dev.get('/mock-payment/:id', async (req, reply) => {
          const attempt = await resolveAttempt(req.params);
          return reply
            .type('text/html')
            .send(
              paymentPage(
                'Тестовая оплата',
                `${attempt.amount.toLocaleString('ru-RU')} ₸ · Это симуляция. Деньги не списываются.`,
                `<form method="post" action="/dev/mock-payment/${escapeHtml(attempt.id)}"><button name="status" value="SUCCESS">Успешная оплата</button> <button name="status" value="FAILED">Отказ</button></form><p><a href="/">Вернуться в симулятор</a></p>`,
              ),
            );
        });
        dev.post('/mock-payment/:id', async (req, reply) => {
          if (!(provider instanceof MockPaymentProvider))
            return reply.status(404).send({ error: 'Not configured' });
          const attempt = await resolveAttempt(req.params);
          const { status } = z.object({ status: z.enum(['SUCCESS', 'FAILED']) }).parse(req.body);
          const event = await provider.verifyWebhook(
            provider.buildSignedPayload({
              externalPaymentId: attempt.externalPaymentId!,
              orderId: attempt.orderId,
              amount: attempt.amount,
              currency: attempt.currency,
              status: status === 'SUCCESS' ? 'PAID' : 'FAILED',
            }),
          );
          const result = await payments.apply(event, req.id);
          await worker.drain();
          if (req.headers.accept?.includes('text/html'))
            return reply
              .type('text/html')
              .send(
                paymentPage(
                  'Тестовый callback обработан.',
                  'Вернитесь в симулятор: статус заказа обновлён.',
                  '<p><a href="/">Открыть симулятор</a></p>',
                ),
              );
          return { accepted: true, ...result };
        });
        dev.post('/webhooks/payment/mock', async (req, reply) => {
          if (provider.name !== 'mock') return reply.status(404).send();
          const event = await provider.verifyWebhook({
            body: req.body,
            rawBody: req.rawBody,
            headers: req.headers,
          });
          return payments.apply(event, req.id);
        });
      },
      { prefix: '/dev' },
    );
  } else app.get('/', async () => ({ service: 'music-box-ai-sales-agent', status: 'running' }));
  if (options.startWorker === true) worker.start();
  app.addHook('onClose', async () => {
    await worker.stop();
    if (!options.db) await db.$disconnect();
  });
  return { app, db, worker, provider, payments, inbox, env, catalog, handoff, sheets, business };
}
function paymentPage(title: string, description: string, extra = '') {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p>${extra}</main></body></html>`;
}
