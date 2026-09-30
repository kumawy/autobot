-- CreateEnum
CREATE TYPE "InboxStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'RETRY', 'DEAD');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ConversationState" ADD VALUE 'CANCEL_CONFIRMATION';
ALTER TYPE "ConversationState" ADD VALUE 'ORDER_CONSENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentStatus" ADD VALUE 'CREATING';
ALTER TYPE "PaymentStatus" ADD VALUE 'CREATION_UNKNOWN';
ALTER TYPE "PaymentStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "PaymentStatus" ADD VALUE 'REVIEW_REQUIRED';
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUND_PENDING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "JobStatus" ADD VALUE 'RETRY';
ALTER TYPE "JobStatus" ADD VALUE 'BLOCKED';
ALTER TYPE "JobStatus" ADD VALUE 'UNKNOWN';
ALTER TYPE "JobStatus" ADD VALUE 'DEAD';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "conversationVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "notificationConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notificationConsentAt" TIMESTAMP(3),
ADD COLUMN     "notificationConsentScope" TEXT,
ADD COLUMN     "notificationConsentSource" TEXT,
ADD COLUMN     "notificationConsentVersion" TEXT,
ADD COLUMN     "optedOutAt" TIMESTAMP(3),
ADD COLUMN     "previousState" "ConversationState",
ADD COLUMN     "privacyNoticeAt" TIMESTAMP(3),
ADD COLUMN     "privacyNoticeVersion" TEXT,
ADD COLUMN     "processingToken" TEXT,
ADD COLUMN     "processingUntil" TIMESTAMP(3),
ADD COLUMN     "selectedDiscIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "appliedPaymentAttemptId" TEXT,
ADD COLUMN     "checkoutFrozenAt" TIMESTAMP(3),
ADD COLUMN     "configVersion" TEXT,
ADD COLUMN     "contentVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "deliveryAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryMode" TEXT NOT NULL DEFAULT 'PAID_SEPARATELY',
ADD COLUMN     "deliverySnapshot" JSONB,
ADD COLUMN     "fulfillmentHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "packageSnapshot" JSONB,
ADD COLUMN     "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "selectedDiscIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "subtotalAmount" INTEGER NOT NULL DEFAULT 20000,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "sheetSyncStatus" SET DEFAULT 'NOT_REQUIRED';

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "lastReconcileAt" TIMESTAMP(3),
ADD COLUMN     "merchantId" TEXT NOT NULL DEFAULT 'demo',
ADD COLUMN     "merchantReference" TEXT,
ADD COLUMN     "orderVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "snapshot" JSONB;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryError" TEXT,
ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "managerId" TEXT,
ADD COLUMN     "outboxJobId" TEXT,
ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "ticketId" TEXT;

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "acknowledgement" JSONB,
ADD COLUMN     "attemptId" TEXT,
ADD COLUMN     "authenticatedAt" TIMESTAMP(3),
ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "lockToken" TEXT,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "payloadHash" TEXT,
ADD COLUMN     "status" "InboxStatus" NOT NULL DEFAULT 'RECEIVED';

-- AlterTable
ALTER TABLE "OutboxJob" ADD COLUMN     "dispatchStartedAt" TIMESTAMP(3),
ADD COLUMN     "lockToken" TEXT,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "resourceKey" TEXT;

-- AlterTable
ALTER TABLE "Handoff" ADD COLUMN     "assignedManagerId" TEXT,
ADD COLUMN     "previousState" "ConversationState";

-- CreateTable
CREATE TABLE "PaymentIncident" (
    "id" TEXT NOT NULL,
    "incidentKey" TEXT NOT NULL,
    "orderId" TEXT,
    "attemptId" TEXT,
    "reason" TEXT NOT NULL,
    "expectedAmount" TEXT,
    "actualAmount" TEXT,
    "expectedCurrency" TEXT,
    "actualCurrency" TEXT,
    "details" JSONB,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "resolutionComment" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SheetCursor" (
    "spreadsheetId" TEXT NOT NULL,
    "sheetId" INTEGER NOT NULL,
    "nextRowIndex" INTEGER NOT NULL DEFAULT 2,

    CONSTRAINT "SheetCursor_pkey" PRIMARY KEY ("spreadsheetId","sheetId")
);

