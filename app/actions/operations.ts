'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { resolveStockGodown } from '@/lib/inventory-stock'
import { requireActor, actionError } from '@/lib/erp/actor'
import { cancelPickingTx, ensureReceiptForPurchaseOrder, returnDeliveryTx, validatePickingTx } from '@/lib/erp/stock-ops'
import { syncStoneLotTotals } from '@/lib/stone-inventory'
import { logMessage, logTracking, startOfToday } from '@/lib/erp/chatter'

const STOCK_ROLES = ['ADMIN', 'MANAGER'] as const

function refresh() {
  revalidatePath('/operations')
  revalidatePath('/sales-orders')
  revalidatePath('/purchases')
  revalidatePath('/inventory')
}

export async function getPickings(filters: { type?: string; status?: string; search?: string } = {}) {
  try {
    await requireActor()
    const search = filters.search?.trim()
    const pickings = await prisma.stockPicking.findMany({
      where: {
        ...(filters.type ? { pickingType: filters.type } : {}),
        ...(filters.status && filters.status !== 'ALL' ? { status: filters.status } : {}),
        ...(search ? { OR: [
          { displayId: { contains: search, mode: 'insensitive' } },
          { contact: { name: { contains: search, mode: 'insensitive' } } },
          { supplier: { name: { contains: search, mode: 'insensitive' } } },
          { salesOrder: { displayId: { contains: search, mode: 'insensitive' } } },
          { purchaseOrder: { displayId: { contains: search, mode: 'insensitive' } } },
        ] } : {}),
      },
      orderBy: [{ status: 'desc' }, { scheduledDate: 'asc' }, { id: 'desc' }],
      take: 300,
      include: {
        godown: { select: { id: true, name: true } },
        contact: { select: { id: true, name: true, phone: true } },
        supplier: { select: { id: true, name: true } },
        salesOrder: { select: { id: true, displayId: true } },
        purchaseOrder: { select: { id: true, displayId: true } },
        backorderOf: { select: { id: true, displayId: true } },
        lines: { select: { demandQty: true, doneQty: true } },
      },
    })
    const today = startOfToday()
    return {
      success: true as const,
      data: pickings.map(picking => ({ ...picking, isLate: picking.status === 'READY' && picking.scheduledDate < today })),
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load transfers') }
  }
}

export async function getPicking(id: number) {
  try {
    await requireActor()
    const picking = await prisma.stockPicking.findUnique({
      where: { id },
      include: {
        godown: { select: { id: true, name: true } },
        contact: { select: { id: true, name: true, phone: true, address: true } },
        supplier: { select: { id: true, name: true, phone: true } },
        salesOrder: { select: { id: true, displayId: true, projectName: true } },
        purchaseOrder: { select: { id: true, displayId: true } },
        backorderOf: { select: { id: true, displayId: true } },
        backorders: { select: { id: true, displayId: true, status: true } },
        returnOf: { select: { id: true, displayId: true } },
        returns: { select: { id: true, displayId: true, status: true } },
        landedCosts: { where: { status: { not: 'CANCELLED' } }, select: { id: true, displayId: true, status: true }, orderBy: { id: 'desc' } },
        lines: { orderBy: { id: 'asc' }, include: { product: { select: { id: true, unitOfMeasure: true, isSlabTracked: true } }, batch: { select: { id: true, batchNumber: true, shadeCode: true } } } },
      },
    })
    if (!picking) return { success: false as const, error: 'Transfer not found' }
    const productIds = picking.lines.map(line => line.productId)
    const [stocks, batches] = await Promise.all([
      prisma.godownStock.findMany({ where: { godownId: picking.godownId, productId: { in: productIds } }, select: { productId: true, quantity: true } }),
      picking.pickingType === 'DELIVERY'
        ? prisma.productBatch.findMany({ where: { productId: { in: productIds }, remainingQty: { gt: 0 } }, select: { id: true, productId: true, batchNumber: true, shadeCode: true, remainingQty: true }, orderBy: { purchaseDate: 'asc' } })
        : Promise.resolve([]),
    ])
    const onHand = new Map(stocks.map(stock => [stock.productId, stock.quantity]))
    // What can still come back from a validated delivery.
    const returned = picking.pickingType === 'DELIVERY' && picking.status === 'DONE'
      ? await prisma.stockPickingLine.findMany({ where: { returnOfLineId: { in: picking.lines.map(line => line.id) }, picking: { status: 'DONE' } }, select: { returnOfLineId: true, doneQty: true, slabIds: true } })
      : []
    const deliveredSlabIds = picking.lines.flatMap(line => line.slabIds)
    const deliveredSlabs = deliveredSlabIds.length
      ? await prisma.slab.findMany({ where: { id: { in: deliveredSlabIds } }, select: { id: true, slabNumber: true, sqft: true, lengthInches: true, widthInches: true, status: true, reservedForOrderId: true, bookMatchPairId: true, qcGrade: true, lot: { select: { productId: true, lotNumber: true, shadeCode: true } } } })
      : []
    // Serial-tracked stone: slabs that can be loaded on this delivery.
    const slabLines = picking.pickingType === 'DELIVERY' ? picking.lines.filter(line => line.product.isSlabTracked) : []
    const slabs = slabLines.length > 0
      ? await prisma.slab.findMany({
        where: {
          lot: { productId: { in: slabLines.map(line => line.productId) } },
          OR: [{ godownId: picking.godownId }, { godownId: null }, { id: { in: picking.lines.flatMap(line => line.slabIds) } }],
          AND: [{ OR: [
            { status: 'AVAILABLE' },
            ...(picking.salesOrderId ? [{ status: 'RESERVED', reservedForOrderId: picking.salesOrderId }] : []),
            { id: { in: picking.lines.flatMap(line => line.slabIds) } },
          ] }],
        },
        orderBy: [{ lotId: 'asc' }, { slabNumber: 'asc' }],
        select: { id: true, slabNumber: true, sqft: true, lengthInches: true, widthInches: true, status: true, reservedForOrderId: true, bookMatchPairId: true, qcGrade: true, lot: { select: { productId: true, lotNumber: true, shadeCode: true } } },
      })
      : []
    return {
      success: true as const,
      data: {
        ...picking,
        lines: picking.lines.map(line => ({
          ...line,
          onHand: onHand.get(line.productId) ?? 0,
          batches: batches.filter(batch => batch.productId === line.productId),
          slabs: picking.status === 'READY' ? slabs.filter(slab => slab.lot.productId === line.productId) : deliveredSlabs.filter(slab => line.slabIds.includes(slab.id)),
          returnedQty: returned.filter(row => row.returnOfLineId === line.id).reduce((sum, row) => sum + row.doneQty, 0),
          returnedSlabIds: returned.filter(row => row.returnOfLineId === line.id).flatMap(row => row.slabIds),
        })),
      },
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load the transfer') }
  }
}

const validateSchema = z.object({
  id: z.number().int().positive(),
  createBackorder: z.boolean().default(true),
  vehicleNumber: z.string().trim().max(30).optional(),
  driverName: z.string().trim().max(100).optional(),
  driverPhone: z.string().trim().max(20).optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({
    lineId: z.number().int().positive(),
    doneQty: z.number().int().min(0),
    batchId: z.number().int().positive().optional().nullable(),
    slabIds: z.array(z.number().int().positive()).max(500).optional(),
    batchNumber: z.string().trim().max(60).optional(),
    shadeCode: z.string().trim().max(60).optional(),
    expiryDate: z.string().trim().max(10).optional(),
  })).min(1),
})

export async function validatePicking(data: unknown) {
  try {
    const actor = await requireActor(...STOCK_ROLES)
    const input = validateSchema.parse(data)
    const result = await prisma.$transaction(tx => validatePickingTx(tx, input.id, input, actor), { timeout: 20000 })
    refresh()
    return { success: true as const, data: result }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not validate the transfer') }
  }
}

export async function cancelPicking(id: number) {
  try {
    const actor = await requireActor(...STOCK_ROLES)
    await prisma.$transaction(async tx => {
      const picking = await tx.stockPicking.findUnique({ where: { id }, select: { salesOrderId: true, purchaseOrderId: true, backorderOfId: true } })
      // A PO's only open receipt is cancelled through the PO itself.
      if (picking?.purchaseOrderId && !picking.backorderOfId) throw new Error('Cancel the purchase order instead, or validate this receipt with "No backorder" to close it short.')
      await cancelPickingTx(tx, id, actor)
    })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not cancel the transfer') }
  }
}

const scheduleSchema = z.object({
  id: z.number().int().positive(),
  scheduledDate: z.string().min(1),
  godownId: z.number().int().positive().optional(),
})

export async function reschedulePicking(data: unknown) {
  try {
    const actor = await requireActor(...STOCK_ROLES)
    const input = scheduleSchema.parse(data)
    const date = new Date(input.scheduledDate.length === 10 ? `${input.scheduledDate}T12:00:00` : input.scheduledDate)
    if (Number.isNaN(date.getTime())) throw new Error('Invalid date')
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "StockPicking" WHERE id = ${input.id} FOR UPDATE`
      const picking = await tx.stockPicking.findUnique({ where: { id: input.id }, include: { godown: { select: { name: true } } } })
      if (!picking || picking.status !== 'READY') throw new Error('Only open transfers can be rescheduled')
      const godown = input.godownId ? await resolveStockGodown(tx, input.godownId) : null
      await tx.stockPicking.update({ where: { id: input.id }, data: { scheduledDate: date, ...(godown ? { godownId: godown.id } : {}) } })
      await logTracking(tx, 'StockPicking', input.id, 'Transfer updated', [
        ...(picking.scheduledDate.toISOString().slice(0, 10) !== date.toISOString().slice(0, 10) ? [{ field: 'Scheduled date', from: picking.scheduledDate.toISOString().slice(0, 10), to: date.toISOString().slice(0, 10) }] : []),
        ...(godown && godown.id !== picking.godownId ? [{ field: 'Location', from: picking.godown.name, to: godown.name }] : []),
      ], actor)
    })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not reschedule the transfer') }
  }
}

const reserveSchema = z.object({ pickingId: z.number().int().positive(), slabIds: z.array(z.number().int().positive()).min(1), release: z.boolean().default(false) })

// Hold specific slabs (e.g. a book-matched set) for the delivery's sales order
// so POS and fabrication cannot take them; release puts them back on sale.
export async function reserveDeliverySlabs(data: unknown) {
  try {
    const actor = await requireActor(...STOCK_ROLES)
    const input = reserveSchema.parse(data)
    const count = await prisma.$transaction(async tx => {
      const picking = await tx.stockPicking.findUnique({ where: { id: input.pickingId }, include: { lines: { select: { productId: true } } } })
      if (!picking || picking.pickingType !== 'DELIVERY' || picking.status !== 'READY' || !picking.salesOrderId) throw new Error('Slabs can only be reserved on an open sales-order delivery')
      const productIds = picking.lines.map(line => line.productId)
      const slabs = await tx.slab.findMany({ where: { id: { in: input.slabIds } }, select: { id: true, slabNumber: true, lotId: true, lot: { select: { productId: true } } } })
      if (slabs.length !== input.slabIds.length || slabs.some(slab => !productIds.includes(slab.lot.productId))) throw new Error('A selected slab does not belong to this delivery')
      const changed = await tx.slab.updateMany({
        where: input.release
          ? { id: { in: input.slabIds }, status: 'RESERVED', reservedForOrderId: picking.salesOrderId }
          : { id: { in: input.slabIds }, status: 'AVAILABLE' },
        data: input.release ? { status: 'AVAILABLE', reservedForOrderId: null } : { status: 'RESERVED', reservedForOrderId: picking.salesOrderId },
      })
      if (changed.count !== input.slabIds.length) throw new Error(input.release ? 'Some slabs are not reserved for this order' : 'Some slabs were taken meanwhile. Refresh and try again.')
      for (const lotId of new Set(slabs.map(slab => slab.lotId))) await syncStoneLotTotals(tx, lotId)
      await logMessage(tx, 'StockPicking', picking.id, `${input.release ? 'Released' : 'Reserved'} slabs ${slabs.map(slab => slab.slabNumber).join(', ')}`, { author: actor })
      return changed.count
    })
    refresh()
    return { success: true as const, data: { count } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not update the slab reservation') }
  }
}

const returnSchema = z.object({
  deliveryId: z.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
  lines: z.array(z.object({ lineId: z.number().int().positive(), quantity: z.number().int().min(0), slabIds: z.array(z.number().int().positive()).optional() })).min(1),
})

export async function returnDelivery(data: unknown) {
  try {
    const actor = await requireActor(...STOCK_ROLES)
    const input = returnSchema.parse(data)
    const picking = await prisma.$transaction(tx => returnDeliveryTx(tx, input.deliveryId, input, actor), { timeout: 20000 })
    refresh()
    return { success: true as const, data: { id: picking.id, displayId: picking.displayId } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not record the return') }
  }
}

// Approved POs from before GRNs existed get their receipt on first visit.
export async function syncPurchaseReceipts() {
  try {
    const actor = await requireActor(...STOCK_ROLES)
    const pos = await prisma.purchaseOrder.findMany({
      where: { status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] }, pickings: { none: { pickingType: 'RECEIPT', status: 'READY' } } },
      select: { id: true },
      take: 200,
    })
    let created = 0
    for (const po of pos) {
      const receipt = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${po.id} FOR UPDATE`
        return ensureReceiptForPurchaseOrder(tx, po.id, actor)
      })
      if (receipt) created += 1
    }
    if (created) refresh()
    return { success: true as const, data: { created } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not prepare receipts') }
  }
}

// Odoo Inventory Overview: one card per operation type.
export async function getOperationsOverview() {
  try {
    await requireActor()
    const now = startOfToday()
    const [receiptsReady, receiptsLate, deliveriesReady, deliveriesLate, backorders, countsOpen, transfersPending, rules] = await Promise.all([
      prisma.stockPicking.count({ where: { pickingType: 'RECEIPT', status: 'READY' } }),
      prisma.stockPicking.count({ where: { pickingType: 'RECEIPT', status: 'READY', scheduledDate: { lt: now } } }),
      prisma.stockPicking.count({ where: { pickingType: 'DELIVERY', status: 'READY' } }),
      prisma.stockPicking.count({ where: { pickingType: 'DELIVERY', status: 'READY', scheduledDate: { lt: now } } }),
      prisma.stockPicking.count({ where: { status: 'READY', backorderOfId: { not: null } } }),
      prisma.inventoryCount.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.godownTransfer.count({ where: { status: 'Pending' } }),
      prisma.reorderRule.count({ where: { active: true } }),
    ])
    return { success: true as const, data: { receiptsReady, receiptsLate, deliveriesReady, deliveriesLate, backorders, countsOpen, transfersPending, rules } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load the overview') }
  }
}
