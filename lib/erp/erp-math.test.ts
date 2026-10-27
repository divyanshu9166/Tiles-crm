import { describe, expect, it } from 'vitest'
import { boxesForArea, computeTaxes, deliveryStatus, invoiceStatus, invoiceableQty, lineAmount, orderDiscount, portionOf } from './sales-math'
import { suggestedOrderQty } from './forecast'
import { averageCost, remainingAfter } from './stock-ops'
import { formatSequence } from './sequence'
import { activityState, diffTracked } from './chatter'
import { billMatchStatus, billTotals, matchLine, poBillingStatus } from './bill-match'
import { balanced, expenseAccount, invoiceEntry, normalizeLines, reverse, stockAccounts } from './accounting'
import { matchingRule, rulePrice } from './pricing'
import { planAssignment, targetProgress } from './sales-team'
import { daysOverdue, levelFor, needsAction } from './followups'
import { allocateLandedCost, costAfterLanding, splitAmount, splitStockAndCogs } from './landed-cost'

describe('sales math', () => {
  it('prices units like POS invoices', () => {
    expect(lineAmount({ quantity: 10, price: 450, unitOfMeasure: 'BOX' })).toBe(4500)
    expect(lineAmount({ quantity: 12, price: 80, unitOfMeasure: 'SQFT', areaSqft: 150.5 })).toBe(12040)
    expect(lineAmount({ quantity: 3, price: 100, unitOfMeasure: 'PCS' })).toBe(300)
  })
  it('rounds boxes up to cover an area', () => {
    expect(boxesForArea(100, 15.5)).toBe(7)
    expect(boxesForArea(31, 15.5)).toBe(2)
    expect(boxesForArea(0, 15.5)).toBe(0)
  })
  it('prorates measured area for partial lines', () => {
    expect(portionOf({ quantity: 10, price: 50, unitOfMeasure: 'SQFT', areaSqft: 155 }, 4).areaSqft).toBe(62)
  })
  it('caps discounts and splits GST by place of supply', () => {
    expect(orderDiscount(1000, 'percent', 150)).toBe(1000)
    expect(orderDiscount(1000, 'flat', 2500)).toBe(1000)
    const intra = computeTaxes([{ amount: 1000, gstRate: 18 }, { amount: 500, gstRate: 5 }], 150, 'INTRASTATE')
    expect(intra.discount).toBe(150)
    expect(intra.taxable).toBe(1350)
    expect(intra.cgst + intra.sgst).toBe(intra.gst)
    expect(intra.igst).toBe(0)
    const inter = computeTaxes([{ amount: 1000, gstRate: 18 }], 0, 'INTERSTATE')
    expect(inter.igst).toBe(180)
    expect(inter.cgst).toBe(0)
  })
  it('derives Odoo delivery and invoice states', () => {
    const lines = [{ quantity: 10, qtyDelivered: 4, qtyInvoiced: 0 }]
    expect(deliveryStatus(lines)).toBe('PARTIAL')
    expect(invoiceableQty(lines[0], 'DELIVERED')).toBe(4)
    expect(invoiceableQty(lines[0], 'ORDERED')).toBe(10)
    expect(invoiceStatus(lines, 'DELIVERED')).toBe('TO_INVOICE')
    expect(invoiceStatus([{ quantity: 10, qtyDelivered: 10, qtyInvoiced: 10 }], 'DELIVERED')).toBe('INVOICED')
    expect(invoiceStatus([{ quantity: 10, qtyDelivered: 0, qtyInvoiced: 0 }], 'DELIVERED')).toBe('NOTHING')
  })
})

describe('inventory math', () => {
  it('orders up to max in purchase multiples', () => {
    expect(suggestedOrderQty(3, 5, 20, 1)).toBe(17)
    expect(suggestedOrderQty(3, 5, 20, 10)).toBe(20)
    expect(suggestedOrderQty(5, 5, 20, 1)).toBe(0)
    expect(suggestedOrderQty(-4, 0, 0, 1)).toBe(4)
  })
  it('keeps a weighted average cost', () => {
    expect(averageCost(10, 100, 10, 200)).toBe(150)
    expect(averageCost(0, 100, 5, 80)).toBe(80)
    expect(averageCost(-3, 100, 5, 80)).toBe(80)
    expect(remainingAfter(10, 4)).toBe(6)
  })
  it('formats sequences', () => {
    expect(formatSequence('SO-', 41, 4)).toBe('SO-0042')
    expect(formatSequence('GRN-', null, 4)).toBe('GRN-0001')
  })
})

