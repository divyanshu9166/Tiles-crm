import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { openProductionDemand } from './mrp'

type Db = Prisma.TransactionClient | typeof prisma

export type ForecastRow = {
  onHand: number
  reserved: number // committed to ready delivery orders and open production orders
  manufacturing: number // part of reserved: components of open production orders
  incoming: number // open PO quantity not yet received
  free: number // on hand − reserved
  forecast: number // on hand − reserved + incoming
}

// Odoo's forecasted quantity: on hand, minus confirmed outgoing demand, plus
// confirmed incoming supply. Incoming PO stock is not location-bound until a
// receipt is created, so a location filter only narrows on-hand and outgoing.
export async function computeForecast(db: Db, options: { productIds?: number[]; godownId?: number } = {}) {
  const productFilter = options.productIds ? { productId: { in: options.productIds } } : {}
  const [stocks, outgoing, receiptLines, poItems] = await Promise.all([
    options.godownId
      ? db.godownStock.findMany({ where: { godownId: options.godownId, ...productFilter }, select: { productId: true, quantity: true } })
      : db.product.findMany({ where: options.productIds ? { id: { in: options.productIds } } : {}, select: { id: true, stock: true } })
        .then(rows => rows.map(row => ({ productId: row.id, quantity: row.stock }))),
    db.stockPickingLine.findMany({
      where: { ...productFilter, picking: { pickingType: 'DELIVERY', status: 'READY', ...(options.godownId ? { godownId: options.godownId } : {}) } },
      select: { productId: true, demandQty: true },
    }),
    db.stockPickingLine.findMany({
      where: { ...productFilter, picking: { pickingType: 'RECEIPT', status: 'READY', ...(options.godownId ? { godownId: options.godownId } : {}) } },
      select: { productId: true, demandQty: true, purchaseOrderItemId: true },
    }),
    db.purchaseOrderItem.findMany({
      where: { ...productFilter, po: { status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] } } },
      select: { id: true, productId: true, quantity: true, receivedQty: true },
    }),
  ])

  const rows = new Map<number, ForecastRow>()
  const row = (productId: number) => {
    let current = rows.get(productId)
    if (!current) {
      current = { onHand: 0, reserved: 0, manufacturing: 0, incoming: 0, free: 0, forecast: 0 }
      rows.set(productId, current)
    }
    return current
  }
  for (const stock of stocks) row(stock.productId).onHand += stock.quantity
  // Serial-tracked stone has no quantity balance: on hand is its available slabs.
  const slabProducts = await db.product.findMany({ where: { isSlabTracked: true, ...(options.productIds ? { id: { in: options.productIds } } : {}) }, select: { id: true } })
  if (slabProducts.length > 0) {
    const slabs = await db.slab.groupBy({
      by: ['lotId'],
      // Slabs held for a sales order stay "on hand"; that order's delivery demand reserves them.
      where: {
        lot: { productId: { in: slabProducts.map(product => product.id) } },
        AND: [
          { OR: [{ status: 'AVAILABLE' }, { status: 'RESERVED', reservedForOrderId: { not: null } }] },
          ...(options.godownId ? [{ OR: [{ godownId: options.godownId }, { godownId: null }] }] : []),
        ],
      },
      _count: { _all: true },
    })
    const lots = await db.stoneLot.findMany({ where: { id: { in: slabs.map(slab => slab.lotId) } }, select: { id: true, productId: true } })
    const productOfLot = new Map(lots.map(lot => [lot.id, lot.productId]))
    for (const product of slabProducts) row(product.id).onHand = 0
    for (const slab of slabs) {
      const productId = productOfLot.get(slab.lotId)
      if (productId) row(productId).onHand += slab._count._all
    }
  }
  for (const line of outgoing) row(line.productId).reserved += line.demandQty
  const planned = new Set<number>()
  for (const line of receiptLines) {
    row(line.productId).incoming += line.demandQty
    if (line.purchaseOrderItemId) planned.add(line.purchaseOrderItemId)
  }
  if (!options.godownId) {
    for (const item of poItems) {
      if (planned.has(item.id)) continue
      const pending = item.quantity - item.receivedQty
      if (pending > 0) row(item.productId).incoming += pending
    }
    // Open production orders reserve components and promise finished goods.
    // They are not location-bound, so (like PO supply) only the company-wide
    // forecast includes them.
    const production = await openProductionDemand(db, options.productIds)
    for (const [productId, qty] of production.demand) {
      row(productId).reserved += qty
      row(productId).manufacturing += qty
    }
    for (const [productId, qty] of production.incoming) row(productId).incoming += qty
  }
  for (const value of rows.values()) {
    value.free = round(value.onHand - value.reserved)
    value.forecast = round(value.onHand - value.reserved + value.incoming)
  }
  return rows
}

function round(value: number) {
  return Math.round(value * 1e6) / 1e6
}

// Quantity a min/max reordering rule asks for: bring the forecast back up to
// the maximum, rounded up to the purchase multiple.
export function suggestedOrderQty(forecast: number, minQty: number, maxQty: number, multiple = 1) {
  if (forecast >= minQty) return 0
  const target = Math.max(maxQty, minQty)
  const needed = target - forecast
  if (needed <= 0) return 0
  const step = multiple > 0 ? multiple : 1
  return Math.ceil(round(needed / step)) * step
}
