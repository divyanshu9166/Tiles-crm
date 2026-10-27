// Odoo landed costs (stock.landed.cost): extra costs of bringing goods in —
// freight, customs duty, unloading — are split over the received lines and
// added to their valuation instead of being expensed.

export const SPLIT_METHODS = ['BY_QUANTITY', 'BY_VALUE', 'EQUAL'] as const
export type SplitMethod = typeof SPLIT_METHODS[number]

export type AllocationLine = { id: number; quantity: number; value: number }
export type CostLine = { amount: number; splitMethod: SplitMethod }

// Whole rupees, largest-remainder rounding: the shares always add up to the
// cost exactly. Falls back to an equal split when every weight is zero.
export function splitAmount(amount: number, weights: number[]) {
  if (weights.length === 0 || amount === 0) return weights.map(() => 0)
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0)
  const shares = total > 0 ? weights.map(weight => (amount * Math.max(0, weight)) / total) : weights.map(() => amount / weights.length)
  const floors = shares.map(Math.floor)
  let left = amount - floors.reduce((sum, value) => sum + value, 0)
  const order = shares.map((share, index) => ({ index, rest: share - floors[index] })).sort((a, b) => b.rest - a.rest || a.index - b.index)
  for (const { index } of order) {
    if (left <= 0) break
    floors[index] += 1
    left -= 1
  }
  return floors
}

export function allocateLandedCost(lines: AllocationLine[], costs: CostLine[]) {
  const result = new Map(lines.map(line => [line.id, 0]))
  for (const cost of costs) {
    const weights = lines.map(line => cost.splitMethod === 'BY_QUANTITY' ? line.quantity : cost.splitMethod === 'BY_VALUE' ? line.value : 1)
    splitAmount(cost.amount, weights).forEach((share, index) => result.set(lines[index].id, (result.get(lines[index].id) || 0) + share))
  }
  return result
}

// Average costing has no per-receipt layers, so the part of a receipt that is
// still on hand is capped by current stock. That part raises the average cost;
// the rest belongs to goods already sold and goes to cost of goods sold.
export function splitStockAndCogs(additional: number, receivedQty: number, onHand: number) {
  if (receivedQty <= 0) return { inStockQty: 0, toStock: 0, toCogs: additional }
  const inStockQty = Math.max(0, Math.min(receivedQty, onHand))
  const toStock = Math.round((additional * inStockQty) / receivedQty)
  return { inStockQty, toStock, toCogs: additional - toStock }
}

export function costAfterLanding(onHand: number, currentCost: number, toStock: number) {
  if (onHand <= 0 || toStock === 0) return currentCost
  return Math.round((onHand * currentCost + toStock) / onHand)
}
