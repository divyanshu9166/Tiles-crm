-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "pricelistId" INTEGER;

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "pricelistId" INTEGER;

-- CreateTable
CREATE TABLE "LandedCost" (
    "id" SERIAL NOT NULL,
    "displayId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplierId" INTEGER,
    "vendorRef" TEXT,
    "creditTo" TEXT NOT NULL DEFAULT 'EXPENSE',
    "notes" TEXT,
    "amountTotal" INTEGER NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3),
    "postedBy" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LandedCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandedCostLine" (
    "id" SERIAL NOT NULL,
    "landedCostId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "costType" TEXT NOT NULL DEFAULT 'FREIGHT',
    "amount" INTEGER NOT NULL,
    "splitMethod" TEXT NOT NULL DEFAULT 'BY_QUANTITY',

    CONSTRAINT "LandedCostLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandedCostAllocation" (
    "id" SERIAL NOT NULL,
    "landedCostId" INTEGER NOT NULL,
    "pickingLineId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "originalValue" INTEGER NOT NULL,
    "additionalCost" INTEGER NOT NULL,
    "inStockQty" INTEGER NOT NULL,
    "toStock" INTEGER NOT NULL,
    "toCogs" INTEGER NOT NULL,
    "costBefore" INTEGER NOT NULL,
    "costAfter" INTEGER NOT NULL,

    CONSTRAINT "LandedCostAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_LandedCostPickings" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_LandedCostPickings_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "LandedCost_displayId_key" ON "LandedCost"("displayId");

-- CreateIndex
CREATE INDEX "LandedCost_status_date_idx" ON "LandedCost"("status", "date");

-- CreateIndex
CREATE INDEX "LandedCostLine_landedCostId_idx" ON "LandedCostLine"("landedCostId");

-- CreateIndex
CREATE INDEX "LandedCostAllocation_landedCostId_idx" ON "LandedCostAllocation"("landedCostId");

-- CreateIndex
CREATE INDEX "LandedCostAllocation_pickingLineId_idx" ON "LandedCostAllocation"("pickingLineId");

-- CreateIndex
CREATE INDEX "_LandedCostPickings_B_index" ON "_LandedCostPickings"("B");

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_pricelistId_fkey" FOREIGN KEY ("pricelistId") REFERENCES "Pricelist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_pricelistId_fkey" FOREIGN KEY ("pricelistId") REFERENCES "Pricelist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCost" ADD CONSTRAINT "LandedCost_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostLine" ADD CONSTRAINT "LandedCostLine_landedCostId_fkey" FOREIGN KEY ("landedCostId") REFERENCES "LandedCost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocation" ADD CONSTRAINT "LandedCostAllocation_landedCostId_fkey" FOREIGN KEY ("landedCostId") REFERENCES "LandedCost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocation" ADD CONSTRAINT "LandedCostAllocation_pickingLineId_fkey" FOREIGN KEY ("pickingLineId") REFERENCES "StockPickingLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LandedCostPickings" ADD CONSTRAINT "_LandedCostPickings_A_fkey" FOREIGN KEY ("A") REFERENCES "LandedCost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LandedCostPickings" ADD CONSTRAINT "_LandedCostPickings_B_fkey" FOREIGN KEY ("B") REFERENCES "StockPicking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

