import { describe, expect, it, vi } from 'vitest';
import { Pool, type ClientConfig } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  DatabaseUrlError,
  migrationDatabaseUrl,
  runtimeDatabaseUrl,
  validateDatabaseUrl,
} from '../../src/db/database-url.js';
import { databasePoolConfig } from '../../src/db/connection.js';
import { checkDatabaseConnection } from '../../src/db/check-database.js';

const local = 'postgresql://test:test@127.0.0.1:5432/test';
const session =
  'postgresql://postgres.example:fixture-secret@aws-0-example.pooler.supabase.com:5432/postgres?sslmode=verify-full';
const transaction = session.replace(':5432/', ':6543/');
const direct =
  'postgresql://postgres:fixture-secret@db.example.supabase.co:5432/postgres?sslmode=verify-full';

describe('Database URLs and migration routing', () => {
  it.each([
    local,
    session,
    transaction,
    direct,
    'postgres://user@localhost/local',
    'postgresql://user:encoded%40p%23ss%3Fword@[::1]:5432/local',
  ])('accepts supported explicit runtime URI %#', (url) => {
    expect(validateDatabaseUrl(url)).toBe(url);
  });
  it('uses DIRECT_URL for migrations and preserves local DATABASE_URL fallback', () => {
    expect(migrationDatabaseUrl({ DATABASE_URL: transaction, DIRECT_URL: session })).toBe(session);
    expect(migrationDatabaseUrl({ DATABASE_URL: transaction, DIRECT_URL: direct })).toBe(direct);
    expect(migrationDatabaseUrl({ DATABASE_URL: local, DIRECT_URL: '' })).toBe(local);
    expect(migrationDatabaseUrl({})).toContain('@127.0.0.1:55432/');
  });
  it.each([transaction, `${local}?pgbouncer=true`])(
    'prevents migration via known transaction-pooler URI %#',
    (url) => {
      expect(() => migrationDatabaseUrl({ DATABASE_URL: url })).toThrow('configure DIRECT_URL');
      expect(() => migrationDatabaseUrl({ DATABASE_URL: local, DIRECT_URL: url })).toThrow(
        'configure DIRECT_URL',
      );
    },
  );
  it.each([
    undefined,
    '',
    ' https://invalid.example/db',
    'https://user:secret@example.com/db',
    'postgresql://user:secret@host/',
    'postgresql://user:secret@host/db/extra',
    'postgresql://user:secret@host/db#fragment',
    'postgresql://user:secret@host:0/db',
    'postgresql://user:%nothex@host/db',
    'postgresql://user:password\n@host/db',
  ])('rejects malformed URI without exposing input %#', (value) => {
    expect(() => validateDatabaseUrl(value)).toThrow(DatabaseUrlError);
    try {
      validateDatabaseUrl(value);
    } catch (error) {
      expect(String(error)).not.toContain('secret');
      expect(String(error)).not.toContain('postgresql://');
    }
  });
  it.each([
    'postgresql://postgres@[::ffff:192.0.2.1]:5432/db',
    'postgresql://postgres:@db.example.supabase.co:5432/postgres?sslmode=verify-full',
    'postgresql://:fixture-password@db.example.supabase.co:5432/postgres?sslmode=verify-full',
    'postgresql://postgres:%5BYOUR-PASSWORD%5D@db.example.supabase.co:5432/postgres?sslmode=verify-full',
    'postgresql://postgres:<password>@db.example.supabase.co:5432/postgres?sslmode=verify-full',
  ])('rejects missing or placeholder credentials %#', (url) =>
    expect(() => validateDatabaseUrl(url)).toThrow(DatabaseUrlError),
  );
  it.each([
    '',
    '?sslmode=disable',
    '?sslmode=no-verify',
    '?sslmode=prefer',
    '?ssl=false',
    '?sslmode=require&sslmode=disable',
    '?sslmode=verify-full&sslMode=disable',
  ])('requires unambiguous TLS for Supabase %#', (suffix) => {
    expect(() => validateDatabaseUrl(direct.split('?')[0] + suffix)).toThrow(DatabaseUrlError);
  });
  it.each([
    'host=other.example',
    'port=6543',
    'user=another',
    'password=another',
    'dbname=another',
    'options=-c%20timezone=Asia%2FAlmaty',
    'uselibpqcompat=true',
  ])('blocks query parameters overriding validated identity or driver invariants: %s', (suffix) => {
    expect(() => validateDatabaseUrl(`${local}?${suffix}`)).toThrow('connection options');
  });
  it('pins require to verify-full for native pg without disabling certificate verification', () => {
    expect(runtimeDatabaseUrl(transaction.replace('verify-full', 'require'))).toBe(transaction);
    const config = databasePoolConfig(transaction);
    expect(config).toMatchObject({
      connectionString: transaction,
      max: 10,
      connectionTimeoutMillis: 5000,
      options: '-c timezone=UTC',
    });
    expect(config.ssl).toBeUndefined();
    expect(config).not.toHaveProperty('statementNameGenerator');
  });
  it('does not accidentally classify a Supabase-looking unrelated domain as managed Supabase', () => {
    expect(
      validateDatabaseUrl('postgresql://test:fixture@supabase.co.example.org:5432/test'),
    ).toContain('supabase.co.example.org');
  });
});

