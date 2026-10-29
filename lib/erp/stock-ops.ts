import type { Prisma } from '@prisma/client'
import { adjustStock, lockInventoryProducts, resolveStockGodown } from '@/lib/inventory-stock'
import { nextSequence } from './sequence'
import { logMessage, type Author } from './chatter'
import { syncStoneLotTotals } from '@/lib/stone-inventory'

type Tx = Prisma.TransactionClient

export type PickingLineInput = { lineId: number; doneQty: number; batchId?: number | null; slabIds?: number[] }
export type ValidatePickingInput = {
  lines: PickingLineInput[]
  createBackorder: boolean
  vehicleNumber?: string
  driverName?: string
  driverPhone?: string
  notes?: string
}

// Weighted average cost (Odoo AVCO). Negative or empty stock never drags the
// average: the incoming layer then defines the cost.
export function averageCost(onHand: number, currentCost: number, incomingQty: number, incomingCost: number) {
  const base = Math.max(0, onHand)
  if (incomingQty <= 0) return currentCost
  if (base === 0 || currentCost <= 0) return Math.round(incomingCost)
  return Math.round((base * currentCost + incomingQty * incomingCost) / (base + incomingQty))
}

export function remainingAfter(demand: number, done: number) {
  return Math.max(0, demand - done)
}

async function lockPicking(tx: Tx, id: number) {
  await tx.$queryRaw`SELECT id FROM "StockPicking" WHERE id = ${id} FOR UPDATE`
  const picking = await tx.stockPicking.findUnique({
    where: { id },
    include: { lines: true, purchaseOrder: { select: { id: true, displayId: true, supplierId: true } }, salesOrder: { select: { id: true, displayId: true } } },
  })
  if (!picking) throw new Error('Transfer not found')
  return picking
}

// Delivery order for every not-yet-planned quantity on a sales order.
export async function createDeliveryForOrder(tx: Tx, orderId: number, author?: Author) {
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { lines: { include: { pickingLines: { include: { picking: { select: { status: true } } } } } } },
  })
  const lines = order.lines.flatMap(line => {
    const planned = line.pickingLines.reduce((sum, pl) => {
      if (pl.picking.status === 'READY') return sum + pl.demandQty
      if (pl.picking.status === 'DONE') return sum + pl.doneQty
      return sum
    }, 0)
    const open = line.quantity - planned
    return open > 0 ? [{ line, open }] : []
  })
  if (lines.length === 0) return null
  const displayId = await nextSequence(tx, 'Delivery')
  const picking = await tx.stockPicking.create({
    data: {
      displayId,
      pickingType: 'DELIVERY',
      godownId: order.godownId,
      salesOrderId: order.id,
      contactId: order.contactId,
      scheduledDate: order.commitmentDate || new Date(),
      deliveryAddress: order.dispatchAddress,
      lines: {
        create: lines.map(({ line, open }) => ({
          productId: line.productId, salesOrderLineId: line.id, name: line.name, sku: line.sku, demandQty: open,
        })),
      },
    },
  })
  await logMessage(tx, 'StockPicking', picking.id, `Delivery order created from ${order.displayId}`, { author })
  return picking
}

