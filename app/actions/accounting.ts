'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireActor, actionError } from '@/lib/erp/actor'
import { ACC, journalTrialBalance, postAutoJournals } from '@/lib/erp/accounting'

const ROLES = ['ADMIN', 'MANAGER'] as const

function endOfDay(value?: string) {
  const date = value ? new Date(`${value}T23:59:59.999`) : new Date()
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date')
  return date
}

export async function postJournalsNow() {
  try {
    const actor = await requireActor(...ROLES)
    const result = await postAutoJournals(prisma, actor.name)
    if (result.posted) revalidatePath('/accounting')
    return { success: true as const, data: result }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not post journals') }
  }
}

// Stock on hand valued at cost: quantity products at cost price, stone at
// available slab area × lot cost per sq.ft.
async function stockValuation() {
  const [products, slabs] = await Promise.all([
    prisma.product.findMany({ where: { isSlabTracked: false, stock: { not: 0 } }, select: { stock: true, costPrice: true } }),
    prisma.slab.findMany({ where: { status: { in: ['AVAILABLE', 'RESERVED', 'IN_PROCESSING'] } }, select: { sqft: true, lot: { select: { costPerSqft: true } } } }),
  ])
  const quantity = products.reduce((sum, product) => sum + Math.round(product.stock * product.costPrice), 0)
  const stone = slabs.reduce((sum, slab) => sum + Math.round(slab.sqft * slab.lot.costPerSqft), 0)
  return { quantity, stone, total: quantity + stone }
}

