'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { requireRole, requireAuth } from '@/lib/auth-helpers';
import { syncIndiaMartPullLeadsCore } from '@/lib/indiamart-sync'

const VALID_LEAD_STATUSES = new Set(['NEW', 'CONTACTED', 'SHOWROOM_VISIT', 'QUOTATION', 'WON', 'LOST'])
const PRISMA_INDIAMART_SCHEMA_ERROR = 'IndiaMART schema is not available in Prisma client. Run `npx prisma generate`, `npx prisma db push`, then restart the dev server.'
const QUERY_TYPE_LABELS = {
  W: 'Direct Enquiry',
  B: 'Buy Lead',
  P: 'PNS Call',
  BIZ: 'Catalog View',
  WA: 'WhatsApp Enquiry',
}

const MONTH_MAP = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function asString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizePhone(value) {
  const digits = asString(value).replace(/\D/g, '')
  if (!digits) return ''
  return digits.length > 10 ? digits.slice(-10) : digits
}

function isValidEmail(value) {
  const email = asString(value)
  if (!email) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function formatIndiaMartTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const get = (type) => parts.find(p => p.type === type)?.value || ''
  return `${get('day')}-${get('month')}-${get('year')}${get('hour')}:${get('minute')}:${get('second')}`
}

function parseIndiaMartTime(value) {
  const text = asString(value)
  if (!text) return null

  // 2021-12-08 12:47:25 (IST from IndiaMART)
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/)
  if (match) {
    const [, y, m, d, hh, mm, ss] = match
    // Convert IST to UTC
    const utc = Date.UTC(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh) - 5,
      Number(mm) - 30,
      Number(ss),
    )
    return new Date(utc)
  }

  // 01-Jan-202216:05:00 (IST)
  match = text.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})(\d{2}):(\d{2}):(\d{2})$/)
  if (match) {
    const [, d, mon, y, hh, mm, ss] = match
    const monthIndex = MONTH_MAP[mon.toUpperCase()]
    if (monthIndex !== undefined) {
      const utc = Date.UTC(
        Number(y),
        monthIndex,
        Number(d),
        Number(hh) - 5,
        Number(mm) - 30,
        Number(ss),
      )
      return new Date(utc)
    }
  }

  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

function extractReceiverMobile(row) {
  return asString(row.RECEIVER_MOBILE || row.RECEIVERMOBILE || '')
}

function buildLeadNotes(row) {
  const queryType = asString(row.QUERY_TYPE)
  const queryTypeLabel = QUERY_TYPE_LABELS[queryType] || queryType || 'Unknown'

  const lines = [
    `IndiaMART Query ID: ${asString(row.UNIQUE_QUERY_ID)}`,
    `IndiaMART Query Type: ${queryTypeLabel}${queryType ? ` (${queryType})` : ''}`,
  ]

  if (asString(row.SENDER_COMPANY)) lines.push(`Company: ${asString(row.SENDER_COMPANY)}`)
  if (asString(row.SENDER_CITY) || asString(row.SENDER_STATE)) {
    lines.push(`Location: ${[asString(row.SENDER_CITY), asString(row.SENDER_STATE)].filter(Boolean).join(', ')}`)
  }
  if (asString(row.QUERY_MESSAGE)) lines.push(`Message: ${asString(row.QUERY_MESSAGE)}`)

  return lines.join('\n')
}

function hasIndiaMartPrismaModels() {
  return Boolean(prisma?.indiaMartConfig && prisma?.indiaMartLead)
}

async function ensureIndiaMartConfig() {
  if (!hasIndiaMartPrismaModels()) {
    throw new Error(PRISMA_INDIAMART_SCHEMA_ERROR)
  }
  let config = await prisma.indiaMartConfig.findUnique({ where: { id: 1 } })
  if (!config) {
    config = await prisma.indiaMartConfig.create({ data: { id: 1 } })
  }
  return config
}

