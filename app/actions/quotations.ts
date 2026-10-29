'use server'

import { prisma } from '@/lib/db'
import { nextNumber } from '@/lib/erp/sequence'
import { revalidatePath } from 'next/cache'
import { createQuotationSchema, updateQuotationSchema, updateQuotationStatusSchema } from '@/lib/validations/quotation'
import { linePrice } from '@/lib/line-math'
import { createInvoice } from '@/app/actions/invoices'
import type { Quotation, QuotationItem, QuotationStatus, Contact, Product } from '@prisma/client'
import { requireAuth, requireRole } from '@/lib/auth-helpers'
import { contactPhoneWhere, normalizePhone } from '@/lib/phone'
import { stripBankDetails } from '@/lib/quotation-notes'

type QuotationWithRelations = Quotation & {
  contact: Contact
  items: (QuotationItem & { product: Product | null })[]
  salesOrder?: { id: number; displayId: string; status: string } | null
}

const statusDisplay: Record<QuotationStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
}

const defaultTerms = [
  'Extra work will be accounted separately.',
  '50% payment in advance with purchase order.',
  'Balance payment before dispatch of goods.',
  'GST at applicable rate will be charged extra.',
  'Labour to load/unload vehicle is at consignee expense.',
  'Packing charge and freight are at actual basis.',
  'Once order is confirmed, amendment or cancellation is not allowed.',
]

type QuotationBankDetails = {
  accountName?: string
  bankName?: string
  accountNumber?: string
  ifscCode?: string
  branchName?: string
  upiId?: string
}

const BANK_DETAILS_MARKER = '[[BANK_DETAILS]]'
const BANK_DETAILS_END_MARKER = '[[/BANK_DETAILS]]'

function normalizeBankDetails(details?: QuotationBankDetails | null): QuotationBankDetails {
  return {
    accountName: details?.accountName?.trim() || '',
    bankName: details?.bankName?.trim() || '',
    accountNumber: details?.accountNumber?.trim() || '',
    ifscCode: details?.ifscCode?.trim() || '',
    branchName: details?.branchName?.trim() || '',
    upiId: details?.upiId?.trim() || '',
  }
}

function hasAnyBankDetails(details: QuotationBankDetails) {
  return Object.values(details).some(value => Boolean(value))
}

function parseNotesMetadata(notes?: string | null): { bankDetails: QuotationBankDetails; cleanNotes: string } {
  const rawNotes = String(notes || '')
  const markerIndex = rawNotes.indexOf(BANK_DETAILS_MARKER)
  const endMarkerIndex = rawNotes.indexOf(BANK_DETAILS_END_MARKER)

  if (markerIndex === -1 || endMarkerIndex === -1 || endMarkerIndex < markerIndex) {
    return {
      bankDetails: normalizeBankDetails(),
      cleanNotes: rawNotes.trim(),
    }
  }

  const jsonChunk = rawNotes
    .slice(markerIndex + BANK_DETAILS_MARKER.length, endMarkerIndex)
    .trim()

  let parsedDetails: QuotationBankDetails = {}
  try {
    parsedDetails = JSON.parse(jsonChunk) as QuotationBankDetails
  } catch {
    parsedDetails = {}
  }

  const before = rawNotes.slice(0, markerIndex).trim()
  const after = rawNotes.slice(endMarkerIndex + BANK_DETAILS_END_MARKER.length).trim()
  const cleanNotes = [before, after].filter(Boolean).join('\n').trim()

  return {
    bankDetails: normalizeBankDetails(parsedDetails),
    cleanNotes,
  }
}

function buildNotesWithMetadata(notes?: string | null, bankDetails?: QuotationBankDetails | null) {
  const cleanNotes = String(notes || '').trim()
  const normalizedBankDetails = normalizeBankDetails(bankDetails)

  if (!hasAnyBankDetails(normalizedBankDetails)) {
    return cleanNotes || null
  }

  const metadata = `${BANK_DETAILS_MARKER}${JSON.stringify(normalizedBankDetails)}${BANK_DETAILS_END_MARKER}`
  return cleanNotes ? `${metadata}\n${cleanNotes}` : metadata
}

