import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'

type Db = Prisma.TransactionClient | typeof prisma

// ─── Account map (codes from the default chart in app/actions/financials.ts) ───
export const ACC = {
  cash: '1001', bank: '1002', receivable: '1100', inventory: '1200', wip: '1210', gstInput: '1300',
  payable: '2001', grni: '2010', gstOutput: '2100', salaryPayable: '2200', pfEsiPayable: '2300',
  openingEquity: '3900',
  sales: '4001', otherIncome: '4100',
  cogs: '5001', purchases: '5020', inventoryAdjustment: '5030',
  salary: '5100', employerPf: '5110', rent: '5200', utilities: '5300', freight: '5400', marketing: '5500',
  bankCharges: '5700', otherExpense: '5900',
} as const

// Accounts the auto-posting needs on top of the default chart.
const EXTRA_ACCOUNTS = [
  { code: '1210', name: 'Work in Progress', group: 'Current Assets', type: 'ASSET' },
  { code: '2010', name: 'Goods Received Not Invoiced (GRNI)', group: 'Current Liabilities', type: 'LIABILITY' },
  { code: '3900', name: 'Opening Balance Equity', group: 'Equity', type: 'EQUITY' },
  { code: '5030', name: 'Inventory Adjustments', group: 'Cost of Goods Sold', type: 'EXPENSE' },
]

export type DraftLine = { code: string; debit?: number; credit?: number; description?: string }
export type DraftEntry = { sourceKey: string; date: Date; narration: string; referenceType: string; referenceId: number; lines: DraftLine[]; reverses?: string }

export function cashAccount(method?: string | null) {
  return String(method || '').toLowerCase() === 'cash' ? ACC.cash : ACC.bank
}

export function expenseAccount(categoryName?: string | null) {
  const name = String(categoryName || '').toLowerCase()
  if (/rent/.test(name)) return ACC.rent
  if (/electric|utilit|water|internet|phone/.test(name)) return ACC.utilities
  if (/transport|freight|loading|fuel|logistic|delivery/.test(name)) return ACC.freight
  if (/market|advert|promotion|social/.test(name)) return ACC.marketing
  if (/bank/.test(name)) return ACC.bankCharges
  return ACC.otherExpense
}

// Stock moves → (debit, credit) accounts. Transfers between godowns stay
// inside the inventory account and post nothing.
export function stockAccounts(entryType: string, referenceType: string | null, quantity: number): [string, string] | null {
  if (entryType === 'TRANSFER_IN' || entryType === 'TRANSFER_OUT') return null
  const inbound = quantity > 0
  if (entryType === 'SALE') return [ACC.cogs, ACC.inventory]
  if (entryType === 'RETURN') return [ACC.inventory, ACC.cogs]
  if (referenceType === 'PurchaseOrder') return inbound ? [ACC.inventory, ACC.grni] : [ACC.grni, ACC.inventory]
  if (referenceType === 'PurchaseReturn') return inbound ? [ACC.inventory, ACC.grni] : [ACC.grni, ACC.inventory]
  if (entryType === 'OPENING_BALANCE') return inbound ? [ACC.inventory, ACC.openingEquity] : [ACC.openingEquity, ACC.inventory]
  if (entryType === 'PRODUCTION') return inbound ? [ACC.inventory, ACC.wip] : [ACC.wip, ACC.inventory]
  if (entryType === 'IN' && referenceType !== 'StaffPortal') return [ACC.inventory, ACC.openingEquity]
  return inbound ? [ACC.inventory, ACC.inventoryAdjustment] : [ACC.inventoryAdjustment, ACC.inventory]
}

export function balanced(lines: DraftLine[]) {
  const debit = lines.reduce((sum, line) => sum + (line.debit || 0), 0)
  const credit = lines.reduce((sum, line) => sum + (line.credit || 0), 0)
  return debit === credit && debit > 0
}

export function reverse(entry: DraftEntry, sourceKey: string, date: Date, narration: string): DraftEntry {
  return { ...entry, sourceKey, date, narration, reverses: entry.sourceKey, lines: entry.lines.map(line => ({ ...line, debit: line.credit, credit: line.debit })) }
}

