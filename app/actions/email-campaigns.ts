'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { requireAuth, requireRole } from '@/lib/auth-helpers'
import { z } from 'zod'
import { sendBulkEmails, replaceVariables, testSmtpConnection, sendTestEmail, getSmtpConfig } from '@/lib/email'
import type { SmtpConfig } from '@/lib/email'
import { getBrand } from '@/lib/brand'

// ─── VALIDATION SCHEMAS ─────────────────────────────

const templateSchema = z.object({
  name: z.string().min(1, 'Template name is required'),
  subject: z.string().min(1, 'Subject is required'),
  body: z.string().min(1, 'Body is required'),
  category: z.string().default('Promotional'),
  variables: z.array(z.string()).default([]),
})

const campaignSchema = z.object({
  name: z.string().min(1, 'Campaign name is required'),
  subject: z.string().min(1, 'Subject is required'),
  body: z.string().min(1, 'Email body is required'),
  templateId: z.number().optional(),
  audience: z.string().default('all'),
  audienceFilter: z.any().optional(),
  scheduledAt: z.string().optional(),
  isABTest: z.boolean().default(false),
  variantBSubject: z.string().optional(),
  variantBBody: z.string().optional(),
  abSplitPercent: z.number().min(10).max(90).default(50),
  isAutomated: z.boolean().default(false),
  triggerType: z.string().optional(),
  triggerDelay: z.number().optional(),
})

// ─── EMAIL TEMPLATES ────────────────────────────────

export async function getEmailTemplates() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const templates = await prisma.emailTemplate.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { campaigns: true } } },
  })

  return {
    success: true,
    data: templates.map(t => ({
      id: t.id,
      name: t.name,
      subject: t.subject,
      body: t.body,
      category: t.category,
      variables: t.variables,
      campaignCount: t._count.campaigns,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
  }
}

export async function createEmailTemplate(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const parsed = templateSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const template = await prisma.emailTemplate.create({ data: parsed.data })
  revalidatePath('/email-marketing')
  return { success: true, data: { id: template.id } }
}

export async function updateEmailTemplate(id: number, data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const parsed = templateSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  await prisma.emailTemplate.update({ where: { id }, data: parsed.data })
  revalidatePath('/email-marketing')
  return { success: true }
}

export async function deleteEmailTemplate(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const usedCount = await prisma.emailCampaign.count({ where: { templateId: id } })
  if (usedCount > 0) return { success: false, error: `Template is used by ${usedCount} campaign(s). Remove them first.` }

  await prisma.emailTemplate.delete({ where: { id } })
  revalidatePath('/email-marketing')
  return { success: true }
}

// ─── EMAIL CAMPAIGNS ────────────────────────────────

export async function getEmailCampaigns() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const campaigns = await prisma.emailCampaign.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      template: { select: { name: true } },
      _count: { select: { recipients: true } },
    },
  })

  return {
    success: true,
    data: campaigns.map(c => ({
      id: c.id,
      name: c.name,
      subject: c.subject,
      body: c.body,
      templateName: c.template?.name || null,
      status: c.status,
      scheduledAt: c.scheduledAt?.toISOString() || null,
      sentAt: c.sentAt?.toISOString() || null,
      audience: c.audience,
      totalRecipients: c.totalRecipients,
      sent: c.sent,
      opened: c.opened,
      clicked: c.clicked,
      bounced: c.bounced,
      unsubscribed: c.unsubscribed,
      isABTest: c.isABTest,
      variantB: c.variantB as Record<string, string> | null,
      abSplitPercent: c.abSplitPercent,
      abWinner: c.abWinner,
      isAutomated: c.isAutomated,
      triggerType: c.triggerType,
      triggerDelay: c.triggerDelay,
      recipientCount: c._count.recipients,
      createdAt: c.createdAt.toISOString(),
    })),
  }
}

export async function createEmailCampaign(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const parsed = campaignSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const campaign = await prisma.emailCampaign.create({
    data: {
      name: parsed.data.name,
      subject: parsed.data.subject,
      body: parsed.data.body,
      templateId: parsed.data.templateId,
      audience: parsed.data.audience,
      audienceFilter: parsed.data.audienceFilter || undefined,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
      status: parsed.data.scheduledAt ? 'SCHEDULED' : 'DRAFT',
      isABTest: parsed.data.isABTest,
      variantB: parsed.data.isABTest ? { subject: parsed.data.variantBSubject, body: parsed.data.variantBBody } : undefined,
      abSplitPercent: parsed.data.abSplitPercent,
      isAutomated: parsed.data.isAutomated,
      triggerType: parsed.data.triggerType,
      triggerDelay: parsed.data.triggerDelay,
    },
  })

  revalidatePath('/email-marketing')
  return { success: true, data: { id: campaign.id } }
}

