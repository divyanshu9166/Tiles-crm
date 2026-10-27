'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireActor, actionError } from '@/lib/erp/actor'
import { nextSequence } from '@/lib/erp/sequence'
import { logMessage, logTracking } from '@/lib/erp/chatter'
import { billMatchStatus, billTotals, billableQty, matchLine, poBillingStatus } from '@/lib/erp/bill-match'

type Tx = Prisma.TransactionClient
const ROLES = ['ADMIN', 'MANAGER'] as const

function refresh() {
  revalidatePath('/vendor-bills')
  revalidatePath('/purchases')
}

function parseDate(value?: string | null) {
  if (!value) return null
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date')
  return date
}

async function lockBill(tx: Tx, id: number) {
  await tx.$queryRaw`SELECT id FROM "VendorBill" WHERE id = ${id} FOR UPDATE`
  const bill = await tx.vendorBill.findUnique({ where: { id }, include: { lines: { include: { poItem: true } } } })
  if (!bill) throw new Error('Vendor bill not found')
  return bill
}

async function recompute(tx: Tx, billId: number) {
  const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id: billId }, include: { lines: { include: { poItem: true } } } })
  for (const line of bill.lines) {
    const amount = line.quantity * line.unitCost
    if (amount !== line.amount) await tx.vendorBillLine.update({ where: { id: line.id }, data: { amount } })
  }
  const totals = billTotals(bill.lines, bill.supplyType)
  // A posted bill's own quantity is already inside billedQty; match against the rest.
  const matchStatus = billMatchStatus(bill.lines.map(line => ({
    quantity: line.quantity,
    unitCost: line.unitCost,
    poItem: line.poItem && { ...line.poItem, billedQty: line.poItem.billedQty - (bill.status === 'POSTED' ? line.quantity : 0) },
  })))
  return tx.vendorBill.update({ where: { id: billId }, data: { ...totals, matchStatus } })
}

export async function getVendorBills(filters: { status?: string; search?: string } = {}) {
  try {
    await requireActor(...ROLES)
    const search = filters.search?.trim()
    const bills = await prisma.vendorBill.findMany({
      where: {
        ...(filters.status && filters.status !== 'ALL' ? (filters.status === 'TO_CHECK' ? { matchStatus: 'TO_CHECK', status: { not: 'CANCELLED' } } : { status: filters.status }) : {}),
        ...(search ? { OR: [
          { displayId: { contains: search, mode: 'insensitive' } },
          { vendorRef: { contains: search, mode: 'insensitive' } },
          { supplier: { name: { contains: search, mode: 'insensitive' } } },
          { po: { displayId: { contains: search, mode: 'insensitive' } } },
        ] } : {}),
      },
      orderBy: { id: 'desc' },
      take: 300,
      include: { supplier: { select: { id: true, name: true } }, po: { select: { id: true, displayId: true } }, payments: { select: { amount: true } } },
    })
    const toBill = await prisma.purchaseOrder.findMany({
      where: { status: { in: ['PARTIALLY_RECEIVED', 'RECEIVED'] } },
      select: { id: true, displayId: true, supplier: { select: { name: true } }, items: { select: { quantity: true, receivedQty: true, billedQty: true, unitCost: true } } },
      orderBy: { id: 'desc' },
      take: 200,
    })
    return {
      success: true as const,
      data: {
        // Odoo payment_state: not paid / partial / paid.
        bills: bills.map(({ payments, ...bill }) => {
          const amountPaid = payments.reduce((sum, payment) => sum + payment.amount, 0)
          return { ...bill, amountPaid, residual: Math.max(0, bill.total - amountPaid), paymentState: bill.status !== 'POSTED' ? null : amountPaid >= bill.total ? 'PAID' : amountPaid > 0 ? 'PARTIAL' : 'NOT_PAID' }
        }),
        posToBill: toBill.filter(po => poBillingStatus(po.items) === 'TO_BILL').map(po => ({
          id: po.id, displayId: po.displayId, supplier: po.supplier.name,
          billableValue: po.items.reduce((sum, item) => sum + billableQty(item) * item.unitCost, 0),
        })),
      },
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load vendor bills') }
  }
}

export async function getVendorBill(id: number) {
  try {
    await requireActor(...ROLES)
    const bill = await prisma.vendorBill.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true, gstNumber: true, paymentTerms: true } },
        po: { select: { id: true, displayId: true, total: true, amountPaid: true, balanceDue: true, status: true } },
        lines: { orderBy: { id: 'asc' }, include: { poItem: true } },
        payments: { orderBy: { paidAt: 'asc' }, select: { id: true, amount: true, method: true, reference: true, paidAt: true, createdBy: true } },
      },
    })
    if (!bill) return { success: false as const, error: 'Vendor bill not found' }
    const advances = bill.poId ? (await prisma.purchasePayment.aggregate({ where: { poId: bill.poId, billId: null }, _sum: { amount: true } }))._sum.amount || 0 : 0
    return {
      success: true as const,
      data: {
        ...bill,
        outstandingAdvances: advances,
        amountPaid: bill.payments.reduce((sum, payment) => sum + payment.amount, 0),
        residual: Math.max(0, bill.total - bill.payments.reduce((sum, payment) => sum + payment.amount, 0)),
        lines: bill.lines.map(line => {
          const po = line.poItem && { ...line.poItem, billedQty: line.poItem.billedQty - (bill.status === 'POSTED' ? line.quantity : 0) }
          return { ...line, match: matchLine({ quantity: line.quantity, unitCost: line.unitCost, poItem: po }) }
        }),
      },
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load the vendor bill') }
  }
}

