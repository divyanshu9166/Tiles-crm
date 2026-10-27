'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { createOrderSchema, updateOrderStatusSchema } from '@/lib/validations/order'
import type { OrderSource, PaymentStatus } from '@prisma/client'
import { requireRole, requireAuth } from '@/lib/auth-helpers'
import { adjustStock, resolveStockGodown, lockInventoryProducts, inventoryError } from '@/lib/inventory-stock'
import { contactPhoneWhere, normalizePhone } from '@/lib/phone'

export async function getOrders(source?: string) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const where = source && source !== 'All'
    ? { source: source.toUpperCase() as OrderSource }
    : {}

  const orders = await prisma.order.findMany({
    where,
    include: { contact: true, product: true },
    orderBy: { date: 'desc' },
  })

  return {
    success: true,
    data: orders.map(o => ({
      id: o.displayId,
      customer: o.contact.name,
      product: o.product.name,
      quantity: o.quantity,
      amount: o.amount,
      status: o.status.charAt(0) + o.status.slice(1).toLowerCase(),
      date: o.date.toISOString().split('T')[0],
      deliveryDate: o.deliveryDate?.toISOString().split('T')[0] || null,
      payment: o.payment.charAt(0) + o.payment.slice(1).toLowerCase(),
      source: o.source.charAt(0) + o.source.slice(1).toLowerCase(),
      dbId: o.id,
    })),
  }
}

export async function getOrder(id: number) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const order = await prisma.order.findUnique({
    where: { id },
    include: { contact: true, product: true },
  })
  if (!order) return { success: false, error: 'Order not found' }
  return { success: true, data: order }
}

export async function createOrder(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER', 'STAFF') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createOrderSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const { customer, phone, productId, quantity, amount, source, payment, notes, godownId } = parsed.data
  const orderSource = source as OrderSource
  const shouldDeductStock = orderSource === 'STORE' || orderSource === 'SHOPIFY'
  try {
    const order = await prisma.$transaction(async tx => {
      await lockInventoryProducts(tx, [productId])
      const product = await tx.product.findUnique({ where: { id: productId } })
      if (!product) throw new Error('Product not found')
      if (shouldDeductStock && product.isSlabTracked) throw new Error('Sell physical slabs through the invoice workflow')
      const godown = shouldDeductStock ? await resolveStockGodown(tx, godownId) : null
      const contact = await tx.contact.findFirst({ where: contactPhoneWhere(phone) }) || await tx.contact.create({ data: { name: customer, phone: normalizePhone(phone) } })
      const prefix = orderSource === 'STORE' ? 'ORD' : orderSource === 'AMAZON' ? 'AMZ' : orderSource === 'FLIPKART' ? 'FK' : 'SHP'
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463102)::text`
      const lastOrder = await tx.order.findFirst({ where: { displayId: { startsWith: `${prefix}-` } }, orderBy: { id: 'desc' }, select: { displayId: true } })
      const nextNum = Number(lastOrder?.displayId.match(/(\d+)$/)?.[1] || 0) + 1
      const displayId = `${prefix}-${String(nextNum).padStart(4, '0')}`
      const created = await tx.order.create({ data: { displayId, contactId: contact.id, productId, quantity, amount, source: orderSource, payment: payment as PaymentStatus, status: 'CONFIRMED', date: new Date(), notes, godownId: godown?.id } })
      if (godown) {
        const batches = await tx.productBatch.aggregate({ where: { productId }, _sum: { remainingQty: true } })
        if (product.stock - quantity < (batches._sum.remainingQty || 0)) throw new Error('This stock is assigned to a batch/shade. Create an invoice with the selected batch.')
        await adjustStock(tx, productId, godown.id, -quantity, 'OUT', { referenceType: 'Order', referenceId: created.id, notes: `${orderSource} order ${displayId}` })
        await tx.product.update({ where: { id: productId }, data: { sold: { increment: quantity } } })
      }
      return created
    })
    revalidatePath('/orders')
    revalidatePath('/inventory')
    revalidatePath('/godowns')
    return { success: true, data: order }
  } catch (error) { return { success: false, error: inventoryError(error) } }
}

export async function updateOrderStatus(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER', 'STAFF') } catch { return { success: false, error: 'Access denied' } }
  const parsed = updateOrderStatusSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const { id, status } = parsed.data
  try {
    const order = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE`
      const existing = await tx.order.findUnique({ where: { id } })
      if (!existing) throw new Error('Order not found')
      if (existing.status === status) return existing
      if (existing.status === 'CANCELLED') throw new Error('A cancelled order cannot be reopened. Create a new order to allocate stock.')
      if (status === 'CANCELLED' && ['STORE', 'SHOPIFY'].includes(existing.source)) {
        await lockInventoryProducts(tx, [existing.productId])
        const product = await tx.product.findUniqueOrThrow({ where: { id: existing.productId } })
        const godown = await resolveStockGodown(tx, existing.godownId ?? undefined)
        await adjustStock(tx, existing.productId, godown.id, existing.quantity, 'RETURN', { referenceType: 'Order', referenceId: id, notes: 'Inventory returned after order cancellation' })
        await tx.product.update({ where: { id: existing.productId }, data: { sold: Math.max(0, product.sold - existing.quantity) } })
      }
      return tx.order.update({ where: { id }, data: { status, ...(status === 'DELIVERED' ? { deliveryDate: new Date() } : {}) } })
    })
    revalidatePath('/orders')
    revalidatePath('/inventory')
    revalidatePath('/godowns')
    return { success: true, data: order }
  } catch (error) { return { success: false, error: inventoryError(error) } }
}

export async function getOrdersBySource() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const counts = await prisma.order.groupBy({
    by: ['source'],
    _count: true,
    _sum: { amount: true },
  })

  return {
    success: true,
    data: counts.map(c => ({
      source: c.source,
      count: c._count,
      revenue: c._sum.amount || 0,
    })),
  }
}
