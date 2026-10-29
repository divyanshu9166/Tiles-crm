-- Purchase orders can name the location their goods are delivered to.
ALTER TABLE "PurchaseOrder" ADD COLUMN "godownId" INTEGER;
CREATE INDEX "PurchaseOrder_godownId_idx" ON "PurchaseOrder"("godownId");
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_godownId_fkey" FOREIGN KEY ("godownId") REFERENCES "Godown"("id") ON DELETE SET NULL ON UPDATE CASCADE;
