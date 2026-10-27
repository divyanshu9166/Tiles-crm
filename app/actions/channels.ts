'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { requireAuth, requireRole } from '@/lib/auth-helpers'
import { encrypt } from '@/lib/whatsapp/encryption'

// Instagram & Facebook are handled by the unified Meta Messenger webhook
// (/api/social/webhook) and surfaced in the modern social inbox. Their
// credentials are stored in the dedicated ig_config / fb_config tables.
const SOCIAL_WEBHOOK_CHANNELS = new Set(['Instagram', 'Facebook'])

// ─── GET ALL CHANNEL CONFIGS ────────────────────────

// Access tokens, app secrets and verify tokens never leave the server: they
// come back masked, and saving a masked/blank value keeps the stored one.
const MASK = '••••••••'
const isSecretKey = (key: string) => /token|secret|password|apikey|api_key/i.test(key)

function maskConfig(config: Record<string, string>) {
  return Object.fromEntries(Object.entries(config || {}).map(([key, value]) => [key, isSecretKey(key) && value ? MASK : value]))
}

export async function getChannelConfigs() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again', data: [] } }
  const configs = await prisma.channelConfig.findMany({
    orderBy: { channel: 'asc' },
  })
  return {
    success: true,
    data: configs.map(c => ({
      id: c.id,
      channel: c.channel,
      enabled: c.enabled,
      config: maskConfig(c.config as Record<string, string>),
      webhookUrl: c.webhookUrl,
    })),
  }
}

// ─── UPSERT CHANNEL CONFIG ─────────────────────────

export async function upsertChannelConfig(data: {
  channel: string
  enabled: boolean
  config: Record<string, string>
}) {
  let session
  try { session = await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const { channel, enabled } = data
  // Keep stored secrets the form only saw masked.
  const stored = ((await prisma.channelConfig.findUnique({ where: { channel } }))?.config || {}) as Record<string, string>
  const config = Object.fromEntries(Object.entries(data.config || {}).map(([key, value]) => (
    isSecretKey(key) && (value === MASK || value === '') && stored[key] ? [key, stored[key]] : [key, value]
  )))

  // Generate webhook URL based on channel.
  // Instagram & Facebook share the unified Meta Messenger webhook used by the
  // modern social inbox; other channels keep their dedicated endpoint.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  const webhookUrl = SOCIAL_WEBHOOK_CHANNELS.has(channel)
    ? `${baseUrl}/api/social/webhook`
    : `${baseUrl}/api/webhooks/${channel.toLowerCase().replace(/\s+/g, '')}`

  // For IG/FB, mirror the credentials into the dedicated config tables that the
  // unified webhook + inbox read. Do this before saving ChannelConfig so a
  // validation error (e.g. missing token) surfaces to the user.
  if (SOCIAL_WEBHOOK_CHANNELS.has(channel) && enabled) {
    const syncError = await syncSocialConfig(channel, enabled, config, String(session.user.id))
    if (syncError) return { success: false, error: syncError }
  } else if (SOCIAL_WEBHOOK_CHANNELS.has(channel) && !enabled) {
    // Disconnect: flip status in the dedicated table too.
    await disconnectSocialConfig(channel, String(session.user.id))
  }

  const result = await prisma.channelConfig.upsert({
    where: { channel },
    create: {
      channel,
      enabled,
      config,
      webhookUrl,
    },
    update: {
      enabled,
      config,
      webhookUrl,
    },
  })

  revalidatePath('/settings')
  revalidatePath('/conversations')
  revalidatePath('/social-inbox')
  return { success: true, data: { id: result.id, webhookUrl: result.webhookUrl } }
}

// ─── SYNC SOCIAL CONFIG (Instagram / Facebook) ─────
// Writes the IG/FB credentials into ig_config / fb_config (tokens encrypted) so
// /api/social/webhook and the social inbox use them. Returns an error string on
// validation failure, or null on success.
async function syncSocialConfig(
  channel: string,
  enabled: boolean,
  config: Record<string, string>,
  userId: string,
): Promise<string | null> {
  const accessToken = config.accessToken?.trim()
  const verifyToken = config.verifyToken?.trim() || null
  const appSecret = config.appSecret?.trim()
  const encryptedSecret = appSecret ? encrypt(appSecret) : null
  const status = enabled ? 'connected' : 'disconnected'
  const connectedAt = enabled ? new Date() : null

  if (channel === 'Facebook') {
    const pageId = config.pageId?.trim()
    if (!pageId) return 'Facebook Page ID is required'
    if (!accessToken) return 'Page Access Token is required'
    const encryptedToken = encrypt(accessToken)
    await prisma.fbConfig.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        page_id: pageId,
        page_access_token: encryptedToken,
        app_secret: encryptedSecret,
        verify_token: verifyToken,
        status,
        connected_at: connectedAt,
      },
      update: {
        page_id: pageId,
        page_access_token: encryptedToken,
        // Only overwrite the stored secret when a new one was provided.
        ...(encryptedSecret ? { app_secret: encryptedSecret } : {}),
        verify_token: verifyToken,
        status,
        connected_at: connectedAt,
      },
    })
    return null
  }

  if (channel === 'Instagram') {
    const igAccountId = config.igAccountId?.trim()
    const linkedPageId = config.pageId?.trim()
    if (!igAccountId) return 'Instagram Business Account ID is required'
    if (!linkedPageId) return 'Linked Facebook Page ID is required'
    if (!accessToken) return 'Page Access Token is required'
    const encryptedToken = encrypt(accessToken)
    await prisma.igConfig.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        ig_account_id: igAccountId,
        page_id: linkedPageId,
        page_access_token: encryptedToken,
        app_secret: encryptedSecret,
        verify_token: verifyToken,
        status,
        connected_at: connectedAt,
      },
      update: {
        ig_account_id: igAccountId,
        page_id: linkedPageId,
        page_access_token: encryptedToken,
        ...(encryptedSecret ? { app_secret: encryptedSecret } : {}),
        verify_token: verifyToken,
        status,
        connected_at: connectedAt,
      },
    })
    return null
  }

  return null
}

async function disconnectSocialConfig(channel: string, userId: string) {
  if (channel === 'Facebook') {
    await prisma.fbConfig.updateMany({
      where: { user_id: userId },
      data: { status: 'disconnected', connected_at: null },
    })
  } else if (channel === 'Instagram') {
    await prisma.igConfig.updateMany({
      where: { user_id: userId },
      data: { status: 'disconnected', connected_at: null },
    })
  }
}
