'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { lockInventoryProducts } from '@/lib/inventory-stock'
import { requireActor, actionError } from '@/lib/erp/actor'
import { nextSequence } from '@/lib/erp/sequence'
import { logMessage } from '@/lib/erp/chatter'
import { SPLIT_METHODS, allocateLandedCost, costAfterLanding, splitAmount, splitStockAndCogs, type SplitMethod } from '@/lib/erp/landed-cost'

type Tx = Prisma.TransactionClient
const ROLES = ['ADMIN', 'MANAGER'] as const
const COST_TYPES = ['FREIGHT', 'DUTY', 'INSURANCE', 'LOADING', 'OTHER'] as const
const CREDIT_TO = ['EXPENSE', 'PAYABLE', 'CASH', 'BANK'] as const

function refresh() {
  revalidatePath('/landed-costs')
  revalidatePath('/operations')
  revalidatePath('/inventory')
}

const pickingInclude = {
  purchaseOrder: { select: { id: true, displayId: true } },
  supplier: { select: { id: true, name: true } },
  lines: { where: { doneQty: { gt: 0 } }, select: { id: true, productId: true, name: true, sku: true, doneQty: true, unitCost: true, purchaseOrderItemId: true, product: { select: { costPrice: true, stock: true, isSlabTracked: true } } } },
} satisfies Prisma.StockPickingInclude

type PickingWithLines = Prisma.StockPickingGetPayload<{ include: typeof pickingInclude }>
type CostInput = { amount: number; splitMethod: string }

// The allocation a draft would post right now, from live stock and cost.
function computeAllocation(pickings: PickingWithLines[], costs: CostInput[]) {
  const lines = pickings.flatMap(picking => picking.lines
    .filter(line => !line.product.isSlabTracked)
    .map(line => ({ ...line, pickingId: picking.id, pickingDisplayId: picking.displayId, poDisplayId: picking.purchaseOrder?.displayId ?? null, value: line.doneQty * (line.unitCost ?? line.product.costPrice) })))
  const shares = allocateLandedCost(lines.map(line => ({ id: line.id, quantity: line.doneQty, value: line.value })), costs.map(cost => ({ amount: cost.amount, splitMethod: cost.splitMethod as SplitMethod })))

  // Lines of the same product share one on-hand quantity and one average cost.
  const rows = lines.map(line => ({ line, additional: shares.get(line.id) || 0, inStockQty: 0, toStock: 0, toCogs: 0, costBefore: line.product.costPrice, costAfter: line.product.costPrice }))
  const byProduct = new Map<number, typeof rows>()
  for (const row of rows) byProduct.set(row.line.productId, [...(byProduct.get(row.line.productId) || []), row])
  for (const group of byProduct.values()) {
    const { stock, costPrice } = group[0].line.product
    const received = group.reduce((sum, row) => sum + row.line.doneQty, 0)
    const additional = group.reduce((sum, row) => sum + row.additional, 0)
    const total = splitStockAndCogs(additional, received, stock)
    const toStock = splitAmount(total.toStock, group.map(row => row.additional))
    const inStock = splitAmount(total.inStockQty, group.map(row => row.line.doneQty))
    const costAfter = costAfterLanding(stock, costPrice, total.toStock)
    group.forEach((row, index) => {
      row.toStock = toStock[index]
      row.toCogs = row.additional - toStock[index]
      row.inStockQty = inStock[index]
      row.costAfter = costAfter
    })
  }
  return rows.map(row => ({
    pickingLineId: row.line.id, pickingId: row.line.pickingId, pickingDisplayId: row.line.pickingDisplayId, poDisplayId: row.line.poDisplayId,
    productId: row.line.productId, name: row.line.name, sku: row.line.sku, quantity: row.line.doneQty, originalValue: row.line.value,
    additionalCost: row.additional, inStockQty: row.inStockQty, toStock: row.toStock, toCogs: row.toCogs, costBefore: row.costBefore, costAfter: row.costAfter,
  }))
}

