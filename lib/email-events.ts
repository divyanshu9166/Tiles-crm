import { prisma } from '@/lib/db'

// Email open/click/bounce/unsubscribe tracking, called by the public
// /api/email-track route. Kept out of app/actions so browsers cannot call it
// as a server action to fake opens or unsubscribe customers.
// ─── RECORD TRACKING EVENT ──────────────────────────

export async function recordEmailEvent(recipientId: number, type: 'open' | 'click' | 'bounce' | 'unsubscribe', metadata?: Record<string, unknown>) {
  const recipient = await prisma.emailRecipient.findUnique({
    where: { id: recipientId },
    include: { campaign: true },
  })
  if (!recipient) return { success: false }

  // Create event
  await prisma.emailEvent.create({
    data: { recipientId, type, metadata: (metadata || {}) as any },
  })

  // Update recipient stats
  const recipientUpdate: Record<string, unknown> = {}
  const campaignUpdate: Record<string, unknown> = {}

  if (type === 'open') {
    recipientUpdate.opens = { increment: 1 }
    if (!recipient.openedAt) {
      recipientUpdate.openedAt = new Date()
      recipientUpdate.status = 'opened'
      campaignUpdate.opened = { increment: 1 }
    }
  } else if (type === 'click') {
    recipientUpdate.clicks = { increment: 1 }
    if (!recipient.clickedAt) {
      recipientUpdate.clickedAt = new Date()
      recipientUpdate.status = 'clicked'
      campaignUpdate.clicked = { increment: 1 }
    }
  } else if (type === 'bounce') {
    recipientUpdate.status = 'bounced'
    recipientUpdate.bouncedAt = new Date()
    campaignUpdate.bounced = { increment: 1 }
  } else if (type === 'unsubscribe') {
    recipientUpdate.status = 'unsubscribed'
    campaignUpdate.unsubscribed = { increment: 1 }
    // Also update contact subscription
    if (recipient.contactId) {
      await prisma.contact.update({
        where: { id: recipient.contactId },
        data: { emailSubscribed: false },
      })
    }
  }

  await prisma.$transaction([
    prisma.emailRecipient.update({ where: { id: recipientId }, data: recipientUpdate }),
    prisma.emailCampaign.update({ where: { id: recipient.campaignId }, data: campaignUpdate }),
  ])

  return { success: true }
}
