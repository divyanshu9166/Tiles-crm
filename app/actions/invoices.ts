'use server'

import { prisma } from '@/lib/db'
import { customerSupplyType } from '@/lib/erp/supply-type'
import { ledgerUnitCost, lockInventoryProducts } from '@/lib/inventory-stock'
import { requireRole, requireAuth } from '@/lib/auth-helpers'
import { revalidatePath } from 'next/cache'
import { createInvoiceSchema, updateInvoiceSchema, recordPaymentSchema, createCreditNoteSchema } from '@/lib/validations/invoice'
import { chargesTax, linePrice, principalGstRate, stockQuantity } from '@/lib/line-math'
import { nextCreditNoteNumber, refreshInvoiceBalance } from '@/lib/erp/credit-notes'
import { syncStoneLotTotals } from '@/lib/stone-inventory'
import type { PaymentStatus, InvoiceStatus } from '@prisma/client'
import { contactPhoneWhere, normalizePhone } from '@/lib/phone'
import { stripBankDetails } from '@/lib/quotation-notes'

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type InvoiceLineInput = {
  quantity: number
  price: number
  unitOfMeasure?: string
  areaSqft?: number
  coveragePerBox?: number
}

type InventoryInvoiceLine = InvoiceLineInput & {
  productId: number
  slabId?: number
  batchId?: number
}

// Shared with the POS screen (lib/line-math), so the cart total is the saved total.
function calculateInvoiceLineAmount(item: InvoiceLineInput) {
  return linePrice({ quantity: item.quantity, rate: item.price, unitOfMeasure: item.unitOfMeasure, areaSqft: item.areaSqft, coveragePerBox: item.coveragePerBox }).amount
}

// The stock quantity a line takes: a BOX tile sold by area takes the boxes
// that area needs (it used to bill 20 boxes and deduct the typed 1).
function resolveLineQuantity(item: InvoiceLineInput & { slabId?: number }) {
  if (item.slabId) return 1
  return stockQuantity({ quantity: item.quantity, rate: item.price, unitOfMeasure: item.unitOfMeasure, areaSqft: item.areaSqft, coveragePerBox: item.coveragePerBox })
}

async function resolveInvoiceGodownId(requestedId?: number) {
  if (requestedId) {
    const godown = await prisma.godown.findUnique({ where: { id: requestedId }, select: { id: true } })
    if (!godown) throw new Error('Selected godown was not found')
    return godown.id
  }

  let godown = await prisma.godown.findFirst({ where: { isDefault: true }, select: { id: true } })
  if (!godown) godown = await prisma.godown.findFirst({ orderBy: { id: 'asc' }, select: { id: true } })
  if (!godown) {
    godown = await prisma.godown.create({ data: { name: 'Main Showroom', type: 'Showroom', isDefault: true }, select: { id: true } })
  }
  return godown.id
}

async function syncProductStockInTransaction(tx: any, productId: number) {
  const total = await tx.godownStock.aggregate({ where: { productId }, _sum: { quantity: true } })
  await tx.product.update({ where: { id: productId }, data: { stock: total._sum.quantity || 0 } })
}

async function consumeInvoiceInventory(tx: any, invoiceId: number, items: InventoryInvoiceLine[], godownId: number) {
  await lockInventoryProducts(tx, items.map(item => item.productId))
  const standardQty = new Map<number, number>()
  for (const item of items) {
    if (item.slabId) continue
    standardQty.set(item.productId, (standardQty.get(item.productId) || 0) + Math.max(1, Number(item.quantity) || 1))
  }

  for (const [productId, quantity] of standardQty) {
    const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true, stock: true, isSlabTracked: true } })
    if (!product) throw new Error('One of the invoice products no longer exists')
    if (product.isSlabTracked) throw new Error('Slab-tracked stone must be invoiced with a selected physical slab')

    let stock = await tx.godownStock.findUnique({ where: { productId_godownId: { productId, godownId } } })
    if (!stock) {
      const existingGodownRows = await tx.godownStock.count({ where: { productId } })
      if (existingGodownRows === 0 && product.stock > 0) {
        stock = await tx.godownStock.create({ data: { productId, godownId, quantity: product.stock } })
        await tx.stockLedger.create({
          data: {
            productId,
            godownId,
            entryType: 'OPENING_BALANCE',
            quantity: product.stock,
            balanceAfter: product.stock,
            unitCost: await ledgerUnitCost(tx, productId),
            referenceType: 'Invoice',
            referenceId: invoiceId,
            notes: 'Legacy product stock migrated to the selected godown before sale',
          },
        })
      }
    }

    const currentQty = stock?.quantity || 0
    if (currentQty < quantity) {
      throw new Error(`Insufficient stock for product ${productId} in the selected godown`)
    }
    const nextQty = currentQty - quantity
    await tx.godownStock.upsert({
      where: { productId_godownId: { productId, godownId } },
      create: { productId, godownId, quantity: nextQty },
      update: { quantity: nextQty },
    })
    await tx.stockLedger.create({
      data: {
        productId,
        godownId,
        entryType: 'SALE',
        quantity: -quantity,
        balanceAfter: nextQty,
        unitCost: await ledgerUnitCost(tx, productId),
        referenceType: 'Invoice',
        referenceId: invoiceId,
      },
    })
    await tx.product.update({ where: { id: productId }, data: { sold: { increment: quantity } } })
    await syncProductStockInTransaction(tx, productId)
  }

  for (const item of items) {
    if (!item.batchId || item.slabId) continue
    const batch = await tx.productBatch.findUnique({ where: { id: item.batchId } })
    const quantity = Math.max(1, Number(item.quantity) || 1)
    if (!batch || batch.productId !== item.productId) throw new Error('Selected batch does not belong to the invoice product')
    if (batch.remainingQty < quantity) throw new Error(`Insufficient quantity in batch ${batch.batchNumber}`)
    await tx.productBatch.update({ where: { id: batch.id }, data: { remainingQty: { decrement: quantity } } })
  }
  for (const productId of standardQty.keys()) {
    const product = await tx.product.findUnique({ where: { id: productId }, select: { stock: true } })
    const batches = await tx.productBatch.aggregate({ where: { productId }, _sum: { remainingQty: true } })
    if ((batches._sum.remainingQty || 0) > (product?.stock || 0)) throw new Error('Select the batch/shade for this sale; the quantity exceeds unassigned stock')
  }
}

