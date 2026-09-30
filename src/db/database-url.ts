/** URL validation is deliberately independent of Prisma, pg and dotenv for CLI config use. */
export type DatabaseUrlPurpose = 'runtime' | 'migration';
export type DatabaseUrlErrorCode =
  | 'DATABASE_URL_MISSING'
  | 'DATABASE_URL_INVALID'
  | 'DATABASE_CREDENTIALS_MISSING'
  | 'DATABASE_URL_PLACEHOLDER'
  | 'DATABASE_TLS_REQUIRED'
  | 'DATABASE_URL_UNSAFE_OPTIONS'
  | 'DATABASE_MIGRATION_POOLER';
const messages: Record<DatabaseUrlErrorCode, string> = {
  DATABASE_URL_MISSING: 'Database URL is not configured',
  DATABASE_URL_INVALID: 'Database URL must be a valid PostgreSQL connection URI',
  DATABASE_CREDENTIALS_MISSING: 'Database credentials are incomplete',
  DATABASE_URL_PLACEHOLDER: 'Database URL still contains a placeholder',
  DATABASE_TLS_REQUIRED: 'Supabase database connections require verified TLS',
  DATABASE_URL_UNSAFE_OPTIONS: 'Database URL contains unsupported or ambiguous connection options',
  DATABASE_MIGRATION_POOLER:
    'Migrations require a direct or session connection; configure DIRECT_URL',
};
export class DatabaseUrlError extends Error {
  constructor(readonly code: DatabaseUrlErrorCode) {
    super(messages[code]);
    this.name = 'DatabaseUrlError';
  }
}
const overrideParameters = new Set([
  'host',
  'hostaddr',
  'port',
  'user',
  'username',
  'password',
  'database',
  'dbname',
  'connectionstring',
  'options',
  'ssl',
  'uselibpqcompat',
]);
const placeholders =
  /\[(?:your[-_ ]?)?(?:password|db[-_ ]?password|db[-_ ]?user|project[-_ ]?ref|pooler[-_ ]?host)[^\]]*\]|<[^>]+>|(?:^|[:/@])(?:YOUR_PASSWORD|YOUR_DB_PASSWORD|REPLACE_ME|CHANGE_ME)(?:$|[:/@])/i;
const isSupabase = (hostname: string) => /(?:^|\.)supabase\.(?:co|com)$/.test(hostname);
const isLocal = (hostname: string) =>
  ['localhost', '127.0.0.1', '[::1]', 'db', 'postgres'].includes(hostname);

/** Never include the input or a URL parser cause in an exception: the URI contains a password. */
export function validateDatabaseUrl(
  value: unknown,
  purpose: DatabaseUrlPurpose = 'runtime',
): string {
  if (typeof value !== 'string' || !value) throw new DatabaseUrlError('DATABASE_URL_MISSING');
  if (
    value !== value.trim() ||
    /\s/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  )
    throw new DatabaseUrlError('DATABASE_URL_INVALID');
  let url: URL;
  let decoded: string;
  try {
    url = new URL(value);
    decoded = decodeURIComponent(value);
  } catch {
    throw new DatabaseUrlError('DATABASE_URL_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    url.hash ||
    !/^\/[^/]+$/.test(url.pathname) ||
    url.port === '0'
  ) {
    throw new DatabaseUrlError('DATABASE_URL_INVALID');
  }
  if (placeholders.test(decoded)) throw new DatabaseUrlError('DATABASE_URL_PLACEHOLDER');
  if (!url.username || (!url.password && !isLocal(url.hostname)))
    throw new DatabaseUrlError('DATABASE_CREDENTIALS_MISSING');
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    const normalized = key.toLowerCase();
    if (seen.has(normalized) || overrideParameters.has(normalized))
      throw new DatabaseUrlError('DATABASE_URL_UNSAFE_OPTIONS');
    seen.add(normalized);
  }
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode && !['disable', 'require', 'verify-full'].includes(sslmode))
    throw new DatabaseUrlError('DATABASE_URL_UNSAFE_OPTIONS');
  if (isSupabase(url.hostname) && !['require', 'verify-full'].includes(sslmode ?? ''))
    throw new DatabaseUrlError('DATABASE_TLS_REQUIRED');
  if (
    purpose === 'migration' &&
    (url.port === '6543' || url.searchParams.get('pgbouncer') === 'true')
  )
    throw new DatabaseUrlError('DATABASE_MIGRATION_POOLER');
  return value;
}

/** Prisma 7 CLI datasource is independent of the application driver's DATABASE_URL. */
export function migrationDatabaseUrl(env: { DIRECT_URL?: string; DATABASE_URL?: string }): string {
  return validateDatabaseUrl(
    env.DIRECT_URL || env.DATABASE_URL || 'postgresql://musicbox:musicbox@127.0.0.1:55432/musicbox',
    'migration',
  );
}

/** Pin the installed pg driver's verified-TLS behavior instead of its ambiguous require alias. */
export function runtimeDatabaseUrl(value: string): string {
  const url = new URL(validateDatabaseUrl(value));
  if (url.searchParams.get('sslmode') === 'require') url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}
