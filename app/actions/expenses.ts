'use server'

import { guarded } from '@/lib/action-guard'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { requireAuth, requireRole } from '@/lib/auth-helpers'

// Cash expenses move the day's cash register only while they are approved.
async function moveCashRegister(expense: { date: Date; amount: number; paymentMode: string | null }, direction: 1 | -1) {
  if (expense.paymentMode !== 'Cash') return
  const dateOnly = new Date(expense.date.toISOString().split('T')[0] + 'T00:00:00')
  if (direction === 1) {
    await prisma.dailyCashRegister.upsert({ where: { date: dateOnly }, create: { date: dateOnly, cashOut: expense.amount }, update: { cashOut: { increment: expense.amount } } })
  } else {
    await prisma.dailyCashRegister.updateMany({ where: { date: dateOnly }, data: { cashOut: { decrement: expense.amount } } })
  }
}
import {
  createExpenseSchema,
  createCategorySchema,
  createRecurringSchema,
  cashRegisterSchema,
} from '@/lib/validations/expenses'
import { moveExpenseToDraft } from './drafts'
import { getActiveVertical } from '@/lib/brand'

const IS_TGM = getActiveVertical() === 'tiles'

const FURNITURE_DEFAULT_CATEGORIES = [
  { name: 'Raw Materials', icon: 'TreePine', color: '#8B4513', sortOrder: 1 },
  { name: 'Labour & Wages', icon: 'HardHat', color: '#F59E0B', sortOrder: 2 },
  { name: 'Transport & Freight', icon: 'Truck', color: '#6366F1', sortOrder: 3 },
  { name: 'Showroom Expenses', icon: 'Store', color: '#EC4899', sortOrder: 4 },
  { name: 'Workshop & Factory', icon: 'Factory', color: '#78716C', sortOrder: 5 },
  { name: 'Packaging', icon: 'Package', color: '#14B8A6', sortOrder: 6 },
  { name: 'Marketing & Ads', icon: 'Megaphone', color: '#F97316', sortOrder: 7 },
  { name: 'Office & Admin', icon: 'FileText', color: '#64748B', sortOrder: 8 },
  { name: 'Fuel & Vehicle', icon: 'Fuel', color: '#EF4444', sortOrder: 9 },
  { name: 'Food & Refreshments', icon: 'Coffee', color: '#A855F7', sortOrder: 10 },
  { name: 'Loan EMI & Interest', icon: 'Landmark', color: '#0EA5E9', sortOrder: 11 },
  { name: 'Rent', icon: 'Home', color: '#10B981', sortOrder: 12 },
  { name: 'Electricity & Utilities', icon: 'Zap', color: '#FBBF24', sortOrder: 13 },
  { name: 'Tools & Equipment', icon: 'Wrench', color: '#6B7280', sortOrder: 14 },
  { name: 'Miscellaneous', icon: 'MoreHorizontal', color: '#94A3B8', sortOrder: 15 },
]

const TGM_DEFAULT_CATEGORIES = [
  { name: 'Slab & Tile Purchases', icon: 'Layers', color: '#2563EB', sortOrder: 1 },
  { name: 'Fabrication & Processing', icon: 'HardHat', color: '#F59E0B', sortOrder: 2 },
  { name: 'Transport / Loading / Unloading', icon: 'Truck', color: '#6366F1', sortOrder: 3 },
  { name: 'Showroom & Display', icon: 'Store', color: '#EC4899', sortOrder: 4 },
  { name: 'Godown & Handling', icon: 'Warehouse', color: '#78716C', sortOrder: 5 },
  { name: 'Packaging & Crating', icon: 'Package', color: '#14B8A6', sortOrder: 6 },
  { name: 'Marketing & Samples', icon: 'Megaphone', color: '#F97316', sortOrder: 7 },
  { name: 'Office & Admin', icon: 'FileText', color: '#64748B', sortOrder: 8 },
  { name: 'Fuel & Vehicle', icon: 'Fuel', color: '#EF4444', sortOrder: 9 },
  { name: 'Staff Meals / Refreshments', icon: 'Coffee', color: '#A855F7', sortOrder: 10 },
  { name: 'Finance / Bank Charges', icon: 'Landmark', color: '#0EA5E9', sortOrder: 11 },
  { name: 'Rent', icon: 'Home', color: '#10B981', sortOrder: 12 },
  { name: 'Electricity & Utilities', icon: 'Zap', color: '#FBBF24', sortOrder: 13 },
  { name: 'Tools & Equipment', icon: 'Wrench', color: '#6B7280', sortOrder: 14 },
  { name: 'Miscellaneous', icon: 'MoreHorizontal', color: '#94A3B8', sortOrder: 15 },
]

