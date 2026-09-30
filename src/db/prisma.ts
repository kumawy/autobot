import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { databasePoolConfig } from './connection.js';
export type Tx = Prisma.TransactionClient;
export function createDatabase(url: string) {
  return new PrismaClient({
    adapter: new PrismaPg(databasePoolConfig(url)),
  });
}
export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function lock(tx: Tx, key: string) {
  await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${key},0))`;
}
export async function tryLock(tx: Tx, key: string): Promise<boolean> {
  const rows = await tx.$queryRaw<
    { locked: boolean }[]
  >`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS locked`;
  return rows[0]?.locked === true;
}
