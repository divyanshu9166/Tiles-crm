'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { createProductSchema, updateProductSchema, updateStockSchema } from '@/lib/validations/product'
import { moveProductToDraft } from './drafts'
import { requireRole, requireAuth } from '@/lib/auth-helpers'
import { adjustStock, stockBalance, resolveStockGodown, lockInventoryProducts, inventoryError } from '@/lib/inventory-stock'

export interface BulkRawMaterialRow {
  name: string
  brand?: string
  sku?: string
  size?: number | string
  instock?: number | string
  costPrice?: number | string
  stockQuantity?: number | string
  unitSize?: number | string
  unitOfMeasure?: string
  reorderLevel?: number | string
  description?: string
  image?: string
}

const toNumber = (value: unknown, fallback = 0) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  return toRequiredNumber(value)
}

const toRequiredNumber = (value: unknown) => {
  const text = String(value ?? '').trim()
  if (!text) return Number.NaN
  const n = Number(text)
  return Number.isFinite(n) ? n : Number.NaN
}

export async function getProducts() {
  await requireAuth()
  const products = await prisma.product.findMany({
    include: {
      category: true,
      warehouse: true,
      stoneLots: {
        select: {
          availableSqft: true,
          slabs: { select: { status: true, sqft: true } },
        },
      },
      batches: {
        where: { remainingQty: { gt: 0 } },
        orderBy: { purchaseDate: 'asc' },
        select: { id: true, batchNumber: true, remainingQty: true, quantity: true, shadeCode: true, purchaseDate: true },
      },
    },
    orderBy: { name: 'asc' },
  })

  return {
    success: true,
    data: products.map(p => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category.name,
      categoryId: p.categoryId,
      stockGroupId: p.stockGroupId,
      isRawMaterial: p.category.name === 'Raw Material',
      price: p.price,
      costPrice: p.costPrice,
      brand: p.brand,
      hsnCode: p.hsnCode,
      unitOfMeasure: p.unitOfMeasure,
      unitSize: p.unitSize,
      coveragePerBox: p.coveragePerBox,
      tilesPerBox: p.tilesPerBox,
      tileSize: p.tileSize,
      finish: p.finish,
      surfaceType: p.surfaceType,
      applicationArea: p.applicationArea,
      materialCategory: p.materialCategory,
      isSlabTracked: p.isSlabTracked,
      origin: p.origin,
      thicknessMm: p.thicknessMm,
      qualityGrade: p.qualityGrade,
      bookMatchPair: p.bookMatchPair,
      stock: p.stock,
      sold: p.sold,
      reorderLevel: p.reorderLevel,
      image: p.image,
      material: p.material,
      color: p.color,
      description: p.description,
      warehouse: p.warehouse?.name || 'Unassigned',
      lastRestocked: p.lastRestocked?.toISOString().split('T')[0] || null,
      // Serialized stone is intentionally not copied into Product.stock. Expose
      // its live sellable balance separately so inventory screens do not show
      // a stocked lot as "out of stock" or permit quantity adjustments.
      availableStoneSqft: p.stoneLots.reduce((sum, lot) => sum + lot.slabs.filter(slab => slab.status === 'AVAILABLE').reduce((area, slab) => area + slab.sqft, 0), 0),
      availableStoneSlabs: p.stoneLots.reduce((sum, lot) => sum + lot.slabs.filter(slab => slab.status === 'AVAILABLE').length, 0),
      allocatedStoneSlabs: p.stoneLots.reduce((sum, lot) => sum + lot.slabs.filter(slab => ['RESERVED', 'IN_PROCESSING'].includes(slab.status)).length, 0),
      batches: p.batches.map(batch => ({
        id: batch.id,
        batchNumber: batch.batchNumber,
        remainingQty: batch.remainingQty,
        quantity: batch.quantity,
        shadeCode: batch.shadeCode,
        purchaseDate: batch.purchaseDate.toISOString().split('T')[0],
      })),
    })),
  }
}

export async function getProduct(id: number) {
  await requireAuth()
  const product = await prisma.product.findUnique({
    where: { id },
    include: { category: true, warehouse: true },
  })

  if (!product) return { success: false, error: 'Product not found' }
  return { success: true, data: product }
}