export async function getIndiaMartConfig() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } }
  try {
    const [config, totalSynced, totalImported] = await Promise.all([
      ensureIndiaMartConfig(),
      prisma.indiaMartLead.count(),
      prisma.indiaMartLead.count({ where: { leadId: { not: null } } }),
    ])

    return {
      success: true,
      data: {
        enabled: config.enabled,
        hasPullApiKey: Boolean(config.pullApiKey),
        autoImportToLeads: config.autoImportToLeads,
        defaultLeadStatus: config.defaultLeadStatus,
        overlapMinutes: config.overlapMinutes,
        lastSyncAt: config.lastSyncAt?.toISOString() || null,
        lastSyncStart: config.lastSyncStart?.toISOString() || null,
        lastSyncEnd: config.lastSyncEnd?.toISOString() || null,
        lastSyncCode: config.lastSyncCode ?? null,
        lastSyncMessage: config.lastSyncMessage ?? null,
        totalSynced,
        totalImported,
      },
    }
  } catch (error) {
    return { success: false, error: error?.message || 'Failed to load IndiaMART config' }
  }
}

export async function saveIndiaMartConfig(input) {
  try {
    await requireRole('ADMIN')
  } catch {
    return { success: false, error: 'Admin access required' }
  }
  if (!hasIndiaMartPrismaModels()) {
    return { success: false, error: PRISMA_INDIAMART_SCHEMA_ERROR }
  }

  const patch = {}

  if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
  if (typeof input?.autoImportToLeads === 'boolean') patch.autoImportToLeads = input.autoImportToLeads

  if (input?.overlapMinutes !== undefined) {
    const overlap = Number(input.overlapMinutes)
    if (Number.isFinite(overlap)) patch.overlapMinutes = clamp(Math.round(overlap), 1, 60)
  }

  if (typeof input?.defaultLeadStatus === 'string' && VALID_LEAD_STATUSES.has(input.defaultLeadStatus)) {
    patch.defaultLeadStatus = input.defaultLeadStatus
  }

  if (typeof input?.pullApiKey === 'string') {
    const trimmed = input.pullApiKey.trim()
    if (trimmed) patch.pullApiKey = trimmed
  }

  const config = await prisma.indiaMartConfig.upsert({
    where: { id: 1 },
    create: { id: 1, ...patch },
    update: patch,
  })

  revalidatePath('/indiamart-leads')

  return {
    success: true,
    data: {
      enabled: config.enabled,
      hasPullApiKey: Boolean(config.pullApiKey),
      autoImportToLeads: config.autoImportToLeads,
      defaultLeadStatus: config.defaultLeadStatus,
      overlapMinutes: config.overlapMinutes,
    },
  }
}

export async function getIndiaMartLeads(limit = 100) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } }
  try {
    if (!hasIndiaMartPrismaModels()) {
      return { success: false, error: PRISMA_INDIAMART_SCHEMA_ERROR }
    }

    const safeLimit = clamp(Number(limit) || 100, 1, 500)
    const rows = await prisma.indiaMartLead.findMany({
      take: safeLimit,
      orderBy: [{ queryTime: 'desc' }, { syncedAt: 'desc' }],
      include: {
        lead: {
          include: {
            contact: true,
          },
        },
      },
    })

    return {
      success: true,
      data: rows.map(row => ({
        id: row.id,
        uniqueQueryId: row.uniqueQueryId,
        queryType: row.queryType,
        queryTypeLabel: QUERY_TYPE_LABELS[asString(row.queryType)] || asString(row.queryType) || 'Unknown',
        queryTime: row.queryTime?.toISOString() || null,
        senderName: row.senderName,
        senderMobile: row.senderMobile,
        senderEmail: row.senderEmail,
        senderCompany: row.senderCompany,
        queryProductName: row.queryProductName,
        queryMessage: row.queryMessage,
        syncedAt: row.syncedAt.toISOString(),
        importedLeadId: row.leadId || null,
        importedLeadName: row.lead?.contact?.name || null,
        importedLeadPhone: row.lead?.contact?.phone || null,
      })),
    }
  } catch (error) {
    return { success: false, error: error?.message || 'Failed to load IndiaMART leads' }
  }
}

export async function syncIndiaMartPullLeads() {
  try {
    await requireRole('ADMIN')
  } catch {
    return { success: false, error: 'Admin access required' }
  }

  return syncIndiaMartPullLeadsCore()
}

export async function syncIndiaMartPullLeadsCron(secret) {
  if (!process.env.CRM_API_SECRET) {
    return { success: false, error: 'CRM_API_SECRET is not configured on server' }
  }
  if (secret !== process.env.CRM_API_SECRET) {
    return { success: false, error: 'Unauthorized' }
  }

  return syncIndiaMartPullLeadsCore()
}
