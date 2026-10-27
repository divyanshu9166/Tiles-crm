'use server'

import { prisma } from '@/lib/db'
import { adjustStock, lockInventoryProducts, resolveStockGodown, inventoryError } from '@/lib/inventory-stock'
import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth-helpers'
import { createSupplierSchema, createPurchaseOrderSchema, createPurchaseReturnSchema } from '@/lib/validations/purchase'
import { sendEmail } from '@/lib/email'
import { z } from 'zod'
import { getOrCreateDefaultGodown } from './godowns'
import { syncStoneLotTotals } from '@/lib/stone-inventory'
import { getBrand } from '@/lib/brand'
import { ensureReceiptForPurchaseOrder, validatePickingTx, cancelPickingTx } from '@/lib/erp/stock-ops'
import { logTracking } from '@/lib/erp/chatter'
import { nextSequence } from '@/lib/erp/sequence'

function escapeHtml(value: string | number | null | undefined) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatDate(dateValue?: Date | null) {
  if (!dateValue) return '—'
  return new Date(dateValue).toLocaleDateString('en-IN')
}

function normalizeIndianPhone(phone: string) {
  const digits = phone.replace(/\D/g, '').replace(/^0+/, '')
  if (!digits) return ''
  return digits.startsWith('91') ? digits : `91${digits}`
}

async function sendSupplierWhatsApp(phoneNumberId: string, apiToken: string, to: string, text: string) {
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, error: `WhatsApp API error: ${errorText}` }
    }

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'WhatsApp send failed'
    return { success: false, error: message }
  }
}

