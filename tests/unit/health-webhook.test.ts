import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { readEnv } from '../../src/config/env.js';

const env = readEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  ADMIN_TOKEN: 'a'.repeat(32),
  MOCK_PAYMENT_SECRET: 'm'.repeat(32),
  WHATSAPP_VERIFY_TOKEN: 'verify-token-test',
  WHATSAPP_APP_SECRET: 'app-secret-test',
  LOG_LEVEL: 'silent',
});
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const runtime of apps.splice(0)) await runtime.app.close();
});
async function app(query = vi.fn().mockResolvedValue([{ value: 1 }])) {
  const runtime = await buildApp({
    env,
    logger: false,
    db: { $queryRaw: query } as unknown as PrismaClient,
  });
  apps.push(runtime);
  return runtime.app;
}

describe('database health', () => {
  it('checks the database on each request', async () => {
    const query = vi.fn().mockResolvedValue([{ value: 1 }]);
    const server = await app(query);
    for (const url of ['/health', '/ready']) {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', database: 'connected' });
    }
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('returns a redacted 503 when PostgreSQL is unavailable', async () => {
    const server = await app(vi.fn().mockRejectedValue(new Error('password=private-host-secret')));
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'degraded', database: 'disconnected' });
    expect(response.body).not.toContain('private-host-secret');
  });
});

describe('Meta webhook verification', () => {
  it('returns the exact challenge only for a valid subscription', async () => {
    const server = await app();
    const result = await server.inject({
      method: 'GET',
      url: '/webhooks/whatsapp',
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': env.WHATSAPP_VERIFY_TOKEN,
        'hub.challenge': 'challenge-001',
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('challenge-001');
    expect(result.headers['content-type']).toContain('text/plain');
  });
  it.each([
    { 'hub.mode': 'unsubscribe', 'hub.verify_token': env.WHATSAPP_VERIFY_TOKEN },
    { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token' },
  ])('forbids invalid mode or token', async (query) => {
    const server = await app();
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/webhooks/whatsapp',
          query: { ...query, 'hub.challenge': 'private-challenge' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('handles missing verification parameters and rejects unsigned synthetic webhooks', async () => {
    const server = await app();
    expect((await server.inject({ method: 'GET', url: '/webhooks/whatsapp' })).statusCode).toBe(
      400,
    );
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/webhooks/whatsapp',
          payload: { object: 'whatsapp_business_account', entry: [] },
        })
      ).statusCode,
    ).toBe(401);
  });
});
