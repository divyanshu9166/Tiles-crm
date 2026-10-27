'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { createLeadSchema, updateLeadStatusSchema, addFollowUpSchema } from '@/lib/validations/lead'
import type { LeadStatus } from '@prisma/client'
import { moveLeadToDraft } from './drafts'
import { autoAssignLead } from '@/lib/erp/sales-team'
import { requireAuth, requireRole } from '@/lib/auth-helpers'
import { contactPhoneWhere, normalizePhone } from '@/lib/phone'

const statusMap: Record<string, LeadStatus> = {
  'New': 'NEW',
  'Contacted': 'CONTACTED',
  'Showroom Visit': 'SHOWROOM_VISIT',
  'Quotation': 'QUOTATION',
  'Won': 'WON',
  'Lost': 'LOST',
}

const statusDisplayMap: Record<LeadStatus, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  SHOWROOM_VISIT: 'Showroom Visit',
  QUOTATION: 'Quotation',
  WON: 'Won',
  LOST: 'Lost',
}

export async function getLeads(status?: string) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const where = status && statusMap[status] ? { status: statusMap[status] } : {}

  const leads = await prisma.lead.findMany({
    where,
    include: { contact: true, followUps: true, assignedTo: true },
    orderBy: { date: 'desc' },
  })

  return {
    success: true,
    data: leads.map(l => ({
      id: l.id,
      name: l.contact.name,
      phone: l.contact.phone,
      email: l.contact.email,
      source: l.source,
      interest: l.interest,
      materialCategory: l.materialCategory,
      applicationArea: l.applicationArea,
      areaSqft: l.areaSqft,
      budget: l.budget,
      status: statusDisplayMap[l.status],
      date: l.date.toISOString().split('T')[0],
      notes: l.notes,
      assignedTo: l.assignedTo?.name || null,
      followUps: l.followUps.map(f => ({
        day: f.day,
        message: f.message,
        sent: f.sent,
        date: f.date.toISOString().split('T')[0],
      })),
    })),
  }
}

export async function getLead(id: number) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: { contact: true, followUps: true, assignedTo: true },
  })
  if (!lead) return { success: false, error: 'Lead not found' }
  return { success: true, data: lead }
}

export async function createLead(data: unknown) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const parsed = createLeadSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { name, phone, email, source, interest, materialCategory, applicationArea, areaSqft, budget, notes } = parsed.data

  // Find or create contact
  let contact = await prisma.contact.findFirst({ where: contactPhoneWhere(phone) })
  if (!contact) {
    contact = await prisma.contact.create({
      data: { name, phone: normalizePhone(phone), email: email || null, source },
    })
  }

  const lead = await prisma.lead.create({
    data: {
      contactId: contact.id,
      interest,
      materialCategory: materialCategory || null,
      applicationArea: applicationArea || null,
      areaSqft: areaSqft ?? null,
      budget,
      status: 'NEW',
      source,
      notes,
    },
  })
  // Sales teams with auto-assignment pick up new leads round-robin.
  await autoAssignLead(prisma, lead.id)

  revalidatePath('/leads')
  return { success: true, data: lead }
}

export async function updateLeadStatus(data: unknown) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const parsed = updateLeadStatusSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const lead = await prisma.lead.update({
    where: { id: parsed.data.id },
    data: { status: parsed.data.status },
  })

  revalidatePath('/leads')
  return { success: true, data: lead }
}

export async function updateLead(id: number, data: Partial<{
  interest: string; materialCategory: string; applicationArea: string; areaSqft: number; budget: string; notes: string; source: string;
}>) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const lead = await prisma.lead.update({
    where: { id },
    data,
  })

  revalidatePath('/leads')
  return { success: true, data: lead }
}

export async function deleteLead(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  return moveLeadToDraft(id)
}

export async function addFollowUp(data: unknown) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const parsed = addFollowUpSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const followUp = await prisma.followUp.create({
    data: {
      leadId: parsed.data.leadId,
      day: parsed.data.day,
      message: parsed.data.message,
      date: new Date(parsed.data.date),
      sent: false,
    },
  })

  revalidatePath('/leads')
  return { success: true, data: followUp }
}

export async function getLeadPipelineCounts() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const counts = await prisma.lead.groupBy({
    by: ['status'],
    _count: true,
  })

  const pipeline: Record<string, number> = {}
  for (const c of counts) {
    pipeline[statusDisplayMap[c.status]] = c._count
  }

  return { success: true, data: pipeline }
}