type ProductDescriptionSource = {
  description?: string | null
  material?: string | null
  color?: string | null
  category?: { name: string } | null
}

function getPreferredItemDescription(
  manualDescription?: string | null,
  product?: ProductDescriptionSource | null
) {
  const cleanManualDescription = String(manualDescription || '').trim()
  if (cleanManualDescription) return cleanManualDescription

  const productDescription = String(product?.description || '').trim()
  if (productDescription) return productDescription

  const detailParts: string[] = []
  if (product?.material?.trim()) detailParts.push(`Material: ${product.material.trim()}`)
  if (product?.color?.trim()) detailParts.push(`Color: ${product.color.trim()}`)
  if (product?.category?.name?.trim()) detailParts.push(`Category: ${product.category.name.trim()}`)

  return detailParts.length > 0 ? detailParts.join(' | ') : null
}

function calculateQuotationLineAmount(item: { quantity: number; rate: number; unitOfMeasure?: string; areaSqft?: number; coveragePerBox?: number }, product?: { unitOfMeasure?: string | null; coveragePerBox?: number | null } | null) {
  // Shared with the quotation screen (lib/line-math).
  return linePrice({
    quantity: item.quantity,
    rate: Math.max(0, Math.round(Number(item.rate) || 0)),
    unitOfMeasure: item.unitOfMeasure || product?.unitOfMeasure || 'PCS',
    areaSqft: item.areaSqft,
    coveragePerBox: item.coveragePerBox ?? product?.coveragePerBox,
  }).amount
}

function formatQuotation(quotation: QuotationWithRelations) {
  const { bankDetails, cleanNotes } = parseNotesMetadata(quotation.notes)

  const sortedItems = [...quotation.items]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(item => ({
      id: item.id,
      productId: item.productId,
      productName: item.product?.name || null,
      productImage: item.product?.image || null,
      name: item.name,
      sku: item.sku,
      description: item.description,
      quantity: item.quantity,
      unitOfMeasure: item.unitOfMeasure,
      areaSqft: item.areaSqft,
      coveragePerBox: item.coveragePerBox,
      rate: item.rate,
      amount: item.amount,
      referenceImage: item.referenceImage,
    }))

  const subtotal = sortedItems.reduce((sum, item) => sum + Number(item.amount || 0), 0)

  return {
    id: quotation.displayId,
    dbId: quotation.id,
    pricelistId: quotation.pricelistId,
    customer: quotation.contact.name,
    phone: quotation.contact.phone,
    email: quotation.emailId || quotation.contact.email || null,
    dispatchAddress: quotation.dispatchAddress || quotation.contact.address || null,
    date: quotation.date.toISOString().split('T')[0],
    validUntil: quotation.validUntil?.toISOString().split('T')[0] || null,
    projectName: quotation.projectName,
    deliveryMode: quotation.deliveryMode,
    roadPermit: quotation.roadPermit,
    contactPerson: quotation.contactPerson,
    subtotal,
    installationPercent: quotation.installationPercent,
    discountType: quotation.discountType,
    discountValue: quotation.discountValue,
    discountAmount: quotation.discountAmount,
    installationCharge: quotation.installationCharge,
    freightCharge: quotation.freightCharge,
    loadingCharge: quotation.loadingCharge,
    gstPercent: quotation.gstPercent,
    gstAmount: quotation.gstAmount,
    totalBeforeTax: quotation.totalBeforeTax,
    grandTotal: quotation.grandTotal,
    notes: cleanNotes,
    bankDetails,
    termsAndConditions: quotation.termsAndConditions,
    status: statusDisplay[quotation.status],
    statusKey: quotation.status,
    // A cancelled order no longer blocks confirming the quotation again.
    salesOrder: quotation.salesOrder && quotation.salesOrder.status !== 'CANCELLED' ? { id: quotation.salesOrder.id, displayId: quotation.salesOrder.displayId } : null,
    items: sortedItems,
  }
}

