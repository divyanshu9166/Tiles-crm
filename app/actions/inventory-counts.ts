'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { adjustStock, lockInventoryProducts, resolveStockGodown } from '@/lib/inventory-stock'
import { requireActor, actionError } from '@/lib/erp/actor'
import { nextSequence } from '@/lib/erp/sequence'
import { logMessage, logTracking } from '@/lib/erp/chatter'

const STOCK_ROLES = ['ADMIN', 'MANAGER'] as const

function refresh() {
  revalidatePath('/inventory-counts')
  revalidatePath('/operations')
  revalidatePath('/inventory')
}

const createSchema = z.object({
  godownId: z.number().int().positive(),
  name: z.string().trim().max(120).optional(),
  scope: z.enum(['LOCATION', 'CATEGORY', 'PRODUCTS']).default('LOCATION'),
  categoryId: z.number().int().positive().optional(),
  productIds: z.array(z.number().int().positive()).optional(),
  assignedToId: z.number().int().positive().optional(),
  scheduledDate: z.string().optional(),
  notes: z.string().trim().max(1000).optional(),
})

// Odoo physical inventory: snapshot what the system believes is on hand, let
// the team count, then post only the differences as adjustments.
export async function createInventoryCount(data: unknown) {
  try {
    const actor = await requireActor(...STOCK_ROLES)
    const input = createSchema.parse(data)
    const count = await prisma.$transaction(async tx => {
      const godown = await resolveStockGodown(tx, input.godownId)
      let productIds: number[]
      if (input.scope === 'PRODUCTS') {
        productIds = input.productIds || []
      } else if (input.scope === 'CATEGORY') {
        if (!input.categoryId) throw new Error('Select a category to count')
        productIds = (await tx.product.findMany({ where: { categoryId: input.categoryId, isSlabTracked: false }, select: { id: true } })).map(p => p.id)
      } else {
        productIds = (await tx.godownStock.findMany({ where: { godownId: godown.id, product: { isSlabTracked: false } }, select: { productId: true } })).map(s => s.productId)
      }
      const products = await tx.product.findMany({ where: { id: { in: productIds }, isSlabTracked: false }, select: { id: true, costPrice: true } })
      if (products.length === 0) throw new Error('No countable products found for this selection (slab-tracked stone is counted in Lot / Slab Explorer)')
      const stocks = await tx.godownStock.findMany({ where: { godownId: godown.id, productId: { in: products.map(p => p.id) } } })
      const onHand = new Map(stocks.map(stock => [stock.productId, stock.quantity]))
      const created = await tx.inventoryCount.create({
        data: {
          displayId: await nextSequence(tx, 'InventoryCount'),
          name: input.name || `${godown.name} count`,
          godownId: godown.id,
          assignedToId: input.assignedToId,
          scheduledDate: input.scheduledDate ? new Date(`${input.scheduledDate}T12:00:00`) : new Date(),
          notes: input.notes,
          createdBy: actor.name,
          lines: { create: products.map(product => ({ productId: product.id, systemQty: onHand.get(product.id) ?? 0, unitCost: product.costPrice })) },
        },
      })
      await logMessage(tx, 'InventoryCount', created.id, `Count started for ${products.length} products`, { author: actor })
      return created
    })
    refresh()
    return { success: true as const, data: count }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not start the count') }
  }
}

export async function getInventoryCounts() {
  try {
    await requireActor()
    const counts = await prisma.inventoryCount.findMany({
      orderBy: { id: 'desc' },
      take: 200,
      include: {
        godown: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true } },
        lines: { select: { countedQty: true, systemQty: true, appliedDelta: true, unitCost: true } },
      },
    })
    return {
      success: true as const,
      data: counts.map(count => ({
        ...count,
        lineCount: count.lines.length,
        countedCount: count.lines.filter(line => line.countedQty !== null).length,
        differenceValue: count.lines.reduce((sum, line) => {
          const delta = line.appliedDelta ?? (line.countedQty === null ? 0 : line.countedQty - line.systemQty)
          return sum + delta * line.unitCost
        }, 0),
        lines: undefined,
      })),
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load counts') }
  }
}

export async function getInventoryCount(id: number) {
  try {
    await requireActor()
    const count = await prisma.inventoryCount.findUnique({
      where: { id },
      include: {
        godown: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true } },
        lines: { orderBy: { id: 'asc' }, include: { product: { select: { id: true, name: true, sku: true, unitOfMeasure: true, category: { select: { name: true } } } } } },
      },
    })
    if (!count) return { success: false as const, error: 'Count not found' }
    const live = await prisma.godownStock.findMany({ where: { godownId: count.godownId, productId: { in: count.lines.map(line => line.productId) } } })
    const onHand = new Map(live.map(stock => [stock.productId, stock.quantity]))
    return {
      success: true as const,
      data: {
        ...count,
        lines: count.lines.map(line => {
          const current = onHand.get(line.productId) ?? 0
          // A counted line is applied against its snapshot; an uncounted one against live stock.
          const baseQty = line.countedQty === null ? current : line.systemQty
          const difference = line.appliedDelta ?? (line.countedQty === null ? null : line.countedQty - baseQty)
          return { ...line, currentQty: current, baseQty, movedSinceSnapshot: count.status === 'IN_PROGRESS' && line.countedQty !== null && current !== line.systemQty, difference }
        }),
      },
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load the count') }
  }
}