const DEFAULT_CATEGORIES = IS_TGM ? TGM_DEFAULT_CATEGORIES : FURNITURE_DEFAULT_CATEGORIES

// ─── ENSURE DEFAULT CATEGORIES ───────────────────────

async function ensureDefaultExpenseCategories() {
  let created = 0
  let updated = 0
  for (const cat of DEFAULT_CATEGORIES) {
    // Reuse existing default rows in a migrated TGM database so historical
    // expenses remain linked while their visible labels become TGM-specific.
    let exists = IS_TGM
      ? await prisma.expenseCategory.findFirst({ where: { isDefault: true, sortOrder: cat.sortOrder } })
      : await prisma.expenseCategory.findFirst({ where: { name: cat.name } })
    if (!exists) exists = await prisma.expenseCategory.findFirst({ where: { name: cat.name } })

    if (exists) {
      if (IS_TGM && (exists.name !== cat.name || exists.icon !== cat.icon || exists.color !== cat.color || !exists.isActive)) {
        await prisma.expenseCategory.update({
          where: { id: exists.id },
          data: { name: cat.name, icon: cat.icon, color: cat.color, isDefault: true, isActive: true, sortOrder: cat.sortOrder },
        })
        updated++
      }
      continue
    }

    await prisma.expenseCategory.create({ data: { ...cat, isDefault: true } })
    created++
  }
  return { created, updated }
}

export async function seedExpenseCategories(...args: Parameters<typeof _seedExpenseCategories>): Promise<Awaited<ReturnType<typeof _seedExpenseCategories>>> {
  return guarded('seedExpenseCategories', () => _seedExpenseCategories(...args))
}

async function _seedExpenseCategories() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const result = await ensureDefaultExpenseCategories()
  revalidatePath('/expenses')
  return { success: true, data: result }
}

// ─── CATEGORIES ───────────────────────────────────────

export async function getExpenseCategories(...args: Parameters<typeof _getExpenseCategories>): Promise<Awaited<ReturnType<typeof _getExpenseCategories>>> {
  return guarded('getExpenseCategories', () => _getExpenseCategories(...args))
}

async function _getExpenseCategories() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again', data: [] } }
  await ensureDefaultExpenseCategories()
  const categories = await prisma.expenseCategory.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    include: {
      _count: { select: { expenses: true } },
    },
  })
  return { success: true, data: categories }
}

export async function createExpenseCategory(...args: Parameters<typeof _createExpenseCategory>): Promise<Awaited<ReturnType<typeof _createExpenseCategory>>> {
  return guarded('createExpenseCategory', () => _createExpenseCategory(...args))
}

async function _createExpenseCategory(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const parsed = createCategorySchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { name, icon, color, budget } = parsed.data
  const existing = await prisma.expenseCategory.findFirst({ where: { name } })
  if (existing) return { success: false, error: 'Category already exists' }

  const maxSort = await prisma.expenseCategory.aggregate({ _max: { sortOrder: true } })
  const category = await prisma.expenseCategory.create({
    data: { name, icon, color, budget, sortOrder: (maxSort._max.sortOrder || 0) + 1 },
  })
  revalidatePath('/expenses')
  return { success: true, data: category }
}

export async function updateCategoryBudget(...args: Parameters<typeof _updateCategoryBudget>): Promise<Awaited<ReturnType<typeof _updateCategoryBudget>>> {
  return guarded('updateCategoryBudget', () => _updateCategoryBudget(...args))
}

