import type { Prisma, PaymentStatus } from '@prisma/client'

type Tx = Prisma.TransactionClient

// One lock for every credit-note number (POS and sales-order refunds), taken
// from the highest number so deletions never make the next one collide.
export async function nextCreditNoteNumber(tx: Tx) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463211)::text`
  const rows = await tx.$queryRaw<{ max: number | null }[]>`SELECT MAX(CAST(substring("displayId" from '^CN-([0-9]+)$') AS INTEGER)) AS max FROM "CreditNote" WHERE "displayId" ~ '^CN-[0-9]+$'`
  return `CN-${String((Number(rows[0]?.max) || 0) + 1).padStart(4, '0')}`
}

// What the customer still owes = total − paid − credited (never below zero).
export function invoiceBalance(total: number, amountPaid: number, credited: number): { balanceDue: number; paymentStatus: PaymentStatus } {
  const owed = Math.max(0, total - credited)
  const balanceDue = Math.max(0, owed - amountPaid)
  const paymentStatus: PaymentStatus = balanceDue === 0 ? 'PAID' : amountPaid > 0 ? 'PARTIAL' : 'PENDING'
  return { balanceDue, paymentStatus }
}

// Re-derive balanceDue/paymentStatus after a payment or credit note, so aging,
// follow-ups and statements stop asking for money already credited.
export async function refreshInvoiceBalance(tx: Tx, invoiceId: number) {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { total: true, amountPaid: true } })
  const credited = (await tx.creditNote.aggregate({ where: { invoiceId }, _sum: { amount: true } }))._sum.amount || 0
  const next = invoiceBalance(invoice.total, invoice.amountPaid, credited)
  await tx.invoice.update({ where: { id: invoiceId }, data: next })
  return { ...next, credited }
}