export async function createProduct(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createProductSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const { category, warehouse, godownId, ...rest } = parsed.data
  if (rest.isSlabTracked && rest.stock > 0) return { success: false, error: 'Create the stone product with zero stock, then receive slabs into a Stone Lot.' }
  try {
    const product = await prisma.$transaction(async tx => {
      // Location and opening stock belong to the same transaction as the product.
      const godown = (rest.stock > 0 || godownId) ? await resolveStockGodown(tx, godownId) : null
      const cat = await tx.category.upsert({ where: { name: category }, create: { name: category }, update: {} })
      const wh = warehouse?.trim() ? await tx.warehouse.upsert({ where: { name: warehouse.trim() }, create: { name: warehouse.trim() }, update: {} }) : null
      const created = await tx.product.create({ data: { ...rest, stock: 0, categoryId: cat.id, warehouseId: wh?.id } })
      if (rest.stock > 0 && godown) await adjustStock(tx, created.id, godown.id, rest.stock * rest.unitSize, 'IN', { referenceType: 'Manual', notes: 'Initial stock on product creation' })
      return tx.product.findUniqueOrThrow({ where: { id: created.id } })
    })
    revalidatePath('/inventory')
    revalidatePath('/godowns')
    return { success: true, data: product }
  } catch (error) { return { success: false, error: inventoryError(error) } }
}

export async function bulkImportRawMaterials(rows: BulkRawMaterialRow[]) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  if (!rows || rows.length === 0) return { success: false, error: 'No raw materials to import' }

  const validRows = rows
    .map(r => ({
      name: String(r.name || '').trim(),
      brand: String(r.brand || '').trim(),
      sku: String(r.sku || '').trim(),
      sizeLabel: String(r.size ?? '').trim(),
      costPrice: toNumber(r.costPrice, 0),
      stockQuantity: toRequiredNumber(r.instock ?? r.stockQuantity),
      unitSize: toNumber(r.unitSize, 1),
      unitOfMeasure: String(r.unitOfMeasure || '').trim().toUpperCase() || 'PCS',
      reorderLevel: toNumber(r.reorderLevel, 5),
      description: String(r.description || '').trim(),
      image: String(r.image || '').trim(),
    }))


  if (validRows.length === 0) {
    return { success: false, error: 'No valid rows found. Product name, size, and in-stock are required.' }
  }

  const existingSkus = new Set(
    (await prisma.product.findMany({ select: { sku: true } })).map(p => p.sku)
  )

  let created = 0
  let skipped = 0
  const errors: { row: number; message: string }[] = []

  let counter = (await prisma.product.count({ where: { category: { name: 'Raw Material' } } })) + 1

  const makeUniqueSku = (preferredSku: string) => {
    const baseSku = String(preferredSku || '').trim()
    if (baseSku) { existingSkus.add(baseSku); return baseSku }
    let candidate = baseSku || `RM-${String(counter).padStart(3, '0')}`
    let suffix = 1

    while (existingSkus.has(candidate)) {
      candidate = baseSku ? `${baseSku}-${suffix++}` : `RM-${String((counter + suffix++)).padStart(3, '0')}`
    }

    existingSkus.add(candidate)
    return candidate
  }

  for (const row of validRows) {
    const sku = makeUniqueSku(row.sku)

    const res = await createProduct({
      name: row.name,
      brand: row.brand || undefined,
      sku,
      category: 'Raw Material',
      price: 0,
      costPrice: row.costPrice,
      stock: row.stockQuantity,
      unitOfMeasure: row.unitOfMeasure || 'PCS',
      unitSize: row.unitSize,
      reorderLevel: row.reorderLevel,
      description: row.description || row.sizeLabel || undefined,
      image: row.image || undefined,
    })

    if (res.success) {
      created++
    } else {
      skipped++
      errors.push({ row: created + skipped, message: res.error || 'Invalid row' })
    }

    counter++
  }

  revalidatePath('/manufacturing')
  revalidatePath('/inventory')

  return {
    success: created > 0,
    error: created === 0 ? errors[0]?.message || 'No products imported' : undefined,
    data: { total: rows.length, created, skipped, errors },
  }
}

export interface BulkProductRow {
  name: string
  sku?: string
  category: string
  price: number | string
  instock: number | string
  description?: string
  material?: string
  color?: string
  reorderLevel?: number | string
  warehouse?: string
  costPrice?: number | string
  unitOfMeasure?: string
  unitSize?: number | string
  brand?: string
  tileSize?: string
  finish?: string
  coveragePerBox?: number | string
  tilesPerBox?: number | string
  materialCategory?: string
  godownId?: number
}

