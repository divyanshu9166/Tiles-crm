'use server'

import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth-helpers'
import { createJournalSchema, createAccountSchema } from '@/lib/validations/financials'
import { creditNoteSplit } from '@/lib/erp/gst-math'
import { refundDue } from '@/lib/erp/credit-notes'

const prismaDynamic = prisma as unknown as {
  purchasePayment?: {
    aggregate: (...args: unknown[]) => Promise<{ _sum: { amount: number | null }, _count?: { id: number } }>
  }
}

async function aggregatePurchasePayments(where: Record<string, unknown>) {
  if (!prismaDynamic.purchasePayment) return { _sum: { amount: 0 }, _count: { id: 0 } }
  return prismaDynamic.purchasePayment.aggregate({ where, _sum: { amount: true }, _count: { id: true } })
}

// Credit notes in a window, split into the shares their invoices booked:
// goods revenue, freight/installation income and output GST.
async function creditNoteShares(date: { gte?: Date; lte: Date }) {
  const notes = await prisma.creditNote.findMany({
    where: { date },
    select: { amount: true, invoice: { select: { total: true, gst: true, transportCost: true, freightCharge: true, loadingCharge: true, installationCharge: true } } },
  })
  const shares = notes.map(note => creditNoteSplit(note.amount, note.invoice))
  return {
    count: notes.length,
    amount: notes.reduce((s, n) => s + n.amount, 0),
    goods: shares.reduce((s, x) => s + x.goods, 0),
    charges: shares.reduce((s, x) => s + x.charges, 0),
    gst: shares.reduce((s, x) => s + x.gst, 0),
  }
}

// A credit note is not cash: it first cancels what the customer still owes.
// Only credit beyond that (on bills already paid) is owed back to the customer.
async function refundsOwedToCustomers(asOf: Date) {
  const invoices = await prisma.invoice.findMany({
    where: { date: { lte: asOf }, heldAt: null, invoiceStatus: { not: 'CANCELLED' }, creditNotes: { some: { date: { lte: asOf } } } },
    select: {
      total: true,
      payments: { where: { date: { lte: asOf } }, select: { amount: true } },
      creditNotes: { where: { date: { lte: asOf } }, select: { amount: true } },
      refunds: { where: { refundedAt: { lte: asOf } }, select: { amount: true } },
    },
  })
  return invoices.reduce((sum, inv) => sum + refundDue(
    inv.total,
    inv.payments.reduce((s, p) => s + p.amount, 0),
    inv.creditNotes.reduce((s, c) => s + c.amount, 0),
    inv.refunds.reduce((s, r) => s + r.amount, 0),
  ), 0)
}

// Cash and bank money handed back to customers up to a date.
async function refundsPaidOut(range: { gte?: Date; lte: Date }) {
  return (await prisma.customerRefund.aggregate({ where: { refundedAt: range }, _sum: { amount: true } }))._sum.amount || 0
}

// Bills that count as sales: issued and not cancelled. Fully refunded bills stay
// in, because their credit notes are subtracted separately.
const SOLD: Prisma.InvoiceWhereInput = { heldAt: null, invoiceStatus: { in: ['ACTIVE', 'REFUNDED'] } }
// Supplier dues: everything ordered except drafts and cancelled orders.
const PAYABLE_PO: Prisma.EnumPOStatusFilter = { notIn: ['CANCELLED', 'DRAFT'] }
// Input tax credit comes from posted supplier bills, as in GSTR-2/3B.
const ITC_BILLS: Prisma.VendorBillWhereInput = { status: 'POSTED', OR: [{ poId: null }, { po: { itcEligible: true, itcCategory: { not: 'INELIGIBLE' } } }] }

// ─── CHART OF ACCOUNTS ────────────────────────────────