export async function getQuotations() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const quotations = await prisma.quotation.findMany({
    include: {
      contact: true,
      items: { include: { product: true } },
      salesOrder: { select: { id: true, displayId: true, status: true } },
    },
    orderBy: { date: 'desc' },
  })

  return {
    success: true,
    data: quotations.map(formatQuotation),
  }
}

export async function getQuotation(id: number) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const quotation = await prisma.quotation.findUnique({
    where: { id },
    include: {
      contact: true,
      items: { include: { product: true }, orderBy: { sortOrder: 'asc' } },
    },
  })

  if (!quotation) return { success: false, error: 'Quotation not found' }
  return { success: true, data: formatQuotation(quotation) }
}

export async function createQuotation(data: unknown) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const parsed = createQuotationSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const {
    customer,
    phone,
    email,
    dispatchAddress,
    date,
    validUntil,
    projectName,
    deliveryMode,
    roadPermit,
    contactPerson,
    installationPercent,
    discountType,
    discountValue,
    freightCharge,
    loadingCharge,
    gstPercent,
    bankDetails,
    notes,
    termsAndConditions,
    pricelistId,
    items,
  } = parsed.data

  const emailValue = email || undefined
  const addressValue = dispatchAddress || undefined

  let contact = await prisma.contact.findFirst({ where: contactPhoneWhere(phone) })
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        name: customer,
        phone: normalizePhone(phone),
        email: emailValue,
        address: addressValue,
      },
    })
  } else {
    const needsUpdate =
      contact.name !== customer ||
      (emailValue !== undefined && contact.email !== emailValue) ||
      (addressValue !== undefined && contact.address !== addressValue)

    if (needsUpdate) {
      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: {
          name: customer,
          email: emailValue,
          address: addressValue,
        },
      })
    }
  }

  const productIds = Array.from(new Set(items.map(item => item.productId).filter((id): id is number => !!id)))
  const products = productIds.length
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          name: true,
          sku: true,
          price: true,
          unitOfMeasure: true,
          coveragePerBox: true,
          description: true,
          material: true,
          color: true,
          category: { select: { name: true } },
        },
      })
    : []
  const productById = new Map(products.map(p => [p.id, p]))

  for (const item of items) {
    if (item.productId && !productById.has(item.productId)) {
      return { success: false, error: 'One of the selected products no longer exists' }
    }
  }

  const normalizedItems = items.map((item, idx) => {
    const product = item.productId ? productById.get(item.productId) : null
    const quantity = Math.max(1, item.quantity)
    const rate = Math.max(0, Math.round(item.rate ?? product?.price ?? 0))
    const unitOfMeasure = item.unitOfMeasure || product?.unitOfMeasure || 'PCS'
    const areaSqft = item.areaSqft == null ? null : Math.max(0, Number(item.areaSqft) || 0)
    const coveragePerBox = item.coveragePerBox == null ? product?.coveragePerBox ?? null : Math.max(0, Number(item.coveragePerBox) || 0)
    const amount = calculateQuotationLineAmount({ quantity, rate, unitOfMeasure, areaSqft: areaSqft ?? undefined, coveragePerBox: coveragePerBox ?? undefined }, product)

    return {
      productId: item.productId,
      name: item.name || product?.name || 'Item',
      sku: item.sku || product?.sku || null,
      description: getPreferredItemDescription(item.description, product),
      quantity,
      unitOfMeasure,
      areaSqft,
      coveragePerBox,
      rate,
      amount,
      referenceImage: item.referenceImage,
      sortOrder: idx,
    }
  })

  const subtotal = normalizedItems.reduce((sum, item) => sum + item.amount, 0)
  const normalizedDiscountType = discountType === 'FLAT' ? 'FLAT' : 'PERCENT'
  const normalizedDiscountValue = Math.max(0, Number(discountValue) || 0)
  const computedDiscountAmount = normalizedDiscountType === 'PERCENT'
    ? Math.round((subtotal * normalizedDiscountValue) / 100)
    : Math.round(normalizedDiscountValue)
  const discountAmount = Math.max(0, Math.min(subtotal, computedDiscountAmount))
  const subtotalAfterDiscount = Math.max(0, subtotal - discountAmount)
  const installationCharge = Math.round((subtotalAfterDiscount * installationPercent) / 100)
  const totalBeforeTax = subtotalAfterDiscount + installationCharge + freightCharge + loadingCharge
  const gstAmount = Math.round((totalBeforeTax * gstPercent) / 100)
  const grandTotal = totalBeforeTax + gstAmount
  const notesWithMetadata = buildNotesWithMetadata(notes, bankDetails)

  const quotation = await prisma.$transaction(async tx => tx.quotation.create({
    data: {
      displayId: await nextNumber(tx, { table: 'Quotation', prefix: 'Q.', lock: 82463215, padding: 0, start: 1000 }),
      contactId: contact.id,
      pricelistId: pricelistId ?? contact.pricelistId ?? null,
      date: date ? new Date(date) : new Date(),
      validUntil: validUntil ? new Date(validUntil) : null,
      projectName,
      deliveryMode,
      roadPermit,
      emailId: emailValue,
      contactPerson,
      dispatchAddress: addressValue,
      installationPercent,
      discountType: normalizedDiscountType,
      discountValue: normalizedDiscountValue,
      discountAmount,
      installationCharge,
      freightCharge,
      loadingCharge,
      gstPercent,
      gstAmount,
      totalBeforeTax,
      grandTotal,
      notes: notesWithMetadata,
      termsAndConditions: termsAndConditions.length > 0 ? termsAndConditions : defaultTerms,
      status: 'DRAFT',
      items: {
        create: normalizedItems,
      },
    },
    include: {
      contact: true,
      items: { include: { product: true } },
    },
  }))

  revalidatePath('/quotations')
  return { success: true, data: formatQuotation(quotation) }
}