// Goods receipt (GRN) for every pending, non-serialized quantity on a PO.
export async function ensureReceiptForPurchaseOrder(tx: Tx, poId: number, author?: Author) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id: poId },
    include: { items: { include: { product: { select: { isSlabTracked: true } }, pickingLines: { include: { picking: { select: { status: true } } } } } } },
  })
  if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) return null
  const open = await tx.stockPicking.findFirst({ where: { purchaseOrderId: poId, pickingType: 'RECEIPT', status: 'READY' } })
  if (open) return open
  const pending = po.items.flatMap(item => {
    if (item.product.isSlabTracked) return []
    const qty = item.quantity - item.receivedQty
    return qty > 0 ? [{ item, qty }] : []
  })
  if (pending.length === 0) return null
  // Stock is valued net of the PO discount, the same amount the supplier bill carries.
  const discountFactor = po.subtotal > 0 ? Math.max(0, po.subtotal - po.discount) / po.subtotal : 1
  // The PO delivery location (a deleted one falls back to the default).
  const godown = await resolveStockGodown(tx, po.godownId ?? undefined)
  const displayId = await nextSequence(tx, 'Receipt')
  const picking = await tx.stockPicking.create({
    data: {
      displayId,
      pickingType: 'RECEIPT',
      godownId: godown.id,
      purchaseOrderId: po.id,
      supplierId: po.supplierId,
      scheduledDate: po.expectedDate || new Date(),
      lines: {
        create: pending.map(({ item, qty }) => ({
          productId: item.productId, purchaseOrderItemId: item.id, name: item.name, sku: item.sku, demandQty: qty, unitCost: Math.round(item.unitCost * discountFactor),
        })),
      },
    },
  })
  await logMessage(tx, 'StockPicking', picking.id, `Goods receipt created from ${po.displayId}`, { author })
  return picking
}

type PickingForSlabs = { id: number; displayId: string; godownId: number; salesOrderId: number | null }
type LineForSlabs = { id: number; productId: number; name: string; salesOrderLineId: number | null }

// Claims each slab (available, or reserved for this order), marks it sold at
// the order rate and adds its measured area to the order line.
async function deliverSlabs(tx: Tx, picking: PickingForSlabs, line: LineForSlabs, slabIds: number[]) {
  const soLine = line.salesOrderLineId ? await tx.salesOrderLine.findUnique({ where: { id: line.salesOrderLineId }, select: { price: true } }) : null
  const slabs = await tx.slab.findMany({ where: { id: { in: slabIds } }, select: { id: true, slabNumber: true, sqft: true, lotId: true, godownId: true, lot: { select: { productId: true } } } })
  if (slabs.length !== slabIds.length) throw new Error('A selected slab no longer exists')
  const now = new Date()
  let sqft = 0
  for (const slab of slabs) {
    if (slab.lot.productId !== line.productId) throw new Error(`Slab ${slab.slabNumber} does not belong to ${line.name}`)
    if (slab.godownId && slab.godownId !== picking.godownId) throw new Error(`Slab ${slab.slabNumber} is stored in another location`)
    const claimed = await tx.slab.updateMany({
      where: {
        id: slab.id,
        OR: [{ status: 'AVAILABLE' }, ...(picking.salesOrderId ? [{ status: 'RESERVED', reservedForOrderId: picking.salesOrderId, reservedForCustomId: null }] : [])],
      },
      data: { status: 'SOLD', soldAt: now, soldPrice: soLine ? Math.round(slab.sqft * soLine.price) : null, reservedForOrderId: null },
    })
    if (claimed.count !== 1) throw new Error(`Slab ${slab.slabNumber} is no longer available`)
    sqft += slab.sqft
  }
  for (const lotId of new Set(slabs.map(slab => slab.lotId))) await syncStoneLotTotals(tx, lotId)
  await tx.stockPickingLine.update({ where: { id: line.id }, data: { doneQty: slabIds.length, slabIds } })
  if (line.salesOrderLineId) {
    await tx.salesOrderLine.update({ where: { id: line.salesOrderLineId }, data: { qtyDelivered: { increment: slabIds.length }, deliveredSqft: { increment: Math.round(sqft * 100) / 100 } } })
  }
}

// Releases every slab held for a sales order (order cancelled or locked).
export async function releaseOrderSlabs(tx: Tx, orderId: number) {
  const held = await tx.slab.findMany({ where: { status: 'RESERVED', reservedForOrderId: orderId }, select: { id: true, lotId: true } })
  if (held.length === 0) return 0
  await tx.slab.updateMany({ where: { id: { in: held.map(slab => slab.id) } }, data: { status: 'AVAILABLE', reservedForOrderId: null } })
  for (const lotId of new Set(held.map(slab => slab.lotId))) await syncStoneLotTotals(tx, lotId)
  return held.length
}

