import { createPrivateKey } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

export interface GoogleSheetsCredentialInput {
  GOOGLE_APPLICATION_CREDENTIALS?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
}

export interface GoogleSheetsCredentials {
  serviceAccountEmail: string;
  privateKey: string;
}

export class GoogleSheetsCredentialsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GoogleSheetsCredentialsError';
  }
}

const MAX_CREDENTIAL_BYTES = 64 * 1024;
export function isGoogleAccountEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateCredentials(email: unknown, key: unknown): GoogleSheetsCredentials {
  if (typeof email !== 'string' || typeof key !== 'string')
    throw new GoogleSheetsCredentialsError('GOOGLE_CREDENTIALS_INVALID');
  const serviceAccountEmail = email.trim();
  const privateKey = key.replace(/\\n/g, '\n').trim();
  if (!isGoogleAccountEmail(serviceAccountEmail) || privateKey.length > MAX_CREDENTIAL_BYTES)
    throw new GoogleSheetsCredentialsError('GOOGLE_CREDENTIALS_INVALID');
  try {
    if (!/^-----BEGIN (?:RSA )?PRIVATE KEY-----\n/.test(privateKey)) throw new Error();
    const parsed = createPrivateKey(privateKey);
    if (parsed.asymmetricKeyType !== 'rsa') throw new Error();
  } catch {
    throw new GoogleSheetsCredentialsError('GOOGLE_CREDENTIALS_INVALID');
  }
  return { serviceAccountEmail, privateKey };
}

/** Explicit files take precedence. Never fall back after a bad file or print key material. */
export function loadGoogleSheetsCredentials(
  input: GoogleSheetsCredentialInput,
): GoogleSheetsCredentials {
  const path = input.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (path) {
    let contents: string;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'r');
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CREDENTIAL_BYTES) throw new Error();
      contents = readFileSync(descriptor, 'utf8');
      if (Buffer.byteLength(contents) > MAX_CREDENTIAL_BYTES) throw new Error();
    } catch {
      throw new GoogleSheetsCredentialsError('GOOGLE_CREDENTIALS_FILE_UNREADABLE');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new GoogleSheetsCredentialsError('GOOGLE_CREDENTIALS_FILE_INVALID');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new GoogleSheetsCredentialsError('GOOGLE_CREDENTIALS_FILE_INVALID');
    const account = value as Record<string, unknown>;
    if (account.type !== 'service_account')
      throw new GoogleSheetsCredentialsError('GOOGLE_CREDENTIALS_FILE_INVALID');
    return validateCredentials(account.client_email, account.private_key);
  }
  if (!input.GOOGLE_SERVICE_ACCOUNT_EMAIL || !input.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)
    throw new GoogleSheetsCredentialsError('GOOGLE_CREDENTIALS_MISSING');
  return validateCredentials(
    input.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    input.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  );
}
