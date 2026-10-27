import { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

// Odoo-style document sequences (ir.sequence). Each sequence takes its own
// transaction-scoped advisory lock so concurrent documents never collide.
const SEQUENCES = {
  SalesOrder: { prefix: 'SO-', lock: 82463201, padding: 4, table: 'SalesOrder' },
  Delivery: { prefix: 'DO-', lock: 82463202, padding: 4, table: 'StockPicking' },
  Receipt: { prefix: 'GRN-', lock: 82463203, padding: 4, table: 'StockPicking' },
  InventoryCount: { prefix: 'PHY-', lock: 82463204, padding: 4, table: 'InventoryCount' },
  PurchaseOrder: { prefix: 'PO-', lock: 82463206, padding: 4, table: 'PurchaseOrder' },
  VendorBill: { prefix: 'BILL-', lock: 82463208, padding: 4, table: 'VendorBill' },
  Return: { prefix: 'RET-', lock: 82463210, padding: 4, table: 'StockPicking' },
  LandedCost: { prefix: 'LC-', lock: 82463212, padding: 4, table: 'LandedCost' },
} as const

export type SequenceCode = keyof typeof SEQUENCES

export function formatSequence(prefix: string, lastNumber: number | null | undefined, padding: number) {
  return `${prefix}${String((lastNumber || 0) + 1).padStart(padding, '0')}`
}

export async function nextSequence(tx: Tx, code: SequenceCode) {
  const { prefix, lock, padding, table } = SEQUENCES[code]
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lock})::text`
  // Numeric max, not the latest row: older documents were numbered from
  // count()+1 and are not guaranteed to be monotonic.
  const pattern = `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9]+)$`
  const rows = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(CAST(substring("displayId" from ${pattern}) AS INTEGER)) AS max
    FROM ${Prisma.raw(`"${table}"`)}
    WHERE "displayId" ~ ${pattern}`
  return formatSequence(prefix, rows[0]?.max ?? 0, padding)
}
