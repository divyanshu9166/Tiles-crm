'use server'

import { prisma } from '@/lib/db'
import { lockInventoryProducts } from '@/lib/inventory-stock'
import { revalidatePath } from 'next/cache'
import { requireRole, requireAuth } from '@/lib/auth-helpers'
import { syncProductStockFromGodowns } from './godowns'
import { syncStoneLotTotals } from '@/lib/stone-inventory'
import {
  InvoiceStatus,
  LeadStatus,
  OrderSource,
  OrderStatus,
  PaymentStatus,
  POStatus,
  QuotationStatus,
  WalkinStatus,
} from '@prisma/client'

const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000

const getDraftExpiry = (now: Date) => new Date(now.getTime() + DRAFT_TTL_MS)

const leadStatusValues = new Set(Object.values(LeadStatus))
const walkinStatusValues = new Set(Object.values(WalkinStatus))
const orderStatusValues = new Set(Object.values(OrderStatus))
const paymentStatusValues = new Set(Object.values(PaymentStatus))
const orderSourceValues = new Set(Object.values(OrderSource))
const quotationStatusValues = new Set(Object.values(QuotationStatus))
const invoiceStatusValues = new Set(Object.values(InvoiceStatus))
const poStatusValues = new Set(Object.values(POStatus))

function coerceEnum<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  if (typeof value === 'string' && allowed.has(value)) return value as T
  return fallback
}

async function adjustGodownStockWithTx(tx: any, params: {
  productId: number
  godownId: number
  quantity: number
  entryType: string
  referenceType?: string
  referenceId?: number
  notes?: string
  createdBy?: string
}) {
  await lockInventoryProducts(tx, [params.productId])
  const existing = await tx.godownStock.findUnique({
    where: { productId_godownId: { productId: params.productId, godownId: params.godownId } },
  })
  const currentQty = existing?.quantity || 0
  const newQty = currentQty + params.quantity
  if (newQty < 0) throw new Error('Insufficient stock to restore this document')

  await tx.godownStock.upsert({
    where: { productId_godownId: { productId: params.productId, godownId: params.godownId } },
    create: { productId: params.productId, godownId: params.godownId, quantity: newQty },
    update: { quantity: newQty },
  })

  await tx.stockLedger.create({
    data: {
      productId: params.productId,
      godownId: params.godownId,
      entryType: params.entryType,
      quantity: params.quantity,
      balanceAfter: newQty,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      notes: params.notes,
      createdBy: params.createdBy,
    },
  })

  await syncProductStockFromGodowns(params.productId, tx)

  return newQty
}

// ─── MOVE CUSTOM ORDER TO DRAFT ────────────────────────

export async function moveCustomOrderToDraft(orderId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const order = await prisma.customOrder.findUnique({
    where: { id: orderId },
    include: {
      contact: { select: { name: true } },
      assignedStaff: { select: { name: true } },
      referenceProduct: { select: { id: true, name: true, sku: true, price: true } },
      timeline: true,
      productionOrders: { select: { displayId: true, status: true } },
    },
  })
  if (!order) return { success: false, error: 'Order not found' }
  if (order.status === 'DELIVERED') return { success: false, error: 'Delivered fabrication jobs must remain in the order history' }
  if (order.productionOrders.length > 0) {
    return { success: false, error: 'Remove the linked production order before moving this fabrication job to drafts' }
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) // +30 days

  // Snapshot the full order data
  const snapshot = {
    displayId: order.displayId,
    customer: order.contact.name,
    phone: order.phone,
    address: order.address,
    type: order.type,
    status: order.status,
    assignedStaff: order.assignedStaff?.name || null,
    date: order.date.toISOString(),
    estimatedDelivery: order.estimatedDelivery?.toISOString() || null,
    measurements: order.measurements,
    referenceImages: order.referenceImages,
    referenceProduct: order.referenceProduct,
    materials: order.materials,
    color: order.color,
    quotedPrice: order.quotedPrice,
    advancePaid: order.advancePaid,
    productionNotes: order.productionNotes,
    installationType: order.installationType,
    edgeProfile: order.edgeProfile,
    cutouts: order.cutouts,
    templateMethod: order.templateMethod,
    areaSqft: order.areaSqft,
    wastagePercent: order.wastagePercent,
    timeline: order.timeline.map(t => ({
      event: t.event,
      date: t.date.toISOString(),
      notes: t.notes,
      status: t.status,
      updatedBy: t.updatedBy,
    })),
  }

  await prisma.$transaction(async tx => {
    // Drafting/removing a custom order releases any slab reservations so they
    // cannot remain permanently locked after the order leaves the workflow.
    const reservedSlabs = await tx.slab.findMany({
      where: { reservedForCustomId: orderId, status: { in: ['RESERVED', 'IN_PROCESSING'] } },
      select: { id: true, lotId: true },
    })
    await tx.slab.updateMany({
      where: { reservedForCustomId: orderId, status: { in: ['RESERVED', 'IN_PROCESSING'] } },
      data: { status: 'AVAILABLE', reservedForCustomId: null },
    })
    for (const lotId of new Set(reservedSlabs.map(slab => slab.lotId))) {
      await syncStoneLotTotals(tx, lotId)
    }
    await tx.draft.create({
      data: {
        sourceType: 'CustomOrder',
        sourceId: order.displayId,
        data: snapshot,
        deletedBy: 'Manager',
        deletedAt: now,
        expiresAt,
      },
    })
    // Delete timeline entries first (cascade should handle but being explicit)
    await tx.customOrderTimeline.deleteMany({ where: { customOrderId: orderId } })
    // Unlink field visits from this order (don't delete visits, just unlink)
    await tx.fieldVisit.updateMany({
      where: { customOrderId: orderId },
      data: { customOrderId: null },
    })
    // Delete the custom order
    await tx.customOrder.delete({ where: { id: orderId } })
  })

  revalidatePath('/custom-orders')
  revalidatePath('/staff-portal')
  revalidatePath('/drafts')
  return { success: true }
}

// ─── MOVE SELF VISIT TO DRAFT ─────────────────────────

export async function moveSelfVisitToDraft(visitId: number) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const visit = await prisma.fieldVisit.findUnique({
    where: { id: visitId },
    include: { staff: { select: { name: true } } },
  })
  if (!visit) return { success: false, error: 'Visit not found' }
  const viewer = await requireAuth()
  if (viewer.user.role === 'STAFF' && Number(viewer.user.staffId) !== visit.staffId) return { success: false, error: 'You can only delete your own visits' }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

  const snapshot = {
    displayId: visit.displayId,
    staffName: visit.staff.name,
    staffId: visit.staffId,
    customer: visit.customer,
    address: visit.address,
    date: visit.date.toISOString(),
    time: visit.time,
    status: visit.status,
    type: visit.type,
    notes: visit.notes,
    staffNotes: visit.staffNotes,
    measurements: visit.measurements,
    photos: visit.photos,
    photoUrls: visit.photoUrls,
  }

  await prisma.$transaction([
    prisma.draft.create({
      data: {
        sourceType: 'FieldVisit',
        sourceId: visit.displayId,
        data: snapshot,
        deletedBy: visit.staff.name,
        deletedAt: now,
        expiresAt,
      },
    }),
    prisma.fieldVisit.delete({ where: { id: visitId } }),
  ])

  revalidatePath('/staff-portal')
  revalidatePath('/staff')
  revalidatePath('/drafts')
  return { success: true }
}

// ─── MOVE LEAD TO DRAFT ─────────────────────────────

