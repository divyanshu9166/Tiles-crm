'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { splitGst } from '@/lib/erp/gst-math'
import { supplierSupplyType } from '@/lib/erp/supply-type'
import { requireActor, actionError } from '@/lib/erp/actor'
import { computeForecast, suggestedOrderQty } from '@/lib/erp/forecast'
import { nextSequence } from '@/lib/erp/sequence'
import { logMessage } from '@/lib/erp/chatter'

const STOCK_ROLES = ['ADMIN', 'MANAGER'] as const

function refresh() {
  revalidatePath('/replenishment')
  revalidatePath('/purchases')
  revalidatePath('/operations')
}

// Odoo Replenishment report: every active reordering rule, plus products
// without a rule whose forecast is negative or at/below their reorder level.
export async function getReplenishment() {
  try {
    await requireActor()
    const [rules, products, vendorPrices, draftLines] = await Promise.all([
      prisma.reorderRule.findMany({
        where: { active: true },
        include: {
          product: { select: { id: true, name: true, sku: true, unitOfMeasure: true, costPrice: true, isSlabTracked: true } },
          godown: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
        },
        orderBy: { id: 'asc' },
      }),
      prisma.product.findMany({
        // Products with a reorder level, plus anything that may go negative
        // (e.g. raw materials reserved by open production orders).
        where: { isSlabTracked: false },
        select: { id: true, name: true, sku: true, unitOfMeasure: true, costPrice: true, reorderLevel: true, stock: true },
      }),
      prisma.productSupplier.findMany({ include: { supplier: { select: { id: true, name: true } } }, orderBy: [{ isPreferred: 'desc' }, { price: 'asc' }] }),
      // Odoo "On order": quantities already on draft RFQs are not suggested again.
      prisma.purchaseOrderItem.groupBy({ by: ['productId'], where: { po: { status: 'DRAFT' } }, _sum: { quantity: true } }),
    ])
    const onOrder = new Map(draftLines.map(line => [line.productId, line._sum.quantity || 0]))
    const vendorsByProduct = new Map<number, typeof vendorPrices>()
    for (const vendor of vendorPrices) vendorsByProduct.set(vendor.productId, [...(vendorsByProduct.get(vendor.productId) || []), vendor])

    const globalForecast = await computeForecast(prisma)
    const godownIds = [...new Set(rules.flatMap(rule => rule.godownId ? [rule.godownId] : []))]
    const godownForecasts = new Map(await Promise.all(godownIds.map(async id => [id, await computeForecast(prisma, { godownId: id })] as const)))

    const ruled = new Set(rules.map(rule => rule.productId))
    const empty = { onHand: 0, reserved: 0, incoming: 0, free: 0, forecast: 0 }
    const rows = rules.filter(rule => !rule.product.isSlabTracked).map(rule => {
      const forecast = (rule.godownId ? godownForecasts.get(rule.godownId)?.get(rule.productId) : globalForecast.get(rule.productId)) || empty
      const vendor = rule.supplierId ? vendorsByProduct.get(rule.productId)?.find(v => v.supplierId === rule.supplierId) : vendorsByProduct.get(rule.productId)?.[0]
      return {
        key: `rule-${rule.id}`,
        ruleId: rule.id,
        product: rule.product,
        godown: rule.godown,
        minQty: rule.minQty,
        maxQty: rule.maxQty,
        multipleQty: rule.multipleQty,
        leadDays: rule.leadDays,
        ...forecast,
        onOrder: onOrder.get(rule.productId) || 0,
        toOrder: suggestedOrderQty(forecast.forecast + (onOrder.get(rule.productId) || 0), rule.minQty, rule.maxQty, rule.multipleQty),
        supplier: rule.supplier || vendor?.supplier || null,
        unitCost: vendor?.price || rule.product.costPrice,
        vendors: vendorsByProduct.get(rule.productId)?.map(v => ({ supplierId: v.supplierId, name: v.supplier.name, price: v.price, leadDays: v.leadDays })) || [],
        lastOrderedAt: rule.lastOrderedAt,
      }
    })
    for (const product of products) {
      if (ruled.has(product.id)) continue
      const forecast = globalForecast.get(product.id) || { ...empty, onHand: product.stock, free: product.stock, forecast: product.stock }
      const drafted = onOrder.get(product.id) || 0
      if (product.reorderLevel > 0 ? forecast.forecast + drafted > product.reorderLevel : forecast.forecast + drafted >= 0) continue
      const vendor = vendorsByProduct.get(product.id)?.[0]
      rows.push({
        key: `auto-${product.id}`,
        ruleId: null as unknown as number,
        product: { ...product, isSlabTracked: false },
        godown: null,
        minQty: product.reorderLevel,
        maxQty: product.reorderLevel * 2,
        multipleQty: 1,
        leadDays: vendor?.leadDays ?? 7,
        ...forecast,
        onOrder: drafted,
        toOrder: suggestedOrderQty(forecast.forecast + drafted, product.reorderLevel, product.reorderLevel * 2, 1),
        supplier: vendor?.supplier || null,
        unitCost: vendor?.price || product.costPrice,
        vendors: vendorsByProduct.get(product.id)?.map(v => ({ supplierId: v.supplierId, name: v.supplier.name, price: v.price, leadDays: v.leadDays })) || [],
        lastOrderedAt: null,
      })
    }
    rows.sort((a, b) => (b.toOrder > 0 ? 1 : 0) - (a.toOrder > 0 ? 1 : 0) || a.forecast - b.forecast)
    return { success: true as const, data: rows }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load replenishment') }
  }
}