export async function validatePickingTx(tx: Tx, pickingId: number, input: ValidatePickingInput, author: Author) {
  const picking = await lockPicking(tx, pickingId)
  if (picking.status !== 'READY') throw new Error(`${picking.displayId} is already ${picking.status.toLowerCase()}`)

  const requested = new Map(input.lines.map(line => [line.lineId, line]))
  for (const lineId of requested.keys()) {
    if (!picking.lines.some(line => line.id === lineId)) throw new Error('A transfer line does not belong to this document')
  }
  const done = picking.lines.map(line => {
    const value = requested.get(line.id)
    // Serial-tracked stone: the selected slabs are the done quantity.
    const slabIds = value?.slabIds || [] // duplicates are rejected below, never silently merged
    const qty = slabIds.length > 0 ? slabIds.length : Number(value?.doneQty ?? 0)
    if (!Number.isInteger(qty) || qty < 0) throw new Error(`Done quantity for ${line.name} must be a whole number`)
    if (qty > line.demandQty) throw new Error(`${line.name}: done quantity (${qty}) exceeds the demand (${line.demandQty})`)
    return { line, qty, batchId: value?.batchId ?? line.batchId ?? null, slabIds }
  })
  const allSlabs = done.flatMap(row => row.slabIds)
  if (new Set(allSlabs).size !== allSlabs.length) throw new Error('A slab can only be delivered once')
  if (done.every(row => row.qty === 0)) throw new Error('Enter the quantity actually delivered/received for at least one line')

  await lockInventoryProducts(tx, done.map(row => row.line.productId))
  const products = await tx.product.findMany({
    where: { id: { in: done.map(row => row.line.productId) } },
    select: { id: true, name: true, isSlabTracked: true, stock: true, costPrice: true },
  })
  const productById = new Map(products.map(product => [product.id, product]))
  const settings = await tx.storeSettings.findFirst({ where: { id: 1 }, select: { costingMethod: true } })
  const costing = settings?.costingMethod === 'LAST' ? 'LAST' : 'AVCO'
  const ref = picking.pickingType === 'DELIVERY'
    ? { referenceType: 'Delivery', referenceId: picking.id }
    : { referenceType: 'PurchaseOrder', referenceId: picking.purchaseOrderId ?? picking.id }

  for (const { line, qty, batchId, slabIds } of done) {
    if (qty === 0) continue
    const product = productById.get(line.productId)
    if (!product) throw new Error(`${line.name} no longer exists`)
    if (product.isSlabTracked) {
      if (picking.pickingType !== 'DELIVERY') throw new Error(`${line.name} is slab-tracked. Receive it from Inventory → Lot / Slab Explorer with lot and slab measurements.`)
      if (slabIds.length !== qty) throw new Error(`Select the ${qty} physical slab(s) loaded for ${line.name}`)
      await deliverSlabs(tx, picking, line, slabIds)
      continue
    }
    if (slabIds.length > 0) throw new Error(`${line.name} is not slab-tracked`)

    if (picking.pickingType === 'DELIVERY') {
      await adjustStock(tx, line.productId, picking.godownId, -qty, 'SALE', { ...ref, notes: `Delivered via ${picking.displayId}`, createdBy: author.name || undefined })
      await tx.product.update({ where: { id: line.productId }, data: { sold: { increment: qty } } })
      if (batchId) {
        const claimed = await tx.productBatch.updateMany({ where: { id: batchId, productId: line.productId, remainingQty: { gte: qty } }, data: { remainingQty: { decrement: qty } } })
        if (claimed.count !== 1) throw new Error(`Not enough quantity left in the selected batch/shade for ${line.name}`)
      }
      if (line.salesOrderLineId) await tx.salesOrderLine.update({ where: { id: line.salesOrderLineId }, data: { qtyDelivered: { increment: qty } } })
    } else {
      const unitCost = line.unitCost ?? product.costPrice
      const nextCost = costing === 'LAST' ? unitCost : averageCost(product.stock, product.costPrice, qty, unitCost)
      await adjustStock(tx, line.productId, picking.godownId, qty, 'IN', { ...ref, notes: `Received via ${picking.displayId}`, createdBy: author.name || undefined, unitCost })
      await tx.product.update({ where: { id: line.productId }, data: { costPrice: nextCost } })
      // The same product can appear on two receipt lines: the next line must
      // average against this line's result, not the pre-receipt figures.
      product.stock += qty
      product.costPrice = nextCost
      if (line.purchaseOrderItemId && picking.purchaseOrder) {
        await tx.purchaseOrderItem.update({ where: { id: line.purchaseOrderItemId }, data: { receivedQty: { increment: qty } } })
        const batchNumber = `PO-${picking.purchaseOrder.displayId}-${line.purchaseOrderItemId}`
        await tx.productBatch.upsert({
          where: { productId_batchNumber: { productId: line.productId, batchNumber } },
          create: { productId: line.productId, batchNumber, quantity: qty, remainingQty: qty, costPrice: unitCost, supplierId: picking.purchaseOrder.supplierId, poId: picking.purchaseOrder.id },
          update: { quantity: { increment: qty }, remainingQty: { increment: qty }, costPrice: unitCost },
        })
      }
    }
    await tx.stockPickingLine.update({ where: { id: line.id }, data: { doneQty: qty, batchId } })
  }

  // Batch-assigned stock may only leave through its batch/shade.
  if (picking.pickingType === 'DELIVERY') {
    for (const productId of new Set(done.filter(row => row.qty > 0).map(row => row.line.productId))) {
      const [product, batches] = await Promise.all([
        tx.product.findUnique({ where: { id: productId }, select: { stock: true, name: true } }),
        tx.productBatch.aggregate({ where: { productId }, _sum: { remainingQty: true } }),
      ])
      if ((batches._sum.remainingQty || 0) > (product?.stock || 0)) throw new Error(`Select the batch/shade for ${product?.name || 'this product'}; the quantity exceeds unassigned stock`)
    }
  }

  await tx.stockPicking.update({
    where: { id: picking.id },
    data: {
      status: 'DONE', doneAt: new Date(), doneBy: author.name || null,
      vehicleNumber: input.vehicleNumber?.trim() || picking.vehicleNumber,
      driverName: input.driverName?.trim() || picking.driverName,
      driverPhone: input.driverPhone?.trim() || picking.driverPhone,
      notes: input.notes?.trim() || picking.notes,
    },
  })

  const remaining = done.flatMap(({ line, qty }) => {
    const left = remainingAfter(line.demandQty, qty)
    return left > 0 ? [{ line, left }] : []
  })
  let backorder: { id: number; displayId: string } | null = null
  if (remaining.length > 0 && input.createBackorder) {
    const displayId = await nextSequence(tx, picking.pickingType === 'DELIVERY' ? 'Delivery' : 'Receipt')
    backorder = await tx.stockPicking.create({
      data: {
        displayId,
        pickingType: picking.pickingType,
        godownId: picking.godownId,
        salesOrderId: picking.salesOrderId,
        purchaseOrderId: picking.purchaseOrderId,
        contactId: picking.contactId,
        supplierId: picking.supplierId,
        backorderOfId: picking.id,
        deliveryAddress: picking.deliveryAddress,
        scheduledDate: picking.scheduledDate,
        lines: {
          create: remaining.map(({ line, left }) => ({
            productId: line.productId, salesOrderLineId: line.salesOrderLineId, purchaseOrderItemId: line.purchaseOrderItemId,
            batchId: line.batchId, name: line.name, sku: line.sku, demandQty: left, unitCost: line.unitCost,
          })),
        },
      },
      select: { id: true, displayId: true },
    })
    await logMessage(tx, 'StockPicking', backorder.id, `Backorder of ${picking.displayId}`, { author })
  }

  const summary = done.filter(row => row.qty > 0).map(row => `${row.line.name} × ${row.qty}`).join(', ')
  await logMessage(tx, 'StockPicking', picking.id, `Validated: ${summary}${backorder ? `. Backorder ${backorder.displayId} created.` : remaining.length ? '. Remaining quantity cancelled (no backorder).' : ''}`, { author })

  if (picking.purchaseOrder) {
    const items = await tx.purchaseOrderItem.findMany({
      where: { poId: picking.purchaseOrder.id },
      select: { quantity: true, receivedQty: true, product: { select: { isSlabTracked: true } } },
    })
    const complete = items.every(item => item.receivedQty >= item.quantity)
    // "No backorder" closes the remaining quantity short, as in Odoo, unless
    // serialized stone on the same PO is still waiting for its lot receipt.
    const openReceipts = await tx.stockPicking.count({ where: { purchaseOrderId: picking.purchaseOrder.id, pickingType: 'RECEIPT', status: 'READY' } })
    const slabPending = items.some(item => item.product.isSlabTracked && item.receivedQty < item.quantity)
    const closed = complete || (remaining.length > 0 && !input.createBackorder && openReceipts === 0 && !slabPending)
    await tx.purchaseOrder.update({
      where: { id: picking.purchaseOrder.id },
      data: { status: closed ? 'RECEIVED' : 'PARTIALLY_RECEIVED', ...(closed ? { receivedAt: new Date() } : {}) },
    })
    await logMessage(tx, 'PurchaseOrder', picking.purchaseOrder.id, `${picking.displayId} validated: ${summary}${closed && !complete ? ' — order closed short' : ''}`, { author })
  }
  if (picking.salesOrder) {
    await logMessage(tx, 'SalesOrder', picking.salesOrder.id, `${picking.displayId} delivered: ${summary}${backorder ? ` (backorder ${backorder.displayId})` : ''}`, { author })
  }
  return { pickingId: picking.id, backorder }
}

