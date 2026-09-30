-- Sheets failures must never delay independent payment reconciliation.
UPDATE "OutboxJob" SET "resourceKey"='sheet:'||"orderId" WHERE kind='SHEETS';
UPDATE "OutboxJob" SET "resourceKey"='payment:'||COALESCE("orderId", "dedupeKey") WHERE kind IN ('CREATE_PAYMENT','PAYMENT_RECONCILE','PAYMENT_EVENT');
