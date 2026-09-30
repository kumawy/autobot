import type { ClientConfig, PoolConfig } from 'pg';
import { runtimeDatabaseUrl } from './database-url.js';

/** Native pg pool settings; Prisma URL connection_limit/pgbouncer flags do not configure it. */
export function databasePoolConfig(url: string): PoolConfig {
  return {
    connectionString: runtimeDatabaseUrl(url),
    connectionTimeoutMillis: 5000,
    max: 10,
    // Keep DB/role UTC on Supabase too; transaction poolers cannot guarantee session state.
    options: '-c timezone=UTC',
  };
}
export function databaseCheckConfig(url: string): ClientConfig {
  const { max: _, ...config } = databasePoolConfig(url);
  return { ...config, query_timeout: 5000, statement_timeout: 5000 };
}