// Odoo "Create Bill" on a PO: bills received-but-unbilled quantities at PO prices.
export async function createBillFromPurchaseOrder(poId: number) {
  try {
    const actor = await requireActor(...ROLES)
    const bill = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${poId} FOR UPDATE`
      const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, include: { items: true, supplier: { select: { paymentTerms: true } } } })
      if (!po) throw new Error('Purchase order not found')
      if (po.status === 'CANCELLED' || po.status === 'DRAFT') throw new Error('Approve and receive the PO before billing it')
      const draft = await tx.vendorBill.findFirst({ where: { poId, status: 'DRAFT' }, select: { id: true, displayId: true } })
      if (draft) throw new Error(`Draft bill ${draft.displayId} is already open for this PO`)
      const lines = po.items.flatMap(item => {
        const qty = billableQty(item)
        return qty > 0 ? [{ poItemId: item.id, productId: item.productId, name: item.name, quantity: qty, unitCost: item.unitCost, gstRate: item.gstRate, amount: qty * item.unitCost }] : []
      })
      if (lines.length === 0) throw new Error('Nothing to bill: every received quantity is already billed')
      const dueDate = new Date()
      dueDate.setDate(dueDate.getDate() + (po.supplier.paymentTerms || 30))
      const created = await tx.vendorBill.create({
        data: {
          displayId: await nextSequence(tx, 'VendorBill'),
          supplierId: po.supplierId, poId: po.id, dueDate,
          supplyType: po.igst > 0 ? 'INTERSTATE' : 'INTRASTATE',
          createdBy: actor.name,
          lines: { create: lines },
        },
      })
      await recompute(tx, created.id)
      await logMessage(tx, 'VendorBill', created.id, `Draft bill created from ${po.displayId}`, { author: actor })
      await logMessage(tx, 'PurchaseOrder', po.id, `Vendor bill ${created.displayId} drafted`, { author: actor })
      return created
    })
    refresh()
    return { success: true as const, data: { id: bill.id, displayId: bill.displayId } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not create the bill') }
  }
}

const updateSchema = z.object({
  id: z.number().int().positive(),
  vendorRef: z.string().trim().max(60).optional(),
  billDate: z.string().optional(),
  dueDate: z.string().optional().nullable(),
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({ id: z.number().int().positive(), quantity: z.number().int().min(0), unitCost: z.number().int().min(0) })).optional(),
})

export async function updateVendorBill(data: unknown) {
  try {
    await requireActor(...ROLES)
    const input = updateSchema.parse(data)
    await prisma.$transaction(async tx => {
      const bill = await lockBill(tx, input.id)
      if (bill.status !== 'DRAFT') throw new Error('Only draft bills can be edited')
      await tx.vendorBill.update({
        where: { id: bill.id },
        data: {
          vendorRef: input.vendorRef ?? bill.vendorRef,
          billDate: input.billDate ? parseDate(input.billDate) ?? bill.billDate : bill.billDate,
          dueDate: input.dueDate === undefined ? bill.dueDate : parseDate(input.dueDate),
          notes: input.notes ?? bill.notes,
        },
      })
      for (const line of input.lines || []) {
        if (!bill.lines.some(existing => existing.id === line.id)) throw new Error('A bill line does not belong to this bill')
        if (line.quantity === 0) await tx.vendorBillLine.delete({ where: { id: line.id } })
        else await tx.vendorBillLine.update({ where: { id: line.id }, data: { quantity: line.quantity, unitCost: line.unitCost } })
      }
      await recompute(tx, bill.id)
    })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not save the bill') }
  }
}

export async function postVendorBill(id: number, options: { acceptVariance?: boolean } = {}) {
  try {
    const actor = await requireActor(...ROLES)
    const result = await prisma.$transaction(async tx => {
      const bill = await lockBill(tx, id)
      if (bill.status !== 'DRAFT') throw new Error('Only draft bills can be posted')
      if (!bill.vendorRef?.trim()) throw new Error("Enter the supplier's invoice number before posting")
      if (bill.lines.length === 0) throw new Error('A bill needs at least one line')
      const duplicate = await tx.vendorBill.findFirst({ where: { id: { not: bill.id }, supplierId: bill.supplierId, vendorRef: bill.vendorRef, status: 'POSTED' }, select: { displayId: true } })
      if (duplicate) throw new Error(`Supplier invoice ${bill.vendorRef} is already posted as ${duplicate.displayId}`)
      if (bill.poId) await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${bill.poId} FOR UPDATE`
      // Re-read PO lines under lock, then apply the three-way match.
      const fresh = await tx.vendorBillLine.findMany({ where: { billId: bill.id }, include: { poItem: true } })
      const issues = fresh.flatMap(line => {
        const match = matchLine({ quantity: line.quantity, unitCost: line.unitCost, poItem: line.poItem })
        return [
          ...(match.qtyOk ? [] : [`${line.name}: billing ${line.quantity}, only ${match.billable} received and unbilled`]),
          ...(match.priceOk ? [] : [`${line.name}: price ₹${line.unitCost} vs PO ₹${line.poItem?.unitCost}`]),
        ]
      })
      const qtyIssue = fresh.some(line => !matchLine({ quantity: line.quantity, unitCost: line.unitCost, poItem: line.poItem }).qtyOk)
      if (qtyIssue) throw new Error(`Bill quantity exceeds goods received — ${issues.join('; ')}`)
      if (issues.length > 0 && !(options.acceptVariance && actor.role === 'ADMIN')) {
        throw new Error(`Price differs from the PO — an administrator must accept the variance. ${issues.join('; ')}`)
      }
      for (const line of fresh) {
        if (line.poItemId) await tx.purchaseOrderItem.update({ where: { id: line.poItemId }, data: { billedQty: { increment: line.quantity } } })
      }
      await tx.vendorBill.update({ where: { id: bill.id }, data: { status: 'POSTED', postedAt: new Date(), matchStatus: issues.length ? 'TO_CHECK' : 'MATCHED' } })
      await logTracking(tx, 'VendorBill', bill.id, issues.length ? `Posted with accepted variance: ${issues.join('; ')}` : 'Bill posted — matched to PO and receipts', [{ field: 'Status', from: 'DRAFT', to: 'POSTED' }], actor)
      if (bill.poId) await logMessage(tx, 'PurchaseOrder', bill.poId, `Vendor bill ${bill.displayId} (${bill.vendorRef}) posted for ₹${bill.total.toLocaleString('en-IN')}`, { author: actor })
      return { matched: issues.length === 0 }
    })
    refresh()
    return { success: true as const, data: result }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not post the bill') }
  }
}

export async function cancelVendorBill(id: number) {
  try {
    const actor = await requireActor(...ROLES)
    await prisma.$transaction(async tx => {
      const bill = await lockBill(tx, id)
      if (bill.status === 'CANCELLED') throw new Error('This bill is already cancelled')
      if (await tx.purchasePayment.count({ where: { billId: id } })) throw new Error('This bill has payments recorded against it — it cannot be cancelled')
      if (bill.status === 'POSTED') {
        for (const line of bill.lines) {
          if (line.poItemId) await tx.purchaseOrderItem.updateMany({ where: { id: line.poItemId, billedQty: { gte: line.quantity } }, data: { billedQty: { decrement: line.quantity } } })
        }
      }
      await tx.vendorBill.update({ where: { id }, data: { status: 'CANCELLED' } })
      await logTracking(tx, 'VendorBill', id, 'Bill cancelled', [{ field: 'Status', from: bill.status, to: 'CANCELLED' }], actor)
    })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not cancel the bill') }
  }
}