describe('chatter helpers', () => {
  it('tracks only changed fields', () => {
    expect(diffTracked({ status: 'A', note: '' }, { status: 'B', note: undefined }, { status: 'Status', note: 'Note' })).toEqual([{ field: 'Status', from: 'A', to: 'B' }])
  })
  it('classifies activity due dates', () => {
    const now = new Date(2026, 9, 25, 15)
    expect(activityState(new Date(2026, 9, 24, 23), now)).toBe('overdue')
    expect(activityState(new Date(2026, 9, 25, 9), now)).toBe('today')
    expect(activityState(new Date(2026, 9, 26, 0, 1), now)).toBe('planned')
  })
})

describe('vendor bill matching', () => {
  const po = { quantity: 10, receivedQty: 6, billedQty: 2, unitCost: 100 }
  it('allows billing only received, unbilled quantity at the PO price', () => {
    expect(matchLine({ quantity: 4, unitCost: 100, poItem: po })).toMatchObject({ qtyOk: true, priceOk: true, billable: 4 })
    expect(matchLine({ quantity: 5, unitCost: 100, poItem: po }).qtyOk).toBe(false)
    expect(matchLine({ quantity: 4, unitCost: 110, poItem: po })).toMatchObject({ priceOk: false, priceVariance: 40 })
    expect(billMatchStatus([{ quantity: 4, unitCost: 100, poItem: po }])).toBe('MATCHED')
    expect(billMatchStatus([{ quantity: 4, unitCost: 90, poItem: po }])).toBe('TO_CHECK')
  })
  it('derives PO billing status and bill GST', () => {
    expect(poBillingStatus([po])).toBe('TO_BILL')
    expect(poBillingStatus([{ ...po, receivedQty: 10, billedQty: 10 }])).toBe('BILLED')
    expect(poBillingStatus([{ ...po, receivedQty: 0, billedQty: 0 }])).toBe('NOTHING')
    expect(billTotals([{ quantity: 2, unitCost: 500, gstRate: 18 }], 'INTERSTATE')).toEqual({ subtotal: 1000, gst: 180, cgst: 0, sgst: 0, igst: 180, total: 1180 })
  })
})

describe('auto-posting rules', () => {
  it('posts a balanced invoice entry with charges as other income', () => {
    const entry = invoiceEntry({ id: 1, displayId: 'INV-1', date: new Date(), total: 1680, gst: 180, transportCost: 0, freightCharge: 300, loadingCharge: 200, installationCharge: 0 })
    expect(balanced(normalizeLines(entry.lines))).toBe(true)
    expect(entry.lines.find(line => line.code === '4001')?.credit).toBe(1000)
    expect(entry.lines.find(line => line.code === '4100')?.credit).toBe(500)
    const reversal = reverse(entry, 'INVREV:1', new Date(), 'x')
    expect(reversal.reverses).toBe('INV:1')
    expect(reversal.lines[0].credit).toBe(1680)
  })
  it('maps stock moves to inventory counter-accounts', () => {
    expect(stockAccounts('SALE', 'Delivery', -5)).toEqual(['5001', '1200'])
    expect(stockAccounts('IN', 'PurchaseOrder', 5)).toEqual(['1200', '2010'])
    expect(stockAccounts('ADJUSTMENT', 'InventoryCount', -2)).toEqual(['5030', '1200'])
    expect(stockAccounts('TRANSFER_IN', 'Transfer', 5)).toBeNull()
    expect(expenseAccount('Shop Rent')).toBe('5200')
    expect(expenseAccount('Transport & Loading')).toBe('5400')
    expect(normalizeLines([{ code: 'a', debit: -50 }, { code: 'b', credit: -50 }])).toEqual([{ code: 'a', debit: 0, credit: 50 }, { code: 'b', debit: 50, credit: 0 }])
  })
})