const DEFAULT_ACCOUNTS = [
  // Assets
  { groupName: 'Current Assets',   type: 'ASSET',     code: '1001', name: 'Cash in Hand' },
  { groupName: 'Current Assets',   type: 'ASSET',     code: '1002', name: 'Bank Account' },
  { groupName: 'Current Assets',   type: 'ASSET',     code: '1100', name: 'Accounts Receivable' },
  { groupName: 'Current Assets',   type: 'ASSET',     code: '1200', name: 'Closing Stock / Inventory' },
  { groupName: 'Current Assets',   type: 'ASSET',     code: '1300', name: 'GST Input Credit (ITC)' },
  { groupName: 'Current Assets',   type: 'ASSET',     code: '1400', name: 'Advance to Suppliers' },
  { groupName: 'Fixed Assets',     type: 'ASSET',     code: '1500', name: 'Plant & Machinery' },
  { groupName: 'Fixed Assets',     type: 'ASSET',     code: '1510', name: 'Furniture & Fixtures' },
  // Liabilities
  { groupName: 'Current Liabilities', type: 'LIABILITY', code: '2001', name: 'Accounts Payable' },
  { groupName: 'Current Liabilities', type: 'LIABILITY', code: '2100', name: 'GST Payable (Output)' },
  { groupName: 'Current Liabilities', type: 'LIABILITY', code: '2200', name: 'Salary Payable' },
  { groupName: 'Current Liabilities', type: 'LIABILITY', code: '2300', name: 'PF / ESI Payable' },
  { groupName: 'Current Liabilities', type: 'LIABILITY', code: '2400', name: 'TDS Payable' },
  { groupName: 'Current Liabilities', type: 'LIABILITY', code: '2500', name: 'Advance from Customers' },
  { groupName: 'Long Term Liabilities', type: 'LIABILITY', code: '2900', name: 'Bank Loan' },
  // Equity
  { groupName: 'Equity',           type: 'EQUITY',    code: '3001', name: "Owner's Capital" },
  { groupName: 'Equity',           type: 'EQUITY',    code: '3100', name: 'Retained Earnings' },
  { groupName: 'Equity',           type: 'EQUITY',    code: '3200', name: 'Drawings' },
  // Income
  { groupName: 'Revenue',          type: 'INCOME',    code: '4001', name: 'Sales Revenue' },
  { groupName: 'Revenue',          type: 'INCOME',    code: '4100', name: 'Other Income' },
  { groupName: 'Revenue',          type: 'INCOME',    code: '4200', name: 'Interest Income' },
  // Expenses
  { groupName: 'Cost of Goods Sold', type: 'EXPENSE', code: '5001', name: 'Cost of Goods Sold' },
  { groupName: 'Cost of Goods Sold', type: 'EXPENSE', code: '5010', name: 'Opening Stock' },
  { groupName: 'Cost of Goods Sold', type: 'EXPENSE', code: '5020', name: 'Purchases' },
  { groupName: 'Operating Expenses', type: 'EXPENSE', code: '5100', name: 'Salary Expense' },
  { groupName: 'Operating Expenses', type: 'EXPENSE', code: '5110', name: 'Employer PF Contribution' },
  { groupName: 'Operating Expenses', type: 'EXPENSE', code: '5120', name: 'Employer ESI Contribution' },
  { groupName: 'Operating Expenses', type: 'EXPENSE', code: '5200', name: 'Rent Expense' },
  { groupName: 'Operating Expenses', type: 'EXPENSE', code: '5300', name: 'Electricity & Utilities' },
  { groupName: 'Operating Expenses', type: 'EXPENSE', code: '5400', name: 'Transport / Freight' },
  { groupName: 'Operating Expenses', type: 'EXPENSE', code: '5500', name: 'Marketing & Advertising' },
  { groupName: 'Operating Expenses', type: 'EXPENSE', code: '5600', name: 'Discount Allowed' },
  { groupName: 'Operating Expenses', type: 'EXPENSE', code: '5700', name: 'Bank Charges' },
  { groupName: 'Operating Expenses', type: 'EXPENSE', code: '5800', name: 'Depreciation' },
  { groupName: 'Operating Expenses', type: 'EXPENSE', code: '5900', name: 'Other Expenses' },
]

function parseAsOfDate(asOfDate: string) {
  const asOf = new Date(asOfDate)
  if (Number.isNaN(asOf.getTime())) return null
  asOf.setHours(23, 59, 59, 999)
  return asOf
}

function parseDateRange(fromDate: string, toDate: string) {
  const from = new Date(fromDate)
  const to = new Date(toDate)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null
  if (from > to) return null
  to.setHours(23, 59, 59, 999)
  return { from, to }
}

function calcAgingRisk(totalOutstanding: number, over90Amount: number, topItems: Array<{ balanceDue: number }>, weightedDays: number) {
  const top5 = topItems
    .slice()
    .sort((a, b) => b.balanceDue - a.balanceDue)
    .slice(0, 5)
    .reduce((s, i) => s + i.balanceDue, 0)

  return {
    over90Amount,
    over90SharePct: totalOutstanding > 0 ? (over90Amount / totalOutstanding) * 100 : 0,
    top5SharePct: totalOutstanding > 0 ? (top5 / totalOutstanding) * 100 : 0,
    averageDaysPastDue: totalOutstanding > 0 ? weightedDays / totalOutstanding : 0,
  }
}

export async function seedChartOfAccounts() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const existing = await prisma.ledgerAccount.count()
  if (existing > 0) return { success: true, message: 'Chart of accounts already exists' }

  for (const acc of DEFAULT_ACCOUNTS) {
    const group = await prisma.accountGroup.upsert({
      where: { name: acc.groupName },
      create: { name: acc.groupName, type: acc.type },
      update: {},
    })
    await prisma.ledgerAccount.upsert({
      where: { code: acc.code },
      create: { code: acc.code, name: acc.name, groupId: group.id, isSystemAccount: true },
      update: {},
    })
  }

  revalidatePath('/financials')
  return { success: true, message: 'Chart of accounts created' }
}

export async function getAccounts() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const groups = await prisma.accountGroup.findMany({
    include: { accounts: { orderBy: { code: 'asc' } } },
    orderBy: { name: 'asc' },
  })
  return { success: true, data: groups }
}

export async function createAccount(data: unknown) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const parsed = createAccountSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const exists = await prisma.ledgerAccount.findFirst({ where: { code: parsed.data.code } })
  if (exists) return { success: false, error: `Account code ${parsed.data.code} already exists` }

  const acc = await prisma.ledgerAccount.create({ data: parsed.data })
  revalidatePath('/financials')
  return { success: true, data: acc }
}

// ─── PROFIT & LOSS (CORRECTED) ────────────────────────

