-- Business invariants also hold if a future code path bypasses the order wizard.
ALTER TABLE "Order" ADD CONSTRAINT "order_positive_quantity" CHECK ("quantity" > 0);
ALTER TABLE "Order" ADD CONSTRAINT "order_price_integrity" CHECK ("unitPrice" > 0 AND "totalAmount" = "unitPrice" * "quantity");
ALTER TABLE "Order" ADD CONSTRAINT "order_currency_kzt" CHECK ("currency" = 'KZT');
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "attempt_positive_amount" CHECK ("amount" > 0 AND "currency" = 'KZT');
ALTER TABLE "Order" ADD CONSTRAINT "sheet_paid_only" CHECK ("sheetSyncStatus" <> 'SYNCED' OR "paymentStatus" IN ('PAID', 'REFUNDED'));
ALTER TABLE "Customer" ADD CONSTRAINT "current_order_exists" FOREIGN KEY ("currentOrderId") REFERENCES "Order"("id") DEFERRABLE INITIALLY DEFERRED;