export async function updateQuotation(data: unknown) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const parsed = updateQuotationSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const {
    id,
    customer,
    phone,
    email,
    dispatchAddress,
    date,
    validUntil,
    projectName,
    deliveryMode,
    roadPermit,
    contactPerson,
    installationPercent,
    discountType,
    discountValue,
    freightCharge,
    loadingCharge,
    gstPercent,
    bankDetails,
    notes,
    termsAndConditions,
    pricelistId,
    items,
  } = parsed.data

  const existing = await prisma.quotation.findUnique({
    where: { id },
    include: { contact: true },
  })
  if (!existing) return { success: false, error: 'Quotation not found' }

  const emailValue = email || undefined
  const addressValue = dispatchAddress || undefined

  let contact = existing.contact
  if (contact.phone === phone) {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: {
        name: customer,
        email: emailValue,
        address: addressValue,
      },
    })
  } else {
    const matchedContact = await prisma.contact.findFirst({ where: contactPhoneWhere(phone) })
    if (!matchedContact) {
      contact = await prisma.contact.create({
        data: {
          name: customer,
          phone: normalizePhone(phone),
          email: emailValue,
          address: addressValue,
        },
      })
    } else {
      contact = await prisma.contact.update({
        where: { id: matchedContact.id },
        data: {
          name: customer,
          email: emailValue,
          address: addressValue,
        },
      })
    }
  }

  const productIds = Array.from(new Set(items.map(item => item.productId).filter((productId): productId is number => !!productId)))
  const products = productIds.length
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          name: true,
          sku: true,
          price: true,
          unitOfMeasure: true,
          coveragePerBox: true,
          description: true,
          material: true,
          color: true,
          category: { select: { name: true } },
        },
      })
    : []
  const productById = new Map(products.map(product => [product.id, product]))

  for (const item of items) {
    if (item.productId && !productById.has(item.productId)) {
      return { success: false, error: 'One of the selected products no longer exists' }
    }
  }

  const normalizedItems = items.map((item, idx) => {
    const product = item.productId ? productById.get(item.productId) : null
    const quantity = Math.max(1, item.quantity)
    const rate = Math.max(0, Math.round(item.rate ?? product?.price ?? 0))
    const unitOfMeasure = item.unitOfMeasure || product?.unitOfMeasure || 'PCS'
    const areaSqft = item.areaSqft == null ? null : Math.max(0, Number(item.areaSqft) || 0)
    const coveragePerBox = item.coveragePerBox == null ? product?.coveragePerBox ?? null : Math.max(0, Number(item.coveragePerBox) || 0)
    const amount = calculateQuotationLineAmount({ quantity, rate, unitOfMeasure, areaSqft: areaSqft ?? undefined, coveragePerBox: coveragePerBox ?? undefined }, product)

    return {
      productId: item.productId,
      name: item.name || product?.name || 'Item',
      sku: item.sku || product?.sku || null,
      description: getPreferredItemDescription(item.description, product),
      quantity,
      unitOfMeasure,
      areaSqft,
      coveragePerBox,
      rate,
      amount,
      referenceImage: item.referenceImage,
      sortOrder: idx,
    }
  })

  const subtotal = normalizedItems.reduce((sum, item) => sum + item.amount, 0)
  const normalizedDiscountType = discountType === 'FLAT' ? 'FLAT' : 'PERCENT'
  const normalizedDiscountValue = Math.max(0, Number(discountValue) || 0)
  const computedDiscountAmount = normalizedDiscountType === 'PERCENT'
    ? Math.round((subtotal * normalizedDiscountValue) / 100)
    : Math.round(normalizedDiscountValue)
  const discountAmount = Math.max(0, Math.min(subtotal, computedDiscountAmount))
  const subtotalAfterDiscount = Math.max(0, subtotal - discountAmount)
  const installationCharge = Math.round((subtotalAfterDiscount * installationPercent) / 100)
  const totalBeforeTax = subtotalAfterDiscount + installationCharge + freightCharge + loadingCharge
  const gstAmount = Math.round((totalBeforeTax * gstPercent) / 100)
  const grandTotal = totalBeforeTax + gstAmount
  const { bankDetails: existingBankDetails, cleanNotes: existingCleanNotes } = parseNotesMetadata(existing.notes)
  const notesWithMetadata = buildNotesWithMetadata(notes ?? existingCleanNotes, bankDetails ?? existingBankDetails)

  const quotation = await prisma.quotation.update({
    where: { id },
    data: {
      contactId: contact.id,
      pricelistId: pricelistId ?? contact.pricelistId ?? null,
      date: date ? new Date(date) : existing.date,
      validUntil: validUntil ? new Date(validUntil) : null,
      projectName,
      deliveryMode,
      roadPermit,
      emailId: emailValue,
      contactPerson,
      dispatchAddress: addressValue,
      installationPercent,
      discountType: normalizedDiscountType,
      discountValue: normalizedDiscountValue,
      discountAmount,
      installationCharge,
      freightCharge,
      loadingCharge,
      gstPercent,
      gstAmount,
      totalBeforeTax,
      grandTotal,
      notes: notesWithMetadata,
      termsAndConditions: termsAndConditions.length > 0 ? termsAndConditions : defaultTerms,
      items: {
        deleteMany: {},
        create: normalizedItems,
      },
    },
    include: {
      contact: true,
      items: { include: { product: true } },
    },
  })

  revalidatePath('/quotations')
  return { success: true, data: formatQuotation(quotation) }
}