export async function getProfitAndLoss(fromDate: string, toDate: string, compareFrom?: string, compareTo?: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  if (!parseDateRange(fromDate, toDate)) {
    return { success: false, error: 'Invalid date range' }
  }

  async function fetchPL(fd: string, td: string) {
    const range = parseDateRange(fd, td)
    if (!range) return null
    const { from, to } = range

    const [invoiceAgg, notes, stockMoves, purchaseAgg, payrollAgg, employerPayroll, expenseRows] = await Promise.all([
      // Gross sales from invoices (refunded ones too; their credit notes come off below)
      prisma.invoice.aggregate({
        where: { date: { gte: from, lte: to }, ...SOLD },
        _sum: { subtotal: true, discount: true, gst: true, total: true },
        _count: { id: true },
      }),
      // Returns, split into goods / charges / GST like their invoices
      creditNoteShares({ gte: from, lte: to }),
      // COGS: goods delivered or sold minus goods returned, each at the cost it had when it moved
      prisma.stockLedger.findMany({
        where: { entryType: { in: ['SALE', 'RETURN'] }, createdAt: { gte: from, lte: to } },
        select: { quantity: true, unitCost: true, product: { select: { costPrice: true } } },
      }),
      // Purchases in period (for reference, not used for COGS)
      prisma.purchaseOrder.aggregate({
        where: { date: { gte: from, lte: to }, status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] } },
        _sum: { subtotal: true, discount: true, gst: true, total: true },
      }),
      // Payroll — net pay
      prisma.payrollRun.aggregate({
        where: { status: { in: ['APPROVED', 'PAID'] }, period: { gte: fd.substring(0, 7), lte: td.substring(0, 7) } },
        _sum: { totalNet: true, totalGross: true, totalDeductions: true },
      }),
      // Employer PF/ESI/Bonus contributions
      prisma.payrollRun.aggregate({
        where: { status: { in: ['APPROVED', 'PAID'] }, period: { gte: fd.substring(0, 7), lte: td.substring(0, 7) } },
        _sum: { employerContributions: true },
      }),
      // Approved operating expenses (rent, freight, electricity, ...) by category
      prisma.expense.groupBy({
        by: ['categoryId'],
        where: { date: { gte: from, lte: to }, status: 'Approved' },
        _sum: { amount: true },
      }),
    ])
    const expenseCategories = expenseRows.length
      ? await prisma.expenseCategory.findMany({ where: { id: { in: expenseRows.map(row => row.categoryId) } }, select: { id: true, name: true } })
      : []
    const categoryName = new Map(expenseCategories.map(category => [category.id, category.name]))
    const expenseLines = expenseRows
      .map(row => ({ category: categoryName.get(row.categoryId) || 'Other', amount: row._sum.amount || 0 }))
      .sort((a, b) => b.amount - a.amount)
    const otherExpenses = expenseLines.reduce((sum, line) => sum + line.amount, 0)

    // Revenue
    const grossSales = invoiceAgg._sum.total || 0
    const salesExGST = (invoiceAgg._sum.subtotal || 0) - (invoiceAgg._sum.discount || 0)
    const salesGST = invoiceAgg._sum.gst || 0
    // Only the goods share of a credit note reverses sales; its GST reverses
    // output tax and its freight/installation share reverses other income.
    const returns = notes.goods
    const netRevenue = salesExGST - returns

    // Same valuation as the COGS journal: stamped cost, current cost only for rows from before the stamp.
    const cogs = Math.round(stockMoves.reduce((sum, move) => sum - move.quantity * (move.unitCost ?? move.product.costPrice ?? 0), 0))
    const grossProfit = netRevenue - cogs
    const grossMarginPct = netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0

    // Operating expenses
    const salaryExpense = payrollAgg._sum.totalGross || 0  // use gross (employee cost to employer)
    const employerPFESI = employerPayroll._sum.employerContributions || 0
    const totalOpEx = salaryExpense + employerPFESI + otherExpenses

    const operatingProfit = grossProfit - totalOpEx
    const netProfit = operatingProfit  // no interest/tax in this simplified model
    const netMarginPct = netRevenue > 0 ? (netProfit / netRevenue) * 100 : 0
    const opMarginPct = netRevenue > 0 ? (operatingProfit / netRevenue) * 100 : 0

    // Purchases (for reference)
    const purchasesExGST = (purchaseAgg._sum.subtotal || 0) - (purchaseAgg._sum.discount || 0)

    return {
      period: { from: fd, to: td },
      invoiceCount: invoiceAgg._count.id,
      returnCount: notes.count,
      revenue: { grossSales, salesExGST, salesGST, returns, netRevenue },
      cogs: { total: cogs, note: 'Goods sold minus goods returned, at the cost when they moved' },
      grossProfit, grossMarginPct,
      purchases: { total: purchasesExGST, gst: purchaseAgg._sum.gst || 0 },
      operatingExpenses: {
        salary: salaryExpense,
        employerPFESI,
        expenses: otherExpenses,
        expenseLines,
        total: totalOpEx,
      },
      operatingProfit, opMarginPct,
      netProfit, netMarginPct,
    }
  }

  const current = await fetchPL(fromDate, toDate)
  if (!current) return { success: false, error: 'Invalid date range' }
  let compare: Awaited<ReturnType<typeof fetchPL>> = null
  if (compareFrom && compareTo) {
    compare = await fetchPL(compareFrom, compareTo)
    if (!compare) return { success: false, error: 'Invalid comparison date range' }
  }

  return { success: true, data: { current, compare } }
}

