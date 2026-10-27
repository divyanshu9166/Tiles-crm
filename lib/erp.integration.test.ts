import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import { adjustStock } from './inventory-stock'

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }))
vi.mock('@/lib/db', () => ({ prisma: new Proxy({}, { get: (_, key) => {
  const value = state.db[key as keyof PrismaClient]
  return typeof value === 'function' ? value.bind(state.db) : value
} }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth-helpers', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: '1', name: 'Test Manager', role: 'ADMIN' } })),
  requireRole: vi.fn(async () => ({ user: { id: '1', name: 'Test Manager', role: 'ADMIN' } })),
}))
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(async () => ({ success: false, error: 'disabled in tests' })) }))

import { createSalesOrder, createSalesOrderFromQuotation, createInvoiceFromSalesOrder, cancelSalesOrder, getSalesOrder, lockSalesOrder, createRefundFromSalesOrder } from '@/app/actions/sales-orders'
import { validatePicking, getPickings, cancelPicking, reserveDeliverySlabs, getPicking, returnDelivery } from '@/app/actions/operations'
import { createStoneLot } from '@/app/actions/stone-inventory'
import { approvePurchaseOrder, receivePurchaseOrder, cancelPurchaseOrder, createPurchaseOrder, recordPurchaseOrderPayment } from '@/app/actions/purchases'
import { cancelInvoice, createInvoice, updateInvoice, finalizeHeldInvoice, createCreditNote, recordPayment } from '@/app/actions/invoices'
import { createOrder, updateOrderStatus } from '@/app/actions/orders'
import { moveOrderToDraft, moveQuotationToDraft, movePurchaseOrderToDraft } from '@/app/actions/drafts'
import { createQuotation } from '@/app/actions/quotations'
import { getReplenishment, orderReplenishment, saveReorderRule, saveVendorPrice } from '@/app/actions/replenishment'
import { createInventoryCount, setCountedQty, applyInventoryCount, getInventoryCount } from '@/app/actions/inventory-counts'
import { getChatter, postNote, scheduleActivity, markActivityDone, getMyActivities } from '@/app/actions/chatter'
import { createBillFromPurchaseOrder, updateVendorBill, postVendorBill, cancelVendorBill, getVendorBill } from '@/app/actions/vendor-bills'
import { seedChartOfAccounts } from '@/app/actions/financials'
import { computeForecast } from '@/lib/erp/forecast'
import { getMRPAnalysis } from '@/app/actions/manufacturing'
import { saveSalesTeam, assignUnassignedLeads, getTeamDashboard } from '@/app/actions/sales-teams'
import { getAccountsDesk, executeFollowUp, registerBillPayment, applyPoAdvancesToBill } from '@/app/actions/accounts-desk'
import { savePricelist, savePricelistItem, assignContactPricelist, getPricesFor } from '@/app/actions/pricelists'
import { postAutoJournals, journalTrialBalance } from '@/lib/erp/accounting'
import { saveLandedCost, postLandedCost, cancelLandedCost, getLandedCost, getLandedCostReceipts } from '@/app/actions/landed-costs'

