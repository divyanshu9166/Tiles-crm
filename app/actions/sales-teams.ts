'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireActor, actionError } from '@/lib/erp/actor'
import { assignLeadsToTeam, targetProgress } from '@/lib/erp/sales-team'
import { deliveryStatus, invoiceStatus } from '@/lib/erp/sales-math'

const ROLES = ['ADMIN', 'MANAGER'] as const

function refresh() {
  revalidatePath('/sales-teams')
  revalidatePath('/leads')
}

function monthRange(month?: string) {
  const base = month ? new Date(`${month}-01T00:00:00`) : new Date()
  const start = new Date(base.getFullYear(), base.getMonth(), 1)
  const end = new Date(base.getFullYear(), base.getMonth() + 1, 1)
  return { start, end }
}

export async function getSalesTeams() {
  try {
    await requireActor()
    const [teams, staff] = await Promise.all([
      prisma.salesTeam.findMany({
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        include: { leader: { select: { id: true, name: true } }, members: { select: { id: true, name: true, role: true, leadCapacity: true, status: true }, orderBy: { name: 'asc' } } },
      }),
      prisma.staff.findMany({ where: { status: { not: 'Inactive' } }, select: { id: true, name: true, role: true, salesTeamId: true }, orderBy: { name: 'asc' } }),
    ])
    return { success: true as const, data: { teams, staff } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load sales teams') }
  }
}

const teamSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, 'Name the team').max(80),
  leaderId: z.number().int().positive().optional().nullable(),
  monthlyTarget: z.number().int().min(0).default(0),
  color: z.string().trim().max(20).optional(),
  autoAssign: z.boolean().default(false),
  active: z.boolean().default(true),
  memberIds: z.array(z.number().int().positive()).default([]),
})

export async function saveSalesTeam(data: unknown) {
  try {
    await requireActor(...ROLES)
    const input = teamSchema.parse(data)
    const memberIds = [...new Set([...input.memberIds, ...(input.leaderId ? [input.leaderId] : [])])]
    const team = await prisma.$transaction(async tx => {
      const values = { name: input.name, leaderId: input.leaderId ?? null, monthlyTarget: input.monthlyTarget, color: input.color, autoAssign: input.autoAssign, active: input.active }
      const saved = input.id ? await tx.salesTeam.update({ where: { id: input.id }, data: values }) : await tx.salesTeam.create({ data: values })
      // A salesperson belongs to one team (Odoo's default); moving them here removes them elsewhere.
      await tx.staff.updateMany({ where: { salesTeamId: saved.id, id: { notIn: memberIds } }, data: { salesTeamId: null } })
      if (memberIds.length) await tx.staff.updateMany({ where: { id: { in: memberIds } }, data: { salesTeamId: saved.id } })
      return saved
    })
    refresh()
    return { success: true as const, data: team }
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return { success: false as const, error: 'A team with this name already exists' }
    return { success: false as const, error: actionError(error, 'Could not save the team') }
  }
}

export async function setMemberCapacity(staffId: number, leadCapacity: number) {
  try {
    await requireActor(...ROLES)
    if (!Number.isInteger(leadCapacity) || leadCapacity < 0 || leadCapacity > 10000) throw new Error('Capacity must be 0 (no limit) or a positive whole number')
    await prisma.staff.update({ where: { id: staffId }, data: { leadCapacity } })
    refresh()
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not update capacity') }
  }
}

export async function assignUnassignedLeads(teamId: number) {
  try {
    await requireActor(...ROLES)
    const result = await prisma.$transaction(tx => assignLeadsToTeam(tx, teamId), { timeout: 20000 })
    refresh()
    return { success: true as const, data: result }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not assign leads') }
  }
}

type MemberStats = {
  staffId: number; name: string; role: string
  openLeads: number; wonLeads: number; lostLeads: number; conversion: number | null
  quotations: number; quotationValue: number
  orders: number; orderValue: number
  invoiced: number; collected: number
  overdueActivities: number
}