const countedSchema = z.object({
  lineId: z.number().int().positive(),
  countedQty: z.number().min(0).max(10_000_000).nullable(),
  notes: z.string().trim().max(300).optional(),
})

// Counting itself is open to warehouse staff; applying needs a manager.
export async function setCountedQty(data: unknown) {
  try {
    await requireActor()
    const input = countedSchema.parse(data)
    const line = await prisma.inventoryCountLine.findUnique({ where: { id: input.lineId }, include: { count: { select: { status: true, godownId: true } } } })
    if (!line) throw new Error('Count line not found')
    if (line.count.status !== 'IN_PROGRESS') throw new Error('This count is already closed')
    // Snapshot what the system held at the moment this line was counted, so
    // sales/receipts after counting are kept when the count is applied.
    const live = input.countedQty === null ? null : await prisma.godownStock.findUnique({ where: { productId_godownId: { productId: line.productId, godownId: line.count.godownId } }, select: { quantity: true } })
    const saved = await prisma.inventoryCountLine.updateMany({
      where: { id: input.lineId, count: { status: 'IN_PROGRESS' } },
      data: { countedQty: input.countedQty, ...(live ? { systemQty: live.quantity } : input.countedQty !== null ? { systemQty: 0 } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}) },
    })
    if (saved.count !== 1) throw new Error('This count is already closed')
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not save the counted quantity') }
  }
}

export async function addCountLine(data: unknown) {
  try {
    await requireActor(...STOCK_ROLES)
    const input = z.object({ countId: z.number().int().positive(), productId: z.number().int().positive() }).parse(data)
    const count = await prisma.inventoryCount.findUnique({ where: { id: input.countId } })
    if (!count || count.status !== 'IN_PROGRESS') throw new Error('This count is already closed')
    const product = await prisma.product.findUnique({ where: { id: input.productId }, select: { isSlabTracked: true, costPrice: true } })
    if (!product) throw new Error('Product not found')
    if (product.isSlabTracked) throw new Error('Slab-tracked stone is counted in Lot / Slab Explorer')
    const stock = await prisma.godownStock.findUnique({ where: { productId_godownId: { productId: input.productId, godownId: count.godownId } } })
    await prisma.inventoryCountLine.create({ data: { countId: count.id, productId: input.productId, systemQty: stock?.quantity ?? 0, unitCost: product.costPrice } })
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not add the product') }
  }
}

export async function applyInventoryCount(id: number) {
  try {
    const actor = await requireActor(...STOCK_ROLES)
    const summary = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "InventoryCount" WHERE id = ${id} FOR UPDATE`
      const count = await tx.inventoryCount.findUnique({ where: { id }, include: { lines: { include: { product: { select: { name: true } } } } } })
      if (!count) throw new Error('Count not found')
      if (count.status !== 'IN_PROGRESS') throw new Error('This count was already applied or cancelled')
      const counted = count.lines.filter(line => line.countedQty !== null)
      if (counted.length === 0) throw new Error('Enter at least one counted quantity before applying')
      await lockInventoryProducts(tx, counted.map(line => line.productId))
      let adjusted = 0
      let value = 0
      for (const line of counted) {
        // The difference found when the line was counted (counted − system at
        // that moment). Moves after counting stay: applying the absolute
        // counted quantity used to erase sales made in between.
        const delta = Math.round(((line.countedQty as number) - line.systemQty) * 1e6) / 1e6
        if (delta !== 0) {
          await adjustStock(tx, line.productId, count.godownId, delta, 'ADJUSTMENT', {
            referenceType: 'InventoryCount', referenceId: count.id, notes: `Physical count ${count.displayId}`, createdBy: actor.name,
          })
          if (delta < 0) {
            const [product, batches] = await Promise.all([
              tx.product.findUnique({ where: { id: line.productId }, select: { stock: true } }),
              tx.productBatch.aggregate({ where: { productId: line.productId }, _sum: { remainingQty: true } }),
            ])
            if ((batches._sum.remainingQty || 0) > (product?.stock || 0)) {
              throw new Error(`${line.product.name}: the counted quantity is below the stock assigned to batches/shades. Reduce the batch quantities first.`)
            }
          }
          adjusted += 1
          value += delta * line.unitCost
        }
        await tx.inventoryCountLine.update({ where: { id: line.id }, data: { appliedDelta: delta } })
      }
      await tx.inventoryCount.update({ where: { id }, data: { status: 'DONE', appliedAt: new Date(), appliedBy: actor.name } })
      await logTracking(tx, 'InventoryCount', id, `Count applied: ${adjusted} adjustments, value ₹${Math.round(value).toLocaleString('en-IN')}`, [{ field: 'Status', from: 'IN_PROGRESS', to: 'DONE' }], actor)
      return { adjusted, value: Math.round(value) }
    }, { timeout: 30000 })
    refresh()
    return { success: true as const, data: summary }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not apply the count') }
  }
}

export async function cancelInventoryCount(id: number) {
  try {
    const actor = await requireActor(...STOCK_ROLES)
    await prisma.$transaction(async tx => {
      const cancelled = await tx.inventoryCount.updateMany({ where: { id, status: 'IN_PROGRESS' }, data: { status: 'CANCELLED' } })
      if (cancelled.count !== 1) throw new Error('This count is already closed')
      await logTracking(tx, 'InventoryCount', id, 'Count cancelled', [{ field: 'Status', from: 'IN_PROGRESS', to: 'CANCELLED' }], actor)
    })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not cancel the count') }
  }
}