export async function updateEmailCampaign(id: number, data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const parsed = campaignSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  await prisma.emailCampaign.update({
    where: { id },
    data: {
      name: parsed.data.name,
      subject: parsed.data.subject,
      body: parsed.data.body,
      templateId: parsed.data.templateId,
      audience: parsed.data.audience,
      audienceFilter: parsed.data.audienceFilter || undefined,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
      isABTest: parsed.data.isABTest,
      variantB: parsed.data.isABTest ? { subject: parsed.data.variantBSubject, body: parsed.data.variantBBody } : undefined,
      abSplitPercent: parsed.data.abSplitPercent,
      isAutomated: parsed.data.isAutomated,
      triggerType: parsed.data.triggerType,
      triggerDelay: parsed.data.triggerDelay,
    },
  })

  revalidatePath('/email-marketing')
  return { success: true }
}

export async function deleteEmailCampaign(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  await prisma.emailCampaign.delete({ where: { id } })
  revalidatePath('/email-marketing')
  return { success: true }
}

// ─── AUDIENCE / RECIPIENTS ──────────────────────────

export async function getAudienceStats() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const [total, withEmail, subscribed, leads, customers] = await Promise.all([
    prisma.contact.count(),
    prisma.contact.count({ where: { email: { not: null } } }),
    prisma.contact.count({ where: { email: { not: null }, emailSubscribed: true } }),
    prisma.contact.count({ where: { email: { not: null }, emailSubscribed: true, leads: { some: {} } } }),
    prisma.contact.count({ where: { email: { not: null }, emailSubscribed: true, orders: { some: {} } } }),
  ])

  return {
    success: true,
    data: { total, withEmail, subscribed, leads, customers },
  }
}

export async function getAudiencePreview(audience: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const where: Record<string, unknown> = { email: { not: null }, emailSubscribed: true }

  if (audience === 'leads') {
    where.leads = { some: {} }
  } else if (audience === 'customers') {
    where.orders = { some: {} }
  }

  const contacts = await prisma.contact.findMany({
    where,
    select: { id: true, name: true, email: true, source: true },
    orderBy: { name: 'asc' },
    take: 100,
  })

  const totalCount = await prisma.contact.count({ where })

  return {
    success: true,
    data: {
      contacts: contacts.map(c => ({ id: c.id, name: c.name, email: c.email!, source: c.source })),
      totalCount,
    },
  }
}

// ─── SEND CAMPAIGN (populate recipients + send emails) ────────────

