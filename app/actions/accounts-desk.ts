'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireActor, actionError } from '@/lib/erp/actor'
import { logMessage } from '@/lib/erp/chatter'
import { ACC } from '@/lib/erp/accounting'
import { DEFAULT_LEVELS, daysOverdue, invoiceDueDate, levelFor, needsAction } from '@/lib/erp/followups'
import { sendEmail } from '@/lib/email'

const ROLES = ['ADMIN', 'MANAGER'] as const

function refresh() {
  revalidatePath('/accounts')
  revalidatePath('/vendor-bills')
  revalidatePath('/purchases')
}

async function ensureLevels() {
  const count = await prisma.followUpLevel.count()
  if (count === 0) await prisma.followUpLevel.createMany({ data: DEFAULT_LEVELS, skipDuplicates: true })
  return prisma.followUpLevel.findMany({ orderBy: { days: 'asc' } })
}

function startOfToday() {
  const today = new Date()
  return new Date(today.getFullYear(), today.getMonth(), today.getDate())
}

async function accountBalance(code: string) {
  const account = await prisma.ledgerAccount.findUnique({ where: { code }, select: { id: true, openingBalance: true } })
  if (!account) return null
  const sum = await prisma.journalLine.aggregate({ where: { accountId: account.id, journalEntry: { status: 'POSTED' } }, _sum: { debit: true, credit: true } })
  return account.openingBalance + (sum._sum.debit || 0) - (sum._sum.credit || 0)
}

// Bill payment state from the payments allocated to it.
async function billPayments(billIds: number[]) {
  if (billIds.length === 0) return new Map<number, number>()
  const rows = await prisma.purchasePayment.groupBy({ by: ['billId'], where: { billId: { in: billIds } }, _sum: { amount: true } })
  return new Map(rows.map(row => [row.billId as number, row._sum.amount || 0]))
}

