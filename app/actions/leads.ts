'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { createLeadSchema, updateLeadStatusSchema, addFollowUpSchema } from '@/lib/validations/lead'
import type { LeadStatus } from '@prisma/client'
import { moveLeadToDraft } from './drafts'
import { autoAssignLead } from '@/lib/erp/sales-team'

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
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: { contact: true, followUps: true, assignedTo: true },
  })
  if (!lead) return { success: false, error: 'Lead not found' }
  return { success: true, data: lead }
}

export async function createLead(data: unknown) {
  const parsed = createLeadSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { name, phone, email, source, interest, materialCategory, applicationArea, areaSqft, budget, notes } = parsed.data

  // Find or create contact
  let contact = await prisma.contact.findFirst({ where: { phone } })
  if (!contact) {
    contact = await prisma.contact.create({
      data: { name, phone, email: email || null, source },
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
  const lead = await prisma.lead.update({
    where: { id },
    data,
  })

  revalidatePath('/leads')
  return { success: true, data: lead }
}

export async function deleteLead(id: number) {
  return moveLeadToDraft(id)
}

export async function addFollowUp(data: unknown) {
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
