ALTER TABLE "Order" ADD COLUMN "quantityConfirmed" BOOLEAN NOT NULL DEFAULT false;

-- Completed checkouts already contain an explicitly reviewed quantity. Existing
-- editable drafts can safely ask again; financial snapshots remain untouched.
UPDATE "Order" SET "quantityConfirmed" = true
WHERE "orderStatus" <> 'DRAFT' OR "checkoutFrozenAt" IS NOT NULL;