export async function cancelPickingTx(tx: Tx, pickingId: number, author: Author) {
  const picking = await lockPicking(tx, pickingId)
  if (picking.status !== 'READY') throw new Error(`Only transfers that are ready can be cancelled (${picking.displayId} is ${picking.status.toLowerCase()})`)
  await tx.stockPicking.update({ where: { id: picking.id }, data: { status: 'CANCELLED' } })
  await logMessage(tx, 'StockPicking', picking.id, 'Transfer cancelled', { author })
  return picking
}

export type ReturnLineInput = { lineId: number; quantity: number; slabIds?: number[] }

// Odoo "Return" on a validated delivery: goods come back into the same
// location, the order's delivered quantity drops, and stone slabs go back on
// sale. Already-returned quantities can never be returned twice.
export async function returnDeliveryTx(tx: Tx, deliveryId: number, input: { lines: ReturnLineInput[]; reason?: string }, author: Author) {
  await tx.$queryRaw`SELECT id FROM "StockPicking" WHERE id = ${deliveryId} FOR UPDATE`
  const delivery = await tx.stockPicking.findUnique({
    where: { id: deliveryId },
    include: { lines: { include: { product: { select: { isSlabTracked: true } } } }, salesOrder: { select: { id: true, displayId: true } } },
  })
  if (!delivery || delivery.pickingType !== 'DELIVERY') throw new Error('Only delivery orders can be returned')
  if (delivery.status !== 'DONE') throw new Error('Validate the delivery before returning goods from it')
  const previous = await tx.stockPickingLine.findMany({
    where: { returnOfLineId: { in: delivery.lines.map(line => line.id) }, picking: { status: 'DONE' } },
    select: { returnOfLineId: true, doneQty: true, slabIds: true },
  })
  const rows = input.lines.filter(row => row.quantity > 0 || (row.slabIds?.length ?? 0) > 0).map(row => {
    const line = delivery.lines.find(item => item.id === row.lineId)
    if (!line) throw new Error('A return line does not belong to this delivery')
    const already = previous.filter(item => item.returnOfLineId === line.id)
    const returnedQty = already.reduce((sum, item) => sum + item.doneQty, 0)
    if (line.product.isSlabTracked) {
      const slabIds = row.slabIds || []
      const returnedSlabs = new Set(already.flatMap(item => item.slabIds))
      if (new Set(slabIds).size !== slabIds.length) throw new Error('A slab can only be returned once')
      if (slabIds.some(id => !line.slabIds.includes(id) || returnedSlabs.has(id))) throw new Error(`Only slabs delivered on ${delivery.displayId} and not yet returned can come back`)
      return { line, qty: slabIds.length, slabIds }
    }
    const qty = row.quantity
    if (!Number.isInteger(qty) || qty < 0) throw new Error('Return quantities must be whole numbers')
    if (qty > line.doneQty - returnedQty) throw new Error(`${line.name}: only ${line.doneQty - returnedQty} can still be returned`)
    return { line, qty, slabIds: [] as number[] }
  }).filter(row => row.qty > 0)
  if (rows.length === 0) throw new Error('Enter the quantity coming back for at least one line')

  await lockInventoryProducts(tx, rows.map(row => row.line.productId))
  const picking = await tx.stockPicking.create({
    data: {
      displayId: await nextSequence(tx, 'Return'),
      pickingType: 'RETURN', status: 'DONE', godownId: delivery.godownId,
      salesOrderId: delivery.salesOrderId, contactId: delivery.contactId, returnOfId: delivery.id,
      doneAt: new Date(), doneBy: author.name || null, notes: input.reason?.trim() || null,
      lines: { create: rows.map(row => ({ productId: row.line.productId, salesOrderLineId: row.line.salesOrderLineId, batchId: row.line.batchId, returnOfLineId: row.line.id, name: row.line.name, sku: row.line.sku, demandQty: row.qty, doneQty: row.qty, slabIds: row.slabIds })) },
    },
  })
  for (const row of rows) {
    let sqft = 0
    if (row.slabIds.length > 0) {
      const slabs = await tx.slab.findMany({ where: { id: { in: row.slabIds } }, select: { id: true, sqft: true, lotId: true } })
      const restored = await tx.slab.updateMany({ where: { id: { in: row.slabIds }, status: 'SOLD' }, data: { status: 'AVAILABLE', soldAt: null, soldPrice: null, godownId: delivery.godownId } })
      if (restored.count !== row.slabIds.length) throw new Error('A returned slab is no longer marked sold')
      for (const lotId of new Set(slabs.map(slab => slab.lotId))) await syncStoneLotTotals(tx, lotId)
      sqft = slabs.reduce((sum, slab) => sum + slab.sqft, 0)
    } else {
      await adjustStock(tx, row.line.productId, delivery.godownId, row.qty, 'RETURN', { referenceType: 'Return', referenceId: picking.id, notes: `Customer return ${picking.displayId}`, createdBy: author.name || undefined })
      await tx.product.update({ where: { id: row.line.productId }, data: { sold: { decrement: row.qty } } })
      if (row.line.batchId) await tx.productBatch.update({ where: { id: row.line.batchId }, data: { remainingQty: { increment: row.qty } } })
    }
    if (row.line.salesOrderLineId) {
      await tx.salesOrderLine.update({ where: { id: row.line.salesOrderLineId }, data: { qtyDelivered: { decrement: row.qty }, deliveredSqft: { decrement: Math.round(sqft * 100) / 100 } } })
    }
  }
  const summary = rows.map(row => `${row.line.name} × ${row.qty}`).join(', ')
  await logMessage(tx, 'StockPicking', picking.id, `Returned from ${delivery.displayId}: ${summary}${input.reason ? ` — ${input.reason}` : ''}`, { author })
  await logMessage(tx, 'StockPicking', delivery.id, `Return ${picking.displayId}: ${summary}`, { author })
  if (delivery.salesOrder) await logMessage(tx, 'SalesOrder', delivery.salesOrder.id, `Customer return ${picking.displayId}: ${summary}`, { author })
  return picking
}
