'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { customerSupplyType } from '@/lib/erp/supply-type'
import { resolveStockGodown } from '@/lib/inventory-stock'
import { requireActor, actionError, type Actor } from '@/lib/erp/actor'
import { nextSequence, nextInvoiceNumber } from '@/lib/erp/sequence'
import { logMessage, logTracking, startOfToday } from '@/lib/erp/chatter'
import { createDeliveryForOrder, cancelPickingTx, releaseOrderSlabs } from '@/lib/erp/stock-ops'
import { computeForecast } from '@/lib/erp/forecast'
import { chargesTax, principalGstRate } from '@/lib/line-math'
import { nextCreditNoteNumber, refreshInvoiceBalance } from '@/lib/erp/credit-notes'
import { contactPhoneWhere, normalizePhone } from '@/lib/phone'
import {
  boxesForArea, computeTaxes, deliveryStatus, invoiceStatus, invoiceableQty, lineAmount, orderDiscount, portionOf, refundableQty, type DiscountType,
} from '@/lib/erp/sales-math'
import { stripBankDetails } from '@/lib/quotation-notes'

type Tx = Prisma.TransactionClient

const lineSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().min(0).max(1_000_000).default(0),
  price: z.number().int().min(0),
  unitOfMeasure: z.string().trim().toUpperCase().optional(),
  areaSqft: z.number().min(0).optional(),
  coveragePerBox: z.number().min(0).optional(),
  gstRate: z.number().min(0).max(40).optional(),
  name: z.string().trim().max(300).optional(),
})

const orderSchema = z.object({
  contactId: z.number().int().positive().optional(),
  customer: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(20).optional(),
  godownId: z.number().int().positive().optional(),
  salespersonId: z.number().int().positive().optional(),
  pricelistId: z.number().int().positive().optional(),
  invoicePolicy: z.enum(['ORDERED', 'DELIVERED']).default('DELIVERED'),
  commitmentDate: z.string().optional(),
  projectName: z.string().trim().max(200).optional(),
  dispatchAddress: z.string().trim().max(500).optional(),
  customerReference: z.string().trim().max(100).optional(),
  supplyType: z.enum(['INTRASTATE', 'INTERSTATE']).default('INTRASTATE'),
  placeOfSupply: z.string().trim().max(100).optional(),
  discountType: z.enum(['none', 'percent', 'flat']).default('none'),
  discountValue: z.number().min(0).default(0),
  freightCharge: z.number().int().min(0).default(0),
  loadingCharge: z.number().int().min(0).default(0),
  installationCharge: z.number().int().min(0).default(0),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(lineSchema).min(1, 'Add at least one product line'),
})

const fromQuotationSchema = z.object({
  quotationId: z.number().int().positive(),
  godownId: z.number().int().positive().optional(),
  invoicePolicy: z.enum(['ORDERED', 'DELIVERED']).default('DELIVERED'),
  commitmentDate: z.string().optional(),
  salespersonId: z.number().int().positive().optional(),
})

const SALES_ROLES = ['ADMIN', 'MANAGER'] as const

function refresh() {
  revalidatePath('/sales-orders')
  revalidatePath('/operations')
  revalidatePath('/billing')
  revalidatePath('/quotations')
}

function parseDate(value?: string) {
  if (!value) return null
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date')
  return date
}

async function resolveContact(tx: Tx, input: { contactId?: number; customer?: string; phone?: string }) {
  if (input.contactId) {
    const contact = await tx.contact.findUnique({ where: { id: input.contactId } })
    if (!contact) throw new Error('Customer not found')
    return contact
  }
  const phone = input.phone?.replace(/\s+/g, '')
  if (!phone || !input.customer) throw new Error('Select a customer or enter customer name and phone')
  return (await tx.contact.findFirst({ where: contactPhoneWhere(phone) })) || tx.contact.create({ data: { name: input.customer, phone: normalizePhone(phone) } })
}

type DraftLine = z.infer<typeof lineSchema>