// ─── BALANCE SHEET ────────────────────────────────────

export async function getBalanceSheet(asOfDate: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const asOf = parseAsOfDate(asOfDate)
  if (!asOf) return { success: false, error: 'Invalid as-of date' }

  const [
    payments, supplierPaid, receivables, poPayables,
    products, gstOutputInvoices, gstInputPOs,
    payrollPayable, staffLoans, salaryPaid,
    loanRecoveries, notes, refundsOwed, refundsPaid,
  ] = await Promise.all([
    // Cash collected from customers (payments on refunded bills were still received)
    prisma.payment.aggregate({ where: { date: { lte: asOf }, invoice: { invoiceStatus: { not: 'CANCELLED' } } }, _sum: { amount: true } }),
    // Cash paid to suppliers (amountPaid on POs)
    aggregatePurchasePayments({ paidAt: { lte: asOf } }),
    // Accounts receivable (outstanding invoices)
    prisma.invoice.aggregate({ where: { invoiceStatus: 'ACTIVE', heldAt: null, date: { lte: asOf } }, _sum: { balanceDue: true } }),
    // Accounts payable (outstanding POs, not drafts)
    prisma.purchaseOrder.aggregate({ where: { date: { lte: asOf }, status: PAYABLE_PO }, _sum: { balanceDue: true } }),
    // Inventory at cost price
    prisma.product.findMany({ select: { stock: true, costPrice: true } }),
    // GST output (from invoices; credit-note GST comes off below)
    prisma.invoice.aggregate({ where: { date: { lte: asOf }, ...SOLD }, _sum: { gst: true } }),
    // GST input (ITC from posted supplier bills)
    prisma.vendorBill.aggregate({ where: { billDate: { lte: asOf }, ...ITC_BILLS }, _sum: { gst: true } }),
    // Salary payable (approved but unpaid payroll)
    prisma.payrollRun.aggregate({ where: { status: 'APPROVED' }, _sum: { totalNet: true } }),
    // Staff loans outstanding (assets — money owed by staff)
    prisma.staffLoan.aggregate({ where: { status: 'Active' }, _sum: { remainingAmount: true } }),
    prisma.payrollRun.aggregate({ where: { status: 'PAID', paidAt: { lte: asOf } }, _sum: { totalNet: true } }),
    prisma.payslip.aggregate({ where: { payrollRun: { status: 'PAID', paidAt: { lte: asOf } } }, _sum: { loanDeduction: true } }),
    creditNoteShares({ lte: asOf }),
    refundsOwedToCustomers(asOf),
    refundsPaidOut({ lte: asOf }),
  ])

  const cashCollected = payments._sum.amount || 0
  const cashPaidToSuppliers = supplierPaid._sum.amount || 0
  const salaryPaidOut = salaryPaid._sum.totalNet || 0
  const loanInflow = loanRecoveries._sum.loanDeduction || 0
  const cashAndBank = cashCollected + loanInflow - cashPaidToSuppliers - salaryPaidOut - refundsPaid

  const accountsReceivable = receivables._sum.balanceDue || 0
  const inventoryValue = products.reduce((sum: number, p: { stock: number, costPrice: number | null }) => sum + p.stock * (p.costPrice || 0), 0)
  const staffLoanAsset = staffLoans._sum.remainingAmount || 0
  const itcAsset = gstInputPOs._sum.gst || 0

  const totalCurrentAssets = cashAndBank + accountsReceivable + inventoryValue + itcAsset + staffLoanAsset
  const totalAssets = totalCurrentAssets

  const accountsPayable = poPayables._sum.balanceDue || 0
  const gstOutput = (gstOutputInvoices._sum.gst || 0) - notes.gst
  const gstInput = itcAsset
  const netGSTPayable = Math.max(0, gstOutput - gstInput)
  const salaryPayable = payrollPayable._sum.totalNet || 0

  const totalLiabilities = accountsPayable + netGSTPayable + salaryPayable + refundsOwed

  // Equity = Assets - Liabilities (derived)
  const equity = totalAssets - totalLiabilities

  return {
    success: true,
    data: {
      asOfDate,
      currentAssets: {
        cashAndBank,
        accountsReceivable,
        inventory: inventoryValue,
        itcReceivable: itcAsset,
        staffLoans: staffLoanAsset,
        total: totalCurrentAssets,
      },
      totalAssets,
      currentLiabilities: {
        accountsPayable,
        netGSTPayable,
        gstOutput,
        gstInput,
        salaryPayable,
        refundsOwed,
        total: totalLiabilities,
      },
      equity: {
        derived: equity,
        note: 'Equity = Total Assets − Total Liabilities',
      },
      quality: {
        cashModel: 'Cash = customer collections + payroll loan recoveries - supplier payouts - salary payouts - refunds paid to customers. Credit notes reduce receivables; credit beyond what was owed and not yet paid back is shown as refunds owed to customers.',
      },
    },
  }
}

// ─── CASH FLOW ────────────────────────────────────────