// Customer invoice: receivable against revenue, output GST and charges income.
export function invoiceEntry(invoice: { id: number; displayId: string; date: Date; total: number; gst: number; transportCost: number; freightCharge: number; loadingCharge: number; installationCharge: number }): DraftEntry {
  const charges = invoice.transportCost + invoice.freightCharge + invoice.loadingCharge + invoice.installationCharge
  const revenue = invoice.total - invoice.gst - charges
  return {
    sourceKey: `INV:${invoice.id}`, date: invoice.date, narration: `Sales invoice ${invoice.displayId}`, referenceType: 'Invoice', referenceId: invoice.id,
    lines: [
      { code: ACC.receivable, debit: invoice.total, description: invoice.displayId },
      { code: ACC.sales, credit: revenue },
      { code: ACC.gstOutput, credit: invoice.gst },
      { code: ACC.otherIncome, credit: charges, description: 'Freight / loading / installation' },
    ],
  }
}

// Credit note: reverses the same shares of goods revenue, charges income and
// output GST that the invoice booked.
export function creditNoteEntry(note: { id: number; displayId: string; amount: number; date: Date; invoice: { displayId: string; total: number; gst: number; transportCost: number; freightCharge: number; loadingCharge: number; installationCharge: number } }): DraftEntry {
  const inv = note.invoice
  const charges = inv.transportCost + inv.freightCharge + inv.loadingCharge + inv.installationCharge
  const gstPart = inv.total > 0 ? Math.round(note.amount * inv.gst / inv.total) : 0
  const chargesPart = inv.total > 0 ? Math.round(note.amount * charges / inv.total) : 0
  return {
    sourceKey: `CN:${note.id}`, date: note.date, narration: `Credit note ${note.displayId} on ${inv.displayId}`, referenceType: 'CreditNote', referenceId: note.id,
    lines: [
      { code: ACC.sales, debit: note.amount - gstPart - chargesPart },
      { code: ACC.otherIncome, debit: chargesPart, description: 'Freight / loading / installation' },
      { code: ACC.gstOutput, debit: gstPart },
      { code: ACC.receivable, credit: note.amount },
    ],
  }
}

// ─── Documents whose journal follows the document ──────────────────────────
// A document's entry is posted as PREFIX:id. If the document is edited after
// posting, the live entry is reversed (REV:<key>) and the new state posted as
// PREFIX:id~2, ~3 … Cancelled, rejected or deleted documents are reversed.
// Older reversal keys (INVREV:, BILLREV:, EXPREV:) are still recognised.
export const FOLLOWED_PREFIXES = ['INV', 'PAY', 'CN', 'RF', 'BILL', 'PPAY', 'EXP', 'LC'] as const
const LEGACY_REVERSAL: Record<string, string> = { INV: 'INVREV', BILL: 'BILLREV', EXP: 'EXPREV' }

export type DocState = { prefix: string; id: number; entry: DraftEntry | null; endedAt?: Date }
export type PostedEntry = { status: string; date: Date; narration: string; referenceType: string | null; referenceId: number | null; lines: { accountId: number; debit: number; credit: number }[] }

function entrySignature(date: Date, lines: { accountId: number; debit: number; credit: number }[]) {
  return `${date.getTime()}|${lines.map(line => `${line.accountId}:${line.debit}:${line.credit}`).sort().join(',')}`
}