export async function getAccountingOverview(asOf?: string) {
  try {
    await requireActor(...ROLES)
    const date = endOfDay(asOf)
    const [trial, valuation, autoCount, manualCount] = await Promise.all([
      journalTrialBalance(prisma, date),
      stockValuation(),
      prisma.journalEntry.count({ where: { isAuto: true } }),
      prisma.journalEntry.count({ where: { isAuto: false } }),
    ])
    const byCode = new Map(trial.rows.map(row => [row.code, row.balance]))
    const sumType = (type: string) => trial.rows.filter(row => row.type === type).reduce((sum, row) => sum + row.balance, 0)
    const income = -sumType('INCOME')
    const expense = sumType('EXPENSE')
    return {
      success: true as const,
      data: {
        trial,
        summary: {
          assets: sumType('ASSET'), liabilities: -sumType('LIABILITY'), equity: -sumType('EQUITY'),
          income, expense, profit: income - expense,
          receivable: byCode.get(ACC.receivable) || 0, payable: -(byCode.get(ACC.payable) || 0),
          gstOutput: -(byCode.get(ACC.gstOutput) || 0), gstInput: byCode.get(ACC.gstInput) || 0,
          grni: -(byCode.get(ACC.grni) || 0),
        },
        inventory: { books: byCode.get(ACC.inventory) || 0, valuation },
        entries: { auto: autoCount, manual: manualCount },
      },
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load accounting') }
  }
}

export async function getGeneralLedger(code: string, from?: string, to?: string) {
  try {
    await requireActor(...ROLES)
    const account = await prisma.ledgerAccount.findUnique({ where: { code }, include: { group: { select: { name: true, type: true } } } })
    if (!account) throw new Error('Account not found')
    const start = from ? new Date(`${from}T00:00:00`) : new Date(new Date().getFullYear(), 3, 1)
    const end = endOfDay(to)
    const [opening, lines] = await Promise.all([
      prisma.journalLine.aggregate({ where: { accountId: account.id, journalEntry: { status: 'POSTED', date: { lt: start } } }, _sum: { debit: true, credit: true } }),
      prisma.journalLine.findMany({
        where: { accountId: account.id, journalEntry: { status: 'POSTED', date: { gte: start, lte: end } } },
        include: { journalEntry: { select: { id: true, displayId: true, date: true, narration: true, referenceType: true, referenceId: true, isAuto: true } } },
        orderBy: [{ journalEntry: { date: 'asc' } }, { id: 'asc' }],
        take: 2000,
      }),
    ])
    let running = account.openingBalance + (opening._sum.debit || 0) - (opening._sum.credit || 0)
    const openingBalance = running
    const rows = lines.map(line => {
      running += line.debit - line.credit
      return { id: line.id, date: line.journalEntry.date, entry: line.journalEntry.displayId, narration: line.journalEntry.narration, description: line.description, debit: line.debit, credit: line.credit, balance: running, referenceType: line.journalEntry.referenceType, referenceId: line.journalEntry.referenceId }
    })
    return { success: true as const, data: { account: { code: account.code, name: account.name, group: account.group.name, type: account.group.type }, openingBalance, closingBalance: running, rows } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load the ledger') }
  }
}

export async function getJournalList(filters: { search?: string; source?: string; limit?: number } = {}) {
  try {
    await requireActor(...ROLES)
    const search = filters.search?.trim()
    const entries = await prisma.journalEntry.findMany({
      where: {
        ...(filters.source === 'auto' ? { isAuto: true } : filters.source === 'manual' ? { isAuto: false } : {}),
        ...(search ? { OR: [{ displayId: { contains: search, mode: 'insensitive' } }, { narration: { contains: search, mode: 'insensitive' } }] } : {}),
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: Math.min(filters.limit || 200, 500),
      include: { lines: { include: { account: { select: { code: true, name: true } } } } },
    })
    return { success: true as const, data: entries }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load journal entries') }
  }
}

// One-time alignment: stock that existed before auto-posting (or without a
// ledger trail) is brought onto the books against opening balance equity.
export async function postOpeningStockDifference() {
  try {
    const actor = await requireActor('ADMIN')
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463209)::text`
      const [inventoryAccount, equityAccount] = await Promise.all([
        tx.ledgerAccount.findUnique({ where: { code: ACC.inventory } }),
        tx.ledgerAccount.findUnique({ where: { code: ACC.openingEquity } }),
      ])
      if (!inventoryAccount || !equityAccount) throw new Error('Post journals once first so the accounts exist')
      const books = await tx.journalLine.aggregate({ where: { accountId: inventoryAccount.id, journalEntry: { status: 'POSTED' } }, _sum: { debit: true, credit: true } })
      const valuation = await stockValuation()
      const difference = valuation.total - ((books._sum.debit || 0) - (books._sum.credit || 0))
      if (difference === 0) throw new Error('Inventory on the books already matches the stock valuation')
      const key = `OPENSTOCK:${new Date().toISOString().slice(0, 10)}`
      if (await tx.journalEntry.findUnique({ where: { sourceKey: key } })) throw new Error('An opening stock alignment was already posted today')
      const rows = await tx.$queryRaw<{ max: number | null }[]>`SELECT MAX(CAST(substring("displayId" from '^AE-([0-9]+)$') AS INTEGER)) AS max FROM "JournalEntry" WHERE "displayId" ~ '^AE-[0-9]+$'`
      const amount = Math.abs(difference)
      await tx.journalEntry.create({
        data: {
          displayId: `AE-${String((rows[0]?.max || 0) + 1).padStart(6, '0')}`,
          date: new Date(), narration: 'Opening stock alignment to inventory valuation', referenceType: 'OpeningStock', referenceId: 0,
          totalDebit: amount, totalCredit: amount, status: 'POSTED', createdBy: actor.name, sourceKey: key, isAuto: true,
          lines: { create: difference > 0
            ? [{ accountId: inventoryAccount.id, debit: amount, credit: 0 }, { accountId: equityAccount.id, debit: 0, credit: amount }]
            : [{ accountId: equityAccount.id, debit: amount, credit: 0 }, { accountId: inventoryAccount.id, debit: 0, credit: amount }] },
        },
      })
      return { difference }
    })
    revalidatePath('/accounting')
    return { success: true as const, data: result }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not align opening stock') }
  }
}