-- CreateTable
CREATE TABLE "SheetBinding" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "sheetId" INTEGER NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "syncedOrderVersion" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SheetBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramMessageBinding" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramMessageBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionToken" (
    "token" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "contentVersion" INTEGER,
    "conversationVersion" INTEGER NOT NULL,
    "actionId" TEXT NOT NULL,
    "context" TEXT,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionToken_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- Preserve historical references; no payment creation or notification is enqueued.
UPDATE "PaymentAttempt" SET "merchantReference" = "id";
ALTER TABLE "PaymentAttempt" ALTER COLUMN "merchantReference" SET NOT NULL;
UPDATE "Order" SET "subtotalAmount"="unitPrice"*"quantity", "selectedDiscIds"=CASE WHEN "discId" IS NULL THEN ARRAY[]::TEXT[] ELSE ARRAY["discId"] END,
 "checkoutFrozenAt"=CASE WHEN "paymentUrl" IS NOT NULL THEN "updatedAt" ELSE NULL END,
 "sheetSyncStatus"=CASE WHEN "paymentStatus" NOT IN ('PAID','REFUNDED') THEN 'NOT_REQUIRED' ELSE "sheetSyncStatus" END;
UPDATE "Order" o SET "appliedPaymentAttemptId"=(SELECT p.id FROM "PaymentAttempt" p WHERE p."orderId"=o.id AND p.status='PAID' ORDER BY p."createdAt" LIMIT 1) WHERE o."paymentStatus"='PAID';
UPDATE "WebhookEvent" SET status=CASE WHEN "processedAt" IS NOT NULL THEN 'PROCESSED'::"InboxStatus" ELSE 'RECEIVED'::"InboxStatus" END;
-- Existing append-based rows require reconciliation, never automatic historical resend.
UPDATE "Order" SET "sheetSyncStatus"='LEGACY_RECONCILIATION_REQUIRED' WHERE "sheetRowReference" IS NOT NULL;
UPDATE "OutboxJob" SET status='BLOCKED',"lastError"='LEGACY_SHEET_RECONCILIATION_REQUIRED' WHERE kind='SHEETS' AND status<>'DONE';
WITH ranked AS (SELECT id,row_number() OVER (PARTITION BY "customerId" ORDER BY "createdAt" DESC) n FROM "Handoff" WHERE status IN ('OPEN','ASSIGNED')) UPDATE "Handoff" SET status='CLOSED',"closedAt"=now() WHERE id IN (SELECT id FROM ranked WHERE n>1);
-- CreateIndex
CREATE UNIQUE INDEX "PaymentIncident_incidentKey_key" ON "PaymentIncident"("incidentKey");

-- CreateIndex
CREATE INDEX "PaymentIncident_orderId_status_idx" ON "PaymentIncident"("orderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SheetBinding_orderId_key" ON "SheetBinding"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "SheetBinding_spreadsheetId_sheetId_rowIndex_key" ON "SheetBinding"("spreadsheetId", "sheetId", "rowIndex");

-- CreateIndex
CREATE INDEX "TelegramMessageBinding_ticketId_idx" ON "TelegramMessageBinding"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramMessageBinding_chatId_messageId_key" ON "TelegramMessageBinding"("chatId", "messageId");

-- CreateIndex
CREATE INDEX "ActionToken_customerId_expiresAt_idx" ON "ActionToken"("customerId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_merchantReference_key" ON "PaymentAttempt"("merchantReference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_provider_merchantId_externalPaymentId_key" ON "PaymentAttempt"("provider", "merchantId", "externalPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_outboxJobId_key" ON "Message"("outboxJobId");

ALTER TABLE "Order" DROP CONSTRAINT "order_price_integrity";
ALTER TABLE "Order" ADD CONSTRAINT "order_price_integrity" CHECK ("unitPrice">0 AND "subtotalAmount"="unitPrice"*"quantity" AND "deliveryAmount">=0 AND "totalAmount"="subtotalAmount"+"deliveryAmount");
CREATE UNIQUE INDEX "handoff_one_active_customer" ON "Handoff"("customerId") WHERE status IN ('OPEN','ASSIGNED');
CREATE UNIQUE INDEX "attempt_one_active_order" ON "PaymentAttempt"("orderId") WHERE status IN ('CREATING','CREATION_UNKNOWN','PENDING');
CREATE INDEX "inbox_claim" ON "WebhookEvent"(status,"nextAttemptAt",sequence);
CREATE INDEX "outbox_resource" ON "OutboxJob"("resourceKey",status);