export async function bulkImportProducts(rows: BulkProductRow[]) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  if (!rows || rows.length === 0) return { success: false, error: 'No products to import' }

  const validRows = rows
    .map(r => ({
      name: String(r.name || '').trim(),
      sku: String(r.sku || '').trim(),
      category: String(r.category || 'General').trim(),
      price: toRequiredNumber(r.price),
      instock: toRequiredNumber(r.instock),
      description: String(r.description || '').trim(),
      material: String(r.material || '').trim(),
      color: String(r.color || '').trim(),
      reorderLevel: toNumber(r.reorderLevel, 5),
      warehouse: String(r.warehouse || '').trim(),
      costPrice: toNumber(r.costPrice, 0), unitOfMeasure: String(r.unitOfMeasure || 'PCS').trim().toUpperCase(),
      unitSize: toNumber(r.unitSize, 1), brand: r.brand, tileSize: r.tileSize, finish: r.finish,
      coveragePerBox: r.coveragePerBox === undefined || r.coveragePerBox === '' ? undefined : toRequiredNumber(r.coveragePerBox),
      tilesPerBox: r.tilesPerBox === undefined || r.tilesPerBox === '' ? undefined : toRequiredNumber(r.tilesPerBox),
      materialCategory: r.materialCategory, godownId: r.godownId,
    }))


  if (validRows.length === 0) {
    return { success: false, error: 'No valid rows found. Product name, price, and in-stock quantity are required.' }
  }

  const existingSkus = new Set(
    (await prisma.product.findMany({ select: { sku: true } })).map(p => p.sku)
  )

  let created = 0
  let skipped = 0
  const errors: { row: number; message: string }[] = []

  let counter = (await prisma.product.count()) + 1

  const makeUniqueSku = (preferredSku: string) => {
    const baseSku = String(preferredSku || '').trim()
    if (baseSku) { existingSkus.add(baseSku); return baseSku }
    let candidate = baseSku || `PRD-${String(counter).padStart(4, '0')}`
    let suffix = 1

    while (existingSkus.has(candidate)) {
      candidate = baseSku ? `${baseSku}-${suffix++}` : `PRD-${String((counter + suffix++)).padStart(4, '0')}`
    }

    existingSkus.add(candidate)
    return candidate
  }

  for (const row of validRows) {
    const sku = makeUniqueSku(row.sku)

    const res = await createProduct({
      name: row.name,
      sku,
      category: row.category,
      price: row.price,
      costPrice: row.costPrice,
      stock: row.instock,
      reorderLevel: row.reorderLevel,
      description: row.description || undefined,
      material: row.material || undefined,
      color: row.color || undefined,
      warehouse: row.warehouse || undefined,
      unitOfMeasure: row.unitOfMeasure, unitSize: row.unitSize, brand: row.brand, tileSize: row.tileSize, finish: row.finish,
      coveragePerBox: row.coveragePerBox, tilesPerBox: row.tilesPerBox, materialCategory: row.materialCategory, godownId: row.godownId,
    })

    if (res.success) {
      created++
    } else {
      skipped++
      errors.push({ row: created + skipped, message: res.error || 'Invalid row' })
    }

    counter++
  }

  revalidatePath('/inventory')

  return {
    success: created > 0,
    error: created === 0 ? errors[0]?.message || 'No products imported' : undefined,
    data: { total: rows.length, created, skipped, errors },
  }
}

export async function updateProduct(id: number, data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  if (!Number.isSafeInteger(id) || id <= 0) return { success: false, error: 'Invalid product ID' }
  const parsed = updateProductSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  try {
    const product = await prisma.$transaction(async tx => {
      await lockInventoryProducts(tx, [id])
      const existing = await tx.product.findUnique({ where: { id } })
      if (!existing) throw new Error('Product not found')
      const input = parsed.data
      const hasHistory = existing.stock > 0 || existing.sold > 0 || await tx.stockLedger.count({ where: { productId: id } }) > 0 || await tx.productBatch.count({ where: { productId: id } }) > 0 || await tx.stoneLot.count({ where: { productId: id } }) > 0
      if (hasHistory && ((input.unitOfMeasure !== undefined && input.unitOfMeasure !== existing.unitOfMeasure) || (input.unitSize !== undefined && input.unitSize !== existing.unitSize))) throw new Error('Units cannot change after stock or inventory history exists. Create a separate product for the new unit.')
      if (input.isSlabTracked !== undefined && input.isSlabTracked !== existing.isSlabTracked && hasHistory) throw new Error('Stock tracking cannot change after inventory history exists')
      return tx.product.update({ where: { id }, data: input })
    })
    revalidatePath('/inventory')
    return { success: true, data: product }
  } catch (error) { return { success: false, error: inventoryError(error) } }
}