async function notifySupplierForPurchaseOrder(poId: number, source: 'approved' | 'manual') {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      supplier: {
        select: {
          name: true,
          email: true,
          phone: true,
          contactPerson: true,
        },
      },
      items: true,
    },
  })

  if (!po) return { success: false, error: 'Purchase order not found' }
  if (po.status === 'CANCELLED') return { success: false, error: 'Cannot send a cancelled purchase order' }

  const settings = await prisma.storeSettings.findFirst({ where: { id: 1 } })
  const storeName = settings?.storeName || getBrand().name

  const supplierPhone = po.supplier?.phone ? normalizeIndianPhone(po.supplier.phone) : ''
  const hasSupplierEmail = Boolean(po.supplier?.email)

  const waChannel = await prisma.channelConfig.findUnique({ where: { channel: 'WhatsApp' } })
  const waConfig = waChannel?.enabled ? (waChannel.config as Record<string, string>) : null
  const hasWhatsAppSetup = Boolean(waConfig?.phoneNumberId && waConfig?.apiToken && supplierPhone)

  if (!hasSupplierEmail && !hasWhatsAppSetup) {
    return {
      success: false,
      error: 'Supplier contact missing. Add supplier email or phone with WhatsApp channel enabled.',
    }
  }

  const itemRows = po.items
    .map(item => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;">${escapeHtml(item.name)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#666;">${escapeHtml(item.sku)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:center;">${item.quantity}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${Number(item.unitCost || 0).toLocaleString('en-IN')}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:right;font-weight:600;">${Number(item.amount || 0).toLocaleString('en-IN')}</td>
      </tr>
    `)
    .join('')

  const emailHtml = `
    <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#1f2937;">
      <h2 style="margin:0 0 8px;">Purchase Order ${escapeHtml(po.displayId)}</h2>
      <p style="margin:0 0 16px;color:#4b5563;">Dear ${escapeHtml(po.supplier.contactPerson || po.supplier.name)}, please find your purchase order details below.</p>

      <table style="width:100%;border-collapse:collapse;margin:10px 0 14px;">
        <tbody>
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#6b7280;">Supplier</td>
            <td style="padding:6px 0;font-size:13px;font-weight:600;">${escapeHtml(po.supplier.name)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#6b7280;">PO Date</td>
            <td style="padding:6px 0;font-size:13px;">${formatDate(po.date)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#6b7280;">Expected Delivery</td>
            <td style="padding:6px 0;font-size:13px;">${formatDate(po.expectedDate)}</td>
          </tr>
        </tbody>
      </table>

      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:10px;text-align:left;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;">Product</th>
            <th style="padding:10px;text-align:left;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;">SKU</th>
            <th style="padding:10px;text-align:center;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;">Qty</th>
            <th style="padding:10px;text-align:right;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;">Unit Cost</th>
            <th style="padding:10px;text-align:right;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;">Amount</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <div style="margin-top:14px;padding:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
        <p style="margin:0 0 4px;font-size:13px;">Subtotal: <strong>INR ${Number(po.subtotal || 0).toLocaleString('en-IN')}</strong></p>
        <p style="margin:0 0 4px;font-size:13px;">GST: <strong>INR ${Number(po.gst || 0).toLocaleString('en-IN')}</strong></p>
        <p style="margin:0;font-size:14px;">PO Total: <strong>INR ${Number(po.total || 0).toLocaleString('en-IN')}</strong></p>
      </div>

      <p style="margin:16px 0 6px;font-size:12px;color:#4b5563;">Please acknowledge this PO and share your delivery confirmation timeline.</p>
      <p style="margin:0;font-size:12px;color:#6b7280;">Issued by ${escapeHtml(storeName)}${settings?.phone ? ` | ${escapeHtml(settings.phone)}` : ''}${settings?.email ? ` | ${escapeHtml(settings.email)}` : ''}</p>
    </div>
  `

  const whatsappLines = [
    `*Purchase Order ${po.displayId}*`,
    `Supplier: ${po.supplier.name}`,
    `PO Date: ${formatDate(po.date)}`,
    `Expected Delivery: ${formatDate(po.expectedDate)}`,
    `Total: INR ${Number(po.total || 0).toLocaleString('en-IN')}`,
    '',
    'Items:',
    ...po.items.map(item => `- ${item.name} (${item.sku}) | Qty ${item.quantity} | INR ${Number(item.amount || 0).toLocaleString('en-IN')}`),
    '',
    `Issued by ${storeName}`,
  ]
  const whatsappText = whatsappLines.join('\n')

  const deliveredChannels: string[] = []
  const channelErrors: string[] = []

  if (hasSupplierEmail && po.supplier.email) {
    const emailResult = await sendEmail({
      to: po.supplier.email,
      subject: `${storeName} | Purchase Order ${po.displayId}`,
      html: emailHtml,
    })

    if (emailResult.success) deliveredChannels.push('Email')
    else channelErrors.push(`Email: ${emailResult.error || 'send failed'}`)
  }

  if (hasWhatsAppSetup && waConfig && supplierPhone) {
    const waResult = await sendSupplierWhatsApp(
      waConfig.phoneNumberId,
      waConfig.apiToken,
      supplierPhone,
      whatsappText
    )
    if (waResult.success) deliveredChannels.push('WhatsApp')
    else channelErrors.push(`WhatsApp: ${waResult.error || 'send failed'}`)
  }

  if (deliveredChannels.length === 0) {
    const reason = channelErrors.length > 0 ? channelErrors.join(' | ') : 'No communication channel available'

    try {
      await prisma.notification.create({
        data: {
          type: 'purchase_order',
          title: `PO ${po.displayId} notification failed`,
          subtitle: `${po.supplier.name} | ${reason}`,
          href: '/purchases',
          metadata: {
            poId: po.id,
            supplierId: po.supplierId,
            source,
          },
        },
      })
    } catch {
      // Notification logging must not block purchase flow.
    }

    return { success: false, error: reason }
  }

  const noteLine = `[SUPPLIER_NOTIFIED ${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${source === 'approved' ? 'Auto on approval' : 'Manual resend'} via ${deliveredChannels.join(', ')}`

  await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: {
      notes: po.notes ? `${po.notes}\n${noteLine}` : noteLine,
    },
  })

  try {
    await prisma.notification.create({
      data: {
        type: 'purchase_order',
        title: `PO ${po.displayId} sent to supplier`,
        subtitle: `${po.supplier.name} | ${source === 'approved' ? 'Auto on approval' : 'Manually sent'} via ${deliveredChannels.join(', ')}`,
        href: '/purchases',
        metadata: {
          poId: po.id,
          supplierId: po.supplierId,
          source,
          email: po.supplier.email,
          phone: po.supplier.phone,
          channels: deliveredChannels,
          errors: channelErrors,
        },
      },
    })
  } catch {
    // In-app notification is best-effort only.
  }

  return { success: true, message: `PO sent via ${deliveredChannels.join(', ')}` }
}

// ─── SUPPLIERS ───────────────────────────────────────

export async function getSuppliers() {
  const suppliers = await prisma.supplier.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { purchaseOrders: true } },
    },
  })
  return { success: true, data: suppliers }
}

export async function createSupplier(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createSupplierSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const supplier = await prisma.supplier.create({ data: parsed.data })
  revalidatePath('/purchases')
  return { success: true, data: supplier }
}

export async function updateSupplier(id: number, data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createSupplierSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const supplier = await prisma.supplier.update({ where: { id }, data: parsed.data })
  revalidatePath('/purchases')
  return { success: true, data: supplier }
}

// ─── PURCHASE ORDERS ─────────────────────────────────

export async function getPurchaseOrders() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied', data: [] } }
  const pos = await prisma.purchaseOrder.findMany({
    orderBy: { date: 'desc' },
    include: {
      supplier: { select: { name: true, phone: true, email: true, contactPerson: true, gstNumber: true, address: true, paymentTerms: true } },
      items: { include: { product: { select: { name: true, sku: true, isSlabTracked: true, thicknessMm: true } } } },
    },
  })
  return { success: true, data: pos }
}

export async function createPurchaseOrder(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createPurchaseOrderSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { supplierId, expectedDate, notes, discount, isRCM, itcEligible, itcCategory, items } = parsed.data

  // Calculate totals
  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitCost, 0)
  const discountAmt = Math.min(discount, subtotal)
  const taxable = Math.max(0, subtotal - discountAmt)
  const grossGst = items.reduce((sum, i) => {
    const lineAmount = i.quantity * i.unitCost
    const rate = typeof i.gstRate === 'number' ? i.gstRate : 18
    return sum + Math.round(lineAmount * rate / 100)
  }, 0)
  const discountFactor = subtotal > 0 ? (taxable / subtotal) : 1
  const gst = Math.max(0, Math.round(grossGst * discountFactor))
  const cgst = Math.round(gst / 2)
  const sgst = gst - cgst
  const total = taxable + gst

  // Sequenced under an advisory lock: count()+1 collided after deletes and
  // under concurrent creation.
  const po = await prisma.$transaction(async tx => tx.purchaseOrder.create({
    data: {
      displayId: await nextSequence(tx, 'PurchaseOrder'),
      supplierId,
      notes,
      discount: discountAmt,
      subtotal,
      gst,
      cgst,
      sgst,
      total,
      balanceDue: total,
      isRCM,
      itcEligible,
      itcCategory,
      expectedDate: expectedDate ? new Date(expectedDate) : undefined,
      items: {
        create: items.map(i => ({
          productId: i.productId,
          name: i.name,
          sku: i.sku,
          hsnCode: i.hsnCode,
          quantity: i.quantity,
          unitCost: i.unitCost,
          gstRate: i.gstRate,
          amount: i.quantity * i.unitCost,
        })),
      },
    },
    include: { items: true },
  }))

  revalidatePath('/purchases')
  return { success: true, data: po }
}

export async function updatePurchaseOrder(id: number, data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createPurchaseOrderSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const existing = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: { items: true },
  })

  if (!existing) return { success: false, error: 'Purchase order not found' }
  if (existing.status !== 'DRAFT') {
    return { success: false, error: 'Only DRAFT purchase orders can be edited' }
  }

  const { supplierId, expectedDate, notes, discount, isRCM, itcEligible, itcCategory, items } = parsed.data

  // Recalculate PO totals from updated line items.
  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitCost, 0)
  const discountAmt = Math.min(discount, subtotal)
  const taxable = Math.max(0, subtotal - discountAmt)
  const grossGst = items.reduce((sum, i) => {
    const lineAmount = i.quantity * i.unitCost
    const rate = typeof i.gstRate === 'number' ? i.gstRate : 18
    return sum + Math.round(lineAmount * rate / 100)
  }, 0)
  const discountFactor = subtotal > 0 ? (taxable / subtotal) : 1
  const gst = Math.max(0, Math.round(grossGst * discountFactor))
  const cgst = Math.round(gst / 2)
  const sgst = gst - cgst
  const total = taxable + gst

  if (total < existing.amountPaid) {
    return { success: false, error: 'Updated total cannot be less than amount already paid' }
  }

  const po = await prisma.$transaction(async (tx) => {
    await tx.purchaseOrderItem.deleteMany({ where: { poId: id } })

    return tx.purchaseOrder.update({
      where: { id },
      data: {
        supplierId,
        notes,
        discount: discountAmt,
        subtotal,
        gst,
        cgst,
        sgst,
        total,
        balanceDue: Math.max(0, total - existing.amountPaid),
        isRCM,
        itcEligible,
        itcCategory,
        expectedDate: expectedDate ? new Date(expectedDate) : null,
        items: {
          create: items.map(i => ({
            productId: i.productId,
            name: i.name,
            sku: i.sku,
            hsnCode: i.hsnCode,
            quantity: i.quantity,
            unitCost: i.unitCost,
            gstRate: i.gstRate,
            amount: i.quantity * i.unitCost,
          })),
        },
      },
      include: { items: true },
    })
  })

  revalidatePath('/purchases')
  return { success: true, data: po }
}

export async function approvePurchaseOrder(id: number) {
  let session
  try { session = await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const po = await prisma.purchaseOrder.findUnique({ where: { id } })
  if (!po) return { success: false, error: 'Purchase order not found' }
  if (po.status !== 'DRAFT') return { success: false, error: 'Only DRAFT orders can be approved' }

  // Odoo "Order approval" (double validation): large POs need an administrator.
  const settings = await prisma.storeSettings.findFirst({ where: { id: 1 }, select: { poApprovalLimit: true } })
  const limit = settings?.poApprovalLimit || 0
  if (limit > 0 && po.total > limit && session.user.role !== 'ADMIN') {
    return { success: false, error: `POs above ₹${limit.toLocaleString('en-IN')} need administrator approval` }
  }
  const author = { id: Number(session.user.id) || null, name: session.user.name }

  try {
    await prisma.$transaction(async tx => {
      const approved = await tx.purchaseOrder.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'APPROVED' } })
      if (approved.count !== 1) throw new Error('Only DRAFT orders can be approved')
      await logTracking(tx, 'PurchaseOrder', id, 'Purchase order approved', [{ field: 'Status', from: 'DRAFT', to: 'APPROVED' }], author)
      await ensureReceiptForPurchaseOrder(tx, id, author)
    })
  } catch (error) {
    return { success: false, error: inventoryError(error) }
  }

  const notifyResult = await notifySupplierForPurchaseOrder(id, 'approved')
  revalidatePath('/purchases')

  if (!notifyResult.success) {
    return {
      success: true,
      warning: `PO approved. Supplier notification failed: ${notifyResult.error}`,
    }
  }

  return {
    success: true,
    message: notifyResult.message || 'PO approved and supplier notified',
  }
}

export async function sendPurchaseOrderToSupplier(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const po = await prisma.purchaseOrder.findUnique({ where: { id } })
  if (!po) return { success: false, error: 'Purchase order not found' }
  if (po.status === 'CANCELLED') return { success: false, error: 'Cannot send a cancelled purchase order' }

  const notifyResult = await notifySupplierForPurchaseOrder(id, 'manual')
  revalidatePath('/purchases')

  if (!notifyResult.success) return { success: false, error: notifyResult.error }
  return { success: true, message: notifyResult.message }
}

export async function receivePurchaseOrder(id: number, godownId?: number) {
  let session
  try { session = await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: { items: { include: { product: { select: { isSlabTracked: true } } } } },
  })
  if (!po) return { success: false, error: 'Purchase order not found' }
  if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
    return { success: false, error: 'Order must be approved before receiving' }
  }

  const pendingItems = po.items.filter(item => item.receivedQty < item.quantity)
  if (pendingItems.length === 0) {
    return { success: false, error: 'All items in this order are already received' }
  }
  if (pendingItems.some(item => item.product.isSlabTracked)) {
    return { success: false, error: 'This purchase order contains slab-tracked stone. Receive it from Inventory → Lot / Slab Explorer with lot, slab dimensions, shade and photos so physical inventory is not lost.' }
  }
  const author = { id: Number(session.user.id) || null, name: session.user.name }

  // "Receive all" validates the PO's goods receipt (GRN) for every pending
  // quantity. Partial receipts and backorders run from Operations → Receipts.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id} FOR UPDATE`
      const livePo = await tx.purchaseOrder.findUnique({ where: { id }, select: { status: true } })
      if (!livePo || !['APPROVED', 'PARTIALLY_RECEIVED'].includes(livePo.status)) throw new Error('This order has already been received or its status changed')
      const receipt = await ensureReceiptForPurchaseOrder(tx, id, author)
      if (!receipt) throw new Error('All items in this order are already received')
      if (godownId && godownId !== receipt.godownId) {
        await resolveStockGodown(tx, godownId)
        await tx.stockPicking.update({ where: { id: receipt.id }, data: { godownId } })
      }
      const lines = await tx.stockPickingLine.findMany({ where: { pickingId: receipt.id } })
      await validatePickingTx(tx, receipt.id, { lines: lines.map(line => ({ lineId: line.id, doneQty: line.demandQty })), createBackorder: false }, author)
    }, { timeout: 20000 })
  } catch (error) { return { success: false, error: inventoryError(error) } }

  revalidatePath('/purchases')
  revalidatePath('/inventory')
  revalidatePath('/operations')
  return { success: true }
}

const stonePurchaseReceiveSchema = z.object({
  poId: z.number().int().positive(),
  poItemId: z.number().int().positive(),
  lotNumber: z.string().trim().min(1),
  godownId: z.number().int().positive().optional(),
  origin: z.string().trim().optional(),
  shadeCode: z.string().trim().optional(),
  qualityGrade: z.string().trim().optional(),
  avgThicknessMm: z.number().positive().optional(),
  costPerSqft: z.number().int().min(0).optional(),
  notes: z.string().trim().optional(),
  slabs: z.array(z.object({
    slabNumber: z.string().trim().min(1),
    lengthInches: z.number().positive(),
    widthInches: z.number().positive(),
    thicknessMm: z.number().positive().optional(),
    photo: z.string().optional(),
    qcGrade: z.string().optional(),
  })).min(1),
})

export async function receiveStoneLotFromPurchaseOrder(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = stonePurchaseReceiveSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const input = parsed.data
  const po = await prisma.purchaseOrder.findUnique({ where: { id: input.poId }, include: { supplier: true, items: { where: { id: input.poItemId }, include: { product: true } } } })
  const item = po?.items[0]
  if (!po || !item) return { success: false, error: 'Purchase order item not found' }
  if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) return { success: false, error: 'Approve the purchase order before receiving stone' }
  if (!item.product.isSlabTracked) return { success: false, error: 'This item is not configured for slab tracking' }
  const pendingQty = item.quantity - item.receivedQty
  if (pendingQty <= 0) return { success: false, error: 'This PO line is already fully received' }
  if (input.slabs.length > pendingQty) return { success: false, error: `Only ${pendingQty} slab(s) remain to be received for this PO line` }

  try {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${input.poId} FOR UPDATE`
      await lockInventoryProducts(tx, [item.productId])
      const livePo = await tx.purchaseOrder.findUnique({ where: { id: input.poId }, include: { items: true } })
      const liveItem = livePo?.items.find(row => row.id === input.poItemId)
      if (!livePo || !liveItem || !['APPROVED', 'PARTIALLY_RECEIVED'].includes(livePo.status)) throw new Error('Purchase order is no longer open for receiving')
      if (input.slabs.length > liveItem.quantity - liveItem.receivedQty) throw new Error('This PO line has insufficient remaining quantity. Refresh and try again.')
      if (input.godownId && !await tx.godown.findUnique({ where: { id: input.godownId } })) throw new Error('Location not found')
      const totalSqft = input.slabs.reduce((sum, slab) => sum + (slab.lengthInches * slab.widthInches / 144), 0)
      const lot = await tx.stoneLot.create({
        data: {
          lotNumber: input.lotNumber,
          productId: item.productId,
          supplierId: po.supplierId,
          poId: po.id,
          origin: input.origin || null,
          shadeCode: input.shadeCode || null,
          qualityGrade: input.qualityGrade || null,
          avgThicknessMm: input.avgThicknessMm ?? item.product.thicknessMm ?? null,
          totalSlabs: input.slabs.length,
          totalSqft,
          costPerSqft: input.costPerSqft ?? item.unitCost,
          notes: input.notes || null,
          slabs: {
            create: input.slabs.map(slab => ({
              slabNumber: slab.slabNumber,
              lengthInches: slab.lengthInches,
              widthInches: slab.widthInches,
              sqft: Math.round((slab.lengthInches * slab.widthInches / 144) * 100) / 100,
              thicknessMm: slab.thicknessMm ?? input.avgThicknessMm ?? item.product.thicknessMm ?? null,
              photo: slab.photo || null,
              qcGrade: slab.qcGrade || null,
              godownId: input.godownId,
            })),
          },
        },
      })
      await syncStoneLotTotals(tx, lot.id)
      const receivedQty = liveItem.receivedQty + input.slabs.length
      const allReceived = livePo.items.every(row => row.id === liveItem.id ? receivedQty >= row.quantity : row.receivedQty >= row.quantity)
      await tx.purchaseOrderItem.update({ where: { id: item.id }, data: { receivedQty } })
      await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: allReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED', receivedAt: allReceived ? new Date() : undefined } })
      return lot
    })
    revalidatePath('/purchases')
    revalidatePath('/inventory')
    return { success: true, data: result }
  } catch (error: any) {
    if (error?.code === 'P2002') return { success: false, error: 'That lot number or slab number already exists' }
    return { success: false, error: error?.message || 'Could not receive stone lot' }
  }
}

export async function recordPurchaseOrderPayment(
  id: number,
  amount: number,
  note?: string,
  method: string = 'Bank Transfer',
  reference?: string,
  paidAt?: string
) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: 'Payment amount must be greater than 0' }
  }

  const paymentDate = paidAt ? new Date(paidAt) : new Date()
  if (Number.isNaN(paymentDate.getTime())) {
    return { success: false, error: 'Invalid payment date' }
  }

  const po = await prisma.purchaseOrder.findUnique({ where: { id } })
  if (!po) return { success: false, error: 'Purchase order not found' }
  if (po.status === 'CANCELLED') return { success: false, error: 'Cannot record payment for a cancelled PO' }
  if (po.balanceDue <= 0) return { success: false, error: 'This PO is already fully paid' }
  if (amount > po.balanceDue) return { success: false, error: 'Payment cannot exceed pending balance' }

  const paymentLine = `[PAYMENT ${paymentDate.toISOString().slice(0, 10)}] Rs. ${amount.toLocaleString('en-IN')} via ${method}${reference?.trim() ? ` (${reference.trim()})` : ''}${note?.trim() ? ` - ${note.trim()}` : ''}`

  const updated = await prisma.$transaction(async (tx) => {
    await tx.purchasePayment.create({
      data: {
        poId: id,
        amount,
        method,
        reference,
        notes: note,
        paidAt: paymentDate,
      },
    })

    return tx.purchaseOrder.update({
      where: { id },
      data: {
        amountPaid: { increment: amount },
        balanceDue: { decrement: amount },
        notes: po.notes ? `${po.notes}\n${paymentLine}` : paymentLine,
      },
    })
  })

  revalidatePath('/purchases')
  return { success: true, data: updated }
}

export async function cancelPurchaseOrder(id: number) {
  let session
  try { session = await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: { items: { select: { receivedQty: true } } } })
  if (!po) return { success: false, error: 'Not found' }
  if (po.status === 'RECEIVED') return { success: false, error: 'Cannot cancel a received order' }
  if (po.status === 'CANCELLED') return { success: false, error: 'This order is already cancelled' }
  if (po.items.some(item => item.receivedQty > 0)) {
    return { success: false, error: 'Goods were already received on this PO. Validate its open receipt with "No backorder" to close it short, or create a purchase return.' }
  }
  const author = { id: Number(session.user.id) || null, name: session.user.name }

  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id} FOR UPDATE`
      const received = await tx.purchaseOrderItem.count({ where: { poId: id, receivedQty: { gt: 0 } } })
      if (received > 0) throw new Error('Goods were received on this PO meanwhile. Refresh and try again.')
      const receipts = await tx.stockPicking.findMany({ where: { purchaseOrderId: id, status: 'READY' }, select: { id: true } })
      for (const receipt of receipts) await cancelPickingTx(tx, receipt.id, author)
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
      await logTracking(tx, 'PurchaseOrder', id, 'Purchase order cancelled', [{ field: 'Status', from: po.status, to: 'CANCELLED' }], author)
    })
  } catch (error) {
    return { success: false, error: inventoryError(error) }
  }
  revalidatePath('/purchases')
  return { success: true }
}

