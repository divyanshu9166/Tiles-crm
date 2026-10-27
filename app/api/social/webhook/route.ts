/**
 * app/api/social/webhook/route.ts
 *
 * Meta Messenger Platform webhook — handles both:
 *   - Facebook Page Messages  (object: "page")
 *   - Instagram DMs           (object: "instagram")
 *
 * GET  — webhook verification (hub.challenge handshake)
 * POST — incoming message events
 *
 * Meta API version: v21.0
 * Reference: https://developers.facebook.com/docs/messenger-platform/webhooks
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { getAiAgentQueue } from '@/lib/queues/jobs'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import {
  sendTextMessage,
  setTypingOn,
  markSeen,
  getUserProfile,
  type SocialPlatform,
} from '@/lib/social/messenger-api'

// ── Constants ──────────────────────────────────────────────────────────────

// Words that trigger human handoff — AI stops responding
const HANDOFF_TRIGGERS = [
  'human', 'agent', 'support', 'help me', 'real person',
  'manav', 'insaan', 'staff', 'manager', 'manager chahiye',
]

// ── Webhook verification (GET) ─────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  if (mode !== 'subscribe' || !token || !challenge) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }

  // Check token against both FB and IG configs for the authenticated user
  // We must match the token against any configured verify token
  const [fbConfigs, igConfigs] = await Promise.all([
    prisma.fbConfig.findMany({ select: { verify_token: true } }),
    prisma.igConfig.findMany({ select: { verify_token: true } }),
  ])

  const allVerifyTokens = [
    ...fbConfigs.map((c) => c.verify_token),
    ...igConfigs.map((c) => c.verify_token),
  ].filter(Boolean)

  if (allVerifyTokens.includes(token)) {
    console.log('[social-webhook] Webhook verified successfully')
    return new Response(challenge, { status: 200 })
  }

  console.warn('[social-webhook] Webhook verify_token mismatch')
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
}

// ── Incoming events (POST) ─────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Keep the raw body: Meta signs the exact bytes (x-hub-signature-256).
  const rawBody = await req.text()
  const signature = req.headers.get('x-hub-signature-256')
  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const platform = body.object as string // "page" or "instagram"

  if (platform !== 'page' && platform !== 'instagram') {
    // Unknown object type — return 200 so Meta doesn't retry
    return NextResponse.json({ status: 'ignored' })
  }

  const normalizedPlatform: SocialPlatform =
    platform === 'instagram' ? 'instagram' : 'facebook'

  const entries = (body.entry as Record<string, unknown>[]) ?? []

  // ✅ Meta best practice: Respond 200 immediately to prevent retries,
  // then process asynchronously. Meta retries if no response within ~20s.
  Promise.all(
    entries.map((entry) => processEntry(entry, normalizedPlatform, rawBody, signature)),
  ).catch((err) => console.error('[social-webhook] Entry processing error:', err))

  return NextResponse.json({ status: 'ok' })
}

// ── Entry processor ────────────────────────────────────────────────────────

async function processEntry(
  entry: Record<string, unknown>,
  platform: SocialPlatform,
  rawBody: string,
  signature: string | null,
) {
  const pageId = entry.id as string // FB Page ID or IG Business Account ID

  // Find the user who owns this Page/IG account
  let userId: string | null = null
  let pageAccessToken: string | null = null
  let appSecret: string | null = null

  if (platform === 'facebook') {
    const fbConfig = await prisma.fbConfig.findFirst({
      where: { page_id: pageId },
    })
    if (!fbConfig) {
      console.warn(`[social-webhook] No FB config for page ${pageId}`)
      return
    }
    userId = fbConfig.user_id
    pageAccessToken = decrypt(fbConfig.page_access_token)
    appSecret = fbConfig.app_secret ? decrypt(fbConfig.app_secret) : null
  } else {
    const igConfig = await prisma.igConfig.findFirst({
      where: { ig_account_id: pageId },
    })
    if (!igConfig) {
      console.warn(`[social-webhook] No IG config for account ${pageId}`)
      return
    }
    userId = igConfig.user_id
    pageAccessToken = decrypt(igConfig.page_access_token)
    appSecret = igConfig.app_secret ? decrypt(igConfig.app_secret) : null
  }

  if (!userId || !pageAccessToken) return

  // Only Meta can send events: verify the signature with this page's app
  // secret (or META_APP_SECRET). No secret configured → rejected (fail closed).
  if (!verifyMetaWebhookSignature(rawBody, signature, appSecret || process.env.META_APP_SECRET || null)) {
    console.warn(`[social-webhook] Rejected unsigned or forged ${platform} event for ${pageId}`)
    return
  }

  // Both Facebook and Instagram deliver via entry.messaging[]
  const messagingEvents = (entry.messaging as Record<string, unknown>[]) ?? []

  await Promise.all(
    messagingEvents.map((event) =>
      processMessagingEvent(event, userId!, pageAccessToken!, platform),
    ),
  )
}

// ── Messaging event handler ────────────────────────────────────────────────

async function processMessagingEvent(
  event: Record<string, unknown>,
  userId: string,
  pageAccessToken: string,
  platform: SocialPlatform,
) {
  const sender = event.sender as { id: string } | undefined
  const recipient = event.recipient as { id: string } | undefined

  if (!sender?.id || !recipient?.id) return

  const senderId = sender.id
  const recipientId = recipient.id // Page/IG account ID

  // ── Skip echo messages (our own outbound via API) ───────────────────────
  const message = event.message as Record<string, unknown> | undefined
  if (message?.is_echo) {
    console.log(`[social-webhook] Skipping echo from ${senderId}`)
    return
  }

  // ── Skip delivery / read receipts ───────────────────────────────────────
  if (event.delivery || event.read) {
    await handleReceipt(event, platform, userId)
    return
  }

  // ── Skip postback / quick_reply (button click) for now ──────────────────
  if (!message?.text && !message?.attachments) {
    console.log(`[social-webhook] Non-message event — skipping`)
    return
  }

  const messageText = (message?.text as string) ?? ''
  const platformMsgId = message?.mid as string | undefined

  // Deduplicate — ignore if we already have this mid
  if (platformMsgId) {
    const existing = await prisma.socialMessage.findFirst({
      where: { platform_msg_id: platformMsgId },
    })
    if (existing) {
      console.log(`[social-webhook] Duplicate mid ${platformMsgId} — skipping`)
      return
    }
  }

  // ── Find or create social contact ───────────────────────────────────────
  let contact = await prisma.socialContact.findFirst({
    where: { user_id: userId, platform, platform_id: senderId },
  })

  if (!contact) {
    // Fetch profile from Graph API (non-critical)
    const profile = await getUserProfile({
      userId: senderId,
      pageAccessToken,
      platform,
    })

    contact = await prisma.socialContact.create({
      data: {
        user_id: userId,
        platform,
        platform_id: senderId,
        // Fall back to the PSID only when no real name is available yet.
        name: profile?.name || senderId,
        profile_pic: profile?.profile_pic,
      },
    })
  } else if (!contact.name || contact.name === contact.platform_id || !contact.profile_pic) {
    // Backfill: an earlier fetch may have failed and stored the PSID as the
    // name (or no avatar). Retry the profile fetch and update if we get data.
    const profile = await getUserProfile({
      userId: senderId,
      pageAccessToken,
      platform,
    })

    if (profile && (profile.name || profile.profile_pic)) {
      contact = await prisma.socialContact.update({
        where: { id: contact.id },
        data: {
          ...(profile.name ? { name: profile.name } : {}),
          ...(profile.profile_pic ? { profile_pic: profile.profile_pic } : {}),
        },
      })
    }
  }

  // ── Find or create conversation ─────────────────────────────────────────
  let conversation = await prisma.socialConversation.findFirst({
    where: { user_id: userId, contact_id: contact.id },
  })

  if (!conversation) {
    conversation = await prisma.socialConversation.create({
      data: {
        user_id: userId,
        contact_id: contact.id,
        platform,
      },
    })
  }

  // ── Save inbound message ────────────────────────────────────────────────
  let contentType = 'text'
  let mediaUrl: string | null = null
  const attachments = message?.attachments as Array<{ type: string; payload?: { url?: string } }> | undefined

  if (attachments?.length) {
    const att = attachments[0]
    contentType = att.type // image | video | audio | file
    mediaUrl = att.payload?.url ?? null
  }

  await prisma.socialMessage.create({
    data: {
      conversation_id: conversation.id,
      platform_msg_id: platformMsgId,
      sender_type: 'customer',
      content_type: contentType,
      content_text: messageText || null,
      media_url: mediaUrl,
      status: 'delivered',
    },
  })

  // Update conversation last message
  await prisma.socialConversation.update({
    where: { id: conversation.id },
    data: {
      last_message_text: messageText || `[${contentType}]`,
      last_message_at: new Date(),
      unread_count: { increment: 1 },
    },
  })

  // Mark as seen + show typing indicator (fire-and-forget)
  markSeen({ recipientId: senderId, pageAccessToken }).catch(() => null)

  // ── Human handoff check ─────────────────────────────────────────────────
  const lowerText = messageText.toLowerCase()
  const wantsHuman = HANDOFF_TRIGGERS.some((t) => lowerText.includes(t))

  if (wantsHuman && !conversation.needs_human) {
    await prisma.socialConversation.update({
      where: { id: conversation.id },
      data: { needs_human: true },
    })
    // Let the customer know a human will respond soon
    await sendTextMessage({
      recipientId: senderId,
      pageAccessToken,
      text: '🙏 Hum aapke liye ek team member se connect kar rahe hain. Thodi der mein humse baat hogi. Shukriya!',
    })
    return
  }

  // Skip AI if human flagged
  if (conversation.needs_human) {
    console.log(`[social-webhook] conversation ${conversation.id} needs human — AI skipped`)
    return
  }

  // ── Skip AI for media messages ──────────────────────────────────────────
  if (!messageText.trim()) {
    console.log(`[social-webhook] No text — skipping AI for ${conversation.id}`)
    return
  }

  // ── Show typing indicator ───────────────────────────────────────────────
  setTypingOn({ recipientId: senderId, pageAccessToken }).catch(() => null)

  // ── Enqueue AI agent job ────────────────────────────────────────────────
  getAiAgentQueue()
    .add(
      'handle_message',
      {
        userId,
        conversationId: conversation.id,
        contactId: contact.id,
        contactPhone: senderId, // PSID/IGSID stored in contactPhone for unified queue
        messageText,
        incomingMessageId: platformMsgId ?? '',
        channel: platform,                // NEW: route send step to messenger API
        socialPageAccessToken: encrypt(pageAccessToken), // encrypted token for worker
        socialRecipientId: senderId,      // PSID/IGSID for reply
      },
      {
        jobId: `social-agent:${contact.id}:${platformMsgId ?? Date.now()}`,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    )
    .catch((err) => console.error('[social-webhook] AI queue error:', err))
}

// ── Receipt handler ─────────────────────────────────────────────────────────

async function handleReceipt(
  event: Record<string, unknown>,
  platform: SocialPlatform,
  userId: string,
) {
  // Update message status from delivery/read receipts
  const delivery = event.delivery as { mids?: string[] } | undefined
  const read = event.read as { watermark?: number } | undefined

  if (delivery?.mids) {
    await prisma.socialMessage.updateMany({
      where: { platform_msg_id: { in: delivery.mids } },
      data: { status: 'delivered' },
    })
  }

  if (read?.watermark) {
    // Mark all messages before watermark as read (watermark is timestamp in ms)
    // Note: this is a best-effort update
    console.log(`[social-webhook] Read receipt at ${read.watermark} for ${platform}/${userId}`)
  }
}