async function _updateCategoryBudget(id: number, budget: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  if (!Number.isFinite(budget) || budget < 0) return { success: false, error: 'Budget must be zero or more' }
  await prisma.expenseCategory.update({ where: { id }, data: { budget } })
  revalidatePath('/expenses')
  return { success: true }
}

export async function deleteExpenseCategory(...args: Parameters<typeof _deleteExpenseCategory>): Promise<Awaited<ReturnType<typeof _deleteExpenseCategory>>> {
  return guarded('deleteExpenseCategory', () => _deleteExpenseCategory(...args))
}

async function _deleteExpenseCategory(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const cat = await prisma.expenseCategory.findUnique({ where: { id }, include: { _count: { select: { expenses: true } } } })
  if (!cat) return { success: false, error: 'Category not found' }
  if (cat._count.expenses > 0) {
    // Soft-deactivate if has expenses
    await prisma.expenseCategory.update({ where: { id }, data: { isActive: false } })
  } else {
    await prisma.expenseCategory.delete({ where: { id } })
  }
  revalidatePath('/expenses')
  return { success: true }
}

// ─── EXPENSES ─────────────────────────────────────────

export async function getExpenses(...args: Parameters<typeof _getExpenses>): Promise<Awaited<ReturnType<typeof _getExpenses>>> {
  return guarded('getExpenses', () => _getExpenses(...args))
}

async function _getExpenses(fromDate?: string, toDate?: string) {
  let session
  try { session = await requireAuth() } catch { return { success: false, error: 'Please sign in again', data: [] } }
  const where: Record<string, unknown> = {}
  // Staff see only expenses they submitted.
  if (session.user.role === 'STAFF') where.staffId = session.user.staffId ? Number(session.user.staffId) : -1
  if (fromDate && toDate) {
    where.date = {
      gte: new Date(fromDate + 'T00:00:00'),
      lte: new Date(toDate + 'T23:59:59'),
    }
  }

  const expenses = await prisma.expense.findMany({
    where,
    include: {
      category: true,
      staff: { select: { id: true, name: true } },
    },
    orderBy: { date: 'desc' },
  })

  return {
    success: true,
    data: expenses.map(e => ({
      id: e.id,
      date: e.date.toISOString().split('T')[0],
      categoryId: e.categoryId,
      categoryName: e.category.name,
      categoryColor: e.category.color,
      categoryIcon: e.category.icon,
      amount: e.amount,
      description: e.description,
      paymentMode: e.paymentMode,
      reference: e.reference,
      receipt: e.receipt,
      vendor: e.vendor,
      staffId: e.staffId,
      staffName: e.staff?.name || null,
      status: e.status,
      approvedBy: e.approvedBy,
      isRecurring: e.isRecurring,
      notes: e.notes,
      createdAt: e.createdAt.toISOString(),
    })),
  }
}

export async function createExpense(...args: Parameters<typeof _createExpense>): Promise<Awaited<ReturnType<typeof _createExpense>>> {
  return guarded('createExpense', () => _createExpense(...args))
}

async function _createExpense(data: unknown) {
  let session
  try { session = await requireAuth() } catch { return { success: false, error: 'Please sign in again' } }
  const parsed = createExpenseSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { date, categoryId, amount, description, paymentMode, reference, receipt, vendor, notes } = parsed.data
  // Staff submit expenses for approval, as themselves; managers' are approved at once.
  const isStaff = session.user.role === 'STAFF'
  const staffId = isStaff ? (session.user.staffId ? Number(session.user.staffId) : undefined) : parsed.data.staffId

  const expense = await prisma.expense.create({
    data: {
      date: new Date(date),
      categoryId,
      amount,
      description,
      paymentMode,
      reference,
      receipt,
      vendor,
      staffId,
      notes,
      status: isStaff ? 'Pending' : 'Approved',
      approvedBy: isStaff ? null : session.user.name,
    },
  })

  if (expense.status === 'Approved') await moveCashRegister(expense, 1)

  revalidatePath('/expenses')
  return { success: true, data: expense }
}

export async function updateExpense(...args: Parameters<typeof _updateExpense>): Promise<Awaited<ReturnType<typeof _updateExpense>>> {
  return guarded('updateExpense', () => _updateExpense(...args))
}

