-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "pricelistId" INTEGER;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "pricelistId" INTEGER;

-- CreateTable
CREATE TABLE "Pricelist" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pricelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricelistItem" (
    "id" SERIAL NOT NULL,
    "pricelistId" INTEGER NOT NULL,
    "appliesTo" TEXT NOT NULL DEFAULT 'ALL',
    "categoryId" INTEGER,
    "productId" INTEGER,
    "minQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "computeType" TEXT NOT NULL DEFAULT 'DISCOUNT',
    "fixedPrice" INTEGER,
    "discountPct" DOUBLE PRECISION,
    "markupPct" DOUBLE PRECISION,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricelistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Pricelist_name_key" ON "Pricelist"("name");

-- CreateIndex
CREATE INDEX "PricelistItem_pricelistId_idx" ON "PricelistItem"("pricelistId");

-- CreateIndex
CREATE INDEX "PricelistItem_productId_idx" ON "PricelistItem"("productId");

-- CreateIndex
CREATE INDEX "PricelistItem_categoryId_idx" ON "PricelistItem"("categoryId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_pricelistId_fkey" FOREIGN KEY ("pricelistId") REFERENCES "Pricelist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_pricelistId_fkey" FOREIGN KEY ("pricelistId") REFERENCES "Pricelist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricelistItem" ADD CONSTRAINT "PricelistItem_pricelistId_fkey" FOREIGN KEY ("pricelistId") REFERENCES "Pricelist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricelistItem" ADD CONSTRAINT "PricelistItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricelistItem" ADD CONSTRAINT "PricelistItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

