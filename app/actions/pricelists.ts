'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireActor, actionError } from '@/lib/erp/actor'
import { matchingRule, rulePrice } from '@/lib/erp/pricing'

const ROLES = ['ADMIN', 'MANAGER'] as const

function refresh() {
  revalidatePath('/pricelists')
  revalidatePath('/sales-orders')
}

export async function getPricelists() {
  try {
    await requireActor()
    const lists = await prisma.pricelist.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: {
        items: { orderBy: [{ appliesTo: 'desc' }, { minQty: 'asc' }], include: { product: { select: { id: true, name: true, sku: true, price: true, costPrice: true } }, category: { select: { id: true, name: true } } } },
        _count: { select: { contacts: true, salesOrders: true } },
      },
    })
    return { success: true as const, data: lists }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load pricelists') }
  }
}

const listSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, 'Name the pricelist').max(80),
  description: z.string().trim().max(300).optional(),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
})

export async function savePricelist(data: unknown) {
  try {
    await requireActor(...ROLES)
    const input = listSchema.parse(data)
    const list = await prisma.$transaction(async tx => {
      if (input.isDefault) await tx.pricelist.updateMany({ where: { isDefault: true, ...(input.id ? { id: { not: input.id } } : {}) }, data: { isDefault: false } })
      const values = { name: input.name, description: input.description, isDefault: input.isDefault, active: input.active }
      return input.id ? tx.pricelist.update({ where: { id: input.id }, data: values }) : tx.pricelist.create({ data: values })
    })
    refresh()
    return { success: true as const, data: list }
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return { success: false as const, error: 'A pricelist with this name already exists' }
    return { success: false as const, error: actionError(error, 'Could not save the pricelist') }
  }
}

const itemSchema = z.object({
  id: z.number().int().positive().optional(),
  pricelistId: z.number().int().positive(),
  appliesTo: z.enum(['ALL', 'CATEGORY', 'PRODUCT']),
  categoryId: z.number().int().positive().optional().nullable(),
  productId: z.number().int().positive().optional().nullable(),
  minQty: z.number().min(0).default(0),
  computeType: z.enum(['FIXED', 'DISCOUNT', 'MARKUP']),
  fixedPrice: z.number().int().min(0).optional().nullable(),
  discountPct: z.number().min(-100).max(100).optional().nullable(),
  markupPct: z.number().min(-100).max(1000).optional().nullable(),
  validFrom: z.string().optional().nullable(),
  validTo: z.string().optional().nullable(),
}).superRefine((item, ctx) => {
  if (item.appliesTo === 'PRODUCT' && !item.productId) ctx.addIssue({ code: 'custom', message: 'Pick the product this rule applies to' })
  if (item.appliesTo === 'CATEGORY' && !item.categoryId) ctx.addIssue({ code: 'custom', message: 'Pick the category this rule applies to' })
  if (item.computeType === 'FIXED' && item.fixedPrice == null) ctx.addIssue({ code: 'custom', message: 'Enter the fixed price' })
  if (item.computeType === 'DISCOUNT' && item.discountPct == null) ctx.addIssue({ code: 'custom', message: 'Enter the discount %' })
  if (item.computeType === 'MARKUP' && item.markupPct == null) ctx.addIssue({ code: 'custom', message: 'Enter the markup % on cost' })
})

export async function savePricelistItem(data: unknown) {
  try {
    await requireActor(...ROLES)
    const input = itemSchema.parse(data)
    const values = {
      pricelistId: input.pricelistId, appliesTo: input.appliesTo,
      categoryId: input.appliesTo === 'CATEGORY' ? input.categoryId : null,
      productId: input.appliesTo === 'PRODUCT' ? input.productId : null,
      minQty: input.minQty, computeType: input.computeType,
      fixedPrice: input.computeType === 'FIXED' ? input.fixedPrice : null,
      discountPct: input.computeType === 'DISCOUNT' ? input.discountPct : null,
      markupPct: input.computeType === 'MARKUP' ? input.markupPct : null,
      validFrom: input.validFrom ? new Date(`${input.validFrom}T00:00:00`) : null,
      validTo: input.validTo ? new Date(`${input.validTo}T23:59:59`) : null,
    }
    const item = input.id ? await prisma.pricelistItem.update({ where: { id: input.id }, data: values }) : await prisma.pricelistItem.create({ data: values })
    refresh()
    return { success: true as const, data: item }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not save the rule') }
  }
}

export async function deletePricelistItem(id: number) {
  try {
    await requireActor(...ROLES)
    await prisma.pricelistItem.delete({ where: { id } })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not delete the rule') }
  }
}

export async function assignContactPricelist(contactId: number, pricelistId: number | null) {
  try {
    await requireActor(...ROLES)
    await prisma.contact.update({ where: { id: contactId }, data: { pricelistId } })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not assign the pricelist') }
  }
}

export async function getPricelistCustomers(pricelistId: number) {
  try {
    await requireActor()
    const contacts = await prisma.contact.findMany({ where: { pricelistId }, select: { id: true, name: true, phone: true }, orderBy: { name: 'asc' }, take: 500 })
    return { success: true as const, data: contacts }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load customers') }
  }
}

const priceSchema = z.object({
  pricelistId: z.number().int().positive().optional().nullable(),
  contactId: z.number().int().positive().optional().nullable(),
  phone: z.string().trim().max(20).optional().nullable(), // quotations / POS identify the customer by phone
  lines: z.array(z.object({ productId: z.number().int().positive(), quantity: z.number().min(0) })).max(200),
})

// Prices for order lines: the customer's pricelist, else the given one, else
// the default list; products without a matching rule keep their list price.
export async function getPricesFor(data: unknown) {
  try {
    await requireActor()
    const input = priceSchema.parse(data)
    let pricelistId = input.pricelistId ?? null
    if (!pricelistId && input.contactId) pricelistId = (await prisma.contact.findUnique({ where: { id: input.contactId }, select: { pricelistId: true } }))?.pricelistId ?? null
    if (!pricelistId && !input.contactId && input.phone && input.phone.length >= 10) pricelistId = (await prisma.contact.findFirst({ where: { phone: input.phone }, select: { pricelistId: true } }))?.pricelistId ?? null
    const pricelist = pricelistId
      ? await prisma.pricelist.findFirst({ where: { id: pricelistId, active: true }, include: { items: true } })
      : await prisma.pricelist.findFirst({ where: { isDefault: true, active: true }, include: { items: true } })
    const products = await prisma.product.findMany({ where: { id: { in: input.lines.map(line => line.productId) } }, select: { id: true, categoryId: true, price: true, costPrice: true } })
    const byId = new Map(products.map(product => [product.id, product]))
    return {
      success: true as const,
      data: {
        pricelist: pricelist ? { id: pricelist.id, name: pricelist.name } : null,
        prices: input.lines.map(line => {
          const product = byId.get(line.productId)
          if (!product) return { productId: line.productId, price: null, ruleId: null }
          const rule = pricelist ? matchingRule(pricelist.items, product, line.quantity) : null
          return { productId: line.productId, price: rulePrice(rule, product), listPrice: product.price, ruleId: rule?.id ?? null }
        }),
      },
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not compute prices') }
  }
}
