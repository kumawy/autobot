ALTER TABLE "Order" ADD COLUMN "trackingNumber" TEXT;
ALTER TABLE "Order" ADD COLUMN "shippedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Order_trackingNumber_key" ON "Order"("trackingNumber");
