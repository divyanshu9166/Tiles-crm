'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { createCampaignSchema } from '@/lib/validations/campaign'
import type { CampaignStatus } from '@prisma/client'
import { requireAuth, requireRole } from '@/lib/auth-helpers'

export async function getCampaigns() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const campaigns = await prisma.campaign.findMany({
    orderBy: { createdAt: 'desc' },
  })

  return {
    success: true,
    data: campaigns.map(c => ({
      id: c.id,
      name: c.name,
      channel: c.channel,
      status: c.status.charAt(0) + c.status.slice(1).toLowerCase(),
      scheduledDate: c.scheduledDate?.toISOString().split('T')[0] || null,
      audience: c.audience,
      sent: c.sent,
      opened: c.opened,
      clicked: c.clicked,
      template: c.template,
    })),
  }
}

export async function createCampaign(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const parsed = createCampaignSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const campaign = await prisma.campaign.create({
    data: {
      name: parsed.data.name,
      channel: parsed.data.channel,
      audience: parsed.data.audience,
      template: parsed.data.template,
      scheduledDate: parsed.data.scheduledDate ? new Date(parsed.data.scheduledDate) : null,
    },
  })

  revalidatePath('/whatsapp-marketing')
  return { success: true, data: campaign }
}

export async function updateCampaignStatus(id: number, status: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const statusMap: Record<string, CampaignStatus> = {
    'Draft': 'DRAFT', 'Scheduled': 'SCHEDULED', 'Sent': 'SENT',
  }
  const dbStatus = statusMap[status]
  if (!dbStatus) return { success: false, error: 'Invalid status' }

  const campaign = await prisma.campaign.update({
    where: { id },
    data: { status: dbStatus },
  })

  revalidatePath('/whatsapp-marketing')
  return { success: true, data: campaign }
}