export async function sendEmailCampaign(campaignId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }

  // Check SMTP is configured first
  const smtpConfig = await getSmtpConfig()
  if (!smtpConfig) return { success: false, error: 'Email not configured. Go to Settings → Email Setup to configure SMTP.' }

  const campaign = await prisma.emailCampaign.findUnique({ where: { id: campaignId } })
  if (!campaign) return { success: false, error: 'Campaign not found' }
  if (campaign.status === 'SENT' || campaign.status === 'SENDING') {
    return { success: false, error: 'Campaign already sent or sending' }
  }

  // Get store settings for template variables
  const storeSettings = await prisma.storeSettings.findFirst({ where: { id: 1 } })

  // Build audience query
  const where: Record<string, unknown> = { email: { not: null }, emailSubscribed: true }
  if (campaign.audience === 'leads') where.leads = { some: {} }
  else if (campaign.audience === 'customers') where.orders = { some: {} }

  const contacts = await prisma.contact.findMany({
    where,
    select: { id: true, name: true, email: true },
  })

  if (contacts.length === 0) return { success: false, error: 'No eligible recipients found' }

  // Mark as SENDING
  await prisma.emailCampaign.update({
    where: { id: campaignId },
    data: { status: 'SENDING' },
  })

  // Assign A/B variants and create recipient records
  const recipientData = contacts.map((c, i) => {
    let variant = 'A'
    if (campaign.isABTest) {
      const cutoff = Math.floor(contacts.length * (campaign.abSplitPercent / 100))
      variant = i < cutoff ? 'A' : 'B'
    }
    return {
      campaignId,
      contactId: c.id,
      email: c.email!,
      name: c.name,
      variant,
      status: 'queued' as const,
    }
  })

  // Clear previous recipients and create new ones
  await prisma.emailRecipient.deleteMany({ where: { campaignId } })
  await prisma.emailRecipient.createMany({ data: recipientData })

  // Fetch created recipients to get their IDs for tracking
  const recipients = await prisma.emailRecipient.findMany({
    where: { campaignId },
    select: { id: true, email: true, name: true, variant: true },
  })

  // Prepare common template variables
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const commonVars: Record<string, string> = {
    storeName: storeSettings?.storeName || getBrand().name,
    storePhone: storeSettings?.phone || '',
    storeEmail: storeSettings?.email || '',
    storeAddress: storeSettings?.address || '',
    storeUrl: appUrl,
  }

  // Get variant B content if A/B test
  const variantB = campaign.variantB as Record<string, string> | null

  // Build email payloads
  const emailPayloads = recipients.map(r => {
    const isB = r.variant === 'B' && variantB
    const subject = isB ? (variantB.subject || campaign.subject) : campaign.subject
    const body = isB ? (variantB.body || campaign.body) : campaign.body

    const personalVars = { ...commonVars, customerName: r.name }
    return {
      to: r.email,
      subject: replaceVariables(subject, personalVars),
      html: replaceVariables(body, personalVars),
      recipientId: r.id,
    }
  })

  // Send all emails via SMTP with throttling
  const result = await sendBulkEmails(emailPayloads)

  // Update recipient statuses for sent ones
  const now = new Date()
  await prisma.emailRecipient.updateMany({
    where: { campaignId, status: 'queued' },
    data: { status: 'sent', sentAt: now },
  })

  // Update campaign with final stats
  await prisma.emailCampaign.update({
    where: { id: campaignId },
    data: {
      status: 'SENT',
      sentAt: now,
      totalRecipients: contacts.length,
      sent: result.sent,
    },
  })

  revalidatePath('/email-marketing')
  return {
    success: true,
    data: {
      recipientCount: contacts.length,
      sent: result.sent,
      failed: result.failed,
      errors: result.errors,
    },
  }
}

// ─── SMTP TEST & CONFIG ACTIONS ─────────────────────

// The settings form never receives the saved SMTP password; a blank password
// in a test request means "use the saved one".
async function withSavedSmtpPass<T extends { smtpPass: string }>(config: T): Promise<T> {
  if (config.smtpPass) return config
  const saved = await prisma.storeSettings.findFirst({ where: { id: 1 }, select: { smtpPass: true } })
  return { ...config, smtpPass: saved?.smtpPass || '' }
}

export async function testSmtp(config: {
  smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; smtpFromName: string; smtpSecure: boolean
}) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const result = await testSmtpConnection(await withSavedSmtpPass(config) as SmtpConfig)
  return result
}

export async function sendSmtpTestEmail(config: {
  smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; smtpFromName: string; smtpSecure: boolean
}, toEmail: string) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const result = await sendTestEmail(await withSavedSmtpPass(config) as SmtpConfig, toEmail)
  return result
}

export async function getEmailConfigStatus() {
  try { await requireAuth() } catch { return { success: false, configured: false, smtpHost: null, smtpUser: null, fromName: null } }
  const config = await getSmtpConfig()
  return {
    success: true,
    configured: !!config,
    smtpHost: config?.smtpHost || null,
    smtpUser: config?.smtpUser || null,
    fromName: config?.smtpFromName || null,
  }
}

// ─── CAMPAIGN ANALYTICS ─────────────────────────────