describe('pricelist rules', () => {
  const product = { id: 7, categoryId: 2, price: 1000, costPrice: 600 }
  const base = { productId: null, categoryId: null, minQty: 0, fixedPrice: null, discountPct: null, markupPct: null, validFrom: null, validTo: null }
  const rules = [
    { ...base, id: 1, appliesTo: 'ALL', computeType: 'DISCOUNT', discountPct: 5 },
    { ...base, id: 2, appliesTo: 'CATEGORY', categoryId: 2, computeType: 'DISCOUNT', discountPct: 10 },
    { ...base, id: 3, appliesTo: 'CATEGORY', categoryId: 2, minQty: 50, computeType: 'DISCOUNT', discountPct: 15 },
    { ...base, id: 4, appliesTo: 'PRODUCT', productId: 99, computeType: 'FIXED', fixedPrice: 1 },
  ]
  it('prefers the most specific rule and the highest quantity break reached', () => {
    expect(matchingRule(rules, product, 10)?.id).toBe(2)
    expect(rulePrice(matchingRule(rules, product, 10), product)).toBe(900)
    expect(rulePrice(matchingRule(rules, product, 60), product)).toBe(850)
    expect(rulePrice(matchingRule(rules, { ...product, categoryId: 5 }, 10), { ...product, categoryId: 5 })).toBe(950)
  })
  it('respects validity dates and supports fixed and cost-plus prices', () => {
    const dated = [{ ...base, id: 9, appliesTo: 'PRODUCT', productId: 7, computeType: 'FIXED', fixedPrice: 777, validTo: new Date(2026, 0, 1) }]
    expect(matchingRule(dated, product, 1, new Date(2026, 5, 1))).toBeNull()
    expect(rulePrice(matchingRule(dated, product, 1, new Date(2025, 5, 1)), product)).toBe(777)
    expect(rulePrice({ ...base, id: 5, appliesTo: 'ALL', computeType: 'MARKUP', markupPct: 25 }, product)).toBe(750)
    expect(rulePrice(null, product)).toBe(1000)
  })
})

describe('sales team assignment', () => {
  it('shares leads round-robin by load and respects capacity', () => {
    const plan = planAssignment([1, 2, 3, 4, 5], [{ id: 10, openLeads: 2, capacity: 0 }, { id: 11, openLeads: 0, capacity: 2 }])
    expect(plan.map(step => step.staffId)).toEqual([11, 11, 10, 10, 10])
    expect(planAssignment([1, 2], [{ id: 1, openLeads: 3, capacity: 3 }])).toEqual([])
    expect(targetProgress(75000, 100000)).toBe(75)
    expect(targetProgress(10, 0)).toBeNull()
  })
})

describe('payment follow-up levels', () => {
  const levels = [{ id: 1, name: 'Reminder', days: 7, action: 'EMAIL' }, { id: 2, name: 'Call', days: 15, action: 'CALL' }, { id: 3, name: 'Final', days: 30, action: 'LETTER' }]
  it('picks the highest level reached and honours promised dates', () => {
    const today = new Date(2026, 9, 25)
    expect(daysOverdue(new Date(2026, 9, 5), today)).toBe(20)
    expect(levelFor(20, levels)?.name).toBe('Call')
    expect(levelFor(3, levels)).toBeNull()
    expect(levelFor(45, levels)?.action).toBe('LETTER')
    expect(needsAction(20, levels[1], null, today)).toBe(true)
    expect(needsAction(20, levels[1], new Date(2026, 9, 30), today)).toBe(false)
    expect(needsAction(20, levels[1], new Date(2026, 9, 25, 9), today)).toBe(true)
  })
})

describe('landed costs', () => {
  const lines = [{ id: 1, quantity: 10, value: 3000 }, { id: 2, quantity: 30, value: 3000 }, { id: 3, quantity: 0, value: 0 }]
  it('splits each cost by its method and adds up exactly', () => {
    const shares = allocateLandedCost(lines, [{ amount: 1000, splitMethod: 'BY_QUANTITY' }, { amount: 600, splitMethod: 'BY_VALUE' }, { amount: 100, splitMethod: 'EQUAL' }])
    expect([shares.get(1), shares.get(2), shares.get(3)]).toEqual([250 + 300 + 34, 750 + 300 + 33, 33])
    expect(splitAmount(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(splitAmount(50, [0, 0])).toEqual([25, 25])
  })
  it('capitalises only what is still on hand', () => {
    expect(splitStockAndCogs(1000, 10, 25)).toEqual({ inStockQty: 10, toStock: 1000, toCogs: 0 })
    expect(splitStockAndCogs(1000, 10, 4)).toEqual({ inStockQty: 4, toStock: 400, toCogs: 600 })
    expect(splitStockAndCogs(1000, 10, 0)).toEqual({ inStockQty: 0, toStock: 0, toCogs: 1000 })
    expect(costAfterLanding(20, 300, 1000)).toBe(350)
    expect(costAfterLanding(0, 300, 0)).toBe(300)
  })
})