export async function moveLeadToDraft(leadId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      contact: true,
      followUps: true,
      assignedTo: { select: { name: true } },
    },
  })
  if (!lead) return { success: false, error: 'Lead not found' }

  const now = new Date()
  const expiresAt = getDraftExpiry(now)

  const snapshot = {
    displayId: `LEAD-${lead.id}`,
    customer: lead.contact.name,
    phone: lead.contact.phone,
    email: lead.contact.email,
    address: lead.contact.address,
    status: lead.status,
    interest: lead.interest,
    materialCategory: lead.materialCategory,
    applicationArea: lead.applicationArea,
    areaSqft: lead.areaSqft,
    budget: lead.budget,
    source: lead.source,
    date: lead.date.toISOString(),
    notes: lead.notes,
    assignedToId: lead.assignedToId,
    assignedTo: lead.assignedTo?.name || null,
    followUps: lead.followUps.map(f => ({
      day: f.day,
      message: f.message,
      sent: f.sent,
      date: f.date.toISOString(),
    })),
    title: lead.contact.name,
    subtitle: lead.interest ? `Lead · ${lead.interest}` : 'Lead',
  }

  await prisma.$transaction([
    prisma.draft.create({
      data: {
        sourceType: 'Lead',
        sourceId: snapshot.displayId,
        data: snapshot,
        deletedBy: 'Manager',
        deletedAt: now,
        expiresAt,
      },
    }),
    prisma.lead.delete({ where: { id: leadId } }),
  ])

  revalidatePath('/leads')
  revalidatePath('/drafts')
  return { success: true }
}

// ─── MOVE WALK-IN TO DRAFT ─────────────────────────

export async function moveWalkinToDraft(walkinId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const walkin = await prisma.walkin.findUnique({
    where: { id: walkinId },
    include: { contact: true, assignedTo: { select: { name: true } } },
  })
  if (!walkin) return { success: false, error: 'Walk-in not found' }

  const now = new Date()
  const expiresAt = getDraftExpiry(now)

  const snapshot = {
    displayId: `WALKIN-${walkin.id}`,
    customer: walkin.contact.name,
    phone: walkin.contact.phone,
    email: walkin.contact.email,
    address: walkin.contact.address,
    requirement: walkin.requirement,
    roomType: walkin.roomType,
    materialCategory: walkin.materialCategory,
    applicationArea: walkin.applicationArea,
    areaSqft: walkin.areaSqft,
    assignedToId: walkin.assignedToId,
    assignedTo: walkin.assignedTo?.name || null,
    date: walkin.date.toISOString(),
    time: walkin.time,
    status: walkin.status,
    budget: walkin.budget,
    notes: walkin.notes,
    source: walkin.source,
    visitDuration: walkin.visitDuration,
    title: walkin.contact.name,
    subtitle: walkin.requirement ? `Walk-in · ${walkin.requirement}` : 'Walk-in',
  }

  await prisma.$transaction([
    prisma.draft.create({
      data: {
        sourceType: 'Walkin',
        sourceId: snapshot.displayId,
        data: snapshot,
        deletedBy: 'Manager',
        deletedAt: now,
        expiresAt,
      },
    }),
    prisma.walkin.delete({ where: { id: walkinId } }),
  ])

  revalidatePath('/walkins')
  revalidatePath('/drafts')
  return { success: true }
}

// ─── MOVE APPOINTMENT TO DRAFT ──────────────────────

export async function moveAppointmentToDraft(appointmentId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { contact: true },
  })
  if (!appointment) return { success: false, error: 'Appointment not found' }

  const now = new Date()
  const expiresAt = getDraftExpiry(now)

  const snapshot = {
    displayId: `APT-${appointment.id}`,
    customer: appointment.contact.name,
    phone: appointment.contact.phone,
    address: appointment.contact.address,
    date: appointment.date.toISOString(),
    time: appointment.time,
    purpose: appointment.purpose,
    status: appointment.status,
    notes: appointment.notes,
    title: appointment.contact.name,
    subtitle: appointment.purpose ? `Appointment · ${appointment.purpose}` : 'Appointment',
  }

  await prisma.$transaction([
    prisma.draft.create({
      data: {
        sourceType: 'Appointment',
        sourceId: snapshot.displayId,
        data: snapshot,
        deletedBy: 'Manager',
        deletedAt: now,
        expiresAt,
      },
    }),
    prisma.appointment.delete({ where: { id: appointmentId } }),
  ])

  revalidatePath('/appointments')
  revalidatePath('/drafts')
  return { success: true }
}

// ─── MOVE ORDER TO DRAFT ────────────────────────────

