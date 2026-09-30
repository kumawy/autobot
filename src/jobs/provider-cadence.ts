import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '@prisma/client';
import { lock } from '../db/prisma.js';
import { PaymentProviderError } from '../modules/payments/payment-provider.interface.js';
/** Reserve one provider request slot, then wait outside the database transaction. */
export async function waitForProviderSlot(db: PrismaClient, provider: string, intervalMs: number) {
  const wait = await db.$transaction(async (tx) => {
    const key = `provider-status-cadence:${provider}`;
    await lock(tx, key);
    const setting = await tx.businessSetting.findUnique({ where: { key } });
    const next =
      setting?.value && typeof setting.value === 'object' && !Array.isArray(setting.value)
        ? Number(setting.value.nextAt ?? 0)
        : 0;
    const at = Math.max(Date.now(), Number.isFinite(next) ? next : 0);
    const wait = at - Date.now();
    if (wait > 15000)
      throw new PaymentProviderError(
        'Provider status queue is busy',
        'PROVIDER_CADENCE_BUSY',
        wait,
      );
    await tx.businessSetting.upsert({
      where: { key },
      create: { key, value: { nextAt: at + intervalMs } },
      update: { value: { nextAt: at + intervalMs } },
    });
    return Math.max(0, wait);
  });
  if (wait) await delay(wait);
}
