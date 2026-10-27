-- AlterTable
ALTER TABLE "StockPicking" ADD COLUMN     "returnOfId" INTEGER;

-- AlterTable
ALTER TABLE "StockPickingLine" ADD COLUMN     "returnOfLineId" INTEGER;

-- AddForeignKey
ALTER TABLE "StockPicking" ADD CONSTRAINT "StockPicking_returnOfId_fkey" FOREIGN KEY ("returnOfId") REFERENCES "StockPicking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