async function buildLines(tx: Tx, lines: DraftLine[], defaultGst: number) {
  const products = await tx.product.findMany({ where: { id: { in: lines.map(line => line.productId) } } })
  const byId = new Map(products.map(product => [product.id, product]))
  return lines.map((line, index) => {
    const product = byId.get(line.productId)
    if (!product) throw new Error('A selected product no longer exists')
    // Serial-tracked stone sells by slab count; the measured area drives price.
    const unitOfMeasure = product.isSlabTracked
      ? (['SQFT', 'SQM', 'SLAB'].includes(line.unitOfMeasure || '') ? line.unitOfMeasure as string : 'SLAB')
      : line.unitOfMeasure || product.unitOfMeasure || 'PCS'
    const coveragePerBox = line.coveragePerBox ?? product.coveragePerBox ?? undefined
    let quantity = line.quantity
    if (unitOfMeasure === 'BOX' && line.areaSqft && coveragePerBox) quantity = Math.max(quantity, boxesForArea(line.areaSqft, coveragePerBox))
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(product.isSlabTracked ? `Enter the number of slabs for ${product.name}` : `Enter the stock quantity (pcs/boxes) for ${product.name}`)
    const priced = { quantity, price: line.price, unitOfMeasure, areaSqft: line.areaSqft, coveragePerBox }
    return {
      productId: product.id,
      name: line.name || product.name,
      sku: product.sku,
      hsnCode: product.hsnCode,
      unitOfMeasure,
      quantity,
      areaSqft: line.areaSqft ?? null,
      coveragePerBox: coveragePerBox ?? null,
      price: line.price,
      gstRate: line.gstRate ?? defaultGst,
      amount: lineAmount(priced),
      sortOrder: index,
    }
  })
}

// Charges (freight/loading/installation) carry GST at the principal line's rate.
function chargesTaxFor(taxedLines: { taxable: number; gstRate: number }[], charges: number, supplyType: string) {
  return chargesTax(charges, principalGstRate(taxedLines, 18), supplyType === 'INTERSTATE')
}

function orderTotals(lines: { amount: number; gstRate: number }[], discountType: DiscountType, discountValue: number, supplyType: string, charges: number) {
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0)
  const discount = orderDiscount(subtotal, discountType, discountValue)
  const taxes = computeTaxes(lines, discount, supplyType)
  const chargeTax = chargesTaxFor(taxes.lines, charges, supplyType)
  return { subtotal, discountAmount: taxes.discount, gst: taxes.gst + chargeTax.gst, total: taxes.taxable + taxes.gst + charges + chargeTax.gst }
}

// Without an explicit location, ship from the godown that covers the most
// ordered units (ties go to the default location).
async function bestFulfilmentGodown(tx: Tx, lines: { productId: number; quantity: number }[]) {
  const quantityStock = await tx.godownStock.findMany({ where: { productId: { in: lines.map(line => line.productId) }, quantity: { gt: 0 } }, select: { godownId: true, productId: true, quantity: true } })
  // Stone counts its available slabs per location.
  const slabs = await tx.slab.findMany({ where: { status: 'AVAILABLE', godownId: { not: null }, lot: { productId: { in: lines.map(line => line.productId) } } }, select: { godownId: true, lot: { select: { productId: true } } } })
  const slabStock = new Map<string, { godownId: number; productId: number; quantity: number }>()
  for (const slab of slabs) {
    const key = `${slab.godownId}-${slab.lot.productId}`
    const entry = slabStock.get(key) || { godownId: slab.godownId as number, productId: slab.lot.productId, quantity: 0 }
    entry.quantity += 1
    slabStock.set(key, entry)
  }
  const stocks = [...quantityStock, ...slabStock.values()]
  if (stocks.length === 0) return undefined
  const fill = new Map<number, number>()
  for (const line of lines) {
    for (const stock of stocks.filter(row => row.productId === line.productId)) fill.set(stock.godownId, (fill.get(stock.godownId) || 0) + Math.min(stock.quantity, line.quantity))
  }
  const fallback = await tx.godown.findFirst({ where: { isDefault: true }, select: { id: true } })
  return [...fill.entries()].sort((a, b) => b[1] - a[1] || (a[0] === fallback?.id ? -1 : b[0] === fallback?.id ? 1 : 0))[0]?.[0]
}

async function stockWarnings(tx: Tx, orderId: number, godownId: number) {
  const lines = await tx.salesOrderLine.findMany({ where: { orderId }, select: { productId: true, name: true } })
  const forecast = await computeForecast(tx, { productIds: lines.map(line => line.productId), godownId })
  return lines.flatMap(line => {
    const row = forecast.get(line.productId)
    return row && row.free < 0 ? [`${line.name}: short by ${Math.abs(row.free)} in this location (incoming ${row.incoming})`] : []
  })
}

