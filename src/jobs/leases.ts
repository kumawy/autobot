import { randomUUID } from 'node:crypto';
import type { OutboxJob, PrismaClient } from '@prisma/client';
import { enqueue } from './outbox.js';
export const LEASE_MS = 60000;
export async function recoverLeases(db: PrismaClient, maxAttempts = 8) {
  await db.$transaction(async (tx) => {
    const expired = await tx.$queryRaw<
      OutboxJob[]
    >`SELECT * FROM "OutboxJob" WHERE status='PROCESSING' AND "lockedUntil"<now() FOR UPDATE SKIP LOCKED`;
    for (const job of expired) {
      const uncertain =
        job.dispatchStartedAt && ['WHATSAPP', 'TELEGRAM', 'CREATE_PAYMENT'].includes(job.kind);
      const receipt =
        job.kind === 'WHATSAPP'
          ? await tx.message.findUnique({ where: { outboxJobId: job.id } })
          : null;
      const confirmed =
        !!receipt?.whatsappMessageId &&
        ['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(receipt?.deliveryStatus ?? '');
      await tx.outboxJob.update({
        where: { id: job.id },
        data: {
          status: confirmed
            ? 'DONE'
            : uncertain
              ? 'UNKNOWN'
              : job.attempts >= maxAttempts
                ? 'DEAD'
                : 'RETRY',
          lockToken: null,
          lockedUntil: null,
          lastError: confirmed
            ? null
            : uncertain
              ? 'LEASE_EXPIRED_AFTER_DISPATCH'
              : 'LEASE_EXPIRED',
          completedAt: confirmed ? new Date() : undefined,
          nextAttemptAt: new Date(),
        },
      });
      if (job.kind === 'WHATSAPP' && uncertain && !confirmed)
        await tx.message.updateMany({
          where: { outboxJobId: job.id, deliveryStatus: 'PENDING' },
          data: { deliveryStatus: 'UNKNOWN', deliveryError: 'LEASE_EXPIRED_AFTER_DISPATCH' },
        });
      if (job.kind === 'CREATE_PAYMENT' && uncertain) {
        const { attemptId } = job.payload as { attemptId: string };
        await tx.paymentAttempt.updateMany({
          where: { id: attemptId, status: 'CREATING' },
          data: { status: 'CREATION_UNKNOWN' },
        });
        await enqueue(tx, {
          key: `reconcile:${attemptId}:recovery`,
          kind: 'PAYMENT_RECONCILE',
          orderId: job.orderId ?? undefined,
          payload: { attemptId },
        });
      }
    }
    await tx.webhookEvent.updateMany({
      where: { status: 'PROCESSING', lockedUntil: { lt: new Date() } },
      data: { status: 'RETRY', lockToken: null, lockedUntil: null, nextAttemptAt: new Date() },
    });
    await tx.webhookEvent.updateMany({
      where: { status: 'RETRY', attempts: { gte: maxAttempts } },
      data: { status: 'DEAD' },
    });
    await tx.customer.updateMany({
      where: { processingUntil: { lt: new Date() } },
      data: { processingToken: null, processingUntil: null },
    });
  });
}
export async function claimJob(db: PrismaClient, maxAttempts: number): Promise<OutboxJob | null> {
  return db.$transaction(async (tx) => {
    const jobs = await tx.$queryRaw<
      OutboxJob[]
    >`SELECT j.* FROM "OutboxJob" j WHERE j.status IN ('PENDING','RETRY') AND j."nextAttemptAt"<=now() AND j.attempts<${maxAttempts}
      AND NOT EXISTS (SELECT 1 FROM "OutboxJob" active WHERE active.status='PROCESSING' AND active."resourceKey"=j."resourceKey")
      AND NOT EXISTS (SELECT 1 FROM "OutboxJob" prior WHERE prior.status IN ('PENDING','RETRY','PROCESSING') AND prior."resourceKey"=j."resourceKey" AND prior.sequence<j.sequence)
      ORDER BY j.sequence FOR UPDATE OF j SKIP LOCKED LIMIT 1`;
    const job = jobs[0];
    if (!job) return null;
    // A short advisory lock closes the race between different rows sharing a resource.
    if (job.resourceKey) {
      const r = await tx.$queryRaw<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtextextended(${job.resourceKey},0)) AS locked`;
      if (!r[0]?.locked) return null;
      if (
        await tx.outboxJob.count({ where: { resourceKey: job.resourceKey, status: 'PROCESSING' } })
      )
        return null;
    }
    return tx.outboxJob.update({
      where: { id: job.id },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        lockToken: randomUUID(),
        lockedUntil: new Date(Date.now() + LEASE_MS),
        dispatchStartedAt: null,
      },
    });
  });
}
