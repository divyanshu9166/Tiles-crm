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

// Next number after the highest existing "<prefix><digits>" in a table, taken
// under a transaction-scoped advisory lock. Numeric max, not the latest row:
// older documents were numbered from count()+1 and are not monotonic, and
// deletions must never make the next number collide.
export async function nextNumber(tx: Tx, opts: { table: string; prefix: string; lock: number; padding?: number; start?: number }) {
  const { table, prefix, lock, padding = 4, start = 1 } = opts
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lock})::text`
  const pattern = `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9]+)$`
  const rows = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(CAST(substring("displayId" from ${pattern}) AS INTEGER)) AS max
    FROM ${Prisma.raw(`"${table}"`)}
    WHERE "displayId" ~ ${pattern}`
  const max = rows[0]?.max
  return `${prefix}${String(max == null ? start : max + 1).padStart(padding, '0')}`
}

export async function nextSequence(tx: Tx, code: SequenceCode) {
  const { prefix, lock, padding, table } = SEQUENCES[code]
  return nextNumber(tx, { table, prefix, lock, padding })
}

// One lock and one prefix for every invoice, whichever screen creates it
// (POS, sales order or a restore from drafts).
export async function nextInvoiceNumber(tx: Tx) {
  const settings = await tx.storeSettings.findFirst({ where: { id: 1 }, select: { invoicePrefix: true, invoicePadding: true } })
  const prefix = (settings?.invoicePrefix || 'INV-').trim() || 'INV-'
  return nextNumber(tx, { table: 'Invoice', prefix, lock: 82463205, padding: settings?.invoicePadding ?? 4 })
}