async function createOrderTx(tx: Tx, input: z.infer<typeof orderSchema> & { quotationId?: number }, actor: Actor) {
  const settings = await tx.storeSettings.findFirst({ where: { id: 1 }, select: { gstRate: true } })
  const contact = await resolveContact(tx, input)
  const godown = await resolveStockGodown(tx, input.godownId)
  const salesperson = input.salespersonId ? await tx.staff.findUnique({ where: { id: input.salespersonId }, select: { id: true, salesTeamId: true } }) : null
  if (input.salespersonId && !salesperson) throw new Error('Salesperson not found')
  const lines = await buildLines(tx, input.lines, settings?.gstRate ?? 18)
  const charges = input.freightCharge + input.loadingCharge + input.installationCharge
  // Interstate is decided by the GSTIN state codes when both are known.
  const supplyType = await customerSupplyType(tx, contact.id, input.supplyType)
  const totals = orderTotals(lines, input.discountType, input.discountValue, supplyType, charges)
  const displayId = await nextSequence(tx, 'SalesOrder')
  const order = await tx.salesOrder.create({
    data: {
      displayId,
      quotationId: input.quotationId,
      contactId: contact.id,
      salespersonId: input.salespersonId,
      teamId: salesperson?.salesTeamId ?? undefined, // Odoo: the order follows its salesperson's team
      godownId: godown.id,
      // Record the price level the order was quoted at (customer default if none chosen).
      pricelistId: input.pricelistId ?? contact.pricelistId ?? undefined,
      invoicePolicy: input.invoicePolicy,
      commitmentDate: parseDate(input.commitmentDate),
      projectName: input.projectName,
      dispatchAddress: input.dispatchAddress || contact.address,
      customerReference: input.customerReference,
      supplyType,
      placeOfSupply: input.placeOfSupply || contact.state,
      discountType: input.discountType,
      discountValue: input.discountValue,
      freightCharge: input.freightCharge,
      loadingCharge: input.loadingCharge,
      installationCharge: input.installationCharge,
      notes: input.notes,
      createdBy: actor.name,
      ...totals,
      lines: { create: lines },
    },
  })
  await logMessage(tx, 'SalesOrder', order.id, input.quotationId ? 'Sales order confirmed from quotation' : 'Sales order confirmed', { author: actor })
  const delivery = await createDeliveryForOrder(tx, order.id, actor)
  const warnings = await stockWarnings(tx, order.id, godown.id)
  return { order, delivery, warnings }
}

