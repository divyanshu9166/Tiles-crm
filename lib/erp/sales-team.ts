import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'

type Db = Prisma.TransactionClient | typeof prisma

export type AssignableMember = { id: number; openLeads: number; capacity: number }

// Odoo lead assignment: each lead goes to the member with the fewest open
// leads who still has capacity (0 = unlimited); ties keep member order.
export function planAssignment(leadIds: number[], members: AssignableMember[]) {
  const load = members.map(member => ({ ...member }))
  const plan: { leadId: number; staffId: number }[] = []
  for (const leadId of leadIds) {
    const candidates = load.filter(member => member.capacity === 0 || member.openLeads < member.capacity)
    if (candidates.length === 0) break
    const next = candidates.reduce((best, member) => (member.openLeads < best.openLeads ? member : best))
    plan.push({ leadId, staffId: next.id })
    next.openLeads += 1
  }
  return plan
}

export function targetProgress(invoiced: number, target: number) {
  if (!(target > 0)) return null
  return Math.round((invoiced / target) * 1000) / 10
}

// Assigns unassigned open leads round-robin to the team's active members.
export async function assignLeadsToTeam(db: Db, teamId: number, leadIds?: number[]) {
  const team = await db.salesTeam.findUnique({
    where: { id: teamId },
    include: { members: { where: { status: { not: 'Inactive' } }, select: { id: true, leadCapacity: true }, orderBy: { id: 'asc' } } },
  })
  if (!team || !team.active) throw new Error('Sales team not found or archived')
  if (team.members.length === 0) throw new Error(`Add members to ${team.name} before assigning leads`)
  const open = await db.lead.groupBy({
    by: ['assignedToId'],
    where: { assignedToId: { in: team.members.map(member => member.id) }, status: { notIn: ['WON', 'LOST'] } },
    _count: { _all: true },
  })
  const openBy = new Map(open.map(row => [row.assignedToId, row._count._all]))
  const leads = await db.lead.findMany({
    where: { assignedToId: null, status: { notIn: ['WON', 'LOST'] }, ...(leadIds ? { id: { in: leadIds } } : {}) },
    orderBy: { date: 'asc' },
    select: { id: true },
    take: 500,
  })
  const plan = planAssignment(leads.map(lead => lead.id), team.members.map(member => ({ id: member.id, openLeads: openBy.get(member.id) || 0, capacity: member.leadCapacity })))
  for (const step of plan) {
    await db.lead.updateMany({ where: { id: step.leadId, assignedToId: null }, data: { assignedToId: step.staffId, teamId: team.id } })
  }
  return { assigned: plan.length, waiting: leads.length - plan.length }
}

// New leads go to the first active team that auto-assigns (Odoo's assignment cron).
export async function autoAssignLead(db: Db, leadId: number) {
  const team = await db.salesTeam.findFirst({ where: { active: true, autoAssign: true }, orderBy: { id: 'asc' }, select: { id: true } })
  if (!team) return null
  try {
    return await assignLeadsToTeam(db, team.id, [leadId])
  } catch {
    return null // a team without members simply leaves the lead unassigned
  }
}
