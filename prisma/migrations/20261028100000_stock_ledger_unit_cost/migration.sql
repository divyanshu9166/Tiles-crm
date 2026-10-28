-- Cost per unit at the time of each stock movement (B1). Older rows stay NULL
-- and are valued as before when journals are posted.
ALTER TABLE "StockLedger" ADD COLUMN "unitCost" DOUBLE PRECISION;