// Same disposable-schema contract as the inventory suite (scripts/test-inventory.cjs).
const url = process.env.INVENTORY_TEST_DATABASE_URL
describe.skipIf(!url)('ERP document flows (Odoo parity)', () => {
  let db: PrismaClient
  let pool: pg.Pool
  let categoryId: number
  let godownId: number
  let supplierId: number

  beforeAll(async () => {
    const parsed = new URL(url!)
    const schema = parsed.searchParams.get('schema') || ''
    if (!/^inventory_test_[a-zA-Z0-9_]+$/.test(schema)) throw new Error('ERP integration tests require a disposable inventory_test_* schema')
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 20 })
    db = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { timeout: 20000, maxWait: 20000 } })
    state.db = db
    await db.user.upsert({ where: { id: 1 }, create: { id: 1, email: `erp-${crypto.randomUUID()}@test.local`, name: 'Test Manager', hashedPassword: 'x', role: 'ADMIN' }, update: {} })
    categoryId = (await db.category.upsert({ where: { name: 'ERP Tiles' }, create: { name: 'ERP Tiles' }, update: {} })).id
    // Never touch the shared default location: the inventory suite owns it.
    godownId = (await db.godown.create({ data: { name: `ERP-Showroom-${crypto.randomUUID()}` } })).id
    supplierId = (await db.supplier.create({ data: { name: 'ERP Supplier' } })).id
  })
  afterAll(async () => { await db?.$disconnect(); await pool?.end() })

  const newProduct = async (stock = 0, extra: Record<string, unknown> = {}) => {
    const product = await db.product.create({ data: { sku: `ERP-${crypto.randomUUID()}`, name: `Tile ${crypto.randomUUID().slice(0, 6)}`, categoryId, price: 500, costPrice: 300, ...extra } })
    if (stock) await db.$transaction(tx => adjustStock(tx, product.id, godownId, stock, 'IN'))
    return product
  }
  const contactPhone = () => `9${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`

  it('runs sales order → partial delivery with backorder → invoice delivered qty', async () => {
    const product = await newProduct(20)
    const order = await createSalesOrder({ customer: 'Sharma Builders', phone: contactPhone(), godownId, lines: [{ productId: product.id, quantity: 10, price: 500, gstRate: 18 }] })
    expect(order.success, order.success ? '' : order.error).toBe(true)
    if (!order.success) return
    expect(order.data.displayId).toMatch(/^SO-\d{4}$/)
    expect(order.data.deliveryId).toBeTruthy()

    const nothing = await createInvoiceFromSalesOrder({ orderId: order.data.id })
    expect(nothing.success).toBe(false)

    const delivery = await db.stockPicking.findUniqueOrThrow({ where: { id: order.data.deliveryId! }, include: { lines: true } })
    const validated = await validatePicking({ id: delivery.id, createBackorder: true, lines: [{ lineId: delivery.lines[0].id, doneQty: 6 }] })
    expect(validated.success, validated.success ? '' : validated.error).toBe(true)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(14)
    const backorder = await db.stockPicking.findFirstOrThrow({ where: { backorderOfId: delivery.id }, include: { lines: true } })
    expect(backorder.status).toBe('READY')
    expect(backorder.lines[0].demandQty).toBe(4)

    const invoice = await createInvoiceFromSalesOrder({ orderId: order.data.id })
    expect(invoice.success, invoice.success ? '' : invoice.error).toBe(true)
    if (!invoice.success) return
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoice.data.id }, include: { items: true } })
    expect(inv.items[0].quantity).toBe(6)
    expect(inv.subtotal).toBe(3000)
    expect(inv.gst).toBe(540)
    expect(inv.salesOrderId).toBe(order.data.id)
    // Invoicing never moves stock for sales-order invoices.
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(14)

    // Cancelling the invoice re-opens the quantity without touching stock.
    expect((await cancelInvoice(inv.id)).success).toBe(true)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(14)
    expect((await db.salesOrderLine.findFirstOrThrow({ where: { orderId: order.data.id } })).qtyInvoiced).toBe(0)

    const detail = await getSalesOrder(order.data.id)
    expect(detail.success && detail.data.deliveryStatus).toBe('PARTIAL')
    expect(detail.success && detail.data.invoiceStatus).toBe('TO_INVOICE')
    expect((await cancelSalesOrder(order.data.id)).success).toBe(false) // already delivered
    expect((await lockSalesOrder(order.data.id)).success).toBe(true)
    expect((await db.stockPicking.findUniqueOrThrow({ where: { id: backorder.id } })).status).toBe('CANCELLED')
    const chatter = await getChatter('SalesOrder', order.data.id)
    expect(chatter.success && chatter.data.messages.length).toBeGreaterThanOrEqual(3)
  })

  it('validates a delivery only once under simultaneous requests', async () => {
    const product = await newProduct(5)
    const order = await createSalesOrder({ customer: 'Race', phone: contactPhone(), godownId, lines: [{ productId: product.id, quantity: 5, price: 100 }] })
    if (!order.success) throw new Error(order.error)
    const line = await db.stockPickingLine.findFirstOrThrow({ where: { pickingId: order.data.deliveryId! } })
    const results = await Promise.all([1, 2].map(() => validatePicking({ id: order.data.deliveryId!, createBackorder: false, lines: [{ lineId: line.id, doneQty: 5 }] })))
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(0)
  })

  it('refuses to deliver more than is on hand and leaves stock unchanged', async () => {
    const product = await newProduct(2)
    const order = await createSalesOrder({ customer: 'Short', phone: contactPhone(), godownId, lines: [{ productId: product.id, quantity: 5, price: 100 }] })
    if (!order.success) throw new Error(order.error)
    expect(order.data.warnings.length).toBe(1)
    const line = await db.stockPickingLine.findFirstOrThrow({ where: { pickingId: order.data.deliveryId! } })
    const result = await validatePicking({ id: order.data.deliveryId!, createBackorder: true, lines: [{ lineId: line.id, doneQty: 5 }] })
    expect(result.success).toBe(false)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(2)
    expect((await db.stockPicking.findUniqueOrThrow({ where: { id: order.data.deliveryId! } })).status).toBe('READY')
  })

  it('confirms a quotation once and links it to the order', async () => {
    const product = await newProduct(10)
    const contact = await db.contact.create({ data: { name: 'Quote Co', phone: contactPhone() } })
    const quotation = await db.quotation.create({ data: { displayId: `QT-${crypto.randomUUID()}`, contactId: contact.id, status: 'SENT', gstPercent: 18, items: { create: [{ productId: product.id, name: product.name, quantity: 4, rate: 250, amount: 1000 }] } } })
    const results = await Promise.all([1, 2].map(() => createSalesOrderFromQuotation({ quotationId: quotation.id, godownId })))
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect((await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).status).toBe('APPROVED')
    expect(await db.salesOrder.count({ where: { quotationId: quotation.id } })).toBe(1)
  })

  it('supports ordered-quantity invoicing before delivery', async () => {
    const product = await newProduct(10)
    const order = await createSalesOrder({ customer: 'Advance', phone: contactPhone(), godownId, invoicePolicy: 'ORDERED', freightCharge: 200, lines: [{ productId: product.id, quantity: 3, price: 1000, gstRate: 18 }] })
    if (!order.success) throw new Error(order.error)
    const invoice = await createInvoiceFromSalesOrder({ orderId: order.data.id })
    if (!invoice.success) throw new Error(invoice.error)
    expect(invoice.data.total).toBe(3000 + 540 + 200 + 36) // freight carries 18% GST (M15)
    expect((await createInvoiceFromSalesOrder({ orderId: order.data.id })).success).toBe(false)
    expect((await cancelSalesOrder(order.data.id)).success).toBe(false) // active invoice
  })

  it('receives a PO partially with a backorder and keeps a weighted average cost', async () => {
    const product = await newProduct(10) // costPrice 300 on 10 units
    const created = await createPurchaseOrder({ supplierId, items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 10, unitCost: 600, gstRate: 18 }] })
    expect(created.success).toBe(true)
    const poId = (created as { data: { id: number } }).data.id
    expect((await approvePurchaseOrder(poId)).success).toBe(true)
    const receipt = await db.stockPicking.findFirstOrThrow({ where: { purchaseOrderId: poId, status: 'READY' }, include: { lines: true } })
    expect(receipt.displayId).toMatch(/^GRN-\d{4}$/)
    expect((await cancelPicking(receipt.id)).success).toBe(false) // cancel through the PO

    const partial = await validatePicking({ id: receipt.id, createBackorder: true, lines: [{ lineId: receipt.lines[0].id, doneQty: 10 / 2 }] })
    expect(partial.success, partial.success ? '' : partial.error).toBe(true)
    const afterPartial = await db.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(afterPartial.stock).toBe(15)
    expect(afterPartial.costPrice).toBe(400) // (10×300 + 5×600) / 15
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe('PARTIALLY_RECEIVED')
    expect((await cancelPurchaseOrder(poId)).success).toBe(false)

    // "Receive all" validates the backorder for the remaining quantity.
    expect((await receivePurchaseOrder(poId)).success).toBe(true)
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { items: true } })
    expect(po.status).toBe('RECEIVED')
    expect(po.items[0].receivedQty).toBe(10)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(20)
    expect((await db.productBatch.findFirstOrThrow({ where: { productId: product.id, poId } })).remainingQty).toBe(10)
  })

  it('closes a PO short when a receipt is validated without backorder', async () => {
    const product = await newProduct()
    const created = await createPurchaseOrder({ supplierId, items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 8, unitCost: 100 }] })
    const poId = (created as { data: { id: number } }).data.id
    await approvePurchaseOrder(poId)
    const receipt = await db.stockPicking.findFirstOrThrow({ where: { purchaseOrderId: poId, status: 'READY' }, include: { lines: true } })
    expect((await validatePicking({ id: receipt.id, createBackorder: false, lines: [{ lineId: receipt.lines[0].id, doneQty: 6 }] })).success).toBe(true)
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe('RECEIVED')
    expect(await db.stockPicking.count({ where: { purchaseOrderId: poId, status: 'READY' } })).toBe(0)
  })

  it('enforces the PO approval limit for managers', async () => {
    const { requireRole } = await import('@/lib/auth-helpers')
    await db.storeSettings.upsert({ where: { id: 1 }, create: { id: 1, poApprovalLimit: 1000 }, update: { poApprovalLimit: 1000 } })
    const product = await newProduct()
    const created = await createPurchaseOrder({ supplierId, items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 10, unitCost: 500 }] })
    const poId = (created as { data: { id: number } }).data.id
    vi.mocked(requireRole).mockResolvedValueOnce({ user: { id: '1', name: 'Manager', role: 'MANAGER', email: '', staffId: null } })
    expect((await approvePurchaseOrder(poId)).success).toBe(false)
    expect((await approvePurchaseOrder(poId)).success).toBe(true) // ADMIN
    await db.storeSettings.update({ where: { id: 1 }, data: { poApprovalLimit: 0 } })
  })

  it('suggests replenishment from forecast and merges into one draft PO per supplier', async () => {
    const product = await newProduct(3)
    expect((await saveVendorPrice({ productId: product.id, supplierId, price: 275, isPreferred: true })).success).toBe(true)
    expect((await saveReorderRule({ productId: product.id, minQty: 5, maxQty: 20, multipleQty: 5, supplierId })).success).toBe(true)
    const report = await getReplenishment()
    if (!report.success) throw new Error(report.error)
    const row = report.data.find(entry => entry.product.id === product.id)!
    expect(row.forecast).toBe(3)
    expect(row.toOrder).toBe(20) // up to 20 in multiples of 5 → 17 rounds to 20
    expect(row.unitCost).toBe(275)

    const first = await orderReplenishment({ items: [{ productId: product.id, supplierId, quantity: 20, ruleId: row.ruleId }] })
    if (!first.success) throw new Error(first.error)
    const second = await orderReplenishment({ items: [{ productId: product.id, supplierId, quantity: 5 }] })
    if (!second.success) throw new Error(second.error)
    expect(second.data[0].id).toBe(first.data[0].id)
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: first.data[0].id }, include: { items: true } })
    expect(po.status).toBe('DRAFT')
    expect(po.items).toHaveLength(1)
    expect(po.items[0].quantity).toBe(25)
    expect(po.subtotal).toBe(25 * 275)

    // Draft RFQs are not incoming yet; approved POs are.
    await approvePurchaseOrder(po.id)
    const after = await getReplenishment()
    const updated = after.success ? after.data.find(entry => entry.product.id === product.id)! : null
    expect(updated?.incoming).toBe(25)
    expect(updated?.toOrder).toBe(0)
  })

  it('applies a physical count against the live balance', async () => {
    const product = await newProduct(10)
    const count = await createInventoryCount({ godownId, scope: 'PRODUCTS', productIds: [product.id] })
    if (!count.success) throw new Error(count.error)
    const detail = await getInventoryCount(count.data.id)
    if (!detail.success) throw new Error(detail.error)
    expect(detail.data.lines[0].systemQty).toBe(10)
    expect((await setCountedQty({ lineId: detail.data.lines[0].id, countedQty: 7 })).success).toBe(true)
    // A sale happens while the team is counting: the count still wins.
    await db.$transaction(tx => adjustStock(tx, product.id, godownId, -1, 'SALE'))
    const applied = await applyInventoryCount(count.data.id)
    expect(applied.success, applied.success ? '' : applied.error).toBe(true)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(7)
    expect((await db.inventoryCountLine.findFirstOrThrow({ where: { countId: count.data.id } })).appliedDelta).toBe(-2)
    expect((await applyInventoryCount(count.data.id)).success).toBe(false)
    expect(await db.stockLedger.count({ where: { productId: product.id, referenceType: 'InventoryCount' } })).toBe(1)
  })

  it('keeps chatter notes and activities per record', async () => {
    const product = await newProduct()
    expect((await postNote({ resModel: 'Product', resId: product.id, body: 'Shade variation reported' })).success).toBe(true)
    const scheduled = await scheduleActivity({ resModel: 'Product', resId: product.id, summary: 'Call supplier', activityType: 'CALL', dueDate: '2020-01-01' })
    if (!scheduled.success) throw new Error(scheduled.error)
    const mine = await getMyActivities()
    expect(mine.success && mine.data.counts.overdue).toBeGreaterThanOrEqual(1)
    expect((await markActivityDone(scheduled.data.id, 'Supplier will replace')).success).toBe(true)
    expect((await markActivityDone(scheduled.data.id)).success).toBe(false)
    const chatter = await getChatter('Product', product.id)
    expect(chatter.success && chatter.data.activities).toHaveLength(0)
    expect(chatter.success && chatter.data.messages.map(message => message.body).join('|')).toContain('Supplier will replace')
    expect((await getChatter('User', 1)).success).toBe(false)
  })

  it('sells serial-tracked slabs through a sales order, billed on delivered sq.ft', async () => {
    const product = await newProduct(0, { isSlabTracked: true, unitOfMeasure: 'SLAB', materialCategory: 'GRANITE' })
    const lot = await createStoneLot({ productId: product.id, lotNumber: `LOT-${crypto.randomUUID()}`, godownId, slabs: [1, 2, 3].map(n => ({ slabNumber: `S${n}`, lengthInches: 120, widthInches: 72 })) })
    expect(lot.success, lot.success ? '' : String((lot as { error?: string }).error)).toBe(true)
    const slabs = await db.slab.findMany({ where: { lot: { productId: product.id } }, orderBy: { id: 'asc' } })
    expect(slabs.map(slab => slab.sqft)).toEqual([60, 60, 60])

    const order = await createSalesOrder({ customer: 'Stone Buyer', phone: contactPhone(), godownId, lines: [{ productId: product.id, quantity: 2, areaSqft: 110, price: 250, gstRate: 18 }] })
    if (!order.success) throw new Error(order.error)
    const detail = await getPicking(order.data.deliveryId!)
    if (!detail.success) throw new Error(detail.error)
    expect(detail.data.lines[0].slabs).toHaveLength(3)

    expect((await reserveDeliverySlabs({ pickingId: order.data.deliveryId!, slabIds: [slabs[0].id] })).success).toBe(true)
    expect((await db.slab.findUniqueOrThrow({ where: { id: slabs[0].id } })).status).toBe('RESERVED')
    const line = await db.stockPickingLine.findFirstOrThrow({ where: { pickingId: order.data.deliveryId! } })
    // A slab of another product, or a count mismatch, is refused.
    expect((await validatePicking({ id: order.data.deliveryId!, createBackorder: false, lines: [{ lineId: line.id, doneQty: 2, slabIds: [slabs[0].id, slabs[0].id] }] })).success).toBe(false)
    const delivered = await validatePicking({ id: order.data.deliveryId!, createBackorder: false, lines: [{ lineId: line.id, doneQty: 2, slabIds: [slabs[0].id, slabs[1].id] }] })
    expect(delivered.success, delivered.success ? '' : delivered.error).toBe(true)
    const after = await db.slab.findMany({ where: { id: { in: [slabs[0].id, slabs[1].id] } } })
    expect(after.every(slab => slab.status === 'SOLD' && slab.soldPrice === 15000)).toBe(true)
    expect((await db.stoneLot.findFirstOrThrow({ where: { productId: product.id } })).availableSqft).toBe(60)
    const soLine = await db.salesOrderLine.findFirstOrThrow({ where: { orderId: order.data.id } })
    expect(soLine.qtyDelivered).toBe(2)
    expect(soLine.deliveredSqft).toBe(120)

    const invoice = await createInvoiceFromSalesOrder({ orderId: order.data.id })
    if (!invoice.success) throw new Error(invoice.error)
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoice.data.id }, include: { items: true } })
    expect(inv.subtotal).toBe(120 * 250) // measured 120 sq.ft, not the quoted 110
    expect(inv.items[0].areaSqft).toBe(120)
    expect((await cancelInvoice(inv.id)).success).toBe(true)
    const reopened = await db.salesOrderLine.findFirstOrThrow({ where: { orderId: order.data.id } })
    expect(reopened.qtyInvoiced).toBe(0)
    expect(reopened.invoicedSqft).toBe(0)
    expect((await db.slab.findUniqueOrThrow({ where: { id: slabs[0].id } })).status).toBe('SOLD') // stock does not come back
  })

  it('releases order-reserved slabs when the order is cancelled', async () => {
    const product = await newProduct(0, { isSlabTracked: true, unitOfMeasure: 'SLAB' })
    await createStoneLot({ productId: product.id, lotNumber: `LOT-${crypto.randomUUID()}`, godownId, slabs: [{ slabNumber: 'R1', lengthInches: 100, widthInches: 60 }] })
    const slab = await db.slab.findFirstOrThrow({ where: { lot: { productId: product.id } } })
    const order = await createSalesOrder({ customer: 'Reserve', phone: contactPhone(), godownId, lines: [{ productId: product.id, quantity: 1, price: 100 }] })
    if (!order.success) throw new Error(order.error)
    expect((await reserveDeliverySlabs({ pickingId: order.data.deliveryId!, slabIds: [slab.id] })).success).toBe(true)
    expect((await cancelSalesOrder(order.data.id)).success).toBe(true)
    const released = await db.slab.findUniqueOrThrow({ where: { id: slab.id } })
    expect(released.status).toBe('AVAILABLE')
    expect(released.reservedForOrderId).toBeNull()
  })

  it('bills a PO three ways: ordered, received, billed', async () => {
    const { requireRole } = await import('@/lib/auth-helpers')
    const product = await newProduct()
    const created = await createPurchaseOrder({ supplierId, items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 10, unitCost: 200, gstRate: 18 }] })
    const poId = (created as { data: { id: number } }).data.id
    await approvePurchaseOrder(poId)
    expect((await createBillFromPurchaseOrder(poId)).success).toBe(false) // nothing received yet
    const receipt = await db.stockPicking.findFirstOrThrow({ where: { purchaseOrderId: poId, status: 'READY' }, include: { lines: true } })
    await validatePicking({ id: receipt.id, createBackorder: true, lines: [{ lineId: receipt.lines[0].id, doneQty: 6 }] })

    const bill = await createBillFromPurchaseOrder(poId)
    if (!bill.success) throw new Error(bill.error)
    const draft = await db.vendorBill.findUniqueOrThrow({ where: { id: bill.data.id }, include: { lines: true } })
    expect(draft.lines[0].quantity).toBe(6)
    expect(draft.total).toBe(6 * 200 + 216)
    expect((await postVendorBill(draft.id)).success).toBe(false) // supplier invoice no. required

    // Billing more than was received is refused outright.
    await updateVendorBill({ id: draft.id, vendorRef: `SUP-${crypto.randomUUID().slice(0, 6)}`, lines: [{ id: draft.lines[0].id, quantity: 7, unitCost: 200 }] })
    expect((await postVendorBill(draft.id)).success).toBe(false)
    // A price variance needs an administrator's acceptance.
    await updateVendorBill({ id: draft.id, lines: [{ id: draft.lines[0].id, quantity: 6, unitCost: 210 }] })
    vi.mocked(requireRole).mockResolvedValueOnce({ user: { id: '1', name: 'Manager', role: 'MANAGER', email: '', staffId: null } })
    const managerPost = await postVendorBill(draft.id, { acceptVariance: true })
    expect(managerPost.success).toBe(false)
    const adminPost = await postVendorBill(draft.id, { acceptVariance: true })
    expect(adminPost.success, adminPost.success ? '' : adminPost.error).toBe(true)
    const posted = await db.vendorBill.findUniqueOrThrow({ where: { id: draft.id } })
    expect(posted.status).toBe('POSTED')
    expect(posted.matchStatus).toBe('TO_CHECK')
    expect((await db.purchaseOrderItem.findFirstOrThrow({ where: { poId } })).billedQty).toBe(6)

    // The same supplier invoice cannot be posted twice; everything received is billed.
    expect((await createBillFromPurchaseOrder(poId)).success).toBe(false)
    expect((await cancelVendorBill(draft.id)).success).toBe(true)
    expect((await db.purchaseOrderItem.findFirstOrThrow({ where: { poId } })).billedQty).toBe(0)
    const again = await createBillFromPurchaseOrder(poId)
    if (!again.success) throw new Error(again.error)
    await updateVendorBill({ id: again.data.id, vendorRef: posted.vendorRef })
    const dup = await postVendorBill(again.data.id)
    expect(dup.success).toBe(true) // the earlier bill with that number was cancelled
  })

  it('posts balanced, idempotent double-entry journals from documents', async () => {
    expect((await seedChartOfAccounts()).success).toBe(true)
    const product = await newProduct(10)
    const order = await createSalesOrder({ customer: 'Books', phone: contactPhone(), godownId, invoicePolicy: 'ORDERED', lines: [{ productId: product.id, quantity: 2, price: 1000, gstRate: 18 }] })
    if (!order.success) throw new Error(order.error)
    const invoice = await createInvoiceFromSalesOrder({ orderId: order.data.id })
    if (!invoice.success) throw new Error(invoice.error)

    const first = await postAutoJournals(db as never)
    expect(first.posted).toBeGreaterThan(0)
    expect(first.skipped).toEqual([])
    const entry = await db.journalEntry.findUniqueOrThrow({ where: { sourceKey: `INV:${invoice.data.id}` }, include: { lines: { include: { account: true } } } })
    expect(entry.totalDebit).toBe(2360)
    expect(entry.lines.find(line => line.account.code === '4001')?.credit).toBe(2000)
    expect(entry.lines.find(line => line.account.code === '2100')?.credit).toBe(360)

    // Re-running posts nothing new; a cancellation adds exactly one reversal.
    expect((await postAutoJournals(db as never)).posted).toBe(0)
    expect((await cancelInvoice(invoice.data.id)).success).toBe(true)
    expect((await postAutoJournals(db as never)).posted).toBe(1)
    expect(await db.journalEntry.count({ where: { sourceKey: `INVREV:${invoice.data.id}` } })).toBe(1)

    const trial = await journalTrialBalance(db as never, new Date(Date.now() + 86400000))
    expect(trial.totals.debit).toBe(trial.totals.credit)
  })

  it('takes customer returns back into stock and refunds only what was returned', async () => {
    const product = await newProduct(10)
    const order = await createSalesOrder({ customer: 'Returner', phone: contactPhone(), godownId, lines: [{ productId: product.id, quantity: 6, price: 1000, gstRate: 18 }] })
    if (!order.success) throw new Error(order.error)
    const line = await db.stockPickingLine.findFirstOrThrow({ where: { pickingId: order.data.deliveryId! } })
    expect((await validatePicking({ id: order.data.deliveryId!, createBackorder: false, lines: [{ lineId: line.id, doneQty: 6 }] })).success).toBe(true)
    const invoice = await createInvoiceFromSalesOrder({ orderId: order.data.id })
    if (!invoice.success) throw new Error(invoice.error)
    expect(invoice.data.total).toBe(7080)

    expect((await returnDelivery({ deliveryId: order.data.deliveryId!, lines: [{ lineId: line.id, quantity: 7 }] })).success).toBe(false)
    const ret = await returnDelivery({ deliveryId: order.data.deliveryId!, reason: 'Shade mismatch', lines: [{ lineId: line.id, quantity: 2 }] })
    if (!ret.success) throw new Error(ret.error)
    expect(ret.data.displayId).toMatch(/^RET-\d{4}$/)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(6)
    expect((await returnDelivery({ deliveryId: order.data.deliveryId!, lines: [{ lineId: line.id, quantity: 5 }] })).success).toBe(false) // only 4 left
    const detail = await getSalesOrder(order.data.id)
    expect(detail.success && detail.data.invoiceStatus).toBe('TO_REFUND')

    const refund = await createRefundFromSalesOrder(order.data.id)
    if (!refund.success) throw new Error(refund.error)
    const note = await db.creditNote.findFirstOrThrow({ where: { invoiceId: invoice.data.id } })
    expect(note.amount).toBe(2360) // 2 × ₹1,000 + 18% GST
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoice.data.id } })).invoiceStatus).toBe('ACTIVE')
    const after = await getSalesOrder(order.data.id)
    expect(after.success && after.data.invoiceStatus).toBe('NOTHING') // 4 kept, 4 invoiced; 2 went back
    expect((await createRefundFromSalesOrder(order.data.id)).success).toBe(false)
  })

  it('returns delivered slabs to the yard', async () => {
    const product = await newProduct(0, { isSlabTracked: true, unitOfMeasure: 'SLAB' })
    await createStoneLot({ productId: product.id, lotNumber: `LOT-${crypto.randomUUID()}`, godownId, slabs: [{ slabNumber: 'X1', lengthInches: 120, widthInches: 72 }] })
    const slab = await db.slab.findFirstOrThrow({ where: { lot: { productId: product.id } } })
    const order = await createSalesOrder({ customer: 'Slab return', phone: contactPhone(), godownId, lines: [{ productId: product.id, quantity: 1, price: 200 }] })
    if (!order.success) throw new Error(order.error)
    const line = await db.stockPickingLine.findFirstOrThrow({ where: { pickingId: order.data.deliveryId! } })
    expect((await validatePicking({ id: order.data.deliveryId!, createBackorder: false, lines: [{ lineId: line.id, doneQty: 1, slabIds: [slab.id] }] })).success).toBe(true)
    const ret = await returnDelivery({ deliveryId: order.data.deliveryId!, lines: [{ lineId: line.id, quantity: 0, slabIds: [slab.id] }] })
    expect(ret.success, ret.success ? '' : ret.error).toBe(true)
    const back = await db.slab.findUniqueOrThrow({ where: { id: slab.id } })
    expect(back.status).toBe('AVAILABLE')
    expect(back.soldPrice).toBeNull()
    const soLine = await db.salesOrderLine.findFirstOrThrow({ where: { orderId: order.data.id } })
    expect(soLine.qtyDelivered).toBe(0)
    expect(soLine.deliveredSqft).toBe(0)
    expect((await returnDelivery({ deliveryId: order.data.deliveryId!, lines: [{ lineId: line.id, quantity: 0, slabIds: [slab.id] }] })).success).toBe(false)
  })

  it('prices order lines from the customer pricelist', async () => {
    const product = await newProduct(0, { price: 2000, costPrice: 1200 })
    const contractor = await savePricelist({ name: `Contractor ${crypto.randomUUID().slice(0, 6)}` })
    if (!contractor.success) throw new Error(contractor.error)
    expect((await savePricelistItem({ pricelistId: contractor.data.id, appliesTo: 'ALL', computeType: 'DISCOUNT', discountPct: 8 })).success).toBe(true)
    expect((await savePricelistItem({ pricelistId: contractor.data.id, appliesTo: 'PRODUCT', productId: product.id, minQty: 100, computeType: 'MARKUP', markupPct: 30 })).success).toBe(true)
    expect((await savePricelistItem({ pricelistId: contractor.data.id, appliesTo: 'PRODUCT', computeType: 'FIXED', fixedPrice: 1 })).success).toBe(false) // product required
    const contact = await db.contact.create({ data: { name: 'Contractor Co', phone: contactPhone() } })
    await assignContactPricelist(contact.id, contractor.data.id)

    const small = await getPricesFor({ contactId: contact.id, lines: [{ productId: product.id, quantity: 10 }] })
    if (!small.success) throw new Error(small.error)
    expect(small.data.pricelist?.id).toBe(contractor.data.id)
    expect(small.data.prices[0].price).toBe(1840)
    const bulk = await getPricesFor({ contactId: contact.id, lines: [{ productId: product.id, quantity: 120 }] })
    expect(bulk.success && bulk.data.prices[0].price).toBe(1560)

    const order = await createSalesOrder({ contactId: contact.id, godownId, lines: [{ productId: product.id, quantity: 10, price: 1840 }] })
    if (!order.success) throw new Error(order.error)
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: order.data.id } })).pricelistId).toBe(contractor.data.id)

    // Quotations and the POS find the customer by phone.
    const byPhone = await getPricesFor({ phone: contact.phone, lines: [{ productId: product.id, quantity: 10 }] })
    expect(byPhone.success && byPhone.data.prices[0].price).toBe(1840)
    const quote = await createQuotation({ customer: contact.name, phone: contact.phone, items: [{ productId: product.id, name: product.name, quantity: 10, rate: 1840 }] })
    if (!quote.success || !quote.data) throw new Error(quote.error)
    expect(quote.data.pricelistId).toBe(contractor.data.id) // the customer's list is recorded
    const confirmed = await createSalesOrderFromQuotation({ quotationId: quote.data.dbId, godownId })
    if (!confirmed.success) throw new Error(confirmed.error)
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: confirmed.data.id } })).pricelistId).toBe(contractor.data.id)
  })

  it('reserves components of open production orders in the forecast and MRP', async () => {
    const raw = await newProduct(10, { name: `Epoxy resin ${crypto.randomUUID().slice(0, 4)}`, reorderLevel: 0 })
    const finished = await newProduct(0)
    const bom = await db.billOfMaterials.create({ data: { name: 'Vanity top', finishedProductId: finished.id, items: { create: [{ rawMaterialId: raw.id, quantity: 2, wastagePercent: 10 }] } } })
    await db.productionOrder.create({ data: { displayId: `MO-${crypto.randomUUID().slice(0, 8)}`, bomId: bom.id, finishedProductId: finished.id, plannedQty: 3, status: 'PLANNED' } })

    const forecast = await computeForecast(db as never, { productIds: [raw.id, finished.id] })
    expect(forecast.get(raw.id)?.manufacturing).toBe(6.6) // 2 × 3 × 1.10
    expect(forecast.get(raw.id)?.forecast).toBe(3.4)
    expect(forecast.get(finished.id)?.incoming).toBe(3)

    // Planning a second batch of 3 sees only 3.4 left, not the 10 on the shelf.
    const mrp = await getMRPAnalysis(bom.id, 3)
    expect(mrp.success).toBe(true)
    const requirement = (mrp as { data: { requirements: { available: number; shortage: number; canProduce: boolean }[] } }).data.requirements[0]
    expect(requirement.available).toBe(3.4)
    expect(requirement.shortage).toBe(3.2)
    expect(requirement.canProduce).toBe(false)

    // A negative forecast also shows up in replenishment without any rule.
    await db.productionOrder.create({ data: { displayId: `MO-${crypto.randomUUID().slice(0, 8)}`, bomId: bom.id, finishedProductId: finished.id, plannedQty: 3, status: 'IN_PROGRESS' } })
    const report = await getReplenishment()
    const row = report.success ? report.data.find(entry => entry.product.id === raw.id) : null
    expect(row?.forecast).toBe(-3.2)
    expect(row?.toOrder).toBe(4)
  })

  it('runs a sales team: round-robin leads, team orders and invoiced vs target', async () => {
    const a = await db.staff.create({ data: { name: 'Asha', role: 'Sales', phone: contactPhone(), email: `a-${crypto.randomUUID()}@t.local`, joinDate: new Date(), leadCapacity: 1 } })
    const b = await db.staff.create({ data: { name: 'Bharat', role: 'Sales', phone: contactPhone(), email: `b-${crypto.randomUUID()}@t.local`, joinDate: new Date() } })
    const team = await saveSalesTeam({ name: `Projects ${crypto.randomUUID().slice(0, 6)}`, leaderId: a.id, monthlyTarget: 10000, memberIds: [a.id, b.id] })
    if (!team.success) throw new Error(team.error)
    const contacts = await Promise.all([1, 2, 3].map(() => db.contact.create({ data: { name: 'Lead co', phone: contactPhone() } })))
    // Other suites leave unassigned leads too; only ours matter here.
    await db.lead.updateMany({ where: { assignedToId: null }, data: { status: 'LOST' } })
    await Promise.all(contacts.map(contact => db.lead.create({ data: { contactId: contact.id, interest: 'Flooring', status: 'NEW' } })))
    const assigned = await assignUnassignedLeads(team.data.id)
    if (!assigned.success) throw new Error(assigned.error)
    expect(assigned.data.assigned).toBe(3)
    expect(await db.lead.count({ where: { assignedToId: a.id } })).toBe(1) // capacity 1
    expect(await db.lead.count({ where: { assignedToId: b.id, teamId: team.data.id } })).toBe(2)

    const product = await newProduct(10)
    const order = await createSalesOrder({ contactId: contacts[0].id, godownId, salespersonId: b.id, invoicePolicy: 'ORDERED', lines: [{ productId: product.id, quantity: 5, price: 1000, gstRate: 0 }] })
    if (!order.success) throw new Error(order.error)
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: order.data.id } })).teamId).toBe(team.data.id)
    const invoice = await createInvoiceFromSalesOrder({ orderId: order.data.id })
    if (!invoice.success) throw new Error(invoice.error)

    const dashboard = await getTeamDashboard()
    if (!dashboard.success) throw new Error(dashboard.error)
    const card = dashboard.data.teams.find(item => item.id === team.data.id)!
    expect(card.invoiced).toBe(5000)
    expect(card.progress).toBe(50)
    expect(card.members.find(member => member.staffId === b.id)?.invoiced).toBe(5000)
    expect(card.funnel.find(step => step.key === 'NEW')?.count).toBe(3)
  })

  it('chases overdue customers and pays vendor bills from the accounts desk', async () => {
    const { requireRole } = await import('@/lib/auth-helpers')
    const contact = await db.contact.create({ data: { name: 'Late payer', phone: contactPhone() } })
    await db.invoice.create({ data: { displayId: `OLD-${crypto.randomUUID().slice(0, 8)}`, contactId: contact.id, subtotal: 10000, total: 10000, balanceDue: 10000, paymentMethod: 'Credit', date: new Date(Date.now() - 20 * 86400000) } })
    const desk = await getAccountsDesk()
    if (!desk.success) throw new Error(desk.error)
    const row = desk.data.followUps.find(item => item.contactId === contact.id)!
    expect(row.oldestDays).toBe(20)
    expect(row.level?.action).toBe('CALL')
    expect(row.needsAction).toBe(true)

    expect((await executeFollowUp({ contactId: contact.id, action: 'CALL', note: 'Spoke to accounts' })).success).toBe(true)
    expect(await db.recordActivity.count({ where: { resModel: 'Contact', resId: contact.id, activityType: 'CALL', doneAt: null } })).toBe(1)
    expect((await executeFollowUp({ contactId: contact.id, action: 'EMAIL' })).success).toBe(false) // no email address
    const promised = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)
    expect((await executeFollowUp({ contactId: contact.id, action: 'PROMISE', nextDate: promised, note: 'NEFT on Friday' })).success).toBe(true)
    const after = await getAccountsDesk()
    expect(after.success && after.data.followUps.find(item => item.contactId === contact.id)?.needsAction).toBe(false)
    expect(await db.followUpLog.count({ where: { contactId: contact.id } })).toBe(2)

    // Bill payment: received 4 × ₹500, billed, paid in two parts.
    const product = await newProduct()
    const created = await createPurchaseOrder({ supplierId, items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 4, unitCost: 500, gstRate: 0 }] })
    const poId = (created as { data: { id: number } }).data.id
    await approvePurchaseOrder(poId)
    expect((await receivePurchaseOrder(poId)).success).toBe(true)
    const bill = await createBillFromPurchaseOrder(poId)
    if (!bill.success) throw new Error(bill.error)
    await updateVendorBill({ id: bill.data.id, vendorRef: `S-${crypto.randomUUID().slice(0, 6)}` })
    expect((await postVendorBill(bill.data.id)).success).toBe(true)
    expect((await registerBillPayment({ billId: bill.data.id, amount: 2500 })).success).toBe(false) // more than open
    const first = await registerBillPayment({ billId: bill.data.id, amount: 1200, reference: 'UTR1' })
    if (!first.success) throw new Error(first.error)
    expect(first.data.residual).toBe(800)
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).balanceDue).toBe(800)
    expect((await cancelVendorBill(bill.data.id)).success).toBe(false) // has payments
    const second = await registerBillPayment({ billId: bill.data.id, amount: 800 })
    expect(second.success && second.data.residual).toBe(0)
    expect((await registerBillPayment({ billId: bill.data.id, amount: 1 })).success).toBe(false)
    void requireRole
  })

  it('applies PO advances to the bill and never pays the supplier twice', async () => {
    const product = await newProduct()
    const created = await createPurchaseOrder({ supplierId, items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 4, unitCost: 500, gstRate: 0 }] })
    const poId = (created as { data: { id: number } }).data.id
    await approvePurchaseOrder(poId)
    expect((await recordPurchaseOrderPayment(poId, 1500, 'Advance')).success).toBe(true)
    expect((await receivePurchaseOrder(poId)).success).toBe(true)
    const bill = await createBillFromPurchaseOrder(poId)
    if (!bill.success) throw new Error(bill.error)
    await updateVendorBill({ id: bill.data.id, vendorRef: `A-${crypto.randomUUID().slice(0, 6)}` })
    expect((await postVendorBill(bill.data.id)).success).toBe(true)

    // Paying the full bill on top of the advance would overpay the PO.
    expect((await registerBillPayment({ billId: bill.data.id, amount: 2000 })).success).toBe(false)
    const detail = await getVendorBill(bill.data.id)
    expect(detail.success && detail.data.outstandingAdvances).toBe(1500)
    const applied = await applyPoAdvancesToBill(bill.data.id)
    if (!applied.success) throw new Error(applied.error)
    expect(applied.data).toEqual({ applied: 1500, residual: 500 })
    expect((await applyPoAdvancesToBill(bill.data.id)).success).toBe(false) // nothing left to apply
    const rest = await registerBillPayment({ billId: bill.data.id, amount: 500 })
    expect(rest.success && rest.data.residual).toBe(0)
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })
    expect([po.amountPaid, po.balanceDue]).toEqual([2000, 0])
  })

  it('lands freight and duty on receipts: stock value for what is on hand, COGS for what was sold', async () => {
    const tileA = await newProduct()
    const tileB = await newProduct()
    const created = await createPurchaseOrder({ supplierId, items: [
      { productId: tileA.id, name: tileA.name, sku: tileA.sku, quantity: 10, unitCost: 300, gstRate: 0 },
      { productId: tileB.id, name: tileB.name, sku: tileB.sku, quantity: 30, unitCost: 100, gstRate: 0 },
    ] })
    const poId = (created as { data: { id: number } }).data.id
    await approvePurchaseOrder(poId)
    expect((await receivePurchaseOrder(poId)).success).toBe(true)
    const receipt = await db.stockPicking.findFirstOrThrow({ where: { purchaseOrderId: poId, status: 'DONE' } })
    const listed = await getLandedCostReceipts(receipt.displayId)
    expect(listed.success && listed.data.map(row => row.id)).toContain(receipt.id)
    // 6 of the 10 A tiles are already sold when the transporter's bill arrives.
    await db.$transaction(tx => adjustStock(tx, tileA.id, godownId, -6, 'SALE'))

    const transporter = await db.supplier.create({ data: { name: 'Transporter' } })
    expect((await saveLandedCost({ pickingIds: [receipt.id], lines: [{ name: 'Freight', amount: 0 }] })).success).toBe(false)
    const draft = await saveLandedCost({ supplierId: transporter.id, vendorRef: 'LR-77', creditTo: 'PAYABLE', pickingIds: [receipt.id], lines: [
      { name: 'Truck freight', costType: 'FREIGHT', amount: 1000, splitMethod: 'BY_QUANTITY' },
      { name: 'Octroi', costType: 'DUTY', amount: 600, splitMethod: 'BY_VALUE' },
    ] })
    if (!draft.success) throw new Error(draft.error)
    const preview = await getLandedCost(draft.data.id)
    if (!preview.success) throw new Error(preview.error)
    const rowA = preview.data.allocation.find(row => row.productId === tileA.id)!
    expect([rowA.additionalCost, rowA.inStockQty, rowA.toStock, rowA.toCogs, rowA.costAfter]).toEqual([550, 4, 220, 330, 355])
    // Nothing changes until it is validated.
    expect((await db.product.findUniqueOrThrow({ where: { id: tileA.id } })).costPrice).toBe(300)

    const posted = await postLandedCost(draft.data.id)
    if (!posted.success) throw new Error(posted.error)
    expect(posted.data).toEqual({ amountTotal: 1600, toStock: 1270, toCogs: 330 })
    expect((await db.product.findUniqueOrThrow({ where: { id: tileA.id } })).costPrice).toBe(355)
    expect((await db.product.findUniqueOrThrow({ where: { id: tileB.id } })).costPrice).toBe(135)
    expect((await postLandedCost(draft.data.id)).success).toBe(false)
    expect((await cancelLandedCost(draft.data.id)).success).toBe(false)
    expect((await saveLandedCost({ id: draft.data.id, pickingIds: [receipt.id], lines: [] })).success).toBe(false)

    await postAutoJournals(db as never)
    const entry = await db.journalEntry.findUniqueOrThrow({ where: { sourceKey: `LC:${draft.data.id}` }, include: { lines: { include: { account: true } } } })
    const byCode = Object.fromEntries(entry.lines.map(line => [line.account.code, line.debit - line.credit]))
    expect(byCode).toEqual({ '1200': 1270, '5001': 330, '2001': -1600 })
  })

  // ── Phase 2: money and stock correctness ──────────────────────────────
  const stockOf = async (productId: number) => (await db.product.findUniqueOrThrow({ where: { id: productId } })).stock
  const posInvoice = (product: { id: number; name: string; sku: string }, item: Record<string, unknown>, extra: Record<string, unknown> = {}) => createInvoice({
    customer: 'Walk-in', phone: contactPhone(), godownId,
    items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 1, price: 1000, gstRate: 18, ...item }],
    payments: [{ amount: 100000, method: 'Cash' }], ...extra,
  })

  it('M1: a BOX tile sold by area bills and deducts the same boxes', async () => {
    const tile = await newProduct(50, { unitOfMeasure: 'BOX', coveragePerBox: 15 })
    const res = await posInvoice(tile, { unitOfMeasure: 'BOX', areaSqft: 300, coveragePerBox: 15 })
    if (!res.success || !res.data) throw new Error(res.error)
    expect(res.data.subtotal).toBe(20 * 1000)
    expect(res.data.items[0].quantity).toBe(20)
    expect(await stockOf(tile.id)).toBe(30) // used to drop by the typed 1
  })

  it('M4: money handed back as change is not booked as cash received', async () => {
    const product = await newProduct(5)
    const res = await posInvoice(product, {}, { payments: [{ amount: 2000, method: 'Cash' }] })
    if (!res.success || !res.data) throw new Error(res.error)
    expect(res.data.total).toBe(1180)
    expect(res.data.amountPaid).toBe(1180)
    expect(res.data.payments.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0)).toBe(1180)
    expect(res.data.payments[0].notes).toMatch(/change ₹820/)
  })

  it('M5: an issued bill keeps its lines; only notes and similar details can change', async () => {
    const product = await newProduct(10)
    const created = await posInvoice(product, { quantity: 2 })
    if (!created.success || !created.data) throw new Error(created.error)
    const invoice = created.data
    const base = { customer: 'Walk-in', phone: (await db.contact.findUniqueOrThrow({ where: { id: invoice.contactId } })).phone, discount: 0, discountType: 'none', payments: [] }
    const sameLines = [{ productId: product.id, name: product.name, sku: product.sku, quantity: 2, price: 1000, gstRate: 18 }]
    const changed = await updateInvoice(invoice.id, { ...base, items: [{ ...sameLines[0], quantity: 5 }] })
    expect(changed.success).toBe(false)
    expect(changed.error).toMatch(/credit note/)
    const notesOnly = await updateInvoice(invoice.id, { ...base, items: sameLines, notes: 'Deliver after 5pm' })
    expect(notesOnly.success, notesOnly.error).toBe(true)
    const after = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, include: { items: true } })
    expect([after.notes, after.total, after.items[0].quantity]).toEqual(['Deliver after 5pm', invoice.total, 2])
    expect(await stockOf(product.id)).toBe(8)
  })

  it('M6: a cancelled parked bill can never be finalized', async () => {
    const product = await newProduct(10)
    const held = await posInvoice(product, { quantity: 3 }, { isHeld: true, payments: [{ amount: 0, method: 'Cash' }] })
    if (!held.success || !held.data) throw new Error(held.error)
    expect((await cancelInvoice(held.data.id)).success).toBe(true)
    expect((await finalizeHeldInvoice(held.data.id)).success).toBe(false)
    expect(await stockOf(product.id)).toBe(10)
  })

  it('M7: moving a cancelled store order to drafts does not add its stock back again', async () => {
    const product = await newProduct(50)
    const order = await createOrder({ customer: 'Store buyer', phone: contactPhone(), productId: product.id, quantity: 5, amount: 5000, source: 'STORE', godownId })
    if (!order.success || !order.data) throw new Error(order.error)
    expect(await stockOf(product.id)).toBe(45)
    expect((await updateOrderStatus({ id: order.data.id, status: 'CANCELLED' })).success).toBe(true)
    expect(await stockOf(product.id)).toBe(50)
    expect((await moveOrderToDraft(order.data.id)).success).toBe(true)
    expect(await stockOf(product.id)).toBe(50) // used to become 55
  })

  it('M8: a quotation already confirmed as a sales order cannot be deleted and re-confirmed', async () => {
    const product = await newProduct(10)
    const phone = contactPhone()
    const quote = await createQuotation({ customer: 'Builder', phone, items: [{ productId: product.id, name: product.name, quantity: 2, rate: 500 }] })
    if (!quote.success || !quote.data) throw new Error(quote.error)
    const order = await createSalesOrderFromQuotation({ quotationId: quote.data.dbId, godownId })
    if (!order.success) throw new Error(order.error)
    const moved = await moveQuotationToDraft(quote.data.dbId)
    expect(moved.success).toBe(false)
    expect(moved.error).toMatch(/confirmed as/)
  })

  it('M9: only an untouched purchase order can be moved to drafts', async () => {
    const product = await newProduct()
    const make = async () => {
      const created = await createPurchaseOrder({ supplierId, items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 4, unitCost: 100, gstRate: 0 }] })
      return (created as { data: { id: number } }).data.id
    }
    const approvedId = await make()
    await approvePurchaseOrder(approvedId)
    const blocked = await movePurchaseOrderToDraft(approvedId)
    expect(blocked.success).toBe(false)
    expect(await db.purchaseOrder.count({ where: { id: approvedId } })).toBe(1)
    const draftId = await make()
    expect((await movePurchaseOrderToDraft(draftId)).success).toBe(true)
  })

  it('M10/M11: credit notes reduce what is owed, restore stock once, and block cancelling', async () => {
    const product = await newProduct(10)
    const created = await posInvoice(product, { quantity: 2 }, { payments: [{ amount: 1000, method: 'Cash' }] }) // total 2360, owes 1360
    if (!created.success || !created.data) throw new Error(created.error)
    const id = created.data.id
    expect((await cancelInvoice(id)).error).toMatch(/credit note/) // has a payment
    expect((await createCreditNote({ invoiceId: id, amount: 360, reason: 'Price adjustment' })).success).toBe(true)
    expect((await db.invoice.findUniqueOrThrow({ where: { id } })).balanceDue).toBe(1000)
    expect(await stockOf(product.id)).toBe(8)
    // Full credit, clicked twice at once: one wins, goods come back once.
    const results = await Promise.all([1, 2].map(() => createCreditNote({ invoiceId: id, amount: 2000, reason: 'Returned' })))
    expect(results.filter(result => result.success)).toHaveLength(1)
    const after = await db.invoice.findUniqueOrThrow({ where: { id } })
    expect([after.invoiceStatus, after.balanceDue]).toEqual(['REFUNDED', 0])
    expect(await stockOf(product.id)).toBe(10)
  })

  it('M12: two payments on the same bill at the same moment both count', async () => {
    const product = await newProduct(5)
    const created = await posInvoice(product, { quantity: 2 }, { payments: [{ amount: 360, method: 'Cash' }] }) // total 2360, owes 2000
    if (!created.success || !created.data) throw new Error(created.error)
    const id = created.data.id
    const results = await Promise.all([1, 2].map(() => recordPayment({ invoiceId: id, amount: 1000, method: 'UPI' })))
    expect(results.every(result => result.success)).toBe(true)
    const after = await db.invoice.findUniqueOrThrow({ where: { id }, include: { payments: true } })
    expect([after.amountPaid, after.balanceDue, after.paymentStatus]).toEqual([2360, 0, 'PAID'])
    expect(after.payments.reduce((sum, payment) => sum + payment.amount, 0)).toBe(2360)
  })

  it('M14: a vendor bill carries the PO discount into what is owed', async () => {
    const product = await newProduct()
    const created = await createPurchaseOrder({ supplierId, discount: 500, items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 10, unitCost: 1000, gstRate: 18 }] })
    const poId = (created as { data: { id: number } }).data.id
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })
    await approvePurchaseOrder(poId)
    expect((await receivePurchaseOrder(poId)).success).toBe(true)
    const bill = await createBillFromPurchaseOrder(poId)
    if (!bill.success) throw new Error(bill.error)
    const saved = await db.vendorBill.findUniqueOrThrow({ where: { id: bill.data.id } })
    expect([saved.subtotal, saved.gst, saved.total]).toEqual([9500, 1710, 11210])
    expect(saved.total).toBe(po.total) // owed exactly what the PO said
  })

  it('M16: re-invoicing an order after cancelling its invoice bills the freight again', async () => {
    const product = await newProduct(10)
    const order = await createSalesOrder({ customer: 'Freight', phone: contactPhone(), godownId, invoicePolicy: 'ORDERED', freightCharge: 3000, lines: [{ productId: product.id, quantity: 2, price: 1000, gstRate: 18 }] })
    if (!order.success) throw new Error(order.error)
    const first = await createInvoiceFromSalesOrder({ orderId: order.data.id })
    if (!first.success) throw new Error(first.error)
    expect((await db.invoice.findUniqueOrThrow({ where: { id: first.data.id } })).freightCharge).toBe(3000)
    expect((await cancelInvoice(first.data.id)).success).toBe(true)
    const second = await createInvoiceFromSalesOrder({ orderId: order.data.id })
    if (!second.success) throw new Error(second.error)
    expect((await db.invoice.findUniqueOrThrow({ where: { id: second.data.id } })).freightCharge).toBe(3000)
  })

  it('M15: freight and installation carry GST at the principal line rate on POS bills', async () => {
    const tile = await newProduct(10)
    const small = await newProduct(10)
    const res = await createInvoice({
      customer: 'Charges', phone: contactPhone(), godownId,
      items: [
        { productId: tile.id, name: tile.name, sku: tile.sku, quantity: 3, price: 1000, gstRate: 12 }, // principal (3000)
        { productId: small.id, name: small.name, sku: small.sku, quantity: 1, price: 500, gstRate: 18 },
      ],
      freightCharge: 1500, installationCharge: 500,
      payments: [{ amount: 100000, method: 'Cash' }],
    })
    if (!res.success || !res.data) throw new Error(res.error)
    // goods GST 360 + 90; charges 2000 at 12% = 240
    expect([res.data.chargesGst, res.data.gst, res.data.total]).toEqual([240, 690, 3500 + 690 + 2000])
    expect(res.data.cgst + res.data.sgst).toBe(690)
  })

  it('M15: a sales order taxes its charges and its invoice matches the order total', async () => {
    const product = await newProduct(10)
    const order = await createSalesOrder({ customer: 'Charges SO', phone: contactPhone(), godownId, invoicePolicy: 'ORDERED', freightCharge: 2000, lines: [{ productId: product.id, quantity: 2, price: 1000, gstRate: 18 }] })
    if (!order.success) throw new Error(order.error)
    const saved = await db.salesOrder.findUniqueOrThrow({ where: { id: order.data.id } })
    expect([saved.gst, saved.total]).toEqual([360 + 360, 2000 + 720 + 2000])
    const invoice = await createInvoiceFromSalesOrder({ orderId: order.data.id })
    if (!invoice.success) throw new Error(invoice.error)
    const billed = await db.invoice.findUniqueOrThrow({ where: { id: invoice.data.id } })
    expect([billed.chargesGst, billed.total]).toEqual([360, saved.total])
  })

  it('lists open transfers with late flags', async () => {
    const result = await getPickings({ type: 'DELIVERY', status: 'READY' })
    expect(result.success).toBe(true)
  })
})