export function reconcileDocuments(docs: DocState[], status: Map<string, string>, postedEntries: Map<string, PostedEntry>, accountIds: Map<string, number>) {
  const codeOf = new Map([...accountIds].map(([code, id]) => [id, code]))
  const versions = new Map<string, { key: string; version: number }[]>()
  for (const key of postedEntries.keys()) {
    const match = key.match(/^([A-Z]+):(\d+)(?:~(\d+))?$/)
    if (!match) continue
    const doc = `${match[1]}:${match[2]}`
    versions.set(doc, [...(versions.get(doc) || []), { key, version: match[3] ? Number(match[3]) : 1 }])
  }
  const all = new Map(docs.map(doc => [`${doc.prefix}:${doc.id}`, doc]))
  // Deleted documents: nothing in the database any more, entry still live.
  for (const doc of versions.keys()) {
    if (all.has(doc)) continue
    const [prefix, id] = doc.split(':')
    all.set(doc, { prefix, id: Number(id), entry: null })
  }

  const drafts: DraftEntry[] = []
  const skipped: string[] = []
  for (const [docKey, doc] of all) {
    const existing = versions.get(docKey) || []
    const legacy = LEGACY_REVERSAL[doc.prefix]
    const live = existing.map(row => row.key).filter(key =>
      postedEntries.get(key)?.status === 'POSTED'
      && status.get(`REV:${key}`) !== 'POSTED'
      && !(legacy && key === docKey && status.get(`${legacy}:${doc.id}`) === 'POSTED'))

    let want: string | null = null
    if (doc.entry) {
      const lines = normalizeLines(doc.entry.lines)
      if (!balanced(lines) || lines.some(line => !accountIds.has(line.code))) { skipped.push(docKey); continue }
      want = entrySignature(doc.entry.date, lines.map(line => ({ accountId: accountIds.get(line.code) as number, debit: line.debit || 0, credit: line.credit || 0 })))
    }
    const keep = want ? live.find(key => {
      const posted = postedEntries.get(key) as PostedEntry
      return entrySignature(posted.date, posted.lines) === want
    }) : undefined

    for (const key of live) {
      if (key === keep) continue
      const posted = postedEntries.get(key) as PostedEntry
      if (posted.lines.some(line => !codeOf.has(line.accountId))) { skipped.push(`REV:${key}`); continue }
      // Edits and deletions undo the old entry in its own period; a cancellation
      // or rejection is booked on the day it happened.
      const date = doc.entry ? posted.date : (doc.endedAt ?? posted.date)
      drafts.push({
        sourceKey: `REV:${key}`, reverses: key, date, narration: `Reversed: ${posted.narration}`,
        referenceType: posted.referenceType || doc.prefix, referenceId: posted.referenceId ?? doc.id,
        lines: posted.lines.map(line => ({ code: codeOf.get(line.accountId) as string, debit: line.credit, credit: line.debit })),
      })
    }
    if (doc.entry && !keep) {
      const next = existing.length === 0 ? null : Math.max(...existing.map(row => row.version)) + 1
      drafts.push({ ...doc.entry, sourceKey: next ? `${docKey}~${next}` : docKey })
    }
  }
  return { drafts, skipped }
}

async function ensureAccounts(db: Db) {
  const accounts = await db.ledgerAccount.findMany({ select: { id: true, code: true } })
  if (accounts.length === 0) throw new Error('Create the chart of accounts first (Financials → Chart of Accounts → Seed)')
  const have = new Set(accounts.map(account => account.code))
  for (const extra of EXTRA_ACCOUNTS) {
    if (have.has(extra.code)) continue
    const group = await db.accountGroup.upsert({ where: { name: extra.group }, create: { name: extra.group, type: extra.type }, update: {} })
    accounts.push(await db.ledgerAccount.create({ data: { code: extra.code, name: extra.name, groupId: group.id, isSystemAccount: true }, select: { id: true, code: true } }))
  }
  return new Map(accounts.map(account => [account.code, account.id]))
}