export async function getCashFlow(fromDate: string, toDate: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const range = parseDateRange(fromDate, toDate)
  if (!range) return { success: false, error: 'Invalid date range' }
  const { from, to } = range

  // Credit notes are not an outflow by themselves; only refunds actually paid out are.
  const [salesCollections, supplierPayments, salaryPayments, loanCollections, refundOutflow] = await Promise.all([
    // Inflow: cash collected from customers (payments on refunded bills were still received)
    prisma.payment.aggregate({ where: { date: { gte: from, lte: to }, invoice: { invoiceStatus: { not: 'CANCELLED' } } }, _sum: { amount: true } }),
    // Outflow: actual supplier payments (event-based)
    aggregatePurchasePayments({ paidAt: { gte: from, lte: to } }),
    // Outflow: salaries paid
    prisma.payrollRun.aggregate({
      where: { status: 'PAID', paidAt: { gte: from, lte: to } },
      _sum: { totalNet: true },
    }),
    // Inflow: staff loan repayments recognized only when payroll is actually paid.
    prisma.payslip.aggregate({
      where: { payrollRun: { status: 'PAID', paidAt: { gte: from, lte: to } } },
      _sum: { loanDeduction: true },
    }),
    refundsPaidOut({ gte: from, lte: to }),
  ])

  const salesInflow = salesCollections._sum.amount || 0
  const purchaseOutflow = supplierPayments._sum.amount || 0
  const salaryOutflow = salaryPayments._sum.totalNet || 0
  const loanInflow = loanCollections._sum.loanDeduction || 0

  const totalInflow = salesInflow + loanInflow
  const totalOutflow = purchaseOutflow + salaryOutflow + refundOutflow
  const netOperating = totalInflow - totalOutflow

  return {
    success: true,
    data: {
      period: { from: fromDate, to: toDate },
      operating: {
        inflow: {
          salesCollections: salesInflow,
          loanRepayments: loanInflow,
          total: totalInflow,
        },
        outflow: {
          purchases: purchaseOutflow,
          salaries: salaryOutflow,
          creditRefunds: refundOutflow,
          total: totalOutflow,
        },
        net: netOperating,
      },
      investing: { net: 0, note: 'Fixed asset purchases not tracked yet' },
      financing: { net: 0, note: 'Equity/loan transactions not tracked yet' },
      quality: {
        purchasePayments: {
          eventBasedAmount: purchaseOutflow,
          paymentRows: Number((supplierPayments as { _count?: { id?: number } })._count?.id || 0),
          note: 'Supplier payouts are sourced from PurchasePayment entries (event-based)',
        },
      },
      netCashFlow: netOperating,
    },
  }
}

export async function getExecutiveSummary(fromDate: string, toDate: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const range = parseDateRange(fromDate, toDate)
  if (!range) return { success: false, error: 'Invalid date range' }
  const { from, to } = range

  const periodDays = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1)
  const prevTo = new Date(from)
  prevTo.setDate(prevTo.getDate() - 1)
  prevTo.setHours(23, 59, 59, 999)
  const prevFrom = new Date(prevTo)
  prevFrom.setDate(prevFrom.getDate() - (periodDays - 1))
  prevFrom.setHours(0, 0, 0, 0)

  const [bsRes, currPLRes, prevPLRes, recAgingRes, payAgingRes, supplierOutflow, currOpex] = await Promise.all([
    getBalanceSheet(toDate),
    getProfitAndLoss(fromDate, toDate),
    getProfitAndLoss(prevFrom.toISOString().slice(0, 10), prevTo.toISOString().slice(0, 10)),
    getReceivablesAging(),
    getPayablesAging(),
    aggregatePurchasePayments({ paidAt: { gte: from, lte: to } }),
    prisma.payrollRun.aggregate({ where: { status: 'PAID', paidAt: { gte: from, lte: to } }, _sum: { totalNet: true } }),
  ])

  if (!bsRes.success || !currPLRes.success || !prevPLRes.success || !recAgingRes.success || !payAgingRes.success) {
    return { success: false, error: 'Unable to compute executive summary' }
  }

  if (!bsRes.data || !currPLRes.data || !prevPLRes.data || !recAgingRes.data || !payAgingRes.data) {
    return { success: false, error: 'Executive summary data is incomplete' }
  }

  const bsData = bsRes.data
  const currPLData = currPLRes.data
  const prevPLData = prevPLRes.data
  const recAgingData = recAgingRes.data
  const payAgingData = payAgingRes.data

  const currentPL = currPLData.current
  const previousPL = prevPLData.current
  const currentAssets = bsData.currentAssets?.total || 0
  const currentLiabilities = bsData.currentLiabilities?.total || 0
  const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : null

  const receivables = bsData.currentAssets?.accountsReceivable || 0
  const payables = bsData.currentLiabilities?.accountsPayable || 0
  const dailyRevenue = (currentPL.revenue?.netRevenue || 0) / periodDays
  const dailyPurchases = Math.max(1, (supplierOutflow._sum.amount || 0) / periodDays)
  const dso = dailyRevenue > 0 ? receivables / dailyRevenue : null
  const dpo = payables > 0 ? payables / dailyPurchases : null

  const dailyOperatingBurn = ((supplierOutflow._sum.amount || 0) + (currOpex._sum.totalNet || 0)) / periodDays
  const cashRunwayDays = dailyOperatingBurn > 0 ? (bsData.currentAssets?.cashAndBank || 0) / dailyOperatingBurn : null

  const netProfitDelta = (currentPL.netProfit || 0) - (previousPL.netProfit || 0)
  const netMarginDeltaPct = (currentPL.netMarginPct || 0) - (previousPL.netMarginPct || 0)
  const grossMarginDeltaPct = (currentPL.grossMarginPct || 0) - (previousPL.grossMarginPct || 0)

  const alerts = [
    recAgingData.risk?.over90SharePct > 35 ? 'High receivables concentration in 90+ bucket' : null,
    payAgingData.risk?.over90SharePct > 35 ? 'High payables concentration in 90+ bucket' : null,
    netMarginDeltaPct < -5 ? 'Net margin dropped more than 5 percentage points vs prior period' : null,
    currentRatio !== null && currentRatio < 1 ? 'Current ratio below 1.0 (working capital stress)' : null,
  ].filter(Boolean)

  return {
    success: true,
    data: {
      period: { from: fromDate, to: toDate, days: periodDays },
      liquidity: {
        currentAssets,
        currentLiabilities,
        currentRatio,
        cashAndBank: bsData.currentAssets?.cashAndBank || 0,
        cashRunwayDays,
      },
      cycle: {
        dso,
        dpo,
      },
      performance: {
        netProfit: currentPL.netProfit || 0,
        netProfitDelta,
        netMarginPct: currentPL.netMarginPct || 0,
        netMarginDeltaPct,
        grossMarginPct: currentPL.grossMarginPct || 0,
        grossMarginDeltaPct,
      },
      agingRisk: {
        receivables: recAgingData.risk,
        payables: payAgingData.risk,
      },
      alerts,
      benchmarkNote: 'Aligned with CRM executive-summary practices: liquidity, cycle metrics, margin variance, and aging concentration',
    },
  }
}