const ruleSchema = z.object({
  id: z.number().int().positive().optional(),
  productId: z.number().int().positive(),
  godownId: z.number().int().positive().optional().nullable(),
  minQty: z.number().min(0),
  maxQty: z.number().min(0),
  multipleQty: z.number().positive().default(1),
  supplierId: z.number().int().positive().optional().nullable(),
  leadDays: z.number().int().min(0).max(365).default(7),
  active: z.boolean().default(true),
}).refine(rule => rule.maxQty >= rule.minQty, { message: 'Max quantity must be at least the min quantity' })

export async function saveReorderRule(data: unknown) {
  try {
    await requireActor(...STOCK_ROLES)
    const input = ruleSchema.parse(data)
    const product = await prisma.product.findUnique({ where: { id: input.productId }, select: { isSlabTracked: true } })
    if (!product) throw new Error('Product not found')
    if (product.isSlabTracked) throw new Error('Slab-tracked stone is replenished by lot, not by reordering rule')
    const duplicate = await prisma.reorderRule.findFirst({ where: { productId: input.productId, godownId: input.godownId ?? null, ...(input.id ? { id: { not: input.id } } : {}) } })
    if (duplicate) throw new Error('This product already has a reordering rule for that location')
    const data_ = { productId: input.productId, godownId: input.godownId ?? null, minQty: input.minQty, maxQty: input.maxQty, multipleQty: input.multipleQty, supplierId: input.supplierId ?? null, leadDays: input.leadDays, active: input.active }
    const rule = input.id ? await prisma.reorderRule.update({ where: { id: input.id }, data: data_ }) : await prisma.reorderRule.create({ data: data_ })
    refresh()
    return { success: true as const, data: rule }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not save the reordering rule') }
  }
}

export async function deleteReorderRule(id: number) {
  try {
    await requireActor(...STOCK_ROLES)
    await prisma.reorderRule.delete({ where: { id } })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not delete the rule') }
  }
}

export async function getReorderRules() {
  try {
    await requireActor()
    const rules = await prisma.reorderRule.findMany({
      orderBy: { id: 'desc' },
      include: { product: { select: { id: true, name: true, sku: true } }, godown: { select: { id: true, name: true } }, supplier: { select: { id: true, name: true } } },
    })
    return { success: true as const, data: rules }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load rules') }
  }
}

const vendorSchema = z.object({
  productId: z.number().int().positive(),
  supplierId: z.number().int().positive(),
  price: z.number().int().min(0),
  minQty: z.number().min(0).default(0),
  leadDays: z.number().int().min(0).max(365).default(7),
  supplierSku: z.string().trim().max(100).optional(),
  isPreferred: z.boolean().default(false),
})

export async function saveVendorPrice(data: unknown) {
  try {
    await requireActor(...STOCK_ROLES)
    const input = vendorSchema.parse(data)
    const row = await prisma.$transaction(async tx => {
      if (input.isPreferred) await tx.productSupplier.updateMany({ where: { productId: input.productId, supplierId: { not: input.supplierId } }, data: { isPreferred: false } })
      return tx.productSupplier.upsert({
        where: { productId_supplierId: { productId: input.productId, supplierId: input.supplierId } },
        create: input,
        update: input,
      })
    })
    refresh()
    return { success: true as const, data: row }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not save the vendor price') }
  }
}

export async function deleteVendorPrice(id: number) {
  try {
    await requireActor(...STOCK_ROLES)
    await prisma.productSupplier.delete({ where: { id } })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not delete the vendor price') }
  }
}

export async function getVendorPrices(productId?: number) {
  try {
    await requireActor()
    const rows = await prisma.productSupplier.findMany({
      where: productId ? { productId } : {},
      orderBy: [{ productId: 'asc' }, { isPreferred: 'desc' }, { price: 'asc' }],
      include: { product: { select: { id: true, name: true, sku: true } }, supplier: { select: { id: true, name: true } } },
    })
    return { success: true as const, data: rows }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load vendor prices') }
  }
}