async function collectEntries(db: Db, posted: Set<string>, status: Map<string, string>, accountIds: Map<string, number>): Promise<{ entries: DraftEntry[]; skipped: string[] }> {
  const entries: DraftEntry[] = []
  const docs: DocState[] = []
  const [invoices, payments, creditNotes, ledger, bills, purchasePayments, expenses, payrolls] = await Promise.all([
    db.invoice.findMany({ where: { heldAt: null }, select: { id: true, displayId: true, date: true, updatedAt: true, total: true, gst: true, transportCost: true, freightCharge: true, loadingCharge: true, installationCharge: true, invoiceStatus: true } }),
    db.payment.findMany({ where: { amount: { gt: 0 } }, select: { id: true, amount: true, method: true, date: true, invoice: { select: { displayId: true, heldAt: true } } } }),
    db.creditNote.findMany({ select: { id: true, displayId: true, amount: true, date: true, invoice: { select: { total: true, gst: true, displayId: true, transportCost: true, freightCharge: true, loadingCharge: true, installationCharge: true } } } }),
    db.stockLedger.findMany({ select: { id: true, productId: true, entryType: true, referenceType: true, referenceId: true, quantity: true, unitCost: true, createdAt: true, product: { select: { name: true, costPrice: true } } } }),
    db.vendorBill.findMany({ where: { status: { in: ['POSTED', 'CANCELLED'] }, postedAt: { not: null } }, select: { id: true, displayId: true, vendorRef: true, poId: true, status: true, subtotal: true, gst: true, total: true, billDate: true, updatedAt: true } }),
    db.purchasePayment.findMany({ select: { id: true, amount: true, method: true, paidAt: true, po: { select: { displayId: true } } } }),
    db.expense.findMany({ select: { id: true, amount: true, date: true, status: true, paymentMode: true, description: true, updatedAt: true, category: { select: { name: true } } } }),
    db.payrollRun.findMany({ where: { status: { in: ['APPROVED', 'PAID'] } }, select: { id: true, displayId: true, period: true, status: true, totalGross: true, totalNet: true, totalDeductions: true, employerContributions: true, processedAt: true, paidAt: true } }),
  ])

  for (const invoice of invoices) {
    docs.push({ prefix: 'INV', id: invoice.id, entry: invoice.invoiceStatus === 'CANCELLED' ? null : invoiceEntry(invoice), endedAt: invoice.updatedAt })
  }
  for (const payment of payments) {
    docs.push({ prefix: 'PAY', id: payment.id, entry: payment.invoice.heldAt ? null : { sourceKey: `PAY:${payment.id}`, date: payment.date, narration: `Receipt for ${payment.invoice.displayId} (${payment.method})`, referenceType: 'Payment', referenceId: payment.id,
      lines: [{ code: cashAccount(payment.method), debit: payment.amount }, { code: ACC.receivable, credit: payment.amount }] } })
  }
  for (const note of creditNotes) docs.push({ prefix: 'CN', id: note.id, entry: creditNoteEntry(note) })
  for (const refund of await db.customerRefund.findMany({ select: { id: true, displayId: true, amount: true, method: true, refundedAt: true, invoice: { select: { displayId: true } } } })) {
    docs.push({ prefix: 'RF', id: refund.id, entry: { sourceKey: `RF:${refund.id}`, date: refund.refundedAt, narration: `Refund ${refund.displayId} to customer on ${refund.invoice.displayId} (${refund.method})`, referenceType: 'CustomerRefund', referenceId: refund.id,
      lines: [{ code: ACC.receivable, debit: refund.amount }, { code: cashAccount(refund.method), credit: refund.amount }] } })
  }

  // Each move is valued at the cost stamped when it happened. Rows from before
  // that stamp existed: receipts at their PO price, others at the current cost.
  const poIds = [...new Set(ledger.filter(row => row.unitCost == null && row.referenceType === 'PurchaseOrder' && row.referenceId).map(row => row.referenceId as number))]
  const poItems = poIds.length ? await db.purchaseOrderItem.findMany({ where: { poId: { in: poIds } }, select: { poId: true, productId: true, unitCost: true } }) : []
  const poCost = new Map(poItems.map(item => [`${item.poId}:${item.productId}`, item.unitCost]))
  for (const row of ledger) {
    const accounts = stockAccounts(row.entryType, row.referenceType, row.quantity)
    if (!accounts) continue
    const unit = row.unitCost ?? (row.referenceType === 'PurchaseOrder' ? poCost.get(`${row.referenceId}:${row.productId}`) ?? row.product.costPrice : row.product.costPrice)
    const value = Math.round(Math.abs(row.quantity) * unit)
    if (value === 0) continue
    entries.push({ sourceKey: `SLG:${row.id}`, date: row.createdAt, narration: `Stock ${row.entryType.toLowerCase()} · ${row.product.name} × ${Math.abs(row.quantity)}`, referenceType: 'StockLedger', referenceId: row.id,
      lines: [{ code: accounts[0], debit: value }, { code: accounts[1], credit: value }] })
  }

  // Serial-tracked stone never moves through the quantity ledger: each slab
  // posts its own receipt, sale (or damage) at lot cost per sq.ft.
  const slabs = await db.slab.findMany({ select: { id: true, slabNumber: true, sqft: true, status: true, soldAt: true, createdAt: true, lot: { select: { lotNumber: true, costPerSqft: true, poId: true, product: { select: { name: true } } } } } })
  const slabById = new Map(slabs.map(slab => [slab.id, slab]))
  for (const slab of slabs) {
    const value = Math.round(slab.sqft * slab.lot.costPerSqft)
    if (value === 0) continue
    const label = `${slab.lot.product.name} lot ${slab.lot.lotNumber} slab ${slab.slabNumber}`
    entries.push({ sourceKey: `SLABIN:${slab.id}`, date: slab.createdAt, narration: `Slab received · ${label}`, referenceType: 'Slab', referenceId: slab.id,
      lines: [{ code: ACC.inventory, debit: value }, { code: slab.lot.poId ? ACC.grni : ACC.openingEquity, credit: value }] })
    if (slab.status === 'SOLD' && slab.soldAt) {
      entries.push({ sourceKey: `SLABOUT:${slab.id}:${slab.soldAt.getTime()}`, date: slab.soldAt, narration: `Slab sold · ${label}`, referenceType: 'Slab', referenceId: slab.id,
        lines: [{ code: ACC.cogs, debit: value }, { code: ACC.inventory, credit: value }] })
    }
    if (slab.status === 'DAMAGED') {
      entries.push({ sourceKey: `SLABLOSS:${slab.id}`, date: slab.createdAt, narration: `Slab damaged · ${label}`, referenceType: 'Slab', referenceId: slab.id,
        lines: [{ code: ACC.inventoryAdjustment, debit: value }, { code: ACC.inventory, credit: value }] })
    }
  }
  // A write-off undone (slab restored from DAMAGED) is reversed.
  for (const key of posted) {
    const match = key.match(/^SLABLOSS:(\d+)$/)
    if (!match) continue
    const slab = slabById.get(Number(match[1]))
    if (!slab || slab.status === 'DAMAGED') continue
    const value = Math.round(slab.sqft * slab.lot.costPerSqft)
    if (value === 0) continue
    entries.push({ sourceKey: `SLABLOSSREV:${match[1]}`, reverses: key, date: new Date(), narration: `Slab write-off reversed · slab ${slab.slabNumber}`, referenceType: 'Slab', referenceId: Number(match[1]),
      lines: [{ code: ACC.inventory, debit: value }, { code: ACC.inventoryAdjustment, credit: value }] })
  }
  // A sale that was undone (invoice cancelled / refunded) is reversed.
  for (const key of posted) {
    const match = key.match(/^SLABOUT:(\d+):(\d+)$/)
    if (!match) continue
    const slab = slabById.get(Number(match[1]))
    if (slab && slab.status === 'SOLD' && slab.soldAt?.getTime() === Number(match[2])) continue
    const value = slab ? Math.round(slab.sqft * slab.lot.costPerSqft) : 0
    if (value === 0) continue
    entries.push({ sourceKey: `SLABOUTREV:${match[1]}:${match[2]}`, reverses: key, date: new Date(), narration: `Slab sale reversed · slab ${slab?.slabNumber}`, referenceType: 'Slab', referenceId: Number(match[1]),
      lines: [{ code: ACC.inventory, debit: value }, { code: ACC.cogs, credit: value }] })
  }

  for (const bill of bills) {
    const entry: DraftEntry = { sourceKey: `BILL:${bill.id}`, date: bill.billDate, narration: `Vendor bill ${bill.displayId}${bill.vendorRef ? ` (${bill.vendorRef})` : ''}`, referenceType: 'VendorBill', referenceId: bill.id,
      lines: [{ code: bill.poId ? ACC.grni : ACC.purchases, debit: bill.subtotal }, { code: ACC.gstInput, debit: bill.gst }, { code: ACC.payable, credit: bill.total }] }
    docs.push({ prefix: 'BILL', id: bill.id, entry: bill.status === 'CANCELLED' ? null : entry, endedAt: bill.updatedAt })
  }
  for (const payment of purchasePayments) {
    docs.push({ prefix: 'PPAY', id: payment.id, entry: { sourceKey: `PPAY:${payment.id}`, date: payment.paidAt, narration: `Payment against ${payment.po.displayId} (${payment.method})`, referenceType: 'PurchasePayment', referenceId: payment.id,
      lines: [{ code: ACC.payable, debit: payment.amount }, { code: cashAccount(payment.method), credit: payment.amount }] } })
  }
  for (const expense of expenses) {
    const credit = String(expense.paymentMode).toLowerCase() === 'credit' ? ACC.payable : cashAccount(expense.paymentMode)
    const entry: DraftEntry = { sourceKey: `EXP:${expense.id}`, date: expense.date, narration: `Expense · ${expense.category.name}: ${expense.description}`, referenceType: 'Expense', referenceId: expense.id,
      lines: [{ code: expenseAccount(expense.category.name), debit: expense.amount }, { code: credit, credit: expense.amount }] }
    // Only approved expenses are on the books; rejecting one later reverses it.
    docs.push({ prefix: 'EXP', id: expense.id, entry: expense.status === 'Approved' ? entry : null, endedAt: expense.updatedAt })
  }
  for (const run of payrolls) {
    const date = new Date(`${run.period}-28T12:00:00`)
    entries.push({ sourceKey: `PAYROLL:${run.id}`, date: Number.isNaN(date.getTime()) ? run.processedAt : date, narration: `Payroll ${run.displayId} (${run.period})`, referenceType: 'PayrollRun', referenceId: run.id,
      lines: [
        { code: ACC.salary, debit: run.totalGross }, { code: ACC.employerPf, debit: run.employerContributions },
        { code: ACC.salaryPayable, credit: run.totalNet }, { code: ACC.pfEsiPayable, credit: run.totalDeductions + run.employerContributions },
      ] })
    if (run.status === 'PAID') {
      entries.push({ sourceKey: `PAYROLLPAID:${run.id}`, date: run.paidAt || run.processedAt, narration: `Salaries paid ${run.displayId}`, referenceType: 'PayrollRun', referenceId: run.id,
        lines: [{ code: ACC.salaryPayable, debit: run.totalNet }, { code: ACC.bank, credit: run.totalNet }] })
    }
  }
  const landed = await db.landedCost.findMany({ where: { status: { in: ['POSTED', 'CANCELLED'] } }, select: { id: true, displayId: true, status: true, date: true, updatedAt: true, creditTo: true, vendorRef: true, lines: { select: { amount: true, costType: true } }, allocations: { select: { toStock: true, toCogs: true } } } })
  for (const cost of landed) docs.push({ prefix: 'LC', id: cost.id, entry: cost.status === 'POSTED' ? landedCostEntry(cost) : null, endedAt: cost.updatedAt })

  const postedRows = await db.journalEntry.findMany({
    where: { OR: FOLLOWED_PREFIXES.map(prefix => ({ sourceKey: { startsWith: `${prefix}:` } })) },
    select: { sourceKey: true, status: true, date: true, narration: true, referenceType: true, referenceId: true, lines: { select: { accountId: true, debit: true, credit: true } } },
  })
  const postedEntries = new Map(postedRows.map(row => [row.sourceKey as string, row]))
  const followed = reconcileDocuments(docs, status, postedEntries, accountIds)
  entries.push(...followed.drafts)
  void posted
  return { entries, skipped: followed.skipped }
}