export async function moveOrderToDraft(orderId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      contact: true,
      product: { select: { id: true, name: true, sku: true, price: true, sold: true } },
      godown: { select: { id: true, name: true } },
    },
  })
  if (!order) return { success: false, error: 'Order not found' }

  const now = new Date()
  const expiresAt = getDraftExpiry(now)
  // A cancelled order already put its stock back (orders.ts); restoring again
  // created phantom stock.
  const shouldDeductStock = ['STORE', 'SHOPIFY'].includes(order.source) && order.status !== 'CANCELLED'

  const snapshot = {
    displayId: order.displayId,
    customer: order.contact.name,
    phone: order.contact.phone,
    address: order.contact.address,
    productId: order.productId,
    productName: order.product?.name,
    productSku: order.product?.sku,
    quantity: order.quantity,
    amount: order.amount,
    status: order.status,
    payment: order.payment,
    source: order.source,
    date: order.date.toISOString(),
    deliveryDate: order.deliveryDate?.toISOString() || null,
    notes: order.notes,
    godownId: order.godownId,
    godownName: order.godown?.name || null,
    title: order.contact.name,
    subtitle: order.product?.name ? `${order.product.name} · Qty ${order.quantity}` : 'Order',
  }

  try {
  await prisma.$transaction(async (tx) => {
    // Re-check under a row lock: a cancel (or a second move) running at the
    // same time must not make the stock decision on stale data.
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`
    const current = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } })
    if (!current) throw new Error('This order was already removed')
    if (current.status !== order.status) throw new Error('This order changed meanwhile. Refresh and try again.')
    if (shouldDeductStock) {
      if (order.godownId) {
        await adjustGodownStockWithTx(tx, {
          productId: order.productId,
          godownId: order.godownId,
          quantity: order.quantity,
          entryType: 'IN',
          referenceType: 'Order',
          referenceId: order.id,
          notes: `Reversal for deleted order ${order.displayId}`,
          createdBy: 'Orders',
        })
        const newSold = Math.max(0, (order.product?.sold || 0) - order.quantity)
        await tx.product.update({ where: { id: order.productId }, data: { sold: newSold } })
      } else {
        const product = await tx.product.findUnique({ where: { id: order.productId }, select: { sold: true } })
        if (!product) throw new Error('Product not found')
        const newSold = Math.max(0, (product.sold || 0) - order.quantity)
        await tx.product.update({
          where: { id: order.productId },
          data: { stock: { increment: order.quantity }, sold: newSold },
        })
      }
    }

    await tx.draft.create({
      data: {
        sourceType: 'Order',
        sourceId: order.displayId,
        data: snapshot,
        deletedBy: 'Manager',
        deletedAt: now,
        expiresAt,
      },
    })

    await tx.order.delete({ where: { id: orderId } })
  })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not move the order to drafts' }
  }

  revalidatePath('/orders')
  revalidatePath('/inventory')
  revalidatePath('/drafts')
  return { success: true }
}

// ─── MOVE QUOTATION TO DRAFT ────────────────────────

export async function moveQuotationToDraft(quotationId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const quotation = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: { contact: true, items: true },
  })
  if (!quotation) return { success: false, error: 'Quotation not found' }

  // Deleting a confirmed quotation let it be restored and confirmed again into
  // a second order for the same deal.
  const linkedOrder = await prisma.salesOrder.findFirst({ where: { quotationId, status: { not: 'CANCELLED' } }, select: { displayId: true } })
  if (linkedOrder) return { success: false, error: `This quotation is confirmed as ${linkedOrder.displayId}. Cancel the order first if the deal is off.` }
  const marker = new RegExp(`Converted from quotation ${quotation.displayId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`)
  const markedInvoices = await prisma.invoice.findMany({ where: { invoiceStatus: 'ACTIVE', notes: { contains: `Converted from quotation ${quotation.displayId}` } }, select: { displayId: true, notes: true } })
  const linkedInvoice = markedInvoices.find(invoice => marker.test(invoice.notes || ''))
  if (linkedInvoice) return { success: false, error: `This quotation was invoiced as ${linkedInvoice.displayId}. Cancel that invoice first.` }

  const now = new Date()
  const expiresAt = getDraftExpiry(now)

  const snapshot = {
    displayId: quotation.displayId,
    customer: quotation.contact.name,
    phone: quotation.contact.phone,
    email: quotation.contact.email,
    address: quotation.contact.address,
    date: quotation.date.toISOString(),
    validUntil: quotation.validUntil?.toISOString() || null,
    projectName: quotation.projectName,
    deliveryMode: quotation.deliveryMode,
    roadPermit: quotation.roadPermit,
    emailId: quotation.emailId,
    contactPerson: quotation.contactPerson,
    dispatchAddress: quotation.dispatchAddress,
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
    notes: quotation.notes,
    termsAndConditions: quotation.termsAndConditions,
    status: quotation.status,
    items: quotation.items.map(item => ({
      productId: item.productId,
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
      sortOrder: item.sortOrder,
    })),
    title: quotation.contact.name,
    subtitle: `Quotation · ${quotation.displayId}`,
  }

  await prisma.$transaction([
    prisma.draft.create({
      data: {
        sourceType: 'Quotation',
        sourceId: quotation.displayId,
        data: snapshot,
        deletedBy: 'Manager',
        deletedAt: now,
        expiresAt,
      },
    }),
    prisma.quotation.delete({ where: { id: quotationId } }),
  ])

  revalidatePath('/quotations')
  revalidatePath('/drafts')
  return { success: true }
}

// ─── MOVE INVOICE TO DRAFT ──────────────────────────

export async function moveInvoiceToDraft(invoiceId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      contact: true,
      items: true,
      payments: true,
      creditNotes: true,
      eWayBills: true,
      salesperson: { select: { name: true } },
    },
  })
  if (!invoice) return { success: false, error: 'Invoice not found' }
  if (invoice.invoiceStatus !== 'ACTIVE') {
    return { success: false, error: 'Only active invoices can be moved to drafts' }
  }
  if (!invoice.heldAt) {
    return { success: false, error: 'Only held invoices can be moved to drafts. Cancel or credit an issued invoice to restore its inventory.' }
  }

  const now = new Date()
  const expiresAt = getDraftExpiry(now)

  const snapshot = {
    displayId: invoice.displayId,
    customer: invoice.contact.name,
    phone: invoice.contact.phone,
    email: invoice.contact.email,
    address: invoice.contact.address,
    subtotal: invoice.subtotal,
    discount: invoice.discount,
    discountType: invoice.discountType,
    gst: invoice.gst,
    cgst: invoice.cgst,
    sgst: invoice.sgst,
    igst: invoice.igst,
    cess: invoice.cess,
    total: invoice.total,
    amountPaid: invoice.amountPaid,
    balanceDue: invoice.balanceDue,
    paymentMethod: invoice.paymentMethod,
    paymentStatus: invoice.paymentStatus,
    invoiceStatus: invoice.invoiceStatus,
    transportCost: invoice.transportCost,
    freightCharge: invoice.freightCharge,
    loadingCharge: invoice.loadingCharge,
    roadPermit: invoice.roadPermit,
    godownId: invoice.godownId,
    supplyType: invoice.supplyType,
    placeOfSupply: invoice.placeOfSupply,
    isRCM: invoice.isRCM,
    date: invoice.date.toISOString(),
    time: invoice.time,
    dueDate: invoice.dueDate?.toISOString() || null,
    salespersonId: invoice.salespersonId,
    salesperson: invoice.salesperson?.name || null,
    notes: invoice.notes,
    heldAt: invoice.heldAt?.toISOString() || null,
    items: invoice.items.map(item => ({
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
    payments: invoice.payments.map(p => ({
      amount: p.amount,
      method: p.method,
      reference: p.reference,
      notes: p.notes,
      date: p.date.toISOString(),
    })),
    creditNotes: invoice.creditNotes.map(cn => ({
      displayId: cn.displayId,
      amount: cn.amount,
      reason: cn.reason,
      date: cn.date.toISOString(),
    })),
    eWayBills: invoice.eWayBills.map(ewb => ({
      ewbNumber: ewb.ewbNumber,
      vehicleNo: ewb.vehicleNo,
      transporterGSTIN: ewb.transporterGSTIN,
      transporterName: ewb.transporterName,
      fromAddress: ewb.fromAddress,
      toAddress: ewb.toAddress,
      distance: ewb.distance,
      goodsDesc: ewb.goodsDesc,
      hsnCode: ewb.hsnCode,
      quantity: ewb.quantity,
      value: ewb.value,
      validFrom: ewb.validFrom?.toISOString() || null,
      validUntil: ewb.validUntil?.toISOString() || null,
      status: ewb.status,
      notes: ewb.notes,
      createdAt: ewb.createdAt.toISOString(),
    })),
    title: invoice.contact.name,
    subtitle: `Invoice · ${invoice.displayId}`,
  }

  await prisma.$transaction(async (tx) => {
    await tx.draft.create({
      data: {
        sourceType: 'Invoice',
        sourceId: invoice.displayId,
        data: snapshot,
        deletedBy: 'Manager',
        deletedAt: now,
        expiresAt,
      },
    })

    await tx.creditNote.deleteMany({ where: { invoiceId } })
    await tx.eWayBill.deleteMany({ where: { invoiceId } })
    await tx.invoice.delete({ where: { id: invoiceId } })
  })

  revalidatePath('/billing')
  revalidatePath('/drafts')
  return { success: true }
}

// ─── MOVE PURCHASE ORDER TO DRAFT ───────────────────

export async function movePurchaseOrderToDraft(poId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { supplier: true, items: true, payments: true },
  })
  if (!po) return { success: false, error: 'Purchase order not found' }

  const now = new Date()
  const expiresAt = getDraftExpiry(now)

  if (po.items.some(item => item.receivedQty > 0)) return { success: false, error: 'Received purchase orders are inventory history and cannot be moved to drafts. Use a supplier return to reverse received stock.' }
  // Approved/paid POs own receipts, bills and payment journals; deleting one
  // orphaned all of them and restoring created a second receipt.
  if (!['DRAFT', 'CANCELLED'].includes(po.status)) return { success: false, error: 'Only draft or cancelled purchase orders can be moved to drafts. Cancel this order instead.' }
  if (po.payments.length > 0 || po.amountPaid > 0) return { success: false, error: 'This purchase order has payments recorded, so it cannot be deleted.' }
  const [linkedBills, linkedReceipts] = await Promise.all([
    prisma.vendorBill.count({ where: { poId, status: { not: 'CANCELLED' } } }),
    prisma.stockPicking.count({ where: { purchaseOrderId: poId, status: { not: 'CANCELLED' } } }),
  ])
  if (linkedBills > 0) return { success: false, error: 'This purchase order has a vendor bill. Cancel the bill first.' }
  if (linkedReceipts > 0) return { success: false, error: 'This purchase order has an open goods receipt. Cancel the order instead.' }
  const receivedItems = po.items.filter(i => i.receivedQty > 0)
  if (receivedItems.length > 0) {
    const productIds = Array.from(new Set(receivedItems.map(i => i.productId)))
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, stock: true, name: true },
    })
    const productById = new Map(products.map(p => [p.id, p]))

    for (const item of receivedItems) {
      const product = productById.get(item.productId)
      if (!product) return { success: false, error: `Product not found for item ${item.name}` }
      if (product.stock < item.receivedQty) {
        return { success: false, error: `Cannot delete PO: stock for ${product.name} is below received quantity.` }
      }
    }
  }

  const snapshot = {
    displayId: po.displayId,
    supplierId: po.supplierId,
    supplierName: po.supplier?.name,
    supplierPhone: po.supplier?.phone,
    supplierEmail: po.supplier?.email,
    supplierAddress: po.supplier?.address,
    supplierContactPerson: po.supplier?.contactPerson,
    status: po.status,
    subtotal: po.subtotal,
    discount: po.discount,
    gst: po.gst,
    cgst: po.cgst,
    sgst: po.sgst,
    igst: po.igst,
    total: po.total,
    amountPaid: po.amountPaid,
    balanceDue: po.balanceDue,
    isRCM: po.isRCM,
    itcEligible: po.itcEligible,
    itcCategory: po.itcCategory,
    date: po.date.toISOString(),
    expectedDate: po.expectedDate?.toISOString() || null,
    receivedAt: po.receivedAt?.toISOString() || null,
    notes: po.notes,
    createdBy: po.createdBy,
    items: po.items.map(item => ({
      productId: item.productId,
      name: item.name,
      sku: item.sku,
      hsnCode: item.hsnCode,
      quantity: item.quantity,
      receivedQty: item.receivedQty,
      unitCost: item.unitCost,
      gstRate: item.gstRate,
      amount: item.amount,
    })),
    payments: po.payments.map(p => ({
      amount: p.amount,
      method: p.method,
      reference: p.reference,
      notes: p.notes,
      paidAt: p.paidAt.toISOString(),
      createdBy: p.createdBy,
    })),
    title: po.supplier?.name || 'Purchase Order',
    subtitle: `PO · ${po.displayId}`,
  }

  await prisma.$transaction(async (tx) => {
    if (receivedItems.length > 0) {
      for (const item of receivedItems) {
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: item.receivedQty } },
        })
        await tx.stockUpdate.create({
          data: {
            product: item.name,
            warehouse: 'Main',
            action: 'Remove',
            quantity: item.receivedQty,
            date: now,
            time: now.toTimeString().split(' ')[0],
          },
        })
      }
    }

    await tx.draft.create({
      data: {
        sourceType: 'PurchaseOrder',
        sourceId: po.displayId,
        data: snapshot,
        deletedBy: 'Manager',
        deletedAt: now,
        expiresAt,
      },
    })

    await tx.purchaseOrder.delete({ where: { id: poId } })
  })

  revalidatePath('/purchases')
  revalidatePath('/inventory')
  revalidatePath('/drafts')
  return { success: true }
}

// ─── MOVE EXPENSE TO DRAFT ──────────────────────────

export async function moveExpenseToDraft(expenseId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
    include: { category: true, staff: { select: { name: true } } },
  })
  if (!expense) return { success: false, error: 'Expense not found' }

  const now = new Date()
  const expiresAt = getDraftExpiry(now)

  const snapshot = {
    displayId: `EXP-${expense.id}`,
    date: expense.date.toISOString(),
    categoryId: expense.categoryId,
    categoryName: expense.category?.name,
    categoryColor: expense.category?.color,
    categoryIcon: expense.category?.icon,
    amount: expense.amount,
    description: expense.description,
    paymentMode: expense.paymentMode,
    reference: expense.reference,
    receipt: expense.receipt,
    vendor: expense.vendor,
    staffId: expense.staffId,
    staffName: expense.staff?.name || null,
    status: expense.status,
    approvedBy: expense.approvedBy,
    isRecurring: expense.isRecurring,
    notes: expense.notes,
    title: expense.vendor || expense.description,
    subtitle: `Expense · ₹${expense.amount}`,
  }

  await prisma.$transaction(async (tx) => {
    if (expense.paymentMode === 'Cash') {
      const dateOnly = new Date(expense.date.toISOString().split('T')[0] + 'T00:00:00')
      await tx.dailyCashRegister.updateMany({
        where: { date: dateOnly },
        data: { cashOut: { decrement: expense.amount } },
      })
    }

    await tx.draft.create({
      data: {
        sourceType: 'Expense',
        sourceId: snapshot.displayId,
        data: snapshot,
        deletedBy: 'Manager',
        deletedAt: now,
        expiresAt,
      },
    })

    await tx.expense.delete({ where: { id: expenseId } })
  })

  revalidatePath('/expenses')
  revalidatePath('/drafts')
  return { success: true }
}

// ─── MOVE PRODUCT TO DRAFT ──────────────────────────

export async function moveProductToDraft(productId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  if (!Number.isSafeInteger(productId) || productId <= 0) return { success: false, error: 'Invalid product ID' }
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { category: true, warehouse: true, stockGroup: true },
  })
  if (!product) return { success: false, error: 'Product not found' }

  const usageChecks = await prisma.$transaction([
    prisma.bomItem.count({ where: { rawMaterialId: productId } }),
    prisma.billOfMaterials.count({ where: { finishedProductId: productId } }),
    prisma.productionOrder.count({ where: { finishedProductId: productId } }),
    prisma.order.count({ where: { productId } }),
    prisma.quotationItem.count({ where: { productId } }),
    prisma.invoiceItem.count({ where: { productId } }),
    prisma.purchaseOrderItem.count({ where: { productId } }),
    prisma.purchaseReturnItem.count({ where: { productId } }),
    prisma.godownStock.count({ where: { productId } }),
    prisma.stockLedger.count({ where: { productId } }),
  ])

  const [bomUsage, bomFinished, prodUsage, orderUsage, quotationUsage, invoiceUsage, poUsage, prUsage, godownUsage, ledgerUsage] = usageChecks
  if (bomUsage > 0) return { success: false, error: `Cannot delete: used in ${bomUsage} BOM(s).` }
  if (bomFinished > 0) return { success: false, error: 'Cannot delete: used as a finished product in a BOM.' }
  if (prodUsage > 0) return { success: false, error: 'Cannot delete: tied to production orders.' }
  if (orderUsage > 0 || quotationUsage > 0 || invoiceUsage > 0) return { success: false, error: 'Cannot delete: product is linked to sales documents.' }
  if (poUsage > 0 || prUsage > 0) return { success: false, error: 'Cannot delete: product is linked to purchase documents.' }
  if (godownUsage > 0) return { success: false, error: 'Cannot delete: product has godown stock entries.' }
  if (ledgerUsage > 0) return { success: false, error: 'Cannot delete: product has stock ledger history.' }

  if (await prisma.stoneLot.count({ where: { productId } }) > 0 || await prisma.sampleLoan.count({ where: { productId } }) > 0 || await prisma.productBatch.count({ where: { productId } }) > 0) return { success: false, error: 'Cannot delete: this product has lot, sample or batch history.' }

  const now = new Date()
  const expiresAt = getDraftExpiry(now)

  const snapshot = {
    displayId: product.sku,
    sku: product.sku,
    name: product.name,
    categoryId: product.categoryId,
    categoryName: product.category?.name,
    price: product.price,
    stock: product.stock,
    sold: product.sold,
    reorderLevel: product.reorderLevel,
    image: product.image,
    material: product.material,
    color: product.color,
    description: product.description,
    warehouseId: product.warehouseId,
    warehouseName: product.warehouse?.name,
    lastRestocked: product.lastRestocked?.toISOString() || null,
    hsnCode: product.hsnCode,
    unitOfMeasure: product.unitOfMeasure,
    costPrice: product.costPrice,
    stockGroupId: product.stockGroupId,
    stockGroupName: product.stockGroup?.name,
    title: product.name,
    subtitle: `Product · ${product.sku}`,
  }

  await prisma.$transaction([
    prisma.stockLedger.deleteMany({ where: { productId } }),
    prisma.godownStock.deleteMany({ where: { productId } }),
    prisma.draft.create({
      data: {
        sourceType: 'Product',
        sourceId: product.sku,
        data: snapshot,
        deletedBy: 'Manager',
        deletedAt: now,
        expiresAt,
      },
    }),
    prisma.product.delete({ where: { id: productId } }),
  ])

  revalidatePath('/inventory')
  revalidatePath('/drafts')
  return { success: true }
}

// ─── GET ALL DRAFTS ────────────────────────────────────

export async function getDrafts() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  // Auto-purge expired drafts first
  await prisma.draft.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })

  const drafts = await prisma.draft.findMany({
    orderBy: { deletedAt: 'desc' },
  })

  return {
    success: true,
    data: drafts.map(d => ({
      id: d.id,
      sourceType: d.sourceType,
      sourceId: d.sourceId,
      data: d.data as Record<string, unknown>,
      deletedBy: d.deletedBy,
      deletedAt: d.deletedAt.toISOString(),
      expiresAt: d.expiresAt.toISOString(),
      daysLeft: Math.max(0, Math.ceil((d.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))),
    })),
  }
}

// ─── RESTORE CUSTOM ORDER FROM DRAFT ───────────────────

export async function restoreFromDraft(draftId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const draft = await prisma.draft.findUnique({ where: { id: draftId } })
  if (!draft) return { success: false, error: 'Draft not found' }

  if (draft.sourceType === 'CustomOrder') {
    const data = draft.data as Record<string, unknown>

    // Find or create the contact
    let contact = await prisma.contact.findFirst({
      where: { phone: data.phone as string },
    })
    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          name: data.customer as string,
          phone: data.phone as string,
          address: data.address as string || '',
          source: 'Custom Order',
        },
      })
    }

    // Generate new displayId
    const lastOrder = await prisma.customOrder.findFirst({ orderBy: { id: 'desc' } })
    const nextNum = lastOrder ? lastOrder.id + 1 : 1
    const displayId = `CUS-${String(nextNum).padStart(3, '0')}`

    await prisma.$transaction([
      prisma.customOrder.create({
        data: {
          displayId,
          contactId: contact.id,
          phone: data.phone as string,
          address: data.address as string,
          type: data.type as string,
          status: 'MEASUREMENT_SCHEDULED',
          date: new Date(),
          measurements: data.measurements as object || undefined,
          referenceImages: (data.referenceImages as string[]) || [],
          materials: data.materials as string || undefined,
          color: data.color as string || undefined,
          quotedPrice: data.quotedPrice as number || undefined,
          advancePaid: (data.advancePaid as number) || 0,
          productionNotes: data.productionNotes as string || undefined,
          installationType: data.installationType as string || undefined,
          edgeProfile: data.edgeProfile as string || undefined,
          cutouts: data.cutouts as object || undefined,
          templateMethod: data.templateMethod as string || undefined,
          areaSqft: typeof data.areaSqft === 'number' ? data.areaSqft : undefined,
          wastagePercent: typeof data.wastagePercent === 'number' ? data.wastagePercent : undefined,
        },
      }),
      prisma.draft.delete({ where: { id: draftId } }),
    ])

    revalidatePath('/custom-orders')
    revalidatePath('/drafts')
    return { success: true, data: { displayId } }
  }

  if (draft.sourceType === 'FieldVisit') {
    const data = draft.data as Record<string, unknown>

    // Generate new displayId
    const count = await prisma.fieldVisit.count({ where: { staffId: data.staffId as number, customOrderId: null } })
    const displayId = `SV-${data.staffId}-${count + 1}`

    await prisma.$transaction([
      prisma.fieldVisit.create({
        data: {
          displayId,
          staffId: data.staffId as number,
          customer: data.customer as string,
          address: data.address as string,
          date: new Date(data.date as string),
          time: data.time as string,
          status: data.status as string || 'Completed',
          type: data.type as string,
          notes: data.notes as string || null,
          staffNotes: data.staffNotes as string || null,
          measurements: data.measurements as object || undefined,
          photos: data.photos as number || 0,
          photoUrls: (data.photoUrls as string[]) || [],
        },
      }),
      prisma.draft.delete({ where: { id: draftId } }),
    ])

    revalidatePath('/staff-portal')
    revalidatePath('/staff')
    revalidatePath('/drafts')
    return { success: true, data: { displayId } }
  }

  if (draft.sourceType === 'Lead') {
    const data = draft.data as Record<string, any>

    let contact = await prisma.contact.findFirst({ where: { phone: data.phone as string } })
    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          name: data.customer as string,
          phone: data.phone as string,
          email: (data.email as string) || null,
          address: (data.address as string) || null,
          source: 'Lead',
        },
      })
    } else if (
      (data.customer && contact.name !== data.customer) ||
      (data.email && contact.email !== data.email) ||
      (data.address && contact.address !== data.address)
    ) {
      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: {
          name: data.customer as string,
          email: (data.email as string) || contact.email,
          address: (data.address as string) || contact.address,
        },
      })
    }

    const lead = await prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          contactId: contact.id,
          interest: data.interest as string,
          materialCategory: (data.materialCategory as string) || null,
          applicationArea: (data.applicationArea as string) || null,
          areaSqft: typeof data.areaSqft === 'number' ? data.areaSqft : null,
          budget: (data.budget as string) || null,
          status: coerceEnum(data.status, leadStatusValues, LeadStatus.NEW),
          source: (data.source as string) || null,
          date: data.date ? new Date(data.date as string) : new Date(),
          notes: (data.notes as string) || null,
          assignedToId: (data.assignedToId as number) || null,
          followUps: {
            create: Array.isArray(data.followUps)
              ? data.followUps.map((f: any) => ({
                day: f.day,
                message: f.message,
                sent: !!f.sent,
                date: new Date(f.date),
              }))
              : [],
          },
        },
      })

      await tx.draft.delete({ where: { id: draftId } })
      return created
    })

    revalidatePath('/leads')
    revalidatePath('/drafts')
    return { success: true, data: { id: lead.id } }
  }

  if (draft.sourceType === 'Walkin') {
    const data = draft.data as Record<string, any>

    let contact = await prisma.contact.findFirst({ where: { phone: data.phone as string } })
    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          name: data.customer as string,
          phone: data.phone as string,
          email: (data.email as string) || null,
          address: (data.address as string) || null,
          source: 'Walk-in',
        },
      })
    } else if (
      (data.customer && contact.name !== data.customer) ||
      (data.email && contact.email !== data.email) ||
      (data.address && contact.address !== data.address)
    ) {
      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: {
          name: data.customer as string,
          email: (data.email as string) || contact.email,
          address: (data.address as string) || contact.address,
        },
      })
    }

    const walkin = await prisma.$transaction(async (tx) => {
      const created = await tx.walkin.create({
        data: {
          contactId: contact.id,
          requirement: data.requirement as string,
          roomType: (data.roomType as string) || null,
          materialCategory: (data.materialCategory as string) || null,
          applicationArea: (data.applicationArea as string) || null,
          areaSqft: typeof data.areaSqft === 'number' ? data.areaSqft : null,
          assignedToId: (data.assignedToId as number) || null,
          date: data.date ? new Date(data.date as string) : new Date(),
          time: data.time as string,
          status: coerceEnum(data.status, walkinStatusValues, WalkinStatus.BROWSING),
          budget: (data.budget as string) || null,
          notes: (data.notes as string) || null,
          source: (data.source as string) || 'Walk-in',
          visitDuration: (data.visitDuration as string) || null,
        },
      })

      await tx.draft.delete({ where: { id: draftId } })
      return created
    })

    revalidatePath('/walkins')
    revalidatePath('/drafts')
    return { success: true, data: { id: walkin.id } }
  }

  if (draft.sourceType === 'Appointment') {
    const data = draft.data as Record<string, any>

    let contact = await prisma.contact.findFirst({ where: { phone: data.phone as string } })
    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          name: data.customer as string,
          phone: data.phone as string,
          address: (data.address as string) || null,
          source: 'Appointment',
        },
      })
    } else if (
      (data.customer && contact.name !== data.customer) ||
      (data.address && contact.address !== data.address)
    ) {
      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: {
          name: data.customer as string,
          address: (data.address as string) || contact.address,
        },
      })
    }

    const appointment = await prisma.$transaction(async (tx) => {
      const created = await tx.appointment.create({
        data: {
          contactId: contact.id,
          date: data.date ? new Date(data.date as string) : new Date(),
          time: data.time as string,
          purpose: data.purpose as string,
          status: (data.status as string) || 'Scheduled',
          notes: (data.notes as string) || null,
        },
      })

      await tx.draft.delete({ where: { id: draftId } })
      return created
    })

    revalidatePath('/appointments')
    revalidatePath('/drafts')
    return { success: true, data: { id: appointment.id } }
  }

  if (draft.sourceType === 'Order') {
    const data = draft.data as Record<string, any>

    const productId = data.productId as number
    const quantity = data.quantity as number
    const orderSource = coerceEnum(data.source, orderSourceValues, OrderSource.STORE)
    const restoredStatus: OrderStatus = coerceEnum(data.status, orderStatusValues, OrderStatus.CONFIRMED as OrderStatus)
    // A cancelled order holds no stock, so restoring it takes none.
    const shouldDeductStock = ['STORE', 'SHOPIFY'].includes(orderSource) && restoredStatus !== OrderStatus.CANCELLED

    let contact = await prisma.contact.findFirst({ where: { phone: data.phone as string } })
    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          name: data.customer as string,
          phone: data.phone as string,
          address: (data.address as string) || null,
          source: 'Order',
        },
      })
    }

    const product = await prisma.product.findUnique({ where: { id: productId } })
    if (!product) return { success: false, error: 'Product not found for this order' }

    let usingGodownStock = false
    let targetGodownId: number | undefined = data.godownId as number | undefined
    if (shouldDeductStock) {
      const godownCount = await prisma.godown.count()
      usingGodownStock = godownCount > 0

      if (usingGodownStock) {
        if (!targetGodownId) {
          const defaultGodown = await prisma.godown.findFirst({ where: { isDefault: true } }) || await prisma.godown.findFirst({ orderBy: { id: 'asc' } })
          if (!defaultGodown) return { success: false, error: 'No godown available for this order' }
          targetGodownId = defaultGodown.id
        }

        const godownStock = await prisma.godownStock.findUnique({
          where: { productId_godownId: { productId, godownId: targetGodownId } },
          select: { quantity: true },
        })
        const available = godownStock?.quantity || 0
        if (available < quantity) {
          return { success: false, error: `Insufficient stock in selected godown (${available} available)` }
        }
      } else if (product.stock < quantity) {
        return { success: false, error: `Only ${product.stock} units in stock` }
      }
    }

    const prefix = orderSource === 'STORE' ? 'ORD' : orderSource === 'AMAZON' ? 'AMZ' : orderSource === 'FLIPKART' ? 'FK' : 'SHP'
    const lastOrder = await prisma.order.findFirst({
      where: { displayId: { startsWith: prefix } },
      orderBy: { id: 'desc' },
      select: { displayId: true },
    })
    let nextNum = 1
    if (lastOrder?.displayId) {
      const match = lastOrder.displayId.match(/(\d+)$/)
      if (match) nextNum = parseInt(match[1]) + 1
    }
    const displayId = `${prefix}-${String(nextNum).padStart(4, '0')}`

    await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          displayId,
          contactId: contact.id,
          productId,
          quantity,
          amount: data.amount as number,
          source: orderSource,
          payment: coerceEnum(data.payment, paymentStatusValues, PaymentStatus.PENDING),
          status: restoredStatus,
          date: data.date ? new Date(data.date as string) : new Date(),
          deliveryDate: data.deliveryDate ? new Date(data.deliveryDate as string) : null,
          notes: (data.notes as string) || null,
          godownId: targetGodownId,
        },
      })

      if (shouldDeductStock) {
        if (usingGodownStock && targetGodownId) {
          await adjustGodownStockWithTx(tx, {
            productId,
            godownId: targetGodownId,
            quantity: -quantity,
            entryType: 'OUT',
            referenceType: 'Order',
            referenceId: created.id,
            notes: `Restored order ${displayId}`,
            createdBy: 'Orders',
          })
          await tx.product.update({
            where: { id: productId },
            data: { sold: product.sold + quantity },
          })
        } else {
          await tx.product.update({
            where: { id: productId },
            data: {
              stock: { decrement: quantity },
              sold: { increment: quantity },
            },
          })
        }
      }

      await tx.draft.delete({ where: { id: draftId } })
    })

    revalidatePath('/orders')
    revalidatePath('/inventory')
    revalidatePath('/drafts')
    return { success: true, data: { displayId } }
  }

  if (draft.sourceType === 'Quotation') {
    const data = draft.data as Record<string, any>

    let contact = await prisma.contact.findFirst({ where: { phone: data.phone as string } })
    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          name: data.customer as string,
          phone: data.phone as string,
          email: (data.email as string) || null,
          address: (data.address as string) || null,
          source: 'Quotation',
        },
      })
    }

    const items = Array.isArray(data.items) ? data.items : []
    const productIds = Array.from(new Set(items.map((item: any) => item.productId).filter(Boolean)))
    if (productIds.length > 0) {
      const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true } })
      const existingIds = new Set(products.map(p => p.id))
      const missing = productIds.filter(id => !existingIds.has(id))
      if (missing.length > 0) {
        return { success: false, error: 'One or more products for this quotation no longer exist' }
      }
    }

    const lastQuotation = await prisma.quotation.findFirst({ orderBy: { id: 'desc' }, select: { displayId: true } })
    let nextNum = 1000
    if (lastQuotation?.displayId) {
      const match = lastQuotation.displayId.match(/(\d+)$/)
      if (match) nextNum = parseInt(match[1]) + 1
    }
    const originalId = typeof data.displayId === 'string' ? data.displayId : null
    const originalTaken = originalId ? await prisma.quotation.findUnique({ where: { displayId: originalId }, select: { id: true } }) : null
    const displayId = originalId && !originalTaken ? originalId : `Q.${nextNum}`

    await prisma.$transaction(async (tx) => {
      await tx.quotation.create({
        data: {
          displayId,
          contactId: contact.id,
          date: data.date ? new Date(data.date as string) : new Date(),
          validUntil: data.validUntil ? new Date(data.validUntil as string) : null,
          projectName: (data.projectName as string) || null,
          deliveryMode: (data.deliveryMode as string) || null,
          roadPermit: (data.roadPermit as string) || null,
          emailId: (data.emailId as string) || null,
          contactPerson: (data.contactPerson as string) || null,
          dispatchAddress: (data.dispatchAddress as string) || null,
          installationPercent: data.installationPercent as number,
          discountType: (data.discountType as string) || 'PERCENT',
          discountValue: Number(data.discountValue || 0),
          discountAmount: Number(data.discountAmount || 0),
          installationCharge: data.installationCharge as number,
          freightCharge: data.freightCharge as number,
          loadingCharge: data.loadingCharge as number,
          gstPercent: data.gstPercent as number,
          gstAmount: data.gstAmount as number,
          totalBeforeTax: data.totalBeforeTax as number,
          grandTotal: data.grandTotal as number,
          notes: (data.notes as string) || null,
          termsAndConditions: Array.isArray(data.termsAndConditions) ? data.termsAndConditions : [],
          status: coerceEnum(data.status, quotationStatusValues, QuotationStatus.DRAFT),
          items: {
            create: items.map((item: any) => ({
            productId: item.productId || null,
            name: item.name,
            sku: item.sku || null,
            description: item.description || null,
            quantity: item.quantity,
            unitOfMeasure: item.unitOfMeasure || 'PCS',
            areaSqft: item.areaSqft ?? null,
            coveragePerBox: item.coveragePerBox ?? null,
            rate: item.rate,
              amount: item.amount,
              referenceImage: item.referenceImage || null,
              sortOrder: item.sortOrder || 0,
            })),
          },
        },
      })

      await tx.draft.delete({ where: { id: draftId } })
    })

    revalidatePath('/quotations')
    revalidatePath('/drafts')
    return { success: true, data: { displayId } }
  }

  if (draft.sourceType === 'Invoice') {
    const data = draft.data as Record<string, any>

    let contact = await prisma.contact.findFirst({ where: { phone: data.phone as string } })
    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          name: data.customer as string,
          phone: data.phone as string,
          email: (data.email as string) || null,
          address: (data.address as string) || null,
          source: 'Invoice',
        },
      })
    } else if (
      (data.customer && contact.name !== data.customer) ||
      (data.address && contact.address !== data.address)
    ) {
      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: {
          name: data.customer as string,
          address: (data.address as string) || contact.address,
        },
      })
    }

    const items = Array.isArray(data.items) ? data.items : []
    if (items.length === 0) return { success: false, error: 'Invoice items missing' }

    const productIds = Array.from(new Set(items.map((item: any) => item.productId)))
    const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true } })
    const existingIds = new Set(products.map(p => p.id))
    const missing = productIds.filter(id => !existingIds.has(id))
    if (missing.length > 0) return { success: false, error: 'One or more products for this invoice no longer exist' }

    const lastInvoice = await prisma.invoice.findFirst({ orderBy: { id: 'desc' }, select: { displayId: true } })
    let nextNum = 1
    if (lastInvoice?.displayId) {
      const match = lastInvoice.displayId.match(/INV-(\d+)/)
      if (match) nextNum = parseInt(match[1]) + 1
    }
    const displayId = `INV-${String(nextNum).padStart(4, '0')}`

    await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          displayId,
          contactId: contact.id,
          subtotal: data.subtotal as number,
          discount: data.discount as number,
          discountType: (data.discountType as string) || 'none',
          gst: data.gst as number,
          cgst: data.cgst as number,
          sgst: data.sgst as number,
          igst: data.igst as number,
          cess: data.cess as number,
          total: data.total as number,
          amountPaid: data.amountPaid as number,
          balanceDue: data.balanceDue as number,
          paymentMethod: data.paymentMethod as string,
          paymentStatus: coerceEnum(data.paymentStatus, paymentStatusValues, PaymentStatus.PENDING),
          invoiceStatus: coerceEnum(data.invoiceStatus, invoiceStatusValues, InvoiceStatus.ACTIVE),
          transportCost: (data.transportCost as number) || 0,
          freightCharge: (data.freightCharge as number) || 0,
          loadingCharge: (data.loadingCharge as number) || 0,
          installationCharge: (data.installationCharge as number) || 0,
          roadPermit: (data.roadPermit as string) || null,
          godownId: (data.godownId as number) || null,
          supplyType: (data.supplyType as string) || 'INTRASTATE',
          placeOfSupply: (data.placeOfSupply as string) || null,
          isRCM: !!data.isRCM,
          date: data.date ? new Date(data.date as string) : new Date(),
          time: data.time as string,
          dueDate: data.dueDate ? new Date(data.dueDate as string) : null,
          salespersonId: (data.salespersonId as number) || null,
          notes: (data.notes as string) || null,
          heldAt: data.heldAt ? new Date(data.heldAt as string) : null,
          items: {
            create: items.map((item: any) => ({
              productId: item.productId,
              name: item.name,
              sku: item.sku || null,
              quantity: item.quantity,
              unitOfMeasure: item.unitOfMeasure || 'PCS',
              areaSqft: item.areaSqft || null,
              coveragePerBox: item.coveragePerBox || null,
              price: item.price,
              slabId: item.slabId || null,
              batchId: item.batchId || null,
              hsnCode: item.hsnCode || null,
              gstRate: item.gstRate || 18,
              cgst: item.cgst || 0,
              sgst: item.sgst || 0,
              igst: item.igst || 0,
              cess: item.cess || 0,
              taxableAmount: item.taxableAmount || 0,
            })),
          },
          payments: {
            create: Array.isArray(data.payments)
              ? data.payments.map((p: any) => ({
                amount: p.amount,
                method: p.method,
                reference: p.reference || null,
                notes: p.notes || null,
                date: p.date ? new Date(p.date) : new Date(),
              }))
              : [],
          },
        },
      })

      if (Array.isArray(data.creditNotes) && data.creditNotes.length > 0) {
        const lastCN = await tx.creditNote.findFirst({ orderBy: { id: 'desc' }, select: { displayId: true } })
        let nextCN = 1
        if (lastCN?.displayId) {
          const match = lastCN.displayId.match(/CN-(\d+)/)
          if (match) nextCN = parseInt(match[1]) + 1
        }

        await tx.creditNote.createMany({
          data: data.creditNotes.map((cn: any, idx: number) => ({
            displayId: `CN-${String(nextCN + idx).padStart(4, '0')}`,
            invoiceId: invoice.id,
            amount: cn.amount,
            reason: cn.reason,
            date: cn.date ? new Date(cn.date) : new Date(),
          })),
        })
      }

      if (Array.isArray(data.eWayBills) && data.eWayBills.length > 0) {
        await tx.eWayBill.createMany({
          data: data.eWayBills.map((ewb: any) => ({
            invoiceId: invoice.id,
            ewbNumber: ewb.ewbNumber || null,
            vehicleNo: ewb.vehicleNo || null,
            transporterGSTIN: ewb.transporterGSTIN || null,
            transporterName: ewb.transporterName || null,
            fromAddress: ewb.fromAddress || null,
            toAddress: ewb.toAddress || null,
            distance: ewb.distance || null,
            goodsDesc: ewb.goodsDesc || null,
            hsnCode: ewb.hsnCode || null,
            quantity: ewb.quantity || null,
            value: ewb.value || 0,
            validFrom: ewb.validFrom ? new Date(ewb.validFrom) : null,
            validUntil: ewb.validUntil ? new Date(ewb.validUntil) : null,
            status: ewb.status || 'GENERATED',
            notes: ewb.notes || null,
          })),
        })
      }

      await tx.draft.delete({ where: { id: draftId } })
    })

    revalidatePath('/billing')
    revalidatePath('/drafts')
    return { success: true, data: { displayId } }
  }

  if (draft.sourceType === 'PurchaseOrder') {
    const data = draft.data as Record<string, any>

    let supplierId = data.supplierId as number | undefined
    if (supplierId) {
      const existing = await prisma.supplier.findUnique({ where: { id: supplierId } })
      if (!existing) supplierId = undefined
    }

    if (!supplierId) {
      const existingByName = data.supplierName
        ? await prisma.supplier.findFirst({ where: { name: data.supplierName as string } })
        : null
      if (existingByName) {
        supplierId = existingByName.id
      } else {
        const created = await prisma.supplier.create({
          data: {
            name: data.supplierName as string,
            phone: (data.supplierPhone as string) || null,
            email: (data.supplierEmail as string) || null,
            address: (data.supplierAddress as string) || null,
            contactPerson: (data.supplierContactPerson as string) || null,
          },
        })
        supplierId = created.id
      }
    }

    const items = Array.isArray(data.items) ? data.items : []
    if (items.length === 0) return { success: false, error: 'Purchase order items missing' }

    const productIds = Array.from(new Set(items.map((item: any) => item.productId)))
    const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true } })
    const existingIds = new Set(products.map(p => p.id))
    const missing = productIds.filter(id => !existingIds.has(id))
    if (missing.length > 0) return { success: false, error: 'One or more products for this PO no longer exist' }

    const count = await prisma.purchaseOrder.count()
    const displayId = `PO-${String(count + 1).padStart(4, '0')}`

    await prisma.$transaction(async (tx) => {
      const created = await tx.purchaseOrder.create({
        data: {
          displayId,
          supplierId: supplierId as number,
          status: coerceEnum(data.status, poStatusValues, POStatus.DRAFT),
          subtotal: data.subtotal as number,
          discount: data.discount as number,
          gst: data.gst as number,
          cgst: data.cgst as number,
          sgst: data.sgst as number,
          igst: data.igst as number,
          total: data.total as number,
          amountPaid: data.amountPaid as number,
          balanceDue: data.balanceDue as number,
          isRCM: !!data.isRCM,
          itcEligible: data.itcEligible !== false,
          itcCategory: (data.itcCategory as string) || 'INPUTS',
          date: data.date ? new Date(data.date as string) : new Date(),
          expectedDate: data.expectedDate ? new Date(data.expectedDate as string) : null,
          receivedAt: data.receivedAt ? new Date(data.receivedAt as string) : null,
          notes: (data.notes as string) || null,
          createdBy: (data.createdBy as string) || null,
          items: {
            create: items.map((item: any) => ({
              productId: item.productId,
              name: item.name,
              sku: item.sku,
              hsnCode: item.hsnCode || null,
              quantity: item.quantity,
              receivedQty: item.receivedQty || 0,
              unitCost: item.unitCost,
              gstRate: item.gstRate || 18,
              amount: item.amount,
            })),
          },
          payments: {
            create: Array.isArray(data.payments)
              ? data.payments.map((p: any) => ({
                amount: p.amount,
                method: p.method || 'Bank Transfer',
                reference: p.reference || null,
                notes: p.notes || null,
                paidAt: p.paidAt ? new Date(p.paidAt) : new Date(),
                createdBy: p.createdBy || null,
              }))
              : [],
          },
        },
      })

      const receivedItems = items.filter((item: any) => item.receivedQty > 0)
      if (receivedItems.length > 0) {
        for (const item of receivedItems) {
          await tx.product.update({
            where: { id: item.productId },
            data: {
              stock: { increment: item.receivedQty },
              costPrice: item.unitCost,
              lastRestocked: new Date(),
            },
          })
          await tx.stockUpdate.create({
            data: {
              product: item.name,
              warehouse: 'Main',
              action: 'Add',
              quantity: item.receivedQty,
              date: new Date(),
              time: new Date().toTimeString().split(' ')[0],
            },
          })
        }
        if (created.status !== 'CANCELLED' && created.status !== 'DRAFT') {
          await tx.purchaseOrder.update({
            where: { id: created.id },
            data: { status: created.status },
          })
        }
      }

      await tx.draft.delete({ where: { id: draftId } })
    })

    revalidatePath('/purchases')
    revalidatePath('/inventory')
    revalidatePath('/drafts')
    return { success: true, data: { displayId } }
  }

  if (draft.sourceType === 'Expense') {
    const data = draft.data as Record<string, any>

    let categoryId = data.categoryId as number | undefined
    if (categoryId) {
      const existing = await prisma.expenseCategory.findUnique({ where: { id: categoryId } })
      if (!existing) categoryId = undefined
    }
    if (!categoryId && data.categoryName) {
      const existingByName = await prisma.expenseCategory.findFirst({ where: { name: data.categoryName as string } })
      if (existingByName) {
        categoryId = existingByName.id
      } else {
        const created = await prisma.expenseCategory.create({
          data: {
            name: data.categoryName as string,
            color: data.categoryColor || null,
            icon: data.categoryIcon || null,
          },
        })
        categoryId = created.id
      }
    }
    if (!categoryId) return { success: false, error: 'Expense category missing' }

    const expense = await prisma.$transaction(async (tx) => {
      const created = await tx.expense.create({
        data: {
          date: data.date ? new Date(data.date as string) : new Date(),
          categoryId,
          amount: data.amount as number,
          description: data.description as string,
          paymentMode: (data.paymentMode as string) || 'Cash',
          reference: (data.reference as string) || null,
          receipt: (data.receipt as string) || null,
          vendor: (data.vendor as string) || null,
          staffId: (data.staffId as number) || null,
          status: (data.status as string) || 'Approved',
          approvedBy: (data.approvedBy as string) || null,
          isRecurring: !!data.isRecurring,
          notes: (data.notes as string) || null,
        },
      })

      if ((data.paymentMode as string) === 'Cash') {
        const dateOnly = new Date(created.date.toISOString().split('T')[0] + 'T00:00:00')
        await tx.dailyCashRegister.upsert({
          where: { date: dateOnly },
          create: { date: dateOnly, cashOut: created.amount },
          update: { cashOut: { increment: created.amount } },
        })
      }

      await tx.draft.delete({ where: { id: draftId } })
      return created
    })

    revalidatePath('/expenses')
    revalidatePath('/drafts')
    return { success: true, data: { id: expense.id } }
  }

  if (draft.sourceType === 'Product') {
    const data = draft.data as Record<string, any>

    const existingSku = await prisma.product.findUnique({ where: { sku: data.sku as string } })
    if (existingSku) return { success: false, error: 'SKU already exists. Update the existing product instead.' }

    let categoryId = data.categoryId as number | undefined
    if (categoryId) {
      const existing = await prisma.category.findUnique({ where: { id: categoryId } })
      if (!existing) categoryId = undefined
    }
    if (!categoryId && data.categoryName) {
      const category = await prisma.category.upsert({
        where: { name: data.categoryName as string },
        update: {},
        create: { name: data.categoryName as string },
      })
      categoryId = category.id
    }
    if (!categoryId) return { success: false, error: 'Product category missing' }

    let warehouseId = data.warehouseId as number | undefined
    if (warehouseId) {
      const existing = await prisma.warehouse.findUnique({ where: { id: warehouseId } })
      if (!existing) warehouseId = undefined
    }
    if (!warehouseId && data.warehouseName) {
      const warehouse = await prisma.warehouse.upsert({
        where: { name: data.warehouseName as string },
        update: {},
        create: { name: data.warehouseName as string },
      })
      warehouseId = warehouse.id
    }

    let stockGroupId = data.stockGroupId as number | undefined
    if (stockGroupId) {
      const existing = await prisma.stockGroup.findUnique({ where: { id: stockGroupId } })
      if (!existing) stockGroupId = undefined
    }
    if (!stockGroupId && data.stockGroupName) {
      const stockGroup = await prisma.stockGroup.upsert({
        where: { name: data.stockGroupName as string },
        update: {},
        create: { name: data.stockGroupName as string },
      })
      stockGroupId = stockGroup.id
    }

    const product = await prisma.product.create({
      data: {
        sku: data.sku as string,
        name: data.name as string,
        categoryId,
        price: data.price as number,
        stock: data.stock as number,
        sold: data.sold as number,
        reorderLevel: data.reorderLevel as number,
        image: (data.image as string) || null,
        material: (data.material as string) || null,
        color: (data.color as string) || null,
        description: (data.description as string) || null,
        warehouseId: warehouseId || null,
        lastRestocked: data.lastRestocked ? new Date(data.lastRestocked as string) : null,
        hsnCode: (data.hsnCode as string) || null,
        unitOfMeasure: (data.unitOfMeasure as string) || 'PCS',
        costPrice: (data.costPrice as number) || 0,
        stockGroupId: stockGroupId || null,
      },
    })

    await prisma.draft.delete({ where: { id: draftId } })

    revalidatePath('/inventory')
    revalidatePath('/drafts')
    return { success: true, data: { id: product.id } }
  }

  return { success: false, error: 'Unsupported draft type' }
}

// ─── PERMANENTLY DELETE A DRAFT ────────────────────────

export async function permanentlyDeleteDraft(draftId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  await prisma.draft.delete({ where: { id: draftId } })
  revalidatePath('/drafts')
  return { success: true }
}