const orderSchema = z.object({
  items: z.array(z.object({
    productId: z.number().int().positive(),
    supplierId: z.number().int().positive(),
    quantity: z.number().int().positive(),
    unitCost: z.number().int().min(0).optional(),
    ruleId: z.number().int().positive().optional().nullable(),
  })).min(1, 'Select at least one product to order'),
})

// Odoo "Order once": quantities land on the supplier's open draft RFQ, or a
// new draft PO per supplier. Drafts still go through normal PO approval.
export async function orderReplenishment(data: unknown) {
  try {
    const actor = await requireActor(...STOCK_ROLES)
    const input = orderSchema.parse(data)
    const result = await prisma.$transaction(async tx => {
      const products = await tx.product.findMany({ where: { id: { in: input.items.map(item => item.productId) } } })
      const productById = new Map(products.map(product => [product.id, product]))
      const vendors = await tx.productSupplier.findMany({ where: { productId: { in: products.map(p => p.id) } } })
      const hsnCodes = products.flatMap(p => p.hsnCode ? [p.hsnCode] : [])
      const hsnRates = new Map((await tx.hsnCode.findMany({ where: { code: { in: hsnCodes } }, select: { code: true, gstRate: true } })).map(h => [h.code, h.gstRate]))
      const defaultRate = (await tx.storeSettings.findFirst({ where: { id: 1 }, select: { gstRate: true } }))?.gstRate ?? 18
      const bySupplier = new Map<number, typeof input.items>()
      for (const item of input.items) bySupplier.set(item.supplierId, [...(bySupplier.get(item.supplierId) || []), item])
      const touched: { id: number; displayId: string; created: boolean }[] = []

      for (const [supplierId, items] of bySupplier) {
        if (!(await tx.supplier.findUnique({ where: { id: supplierId }, select: { id: true } }))) throw new Error('A selected supplier no longer exists')
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463207, ${supplierId})::text`
        let po = await tx.purchaseOrder.findFirst({ where: { supplierId, status: 'DRAFT', notes: { contains: '[REPLENISHMENT]' } }, include: { items: true }, orderBy: { id: 'desc' } })
        const created = !po
        if (!po) {
          po = await tx.purchaseOrder.create({
            data: { displayId: await nextSequence(tx, 'PurchaseOrder'), supplierId, notes: '[REPLENISHMENT] Created from reordering rules', createdBy: actor.name },
            include: { items: true },
          })
        }
        for (const item of items) {
          const product = productById.get(item.productId)
          if (!product) throw new Error('A selected product no longer exists')
          if (product.isSlabTracked) throw new Error(`${product.name} is slab-tracked; order stone lots manually`)
          const vendor = vendors.find(v => v.productId === item.productId && v.supplierId === supplierId)
          const unitCost = item.unitCost ?? vendor?.price ?? product.costPrice
          const gstRate = (product.hsnCode ? hsnRates.get(product.hsnCode) : undefined) ?? defaultRate
          const existing = po.items.find(line => line.productId === item.productId && line.unitCost === unitCost)
          if (existing) {
            await tx.purchaseOrderItem.update({ where: { id: existing.id }, data: { quantity: { increment: item.quantity }, amount: { increment: item.quantity * unitCost } } })
          } else {
            await tx.purchaseOrderItem.create({ data: { poId: po.id, productId: product.id, name: product.name, sku: product.sku, hsnCode: product.hsnCode, quantity: item.quantity, unitCost, gstRate, amount: item.quantity * unitCost } })
          }
          if (item.ruleId) await tx.reorderRule.updateMany({ where: { id: item.ruleId }, data: { lastOrderedAt: new Date() } })
        }
        // Recompute totals the way createPurchaseOrder does.
        const lines = await tx.purchaseOrderItem.findMany({ where: { poId: po.id } })
        const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0)
        const discount = Math.min(po.discount, subtotal)
        const factor = subtotal > 0 ? (subtotal - discount) / subtotal : 1
        const gst = Math.max(0, Math.round(lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitCost * line.gstRate / 100), 0) * factor))
        const { cgst, sgst, igst } = splitGst(gst, await supplierSupplyType(tx, supplierId))
        const total = subtotal - discount + gst
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { subtotal, discount, gst, cgst, sgst, igst, total, balanceDue: Math.max(0, total - po.amountPaid) } })
        await logMessage(tx, 'PurchaseOrder', po.id, `${created ? 'Draft created' : 'Updated'} from replenishment: ${items.map(item => `${productById.get(item.productId)?.name} × ${item.quantity}`).join(', ')}`, { author: actor })
        touched.push({ id: po.id, displayId: po.displayId, created })
      }
      return touched
    }, { timeout: 20000 })
    refresh()
    return { success: true as const, data: result }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not create purchase orders') }
  }
}