async function _updateExpense(id: number, data: unknown) {
  try {
    await requireRole('ADMIN')
  } catch {
    return { success: false, error: 'Admin access required to edit expenses' }
  }

  const parsed = createExpenseSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { date, categoryId, amount, description, paymentMode, reference, receipt, vendor, staffId, notes } = parsed.data

  const existing = await prisma.expense.findUnique({ where: { id } })
  if (!existing) return { success: false, error: 'Expense not found' }

  // Only approved expenses are in the cash register (approveExpense adds them).
  if (existing.status === 'Approved') await moveCashRegister(existing, -1)

  const expense = await prisma.expense.update({
    where: { id },
    data: {
      date: new Date(date),
      categoryId,
      amount,
      description,
      paymentMode,
      reference,
      receipt,
      vendor,
      staffId,
      notes,
    },
  })

  if (expense.status === 'Approved') await moveCashRegister(expense, 1)

  revalidatePath('/expenses')
  return { success: true, data: expense }
}

export async function deleteExpense(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  return moveExpenseToDraft(id)
}

// The approver is whoever is signed in (the old `approvedBy` argument is ignored).
export async function approveExpense(...args: Parameters<typeof _approveExpense>): Promise<Awaited<ReturnType<typeof _approveExpense>>> {
  return guarded('approveExpense', () => _approveExpense(...args))
}

async function _approveExpense(id: number, _approvedBy?: string) {
  let session
  try { session = await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  void _approvedBy
  const claimed = await prisma.expense.updateMany({ where: { id, status: { not: 'Approved' } }, data: { status: 'Approved', approvedBy: session.user.name } })
  if (claimed.count !== 1) return { success: false, error: 'This expense is already approved' }
  const expense = await prisma.expense.findUnique({ where: { id } })
  if (expense) await moveCashRegister(expense, 1)
  revalidatePath('/expenses')
  return { success: true }
}

export async function rejectExpense(...args: Parameters<typeof _rejectExpense>): Promise<Awaited<ReturnType<typeof _rejectExpense>>> {
  return guarded('rejectExpense', () => _rejectExpense(...args))
}

async function _rejectExpense(id: number) {
  let session
  try { session = await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const before = await prisma.expense.findUnique({ where: { id } })
  if (!before) return { success: false, error: 'Expense not found' }
  const claimed = await prisma.expense.updateMany({ where: { id, status: { not: 'Rejected' } }, data: { status: 'Rejected', approvedBy: session.user.name } })
  if (claimed.count !== 1) return { success: false, error: 'This expense is already rejected' }
  if (before.status === 'Approved') await moveCashRegister(before, -1)
  revalidatePath('/expenses')
  return { success: true }
}

// ─── RECURRING EXPENSES ───────────────────────────────

export async function getRecurringExpenses(...args: Parameters<typeof _getRecurringExpenses>): Promise<Awaited<ReturnType<typeof _getRecurringExpenses>>> {
  return guarded('getRecurringExpenses', () => _getRecurringExpenses(...args))
}

async function _getRecurringExpenses() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again', data: [] } }
  const recurring = await prisma.recurringExpense.findMany({
    include: { category: true },
    orderBy: { createdAt: 'desc' },
  })
  return {
    success: true,
    data: recurring.map(r => ({
      id: r.id,
      categoryId: r.categoryId,
      categoryName: r.category.name,
      categoryColor: r.category.color,
      description: r.description,
      amount: r.amount,
      paymentMode: r.paymentMode,
      vendor: r.vendor,
      frequency: r.frequency,
      dayOfMonth: r.dayOfMonth,
      isActive: r.isActive,
      lastRun: r.lastRun?.toISOString().split('T')[0] || null,
      notes: r.notes,
    })),
  }
}

export async function createRecurringExpense(...args: Parameters<typeof _createRecurringExpense>): Promise<Awaited<ReturnType<typeof _createRecurringExpense>>> {
  return guarded('createRecurringExpense', () => _createRecurringExpense(...args))
}

async function _createRecurringExpense(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const parsed = createRecurringSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const rec = await prisma.recurringExpense.create({
    data: {
      ...parsed.data,
      startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : new Date(),
      endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : null,
    },
  })
  revalidatePath('/expenses')
  return { success: true, data: rec }
}

export async function toggleRecurringExpense(...args: Parameters<typeof _toggleRecurringExpense>): Promise<Awaited<ReturnType<typeof _toggleRecurringExpense>>> {
  return guarded('toggleRecurringExpense', () => _toggleRecurringExpense(...args))
}

async function _toggleRecurringExpense(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const rec = await prisma.recurringExpense.findUnique({ where: { id } })
  if (!rec) return { success: false, error: 'Not found' }
  await prisma.recurringExpense.update({ where: { id }, data: { isActive: !rec.isActive } })
  revalidatePath('/expenses')
  return { success: true }
}

export async function deleteRecurringExpense(...args: Parameters<typeof _deleteRecurringExpense>): Promise<Awaited<ReturnType<typeof _deleteRecurringExpense>>> {
  return guarded('deleteRecurringExpense', () => _deleteRecurringExpense(...args))
}

async function _deleteRecurringExpense(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  await prisma.recurringExpense.delete({ where: { id } })
  revalidatePath('/expenses')
  return { success: true }
}

// ─── DAILY CASH REGISTER ──────────────────────────────

export async function getCashRegister(...args: Parameters<typeof _getCashRegister>): Promise<Awaited<ReturnType<typeof _getCashRegister>>> {
  return guarded('getCashRegister', () => _getCashRegister(...args))
}

async function _getCashRegister(date: string) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } }
  const dateOnly = new Date(date + 'T00:00:00')
  let register = await prisma.dailyCashRegister.findUnique({ where: { date: dateOnly } })
  if (!register) {
    // Carry forward closing from previous day
    const prev = await prisma.dailyCashRegister.findFirst({
      where: { date: { lt: dateOnly } },
      orderBy: { date: 'desc' },
    })
    register = await prisma.dailyCashRegister.create({
      data: {
        date: dateOnly,
        openingCash: prev?.closingCash ?? 0,
      },
    })
  }
  return {
    success: true,
    data: {
      id: register.id,
      date: register.date.toISOString().split('T')[0],
      openingCash: register.openingCash,
      closingCash: register.closingCash,
      cashIn: register.cashIn,
      cashOut: register.cashOut,
      notes: register.notes,
    },
  }
}