// Odoo Accounting dashboard: one card per work queue, then the follow-up
// list and the bills to pay.
export async function getAccountsDesk() {
  try {
    await requireActor(...ROLES)
    const today = startOfToday()
    const weekAhead = new Date(today.getTime() + 7 * 86_400_000)
    const levels = await ensureLevels()
    const [openInvoices, draftBills, postedBills, unreconciled, cash, bank, gstOut, gstIn] = await Promise.all([
      prisma.invoice.findMany({
        where: { invoiceStatus: 'ACTIVE', heldAt: null, balanceDue: { gt: 0 } },
        select: { id: true, displayId: true, date: true, dueDate: true, total: true, balanceDue: true, contactId: true, contact: { select: { id: true, name: true, phone: true, email: true, followUpNextDate: true, followUpNote: true } } },
        orderBy: { date: 'asc' },
      }),
      prisma.vendorBill.count({ where: { status: 'DRAFT' } }),
      prisma.vendorBill.findMany({ where: { status: 'POSTED' }, include: { supplier: { select: { id: true, name: true } }, po: { select: { id: true, displayId: true } } }, orderBy: { dueDate: 'asc' } }),
      prisma.dailyPayment.count({ where: { status: 'Pending' } }),
      accountBalance(ACC.cash), accountBalance(ACC.bank), accountBalance(ACC.gstOutput), accountBalance(ACC.gstInput),
    ])

    const invoices = openInvoices.map(invoice => {
      const due = invoiceDueDate(invoice)
      return { ...invoice, due, daysOverdue: due < today ? daysOverdue(due, today) : 0 }
    })
    const overdue = invoices.filter(invoice => invoice.daysOverdue > 0)
    const dueSoon = invoices.filter(invoice => invoice.due >= today && invoice.due < weekAhead)

    // Group overdue invoices by customer for follow-up.
    const lastLogs = await prisma.followUpLog.findMany({
      where: { contactId: { in: [...new Set(overdue.map(invoice => invoice.contactId))] } },
      orderBy: { createdAt: 'desc' },
      include: { level: { select: { name: true } } },
    })
    const byContact = new Map<number, typeof overdue>()
    for (const invoice of overdue) byContact.set(invoice.contactId, [...(byContact.get(invoice.contactId) || []), invoice])
    const followUps = [...byContact.entries()].map(([contactId, rows]) => {
      const contact = rows[0].contact
      const oldest = Math.max(...rows.map(row => row.daysOverdue))
      const level = levelFor(oldest, levels)
      const last = lastLogs.find(log => log.contactId === contactId) || null
      return {
        contactId, name: contact.name, phone: contact.phone, email: contact.email,
        overdueAmount: rows.reduce((sum, row) => sum + row.balanceDue, 0),
        totalDue: invoices.filter(invoice => invoice.contactId === contactId).reduce((sum, row) => sum + row.balanceDue, 0),
        oldestDays: oldest, invoices: rows.map(row => ({ id: row.id, displayId: row.displayId, due: row.due, balanceDue: row.balanceDue, daysOverdue: row.daysOverdue })),
        level, nextDate: contact.followUpNextDate, note: contact.followUpNote,
        lastAction: last ? { action: last.action, level: last.level?.name || null, at: last.createdAt, by: last.createdBy, note: last.note } : null,
        needsAction: needsAction(oldest, level, contact.followUpNextDate, today),
      }
    }).sort((a, b) => Number(b.needsAction) - Number(a.needsAction) || b.oldestDays - a.oldestDays)

    const paid = await billPayments(postedBills.map(bill => bill.id))
    const bills = postedBills.map(bill => {
      const amountPaid = paid.get(bill.id) || 0
      const residual = Math.max(0, bill.total - amountPaid)
      return { id: bill.id, displayId: bill.displayId, vendorRef: bill.vendorRef, supplier: bill.supplier, po: bill.po, billDate: bill.billDate, dueDate: bill.dueDate, total: bill.total, amountPaid, residual, overdue: !!bill.dueDate && bill.dueDate < today && residual > 0 }
    }).filter(bill => bill.residual > 0)

    return {
      success: true as const,
      data: {
        cards: {
          receivable: { count: invoices.length, amount: invoices.reduce((sum, row) => sum + row.balanceDue, 0) },
          overdue: { count: overdue.length, amount: overdue.reduce((sum, row) => sum + row.balanceDue, 0), customers: byContact.size },
          dueSoon: { count: dueSoon.length, amount: dueSoon.reduce((sum, row) => sum + row.balanceDue, 0) },
          followUpsToDo: followUps.filter(row => row.needsAction).length,
          billsDraft: draftBills,
          billsToPay: { count: bills.length, amount: bills.reduce((sum, bill) => sum + bill.residual, 0) },
          billsOverdue: { count: bills.filter(bill => bill.overdue).length, amount: bills.filter(bill => bill.overdue).reduce((sum, bill) => sum + bill.residual, 0) },
          cash, bank,
          gstNet: gstOut == null || gstIn == null ? null : -(gstOut) - gstIn,
          unreconciled,
        },
        followUps,
        bills,
        levels,
      },
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load the accounts desk') }
  }
}

const followUpSchema = z.object({
  contactId: z.number().int().positive(),
  action: z.enum(['EMAIL', 'CALL', 'LETTER', 'NOTE', 'PROMISE']),
  note: z.string().trim().max(1000).optional(),
  nextDate: z.string().optional().nullable(),
})

// Executes one follow-up step and records it: email the statement, schedule
// a call, log a letter/note, or record a promised payment date (snooze).
export async function executeFollowUp(data: unknown) {
  try {
    const actor = await requireActor(...ROLES)
    const input = followUpSchema.parse(data)
    const today = startOfToday()
    const levels = await ensureLevels()
    const contact = await prisma.contact.findUnique({ where: { id: input.contactId }, select: { id: true, name: true, email: true } })
    if (!contact) throw new Error('Customer not found')
    const invoices = await prisma.invoice.findMany({ where: { contactId: contact.id, invoiceStatus: 'ACTIVE', heldAt: null, balanceDue: { gt: 0 } }, select: { displayId: true, date: true, dueDate: true, balanceDue: true } })
    const overdue = invoices.filter(invoice => invoiceDueDate(invoice) < today)
    const amountDue = overdue.reduce((sum, invoice) => sum + invoice.balanceDue, 0)
    const level = levelFor(Math.max(0, ...overdue.map(invoice => daysOverdue(invoiceDueDate(invoice), today))), levels)
    const nextDate = input.nextDate ? new Date(`${input.nextDate}T12:00:00`) : input.action === 'PROMISE' ? null : new Date(today.getTime() + 7 * 86_400_000)
    if (input.action === 'PROMISE' && !nextDate) throw new Error('Enter the date the customer promised to pay')

    let emailResult: string | null = null
    if (input.action === 'EMAIL') {
      if (!contact.email) throw new Error(`${contact.name} has no email address — log a call or letter instead`)
      const settings = await prisma.storeSettings.findFirst({ where: { id: 1 }, select: { storeName: true } })
      const rows = overdue.map(invoice => `<tr><td style="padding:4px 8px">${invoice.displayId}</td><td style="padding:4px 8px">${invoiceDueDate(invoice).toLocaleDateString('en-IN')}</td><td style="padding:4px 8px;text-align:right">₹${invoice.balanceDue.toLocaleString('en-IN')}</td></tr>`).join('')
      const message = levels.find(item => item.id === level?.id)?.message || DEFAULT_LEVELS[0].message
      const sent = await sendEmail({
        to: contact.email,
        subject: `Payment reminder — ₹${amountDue.toLocaleString('en-IN')} overdue`,
        html: `<p>Dear ${contact.name},</p><p>${message}</p><table style="border-collapse:collapse"><tr><th style="text-align:left;padding:4px 8px">Invoice</th><th style="text-align:left;padding:4px 8px">Due</th><th style="text-align:right;padding:4px 8px">Balance</th></tr>${rows}</table><p><b>Total overdue: ₹${amountDue.toLocaleString('en-IN')}</b></p>${input.note ? `<p>${input.note}</p>` : ''}<p>— ${settings?.storeName || 'Accounts'}</p>`,
      })
      if (!sent.success) throw new Error(`Email not sent: ${sent.error || 'SMTP is not configured'} — log a call instead`)
      emailResult = 'sent'
    }

    await prisma.$transaction(async tx => {
      await tx.followUpLog.create({ data: { contactId: contact.id, levelId: level?.id ?? null, action: input.action, note: input.note, amountDue, createdBy: actor.name } })
      await tx.contact.update({ where: { id: contact.id }, data: { followUpNextDate: nextDate, ...(input.note ? { followUpNote: input.note } : {}) } })
      if (input.action === 'CALL') {
        await tx.recordActivity.create({
          data: { resModel: 'Contact', resId: contact.id, resName: `${contact.name} · ₹${amountDue.toLocaleString('en-IN')} overdue`, activityType: 'CALL', summary: `Payment follow-up call (${level?.name || 'overdue'})`, note: input.note, dueDate: today, assignedToId: actor.id, createdById: actor.id, createdByName: actor.name },
        })
      }
      const label = { EMAIL: 'Reminder emailed', CALL: 'Follow-up call scheduled', LETTER: 'Final notice letter issued', NOTE: 'Follow-up note', PROMISE: 'Payment promised' }[input.action]
      await logMessage(tx, 'Contact', contact.id, `${label}: ₹${amountDue.toLocaleString('en-IN')} overdue${level ? ` (${level.name})` : ''}${nextDate ? ` · next follow-up ${nextDate.toLocaleDateString('en-IN')}` : ''}${input.note ? ` — ${input.note}` : ''}`, { author: actor, kind: 'NOTE' })
    })
    refresh()
    return { success: true as const, data: { emailResult } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not record the follow-up') }
  }
}

export async function getCustomerStatement(contactId: number) {
  try {
    await requireActor(...ROLES)
    const [contact, invoices, settings] = await Promise.all([
      prisma.contact.findUnique({ where: { id: contactId }, select: { name: true, phone: true, address: true, gstNumber: true } }),
      prisma.invoice.findMany({
        where: { contactId, invoiceStatus: 'ACTIVE', heldAt: null },
        orderBy: { date: 'asc' },
        select: { displayId: true, date: true, dueDate: true, total: true, amountPaid: true, balanceDue: true, creditNotes: { select: { displayId: true, amount: true, date: true } } },
      }),
      prisma.storeSettings.findFirst({ where: { id: 1 }, select: { storeName: true, address: true, gstNumber: true, phone: true } }),
    ])
    if (!contact) throw new Error('Customer not found')
    const today = startOfToday()
    return {
      success: true as const,
      data: {
        contact, store: settings,
        invoices: invoices.map(invoice => ({ ...invoice, due: invoiceDueDate(invoice), daysOverdue: invoiceDueDate(invoice) < today ? daysOverdue(invoiceDueDate(invoice), today) : 0 })),
        balance: invoices.reduce((sum, invoice) => sum + invoice.balanceDue, 0),
      },
    }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not build the statement') }
  }
}

const levelSchema = z.object({ levels: z.array(z.object({ id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(80), days: z.number().int().min(1).max(365), action: z.enum(['EMAIL', 'CALL', 'LETTER']), message: z.string().trim().max(1000).optional() })).min(1).max(6) })

export async function saveFollowUpLevels(data: unknown) {
  try {
    await requireActor('ADMIN')
    const input = levelSchema.parse(data)
    if (new Set(input.levels.map(level => level.days)).size !== input.levels.length) throw new Error('Each level needs a different number of days')
    await prisma.$transaction(async tx => {
      const keep = input.levels.flatMap(level => level.id ? [level.id] : [])
      await tx.followUpLevel.deleteMany({ where: { id: { notIn: keep } } })
      // Two passes avoid clashing on the unique "days" while values swap.
      for (const level of input.levels.filter(item => item.id)) await tx.followUpLevel.update({ where: { id: level.id }, data: { days: 100000 + (level.id as number) } })
      for (const level of input.levels) {
        const values = { name: level.name, days: level.days, action: level.action, message: level.message }
        if (level.id) await tx.followUpLevel.update({ where: { id: level.id }, data: values })
        else await tx.followUpLevel.create({ data: values })
      }
    })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not save follow-up levels') }
  }
}

const billPaymentSchema = z.object({
  billId: z.number().int().positive(),
  amount: z.number().int().positive(),
  method: z.enum(['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card']).default('Bank Transfer'),
  reference: z.string().trim().max(100).optional(),
  paidAt: z.string().optional(),
})

// Odoo "Register Payment" on a vendor bill. The payment is also booked on the
// bill's PO so purchase balances, payables aging and journals stay in step.
export async function registerBillPayment(data: unknown) {
  try {
    const actor = await requireActor(...ROLES)
    const input = billPaymentSchema.parse(data)
    const paidAt = input.paidAt ? new Date(`${input.paidAt}T12:00:00`) : new Date()
    if (Number.isNaN(paidAt.getTime())) throw new Error('Invalid payment date')
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "VendorBill" WHERE id = ${input.billId} FOR UPDATE`
      const bill = await tx.vendorBill.findUnique({ where: { id: input.billId }, include: { po: { select: { id: true, displayId: true, balanceDue: true } } } })
      if (!bill) throw new Error('Vendor bill not found')
      if (bill.status !== 'POSTED') throw new Error('Post the bill before paying it')
      if (!bill.po) throw new Error('This bill has no purchase order to pay against')
      const paid = (await tx.purchasePayment.aggregate({ where: { billId: bill.id }, _sum: { amount: true } }))._sum.amount || 0
      const residual = bill.total - paid
      if (residual <= 0) throw new Error('This bill is already fully paid')
      if (input.amount > residual) throw new Error(`Payment cannot exceed the bill's open amount of ₹${residual.toLocaleString('en-IN')}`)
      await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${bill.po.id} FOR UPDATE`
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: bill.po.id }, select: { amountPaid: true, total: true } })
      // Advances already paid on the PO count too, so the supplier is never paid twice.
      if (input.amount > po.total - po.amountPaid) throw new Error(`Only ₹${Math.max(0, po.total - po.amountPaid).toLocaleString('en-IN')} is still owed on ${bill.po.displayId} — apply its advance payments to this bill instead`)
      const payment = await tx.purchasePayment.create({
        data: { poId: bill.po.id, billId: bill.id, amount: input.amount, method: input.method, reference: input.reference, paidAt, createdBy: actor.name, notes: `Payment for ${bill.displayId}${bill.vendorRef ? ` (${bill.vendorRef})` : ''}` },
      })
      await tx.purchaseOrder.update({ where: { id: bill.po.id }, data: { amountPaid: po.amountPaid + input.amount, balanceDue: Math.max(0, po.total - po.amountPaid - input.amount) } })
      const left = residual - input.amount
      await logMessage(tx, 'VendorBill', bill.id, `Payment of ₹${input.amount.toLocaleString('en-IN')} by ${input.method}${input.reference ? ` (${input.reference})` : ''} — ${left > 0 ? `₹${left.toLocaleString('en-IN')} still open` : 'fully paid'}`, { author: actor })
      await logMessage(tx, 'PurchaseOrder', bill.po.id, `Paid ₹${input.amount.toLocaleString('en-IN')} against ${bill.displayId}`, { author: actor })
      return { paymentId: payment.id, residual: left }
    })
    refresh()
    return { success: true as const, data: result }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not register the payment') }
  }
}

// Odoo "outstanding payments": advances paid on the PO before the bill was
// posted can be applied to it. Whole payments are applied while they fit
// the bill's open amount.
export async function applyPoAdvancesToBill(billId: number) {
  try {
    const actor = await requireActor(...ROLES)
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "VendorBill" WHERE id = ${billId} FOR UPDATE`
      const bill = await tx.vendorBill.findUnique({ where: { id: billId }, select: { id: true, displayId: true, status: true, total: true, poId: true } })
      if (!bill || bill.status !== 'POSTED' || !bill.poId) throw new Error('Only posted bills with a purchase order can use PO advances')
      const paid = (await tx.purchasePayment.aggregate({ where: { billId: bill.id }, _sum: { amount: true } }))._sum.amount || 0
      let open = bill.total - paid
      const advances = await tx.purchasePayment.findMany({ where: { poId: bill.poId, billId: null }, orderBy: { paidAt: 'asc' } })
      const applied: number[] = []
      for (const advance of advances) {
        if (advance.amount > open) continue
        await tx.purchasePayment.update({ where: { id: advance.id }, data: { billId: bill.id } })
        open -= advance.amount
        applied.push(advance.amount)
      }
      if (applied.length === 0) throw new Error(advances.length ? 'The PO advances are larger than the bill\'s open amount' : 'No unapplied payments on this purchase order')
      const total = applied.reduce((sum, amount) => sum + amount, 0)
      await logMessage(tx, 'VendorBill', bill.id, `Applied PO advance(s) of ₹${total.toLocaleString('en-IN')} — ₹${open.toLocaleString('en-IN')} still open`, { author: actor })
      return { applied: total, residual: open }
    })
    refresh()
    return { success: true as const, data: result }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not apply the advances') }
  }
}