// ─── TRIAL BALANCE ────────────────────────────────────

export async function getTrialBalance(asOfDate: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const asOf = parseAsOfDate(asOfDate)
  if (!asOf) return { success: false, error: 'Invalid as-of date' }

  const [payments, receivables, inventory, poPayables, salesTotal, purchasesTotal,
    payrollTotal, employerTotal, gstOutput, gstInput, notes, staffLoans, salaryPaid, loanRecoveries, refundsOwed, refundsPaid] = await Promise.all([
    prisma.payment.aggregate({ where: { date: { lte: asOf }, invoice: { invoiceStatus: { not: 'CANCELLED' } } }, _sum: { amount: true } }),
    prisma.invoice.aggregate({ where: { invoiceStatus: 'ACTIVE', heldAt: null, date: { lte: asOf } }, _sum: { balanceDue: true } }),
    prisma.product.findMany({ select: { stock: true, costPrice: true } }),
    prisma.purchaseOrder.aggregate({ where: { date: { lte: asOf }, status: PAYABLE_PO }, _sum: { balanceDue: true } }),
    prisma.invoice.aggregate({ where: { date: { lte: asOf }, ...SOLD }, _sum: { subtotal: true, discount: true } }),
    prisma.purchaseOrder.aggregate({ where: { date: { lte: asOf }, status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] } }, _sum: { subtotal: true, discount: true } }),
    prisma.payrollRun.aggregate({ where: { status: { in: ['APPROVED', 'PAID'] } }, _sum: { totalGross: true } }),
    prisma.payrollRun.aggregate({ where: { status: { in: ['APPROVED', 'PAID'] } }, _sum: { employerContributions: true } }),
    prisma.invoice.aggregate({ where: { date: { lte: asOf }, ...SOLD }, _sum: { gst: true } }),
    prisma.vendorBill.aggregate({ where: { billDate: { lte: asOf }, ...ITC_BILLS }, _sum: { gst: true } }),
    creditNoteShares({ lte: asOf }),
    prisma.staffLoan.aggregate({ where: { status: 'Active' }, _sum: { remainingAmount: true } }),
    prisma.payrollRun.aggregate({ where: { status: 'PAID', paidAt: { lte: asOf } }, _sum: { totalNet: true } }),
    prisma.payslip.aggregate({ where: { payrollRun: { status: 'PAID', paidAt: { lte: asOf } } }, _sum: { loanDeduction: true } }),
    refundsOwedToCustomers(asOf),
    refundsPaidOut({ lte: asOf }),
  ])

  const supplierPayout = (await aggregatePurchasePayments({ paidAt: { lte: asOf } }))._sum.amount || 0
  const salaryPaidOut = salaryPaid._sum.totalNet || 0
  const loanInflow = loanRecoveries._sum.loanDeduction || 0
  // Credit notes are not cash; they reduce receivables (or are owed back, below).
  const cashAndBank = (payments._sum.amount || 0) + loanInflow - supplierPayout - salaryPaidOut - refundsPaid
  const receivablesVal = receivables._sum.balanceDue || 0
  const inventoryVal = inventory.reduce((s, p) => s + p.stock * (p.costPrice || 0), 0)
  const gstITC = gstInput._sum.gst || 0
  const staffLoanAsset = staffLoans._sum.remainingAmount || 0

  const netSalesRevenue = (salesTotal._sum.subtotal || 0) - (salesTotal._sum.discount || 0) - notes.goods
  const purchasesEx = (purchasesTotal._sum.subtotal || 0) - (purchasesTotal._sum.discount || 0)
  const salaryEx = payrollTotal._sum.totalGross || 0
  const employerEx = employerTotal._sum.employerContributions || 0

  const netGST = Math.max(0, (gstOutput._sum.gst || 0) - notes.gst - gstITC)
  const payables = poPayables._sum.balanceDue || 0

  const lines = [
    { code: '1002', name: 'Cash & Bank', type: 'ASSET', debit: cashAndBank, credit: 0 },
    { code: '1100', name: 'Accounts Receivable', type: 'ASSET', debit: receivablesVal, credit: 0 },
    { code: '1200', name: 'Closing Stock / Inventory', type: 'ASSET', debit: inventoryVal, credit: 0 },
    { code: '1300', name: 'GST Input Credit (ITC)', type: 'ASSET', debit: gstITC, credit: 0 },
    { code: '1400', name: 'Staff Loans Outstanding', type: 'ASSET', debit: staffLoanAsset, credit: 0 },
    { code: '2001', name: 'Accounts Payable', type: 'LIABILITY', debit: 0, credit: payables },
    { code: '2100', name: 'Net GST Payable', type: 'LIABILITY', debit: 0, credit: netGST },
    { code: '2500', name: 'Refunds Owed to Customers', type: 'LIABILITY', debit: 0, credit: refundsOwed },
    { code: '4001', name: 'Sales Revenue', type: 'INCOME', debit: 0, credit: netSalesRevenue },
    { code: '5020', name: 'Purchases (COGS)', type: 'EXPENSE', debit: purchasesEx, credit: 0 },
    { code: '5100', name: 'Salary Expense', type: 'EXPENSE', debit: salaryEx, credit: 0 },
    { code: '5110', name: 'Employer PF/ESI', type: 'EXPENSE', debit: employerEx, credit: 0 },
  ]

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0)
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0)

  // Balancing figure goes to Equity (Retained Earnings)
  const equityBalance = totalDebit - totalCredit
  if (equityBalance !== 0) {
    lines.push({
      code: '3100', name: "Retained Earnings / Equity",
      type: 'EQUITY',
      debit: equityBalance < 0 ? Math.abs(equityBalance) : 0,
      credit: equityBalance > 0 ? equityBalance : 0,
    })
  }

  const finalDebit = lines.reduce((s, l) => s + l.debit, 0)
  const finalCredit = lines.reduce((s, l) => s + l.credit, 0)

  return {
    success: true,
    data: { asOfDate, lines, totalDebit: finalDebit, totalCredit: finalCredit },
  }
}