export async function getLandedCosts(filters: { status?: string; search?: string } = {}) {
  try {
    await requireActor(...ROLES)
    const search = filters.search?.trim()
    const where: Prisma.LandedCostWhereInput = {
      ...(filters.status && filters.status !== 'ALL' ? { status: filters.status } : {}),
      ...(search ? { OR: [
        { displayId: { contains: search, mode: 'insensitive' } },
        { vendorRef: { contains: search, mode: 'insensitive' } },
        { supplier: { name: { contains: search, mode: 'insensitive' } } },
        { pickings: { some: { displayId: { contains: search, mode: 'insensitive' } } } },
        { pickings: { some: { purchaseOrder: { displayId: { contains: search, mode: 'insensitive' } } } } },
      ] } : {}),
    }
    const costs = await prisma.landedCost.findMany({
      where, orderBy: { id: 'desc' }, take: 200,
      include: { supplier: { select: { name: true } }, pickings: { select: { id: true, displayId: true, purchaseOrder: { select: { displayId: true } } } }, lines: { select: { amount: true } } },
    })
    return {
      success: true as const,
      data: costs.map(cost => ({
        id: cost.id, displayId: cost.displayId, status: cost.status, date: cost.date, supplier: cost.supplier?.name ?? null, vendorRef: cost.vendorRef, creditTo: cost.creditTo,
        amountTotal: cost.status === 'DRAFT' ? cost.lines.reduce((sum, line) => sum + line.amount, 0) : cost.amountTotal,
        receipts: cost.pickings.map(picking => ({ id: picking.id, displayId: picking.displayId, po: picking.purchaseOrder?.displayId ?? null })),
      })),
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load landed costs') }
  }
}

// Completed receipts that can carry landed costs (newest first).
export async function getLandedCostReceipts(search = '') {
  try {
    await requireActor(...ROLES)
    const q = search.trim()
    const pickings = await prisma.stockPicking.findMany({
      where: {
        pickingType: 'RECEIPT', status: 'DONE',
        ...(q ? { OR: [
          { displayId: { contains: q, mode: 'insensitive' } },
          { purchaseOrder: { displayId: { contains: q, mode: 'insensitive' } } },
          { supplier: { name: { contains: q, mode: 'insensitive' } } },
        ] } : {}),
      },
      orderBy: { doneAt: 'desc' }, take: 40,
      include: { ...pickingInclude, _count: { select: { landedCosts: { where: { status: 'POSTED' } } } } },
    })
    return {
      success: true as const,
      data: pickings.filter(picking => picking.lines.some(line => !line.product.isSlabTracked)).map(picking => ({
        id: picking.id, displayId: picking.displayId, doneAt: picking.doneAt, po: picking.purchaseOrder?.displayId ?? null, supplier: picking.supplier?.name ?? null,
        lines: picking.lines.length, quantity: picking.lines.reduce((sum, line) => sum + line.doneQty, 0),
        value: picking.lines.reduce((sum, line) => sum + line.doneQty * (line.unitCost ?? line.product.costPrice), 0),
        landed: picking._count.landedCosts,
      })),
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load receipts') }
  }
}

export async function getLandedCost(id: number) {
  try {
    await requireActor(...ROLES)
    const cost = await prisma.landedCost.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true } },
        lines: { orderBy: { id: 'asc' } },
        pickings: { include: pickingInclude, orderBy: { id: 'asc' } },
        allocations: { include: { pickingLine: { select: { name: true, sku: true, picking: { select: { id: true, displayId: true, purchaseOrder: { select: { displayId: true } } } } } } }, orderBy: { id: 'asc' } },
      },
    })
    if (!cost) return { success: false as const, error: 'Landed cost not found' }
    const allocation = cost.status === 'POSTED'
      ? cost.allocations.map(row => ({ ...row, name: row.pickingLine.name, sku: row.pickingLine.sku, pickingId: row.pickingLine.picking.id, pickingDisplayId: row.pickingLine.picking.displayId, poDisplayId: row.pickingLine.picking.purchaseOrder?.displayId ?? null }))
      : computeAllocation(cost.pickings, cost.lines)
    return {
      success: true as const,
      data: {
        id: cost.id, displayId: cost.displayId, status: cost.status, date: cost.date, supplier: cost.supplier, vendorRef: cost.vendorRef, creditTo: cost.creditTo, notes: cost.notes,
        postedAt: cost.postedAt, postedBy: cost.postedBy, createdBy: cost.createdBy,
        amountTotal: cost.lines.reduce((sum, line) => sum + line.amount, 0),
        lines: cost.lines,
        receipts: cost.pickings.map(picking => ({ id: picking.id, displayId: picking.displayId, po: picking.purchaseOrder?.displayId ?? null, supplier: picking.supplier?.name ?? null, doneAt: picking.doneAt })),
        allocation,
      },
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load the landed cost') }
  }
}