export async function createSalesOrder(data: unknown) {
  try {
    const actor = await requireActor(...SALES_ROLES)
    const input = orderSchema.parse(data)
    const result = await prisma.$transaction(tx => createOrderTx(tx, input, actor), { timeout: 20000 })
    refresh()
    return { success: true as const, data: { id: result.order.id, displayId: result.order.displayId, deliveryId: result.delivery?.id ?? null, warnings: result.warnings } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not create the sales order') }
  }
}

export async function createSalesOrderFromQuotation(data: unknown) {
  try {
    const actor = await requireActor(...SALES_ROLES)
    const input = fromQuotationSchema.parse(data)
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Quotation" WHERE id = ${input.quotationId} FOR UPDATE`
      const quotation = await tx.quotation.findUnique({
        where: { id: input.quotationId },
        include: { items: { orderBy: { sortOrder: 'asc' } }, salesOrder: { select: { id: true, displayId: true, status: true } } },
      })
      if (!quotation) throw new Error('Quotation not found')
      if (quotation.salesOrder?.status === 'CANCELLED') {
        // A cancelled order releases its quotation so it can be confirmed again.
        await tx.salesOrder.update({ where: { id: quotation.salesOrder.id }, data: { quotationId: null } })
        await logMessage(tx, 'SalesOrder', quotation.salesOrder.id, `Released quotation ${quotation.displayId} for re-confirmation`, { author: actor })
      } else if (quotation.salesOrder) throw new Error(`This quotation is already confirmed as ${quotation.salesOrder.displayId}`)
      if (quotation.status === 'REJECTED') throw new Error('A rejected quotation cannot be confirmed')
      // The legacy "Create Invoice" path links by a notes marker.
      const legacyInvoice = await tx.invoice.findFirst({ where: { notes: { contains: `Converted from quotation ${quotation.displayId}` }, invoiceStatus: 'ACTIVE' }, select: { displayId: true } })
      if (legacyInvoice) throw new Error(`This quotation was already invoiced directly as ${legacyInvoice.displayId}`)
      const unlinked = quotation.items.find(item => !item.productId)
      if (unlinked) throw new Error(`"${unlinked.name}" is not linked to an inventory product`)
      const created = await createOrderTx(tx, {
        quotationId: quotation.id,
        contactId: quotation.contactId,
        pricelistId: quotation.pricelistId ?? undefined,
        godownId: input.godownId ?? await bestFulfilmentGodown(tx, quotation.items.map(item => ({ productId: item.productId as number, quantity: item.quantity }))),
        salespersonId: input.salespersonId,
        invoicePolicy: input.invoicePolicy,
        commitmentDate: input.commitmentDate,
        projectName: quotation.projectName || undefined,
        dispatchAddress: quotation.dispatchAddress || undefined,
        supplyType: 'INTRASTATE',
        discountType: quotation.discountValue > 0 ? (quotation.discountType === 'FLAT' ? 'flat' : 'percent') : 'none',
        discountValue: quotation.discountValue,
        freightCharge: quotation.freightCharge,
        loadingCharge: quotation.loadingCharge,
        installationCharge: quotation.installationCharge,
        notes: stripBankDetails(quotation.notes) || undefined,
        lines: quotation.items.map(item => ({
          productId: item.productId as number,
          quantity: item.quantity,
          price: item.rate,
          unitOfMeasure: item.unitOfMeasure,
          areaSqft: item.areaSqft ?? undefined,
          coveragePerBox: item.coveragePerBox ?? undefined,
          gstRate: quotation.gstPercent,
          name: item.name,
        })),
      }, actor)
      if (quotation.status !== 'APPROVED') await tx.quotation.update({ where: { id: quotation.id }, data: { status: 'APPROVED' } })
      await logMessage(tx, 'Quotation', quotation.id, `Confirmed as sales order ${created.order.displayId}`, { author: actor })
      return created
    }, { timeout: 20000 })
    refresh()
    return { success: true as const, data: { id: result.order.id, displayId: result.order.displayId, deliveryId: result.delivery?.id ?? null, warnings: result.warnings } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not confirm the quotation') }
  }
}

function summarize<T extends { lines: { quantity: number; qtyDelivered: number; qtyInvoiced: number }[]; invoicePolicy: string; notes?: string | null }>(order: T) {
  // Older orders confirmed from quotations may still carry the hidden bank-details block.
  const notes = order.notes == null ? order.notes : stripBankDetails(order.notes)
  return { ...order, notes, deliveryStatus: deliveryStatus(order.lines), invoiceStatus: invoiceStatus(order.lines, order.invoicePolicy) }
}

export async function getSalesOrders(filters: { status?: string; search?: string } = {}) {
  try {
    await requireActor()
    const search = filters.search?.trim()
    const where = {
      ...(filters.status && filters.status !== 'ALL' ? { status: filters.status as 'CONFIRMED' | 'DONE' | 'CANCELLED' } : {}),
      ...(search ? { OR: [
        { displayId: { contains: search, mode: 'insensitive' as const } },
        { projectName: { contains: search, mode: 'insensitive' as const } },
        { contact: { name: { contains: search, mode: 'insensitive' as const } } },
        { contact: { phone: { contains: search } } },
      ] } : {}),
    }
    const include = {
      contact: { select: { id: true, name: true, phone: true } },
      salesperson: { select: { id: true, name: true } },
      godown: { select: { id: true, name: true } },
      lines: { select: { quantity: true, qtyDelivered: true, qtyInvoiced: true } },
      _count: { select: { pickings: true, invoices: true } },
    }
    // Every open order is returned (the To deliver / To invoice tabs depend on
    // them); only closed history is capped, so old open orders never vanish.
    const [open, closed] = await Promise.all([
      prisma.salesOrder.findMany({ where: { AND: [where, { status: 'CONFIRMED' }] }, orderBy: { id: 'desc' }, include }),
      prisma.salesOrder.findMany({ where: { AND: [where, { status: { not: 'CONFIRMED' } }] }, orderBy: { id: 'desc' }, take: 300, include }),
    ])
    const orders = [...open, ...closed].sort((a, b) => b.id - a.id)
    return { success: true as const, data: orders.map(summarize) }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load sales orders') }
  }
}