// ─── PURCHASE RETURNS ─────────────────────────────────

export async function getPurchaseReturns() {
  const returns = await prisma.purchaseReturn.findMany({
    orderBy: { date: 'desc' },
    include: {
      supplier: { select: { name: true } },
      po: { select: { displayId: true } },
      items: true,
    },
  })
  return { success: true, data: returns }
}

export async function createPurchaseReturn(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createPurchaseReturnSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { supplierId, poId, godownId: requestedGodownId, reason, notes, items } = parsed.data
  const totalAmount = items.reduce((sum, i) => sum + i.quantity * i.unitCost, 0)

  const godown = requestedGodownId
    ? await prisma.godown.findUnique({ where: { id: requestedGodownId }, select: { id: true } })
    : await getOrCreateDefaultGodown()
  if (!godown) return { success: false, error: 'Selected godown was not found' }

  const productIds = Array.from(new Set(items.map(item => item.productId)))
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true, stock: true, isSlabTracked: true },
  })
  const productById = new Map(products.map(product => [product.id, product]))
  for (const item of items) {
    const product = productById.get(item.productId)
    if (!product) return { success: false, error: `Product ${item.productId} was not found` }
    if (product.isSlabTracked) {
      return { success: false, error: `${product.name} is slab-tracked. Return the exact physical slab from Lot / Slab Explorer instead of reducing aggregate stock.` }
    }
  }

  let ret
  try {
    ret = await prisma.$transaction(async tx => {
      await lockInventoryProducts(tx, productIds)
      if (poId) {
        const po = await tx.purchaseOrder.findUnique({ where: { id: poId } })
        if (!po || po.supplierId !== supplierId) throw new Error('Selected purchase order does not belong to this supplier')
      }
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463104)::text`
      const lastReturn = await tx.purchaseReturn.findFirst({ orderBy: { id: 'desc' }, select: { displayId: true } })
      const nextNumber = Number(lastReturn?.displayId.match(/(\d+)$/)?.[1] || 0) + 1
      const created = await tx.purchaseReturn.create({ data: {
        displayId: `PRN-${String(nextNumber).padStart(4, '0')}`, supplierId, poId, reason, notes, totalAmount,
        items: { create: items.map(item => ({ productId: item.productId, name: item.name, sku: item.sku, quantity: item.quantity, unitCost: item.unitCost })) },
      } })
      for (const item of items) {
        const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId } })
        if (product.isSlabTracked) throw new Error('Return physical slabs through their serialized inventory workflow')
        const batches = await tx.productBatch.findMany({ where: { productId: item.productId, remainingQty: { gt: 0 } }, orderBy: [{ purchaseDate: 'asc' }, { id: 'asc' }] })
        const unassigned = Math.max(0, product.stock - batches.reduce((sum, batch) => sum + batch.remainingQty, 0))
        let remaining = item.quantity
        const details: string[] = []
        for (const batch of batches.filter(batch => batch.supplierId === supplierId && (!poId || batch.poId === poId))) {
          const quantity = Math.min(remaining, batch.remainingQty)
          if (!quantity) break
          await tx.productBatch.update({ where: { id: batch.id }, data: { remainingQty: { decrement: quantity } } })
          remaining -= quantity
          details.push(`${batch.batchNumber}: ${quantity}`)
        }
        if (remaining > unassigned) throw new Error('Return quantity exceeds this supplier’s available batches and unassigned stock')
        await adjustStock(tx, item.productId, godown.id, -item.quantity, 'OUT', {
          referenceType: 'PurchaseReturn', referenceId: created.id,
          notes: ['Stock returned to supplier', ...details].join(' · '),
        })
      }
      return created
    })
  } catch (error) { return { success: false, error: inventoryError(error) } }

  revalidatePath('/purchases')
  revalidatePath('/inventory')
  return { success: true, data: ret }
}

export async function getPurchaseStats() {
  const [totalPOs, totalSpend, pendingPOs, totalSuppliers, overduePOs, outstandingPayables] = await Promise.all([
    prisma.purchaseOrder.count(),
    prisma.purchaseOrder.aggregate({
      where: { status: { in: ['APPROVED', 'RECEIVED', 'PARTIALLY_RECEIVED'] } },
      _sum: { total: true },
    }),
    prisma.purchaseOrder.count({ where: { status: { in: ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED'] } } }),
    prisma.supplier.count(),
    prisma.purchaseOrder.count({
      where: {
        expectedDate: { lt: new Date() },
        status: { in: ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED'] },
      },
    }),
    prisma.purchaseOrder.aggregate({
      where: {
        status: { not: 'CANCELLED' },
      },
      _sum: { balanceDue: true },
    }),
  ])

  return {
    success: true,
    data: {
      totalPOs,
      totalSpend: totalSpend._sum.total || 0,
      pendingPOs,
      overduePOs,
      totalSuppliers,
      suppliers: totalSuppliers,
      outstandingPayables: outstandingPayables._sum.balanceDue || 0,
    },
  }
}