const saveSchema = z.object({
  id: z.number().int().positive().optional(),
  date: z.string().optional(),
  supplierId: z.number().int().positive().nullable().optional(),
  vendorRef: z.string().trim().max(100).nullable().optional(),
  creditTo: z.enum(CREDIT_TO).default('EXPENSE'),
  notes: z.string().trim().max(1000).nullable().optional(),
  pickingIds: z.array(z.number().int().positive()).max(50),
  lines: z.array(z.object({
    name: z.string().trim().min(1, 'Name every cost line').max(120),
    costType: z.enum(COST_TYPES).default('FREIGHT'),
    amount: z.number().int('Amounts are in whole rupees').positive('Cost amounts must be greater than 0').max(100_000_000),
    splitMethod: z.enum(SPLIT_METHODS).default('BY_QUANTITY'),
  })).max(30),
})

async function loadReceipts(tx: Tx, ids: number[]) {
  const pickings = await tx.stockPicking.findMany({ where: { id: { in: ids } }, include: pickingInclude })
  if (pickings.length !== new Set(ids).size) throw new Error('One of the receipts no longer exists')
  const invalid = pickings.find(picking => picking.pickingType !== 'RECEIPT' || picking.status !== 'DONE')
  if (invalid) throw new Error(`${invalid.displayId} is not a completed receipt`)
  return pickings
}