async function restoreInvoiceInventory(tx: any, invoice: any) {
  if (invoice.heldAt) return
  if (invoice.salesOrderId) {
    // Stock left through the sales order's delivery orders; cancelling the
    // invoice only re-opens its quantity for invoicing (Odoo behaviour).
    for (const item of invoice.items) {
      if (item.salesOrderLineId) await tx.salesOrderLine.updateMany({ where: { id: item.salesOrderLineId, qtyInvoiced: { gte: item.quantity } }, data: { qtyInvoiced: { decrement: item.quantity }, invoicedSqft: { decrement: Number(item.areaSqft) || 0 } } })
    }
    // The order's freight/loading/installation are billed once; if this invoice
    // carried them, the next invoice must bill them again.
    if ((invoice.freightCharge || 0) + (invoice.loadingCharge || 0) + (invoice.installationCharge || 0) > 0) {
      await tx.salesOrder.update({ where: { id: invoice.salesOrderId }, data: { chargesInvoiced: false } })
    }
    return
  }
  await lockInventoryProducts(tx, invoice.items.map((item: any) => item.productId))
  const godownId = invoice.godownId || await resolveInvoiceGodownId()
  const standardQty = new Map<number, number>()
  for (const item of invoice.items) {
    if (!item.slabId) standardQty.set(item.productId, (standardQty.get(item.productId) || 0) + Math.max(1, Number(item.quantity) || 1))
    if (item.batchId) await tx.productBatch.update({ where: { id: item.batchId }, data: { remainingQty: { increment: Math.max(1, Number(item.quantity) || 1) } } })
  }
  for (const [productId, quantity] of standardQty) {
    const existing = await tx.godownStock.findUnique({ where: { productId_godownId: { productId, godownId } } })
    const nextQty = (existing?.quantity || 0) + quantity
    await tx.godownStock.upsert({
      where: { productId_godownId: { productId, godownId } },
      create: { productId, godownId, quantity: nextQty },
      update: { quantity: nextQty },
    })
    await tx.stockLedger.create({
      data: { productId, godownId, entryType: 'RETURN', quantity, balanceAfter: nextQty, unitCost: await ledgerUnitCost(tx, productId), referenceType: 'Invoice', referenceId: invoice.id, notes: 'Inventory restored after invoice cancellation/refund' },
    })
    await tx.product.update({ where: { id: productId }, data: { sold: { decrement: quantity } } })
    await syncProductStockInTransaction(tx, productId)
  }
  const slabIds = invoice.items.filter((item: any) => item.slabId).map((item: any) => item.slabId)
  const slabRows = slabIds.length > 0
    ? await tx.slab.findMany({ where: { id: { in: slabIds } }, select: { id: true, lotId: true } })
    : []
  for (const item of invoice.items) {
    if (!item.slabId) continue
    await tx.slab.updateMany({
      where: { id: item.slabId, status: 'SOLD' },
      data: { status: 'AVAILABLE', soldPrice: null, soldAt: null },
    })
  }
  if (slabIds.length > 0) {
    const convertedLoans = await tx.sampleLoan.findMany({
      where: { slabId: { in: slabIds }, status: 'CONVERTED_TO_SALE' },
      select: { id: true, slabId: true },
    })
    if (convertedLoans.length > 0) {
      await tx.sampleLoan.updateMany({
        where: { id: { in: convertedLoans.map((loan: any) => loan.id) } },
        data: { status: 'OUT', returnedDate: null },
      })
      for (const loan of convertedLoans) {
        if (loan.slabId) {
          await tx.slab.updateMany({ where: { id: loan.slabId, status: 'AVAILABLE' }, data: { status: 'RESERVED' } })
        }
      }
    }
  }
  for (const lotId of new Set<number>(slabRows.map((slab: any) => Number(slab.lotId)))) {
    await syncStoneLotTotals(tx, lotId)
  }
}

// ─── GET ALL INVOICES ──────────────────────────────────

export async function getInvoices() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const invoices = await prisma.invoice.findMany({
    include: {
      contact: true,
      items: true,
      salesperson: true,
      payments: { orderBy: { date: 'desc' } },
      creditNotes: { orderBy: { date: 'desc' } },
    },
    orderBy: { date: 'desc' },
  })

  return {
    success: true,
    data: invoices.map(inv => ({
      id: inv.displayId,
      dbId: inv.id,
      customer: inv.contact.name,
      phone: inv.contact.phone,
      email: inv.contact.email,
      address: inv.contact.address,
      gstNumber: inv.contact.gstNumber,
      items: inv.items.map(i => ({
        name: i.name,
        sku: i.sku,
        qty: i.quantity,
        price: i.price,
        hsnCode: i.hsnCode,
        unitOfMeasure: i.unitOfMeasure,
        areaSqft: i.areaSqft,
        coveragePerBox: i.coveragePerBox,
        slabId: i.slabId,
        batchId: i.batchId,
      })),
      subtotal: inv.subtotal,
      discount: inv.discount,
      discountType: inv.discountType,
      gst: inv.gst,
      cgst: inv.cgst,
      sgst: inv.sgst,
      igst: inv.igst,
      supplyType: inv.supplyType,
      placeOfSupply: inv.placeOfSupply,
      transportCost: inv.transportCost,
      freightCharge: inv.freightCharge,
      loadingCharge: inv.loadingCharge,
      installationCharge: inv.installationCharge,
      roadPermit: inv.roadPermit,
      godownId: inv.godownId,
      total: inv.total,
      amountPaid: inv.amountPaid,
      balanceDue: inv.balanceDue,
      paymentMethod: inv.paymentMethod,
      paymentStatus: inv.paymentStatus.charAt(0) + inv.paymentStatus.slice(1).toLowerCase() as 'Paid' | 'Partial' | 'Pending',
      invoiceStatus: inv.invoiceStatus as InvoiceStatus,
      date: inv.date.toISOString().split('T')[0],
      time: inv.time,
      dueDate: inv.dueDate?.toISOString().split('T')[0] || null,
      salesperson: inv.salesperson?.name || null,
      salespersonId: inv.salespersonId,
      notes: inv.notes == null ? inv.notes : stripBankDetails(inv.notes),
      isHeld: !!inv.heldAt,
      payments: inv.payments.map(p => ({
        id: p.id,
        amount: p.amount,
        method: p.method,
        reference: p.reference,
        date: p.date.toISOString().split('T')[0],
        notes: p.notes,
      })),
      creditNotes: inv.creditNotes.map(cn => ({
        id: cn.id,
        displayId: cn.displayId,
        amount: cn.amount,
        reason: cn.reason,
        date: cn.date.toISOString().split('T')[0],
      })),
    })),
  }
}

