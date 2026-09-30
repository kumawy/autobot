import { readEnv } from '../config/env.js';
import { createDatabase } from '../db/prisma.js';
const db = createDatabase(readEnv().DATABASE_URL);
try {
  const heartbeat = await db.workerHeartbeat.findFirst({
    where: { lastSeenAt: { gte: new Date(Date.now() - 120000), lte: new Date(Date.now() + 5000) } },
  });
  process.exitCode = heartbeat ? 0 : 1;
} finally {
  await db.$disconnect();
}