export async function updateCashRegister(...args: Parameters<typeof _updateCashRegister>): Promise<Awaited<ReturnType<typeof _updateCashRegister>>> {
  return guarded('updateCashRegister', () => _updateCashRegister(...args))
}

async function _updateCashRegister(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const parsed = cashRegisterSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const dateOnly = new Date(parsed.data.date + 'T00:00:00')
  const register = await prisma.dailyCashRegister.upsert({
    where: { date: dateOnly },
    create: {
      date: dateOnly,
      openingCash: parsed.data.openingCash,
      closingCash: parsed.data.closingCash ?? null,
      cashIn: parsed.data.cashIn,
      notes: parsed.data.notes,
    },
    update: {
      openingCash: parsed.data.openingCash,
      closingCash: parsed.data.closingCash ?? null,
      cashIn: parsed.data.cashIn,
      notes: parsed.data.notes,
    },
  })
  revalidatePath('/expenses')
  return { success: true, data: register }
}

// ─── ANALYTICS & REPORTS ──────────────────────────────

export async function getExpenseSummary(...args: Parameters<typeof _getExpenseSummary>): Promise<Awaited<ReturnType<typeof _getExpenseSummary>>> {
  return guarded('getExpenseSummary', () => _getExpenseSummary(...args))
}

async function _getExpenseSummary(fromDate: string, toDate: string) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } }
  const from = new Date(fromDate + 'T00:00:00')
  const to = new Date(toDate + 'T23:59:59')

  // Category-wise breakdown
  const byCategory = await prisma.expense.groupBy({
    by: ['categoryId'],
    where: { date: { gte: from, lte: to }, status: 'Approved' },
    _sum: { amount: true },
    _count: true,
  })

  const categories = await prisma.expenseCategory.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  })

  const catMap = Object.fromEntries(categories.map(c => [c.id, c]))

  const categoryBreakdown = byCategory.map(b => ({
    categoryId: b.categoryId,
    categoryName: catMap[b.categoryId]?.name || 'Unknown',
    categoryColor: catMap[b.categoryId]?.color || '#94A3B8',
    categoryIcon: catMap[b.categoryId]?.icon || 'MoreHorizontal',
    total: b._sum.amount || 0,
    count: b._count,
    budget: catMap[b.categoryId]?.budget || 0,
  })).sort((a, b) => b.total - a.total)

  // Payment mode breakdown
  const byPaymentMode = await prisma.expense.groupBy({
    by: ['paymentMode'],
    where: { date: { gte: from, lte: to }, status: 'Approved' },
    _sum: { amount: true },
    _count: true,
  })

  // Daily totals
  const allExpenses = await prisma.expense.findMany({
    where: { date: { gte: from, lte: to }, status: 'Approved' },
    select: { date: true, amount: true },
    orderBy: { date: 'asc' },
  })

  const dailyMap: Record<string, number> = {}
  allExpenses.forEach(e => {
    const d = e.date.toISOString().split('T')[0]
    dailyMap[d] = (dailyMap[d] || 0) + e.amount
  })

  const dailyTotals = Object.entries(dailyMap)
    .map(([date, total]) => ({ date, total }))
    .sort((a, b) => a.date.localeCompare(b.date))

  // Grand total
  const grandTotal = categoryBreakdown.reduce((s, c) => s + c.total, 0)
  const totalBudget = categories.reduce((s, c) => s + (c.budget || 0), 0)
  const dayCount = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)))
  const dailyAverage = Math.round(grandTotal / dayCount)

  // Top vendor
  const byVendor = await prisma.expense.groupBy({
    by: ['vendor'],
    where: { date: { gte: from, lte: to }, status: 'Approved', vendor: { not: null } },
    _sum: { amount: true },
    _count: true,
    orderBy: { _sum: { amount: 'desc' } },
    take: 10,
  })

  return {
    success: true,
    data: {
      grandTotal,
      totalBudget,
      dailyAverage,
      dayCount,
      categoryBreakdown,
      paymentModeBreakdown: byPaymentMode.map(b => ({
        mode: b.paymentMode,
        total: b._sum.amount || 0,
        count: b._count,
      })),
      dailyTotals,
      topVendors: byVendor.map(v => ({
        vendor: v.vendor || 'Unknown',
        total: v._sum.amount || 0,
        count: v._count,
      })),
    },
  }
}

