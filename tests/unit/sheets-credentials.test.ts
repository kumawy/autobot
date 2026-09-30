import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GoogleSheetsCredentialsError,
  loadGoogleSheetsCredentials,
} from '../../src/modules/sheets/credentials.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;
const email = 'sheets@unit-test.iam.gserviceaccount.com';
const folders: string[] = [];
function credentialFile(value: unknown, raw = false): string {
  const folder = mkdtempSync(join(tmpdir(), 'sheets-credentials-test-'));
  folders.push(folder);
  const path = join(folder, 'account.json');
  writeFileSync(path, raw ? String(value) : JSON.stringify(value), { mode: 0o600 });
  return path;
}
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('service-account credentials without implicit network or secret output', () => {
  it('accepts inline RSA keys and normalizes escaped newlines', () => {
    expect(
      loadGoogleSheetsCredentials({
        GOOGLE_SERVICE_ACCOUNT_EMAIL: ` ${email} `,
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
      }),
    ).toEqual({ serviceAccountEmail: email, privateKey: privateKey.trim() });
  });

  it('loads a local service-account JSON and gives it explicit precedence', () => {
    const path = credentialFile({
      type: 'service_account',
      client_email: email,
      private_key: privateKey,
    });
    expect(
      loadGoogleSheetsCredentials({
        GOOGLE_APPLICATION_CREDENTIALS: path,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: 'ignored@example.test',
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'ignored',
      }),
    ).toEqual({ serviceAccountEmail: email, privateKey: privateKey.trim() });
  });

  it.each([
    {},
    { GOOGLE_SERVICE_ACCOUNT_EMAIL: email },
    { GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey },
  ])('fails closed when inline credentials are incomplete', (input) => {
    expect(() => loadGoogleSheetsCredentials(input)).toThrow('GOOGLE_CREDENTIALS_MISSING');
  });

  it('does not fall back to an inline key when an explicit file is unreadable', () => {
    expect(() =>
      loadGoogleSheetsCredentials({
        GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/private-sensitive-name.json',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: email,
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
      }),
    ).toThrow('GOOGLE_CREDENTIALS_FILE_UNREADABLE');
  });

  it.each([
    { type: 'authorized_user', refresh_token: 'secret' },
    [],
    null,
    { client_email: email, private_key: privateKey },
  ])('rejects non service-account documents', (contents) => {
    expect(() =>
      loadGoogleSheetsCredentials({ GOOGLE_APPLICATION_CREDENTIALS: credentialFile(contents) }),
    ).toThrow('GOOGLE_CREDENTIALS_FILE_INVALID');
  });

  it('sanitizes malformed JSON without exposing its contents or file path', () => {
    const path = credentialFile('{"secret":"do-not-print-this",', true);
    try {
      loadGoogleSheetsCredentials({ GOOGLE_APPLICATION_CREDENTIALS: path });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleSheetsCredentialsError);
      expect(String(error)).toBe('GoogleSheetsCredentialsError: GOOGLE_CREDENTIALS_FILE_INVALID');
      expect(String(error)).not.toContain(path);
    }
  });

  it('rejects oversized local input before parsing it', () => {
    expect(() =>
      loadGoogleSheetsCredentials({
        GOOGLE_APPLICATION_CREDENTIALS: credentialFile('x'.repeat(65537), true),
      }),
    ).toThrow('GOOGLE_CREDENTIALS_FILE_UNREADABLE');
  });

  it.each(['not-an-email', 'one@example.test\ntwo@example.test', 'x@'])(
    'rejects invalid email %s',
    (invalidEmail) => {
      expect(() =>
        loadGoogleSheetsCredentials({
          GOOGLE_SERVICE_ACCOUNT_EMAIL: invalidEmail,
          GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
        }),
      ).toThrow('GOOGLE_CREDENTIALS_INVALID');
    },
  );

  it('rejects invalid PEM without including it in the error', () => {
    expect(() =>
      loadGoogleSheetsCredentials({
        GOOGLE_SERVICE_ACCOUNT_EMAIL: email,
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'private-secret',
      }),
    ).toThrow('GOOGLE_CREDENTIALS_INVALID');
  });

  it('rejects keys unsuitable for service-account RS256 signing', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    expect(() =>
      loadGoogleSheetsCredentials({
        GOOGLE_SERVICE_ACCOUNT_EMAIL: email,
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: ec,
      }),
    ).toThrow('GOOGLE_CREDENTIALS_INVALID');
  });
});
