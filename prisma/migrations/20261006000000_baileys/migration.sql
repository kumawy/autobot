CREATE TABLE "WhatsAppSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "WhatsAppAuthRecord" (
  "sessionId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  CONSTRAINT "WhatsAppAuthRecord_pkey" PRIMARY KEY ("sessionId", "key")
);
