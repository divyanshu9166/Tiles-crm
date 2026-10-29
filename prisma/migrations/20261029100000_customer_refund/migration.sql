-- Cash refunds paid to customers (credit notes on bills that were already paid).
CREATE TABLE "CustomerRefund" (
    "id" SERIAL NOT NULL,
    "displayId" TEXT NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'Cash',
    "reference" TEXT,
    "notes" TEXT,
    "refundedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerRefund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerRefund_displayId_key" ON "CustomerRefund"("displayId");
CREATE INDEX "CustomerRefund_invoiceId_idx" ON "CustomerRefund"("invoiceId");
CREATE INDEX "CustomerRefund_refundedAt_idx" ON "CustomerRefund"("refundedAt");

ALTER TABLE "CustomerRefund" ADD CONSTRAINT "CustomerRefund_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