// ─── BUDGET VS ACTUAL ─────────────────────────────────

export async function getBudgetVsActual(...args: Parameters<typeof _getBudgetVsActual>): Promise<Awaited<ReturnType<typeof _getBudgetVsActual>>> {
  return guarded('getBudgetVsActual', () => _getBudgetVsActual(...args))
}

async function _getBudgetVsActual(month: string) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } }
  // month = "YYYY-MM"
  const from = new Date(month + '-01T00:00:00')
  const to = new Date(from)
  to.setMonth(to.getMonth() + 1)
  to.setDate(0) // last day of month
  to.setHours(23, 59, 59)

  const categories = await prisma.expenseCategory.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  })

  const byCategory = await prisma.expense.groupBy({
    by: ['categoryId'],
    where: { date: { gte: from, lte: to }, status: 'Approved' },
    _sum: { amount: true },
  })

  const spentMap = Object.fromEntries(byCategory.map(b => [b.categoryId, b._sum.amount || 0]))

  return {
    success: true,
    data: categories.map(c => ({
      categoryId: c.id,
      categoryName: c.name,
      categoryColor: c.color,
      categoryIcon: c.icon,
      budget: c.budget || 0,
      actual: spentMap[c.id] || 0,
      variance: (c.budget || 0) - (spentMap[c.id] || 0),
      percent: c.budget > 0 ? Math.round(((spentMap[c.id] || 0) / c.budget) * 100) : 0,
    })),
  }
}
