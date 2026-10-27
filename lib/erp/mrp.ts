import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'

type Db = Prisma.TransactionClient | typeof prisma

export const OPEN_PRODUCTION = ['PLANNED', 'IN_PROGRESS', 'ON_HOLD']

// Quantity of one component a production order still needs (BOM qty per unit
// × planned units, plus wastage). Materials are only issued at completion, so
// an open order needs its full requirement.
export function componentRequirement(bomQty: number, plannedQty: number, wastagePercent: number) {
  return Math.round(bomQty * plannedQty * (1 + (wastagePercent || 0) / 100) * 100) / 100
}

// Odoo MRP: open manufacturing orders reserve their components and promise
// their finished goods. Fabrication jobs (customOrderId) deliver into the
// customer's job, not into sellable stock, so they add no incoming quantity.
export async function openProductionDemand(db: Db, productIds?: number[]) {
  const orders = await db.productionOrder.findMany({
    where: { status: { in: OPEN_PRODUCTION } },
    select: {
      id: true, displayId: true, plannedQty: true, finishedProductId: true, customOrderId: true,
      bom: { select: { items: { select: { rawMaterialId: true, quantity: true, wastagePercent: true } } } },
    },
  })
  const demand = new Map<number, number>()
  const incoming = new Map<number, number>()
  const sources = new Map<number, string[]>()
  const wanted = productIds ? new Set(productIds) : null
  for (const order of orders) {
    for (const item of order.bom.items) {
      if (wanted && !wanted.has(item.rawMaterialId)) continue
      demand.set(item.rawMaterialId, (demand.get(item.rawMaterialId) || 0) + componentRequirement(item.quantity, order.plannedQty, item.wastagePercent))
      sources.set(item.rawMaterialId, [...(sources.get(item.rawMaterialId) || []), order.displayId])
    }
    if (!order.customOrderId && (!wanted || wanted.has(order.finishedProductId))) {
      incoming.set(order.finishedProductId, (incoming.get(order.finishedProductId) || 0) + order.plannedQty)
    }
  }
  return { demand, incoming, sources }
}
