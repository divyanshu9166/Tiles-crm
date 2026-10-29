'use server'

import { guarded } from '@/lib/action-guard'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { requireRole, requireAuth } from '@/lib/auth-helpers'
import { z } from 'zod'
import { lockInventoryProducts, inventoryError } from '@/lib/inventory-stock'

const createBatchSchema = z.object({
  productId: z.number().int().positive(),
  batchNumber: z.string().trim().min(1, 'Batch number is required'),
  purchaseDate: z.string().optional(),
  expiryDate: z.string().optional(),
  quantity: z.number().int().min(1),
  remainingQty: z.number().int().min(0),
  costPrice: z.number().int().min(0).default(0),
  supplierId: z.number().int().positive().optional(),
  poId: z.number().int().positive().optional(),
  shadeCode: z.string().trim().optional(),
}).refine(v => v.remainingQty <= v.quantity, { message: 'Remaining quantity cannot exceed received quantity' })

export async function getBatches(...args: Parameters<typeof _getBatches>): Promise<Awaited<ReturnType<typeof _getBatches>>> {
  return guarded('getBatches', () => _getBatches(...args))
}

async function _getBatches(productId?: number) {
  await requireAuth()
  const batches = await prisma.productBatch.findMany({
    where: productId ? { productId } : undefined,
    include: {
      product: { select: { name: true, sku: true } },
    },
    orderBy: { purchaseDate: 'desc' },
  })
  return { success: true, data: batches }
}

export async function createBatch(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createBatchSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { purchaseDate, expiryDate, ...rest } = parsed.data
  const received = purchaseDate ? new Date(purchaseDate) : new Date()
  const expires = expiryDate ? new Date(expiryDate) : undefined
  if (Number.isNaN(received.getTime()) || (expires && Number.isNaN(expires.getTime()))) return { success: false, error: 'Enter valid batch dates' }
  if (received > new Date()) return { success: false, error: 'Received stock cannot have a future purchase date' }
  if (expires && expires < received) return { success: false, error: 'Expiry cannot precede the purchase date' }
  try {
    const batch = await prisma.$transaction(async tx => {
      await lockInventoryProducts(tx, [rest.productId])
      const product = await tx.product.findUnique({ where: { id: rest.productId } })
      if (!product) throw new Error('Product not found')
      if (product.isSlabTracked) throw new Error('Receive serialized stone through a Stone Lot, not a quantity batch')
      if (rest.poId) throw new Error('Receive purchase-order batches through the Purchases section')
      if (rest.supplierId && !await tx.supplier.findUnique({ where: { id: rest.supplierId } })) throw new Error('Supplier not found')
      const existing = await tx.productBatch.aggregate({ where: { productId: rest.productId }, _sum: { remainingQty: true } })
      if ((existing._sum.remainingQty || 0) + rest.remainingQty > product.stock) throw new Error('Batch quantity exceeds unassigned stock. Receive or add physical stock first.')
      return tx.productBatch.create({ data: { ...rest, purchaseDate: received, expiryDate: expires } })
    })
    revalidatePath('/inventory')
    return { success: true, data: batch }
  } catch (error) { return { success: false, error: inventoryError(error) } }
}

export async function getAgingAnalysis(...args: Parameters<typeof _getAgingAnalysis>): Promise<Awaited<ReturnType<typeof _getAgingAnalysis>>> {
  return guarded('getAgingAnalysis', () => _getAgingAnalysis(...args))
}

async function _getAgingAnalysis() {
  await requireAuth()
  const batches = await prisma.productBatch.findMany({
    where: { remainingQty: { gt: 0 } },
    include: { product: { select: { name: true, sku: true, category: { select: { name: true } } } } },
    orderBy: { purchaseDate: 'asc' },
  })

  const now = new Date()
  const aging = batches.map(b => {
    const days = Math.floor((now.getTime() - new Date(b.purchaseDate).getTime()) / (1000 * 60 * 60 * 24))
    let bracket = '0-30 days'
    if (days > 180) bracket = '180+ days'
    else if (days > 90) bracket = '91-180 days'
    else if (days > 60) bracket = '61-90 days'
    else if (days > 30) bracket = '31-60 days'

    return {
      ...b,
      ageDays: days,
      bracket,
      value: b.remainingQty * b.costPrice,
    }
  })

  return { success: true, data: aging }
}