// Odoo keeps landed costs in draft until "Validate"; drafts can be edited freely.
export async function saveLandedCost(data: unknown) {
  try {
    const actor = await requireActor(...ROLES)
    const input = saveSchema.parse(data)
    const date = input.date ? new Date(`${input.date}T12:00:00`) : new Date()
    if (Number.isNaN(date.getTime())) throw new Error('Invalid date')
    const saved = await prisma.$transaction(async tx => {
      await loadReceipts(tx, input.pickingIds)
      const fields = {
        date, supplierId: input.supplierId ?? null, vendorRef: input.vendorRef || null, creditTo: input.creditTo, notes: input.notes || null,
        amountTotal: input.lines.reduce((sum, line) => sum + line.amount, 0),
      }
      if (input.id) {
        await tx.$queryRaw`SELECT id FROM "LandedCost" WHERE id = ${input.id} FOR UPDATE`
        const existing = await tx.landedCost.findUnique({ where: { id: input.id }, select: { status: true } })
        if (!existing) throw new Error('Landed cost not found')
        if (existing.status !== 'DRAFT') throw new Error('Only draft landed costs can be edited')
        await tx.landedCostLine.deleteMany({ where: { landedCostId: input.id } })
        return tx.landedCost.update({
          where: { id: input.id },
          data: { ...fields, pickings: { set: input.pickingIds.map(id => ({ id })) }, lines: { create: input.lines } },
        })
      }
      const created = await tx.landedCost.create({
        data: { ...fields, displayId: await nextSequence(tx, 'LandedCost'), createdBy: actor.name, pickings: { connect: input.pickingIds.map(id => ({ id })) }, lines: { create: input.lines } },
      })
      await logMessage(tx, 'LandedCost', created.id, 'Landed cost created', { author: actor })
      return created
    })
    refresh()
    return { success: true as const, data: { id: saved.id, displayId: saved.displayId } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not save the landed cost') }
  }
}

// "Validate": freeze the split, raise the average cost of what is still on
// hand and log it on every receipt. The journal is posted by auto-accounting.
export async function postLandedCost(id: number) {
  try {
    const actor = await requireActor(...ROLES)
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "LandedCost" WHERE id = ${id} FOR UPDATE`
      const cost = await tx.landedCost.findUnique({ where: { id }, include: { lines: true, pickings: { select: { id: true } } } })
      if (!cost) throw new Error('Landed cost not found')
      if (cost.status !== 'DRAFT') throw new Error('This landed cost is already validated or cancelled')
      if (cost.pickings.length === 0) throw new Error('Select at least one receipt')
      if (cost.lines.length === 0) throw new Error('Add at least one cost line')
      const amountTotal = cost.lines.reduce((sum, line) => sum + line.amount, 0)

      const firstPass = await loadReceipts(tx, cost.pickings.map(picking => picking.id))
      await lockInventoryProducts(tx, [...new Set(firstPass.flatMap(picking => picking.lines.map(line => line.productId)))])
      // Re-read after the product locks so stock and cost are current.
      const pickings = await loadReceipts(tx, cost.pickings.map(picking => picking.id))
      const rows = computeAllocation(pickings, cost.lines)
      if (rows.length === 0) throw new Error('The selected receipts have no quantity-tracked lines to carry the cost')
      if (rows.reduce((sum, row) => sum + row.additionalCost, 0) !== amountTotal) throw new Error('The cost could not be split over the receipt lines')

      const lineById = new Map(pickings.flatMap(picking => picking.lines.map(line => [line.id, { line, picking }] as const)))
      for (const productId of new Set(rows.map(row => row.productId))) {
        const row = rows.find(item => item.productId === productId)!
        if (row.costAfter !== row.costBefore) await tx.product.update({ where: { id: productId }, data: { costPrice: row.costAfter } })
      }
      for (const row of rows) {
        const { line, picking } = lineById.get(row.pickingLineId)!
        // Keep the PO batch's unit cost in step for batch-level valuation.
        if (line.purchaseOrderItemId && picking.purchaseOrder && row.additionalCost > 0) {
          const batchNumber = `PO-${picking.purchaseOrder.displayId}-${line.purchaseOrderItemId}`
          const batch = await tx.productBatch.findUnique({ where: { productId_batchNumber: { productId: line.productId, batchNumber } }, select: { id: true, costPrice: true } })
          if (batch) await tx.productBatch.update({ where: { id: batch.id }, data: { costPrice: Math.round((batch.costPrice || 0) + row.additionalCost / row.quantity) } })
        }
      }
      await tx.landedCostAllocation.createMany({
        data: rows.map(row => ({
          landedCostId: id, pickingLineId: row.pickingLineId, productId: row.productId, quantity: row.quantity, originalValue: row.originalValue,
          additionalCost: row.additionalCost, inStockQty: row.inStockQty, toStock: row.toStock, toCogs: row.toCogs, costBefore: row.costBefore, costAfter: row.costAfter,
        })),
      })
      const toStock = rows.reduce((sum, row) => sum + row.toStock, 0)
      await tx.landedCost.update({ where: { id }, data: { status: 'POSTED', postedAt: new Date(), postedBy: actor.name, amountTotal } })
      const summary = `₹${amountTotal.toLocaleString('en-IN')} landed: ₹${toStock.toLocaleString('en-IN')} added to stock value${amountTotal - toStock > 0 ? `, ₹${(amountTotal - toStock).toLocaleString('en-IN')} to cost of goods sold (already sold)` : ''}`
      await logMessage(tx, 'LandedCost', id, `Validated — ${summary}`, { author: actor })
      for (const picking of pickings) await logMessage(tx, 'StockPicking', picking.id, `Landed cost ${cost.displayId} applied`, { author: actor })
      return { amountTotal, toStock, toCogs: amountTotal - toStock }
    })
    refresh()
    return { success: true as const, data: result }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not validate the landed cost') }
  }
}

// Validated landed costs are final (Odoo has no reset); drafts can be cancelled.
export async function cancelLandedCost(id: number) {
  try {
    const actor = await requireActor(...ROLES)
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "LandedCost" WHERE id = ${id} FOR UPDATE`
      const cost = await tx.landedCost.findUnique({ where: { id }, select: { status: true } })
      if (!cost) throw new Error('Landed cost not found')
      if (cost.status !== 'DRAFT') throw new Error('A validated landed cost cannot be cancelled')
      await tx.landedCost.update({ where: { id }, data: { status: 'CANCELLED' } })
      await logMessage(tx, 'LandedCost', id, 'Cancelled', { author: actor })
    })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not cancel the landed cost') }
  }
}
