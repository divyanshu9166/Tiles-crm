'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { requireRole, requireAuth } from '@/lib/auth-helpers'
import { createBranchSchema, createGodownSchema, createTransferSchema } from '@/lib/validations/godown'

import { adjustStock, syncStock, resolveStockGodown, lockInventoryProducts, inventoryError } from '@/lib/inventory-stock'

// ─── CORE SYNC ENGINE ────────────────────────────────────
// All stock changes MUST go through adjustGodownStock → syncProductStockFromGodowns
// This ensures Product.stock always equals SUM(GodownStock.quantity)

/**
 * Recalculates Product.stock as SUM(GodownStock.quantity) for a given product.
 * Called after every godown stock change to keep the single source of truth.
 */
export async function syncProductStockFromGodowns(productId: number, tx?: any) {
  await requireRole('ADMIN', 'MANAGER')
  if (tx) { await lockInventoryProducts(tx, [productId]); return syncStock(tx, productId) }
  return prisma.$transaction(async transaction => {
    await lockInventoryProducts(transaction, [productId])
    return syncStock(transaction, productId)
  })
}

type StockAdjustmentOptions = { referenceType?: string; referenceId?: number; notes?: string; createdBy?: string }
const adjustGodownStockWithTx = adjustStock

export async function adjustGodownStock(productId: number, godownId: number, quantity: number, entryType: string, options?: StockAdjustmentOptions) {
  await requireRole('ADMIN', 'MANAGER')
  return prisma.$transaction(tx => adjustStock(tx, productId, godownId, quantity, entryType, options))
}

export async function getOrCreateDefaultGodown() {
  await requireRole('ADMIN', 'MANAGER', 'STAFF')
  return prisma.$transaction(tx => resolveStockGodown(tx))
}

// ─── STOCK LEDGER ────────────────────────────────────────

export async function getStockLedger(filters?: { productId?: number; godownId?: number; limit?: number }) {
  await requireAuth()
  const entries = await prisma.stockLedger.findMany({
    where: {
      ...(filters?.productId ? { productId: filters.productId } : {}),
      ...(filters?.godownId ? { godownId: filters.godownId } : {}),
    },
    include: {
      product: { select: { name: true, sku: true } },
      godown: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: filters?.limit || 100,
  })
  return { success: true, data: entries }
}

// ─── GODOWN STOCK SUMMARY ────────────────────────────────

export async function getGodownStockSummary() {
  await requireAuth()
  const godowns = await prisma.godown.findMany({
    include: {
      branch: { select: { name: true } },
      stocks: {
        include: { product: { select: { name: true, sku: true, price: true, costPrice: true } } },
      },
      slabs: { where: { status: 'AVAILABLE' }, select: { sqft: true, lot: { select: { costPerSqft: true, product: { select: { price: true } } } } } },
      _count: { select: { stocks: true, ledgerEntries: true } },
    },
    orderBy: { name: 'asc' },
  })

  return {
    success: true,
    data: godowns.map(g => {
      const totalItems = g.stocks.reduce((s, st) => s + st.quantity, 0) + g.slabs.length
      const totalValue = g.stocks.reduce((s, st) => s + (st.quantity * (st.product?.price || 0)), 0) + g.slabs.reduce((sum, slab) => sum + slab.sqft * slab.lot.product.price, 0)
      const totalCostValue = g.stocks.reduce((s, st) => s + (st.quantity * (st.product?.costPrice || 0)), 0) + g.slabs.reduce((sum, slab) => sum + slab.sqft * slab.lot.costPerSqft, 0)
      return {
        ...g,
        totalItems,
        totalValue,
        totalCostValue,
        utilization: g.capacity ? Math.round((totalItems / g.capacity) * 100) : null,
      }
    }),
  }
}

// ─── BRANCHES ────────────────────────────────────────

export async function getBranches() {
  const branches = await prisma.branch.findMany({
    orderBy: { name: 'asc' },
    include: {
      godowns: { select: { id: true, name: true, type: true, isDefault: true } },
      _count: { select: { godowns: true } },
    },
  })
  return { success: true, data: branches }
}

export async function createBranch(data: unknown) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const parsed = createBranchSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const branch = await prisma.branch.create({ data: parsed.data })
  revalidatePath('/godowns')
  return { success: true, data: branch }
}

export async function updateBranch(id: number, data: unknown) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const parsed = createBranchSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const branch = await prisma.branch.update({ where: { id }, data: parsed.data })
  revalidatePath('/godowns')
  return { success: true, data: branch }
}

export async function deleteBranch(id: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const godownCount = await prisma.godown.count({ where: { branchId: id } })
  if (godownCount > 0) return { success: false, error: 'Cannot delete branch with godowns. Remove godowns first.' }
  await prisma.branch.delete({ where: { id } })
  revalidatePath('/godowns')
  return { success: true }
}

// ─── GODOWNS ─────────────────────────────────────────

export async function getGodowns() {
  await requireAuth()
  const godowns = await prisma.godown.findMany({
    orderBy: { name: 'asc' },
    include: {
      branch: { select: { name: true } },
      _count: { select: { stocks: true } },
    },
  })
  return { success: true, data: godowns }
}

