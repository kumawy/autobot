import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { Prisma, type PrismaClient } from '@prisma/client';
import { lock, type Tx } from '../../db/prisma.js';

export const SESSION_LEASE_MS = 60000;
export function encryptAuth(value: unknown, hexKey: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(value, BufferJSON.replacer), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
export function decryptAuth(value: string, hexKey: string, context: string): unknown {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(hexKey, 'hex'),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
    BufferJSON.reviver,
  );
}

export class BaileysAuthStore {
  constructor(
    private db: PrismaClient,
    readonly sessionId: string,
    private ownerToken: string,
    private encryptionKey: string,
  ) {}
  async acquire(): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await lock(tx, `baileys-session:${this.sessionId}`);
      const session = await tx.whatsAppSession.upsert({
        where: { id: this.sessionId },
        create: { id: this.sessionId },
        update: {},
      });
      if (
        session.ownerToken &&
        session.ownerToken !== this.ownerToken &&
        session.leaseUntil &&
        session.leaseUntil > new Date()
      )
        return false;
      await tx.whatsAppSession.update({
        where: { id: this.sessionId },
        data: { ownerToken: this.ownerToken, leaseUntil: new Date(Date.now() + SESSION_LEASE_MS) },
      });
      return true;
    });
  }
  async assertOwnership(tx: Tx = this.db) {
    const updated = await tx.whatsAppSession.updateMany({
      where: { id: this.sessionId, ownerToken: this.ownerToken, leaseUntil: { gt: new Date() } },
      data: { leaseUntil: new Date(Date.now() + SESSION_LEASE_MS) },
    });
    if (!updated.count) throw new Error('BAILEYS_SESSION_OWNERSHIP_LOST');
  }
  async release() {
    await this.db.whatsAppSession.updateMany({
      where: { id: this.sessionId, ownerToken: this.ownerToken },
      data: { ownerToken: null, leaseUntil: null },
    });
  }
  async reset() {
    await this.db.$transaction(async (tx) => {
      await this.assertOwnership(tx);
      await tx.whatsAppAuthRecord.deleteMany({ where: { sessionId: this.sessionId } });
      await tx.whatsAppSession.update({
        where: { id: this.sessionId },
        data: { activatedAt: null },
      });
    });
  }
  private async read(key: string) {
    const row = await this.db.whatsAppAuthRecord.findUnique({
      where: { sessionId_key: { sessionId: this.sessionId, key } },
    });
    return row ? decryptAuth(row.value, this.encryptionKey, `${this.sessionId}:${key}`) : null;
  }
  private async write(tx: Tx, key: string, value: unknown) {
    if (value === null || value === undefined) {
      await tx.whatsAppAuthRecord.deleteMany({ where: { sessionId: this.sessionId, key } });
      return;
    }
    const encrypted = encryptAuth(value, this.encryptionKey, `${this.sessionId}:${key}`);
    await tx.whatsAppAuthRecord.upsert({
      where: { sessionId_key: { sessionId: this.sessionId, key } },
      create: { sessionId: this.sessionId, key, value: encrypted },
      update: { value: encrypted },
    });
  }
  async load(): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
    await this.assertOwnership();
    const creds = (await this.read('creds')) as AuthenticationState['creds'] | null;
    const state: AuthenticationState = {
      creds: creds ?? initAuthCreds(),
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          const rows = await this.db.whatsAppAuthRecord.findMany({
            where: { sessionId: this.sessionId, key: { in: ids.map((id) => `${type}:${id}`) } },
          });
          for (const row of rows) {
            const id = row.key.slice(type.length + 1);
            let value = decryptAuth(row.value, this.encryptionKey, `${this.sessionId}:${row.key}`);
            if (type === 'app-state-sync-key' && value)
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as Record<string, unknown>,
              );
            if (value) data[id] = value as SignalDataTypeMap[T];
          }
          return data;
        },
        set: async (data) => {
          const upserts: { key: string; value: string }[] = [];
          const removals: string[] = [];
          for (const [category, entries] of Object.entries(data))
            for (const [id, value] of Object.entries(entries ?? {})) {
              const key = `${category}:${id}`;
              if (value === null || value === undefined) removals.push(key);
              else
                upserts.push({
                  key,
                  value: encryptAuth(value, this.encryptionKey, `${this.sessionId}:${key}`),
                });
            }
          await this.db.$transaction(async (tx) => {
            await this.assertOwnership(tx);
            // Signal initialization can create hundreds of keys; batch to avoid one round trip per key.
            if (removals.length)
              await tx.whatsAppAuthRecord.deleteMany({
                where: { sessionId: this.sessionId, key: { in: removals } },
              });
            for (let offset = 0; offset < upserts.length; offset += 500) {
              const values = upserts
                .slice(offset, offset + 500)
                .map((row) => Prisma.sql`(${this.sessionId}, ${row.key}, ${row.value})`);
              await tx.$executeRaw(Prisma.sql`INSERT INTO "WhatsAppAuthRecord" ("sessionId", "key", "value")
                VALUES ${Prisma.join(values)} ON CONFLICT ("sessionId", "key") DO UPDATE SET "value"=EXCLUDED."value"`);
            }
          });
        },
      },
    };
    const saveCreds = async () => {
      await this.db.$transaction(async (tx) => {
        await this.assertOwnership(tx);
        await this.write(tx, 'creds', state.creds);
      });
    };
    if (!creds) await saveCreds();
    return { state, saveCreds };
  }
}
