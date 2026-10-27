import type { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient
export type StockOptions = { referenceType?: string; referenceId?: number; notes?: string; createdBy?: string }

// Lock the product, not only a location row: this also serializes the aggregate
// stock balance when two transactions affect different locations.
export async function lockInventoryProducts(tx: Tx, ids: number[]) {
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid product ID')
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${id} FOR UPDATE`
  }
}

export async function resolveStockGodown(tx: Tx, id?: number) {
  if (id !== undefined) {
    const godown = await tx.godown.findUnique({ where: { id } })
    if (!godown) throw new Error('Selected location no longer exists')
    return godown
  }
  // Protect default-location creation and selection, including an empty table.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463101)::text`
  const existing = await tx.godown.findFirst({ orderBy: [{ isDefault: 'desc' }, { id: 'asc' }] })
  if (existing) return existing.isDefault ? existing : tx.godown.update({ where: { id: existing.id }, data: { isDefault: true } })
  return tx.godown.create({ data: { name: 'Main Showroom', type: 'Showroom', isDefault: true } })
}

export async function syncStock(tx: Tx, productId: number) {
  const aggregate = await tx.godownStock.aggregate({ where: { productId }, _sum: { quantity: true } })
  const stock = aggregate._sum.quantity ?? 0
  await tx.product.update({ where: { id: productId }, data: { stock } })
  return stock
}

export async function stockBalance(tx: Tx, productId: number, godownId: number) {
  await lockInventoryProducts(tx, [productId])
  const product = await tx.product.findUnique({ where: { id: productId } })
  if (!product) throw new Error('Product not found')
  if (product.isSlabTracked) throw new Error('Serialized stone stock must be managed through Lot / Slab Explorer')
  if (!await tx.godown.findUnique({ where: { id: godownId }, select: { id: true } })) throw new Error('Selected location no longer exists')
  // Preserve legacy stock rather than discarding it at the first adjustment.
  if (product.stock > 0 && await tx.godownStock.count({ where: { productId } }) === 0) {
    await tx.godownStock.create({ data: { productId, godownId, quantity: product.stock } })
    await tx.stockLedger.create({ data: { productId, godownId, entryType: 'OPENING_BALANCE', quantity: product.stock, balanceAfter: product.stock, notes: 'Existing stock allocated on first inventory movement' } })
  }
  const row = await tx.godownStock.findUnique({ where: { productId_godownId: { productId, godownId } } })
  return row?.quantity ?? 0
}

export async function adjustStock(tx: Tx, productId: number, godownId: number, delta: number, entryType: string, options?: StockOptions) {
  if (!Number.isFinite(delta)) throw new Error('Enter a finite stock quantity')
  const current = await stockBalance(tx, productId, godownId)
  const balance = Math.round((current + delta) * 1e6) / 1e6
  if (balance < 0) throw new Error(`Insufficient stock in location (available: ${current}, requested: ${Math.abs(delta)})`)
  if (delta === 0) return { godownBalance: current, totalStock: await syncStock(tx, productId) }
  await tx.godownStock.upsert({
    where: { productId_godownId: { productId, godownId } },
    create: { productId, godownId, quantity: balance }, update: { quantity: balance },
  })
  await tx.stockLedger.create({ data: { productId, godownId, entryType, quantity: delta, balanceAfter: balance, ...options } })
  const totalStock = await syncStock(tx, productId)
  if (delta > 0) await tx.product.update({ where: { id: productId }, data: { lastRestocked: new Date() } })
  return { godownBalance: balance, totalStock }
}

export function inventoryError(error: unknown) {
  const code = (error as { code?: string })?.code
  if (code === 'P2002') return 'That SKU, name or batch number already exists'
  if (code === 'P2003') return 'This record is linked to other records, or a selected relation no longer exists'
  if (code === 'P2025') return 'This record no longer exists. Refresh and try again.'
  if (code === 'P2034' || code === '40P01') return 'Stock changed at the same time. Refresh and retry.'
  return error instanceof Error ? error.message : 'Could not update inventory'
}
