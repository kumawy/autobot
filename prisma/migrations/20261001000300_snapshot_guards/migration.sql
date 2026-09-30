-- Legacy records are preserved; this migration never queues an external action.
UPDATE "PaymentAttempt" SET snapshot=jsonb_build_object('legacyMigration',true,'legacyMerchantReference',"orderId") WHERE snapshot IS NULL;
INSERT INTO "PaymentAttempt" (id,"orderId",provider,"merchantId","merchantReference","externalPaymentId",amount,currency,status,"paymentUrl","orderVersion",snapshot,"createdAt","updatedAt")
SELECT gen_random_uuid()::text,o.id,COALESCE(o."paymentProvider",'legacy'),'demo',o.id,o."externalPaymentId",o."totalAmount",o.currency,o."paymentStatus",o."paymentUrl",o."contentVersion",jsonb_build_object('legacyMigration',true,'legacyMerchantReference',o.id),o."createdAt",now()
FROM "Order" o WHERE o."externalPaymentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "PaymentAttempt" a WHERE a."orderId"=o.id);
UPDATE "Order" o SET "appliedPaymentAttemptId"=(SELECT a.id FROM "PaymentAttempt" a WHERE a."orderId"=o.id AND a.status='PAID' ORDER BY a."createdAt" LIMIT 1) WHERE o."paymentStatus"='PAID' AND o."appliedPaymentAttemptId" IS NULL;
UPDATE "OutboxJob" SET "resourceKey"=CASE WHEN kind IN ('CREATE_PAYMENT','PAYMENT_RECONCILE','SHEETS') THEN 'order:'||"orderId" WHEN "customerId" IS NOT NULL THEN 'customer:'||"customerId"||':'||kind ELSE NULL END WHERE "resourceKey" IS NULL;
UPDATE "OutboxJob" SET status='DEAD' WHERE status='FAILED';
CREATE FUNCTION prevent_attempt_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW."orderVersion" IS DISTINCT FROM OLD."orderVersion" OR NEW."merchantReference" IS DISTINCT FROM OLD."merchantReference" OR NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
    RAISE EXCEPTION 'Payment attempt snapshot is immutable';
  END IF;
  IF NEW."merchantId" IS DISTINCT FROM OLD."merchantId" AND NOT (OLD."merchantId"='demo' AND OLD.snapshot->>'legacyMigration'='true') THEN RAISE EXCEPTION 'Merchant identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempt_snapshot_immutable BEFORE UPDATE ON "PaymentAttempt" FOR EACH ROW EXECUTE FUNCTION prevent_attempt_snapshot_mutation();
ALTER TABLE "SheetBinding" ADD CONSTRAINT sheet_data_row CHECK ("rowIndex">=2);
ALTER TABLE "SheetCursor" ADD CONSTRAINT sheet_next_row CHECK ("nextRowIndex">=2);