export async function getCampaignAnalytics(campaignId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const campaign = await prisma.emailCampaign.findUnique({
    where: { id: campaignId },
    include: {
      recipients: {
        orderBy: { sentAt: 'desc' },
        take: 200,
        select: {
          id: true,
          email: true,
          name: true,
          variant: true,
          status: true,
          sentAt: true,
          openedAt: true,
          clickedAt: true,
          opens: true,
          clicks: true,
        },
      },
    },
  })

  if (!campaign) return { success: false, error: 'Campaign not found' }

  // Aggregate events timeline (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const events = await prisma.emailEvent.findMany({
    where: {
      recipient: { campaignId },
      createdAt: { gte: sevenDaysAgo },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { type: true, createdAt: true, recipient: { select: { variant: true } } },
  })

  // A/B test breakdown
  let abStats: {
    A: { sent: number; opened: number; clicked: number; openRate: number; clickRate: number }
    B: { sent: number; opened: number; clicked: number; openRate: number; clickRate: number }
  } | null = null
  if (campaign.isABTest) {
    const variantA = campaign.recipients.filter(r => r.variant === 'A')
    const variantB = campaign.recipients.filter(r => r.variant === 'B')
    abStats = {
      A: {
        sent: variantA.length,
        opened: variantA.filter(r => r.openedAt).length,
        clicked: variantA.filter(r => r.clickedAt).length,
        openRate: variantA.length > 0 ? Math.round((variantA.filter(r => r.openedAt).length / variantA.length) * 100) : 0,
        clickRate: variantA.length > 0 ? Math.round((variantA.filter(r => r.clickedAt).length / variantA.length) * 100) : 0,
      },
      B: {
        sent: variantB.length,
        opened: variantB.filter(r => r.openedAt).length,
        clicked: variantB.filter(r => r.clickedAt).length,
        openRate: variantB.length > 0 ? Math.round((variantB.filter(r => r.openedAt).length / variantB.length) * 100) : 0,
        clickRate: variantB.length > 0 ? Math.round((variantB.filter(r => r.clickedAt).length / variantB.length) * 100) : 0,
      },
    }
  }

  // Build daily timeline
  const timeline: Record<string, { opens: number; clicks: number }> = {}
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    const key = d.toISOString().split('T')[0]
    timeline[key] = { opens: 0, clicks: 0 }
  }
  events.forEach(e => {
    const key = e.createdAt.toISOString().split('T')[0]
    if (timeline[key]) {
      if (e.type === 'open') timeline[key].opens++
      if (e.type === 'click') timeline[key].clicks++
    }
  })

  return {
    success: true,
    data: {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        subject: campaign.subject,
        status: campaign.status,
        totalRecipients: campaign.totalRecipients,
        sent: campaign.sent,
        opened: campaign.opened,
        clicked: campaign.clicked,
        bounced: campaign.bounced,
        unsubscribed: campaign.unsubscribed,
        openRate: campaign.sent > 0 ? Math.round((campaign.opened / campaign.sent) * 100) : 0,
        clickRate: campaign.sent > 0 ? Math.round((campaign.clicked / campaign.sent) * 100) : 0,
        bounceRate: campaign.sent > 0 ? Math.round((campaign.bounced / campaign.sent) * 100) : 0,
      },
      recipients: campaign.recipients.map(r => ({
        ...r,
        sentAt: r.sentAt?.toISOString() || null,
        openedAt: r.openedAt?.toISOString() || null,
        clickedAt: r.clickedAt?.toISOString() || null,
      })),
      abStats,
      timeline: Object.entries(timeline).map(([date, v]) => ({ date, ...v })),
    },
  }
}

// ─── AUTOMATED CAMPAIGN HELPERS ─────────────────────

export async function getAutomatedCampaigns() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const campaigns = await prisma.emailCampaign.findMany({
    where: { isAutomated: true },
    orderBy: { createdAt: 'desc' },
  })

  return {
    success: true,
    data: campaigns.map(c => ({
      id: c.id,
      name: c.name,
      subject: c.subject,
      triggerType: c.triggerType,
      triggerDelay: c.triggerDelay,
      status: c.status,
      sent: c.sent,
      opened: c.opened,
      clicked: c.clicked,
    })),
  }
}

export async function duplicateCampaign(campaignId: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }

  const original = await prisma.emailCampaign.findUnique({ where: { id: campaignId } })
  if (!original) return { success: false, error: 'Campaign not found' }

  const copy = await prisma.emailCampaign.create({
    data: {
      name: `${original.name} (Copy)`,
      subject: original.subject,
      body: original.body,
      templateId: original.templateId,
      audience: original.audience,
      audienceFilter: original.audienceFilter || undefined,
      isABTest: original.isABTest,
      variantB: original.variantB || undefined,
      abSplitPercent: original.abSplitPercent,
      isAutomated: original.isAutomated,
      triggerType: original.triggerType,
      triggerDelay: original.triggerDelay,
    },
  })

  revalidatePath('/email-marketing')
  return { success: true, data: { id: copy.id } }
}