// Odoo Sales Team dashboard: one card per team — pipeline, quotations,
// orders to invoice, invoiced vs target — plus the end-to-end funnel and a
// per-salesperson leaderboard for the month.
export async function getTeamDashboard(month?: string) {
  try {
    await requireActor()
    const { start, end } = monthRange(month)
    const teams = await prisma.salesTeam.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      include: { leader: { select: { id: true, name: true } }, members: { select: { id: true, name: true, role: true } } },
    })
    const memberIds = teams.flatMap(team => team.members.map(member => member.id))
    const teamOf = new Map(teams.flatMap(team => team.members.map(member => [member.id, team.id] as const)))

    const [leads, quotations, orders, invoices, users] = await Promise.all([
      prisma.lead.findMany({
        where: { OR: [{ assignedToId: { in: memberIds } }, { teamId: { in: teams.map(team => team.id) } }] },
        select: { id: true, status: true, assignedToId: true, teamId: true, contactId: true, updatedAt: true, date: true, expectedRevenue: true },
      }),
      prisma.quotation.findMany({ where: { status: { in: ['DRAFT', 'SENT', 'APPROVED'] } }, select: { id: true, contactId: true, status: true, grandTotal: true, date: true, updatedAt: true } }),
      prisma.salesOrder.findMany({
        where: { status: { not: 'CANCELLED' }, OR: [{ teamId: { in: teams.map(team => team.id) } }, { salespersonId: { in: memberIds } }] },
        select: { id: true, teamId: true, salespersonId: true, total: true, orderDate: true, invoicePolicy: true, lines: { select: { quantity: true, qtyDelivered: true, qtyInvoiced: true } } },
      }),
      prisma.invoice.findMany({
        where: { invoiceStatus: 'ACTIVE', heldAt: null, date: { gte: start, lt: end }, OR: [{ salespersonId: { in: memberIds } }, { salesOrder: { teamId: { in: teams.map(team => team.id) } } }] },
        select: { id: true, total: true, amountPaid: true, salespersonId: true, salesOrder: { select: { teamId: true } } },
      }),
      prisma.user.findMany({ where: { staffId: { in: memberIds } }, select: { id: true, staffId: true } }),
    ])
    const overdue = await prisma.recordActivity.groupBy({
      by: ['assignedToId'],
      where: { doneAt: null, dueDate: { lt: new Date(new Date().setHours(0, 0, 0, 0)) }, assignedToId: { in: users.map(user => user.id) } },
      _count: { _all: true },
    })
    const overdueByStaff = new Map(users.map(user => [user.staffId as number, overdue.find(row => row.assignedToId === user.id)?._count._all || 0]))

    // Quotations have no salesperson: they belong to whoever owns the
    // customer's most recent lead (the person working that customer).
    const ownerOfContact = new Map<number, number>()
    for (const lead of [...leads].sort((a, b) => a.date.getTime() - b.date.getTime())) {
      if (lead.assignedToId) ownerOfContact.set(lead.contactId, lead.assignedToId)
    }

    const leadTeam = (lead: typeof leads[number]) => lead.teamId ?? (lead.assignedToId ? teamOf.get(lead.assignedToId) : undefined)
    const orderTeam = (order: typeof orders[number]) => order.teamId ?? (order.salespersonId ? teamOf.get(order.salespersonId) : undefined)
    const invoiceTeam = (invoice: typeof invoices[number]) => invoice.salesOrder?.teamId ?? (invoice.salespersonId ? teamOf.get(invoice.salespersonId) : undefined)
    const inMonth = (date: Date) => date >= start && date < end

    const memberStats = (staffId: number, name: string, role: string): MemberStats => {
      const mine = leads.filter(lead => lead.assignedToId === staffId)
      const won = mine.filter(lead => lead.status === 'WON' && inMonth(lead.updatedAt)).length
      const lost = mine.filter(lead => lead.status === 'LOST' && inMonth(lead.updatedAt)).length
      const myQuotes = quotations.filter(quote => ownerOfContact.get(quote.contactId) === staffId && quote.status !== 'APPROVED')
      const myOrders = orders.filter(order => order.salespersonId === staffId && inMonth(order.orderDate))
      const myInvoices = invoices.filter(invoice => invoice.salespersonId === staffId)
      return {
        staffId, name, role,
        openLeads: mine.filter(lead => !['WON', 'LOST'].includes(lead.status)).length,
        wonLeads: won, lostLeads: lost,
        conversion: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null,
        quotations: myQuotes.length, quotationValue: myQuotes.reduce((sum, quote) => sum + quote.grandTotal, 0),
        orders: myOrders.length, orderValue: myOrders.reduce((sum, order) => sum + order.total, 0),
        invoiced: myInvoices.reduce((sum, invoice) => sum + invoice.total, 0),
        collected: myInvoices.reduce((sum, invoice) => sum + invoice.amountPaid, 0),
        overdueActivities: overdueByStaff.get(staffId) || 0,
      }
    }

    const data = teams.map(team => {
      const teamLeads = leads.filter(lead => leadTeam(lead) === team.id)
      const teamOrders = orders.filter(order => orderTeam(order) === team.id)
      const teamInvoices = invoices.filter(invoice => invoiceTeam(invoice) === team.id)
      const memberSet = new Set(team.members.map(member => member.id))
      const teamQuotes = quotations.filter(quote => memberSet.has(ownerOfContact.get(quote.contactId) ?? -1))
      const invoiced = teamInvoices.reduce((sum, invoice) => sum + invoice.total, 0)
      const openOrders = teamOrders.filter(order => order.lines.some(line => line.qtyInvoiced < line.quantity))
      const byStatus = (status: string) => teamLeads.filter(lead => lead.status === status).length
      return {
        id: team.id, name: team.name, color: team.color, leader: team.leader, autoAssign: team.autoAssign,
        monthlyTarget: team.monthlyTarget,
        invoiced,
        collected: teamInvoices.reduce((sum, invoice) => sum + invoice.amountPaid, 0),
        progress: targetProgress(invoiced, team.monthlyTarget),
        unassignedLeads: 0,
        // The end-to-end flow, Odoo pipeline → sales → invoicing.
        funnel: [
          { key: 'NEW', label: 'New leads', count: byStatus('NEW') },
          { key: 'CONTACTED', label: 'Contacted', count: byStatus('CONTACTED') },
          { key: 'SHOWROOM_VISIT', label: 'Showroom visit', count: byStatus('SHOWROOM_VISIT') },
          { key: 'QUOTATION', label: 'Quotations open', count: teamQuotes.filter(quote => quote.status !== 'APPROVED').length, value: teamQuotes.filter(quote => quote.status !== 'APPROVED').reduce((sum, quote) => sum + quote.grandTotal, 0) },
          { key: 'ORDER', label: 'Sales orders (month)', count: teamOrders.filter(order => inMonth(order.orderDate)).length, value: teamOrders.filter(order => inMonth(order.orderDate)).reduce((sum, order) => sum + order.total, 0) },
          { key: 'TO_DELIVER', label: 'To deliver', count: teamOrders.filter(order => deliveryStatus(order.lines) !== 'DELIVERED').length },
          { key: 'TO_INVOICE', label: 'To invoice', count: openOrders.filter(order => invoiceStatus(order.lines, order.invoicePolicy) === 'TO_INVOICE').length },
          { key: 'INVOICED', label: 'Invoiced (month)', count: teamInvoices.length, value: invoiced },
          { key: 'PAID', label: 'Collected (month)', count: teamInvoices.filter(invoice => invoice.amountPaid >= invoice.total).length, value: teamInvoices.reduce((sum, invoice) => sum + invoice.amountPaid, 0) },
        ],
        won: teamLeads.filter(lead => lead.status === 'WON' && inMonth(lead.updatedAt)).length,
        lost: teamLeads.filter(lead => lead.status === 'LOST' && inMonth(lead.updatedAt)).length,
        members: team.members.map(member => memberStats(member.id, member.name, member.role)).sort((a, b) => b.invoiced - a.invoiced || b.orderValue - a.orderValue),
      }
    })
    const unassigned = await prisma.lead.count({ where: { assignedToId: null, status: { notIn: ['WON', 'LOST'] } } })
    return { success: true as const, data: { teams: data, unassignedLeads: unassigned, month: start.toISOString().slice(0, 7) } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load the team dashboard') }
  }
}
