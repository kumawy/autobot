import type { Tx } from '../db/prisma.js';
import { json } from '../db/prisma.js';
export async function enqueue(
  tx: Tx,
  input: { key: string; kind: string; customerId?: string; orderId?: string; payload: unknown },
) {
  await tx.outboxJob.upsert({
    where: { dedupeKey: input.key },
    create: {
      dedupeKey: input.key,
      kind: input.kind,
      customerId: input.customerId,
      orderId: input.orderId,
      payload: json(input.payload),
      resourceKey:
        input.kind === 'SHEETS'
          ? `sheet:${input.orderId}`
          : ['CREATE_PAYMENT', 'PAYMENT_RECONCILE', 'PAYMENT_EVENT'].includes(input.kind)
            ? `payment:${input.orderId ?? input.key}`
            : input.customerId
              ? `customer:${input.customerId}:${input.kind}`
              : null,
    },
    update: {},
  });
}
export function retryDelay(attempt: number): number {
  return [60000, 300000, 900000, 3600000][Math.min(Math.max(attempt - 1, 0), 3)]!;
}
