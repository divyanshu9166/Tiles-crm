-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "followUpNextDate" TIMESTAMP(3),
ADD COLUMN     "followUpNote" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "expectedRevenue" INTEGER,
ADD COLUMN     "teamId" INTEGER;

-- AlterTable
ALTER TABLE "PurchasePayment" ADD COLUMN     "billId" INTEGER;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "teamId" INTEGER;

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "leadCapacity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "salesTeamId" INTEGER;

-- CreateTable
CREATE TABLE "SalesTeam" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "leaderId" INTEGER,
    "monthlyTarget" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT,
    "autoAssign" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpLevel" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'EMAIL',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowUpLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpLog" (
    "id" SERIAL NOT NULL,
    "contactId" INTEGER NOT NULL,
    "levelId" INTEGER,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "amountDue" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowUpLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesTeam_name_key" ON "SalesTeam"("name");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpLevel_days_key" ON "FollowUpLevel"("days");

-- CreateIndex
CREATE INDEX "FollowUpLog_contactId_createdAt_idx" ON "FollowUpLog"("contactId", "createdAt");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "SalesTeam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_salesTeamId_fkey" FOREIGN KEY ("salesTeamId") REFERENCES "SalesTeam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_billId_fkey" FOREIGN KEY ("billId") REFERENCES "VendorBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "SalesTeam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesTeam" ADD CONSTRAINT "SalesTeam_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpLog" ADD CONSTRAINT "FollowUpLog_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpLog" ADD CONSTRAINT "FollowUpLog_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "FollowUpLevel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