// ─── GET SINGLE INVOICE ────────────────────────────────

export async function getInvoice(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      contact: true,
      items: { include: { product: true } },
      salesperson: true,
      payments: { orderBy: { date: 'desc' } },
      creditNotes: { orderBy: { date: 'desc' } },
    },
  })
  if (!invoice) return { success: false, error: 'Invoice not found' }
  return { success: true, data: { ...invoice, notes: invoice.notes == null ? invoice.notes : stripBankDetails(invoice.notes) } }
}

// ─── CREATE INVOICE ────────────────────────────────────

export async function createInvoice(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createInvoiceSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const {
    customer,
    phone,
    address,
    gstNumber,
    items,
    discount,
    discountType,
    payments,
    salespersonId,
    notes,
    dueDate,
    isHeld,
    transportCost,
    freightCharge,
    loadingCharge,
    installationCharge,
    roadPermit,
    godownId,
    supplyType,
    placeOfSupply,
    pricelistId,
  } = parsed.data

  const gstNumberValue = typeof gstNumber === 'string'
    ? gstNumber.trim().toUpperCase()
    : undefined

  // Find or create contact
  let contact = await prisma.contact.findFirst({ where: contactPhoneWhere(phone) })
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        name: customer,
        phone: normalizePhone(phone),
        address,
        ...(gstNumberValue ? { gstNumber: gstNumberValue } : {}),
      },
    })
  } else {
    const updateData: { name?: string; address?: string; gstNumber?: string | null } = {}
    if (contact.name !== customer) updateData.name = customer
    if (address && contact.address !== address) updateData.address = address
    if (gstNumberValue !== undefined && gstNumberValue !== contact.gstNumber) {
      updateData.gstNumber = gstNumberValue || null
    }
    if (Object.keys(updateData).length > 0) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: updateData,
      })
    }
  }

  // Get GST rate and invoice prefix from store settings (not hardcoded)
  const settings = await prisma.storeSettings.findFirst({ where: { id: 1 } })
  const gstRate = settings?.gstRate ?? 18
  const invoicePrefix = (settings?.invoicePrefix || 'INV-').trim() || 'INV-'
  const invoicePadding = settings?.invoicePadding ?? 4

  const slabIds = items.flatMap(item => item.slabId ? [item.slabId] : [])
  const invoiceGodownId = await resolveInvoiceGodownId(godownId)
  const productIds = Array.from(new Set(items.map(item => item.productId)))
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, isSlabTracked: true, coveragePerBox: true },
  })
  const productsById = new Map(products.map(product => [product.id, product]))
  if (products.length !== productIds.length) return { success: false, error: 'One or more invoice products no longer exist' }
  for (const item of items) {
    const product = productsById.get(item.productId)
    if (product?.isSlabTracked && !item.slabId) return { success: false, error: 'Select a physical slab for every slab-tracked stone line' }
    if (isHeld && item.slabId) return { success: false, error: 'Physical slab lines cannot be parked. Finalize a slab sale at checkout.' }
  }
  if (new Set(slabIds).size !== slabIds.length) return { success: false, error: 'A slab can only appear once on an invoice' }
  const slabs = slabIds.length > 0
    ? await prisma.slab.findMany({ where: { id: { in: slabIds } }, include: { lot: { select: { productId: true } } } })
    : []
  if (slabs.length !== slabIds.length) return { success: false, error: 'One or more selected slabs no longer exist' }
  const slabsById = new Map(slabs.map(slab => [slab.id, slab]))
  for (const item of items) {
    if (!item.slabId) continue
    const slab = slabsById.get(item.slabId)
    if (!slab || slab.lot.productId !== item.productId) return { success: false, error: 'Selected slab does not belong to its invoice product' }
    if (!['AVAILABLE', 'RESERVED'].includes(slab.status)) return { success: false, error: `Slab ${slab.slabNumber} is not available for sale` }
    if (slab.status === 'RESERVED' && slab.reservedForCustomId) return { success: false, error: `Slab ${slab.slabNumber} is reserved for a fabrication job and cannot be sold from POS` }
  }
  const activeSampleLoans = slabIds.length > 0
    ? await prisma.sampleLoan.findMany({
      where: { slabId: { in: slabIds }, status: 'OUT' },
      select: { id: true, slabId: true, contactId: true },
    })
    : []
  if (activeSampleLoans.some(loan => loan.contactId !== contact.id)) {
    return { success: false, error: 'A selected slab is issued as a sample to another customer' }
  }
  const activeSampleBySlab = new Map(activeSampleLoans.map(loan => [loan.slabId, loan]))
  for (const slab of slabs) {
    if (slab.status === 'RESERVED' && !activeSampleBySlab.has(slab.id)) {
      return { success: false, error: `Slab ${slab.slabNumber} is reserved and cannot be sold from POS` }
    }
  }

  const resolvedItems = items.map(item => {
    const unitOfMeasure = item.unitOfMeasure || (item.slabId ? 'SLAB' : 'PCS')
    const areaSqft = item.areaSqft ?? (item.slabId ? slabsById.get(item.slabId)?.sqft : undefined)
    const coveragePerBox = item.coveragePerBox ?? productsById.get(item.productId)?.coveragePerBox ?? undefined
    const line = { ...item, unitOfMeasure, areaSqft, coveragePerBox }
    return {
      ...line,
      quantity: resolveLineQuantity(line),
      lineAmount: calculateInvoiceLineAmount(line),
    }
  })

  // Calculate totals with per-item GST and measured-unit line amounts.
  const subtotal = resolvedItems.reduce((sum, item) => sum + item.lineAmount, 0)
  let discountAmount = 0
  if (discountType === 'flat') discountAmount = Math.min(discount, subtotal)
  else if (discountType === 'percent') discountAmount = Math.round(subtotal * discount / 100)

  let remainingDiscount = discountAmount
  const discountSplits = resolvedItems.map((item, index) => {
    if (discountAmount <= 0 || subtotal <= 0) return 0
    if (index === items.length - 1) return remainingDiscount
    const share = Math.round((item.lineAmount / subtotal) * discountAmount)
    remainingDiscount -= share
    return share
  })
  // Interstate is decided by the GSTIN state codes when both are known.
  const resolvedSupplyType = await customerSupplyType(prisma, contact.id, supplyType)
  const itemRows = resolvedItems.map((item, index) => {
    const lineTotal = item.lineAmount
    const discountShare = discountSplits[index] || 0
    const taxableAmount = Math.max(0, lineTotal - discountShare)
    const rate = typeof item.gstRate === 'number' ? item.gstRate : gstRate
    const itemGst = Math.round(taxableAmount * rate / 100)
    const igst = resolvedSupplyType === 'INTERSTATE' ? itemGst : 0
    const cgst = resolvedSupplyType === 'INTERSTATE' ? 0 : Math.round(itemGst / 2)
    const sgst = resolvedSupplyType === 'INTERSTATE' ? 0 : itemGst - cgst
    return {
      ...item,
      taxableAmount,
      gstRate: rate,
      igst,
      cgst,
      sgst,
      cess: 0,
      gstAmount: itemGst,
    }
  })

  const totalTaxable = itemRows.reduce((sum, item) => sum + item.taxableAmount, 0)
  // Transport/freight/loading/installation are part of the value of supply:
  // taxed at the principal line's rate (composite supply), as quotations do.
  const chargesTotal = (transportCost || 0) + (freightCharge || 0) + (loadingCharge || 0) + (installationCharge || 0)
  const chargeTax = chargesTax(chargesTotal, principalGstRate(itemRows.map(item => ({ taxable: item.taxableAmount, gstRate: item.gstRate })), gstRate), resolvedSupplyType === 'INTERSTATE')
  const totalGst = itemRows.reduce((sum, item) => sum + item.gstAmount, 0) + chargeTax.gst
  const igst = itemRows.reduce((sum, item) => sum + item.igst, 0) + chargeTax.igst
  const cgst = itemRows.reduce((sum, item) => sum + item.cgst, 0) + chargeTax.cgst
  const sgst = itemRows.reduce((sum, item) => sum + item.sgst, 0) + chargeTax.sgst
  const logisticsTotal = (transportCost || 0) + (freightCharge || 0) + (loadingCharge || 0) + (installationCharge || 0)
  const total = totalTaxable + totalGst + logisticsTotal

  // Calculate total payment
  const totalPayment = payments.reduce((sum, p) => sum + p.amount, 0)
  const amountPaid = Math.min(totalPayment, total) // can't overpay
  const balanceDue = total - amountPaid
  // Payment rows add up to what was applied: money handed back as change is
  // not cash received (it used to post ₹2,000 for an ₹1,180 bill).
  let leftToApply = amountPaid
  const paymentRows = payments.flatMap(payment => {
    const applied = Math.min(payment.amount, leftToApply)
    leftToApply -= applied
    if (applied <= 0) return []
    const change = payment.amount - applied
    const changeNote = change > 0 ? `Tendered ₹${payment.amount.toLocaleString('en-IN')}, change ₹${change.toLocaleString('en-IN')}` : null
    return [{ ...payment, amount: applied, notes: [payment.notes, changeNote].filter(Boolean).join(' · ') || undefined }]
  })

  // Determine payment status from actual payments
  let paymentStatus: PaymentStatus = 'PENDING'
  if (amountPaid >= total) paymentStatus = 'PAID'
  else if (amountPaid > 0) paymentStatus = 'PARTIAL'

  // Generate display ID using MAX + 1 (avoids race condition with count())
  const lastInvoice = await prisma.invoice.findFirst({
    where: { displayId: { startsWith: invoicePrefix } },
    orderBy: { id: 'desc' },
    select: { displayId: true },
  })
  let nextNum = 1
  if (lastInvoice?.displayId) {
    const match = lastInvoice.displayId.match(new RegExp(`^${escapeRegExp(invoicePrefix)}(\\d+)$`))
    if (match) nextNum = parseInt(match[1]) + 1
  }
  const displayId = `${invoicePrefix}${String(nextNum).padStart(invoicePadding, '0')}`

  const now = new Date()

  let invoice
  try {
    invoice = await prisma.$transaction(async tx => {
      const createdInvoice = await tx.invoice.create({
        data: {
      displayId,
      contactId: contact.id,
      pricelistId: pricelistId ?? contact.pricelistId ?? null,
      subtotal,
      discount: discountAmount,
      discountType,
      gst: totalGst,
      chargesGst: chargeTax.gst,
      cgst,
      sgst,
      igst,
      transportCost: transportCost || 0,
      freightCharge: freightCharge || 0,
      loadingCharge: loadingCharge || 0,
      installationCharge: installationCharge || 0,
      roadPermit: roadPermit?.trim() || null,
      godownId: invoiceGodownId,
      total,
      amountPaid,
      balanceDue,
      paymentMethod: amountPaid > 0 ? payments[0].method : (isHeld ? payments[0].method : 'Credit'), // primary method; unpaid bills are credit sales
      paymentStatus,
      invoiceStatus: 'ACTIVE',
      supplyType: resolvedSupplyType,
      placeOfSupply: placeOfSupply?.trim() || null,
      date: now,
      time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
      dueDate: dueDate ? new Date(dueDate) : null,
      salespersonId,
      notes,
      heldAt: isHeld ? now : null,
      items: {
        create: itemRows.map(item => ({
          productId: item.productId,
          name: item.name,
          sku: item.sku,
          quantity: item.quantity,
          unitOfMeasure: item.unitOfMeasure,
          areaSqft: item.areaSqft,
          coveragePerBox: item.coveragePerBox,
          price: item.price,
          slabId: item.slabId,
          batchId: item.batchId,
          hsnCode: item.hsnCode,
          gstRate: item.gstRate,
          cgst: item.cgst,
          sgst: item.sgst,
          igst: item.igst,
          cess: item.cess,
          taxableAmount: item.taxableAmount,
        })),
      },
      payments: {
        create: paymentRows.map(p => ({
          amount: p.amount,
          method: p.method,
          reference: p.reference,
          notes: p.notes,
          date: now,
        })),
      },
        },
      })

      if (!isHeld) {
        const soldLotIds = new Set<number>()
        for (const slabId of slabIds) {
          const invoiceItem = itemRows.find(item => item.slabId === slabId)
          const claimed = await tx.slab.updateMany({
            where: {
              id: slabId,
              OR: [
                { status: 'AVAILABLE' },
                { status: 'RESERVED', reservedForCustomId: null, sampleLoans: { some: { status: 'OUT', contactId: contact.id } } },
              ],
            },
            data: { status: 'SOLD', soldPrice: invoiceItem ? Math.round(invoiceItem.lineAmount) : null, soldAt: now },
          })
          if (claimed.count !== 1) throw new Error('A selected slab has just become unavailable. Refresh the slab list and try again.')
          const soldSlab = slabsById.get(slabId)
          if (soldSlab) soldLotIds.add(soldSlab.lotId)
        }
        if (slabIds.length > 0) {
          await tx.sampleLoan.updateMany({
            where: { slabId: { in: slabIds }, contactId: contact.id, status: 'OUT' },
            data: { status: 'CONVERTED_TO_SALE', returnedDate: now },
          })
        }
        for (const lotId of soldLotIds) await syncStoneLotTotals(tx, lotId)
        await consumeInvoiceInventory(tx, createdInvoice.id, itemRows as InventoryInvoiceLine[], invoiceGodownId)
      }

      return tx.invoice.findUnique({ where: { id: createdInvoice.id }, include: { items: true, payments: true } })
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not create invoice' }
  }

  revalidatePath('/billing')
  return { success: true, data: invoice }
}

// ─── UPDATE INVOICE (ADMIN ONLY) ──────────────────────

export async function updateInvoice(invoiceId: number, data: unknown) {
  try {
    await requireRole('ADMIN')
  } catch {
    return { success: false, error: 'Admin access required to edit invoices' }
  }

  const parsed = updateInvoiceSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const {
    customer,
    phone,
    address,
    gstNumber,
    items,
    discount,
    discountType,
    payments,
    salespersonId,
    notes,
    dueDate,
    transportCost,
    freightCharge,
    loadingCharge,
    installationCharge,
    roadPermit,
    supplyType,
    placeOfSupply,
  } = parsed.data

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { payments: true, items: { select: { productId: true, quantity: true, price: true, areaSqft: true, slabId: true, batchId: true, slab: { select: { sqft: true } } } } },
  })
  if (!invoice) return { success: false, error: 'Invoice not found' }

  // An issued bill has already taken stock and been posted to the books;
  // rewriting its lines silently broke both. Only parked bills can change
  // money or lines; issued bills keep their lines and totals.
  const isHeld = !!invoice.heldAt
  if (!isHeld) {
    const lineKey = (line: { productId: number; quantity: number; price: number; areaSqft?: number | null; slabId?: number | null; batchId?: number | null }) =>
      [line.productId, Number(line.quantity), Number(line.price), Math.round((Number(line.areaSqft) || 0) * 100), line.slabId || null, line.batchId || null].join(':')
    const before = invoice.items.map(lineKey).sort().join('|')
    const after = items.map(lineKey).sort().join('|')
    const chargesChanged = (transportCost || 0) !== invoice.transportCost || (freightCharge || 0) !== invoice.freightCharge
      || (loadingCharge || 0) !== invoice.loadingCharge || (installationCharge || 0) !== invoice.installationCharge
    const requestedDiscount = discountType === 'flat' ? Number(discount) || 0 : discountType === 'percent' ? null : 0
    const discountChanged = requestedDiscount !== null && requestedDiscount !== invoice.discount
    if (before !== after || chargesChanged || discountChanged) {
      return { success: false, error: 'This bill is already issued, so its items, prices, discount and charges cannot change. Issue a credit note and create a new bill instead.' }
    }
  }
  if (invoice.invoiceStatus !== 'ACTIVE') return { success: false, error: 'Only active invoices can be edited' }
  if (invoice.salesOrderId) return { success: false, error: 'This invoice belongs to a sales order. Cancel it and invoice again from the order so delivered and invoiced quantities stay in sync.' }

  // Replacing serialized slabs after sale would orphan the physical inventory trail.
  // Use a credit note and a fresh invoice for a slab substitution instead.
  const existingSlabIds = invoice.items.flatMap(item => item.slabId ? [item.slabId] : []).sort((a, b) => a - b)
  const requestedSlabIds = items.flatMap(item => item.slabId ? [item.slabId] : []).sort((a, b) => a - b)
  if (existingSlabIds.length !== requestedSlabIds.length || existingSlabIds.some((id, index) => id !== requestedSlabIds[index])) {
    return { success: false, error: 'Serialized slab lines cannot be changed after invoicing. Issue a credit note and create a new invoice instead.' }
  }
  const existingBatchIds = invoice.items.flatMap(item => item.batchId ? [item.batchId] : []).sort((a, b) => a - b)
  const requestedBatchIds = items.flatMap(item => item.batchId ? [item.batchId] : []).sort((a, b) => a - b)
  if (existingBatchIds.length !== requestedBatchIds.length || existingBatchIds.some((id, index) => id !== requestedBatchIds[index])) {
    return { success: false, error: 'Batch allocations cannot be changed after invoicing. Issue a credit note and create a new invoice instead.' }
  }

  const gstNumberValue = typeof gstNumber === 'string'
    ? gstNumber.trim().toUpperCase()
    : undefined

  let contact = await prisma.contact.findFirst({ where: contactPhoneWhere(phone) })
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        name: customer,
        phone: normalizePhone(phone),
        address,
        ...(gstNumberValue ? { gstNumber: gstNumberValue } : {}),
      },
    })
  } else {
    const updateData: { name?: string; address?: string; gstNumber?: string | null } = {}
    if (contact.name !== customer) updateData.name = customer
    if (address && contact.address !== address) updateData.address = address
    if (gstNumberValue !== undefined && gstNumberValue !== contact.gstNumber) {
      updateData.gstNumber = gstNumberValue || null
    }
    if (Object.keys(updateData).length > 0) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: updateData,
      })
    }
  }

  if (!isHeld) {
    const claimed = await prisma.invoice.updateMany({
      where: { id: invoiceId, invoiceStatus: 'ACTIVE', heldAt: null },
      data: {
        contactId: contact.id,
        roadPermit: roadPermit?.trim() || null,
        placeOfSupply: placeOfSupply?.trim() || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        salespersonId: salespersonId ?? null,
        notes: notes || null,
      },
    })
    if (claimed.count !== 1) return { success: false, error: 'This invoice changed meanwhile (cancelled or refunded). Refresh and try again.' }
    revalidatePath('/billing')
    return { success: true, data: await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } }) }
  }

  const settings = await prisma.storeSettings.findFirst({ where: { id: 1 } })
  const gstRate = settings?.gstRate ?? 18

  const resolvedItems = items.map(item => {
    const unitOfMeasure = item.unitOfMeasure || (item.slabId ? 'SLAB' : 'PCS')
    const storedSlab = item.slabId ? invoice.items.find(existingItem => existingItem.slabId === item.slabId)?.slab : null
    const areaSqft = item.areaSqft ?? storedSlab?.sqft
    const line = { ...item, unitOfMeasure, areaSqft }
    return { ...line, quantity: resolveLineQuantity(line), lineAmount: calculateInvoiceLineAmount(line) }
  })
  const subtotal = resolvedItems.reduce((sum, item) => sum + item.lineAmount, 0)
  let discountAmount = 0
  if (discountType === 'flat') discountAmount = Math.min(discount, subtotal)
  else if (discountType === 'percent') discountAmount = Math.round(subtotal * discount / 100)

  let remainingDiscount = discountAmount
  const discountSplits = resolvedItems.map((item, index) => {
    if (discountAmount <= 0 || subtotal <= 0) return 0
    if (index === items.length - 1) return remainingDiscount
    const share = Math.round((item.lineAmount / subtotal) * discountAmount)
    remainingDiscount -= share
    return share
  })

  // Interstate is decided by the GSTIN state codes when both are known.
  const resolvedSupplyType = isHeld ? await customerSupplyType(prisma, contact.id, supplyType) : (invoice.supplyType === 'INTERSTATE' ? 'INTERSTATE' : 'INTRASTATE')
  const itemRows = resolvedItems.map((item, index) => {
    const lineTotal = item.lineAmount
    const discountShare = discountSplits[index] || 0
    const taxableAmount = Math.max(0, lineTotal - discountShare)
    const rate = typeof item.gstRate === 'number' ? item.gstRate : gstRate
    const itemGst = Math.round(taxableAmount * rate / 100)
    const igst = resolvedSupplyType === 'INTERSTATE' ? itemGst : 0
    const cgst = resolvedSupplyType === 'INTERSTATE' ? 0 : Math.round(itemGst / 2)
    const sgst = resolvedSupplyType === 'INTERSTATE' ? 0 : itemGst - cgst
    return {
      ...item,
      taxableAmount,
      gstRate: rate,
      igst,
      cgst,
      sgst,
      cess: 0,
      gstAmount: itemGst,
    }
  })

  const totalTaxable = itemRows.reduce((sum, item) => sum + item.taxableAmount, 0)
  // Transport/freight/loading/installation are part of the value of supply:
  // taxed at the principal line's rate (composite supply), as quotations do.
  const chargesTotal = (transportCost || 0) + (freightCharge || 0) + (loadingCharge || 0) + (installationCharge || 0)
  const chargeTax = chargesTax(chargesTotal, principalGstRate(itemRows.map(item => ({ taxable: item.taxableAmount, gstRate: item.gstRate })), gstRate), resolvedSupplyType === 'INTERSTATE')
  const totalGst = itemRows.reduce((sum, item) => sum + item.gstAmount, 0) + chargeTax.gst
  const igst = itemRows.reduce((sum, item) => sum + item.igst, 0) + chargeTax.igst
  const cgst = itemRows.reduce((sum, item) => sum + item.cgst, 0) + chargeTax.cgst
  const sgst = itemRows.reduce((sum, item) => sum + item.sgst, 0) + chargeTax.sgst
  const total = totalTaxable + totalGst + (transportCost || 0) + (freightCharge || 0) + (loadingCharge || 0) + (installationCharge || 0)

  const paidSoFar = invoice.payments.reduce((sum, p) => sum + p.amount, 0)
  const amountPaid = Math.min(paidSoFar, total)
  const balanceDue = total - amountPaid

  let paymentStatus: PaymentStatus = 'PENDING'
  if (amountPaid >= total) paymentStatus = 'PAID'
  else if (amountPaid > 0) paymentStatus = 'PARTIAL'

  const paymentMethod = invoice.payments.length > 0
    ? invoice.paymentMethod
    : (payments?.[0]?.method || invoice.paymentMethod || 'Cash')

  let updated
  try {
    updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`
      const current = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { invoiceStatus: true, heldAt: true } })
      if (!current || current.invoiceStatus !== 'ACTIVE' || !current.heldAt) throw new Error('This parked bill was finalized or cancelled meanwhile. Refresh and try again.')
      return tx.invoice.update({
    where: { id: invoiceId },
    data: {
      contactId: contact.id,
      subtotal,
      discount: discountAmount,
      discountType,
      gst: totalGst,
      chargesGst: chargeTax.gst,
      cgst,
      sgst,
      igst,
      transportCost: transportCost || 0,
      freightCharge: freightCharge || 0,
      loadingCharge: loadingCharge || 0,
      installationCharge: installationCharge || 0,
      roadPermit: roadPermit?.trim() || null,
      total,
      amountPaid,
      balanceDue,
      paymentMethod,
      paymentStatus,
      supplyType: resolvedSupplyType,
      placeOfSupply: placeOfSupply?.trim() || null,
      dueDate: dueDate ? new Date(dueDate) : null,
      salespersonId: salespersonId ?? null,
      notes: notes || null,
      items: {
        deleteMany: {},
        create: itemRows.map(item => ({
          productId: item.productId,
          name: item.name,
          sku: item.sku,
          quantity: item.quantity,
          unitOfMeasure: item.unitOfMeasure,
          areaSqft: item.areaSqft,
          coveragePerBox: item.coveragePerBox,
          price: item.price,
          slabId: item.slabId,
          batchId: item.batchId,
          hsnCode: item.hsnCode,
          gstRate: item.gstRate,
          cgst: item.cgst,
          sgst: item.sgst,
          igst: item.igst,
          cess: item.cess,
          taxableAmount: item.taxableAmount,
        })),
      },
    },
    include: { items: true },
      })
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not update the bill' }
  }

  revalidatePath('/billing')
  return { success: true, data: updated }
}

// ─── RECORD ADDITIONAL PAYMENT ─────────────────────────

export async function recordPayment(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = recordPaymentSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { invoiceId, amount, method, reference, notes } = parsed.data

  // Locked and re-read: two cashiers paying the same bill used to save both
  // payments while amountPaid counted only one.
  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } })
      if (!invoice) throw new Error('Invoice not found')
      if (invoice.invoiceStatus !== 'ACTIVE') throw new Error('Cannot add payment to cancelled/refunded invoice')
      if (invoice.heldAt) throw new Error('Finalize the parked bill before taking more payments')
      if (invoice.balanceDue <= 0) throw new Error('Invoice is already fully paid')
      // Never cap silently: the cashier must know the extra wasn't recorded.
      if (amount > invoice.balanceDue) throw new Error(`Amount is more than the balance due (₹${invoice.balanceDue.toLocaleString('en-IN')}). Enter ₹${invoice.balanceDue.toLocaleString('en-IN')} or less and return the change.`)
      const paymentAmount = amount
      await tx.payment.create({ data: { invoiceId, amount: paymentAmount, method, reference, notes } })
      await tx.invoice.update({ where: { id: invoiceId }, data: { amountPaid: { increment: paymentAmount } } })
      await refreshInvoiceBalance(tx, invoiceId)
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not record the payment' }
  }

  revalidatePath('/billing')
  return { success: true }
}

// ─── CANCEL INVOICE ────────────────────────────────────

export async function cancelInvoice(invoiceId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } })
  if (!invoice) return { success: false, error: 'Invoice not found' }
  if (invoice.invoiceStatus !== 'ACTIVE') return { success: false, error: 'Invoice is already cancelled or refunded' }

  try {
    await prisma.$transaction(async tx => {
      // A bill with money or credit on it is refunded with a credit note, not
      // cancelled: cancelling reversed the sale while the payment stayed booked.
      const [paid, credited] = await Promise.all([
        tx.payment.aggregate({ where: { invoiceId, amount: { gt: 0 } }, _sum: { amount: true } }),
        tx.creditNote.count({ where: { invoiceId } }),
      ])
      if ((paid._sum.amount || 0) > 0 || credited > 0) throw new Error('This bill has payments or credit notes. Issue a full credit note to refund it instead of cancelling.')
      // Claim the cancellation first so concurrent requests restore stock once.
      const claimed = await tx.invoice.updateMany({ where: { id: invoiceId, invoiceStatus: 'ACTIVE' }, data: { invoiceStatus: 'CANCELLED' } })
      if (claimed.count !== 1) throw new Error('Invoice is already cancelled or refunded')
      await restoreInvoiceInventory(tx, invoice)
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not cancel invoice' }
  }

  revalidatePath('/billing')
  return { success: true }
}

// ─── CREATE CREDIT NOTE ────────────────────────────────

export async function createCreditNote(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createCreditNoteSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { invoiceId, amount, reason } = parsed.data

  if (!(amount > 0)) return { success: false, error: 'Credit note amount must be greater than zero' }

  try {
    await prisma.$transaction(async tx => {
      // Checked under a row lock: a double-click used to create two credit
      // notes and put the goods back into stock twice.
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } })
      if (!invoice) throw new Error('Invoice not found')
      if (invoice.invoiceStatus !== 'ACTIVE') throw new Error('Cannot create credit note for a cancelled or refunded invoice')
      if (invoice.heldAt) throw new Error('A parked bill has not been issued yet; cancel it instead')
      const creditedSoFar = (await tx.creditNote.aggregate({ where: { invoiceId }, _sum: { amount: true } }))._sum.amount || 0
      if (amount > invoice.total - creditedSoFar) throw new Error('Credit note cannot exceed the remaining invoice value')

      await tx.creditNote.create({ data: { displayId: await nextCreditNoteNumber(tx), invoiceId, amount, reason } })
      const { credited } = await refreshInvoiceBalance(tx, invoiceId)
      if (credited >= invoice.total) {
        // Fully credited = goods returned: claim the status first, then restore once.
        const claimed = await tx.invoice.updateMany({ where: { id: invoiceId, invoiceStatus: 'ACTIVE' }, data: { invoiceStatus: 'REFUNDED' } })
        if (claimed.count === 1) await restoreInvoiceInventory(tx, invoice)
      }
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not create the credit note' }
  }

  revalidatePath('/billing')
  return { success: true }
}

// ─── FINALIZE HELD BILL ────────────────────────────────

export async function finalizeHeldInvoice(invoiceId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } })
  if (!invoice) return { success: false, error: 'Invoice not found' }
  if (!invoice.heldAt) return { success: false, error: 'Invoice is not held' }

  try {
    const godownId = invoice.godownId || await resolveInvoiceGodownId()
    await prisma.$transaction(async tx => {
      // Only an active parked bill can be finalized: a cancelled one must never take stock.
      const released = await tx.invoice.updateMany({ where: { id: invoiceId, heldAt: { not: null }, invoiceStatus: 'ACTIVE' }, data: { heldAt: null } })
      if (released.count !== 1) throw new Error('This parked bill was already finalized or has been cancelled')
      await consumeInvoiceInventory(tx, invoiceId, invoice.items as InventoryInvoiceLine[], godownId)
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not finalize held invoice' }
  }

  revalidatePath('/billing')
  return { success: true }
}

// ─── SEARCH CONTACTS (for auto-complete) ───────────────

export async function searchContacts(query: string) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  if (!query || query.length < 2) return { success: true, data: [] }

  const contacts = await prisma.contact.findMany({
    where: {
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { phone: { contains: query } },
      ],
    },
    take: 10,
    orderBy: { updatedAt: 'desc' },
  })

  return {
    success: true,
    data: contacts.map(c => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      address: c.address,
      gstNumber: c.gstNumber,
    })),
  }
}

// ─── GET CUSTOMER PROFILE (returning customer detection) ──

export async function getCustomerProfile(phone: string, contactId?: number) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const selectFields = {
    id: true,
    name: true,
    phone: true,
    email: true,
    address: true,
    gstNumber: true,
    invoices: {
      where: { invoiceStatus: 'ACTIVE' as const },
      select: { total: true, date: true },
      orderBy: { date: 'desc' as const },
    },
    orders: {
      select: { amount: true, date: true },
      orderBy: { date: 'desc' as const },
    },
    customOrders: {
      select: { quotedPrice: true, date: true },
      orderBy: { date: 'desc' as const },
    },
  }

  let contact

  // If we have a direct contact ID (selected from autocomplete), use it — no ambiguity
  if (contactId) {
    contact = await prisma.contact.findUnique({ where: { id: contactId }, select: selectFields })
  } else {
    // Fallback: lookup by phone (last 10 digits) — used when phone is typed directly
    const phoneSuffix = phone?.replace(/\D/g, '').slice(-10) || ''
    if (phoneSuffix.length < 6) return { success: true, data: null }
    contact = await prisma.contact.findFirst({
      where: { phone: { contains: phoneSuffix } },
      select: selectFields,
    })
  }

  if (!contact) return { success: true, data: null }

  const totalInvoiceValue = contact.invoices.reduce((s, i) => s + i.total, 0)
  const totalOrderValue   = contact.orders.reduce((s, o) => s + o.amount, 0)
  const totalCustomValue  = contact.customOrders.reduce((s, c) => s + (c.quotedPrice || 0), 0)

  const allDates = [
    ...contact.invoices.map(i => i.date),
    ...contact.orders.map(o => o.date),
    ...contact.customOrders.map(c => c.date),
  ]
  const lastPurchaseDate = allDates.length > 0
    ? new Date(Math.max(...allDates.map(d => d.getTime())))
    : null

  return {
    success: true,
    data: {
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      address: contact.address,
      gstNumber: contact.gstNumber,
      invoiceCount: contact.invoices.length,
      orderCount: contact.orders.length,
      customOrderCount: contact.customOrders.length,
      totalInvoiceValue,
      totalOrderValue,
      totalCustomValue,
      lifetimeValue: totalInvoiceValue + totalOrderValue + totalCustomValue,
      lastPurchaseDate: lastPurchaseDate?.toISOString() || null,
    },
  }
}

// ─── GET INVOICE STATS ─────────────────────────────────

export async function getInvoiceStats() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)

  const [allInvoices, todayInvoices, monthInvoices, lastMonthInvoices] = await Promise.all([
    prisma.invoice.findMany({
      where: { invoiceStatus: 'ACTIVE', heldAt: null },
      select: { total: true, amountPaid: true, balanceDue: true, paymentStatus: true, dueDate: true, date: true },
    }),
    prisma.invoice.findMany({
      where: { invoiceStatus: 'ACTIVE', heldAt: null, date: { gte: todayStart } },
      select: { total: true, amountPaid: true },
    }),
    prisma.invoice.findMany({
      where: { invoiceStatus: 'ACTIVE', heldAt: null, date: { gte: monthStart } },
      select: { total: true, amountPaid: true },
    }),
    prisma.invoice.findMany({
      where: { invoiceStatus: 'ACTIVE', heldAt: null, date: { gte: lastMonthStart, lte: lastMonthEnd } },
      select: { total: true },
    }),
  ])

  const totalBilled = allInvoices.reduce((s, i) => s + i.total, 0)
  const totalCollected = allInvoices.reduce((s, i) => s + i.amountPaid, 0)
  const totalPending = allInvoices.reduce((s, i) => s + i.balanceDue, 0)
  // Overdue = unpaid past its due date (bills without a due date count from the bill date).
  const overdueCount = allInvoices.filter(i => i.balanceDue > 0 && (i.dueDate ? i.dueDate < todayStart : i.date < todayStart)).length

  const todayRevenue = todayInvoices.reduce((s, i) => s + i.amountPaid, 0)
  const todayCount = todayInvoices.length

  const monthRevenue = monthInvoices.reduce((s, i) => s + i.total, 0)
  const lastMonthRevenue = lastMonthInvoices.reduce((s, i) => s + i.total, 0)
  const monthGrowth = lastMonthRevenue > 0 ? Math.round(((monthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100) : 0

  return {
    success: true,
    data: {
      totalBilled,
      totalCollected,
      totalPending,
      overdueCount,
      todayRevenue,
      todayCount,
      monthRevenue,
      monthGrowth,
    },
  }
}