// Landed cost: capitalised into stock (or COGS for goods already sold),
// credited to where the cost was booked or paid.
export function landedCostCredit(creditTo: string, costType: string) {
  if (creditTo === 'PAYABLE') return ACC.payable
  if (creditTo === 'CASH') return ACC.cash
  if (creditTo === 'BANK') return ACC.bank
  return costType === 'FREIGHT' || costType === 'LOADING' ? ACC.freight : ACC.otherExpense
}

export function landedCostEntry(cost: { id: number; displayId: string; date: Date; creditTo: string; vendorRef?: string | null; lines: { amount: number; costType: string }[]; allocations: { toStock: number; toCogs: number }[] }): DraftEntry {
  const credits = new Map<string, number>()
  for (const line of cost.lines) {
    const code = landedCostCredit(cost.creditTo, line.costType)
    credits.set(code, (credits.get(code) || 0) + line.amount)
  }
  return {
    sourceKey: `LC:${cost.id}`, date: cost.date, narration: `Landed cost ${cost.displayId}${cost.vendorRef ? ` (${cost.vendorRef})` : ''}`, referenceType: 'LandedCost', referenceId: cost.id,
    lines: [
      { code: ACC.inventory, debit: cost.allocations.reduce((sum, row) => sum + row.toStock, 0) },
      { code: ACC.cogs, debit: cost.allocations.reduce((sum, row) => sum + row.toCogs, 0), description: 'Share of goods already sold' },
      ...[...credits].map(([code, amount]) => ({ code, credit: amount })),
    ],
  }
}