// ─── RECEIVABLES AGING ────────────────────────────────

export async function getReceivablesAging() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const outstanding = await prisma.invoice.findMany({
    where: { invoiceStatus: 'ACTIVE', heldAt: null, balanceDue: { gt: 0 } },
    include: { contact: { select: { name: true, phone: true } } },
    orderBy: { date: 'asc' },
  })

  const buckets = { current: [] as typeof outstanding, days30: [], days60: [], days90: [], over90: [] } as Record<string, typeof outstanding>
  const labels: Record<string, string> = { current: '0-30 days', days30: '31-60 days', days60: '61-90 days', days90: '91-180 days', over90: '180+ days' }

  let weightedDays = 0
  let over90Amount = 0
  for (const inv of outstanding) {
    const dueRef = inv.dueDate || inv.date
    const ageDays = Math.max(0, Math.floor((today.getTime() - new Date(dueRef).getTime()) / (1000 * 60 * 60 * 24)))
    weightedDays += ageDays * inv.balanceDue
    if (ageDays <= 30) buckets.current.push(inv)
    else if (ageDays <= 60) buckets.days30.push(inv)
    else if (ageDays <= 90) buckets.days60.push(inv)
    else if (ageDays <= 180) {
      buckets.days90.push(inv)
      over90Amount += inv.balanceDue
    }
    else buckets.over90.push(inv)
    if (ageDays > 180) over90Amount += inv.balanceDue
  }

  const summary = Object.entries(buckets).map(([key, items]) => ({
    bucket: key,
    label: labels[key],
    count: items.length,
    amount: items.reduce((s, i) => s + i.balanceDue, 0),
    invoices: items.map(i => ({
      displayId: i.displayId, date: i.date, customer: i.contact.name,
      phone: i.contact.phone, total: i.total, balanceDue: i.balanceDue,
        ageDays: Math.max(0, Math.floor((today.getTime() - new Date(i.dueDate || i.date).getTime()) / (1000 * 60 * 60 * 24))),
        dueDate: i.dueDate,
    })),
  }))

  const totalOutstanding = outstanding.reduce((s, i) => s + i.balanceDue, 0)
  const risk = calcAgingRisk(totalOutstanding, over90Amount, outstanding, weightedDays)
  return { success: true, data: { summary, totalOutstanding, totalCount: outstanding.length, risk } }
}

// ─── PAYABLES AGING ──────────────────────────────────