export async function updateStock(data: unknown) {
  let session
  try { session = await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = updateStockSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const input = parsed.data
  try {
    const product = await prisma.$transaction(async tx => {
      await lockInventoryProducts(tx, [input.id])
      const godown = await resolveStockGodown(tx, input.godownId)
      const current = await stockBalance(tx, input.id, godown.id)
      const operation = input.operation || 'SET'
      if (operation === 'SET' && input.expectedBalance !== undefined && Math.abs(current - input.expectedBalance) > 0.000001) throw new Error('Stock has changed since this screen loaded. Refresh before setting its balance.')
      const quantity = input.quantity ?? input.stock!
      const productRow = await tx.product.findUniqueOrThrow({ where: { id: input.id } })
      const setBalance = !input.operation && !input.godownId ? productRow.stock : current
      const delta = operation === 'ADD' ? quantity : operation === 'REMOVE' ? -quantity : quantity - setBalance
      // Batch records describe real stock. Quantity corrections must not leave
      // more units assigned to batches than are physically available.
      if (input.batchId && delta !== 0) {
        if (!Number.isInteger(delta)) throw new Error('Batch quantities must be whole units')
        const batch = await tx.productBatch.findUnique({ where: { id: input.batchId } })
        if (!batch || batch.productId !== input.id) throw new Error('Selected batch does not belong to this product')
        if (batch.remainingQty + delta < 0) throw new Error('Insufficient quantity in the selected batch')
        await tx.productBatch.update({ where: { id: batch.id }, data: {
          remainingQty: { increment: delta },
          ...(delta > 0 ? { quantity: { increment: delta } } : {}),
        } })
      }
      const batchTotal = await tx.productBatch.aggregate({ where: { productId: input.id }, _sum: { remainingQty: true } })
      if (productRow.stock + delta < (batchTotal._sum.remainingQty || 0)) throw new Error('This stock is assigned to batches. Adjust the batch through its purchase/sale workflow first.')
      await adjustStock(tx, input.id, godown.id, delta, 'ADJUSTMENT', { referenceType: 'Manual', notes: [input.reason, input.notes].filter(Boolean).join(' — ') || 'Manual stock adjustment', createdBy: session.user.name })
      return tx.product.findUniqueOrThrow({ where: { id: input.id } })
    })
    revalidatePath('/inventory')
    revalidatePath('/godowns')
    return { success: true, data: product }
  } catch (error) { return { success: false, error: inventoryError(error) } }
}

export async function getCategories() {
  await requireAuth()
  return prisma.category.findMany({ orderBy: { name: 'asc' } })
}

export async function getWarehouses() {
  await requireAuth()
  return prisma.warehouse.findMany({ orderBy: { name: 'asc' } })
}

export async function getLowStockProducts() {
  await requireAuth()
  const products = await prisma.product.findMany({
    where: {},
    include: { category: true, stoneLots: { select: { slabs: { select: { status: true } } } } },
    orderBy: { stock: 'asc' },
  })

  // Filter in JS since Prisma can't compare two columns directly
  return products.map(p => ({ ...p, stock: p.isSlabTracked ? p.stoneLots.reduce((sum, lot) => sum + lot.slabs.filter(slab => slab.status === 'AVAILABLE').length, 0) : p.stock })).filter(p => p.stock <= p.reorderLevel).map(p => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    stock: p.stock,
    reorderLevel: p.reorderLevel,
    category: p.category.name,
  }))
}

export async function deleteProduct(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  return moveProductToDraft(id)
}

export async function deleteRawMaterial(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const product = await prisma.product.findUnique({ where: { id }, include: { category: true } })
  if (!product || product.category.name !== 'Raw Material') return { success: false, error: 'Raw material not found' }
  return moveProductToDraft(id)
}