export async function updateQuotationStatus(data: unknown) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const parsed = updateQuotationStatusSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  await prisma.quotation.update({
    where: { id: parsed.data.id },
    data: { status: parsed.data.status },
  })

  revalidatePath('/quotations')
  return { success: true }
}

/**
 * Creates a parked invoice from an accepted quotation. The invoice remains held
 * so payment and, for slab-tracked products, physical slab allocation can be
 * completed at checkout without consuming inventory prematurely.
 */
export async function convertQuotationToInvoice(quotationId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const quotation = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: {
      contact: true,
      items: { include: { product: true }, orderBy: { sortOrder: 'asc' } },
    },
  })

  if (!quotation) return { success: false, error: 'Quotation not found' }
  const salesOrder = await prisma.salesOrder.findUnique({ where: { quotationId }, select: { displayId: true, status: true } })
  if (salesOrder && salesOrder.status !== 'CANCELLED') return { success: false, error: `This quotation is confirmed as sales order ${salesOrder.displayId}; invoice it from the order` }
  if (quotation.status === 'DRAFT' || quotation.status === 'REJECTED') {
    return { success: false, error: 'Only sent or approved quotations can be converted to an invoice' }
  }

  const marker = `Converted from quotation ${quotation.displayId}`
  // Only an active invoice blocks a new one (a cancelled one used to block it
  // forever), and Q.1000 must not match Q.10000.
  const exact = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`)
  const candidates = await prisma.invoice.findMany({
    where: { notes: { contains: marker }, invoiceStatus: 'ACTIVE' },
    select: { id: true, displayId: true, heldAt: true, notes: true },
  })
  const existing = candidates.find(invoice => exact.test(invoice.notes || ''))
  if (existing) {
    return { success: false, error: `This quotation is already linked to invoice ${existing.displayId}` }
  }

  const missingProduct = quotation.items.find(item => !item.productId || !item.product)
  if (missingProduct) {
    return { success: false, error: `Item "${missingProduct.name}" is not linked to an inventory product` }
  }

  const slabItem = quotation.items.find(item => item.product?.isSlabTracked)
  if (slabItem) {
    return {
      success: false,
      error: `Quotation item "${slabItem.name}" is slab-tracked. Select the physical slab in Billing before invoicing this quotation.`,
    }
  }

  const invoiceResult = await createInvoice({
    customer: quotation.contact.name,
    phone: quotation.contact.phone,
    address: quotation.dispatchAddress || quotation.contact.address || undefined,
    gstNumber: quotation.contact.gstNumber || undefined,
    pricelistId: quotation.pricelistId ?? undefined,
    items: quotation.items.map(item => ({
      productId: item.productId as number,
      name: item.name,
      sku: item.sku || item.product?.sku || '',
      quantity: item.quantity,
      price: item.rate,
      unitOfMeasure: item.unitOfMeasure,
      areaSqft: item.areaSqft || undefined,
      coveragePerBox: item.coveragePerBox || undefined,
      hsnCode: item.product?.hsnCode || undefined,
      gstRate: quotation.gstPercent,
    })),
    discount: quotation.discountValue,
    discountType: quotation.discountType === 'FLAT' ? 'flat' : 'percent',
    payments: [{ amount: 0, method: 'Cash', notes: marker }],
    isHeld: true,
    freightCharge: quotation.freightCharge,
    loadingCharge: quotation.loadingCharge,
    installationCharge: quotation.installationCharge,
    roadPermit: quotation.roadPermit || undefined,
    notes: [marker, stripBankDetails(quotation.notes)].filter(Boolean).join('\n'),
  })

  if (!invoiceResult.success) return invoiceResult

  if (quotation.status !== 'APPROVED') {
    await prisma.quotation.update({ where: { id: quotation.id }, data: { status: 'APPROVED' } })
  }
  revalidatePath('/quotations')
  revalidatePath('/billing')
  return { success: true, data: invoiceResult.data }
}

export async function getQuotationStats() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const [total, draft, sent, approved, rejected, totalValue] = await Promise.all([
    prisma.quotation.count(),
    prisma.quotation.count({ where: { status: 'DRAFT' } }),
    prisma.quotation.count({ where: { status: 'SENT' } }),
    prisma.quotation.count({ where: { status: 'APPROVED' } }),
    prisma.quotation.count({ where: { status: 'REJECTED' } }),
    prisma.quotation.aggregate({ _sum: { grandTotal: true } }),
  ])

  return {
    success: true,
    data: {
      total,
      draft,
      sent,
      approved,
      rejected,
      totalValue: totalValue._sum.grandTotal || 0,
    },
  }
}