export async function createGodown(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createGodownSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  // If this is the first godown, make it default
  const existingCount = await prisma.godown.count()
  const isDefault = parsed.data.isDefault || existingCount === 0

  const godown = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463101)::text`
    const defaultValue = isDefault || await tx.godown.count() === 0
    if (defaultValue) await tx.godown.updateMany({ data: { isDefault: false } })
    return tx.godown.create({ data: { ...parsed.data, isDefault: defaultValue } })
  })
  revalidatePath('/godowns')
  revalidatePath('/inventory')
  return { success: true, data: godown }
}

export async function updateGodown(id: number, data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createGodownSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const godown = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463101)::text`
    if (parsed.data.isDefault) await tx.godown.updateMany({ data: { isDefault: false } })
    return tx.godown.update({ where: { id }, data: parsed.data })
  })
  revalidatePath('/godowns')
  return { success: true, data: godown }
}

export async function deleteGodown(id: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const stockCount = await prisma.godownStock.count({ where: { godownId: id } })
  if (await prisma.slab.count({ where: { godownId: id } }) > 0) return { success: false, error: 'This location contains physical slabs. Move those slabs first.' }
  if (stockCount > 0) return { success: false, error: 'Cannot delete godown with stock. Transfer stock first.' }
  await prisma.godown.delete({ where: { id } })
  revalidatePath('/godowns')
  return { success: true }
}

export async function setDefaultGodown(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463101)::text`
      if (!await tx.godown.findUnique({ where: { id } })) throw new Error('Location not found')
      await tx.godown.updateMany({ data: { isDefault: false } })
      await tx.godown.update({ where: { id }, data: { isDefault: true } })
    })
  } catch (error) { return { success: false, error: inventoryError(error) } }
  revalidatePath('/godowns')
  return { success: true }
}

// ─── GODOWN STOCK ─────────────────────────────────────

export async function getGodownStock(godownId?: number) {
  await requireAuth()
  const stocks = await prisma.godownStock.findMany({
    where: godownId ? { godownId } : undefined,
    include: {
      product: { select: { id: true, name: true, sku: true, price: true, costPrice: true, unitOfMeasure: true, isSlabTracked: true, category: { select: { name: true } } } },
      godown: { select: { name: true, type: true } },
    },
    orderBy: { product: { name: 'asc' } },
  })
  const slabs = await prisma.slab.findMany({
    where: { status: 'AVAILABLE', ...(godownId ? { godownId } : {}) },
    include: { godown: { select: { name: true, type: true } }, lot: { select: { product: { select: { id: true, name: true, sku: true, price: true, costPrice: true, unitOfMeasure: true, isSlabTracked: true, category: { select: { name: true } } } } } } },
  })
  const serialized = new Map<string, { id: number; productId: number; godownId: number | null; quantity: number; areaSqft: number; product: typeof slabs[number]['lot']['product']; godown: typeof slabs[number]['godown'] }>()
  for (const slab of slabs) {
    const key = `${slab.lot.product.sku}:${slab.godownId}`
    const current = serialized.get(key)
    if (current) { current.quantity++; current.areaSqft += slab.sqft }
    else {
      serialized.set(key, { id: -slab.id, productId: slab.lot.product.id, godownId: slab.godownId, quantity: 1, areaSqft: slab.sqft, product: slab.lot.product, godown: slab.godown })
    }
  }
  return { success: true, data: [...stocks, ...serialized.values()] }
}

export async function updateGodownStock(productId: number, godownId: number, quantity: number) {
  const { updateStock } = await import('./products')
  return updateStock({ id: productId, godownId, stock: quantity, reason: 'Stock count correction' })
}

/**
 * Assigns stock to a godown (adds to existing). Used from Inventory page.
 */
export async function assignStockToGodown(productId: number, godownId: number, quantity: number, notes?: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  if (!Number.isFinite(quantity) || quantity <= 0) return { success: false, error: 'Quantity must be positive' }

  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, isSlabTracked: true } })
  if (!product) return { success: false, error: 'Product not found' }
  if (product.isSlabTracked) return { success: false, error: 'Serialized stone stock must be managed through Lot / Slab Explorer' }

  const result = await adjustGodownStock(productId, godownId, quantity, 'IN', {
    referenceType: 'Manual',
    notes: notes || 'Stock assigned to godown',
    createdBy: 'Admin',
  })

  revalidatePath('/godowns')
  revalidatePath('/inventory')
  return { success: true, data: result }
}

// ─── INTER-GODOWN TRANSFERS ──────────────────────────

export async function getTransfers() {
  await requireAuth()
  const transfers = await prisma.godownTransfer.findMany({
    orderBy: { date: 'desc' },
    include: {
      fromGodown: { select: { name: true } },
      toGodown: { select: { name: true } },
      items: { include: { product: { select: { name: true, sku: true } } } },
    },
  })
  return { success: true, data: transfers }
}

export async function createTransfer(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createTransferSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { fromGodownId, toGodownId, notes, requestedBy, items } = parsed.data
  if (fromGodownId === toGodownId) return { success: false, error: 'Source and destination godown cannot be the same' }

  const transferProducts = await prisma.product.findMany({
    where: { id: { in: items.map(item => item.productId) } },
    select: { id: true, isSlabTracked: true },
  })
  if (transferProducts.length !== new Set(items.map(item => item.productId)).size) return { success: false, error: 'One or more selected products no longer exist' }
  if (transferProducts.some(product => product.isSlabTracked)) return { success: false, error: 'Serialized stone must be moved slab-by-slab through Lot / Slab Explorer' }
  if (new Set(items.map(item => item.productId)).size !== items.length) return { success: false, error: 'Each product can appear only once in a transfer' }

  const godowns = await prisma.godown.findMany({
    where: { id: { in: [fromGodownId, toGodownId] } },
    select: { id: true },
  })
  if (godowns.length !== 2) return { success: false, error: 'Source or destination godown was not found' }

  // Validate source stock
  for (const item of items) {
    const sourceStock = await prisma.godownStock.findUnique({
      where: { productId_godownId: { productId: item.productId, godownId: fromGodownId } },
    })
    if (!sourceStock || sourceStock.quantity < item.quantity) {
      return { success: false, error: `Insufficient stock for ${item.name} in source godown (available: ${sourceStock?.quantity || 0}, requested: ${item.quantity})` }
    }
  }

  try {
  const transfer = await prisma.$transaction(async tx => {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463103)::text`
  const lastTransfer = await tx.godownTransfer.findFirst({
    where: { displayId: { startsWith: 'TRF-' } },
    orderBy: { id: 'desc' },
    select: { displayId: true },
  })
  const lastNumber = lastTransfer?.displayId?.match(/^TRF-(\d+)$/)?.[1]
  const displayId = `TRF-${String(lastNumber ? Number(lastNumber) + 1 : 1).padStart(4, '0')}`

  return tx.godownTransfer.create({
    data: {
      displayId,
      fromGodownId,
      toGodownId,
      notes,
      requestedBy,
      items: {
        create: items.map(i => ({
          productId: i.productId,
          name: i.name,
          sku: i.sku,
          quantity: i.quantity,
        })),
      },
    },
  })
  })
  revalidatePath('/godowns')
  return { success: true, data: transfer }
  } catch (error) { return { success: false, error: inventoryError(error) } }
}

