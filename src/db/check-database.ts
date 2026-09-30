import { Client } from 'pg';
import { databaseCheckConfig } from './connection.js';
import { DatabaseUrlError } from './database-url.js';
import type { ClientConfig } from 'pg';

export interface DatabaseCheckClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
}
export type DatabaseCheckResult = { ok: boolean; message: string };
const failureCategories: Record<string, string> = {
  '28P01': 'authentication',
  '28000': 'authentication',
  '3D000': 'database unavailable',
  ENOTFOUND: 'network',
  EAI_AGAIN: 'network',
  ECONNREFUSED: 'network',
  ENETUNREACH: 'network',
  EHOSTUNREACH: 'network',
  ETIMEDOUT: 'timeout',
  '57014': 'timeout',
  CERT_HAS_EXPIRED: 'TLS',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS',
};
/** Whitelist categories only: driver errors can include hostname, username, password or SQL. */
function failure(error: unknown): DatabaseCheckResult {
  const category =
    error instanceof DatabaseUrlError
      ? 'configuration'
      : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? (failureCategories[error.code] ?? 'connection failed')
        : 'connection failed';
  return { ok: false, message: `Database connection: FAILED (${category})` };
}

/** Exactly one read-only query. It does not inspect application data or execute migrations. */
export async function checkDatabaseConnection(
  url: unknown,
  factory: (config: ClientConfig) => DatabaseCheckClient = (config) => new Client(config),
): Promise<DatabaseCheckResult> {
  let client: DatabaseCheckClient | undefined;
  let result: DatabaseCheckResult;
  try {
    // Undefined is rejected by the shared validator without ever constructing a driver client.
    const config = databaseCheckConfig(url as string);
    client = factory(config);
    await client.connect();
    await client.query('SELECT 1');
    result = { ok: true, message: 'Database connection: OK' };
  } catch (error) {
    result = failure(error);
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        /* Disconnect details must not leak credentials. */
      }
    }
  }
  return result;
}
