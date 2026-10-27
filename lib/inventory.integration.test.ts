import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
vi.mock('@/lib/auth-helpers', () => ({ requireAuth: vi.fn(async () => ({ user: { name: 'Test Manager', role: 'ADMIN' } })), requireRole: vi.fn(async () => ({ user: { name: 'Test Manager', role: 'ADMIN' } })) }))
vi.mock('@/app/actions/drafts', () => ({ moveProductToDraft: vi.fn() }))
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn() }))

import { createProduct, updateProduct, updateStock, bulkImportProducts, getProducts } from '@/app/actions/products'
import { createBatch } from '@/app/actions/batches'
import { createStoneLot, createSampleLoan, updateSampleLoanStatus, updateSlab, pairSlabs, createStoneOffcut, getStoneLots } from '@/app/actions/stone-inventory'
import { createTransfer, completeTransfer, setDefaultGodown, deleteGodown } from '@/app/actions/godowns'
import { requireRole } from '@/lib/auth-helpers'
import { createOrder, updateOrderStatus } from '@/app/actions/orders'
import { createPurchaseReturn, receivePurchaseOrder, receiveStoneLotFromPurchaseOrder } from '@/app/actions/purchases'

// Never load the developer's .env here. This suite requires an explicitly
// provisioned disposable schema, and refuses production/default schemas.
const url = process.env.INVENTORY_TEST_DATABASE_URL
describe.skipIf(!url)('inventory PostgreSQL regression workflows', () => {
  let db: PrismaClient
  let pool: pg.Pool
  let categoryId: number
  let godownId: number
  let secondGodownId: number
  beforeAll(async () => {
    const parsed = new URL(url!)
    const schema = parsed.searchParams.get('schema') || ''
    if (!/^inventory_test_[a-zA-Z0-9_]+$/.test(schema)) throw new Error('Inventory integration tests require a disposable inventory_test_* schema')
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 20 })
    db = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { timeout: 15000, maxWait: 15000 } })
    state.db = db
    categoryId = (await db.category.upsert({ where: { name: 'Tiles' }, create: { name: 'Tiles' }, update: {} })).id
    await db.godown.updateMany({ data: { isDefault: false } })
    godownId = (await db.godown.create({ data: { name: `Showroom-${crypto.randomUUID()}`, isDefault: true } })).id
    secondGodownId = (await db.godown.create({ data: { name: `Warehouse-${crypto.randomUUID()}` } })).id
  })
  afterAll(async () => { await db?.$disconnect(); await pool?.end() })
  beforeEach(() => { vi.mocked(requireRole).mockClear() })
  const newProduct = async (stock = 0, slab = false) => {
    const product = await db.product.create({ data: { sku: `TEST-${crypto.randomUUID()}`, name: 'Test tile', categoryId, price: 100, isSlabTracked: slab } })
    if (stock) await db.$transaction(tx => adjustStock(tx, product.id, godownId, stock, 'IN'))
    return product
  }
  const newLot = async () => {
    const product = await newProduct(0, true)
    const result = await createStoneLot({ productId: product.id, lotNumber: crypto.randomUUID(), godownId, slabs: [1, 2, 3, 4].map(id => ({ slabNumber: String(id), lengthInches: 120, widthInches: 72 })) })
    expect(result.success).toBe(true)
    return db.stoneLot.findUniqueOrThrow({ where: { id: result.data!.id }, include: { slabs: { orderBy: { id: 'asc' } } } })
  }

  it('rolls back product creation when opening stock location is invalid', async () => {
    const sku = crypto.randomUUID()
    const result = await createProduct({ sku, name: 'Invalid location', category: 'New category', price: 10, stock: 4, godownId: 2147483647 })
    expect(result.success).toBe(false)
    expect(await db.product.findUnique({ where: { sku } })).toBeNull()
    expect(await db.category.findUnique({ where: { name: 'New category' } })).toBeNull()
  })
  it('returns the real opening balance and matching ledger', async () => {
    const result = await createProduct({ sku: crypto.randomUUID(), name: 'Opening stock', category: 'Tiles', price: 10, stock: 4, godownId })
    expect(result.success).toBe(true)
    expect(result.data!.stock).toBe(4)
    expect(await db.stockLedger.count({ where: { productId: result.data!.id } })).toBe(1)
  })
  it('adds stock without a client location balance', async () => {
    const product = await newProduct(10)
    expect((await updateStock({ id: product.id, godownId, operation: 'ADD', quantity: 3, reason: 'Shipment', notes: 'Receipt A' })).success).toBe(true)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(13)
    expect((await db.stockLedger.findFirstOrThrow({ where: { productId: product.id, entryType: 'ADJUSTMENT' } })).notes).toContain('Receipt A')
  })
  it('does not lose simultaneous additions across locations', async () => {
    const product = await newProduct(10)
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => updateStock({ id: product.id, godownId: i % 2 ? secondGodownId : godownId, operation: 'ADD', quantity: 1 })))
    expect(results.every(result => result.success)).toBe(true)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(18)
    expect((await db.godownStock.aggregate({ where: { productId: product.id }, _sum: { quantity: true } }))._sum.quantity).toBe(18)
  })
  it('allows only one concurrent removal when stock cannot cover both', async () => {
    const product = await newProduct(10)
    const results = await Promise.all([1, 2].map(() => updateStock({ id: product.id, godownId, operation: 'REMOVE', quantity: 7 })))
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(3)
  })
  it('rejects stale absolute counts and leaves stock untouched', async () => {
    const product = await newProduct(10)
    const result = await updateStock({ id: product.id, godownId, operation: 'SET', quantity: 4, expectedBalance: 9 })
    expect(result.success).toBe(false)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(10)
  })
  it('preserves legacy unallocated stock on its first movement', async () => {
    const product = await newProduct()
    await db.product.update({ where: { id: product.id }, data: { stock: 10 } })
    expect((await updateStock({ id: product.id, godownId, operation: 'ADD', quantity: 2 })).success).toBe(true)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(12)
    expect(await db.stockLedger.count({ where: { productId: product.id, entryType: 'OPENING_BALANCE' } })).toBe(1)
  })
  it('legacy aggregate SET does not duplicate stock held at another location', async () => {
    const product = await newProduct(10)
    await db.$transaction(tx => adjustStock(tx, product.id, secondGodownId, 5, 'IN'))
    const result = await updateStock({ id: product.id, stock: 12 })
    expect(result.success, result.error).toBe(true)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(12)
  })
  it('prevents metadata edits from bypassing stock history and unit tracking', async () => {
    const product = await newProduct(10)
    expect((await updateProduct(product.id, { stock: 50 })).success).toBe(false)
    expect((await updateProduct(product.id, { unitOfMeasure: 'BOX' })).success).toBe(false)
    expect((await updateProduct(product.id, { isSlabTracked: true })).success).toBe(false)
    expect((await updateProduct(product.id, { reorderLevel: 0, finish: 'matte' })).success).toBe(true)
  })
  it('rejects an unauthorized stock mutation before touching the database', async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new Error('Forbidden'))
    expect((await updateStock({ id: 1, operation: 'ADD', quantity: 1 })).success).toBe(false)
  })
  it('rolls back an order and customer when its stock deduction fails', async () => {
    const product = await newProduct(2)
    const phone = crypto.randomUUID()
    const result = await createOrder({ customer: 'Out of stock buyer', phone, productId: product.id, quantity: 5, amount: 500, source: 'STORE', godownId })
    expect(result.success).toBe(false)
    expect(await db.order.count({ where: { productId: product.id } })).toBe(0)
    expect(await db.contact.findFirst({ where: { phone } })).toBeNull()
  })
  it('serializes competing store orders and their sold counters', async () => {
    const product = await newProduct(10)
    const results = await Promise.all([1, 2].map(() => createOrder({ customer: 'Stock buyer', phone: crypto.randomUUID(), productId: product.id, quantity: 7, amount: 700, source: 'STORE', godownId })))
    expect(results.filter(result => result.success)).toHaveLength(1)
    const updated = await db.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(updated.stock).toBe(3)
    expect(updated.sold).toBe(7)
    expect(await db.order.count({ where: { productId: product.id } })).toBe(1)
  })
  it('does not let a store order consume assigned batch stock without its shade', async () => {
    const product = await newProduct(10)
    await createBatch({ productId: product.id, batchNumber: crypto.randomUUID(), quantity: 10, remainingQty: 10 })
    const result = await createOrder({ customer: 'Batch buyer', phone: crypto.randomUUID(), productId: product.id, quantity: 1, amount: 100, source: 'STORE', godownId })
    expect(result.success).toBe(false)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(10)
  })
  it('returns cancelled order stock once and refuses reopening without reallocation', async () => {
    const product = await newProduct(10)
    const order = await createOrder({ customer: 'Cancellation buyer', phone: crypto.randomUUID(), productId: product.id, quantity: 4, amount: 400, source: 'STORE', godownId })
    expect(order.success).toBe(true)
    const results = await Promise.all([1, 2].map(() => updateOrderStatus({ id: order.data!.id, status: 'CANCELLED' })))
    expect(results.every(result => result.success)).toBe(true)
    const updated = await db.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(updated.stock).toBe(10)
    expect(updated.sold).toBe(0)
    expect(await db.stockLedger.count({ where: { productId: product.id, entryType: 'RETURN' } })).toBe(1)
    expect((await updateOrderStatus({ id: order.data!.id, status: 'CONFIRMED' })).success).toBe(false)
  })
  it('receives a purchase order once under simultaneous requests', async () => {
    const product = await newProduct()
    const supplier = await db.supplier.create({ data: { name: 'Test supplier' } })
    const po = await db.purchaseOrder.create({ data: { displayId: crypto.randomUUID(), supplierId: supplier.id, status: 'APPROVED', items: { create: { productId: product.id, name: product.name, sku: product.sku, quantity: 10, unitCost: 50, amount: 500 } } } })
    const results = await Promise.all([1, 2].map(() => receivePurchaseOrder(po.id)))
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(10)
    expect((await db.productBatch.findFirstOrThrow({ where: { productId: product.id } })).remainingQty).toBe(10)
  })
  it('supplier returns reduce both physical and matching batch stock', async () => {
    const product = await newProduct()
    const supplier = await db.supplier.create({ data: { name: 'Return test supplier' } })
    const po = await db.purchaseOrder.create({ data: { displayId: crypto.randomUUID(), supplierId: supplier.id, status: 'APPROVED', items: { create: { productId: product.id, name: product.name, sku: product.sku, quantity: 10, unitCost: 50, amount: 500 } } } })
    expect((await receivePurchaseOrder(po.id)).success).toBe(true)
    const result = await createPurchaseReturn({ supplierId: supplier.id, poId: po.id, godownId, reason: 'Damaged delivery', items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 3, unitCost: 50 }] })
    expect(result.success, result.error).toBe(true)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(7)
    expect((await db.productBatch.findFirstOrThrow({ where: { productId: product.id } })).remainingQty).toBe(7)
    expect(await db.stockLedger.count({ where: { productId: product.id, referenceType: 'PurchaseReturn', referenceId: result.data!.id } })).toBe(1)
  })
  it('does not consume another supplier’s batches during a return', async () => {
    const product = await newProduct(10)
    const supplier = await db.supplier.create({ data: { name: 'Original supplier' } })
    const other = await db.supplier.create({ data: { name: 'Wrong supplier' } })
    await db.productBatch.create({ data: { productId: product.id, batchNumber: crypto.randomUUID(), quantity: 10, remainingQty: 10, supplierId: supplier.id } })
    const result = await createPurchaseReturn({ supplierId: other.id, godownId, reason: 'Incorrect supplier', items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 3, unitCost: 50 }] })
    expect(result.success).toBe(false)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(10)
    expect(await db.purchaseReturn.count({ where: { supplierId: other.id } })).toBe(0)
  })
  it('keeps a multi-line stone PO partially received until every line is received', async () => {
    const products = await Promise.all([newProduct(0, true), newProduct(0, true)])
    const supplier = await db.supplier.create({ data: { name: 'Stone test supplier' } })
    const po = await db.purchaseOrder.create({ data: { displayId: crypto.randomUUID(), supplierId: supplier.id, status: 'APPROVED', items: { create: products.map(product => ({ productId: product.id, name: product.name, sku: product.sku, quantity: 1, unitCost: 50, amount: 50 })) } }, include: { items: { orderBy: { id: 'asc' } } } })
    for (const [index, item] of po.items.entries()) {
      const result = await receiveStoneLotFromPurchaseOrder({ poId: po.id, poItemId: item.id, lotNumber: crypto.randomUUID(), godownId, costPerSqft: 0, slabs: [{ slabNumber: '1', lengthInches: 120, widthInches: 72 }] })
      expect(result.success, result.error).toBe(true)
      expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe(index === 0 ? 'PARTIALLY_RECEIVED' : 'RECEIVED')
      expect(result.data!.costPerSqft).toBe(0)
    }
  })
  it('prevents competing stone receipts from exceeding the ordered slab count', async () => {
    const product = await newProduct(0, true)
    const supplier = await db.supplier.create({ data: { name: 'Stone concurrency supplier' } })
    const po = await db.purchaseOrder.create({ data: { displayId: crypto.randomUUID(), supplierId: supplier.id, status: 'APPROVED', items: { create: { productId: product.id, name: product.name, sku: product.sku, quantity: 1, unitCost: 50, amount: 50 } } }, include: { items: true } })
    const results = await Promise.all([1, 2].map(() => receiveStoneLotFromPurchaseOrder({ poId: po.id, poItemId: po.items[0].id, lotNumber: crypto.randomUUID(), godownId, slabs: [{ slabNumber: '1', lengthInches: 120, widthInches: 72 }] })))
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect(await db.slab.count({ where: { lot: { productId: product.id } } })).toBe(1)
  })
  it('handles blank generated SKU collisions and reports invalid import rows', async () => {
    const counter = await db.product.count()
    await db.product.create({ data: { sku: `PRD-${String(counter + 2).padStart(4, '0')}`, name: 'Existing generated SKU', categoryId, price: 1 } })
    const result = await bulkImportProducts([
      { name: 'Valid tile', category: 'Tiles', price: 100, instock: 2, unitOfMeasure: 'BOX', tileSize: '600x600', coveragePerBox: 15.5 },
      { name: 'Bad tile', category: 'Tiles', price: -100, instock: 2 },
      { name: 'Blank price', category: 'Tiles', price: '', instock: 2 },
    ])
    expect(result.success, result.error).toBe(true)
    expect(result.data).toMatchObject({ created: 1, skipped: 2, total: 3 })
    expect(result.data!.errors).toHaveLength(2)
    const imported = await db.product.findFirstOrThrow({ where: { name: 'Valid tile' } })
    expect(imported.unitOfMeasure).toBe('BOX')
    expect(imported.coveragePerBox).toBe(15.5)
  })
  it('reports existing explicit SKUs rather than silently renaming duplicate products', async () => {
    const existing = await newProduct()
    const result = await bulkImportProducts([{ name: 'Duplicate tile', sku: existing.sku, category: 'Tiles', price: 100, instock: 2 }])
    expect(result.success).toBe(false)
    expect(result.data).toMatchObject({ created: 0, skipped: 1, total: 1 })
    expect(await db.product.count({ where: { sku: { startsWith: existing.sku } } })).toBe(1)
  })
  it('reports malformed optional import numbers instead of replacing them with defaults', async () => {
    const result = await bulkImportProducts([{ name: 'Bad cost', category: 'Tiles', price: 100, instock: 2, costPrice: 'not-a-number' }])
    expect(result.success).toBe(false)
    expect(result.data!.errors).toHaveLength(1)
  })
  it('validates batch dates, whole quantities and remaining versus received', async () => {
    const product = await newProduct(10)
    for (const input of [{ quantity: 1.5 }, { quantity: 2, remainingQty: 3 }, { purchaseDate: 'invalid' }, { purchaseDate: '2020-02-02', expiryDate: '2020-01-01' }]) {
      expect((await createBatch({ productId: product.id, batchNumber: crypto.randomUUID(), quantity: 2, remainingQty: 2, ...input })).success).toBe(false)
    }
  })
  it('cannot assign more batches than physical stock, including concurrent assignments', async () => {
    const product = await newProduct(10)
    const results = await Promise.all([1, 2].map(() => createBatch({ productId: product.id, batchNumber: crypto.randomUUID(), quantity: 7, remainingQty: 7 })))
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect((await db.productBatch.aggregate({ where: { productId: product.id }, _sum: { remainingQty: true } }))._sum.remainingQty).toBe(7)
  })
  it('requires a selected batch for batch stock write-offs and updates both balances', async () => {
    const product = await newProduct(10)
    const batch = await createBatch({ productId: product.id, batchNumber: crypto.randomUUID(), quantity: 10, remainingQty: 10 })
    expect(batch.success).toBe(true)
    expect((await updateStock({ id: product.id, godownId, operation: 'REMOVE', quantity: 2 })).success).toBe(false)
    expect((await updateStock({ id: product.id, godownId, operation: 'REMOVE', quantity: 2, batchId: batch.data!.id })).success).toBe(true)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(8)
    expect((await db.productBatch.findUniqueOrThrow({ where: { id: batch.data!.id } })).remainingQty).toBe(8)
  })
  it('rejects aggregate quantity changes and batches for serialized stone', async () => {
    const product = await newProduct(0, true)
    expect((await updateStock({ id: product.id, godownId, operation: 'ADD', quantity: 2 })).success).toBe(false)
    expect((await createBatch({ productId: product.id, batchNumber: 'Stone', quantity: 1, remainingQty: 1 })).success).toBe(false)
  })
  it('sample checkout reserves a physical slab and a return updates live totals', async () => {
    const lot = await newLot()
    const loan = await createSampleLoan({ slabId: lot.slabs[0].id, customerName: 'Sample customer', customerPhone: crypto.randomUUID() })
    expect(loan.success).toBe(true)
    expect((await db.stoneLot.findUniqueOrThrow({ where: { id: lot.id } })).availableSqft).toBe(180)
    const results = await Promise.all([1, 2].map(() => updateSampleLoanStatus({ id: loan.data!.id, status: 'RETURNED' })))
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect((await db.stoneLot.findUniqueOrThrow({ where: { id: lot.id } })).availableSqft).toBe(240)
  })
  it('does not return a sold slab to availability or close its loan incorrectly', async () => {
    const lot = await newLot()
    const loan = await createSampleLoan({ slabId: lot.slabs[0].id, customerName: 'Sample buyer', customerPhone: crypto.randomUUID() })
    await db.slab.update({ where: { id: lot.slabs[0].id }, data: { status: 'SOLD' } })
    expect((await updateSampleLoanStatus({ id: loan.data!.id, status: 'RETURNED' })).success).toBe(false)
    expect((await db.sampleLoan.findUniqueOrThrow({ where: { id: loan.data!.id } })).status).toBe('OUT')
    expect((await db.slab.findUniqueOrThrow({ where: { id: lot.slabs[0].id } })).status).toBe('SOLD')
  })
  it('failed sample checkout leaves no orphan customer', async () => {
    const phone = crypto.randomUUID()
    expect((await createSampleLoan({ slabId: 2147483647, customerName: 'Invalid sample', customerPhone: phone })).success).toBe(false)
    expect(await db.contact.findFirst({ where: { phone } })).toBeNull()
  })
  it('prevents fabricated allocation or sale fields from bypassing workflows', async () => {
    const lot = await newLot()
    expect((await updateSlab({ slabId: lot.slabs[0].id, reservedForCustomId: 1, status: 'RESERVED' })).success).toBe(false)
    expect((await updateSlab({ slabId: lot.slabs[0].id, soldPrice: 100 })).success).toBe(false)
    expect((await updateSlab({ slabId: lot.slabs[0].id, status: 'SOLD' })).success).toBe(false)
  })
  it('re-pairs slabs symmetrically without leaving dangling previous partners', async () => {
    const { slabs } = await newLot()
    expect((await pairSlabs({ slabId: slabs[0].id, partnerId: slabs[1].id })).success).toBe(true)
    expect((await pairSlabs({ slabId: slabs[2].id, partnerId: slabs[3].id })).success).toBe(true)
    expect((await pairSlabs({ slabId: slabs[0].id, partnerId: slabs[2].id })).success).toBe(true)
    const updated = await db.slab.findMany({ where: { id: { in: slabs.map(row => row.id) } }, orderBy: { id: 'asc' } })
    expect(updated.map(row => row.bookMatchPairId)).toEqual([slabs[2].id, null, slabs[0].id, null])
  })
  it('checks offcut dimensions and serializes competing area claims', async () => {
    const lot = await newLot()
    const sourceSlabId = lot.slabs[0].id
    await db.slab.update({ where: { id: sourceSlabId }, data: { status: 'IN_PROCESSING' } })
    expect((await createStoneOffcut({ sourceSlabId, lengthInches: 130, widthInches: 1 })).success).toBe(false)
    const results = await Promise.all([1, 2].map(() => createStoneOffcut({ sourceSlabId, lengthInches: 100, widthInches: 50 })))
    expect(results.filter(result => result.success)).toHaveLength(1)
  })
  it('location-filtered lots omit empty lots and use scoped totals', async () => {
    const lot = await newLot()
    await db.slab.update({ where: { id: lot.slabs[0].id }, data: { godownId: secondGodownId } })
    const result = await getStoneLots({ godownId: secondGodownId })
    const filtered = result.data.find(row => row.id === lot.id)!
    expect(filtered.totalSlabs).toBe(1)
    expect(filtered.totalSqft).toBe(60)
    expect(result.data.every(row => row.slabs.length > 0)).toBe(true)
    const products = await getProducts()
    expect(products.data.find(row => row.id === lot.productId)!.availableStoneSlabs).toBe(4)
  })
  it('completes a transfer once despite concurrent requests and preserves total stock', async () => {
    const product = await newProduct(10)
    const transfer = await db.godownTransfer.create({ data: { displayId: crypto.randomUUID(), fromGodownId: godownId, toGodownId: secondGodownId, items: { create: { productId: product.id, name: product.name, sku: product.sku, quantity: 4 } } } })
    const results = await Promise.all([1, 2].map(() => completeTransfer(transfer.id)))
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(10)
    expect((await db.godownStock.findUniqueOrThrow({ where: { productId_godownId: { productId: product.id, godownId: secondGodownId } } })).quantity).toBe(4)
  })
  it('creates unique transfer numbers under simultaneous requests', async () => {
    const product = await newProduct(10)
    const results = await Promise.all([1, 2].map(() => createTransfer({ fromGodownId: godownId, toGodownId: secondGodownId, items: [{ productId: product.id, name: product.name, sku: product.sku, quantity: 2 }] })))
    expect(results.every(result => result.success)).toBe(true)
    expect(new Set(results.map(result => result.data!.displayId)).size).toBe(2)
  })
  it('does not unset the default godown when an invalid selection fails', async () => {
    expect((await setDefaultGodown(2147483647)).success).toBe(false)
    expect((await db.godown.findUniqueOrThrow({ where: { id: godownId } })).isDefault).toBe(true)
  })
  it('does not delete a location holding physical slabs', async () => {
    const location = await db.godown.create({ data: { name: `Stone-only-${crypto.randomUUID()}` } })
    const lot = await newLot()
    await db.slab.update({ where: { id: lot.slabs[0].id }, data: { godownId: location.id } })
    expect((await deleteGodown(location.id)).success).toBe(false)
    expect(await db.godown.findUnique({ where: { id: location.id } })).not.toBeNull()
  })
})