describe('Read-only database diagnostic', () => {
  it('runs exactly SELECT 1 and always disconnects, without returning URL or rows', async () => {
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [{ password: 'must not print' }] }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const factory = vi.fn((_config: ClientConfig) => client);
    expect(await checkDatabaseConnection(local, factory)).toEqual({
      ok: true,
      message: 'Database connection: OK',
    });
    expect(client.query).toHaveBeenCalledExactlyOnceWith('SELECT 1');
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      statement_timeout: 5000,
    });
  });
  it('does not create a client or attempt network access when configuration is missing', async () => {
    const factory = vi.fn();
    expect(await checkDatabaseConnection(undefined, factory)).toEqual({
      ok: false,
      message: 'Database connection: FAILED (configuration)',
    });
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([
    ['28P01', 'authentication'],
    ['ENOTFOUND', 'network'],
    ['ETIMEDOUT', 'timeout'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS'],
    ['arbitrary-secret-code', 'connection failed'],
  ])('sanitizes driver failure %s', async (code, category) => {
    const client = {
      connect: vi.fn().mockRejectedValue(
        Object.assign(new Error(`Credentials ${direct}`), {
          code,
          detail: 'secret-password',
          cause: new Error(direct),
        }),
      ),
      query: vi.fn(),
      end: vi.fn().mockRejectedValue(new Error(direct)),
    };
    expect(await checkDatabaseConnection(direct, () => client)).toEqual({
      ok: false,
      message: `Database connection: FAILED (${category})`,
    });
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });
  it('handles construction and query errors with the same sanitized boundary', async () => {
    expect(
      (
        await checkDatabaseConnection(local, () => {
          throw new Error(direct);
        })
      ).message,
    ).toBe('Database connection: FAILED (connection failed)');
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(new Error(direct)),
      end: vi.fn().mockResolvedValue(undefined),
    };
    expect((await checkDatabaseConnection(local, () => client)).ok).toBe(false);
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});

describe('Installed Prisma native pg transaction-pooler contract', () => {
  it('uses unnamed queries by default, so no prepared statement cache is carried across transactions', async () => {
    const pool = new Pool(databasePoolConfig(transaction));
    const query = vi.fn(async (_config: unknown) => ({
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [
        {
          name: 'value',
          tableID: 0,
          columnID: 0,
          dataTypeID: 23,
          dataTypeSize: 4,
          dataTypeModifier: -1,
          format: 'text',
        },
      ],
      rows: [[1]],
    }));
    vi.spyOn(pool, 'query').mockImplementation(query as unknown as typeof pool.query);
    const adapter = await new PrismaPg(pool, { disposeExternalPool: true }).connect();
    try {
      const result = await adapter.queryRaw({ sql: 'SELECT 1', args: [], argTypes: [] });
      expect(result.rows).toEqual([[1]]);
      expect(query).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: 'SELECT 1', name: undefined, values: [] }),
      );
    } finally {
      await adapter.dispose();
    }
  });
});