// Posts every missing auto entry. Idempotent: each source event has a unique
// sourceKey, so re-running only adds what happened since the last run.
export async function postAutoJournals(db: typeof prisma = prisma, author = 'Auto-posting') {
  const accountIds = await ensureAccounts(db)
  const statusRows = await db.journalEntry.findMany({ where: { sourceKey: { not: null } }, select: { sourceKey: true, status: true } })
  const status = new Map(statusRows.map(entry => [entry.sourceKey as string, entry.status]))
  const posted = new Set(status.keys())
  const collected = await collectEntries(db, posted, status, accountIds)
  const drafts = collected.entries
  // Originals before reversals, then chronological.
  const pending = drafts.filter(entry => !posted.has(entry.sourceKey))
    .sort((a, b) => Number(Boolean(a.reverses)) - Number(Boolean(b.reverses)) || a.date.getTime() - b.date.getTime())
  let count = 0
  const skipped: string[] = [...collected.skipped]
  for (const draft of pending) {
    // A reversal only makes sense once its original is on the books.
    if (draft.reverses && !posted.has(draft.reverses)) continue
    const lines = normalizeLines(draft.lines)
    if (!balanced(lines)) { skipped.push(draft.sourceKey); continue }
    const missing = lines.find(line => !accountIds.has(line.code))
    if (missing) { skipped.push(`${draft.sourceKey} (account ${missing.code} missing)`); continue }
    const total = lines.reduce((sum, line) => sum + (line.debit || 0), 0)
    try {
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463209)::text`
        const rows = await tx.$queryRaw<{ max: number | null }[]>`SELECT MAX(CAST(substring("displayId" from '^AE-([0-9]+)$') AS INTEGER)) AS max FROM "JournalEntry" WHERE "displayId" ~ '^AE-[0-9]+$'`
        await tx.journalEntry.create({
          data: {
            displayId: `AE-${String((rows[0]?.max || 0) + 1).padStart(6, '0')}`,
            date: draft.date, narration: draft.narration, referenceType: draft.referenceType, referenceId: draft.referenceId,
            totalDebit: total, totalCredit: total, status: 'POSTED', createdBy: author, sourceKey: draft.sourceKey, isAuto: true,
            lines: { create: lines.map(line => ({ accountId: accountIds.get(line.code) as number, debit: line.debit || 0, credit: line.credit || 0, description: line.description })) },
          },
        })
      })
      posted.add(draft.sourceKey)
      count += 1
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') { posted.add(draft.sourceKey); continue } // posted concurrently
      throw error
    }
  }
  return { posted: count, skipped, total: drafts.length }
}

// Drops zero lines; a negative amount moves to the opposite side.
export function normalizeLines(lines: DraftLine[]) {
  return lines.flatMap(line => {
    const debit = line.debit || 0
    const credit = line.credit || 0
    const net = debit - credit
    if (net === 0) return []
    return [{ ...line, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }]
  })
}

// Trial balance straight from posted journal lines.
export async function journalTrialBalance(db: Db, asOf: Date) {
  const [accounts, sums] = await Promise.all([
    db.ledgerAccount.findMany({ include: { group: { select: { name: true, type: true } } }, orderBy: { code: 'asc' } }),
    db.journalLine.groupBy({ by: ['accountId'], where: { journalEntry: { status: 'POSTED', date: { lte: asOf } } }, _sum: { debit: true, credit: true } }),
  ])
  const byAccount = new Map(sums.map(row => [row.accountId, row._sum]))
  const rows = accounts.map(account => {
    const sum = byAccount.get(account.id)
    const debit = (sum?.debit || 0) + Math.max(0, account.openingBalance)
    const credit = (sum?.credit || 0) + Math.max(0, -account.openingBalance)
    const balance = debit - credit
    return { id: account.id, code: account.code, name: account.name, group: account.group.name, type: account.group.type, debit, credit, balance }
  }).filter(row => row.debit !== 0 || row.credit !== 0)
  const totals = rows.reduce((acc, row) => ({ debit: acc.debit + row.debit, credit: acc.credit + row.credit }), { debit: 0, credit: 0 })
  return { rows, totals }
}
