import 'dotenv/config';
import { readEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/prisma.js';
const env = readEnv();
const db = createDatabase(env.DATABASE_URL);
try {
  const legacy = await db.paymentAttempt.findMany({
    where: {
      provider: 'freedompay',
      merchantId: 'demo',
      snapshot: { path: ['legacyMigration'], equals: true },
    },
    select: { id: true, orderId: true, externalPaymentId: true },
  });
  if (legacy.length && !env.FREEDOMPAY_MERCHANT_ID)
    throw new Error(
      'Legacy Freedom Pay records require configured merchant ID; do not process real callbacks until reconciled',
    );
  if (process.argv.includes('--apply'))
    await db.$transaction(async (tx) => {
      for (const attempt of legacy)
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { merchantId: env.FREEDOMPAY_MERCHANT_ID },
        });
      await tx.auditLog.create({
        data: {
          event: 'legacy_merchant_migration',
          details: { count: legacy.length, merchantId: env.FREEDOMPAY_MERCHANT_ID },
        },
      });
    });
  console.log(
    JSON.stringify({ applied: process.argv.includes('--apply'), legacyAttempts: legacy }, null, 2),
  );
} finally {
  await db.$disconnect();
}