export async function completeTransfer(id: number, approvedBy?: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "GodownTransfer" WHERE id = ${id} FOR UPDATE`
      const transfer = await tx.godownTransfer.findUnique({ where: { id }, include: { items: true } })
      if (!transfer) throw new Error('Transfer not found')
      if (transfer.status !== 'Pending') throw new Error('Only a pending transfer can be completed')

      const productIds = [...new Set(transfer.items.map(item => item.productId))]
      await lockInventoryProducts(tx, productIds)
      const transferProducts = await tx.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, isSlabTracked: true },
      })
      if (transferProducts.length !== productIds.length) throw new Error('One or more transfer products no longer exist')
      if (transferProducts.some(product => product.isSlabTracked)) throw new Error('Serialized stone must be moved slab-by-slab through Lot / Slab Explorer')

      for (const item of [...transfer.items].sort((a, b) => a.productId - b.productId)) {
        await adjustGodownStockWithTx(tx, item.productId, transfer.fromGodownId, -item.quantity, 'TRANSFER_OUT', {
          referenceType: 'Transfer',
          referenceId: transfer.id,
          notes: `Transfer ${transfer.displayId}`,
          createdBy: approvedBy || 'Admin',
        })
        await adjustGodownStockWithTx(tx, item.productId, transfer.toGodownId, item.quantity, 'TRANSFER_IN', {
          referenceType: 'Transfer',
          referenceId: transfer.id,
          notes: `Transfer ${transfer.displayId}`,
          createdBy: approvedBy || 'Admin',
        })
      }

      await tx.godownTransfer.update({ where: { id }, data: { status: 'Completed', approvedBy } })
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not complete transfer' }
  }

  revalidatePath('/godowns')
  revalidatePath('/inventory')
  return { success: true }
}

// ─── MIGRATION HELPER ────────────────────────────────

/**
 * One-time migration: Creates GodownStock entries from existing Product.stock values.
 * Ensures all products have their stock allocated in the default godown.
 */
export async function migrateExistingStockToGodowns() {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }

  const defaultGodown = await getOrCreateDefaultGodown()

  const products = await prisma.product.findMany({
    where: { stock: { gt: 0 }, isSlabTracked: false },
    select: { id: true, stock: true, name: true },
  })

  let migrated = 0
  for (const product of products) {
    const existingGodownStock = await prisma.godownStock.findFirst({
      where: { productId: product.id },
    })

    if (!existingGodownStock) {
      await prisma.$transaction(tx => adjustStock(tx, product.id, defaultGodown.id, 0, 'OPENING_BALANCE'))
      migrated++
    }
  }

  revalidatePath('/godowns')
  revalidatePath('/inventory')
  return { success: true, migrated, defaultGodownId: defaultGodown.id, defaultGodownName: defaultGodown.name }
}