export async function getSalesOrder(id: number) {
  try {
    await requireActor()
    const order = await prisma.salesOrder.findUnique({
      where: { id },
      include: {
        contact: true,
        salesperson: { select: { id: true, name: true } },
        godown: { select: { id: true, name: true } },
        quotation: { select: { id: true, displayId: true } },
        lines: { orderBy: { sortOrder: 'asc' }, include: { product: { select: { stock: true, unitOfMeasure: true } } } },
        pickings: { orderBy: { id: 'asc' }, include: { lines: { select: { demandQty: true, doneQty: true } } } },
        invoices: { orderBy: { id: 'asc' }, select: { id: true, displayId: true, total: true, balanceDue: true, paymentStatus: true, invoiceStatus: true, date: true } },
      },
    })
    if (!order) return { success: false as const, error: 'Sales order not found' }
    const forecast = await computeForecast(prisma, { productIds: order.lines.map(line => line.productId), godownId: order.godownId })
    const charges = order.freightCharge + order.loadingCharge + order.installationCharge
    const invoicedTotal = order.invoices.filter(inv => inv.invoiceStatus === 'ACTIVE').reduce((sum, inv) => sum + inv.total, 0)
    return {
      success: true as const,
      data: {
        ...summarize(order),
        charges,
        invoicedTotal,
        lines: order.lines.map(line => ({ ...line, toInvoice: invoiceableQty(line, order.invoicePolicy), toRefund: refundableQty(line, order.invoicePolicy), forecast: forecast.get(line.productId) || null })),
      },
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load the sales order') }
  }
}

async function lockOrder(tx: Tx, id: number) {
  await tx.$queryRaw`SELECT id FROM "SalesOrder" WHERE id = ${id} FOR UPDATE`
  const order = await tx.salesOrder.findUnique({ where: { id }, include: { lines: { include: { product: { select: { isSlabTracked: true } } } }, contact: true, pickings: { where: { status: 'READY' }, select: { id: true } } } })
  if (!order) throw new Error('Sales order not found')
  return order
}

const invoiceSchema = z.object({
  orderId: z.number().int().positive(),
  dueDate: z.string().optional(),
  lines: z.array(z.object({ lineId: z.number().int().positive(), quantity: z.number().int().min(0) })).optional(),
})

// Odoo "Create Invoice": bills what the invoicing policy allows. Stock already
// left through delivery orders, so the invoice itself never moves inventory.
export async function createInvoiceFromSalesOrder(data: unknown) {
  try {
    const actor = await requireActor(...SALES_ROLES)
    const input = invoiceSchema.parse(data)
    const invoice = await prisma.$transaction(async tx => {
      const order = await lockOrder(tx, input.orderId)
      if (order.status === 'CANCELLED') throw new Error('A cancelled order cannot be invoiced')
      const requested = input.lines ? new Map(input.lines.map(line => [line.lineId, line.quantity])) : null
      const picks = order.lines.flatMap(line => {
        const allowed = invoiceableQty(line, order.invoicePolicy)
        const qty = requested ? Math.min(requested.get(line.id) ?? 0, allowed) : allowed
        if (requested && (requested.get(line.id) ?? 0) > allowed) throw new Error(`${line.name}: only ${allowed} can be invoiced (${order.invoicePolicy === 'DELIVERED' ? 'delivered, not yet invoiced' : 'ordered, not yet invoiced'})`)
        return qty > 0 ? [{ line, qty }] : []
      })
      if (picks.length === 0) {
        throw new Error(order.invoicePolicy === 'DELIVERED' ? 'Nothing to invoice yet — validate a delivery first, or switch the order to "Invoice ordered quantities".' : 'Everything on this order is already invoiced')
      }

      const priced = picks.map(({ line, qty }) => {
        // Stone billed on delivery uses the measured area of the slabs that left.
        const openSlabs = line.qtyDelivered - line.qtyInvoiced
        const openSqft = Math.max(0, line.deliveredSqft - line.invoicedSqft)
        const part = line.product.isSlabTracked && order.invoicePolicy === 'DELIVERED' && openSqft > 0
          ? { quantity: qty, price: line.price, unitOfMeasure: line.unitOfMeasure, coveragePerBox: null, areaSqft: qty >= openSlabs ? Math.round(openSqft * 100) / 100 : Math.round(openSqft * qty / openSlabs * 100) / 100 }
          : portionOf({ quantity: line.quantity, price: line.price, unitOfMeasure: line.unitOfMeasure, areaSqft: line.areaSqft, coveragePerBox: line.coveragePerBox }, qty)
        return { line, qty, part, amount: lineAmount(part) }
      })
      const pickedValue = priced.reduce((sum, row) => sum + row.amount, 0)
      // Percent discounts apply as-is; a flat order discount is spread by value.
      const discount = order.discountType === 'percent'
        ? orderDiscount(pickedValue, 'percent', order.discountValue)
        : order.discountType === 'flat' && order.subtotal > 0
          ? Math.round(Math.min(order.discountValue, order.subtotal) * pickedValue / order.subtotal)
          : 0
      const taxes = computeTaxes(priced.map(row => ({ amount: row.amount, gstRate: row.line.gstRate })), discount, order.supplyType)
      const charges = order.chargesInvoiced ? { freight: 0, loading: 0, installation: 0 } : { freight: order.freightCharge, loading: order.loadingCharge, installation: order.installationCharge }
      const chargeTotal = charges.freight + charges.loading + charges.installation
      const chargeTax = chargesTaxFor(taxes.lines, chargeTotal, order.supplyType)
      const total = taxes.taxable + taxes.gst + chargeTotal + chargeTax.gst

      const displayId = await nextInvoiceNumber(tx)
      const now = new Date()
      const created = await tx.invoice.create({
        data: {
          displayId,
          contactId: order.contactId,
          salesOrderId: order.id,
          subtotal: taxes.subtotal,
          discount: taxes.discount,
          discountType: order.discountType === 'none' ? 'none' : order.discountType,
          gst: taxes.gst + chargeTax.gst, chargesGst: chargeTax.gst,
          cgst: taxes.cgst + chargeTax.cgst, sgst: taxes.sgst + chargeTax.sgst, igst: taxes.igst + chargeTax.igst,
          freightCharge: charges.freight, loadingCharge: charges.loading, installationCharge: charges.installation,
          total, amountPaid: 0, balanceDue: total,
          paymentMethod: 'Credit', paymentStatus: 'PENDING', invoiceStatus: 'ACTIVE',
          godownId: order.godownId,
          supplyType: order.supplyType, placeOfSupply: order.placeOfSupply,
          date: now,
          time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
          dueDate: parseDate(input.dueDate),
          salespersonId: order.salespersonId,
          notes: `Invoiced from sales order ${order.displayId}`,
          items: {
            create: priced.map((row, index) => ({
              productId: row.line.productId,
              salesOrderLineId: row.line.id,
              name: row.line.name,
              sku: row.line.sku,
              quantity: row.qty,
              unitOfMeasure: row.line.unitOfMeasure,
              areaSqft: row.part.areaSqft ?? undefined,
              coveragePerBox: row.line.coveragePerBox ?? undefined,
              price: row.line.price,
              hsnCode: row.line.hsnCode,
              gstRate: row.line.gstRate,
              cgst: taxes.lines[index].cgst, sgst: taxes.lines[index].sgst, igst: taxes.lines[index].igst,
              taxableAmount: taxes.lines[index].taxable,
            })),
          },
        },
      })
      for (const row of priced) await tx.salesOrderLine.update({ where: { id: row.line.id }, data: { qtyInvoiced: { increment: row.qty }, invoicedSqft: { increment: Number(row.part.areaSqft) || 0 } } })
      if (!order.chargesInvoiced && (charges.freight || charges.loading || charges.installation)) await tx.salesOrder.update({ where: { id: order.id }, data: { chargesInvoiced: true } })
      await logMessage(tx, 'SalesOrder', order.id, `Invoice ${displayId} created for ₹${total.toLocaleString('en-IN')}`, { author: actor })
      await logMessage(tx, 'Invoice', created.id, `Created from sales order ${order.displayId}`, { author: actor })
      return created
    }, { timeout: 20000 })
    refresh()
    return { success: true as const, data: { id: invoice.id, displayId: invoice.displayId, total: invoice.total } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not create the invoice') }
  }
}

const updateSchema = z.object({
  id: z.number().int().positive(),
  commitmentDate: z.string().optional().nullable(),
  invoicePolicy: z.enum(['ORDERED', 'DELIVERED']).optional(),
  salespersonId: z.number().int().positive().optional().nullable(),
  dispatchAddress: z.string().trim().max(500).optional(),
  customerReference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(2000).optional(),
})

export async function updateSalesOrder(data: unknown) {
  try {
    const actor = await requireActor(...SALES_ROLES)
    const input = updateSchema.parse(data)
    await prisma.$transaction(async tx => {
      const order = await lockOrder(tx, input.id)
      if (order.status !== 'CONFIRMED') throw new Error('Only open sales orders can be edited')
      const next = {
        commitmentDate: input.commitmentDate === undefined ? order.commitmentDate : parseDate(input.commitmentDate || undefined),
        invoicePolicy: input.invoicePolicy ?? order.invoicePolicy,
        salespersonId: input.salespersonId === undefined ? order.salespersonId : input.salespersonId,
        dispatchAddress: input.dispatchAddress ?? order.dispatchAddress,
        customerReference: input.customerReference ?? order.customerReference,
        notes: input.notes ?? order.notes,
      }
      await tx.salesOrder.update({ where: { id: order.id }, data: next })
      if (next.commitmentDate && order.pickings.length) {
        await tx.stockPicking.updateMany({ where: { salesOrderId: order.id, status: 'READY' }, data: { scheduledDate: next.commitmentDate } })
      }
      await logTracking(tx, 'SalesOrder', order.id, 'Order updated', [
        ...(String(order.commitmentDate?.toISOString().slice(0, 10) ?? '') !== String(next.commitmentDate?.toISOString().slice(0, 10) ?? '') ? [{ field: 'Delivery date', from: order.commitmentDate?.toISOString().slice(0, 10) ?? null, to: next.commitmentDate?.toISOString().slice(0, 10) ?? null }] : []),
        ...(order.invoicePolicy !== next.invoicePolicy ? [{ field: 'Invoicing policy', from: order.invoicePolicy, to: next.invoicePolicy }] : []),
        ...(order.salespersonId !== next.salespersonId ? [{ field: 'Salesperson', from: order.salespersonId, to: next.salespersonId }] : []),
      ], actor)
    })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not update the sales order') }
  }
}

// Cancel: only before anything left the warehouse or was billed (Odoo asks
// for a return first). Lock: close a partially delivered order short.
export async function cancelSalesOrder(id: number) {
  try {
    const actor = await requireActor(...SALES_ROLES)
    await prisma.$transaction(async tx => {
      const order = await lockOrder(tx, id)
      if (order.status !== 'CONFIRMED') throw new Error('This order is already closed')
      if (order.lines.some(line => line.qtyDelivered > 0)) throw new Error('Goods were already delivered. Use "Lock" to close the rest of the order instead.')
      const activeInvoices = await tx.invoice.count({ where: { salesOrderId: id, invoiceStatus: 'ACTIVE' } })
      if (activeInvoices > 0) throw new Error('Cancel the order’s invoices first')
      for (const picking of order.pickings) await cancelPickingTx(tx, picking.id, actor)
      await releaseOrderSlabs(tx, order.id)
      await tx.salesOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
      await logTracking(tx, 'SalesOrder', id, 'Order cancelled', [{ field: 'Status', from: 'CONFIRMED', to: 'CANCELLED' }], actor)
    })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not cancel the order') }
  }
}

export async function lockSalesOrder(id: number) {
  try {
    const actor = await requireActor(...SALES_ROLES)
    await prisma.$transaction(async tx => {
      const order = await lockOrder(tx, id)
      if (order.status !== 'CONFIRMED') throw new Error('This order is already closed')
      for (const picking of order.pickings) await cancelPickingTx(tx, picking.id, actor)
      await releaseOrderSlabs(tx, order.id)
      await tx.salesOrder.update({ where: { id }, data: { status: 'DONE' } })
      await logTracking(tx, 'SalesOrder', id, 'Order locked', [{ field: 'Status', from: 'CONFIRMED', to: 'DONE' }], actor)
    })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not lock the order') }
  }
}

// Re-plan quantities whose delivery was cancelled (Odoo: re-run procurement).
export async function planSalesOrderDelivery(id: number) {
  try {
    const actor = await requireActor(...SALES_ROLES)
    const picking = await prisma.$transaction(async tx => {
      const order = await lockOrder(tx, id)
      if (order.status !== 'CONFIRMED') throw new Error('Only open orders can be delivered')
      const created = await createDeliveryForOrder(tx, id, actor)
      if (!created) throw new Error('Every ordered quantity is already planned or delivered')
      await logMessage(tx, 'SalesOrder', id, `Delivery ${created.displayId} planned`, { author: actor })
      return created
    })
    refresh()
    return { success: true as const, data: { id: picking.id, displayId: picking.displayId } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not plan the delivery') }
  }
}

// After a customer return, credit what was invoiced but not kept (Odoo
// "Create Invoice" with negative quantities → credit note), newest invoice first.
export async function createRefundFromSalesOrder(orderId: number) {
  try {
    const actor = await requireActor(...SALES_ROLES)
    const result = await prisma.$transaction(async tx => {
      const order = await lockOrder(tx, orderId)
      const refundLines = order.lines.map(line => ({ line, qty: refundableQty(line, order.invoicePolicy) })).filter(row => row.qty > 0)
      if (refundLines.length === 0) throw new Error('Nothing to refund — every invoiced quantity was kept by the customer')
      const items = await tx.invoiceItem.findMany({
        where: { salesOrderLineId: { in: refundLines.map(row => row.line.id) }, invoice: { invoiceStatus: 'ACTIVE' } },
        include: { invoice: { select: { id: true, displayId: true, total: true } } },
        orderBy: { invoiceId: 'desc' },
      })
      const perInvoice = new Map<number, { displayId: string; total: number; amount: number; parts: string[] }>()
      for (const { line, qty } of refundLines) {
        let left = qty
        for (const item of items.filter(row => row.salesOrderLineId === line.id)) {
          if (left === 0) break
          const take = Math.min(left, item.quantity)
          const gross = item.taxableAmount + item.cgst + item.sgst + item.igst
          const amount = Math.round(gross * take / item.quantity)
          const entry = perInvoice.get(item.invoice.id) || { displayId: item.invoice.displayId, total: item.invoice.total, amount: 0, parts: [] }
          entry.amount += amount
          entry.parts.push(`${line.name} × ${take}`)
          perInvoice.set(item.invoice.id, entry)
          const sqft = item.areaSqft ? Math.round(item.areaSqft * take / item.quantity * 100) / 100 : 0
          await tx.salesOrderLine.update({ where: { id: line.id }, data: { qtyInvoiced: { decrement: take }, invoicedSqft: { decrement: sqft } } })
          left -= take
        }
        if (left > 0) throw new Error(`${line.name}: ${left} invoiced unit(s) could not be matched to an active invoice`)
      }
      const created: string[] = []
      for (const [invoiceId, entry] of perInvoice) {
        const displayId = await nextCreditNoteNumber(tx)
        const credited = (await tx.creditNote.aggregate({ where: { invoiceId }, _sum: { amount: true } }))._sum.amount || 0
        const amount = Math.min(entry.amount, entry.total - credited)
        if (amount <= 0) continue
        await tx.creditNote.create({ data: { displayId, invoiceId, amount, reason: `Goods returned on ${order.displayId}: ${entry.parts.join(', ')}` } })
        // Stock already came back through the return; only the invoice status changes.
        if (credited + amount >= entry.total) await tx.invoice.update({ where: { id: invoiceId }, data: { invoiceStatus: 'REFUNDED' } })
        await refreshInvoiceBalance(tx, invoiceId)
        await logMessage(tx, 'Invoice', invoiceId, `Credit note ${displayId} for ₹${amount.toLocaleString('en-IN')} (customer return)`, { author: actor })
        created.push(`${displayId} on ${entry.displayId} (₹${amount.toLocaleString('en-IN')})`)
      }
      await logMessage(tx, 'SalesOrder', order.id, `Refund issued: ${created.join('; ')}`, { author: actor })
      return created
    }, { timeout: 20000 })
    refresh()
    return { success: true as const, data: result }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not create the refund') }
  }
}

export async function getSalesOrderStats() {
  try {
    await requireActor()
    const open = await prisma.salesOrder.findMany({
      where: { status: 'CONFIRMED' },
      select: { total: true, invoicePolicy: true, lines: { select: { quantity: true, qtyDelivered: true, qtyInvoiced: true } } },
    })
    const lateDeliveries = await prisma.stockPicking.count({ where: { pickingType: 'DELIVERY', status: 'READY', scheduledDate: { lt: startOfToday() } } })
    return {
      success: true as const,
      data: {
        open: open.length,
        openValue: open.reduce((sum, order) => sum + order.total, 0),
        toDeliver: open.filter(order => deliveryStatus(order.lines) !== 'DELIVERED').length,
        toInvoice: open.filter(order => invoiceStatus(order.lines, order.invoicePolicy) === 'TO_INVOICE').length,
        lateDeliveries,
      },
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load sales statistics') }
  }
}