export async function getPayablesAging() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const outstanding = await prisma.purchaseOrder.findMany({
    where: { balanceDue: { gt: 0 }, status: { notIn: ['CANCELLED', 'DRAFT'] } },
    include: { supplier: { select: { name: true, phone: true, paymentTerms: true } } },
    orderBy: { date: 'asc' },
  })

  const buckets = { current: [] as typeof outstanding, days30: [], days60: [], days90: [], over90: [] } as Record<string, typeof outstanding>
  const labels: Record<string, string> = { current: '0-30 days', days30: '31-60 days', days60: '61-90 days', days90: '91-180 days', over90: '180+ days' }

  let weightedDays = 0
  let over90Amount = 0
  for (const po of outstanding) {
    const baseDate = po.expectedDate || po.date
    const dueDate = new Date(baseDate)
    if (!po.expectedDate) dueDate.setDate(dueDate.getDate() + (po.supplier.paymentTerms || 30))
    const ageDays = Math.max(0, Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)))
    weightedDays += ageDays * po.balanceDue
    if (ageDays <= 30) buckets.current.push(po)
    else if (ageDays <= 60) buckets.days30.push(po)
    else if (ageDays <= 90) buckets.days60.push(po)
    else if (ageDays <= 180) {
      buckets.days90.push(po)
      over90Amount += po.balanceDue
    }
    else buckets.over90.push(po)
    if (ageDays > 180) over90Amount += po.balanceDue
  }

  const summary = Object.entries(buckets).map(([key, items]) => ({
    bucket: key,
    label: labels[key],
    count: items.length,
    amount: items.reduce((s, p) => s + p.balanceDue, 0),
    pos: items.map(p => ({
      displayId: p.displayId, date: p.date, supplier: p.supplier.name,
      total: p.total, balanceDue: p.balanceDue,
        ageDays: (() => {
          const baseDate = p.expectedDate || p.date
          const dueDate = new Date(baseDate)
          if (!p.expectedDate) dueDate.setDate(dueDate.getDate() + (p.supplier.paymentTerms || 30))
          return Math.max(0, Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)))
        })(),
      paymentTerms: p.supplier.paymentTerms,
        expectedDate: p.expectedDate,
    })),
  }))

  const totalOutstanding = outstanding.reduce((s, p) => s + p.balanceDue, 0)
  const risk = calcAgingRisk(totalOutstanding, over90Amount, outstanding, weightedDays)
  return { success: true, data: { summary, totalOutstanding, totalCount: outstanding.length, risk } }
}

// ─── JOURNAL ENTRIES ─────────────────────────────────

export async function getJournalEntries(fromDate?: string, toDate?: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const where: Record<string, unknown> = {}
  if (fromDate && toDate) {
    const range = parseDateRange(fromDate, toDate)
    if (!range) return { success: false, error: 'Invalid date range' }
    where.date = { gte: range.from, lte: range.to }
  }

  const entries = await prisma.journalEntry.findMany({
    where,
    orderBy: { date: 'desc' },
    take: 200,
    include: {
      lines: {
        include: { account: { select: { code: true, name: true } } },
        orderBy: { debit: 'desc' },
      },
    },
  })
  return { success: true, data: entries }
}

export async function createManualJournal(data: unknown) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const parsed = createJournalSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { date, narration, lines } = parsed.data
  const journalDate = new Date(date)
  if (Number.isNaN(journalDate.getTime())) return { success: false, error: 'Invalid journal date' }

  const hasBothSidesInSingleLine = lines.some(l => l.debit > 0 && l.credit > 0)
  if (hasBothSidesInSingleLine) {
    return { success: false, error: 'A journal line cannot have both debit and credit values' }
  }

  const debitLines = lines.filter(l => l.debit > 0).length
  const creditLines = lines.filter(l => l.credit > 0).length
  if (debitLines === 0 || creditLines === 0) {
    return { success: false, error: 'Journal must include at least one debit line and one credit line' }
  }

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0)
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0)
  if (Math.abs(totalDebit - totalCredit) > 1) {
    return { success: false, error: `Debit (${totalDebit}) ≠ Credit (${totalCredit}). Journal must balance.` }
  }

  const count = await prisma.journalEntry.count()
  const displayId = `JV-${String(count + 1).padStart(4, '0')}`

  const entry = await prisma.journalEntry.create({
    data: {
      displayId, date: journalDate, narration,
      referenceType: 'MANUAL', totalDebit, totalCredit,
      lines: {
        create: lines.map(l => ({
          accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description,
        })),
      },
    },
  })

  revalidatePath('/financials')
  return { success: true, data: entry }
}

export async function voidJournalEntry(id: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const entry = await prisma.journalEntry.findUnique({ where: { id }, select: { status: true, isAuto: true, referenceType: true } })
  if (!entry) return { success: false, error: 'Journal entry not found' }
  if (entry.status === 'VOIDED') return { success: false, error: 'Already voided' }
  // Auto entries follow their document; voiding one would silently drop it from the books.
  if (entry.isAuto) return { success: false, error: `This entry was posted automatically from a ${entry.referenceType || 'document'}. Edit, cancel or delete that document instead and the books follow.` }

  await prisma.journalEntry.update({ where: { id }, data: { status: 'VOIDED' } })
  revalidatePath('/financials')
  return { success: true }
}
