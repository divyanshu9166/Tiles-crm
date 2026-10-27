-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('CONFIRMED', 'DONE', 'CANCELLED');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "salesOrderId" INTEGER;

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "costingMethod" TEXT NOT NULL DEFAULT 'AVCO',
ADD COLUMN     "poApprovalLimit" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RecordMessage" (
    "id" SERIAL NOT NULL,
    "resModel" TEXT NOT NULL,
    "resId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'NOTE',
    "body" TEXT NOT NULL,
    "tracking" JSONB,
    "authorId" INTEGER,
    "authorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordActivity" (
    "id" SERIAL NOT NULL,
    "resModel" TEXT NOT NULL,
    "resId" INTEGER NOT NULL,
    "resName" TEXT,
    "activityType" TEXT NOT NULL DEFAULT 'TODO',
    "summary" TEXT NOT NULL,
    "note" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "assignedToId" INTEGER,
    "createdById" INTEGER,
    "createdByName" TEXT,
    "doneAt" TIMESTAMP(3),
    "doneByName" TEXT,
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" SERIAL NOT NULL,
    "displayId" TEXT NOT NULL,
    "quotationId" INTEGER,
    "contactId" INTEGER NOT NULL,
    "salespersonId" INTEGER,
    "godownId" INTEGER NOT NULL,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'CONFIRMED',
    "invoicePolicy" TEXT NOT NULL DEFAULT 'DELIVERED',
    "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "commitmentDate" TIMESTAMP(3),
    "projectName" TEXT,
    "dispatchAddress" TEXT,
    "customerReference" TEXT,
    "supplyType" TEXT NOT NULL DEFAULT 'INTRASTATE',
    "placeOfSupply" TEXT,
    "discountType" TEXT NOT NULL DEFAULT 'none',
    "discountValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "freightCharge" INTEGER NOT NULL DEFAULT 0,
    "loadingCharge" INTEGER NOT NULL DEFAULT 0,
    "installationCharge" INTEGER NOT NULL DEFAULT 0,
    "chargesInvoiced" BOOLEAN NOT NULL DEFAULT false,
    "subtotal" INTEGER NOT NULL DEFAULT 0,
    "discountAmount" INTEGER NOT NULL DEFAULT 0,
    "gst" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderLine" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "hsnCode" TEXT,
    "unitOfMeasure" TEXT NOT NULL DEFAULT 'PCS',
    "quantity" INTEGER NOT NULL,
    "qtyDelivered" INTEGER NOT NULL DEFAULT 0,
    "qtyInvoiced" INTEGER NOT NULL DEFAULT 0,
    "areaSqft" DOUBLE PRECISION,
    "coveragePerBox" DOUBLE PRECISION,
    "price" INTEGER NOT NULL,
    "gstRate" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SalesOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockPicking" (
    "id" SERIAL NOT NULL,
    "displayId" TEXT NOT NULL,
    "pickingType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "godownId" INTEGER NOT NULL,
    "salesOrderId" INTEGER,
    "purchaseOrderId" INTEGER,
    "contactId" INTEGER,
    "supplierId" INTEGER,
    "backorderOfId" INTEGER,
    "scheduledDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),
    "doneBy" TEXT,
    "vehicleNumber" TEXT,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "deliveryAddress" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockPicking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockPickingLine" (
    "id" SERIAL NOT NULL,
    "pickingId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "salesOrderLineId" INTEGER,
    "purchaseOrderItemId" INTEGER,
    "batchId" INTEGER,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "demandQty" INTEGER NOT NULL,
    "doneQty" INTEGER NOT NULL DEFAULT 0,
    "unitCost" INTEGER,

    CONSTRAINT "StockPickingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReorderRule" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "godownId" INTEGER,
    "minQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "multipleQty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "supplierId" INTEGER,
    "leadDays" INTEGER NOT NULL DEFAULT 7,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastOrderedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReorderRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSupplier" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "supplierSku" TEXT,
    "price" INTEGER NOT NULL DEFAULT 0,
    "minQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "leadDays" INTEGER NOT NULL DEFAULT 7,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCount" (
    "id" SERIAL NOT NULL,
    "displayId" TEXT NOT NULL,
    "name" TEXT,
    "godownId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "assignedToId" INTEGER,
    "scheduledDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "appliedBy" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCountLine" (
    "id" SERIAL NOT NULL,
    "countId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "systemQty" DOUBLE PRECISION NOT NULL,
    "countedQty" DOUBLE PRECISION,
    "appliedDelta" DOUBLE PRECISION,
    "unitCost" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "InventoryCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecordMessage_resModel_resId_createdAt_idx" ON "RecordMessage"("resModel", "resId", "createdAt");

-- CreateIndex
CREATE INDEX "RecordActivity_resModel_resId_idx" ON "RecordActivity"("resModel", "resId");

-- CreateIndex
CREATE INDEX "RecordActivity_assignedToId_doneAt_dueDate_idx" ON "RecordActivity"("assignedToId", "doneAt", "dueDate");

-- CreateIndex
CREATE INDEX "RecordActivity_doneAt_dueDate_idx" ON "RecordActivity"("doneAt", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_displayId_key" ON "SalesOrder"("displayId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_quotationId_key" ON "SalesOrder"("quotationId");

-- CreateIndex
CREATE INDEX "SalesOrder_contactId_idx" ON "SalesOrder"("contactId");

-- CreateIndex
CREATE INDEX "SalesOrder_status_orderDate_idx" ON "SalesOrder"("status", "orderDate");

-- CreateIndex
CREATE INDEX "SalesOrder_salespersonId_idx" ON "SalesOrder"("salespersonId");

-- CreateIndex
CREATE INDEX "SalesOrderLine_orderId_idx" ON "SalesOrderLine"("orderId");

-- CreateIndex
CREATE INDEX "SalesOrderLine_productId_idx" ON "SalesOrderLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "StockPicking_displayId_key" ON "StockPicking"("displayId");

-- CreateIndex
CREATE INDEX "StockPicking_pickingType_status_scheduledDate_idx" ON "StockPicking"("pickingType", "status", "scheduledDate");

-- CreateIndex
CREATE INDEX "StockPicking_salesOrderId_idx" ON "StockPicking"("salesOrderId");

-- CreateIndex
CREATE INDEX "StockPicking_purchaseOrderId_idx" ON "StockPicking"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "StockPickingLine_pickingId_idx" ON "StockPickingLine"("pickingId");

-- CreateIndex
CREATE INDEX "StockPickingLine_productId_idx" ON "StockPickingLine"("productId");

-- CreateIndex
CREATE INDEX "ReorderRule_productId_idx" ON "ReorderRule"("productId");

-- CreateIndex
CREATE INDEX "ReorderRule_active_idx" ON "ReorderRule"("active");

-- CreateIndex
CREATE INDEX "ProductSupplier_supplierId_idx" ON "ProductSupplier"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSupplier_productId_supplierId_key" ON "ProductSupplier"("productId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCount_displayId_key" ON "InventoryCount"("displayId");

-- CreateIndex
CREATE INDEX "InventoryCount_status_idx" ON "InventoryCount"("status");

-- CreateIndex
CREATE INDEX "InventoryCount_godownId_idx" ON "InventoryCount"("godownId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCountLine_countId_productId_key" ON "InventoryCountLine"("countId", "productId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordActivity" ADD CONSTRAINT "RecordActivity_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_salespersonId_fkey" FOREIGN KEY ("salespersonId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_godownId_fkey" FOREIGN KEY ("godownId") REFERENCES "Godown"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPicking" ADD CONSTRAINT "StockPicking_godownId_fkey" FOREIGN KEY ("godownId") REFERENCES "Godown"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPicking" ADD CONSTRAINT "StockPicking_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPicking" ADD CONSTRAINT "StockPicking_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPicking" ADD CONSTRAINT "StockPicking_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPicking" ADD CONSTRAINT "StockPicking_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPicking" ADD CONSTRAINT "StockPicking_backorderOfId_fkey" FOREIGN KEY ("backorderOfId") REFERENCES "StockPicking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPickingLine" ADD CONSTRAINT "StockPickingLine_pickingId_fkey" FOREIGN KEY ("pickingId") REFERENCES "StockPicking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPickingLine" ADD CONSTRAINT "StockPickingLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPickingLine" ADD CONSTRAINT "StockPickingLine_salesOrderLineId_fkey" FOREIGN KEY ("salesOrderLineId") REFERENCES "SalesOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPickingLine" ADD CONSTRAINT "StockPickingLine_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPickingLine" ADD CONSTRAINT "StockPickingLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ProductBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderRule" ADD CONSTRAINT "ReorderRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderRule" ADD CONSTRAINT "ReorderRule_godownId_fkey" FOREIGN KEY ("godownId") REFERENCES "Godown"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderRule" ADD CONSTRAINT "ReorderRule_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSupplier" ADD CONSTRAINT "ProductSupplier_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSupplier" ADD CONSTRAINT "ProductSupplier_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCount" ADD CONSTRAINT "InventoryCount_godownId_fkey" FOREIGN KEY ("godownId") REFERENCES "Godown"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCount" ADD CONSTRAINT "InventoryCount_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "InventoryCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "salesOrderLineId" INTEGER;
