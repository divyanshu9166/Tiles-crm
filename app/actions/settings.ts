'use server'

import { guarded } from '@/lib/action-guard'

import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAuth, requireRole } from '@/lib/auth-helpers'
import { getBrand } from '@/lib/brand'

const updateSettingsSchema = z.object({
  // Store name, when provided, must be non-empty after trimming. The
  // field-identifying message satisfies Requirement 12.4 (reject an empty
  // store name and identify the offending field).
  storeName: z
    .string({ message: 'Store name must be text' })
    .trim()
    .min(1, { message: 'Store name is required' })
    .optional(),
  phone: z.string().optional(),
  whatsappNumber: z.string().optional(),
  // Email, when a non-empty value is provided, must be well-formed. An empty
  // string is allowed (clears the field). The field-identifying message
  // satisfies Requirement 12.4 for malformed email submissions.
  email: z
    .string({ message: 'Email must be text' })
    .email({ message: 'Please enter a valid email address' })
    .optional()
    .or(z.literal('')),
  address: z.string().optional(),
  paymentQr: z.string().optional(),
  invoicePrefix: z.string().optional(),
  invoicePadding: z.number().min(2).max(8).optional(),
  invoiceTerms: z.string().optional(),
  bankName: z.string().optional(),
  bankAccountName: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  bankIfsc: z.string().optional(),
  bankUpiId: z.string().optional(),
  gstNumber: z.string().optional(),
  gstRate: z.number().min(0).max(100).optional(),
  currency: z.string().optional(),
  logo: z.string().optional(),
  storeLat: z.number().optional(),
  storeLng: z.number().optional(),
  geofenceRadius: z.number().min(10).max(5000).optional(),
  shiftStartTime: z.string().optional(),
  shiftEndTime: z.string().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().min(1).max(65535).optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpFromName: z.string().optional(),
  smtpSecure: z.boolean().optional(),
  smtpConfigured: z.boolean().optional(),
})

const supportsStoreSettingsPaymentQr = Boolean(
  Prisma.dmmf.datamodel.models
    .find(model => model.name === 'StoreSettings')
    ?.fields.some(field => field.name === 'paymentQr')
)

const supportsStoreSettingsWhatsappNumber = Boolean(
  Prisma.dmmf.datamodel.models
    .find(model => model.name === 'StoreSettings')
    ?.fields.some(field => field.name === 'whatsappNumber')
)

async function readPaymentQrFromDb() {
  try {
    const rows = await prisma.$queryRaw<Array<{ paymentQr: string | null }>>`
      SELECT "paymentQr" as "paymentQr"
      FROM "StoreSettings"
      WHERE "id" = 1
      LIMIT 1
    `
    return rows[0]?.paymentQr ?? null
  } catch {
    return null
  }
}

async function readWhatsappNumberFromDb() {
  try {
    const rows = await prisma.$queryRaw<Array<{ whatsappNumber: string | null }>>`
      SELECT "whatsappNumber" as "whatsappNumber"
      FROM "StoreSettings"
      WHERE "id" = 1
      LIMIT 1
    `
    return rows[0]?.whatsappNumber ?? null
  } catch {
    return null
  }
}

// Public (no sign-in): only what the login screen shows.
export async function getPublicBranding(...args: Parameters<typeof _getPublicBranding>): Promise<Awaited<ReturnType<typeof _getPublicBranding>>> {
  return guarded('getPublicBranding', () => _getPublicBranding(...args))
}

async function _getPublicBranding() {
  const brand = getBrand()
  const settings = await prisma.storeSettings.findFirst({ where: { id: 1 }, select: { storeName: true, logo: true } })
  return { success: true as const, data: { storeName: settings?.storeName || brand.name, logo: settings?.logo || brand.logo } }
}

export async function getStoreSettings(...args: Parameters<typeof _getStoreSettings>): Promise<Awaited<ReturnType<typeof _getStoreSettings>>> {
  return guarded('getStoreSettings', () => _getStoreSettings(...args))
}

async function _getStoreSettings() {
  try { await requireAuth() } catch { return { success: false as const, error: 'Please sign in again' } }
  // Resolve the Active_Vertical's brand so a first-time StoreSettings record
  // is seeded with the correct per-vertical identity (name, contacts, logo)
  // instead of the generic schema default. Writes go through the active
  // vertical's database via the shared Prisma client in `@/lib/db`, so this
  // is scoped to the Active_Vertical (Requirement 12.1, 12.5, 12.6).
  const brand = getBrand()

  let settings = await prisma.storeSettings.findFirst({ where: { id: 1 } })
  if (!settings) {
    settings = await prisma.storeSettings.create({
      data: {
        id: 1,
        storeName: brand.name,
        phone: brand.support.phone,
        email: brand.support.email,
        address: brand.support.address,
        logo: brand.logo,
      },
    })
  }

  const paymentQr = supportsStoreSettingsPaymentQr
    ? ((settings as { paymentQr?: string | null }).paymentQr ?? null)
    : await readPaymentQrFromDb()

  const whatsappNumber = supportsStoreSettingsWhatsappNumber
    ? ((settings as { whatsappNumber?: string | null }).whatsappNumber ?? null)
    : await readWhatsappNumberFromDb()

  return {
    success: true,
    data: {
      storeName: settings.storeName,
      phone: settings.phone,
      whatsappNumber,
      email: settings.email,
      address: settings.address,
      paymentQr,
      invoicePrefix: settings.invoicePrefix,
      invoicePadding: settings.invoicePadding,
      invoiceTerms: settings.invoiceTerms,
      bankName: settings.bankName,
      bankAccountName: settings.bankAccountName,
      bankAccountNumber: settings.bankAccountNumber,
      bankIfsc: settings.bankIfsc,
      bankUpiId: settings.bankUpiId,
      gstNumber: settings.gstNumber,
      gstRate: settings.gstRate,
      currency: settings.currency,
      logo: settings.logo,
      storeLat: settings.storeLat,
      storeLng: settings.storeLng,
      geofenceRadius: settings.geofenceRadius,
      shiftStartTime: settings.shiftStartTime,
      shiftEndTime: settings.shiftEndTime,
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpUser: settings.smtpUser,
      // The password itself never leaves the server.
      smtpPassSet: Boolean(settings.smtpPass),
      smtpFromName: settings.smtpFromName,
      smtpSecure: settings.smtpSecure,
      smtpConfigured: settings.smtpConfigured,
    },
  }
}

export async function updateStoreSettings(...args: Parameters<typeof _updateStoreSettings>): Promise<Awaited<ReturnType<typeof _updateStoreSettings>>> {
  return guarded('updateStoreSettings', () => _updateStoreSettings(...args))
}

async function _updateStoreSettings(data: unknown) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const parsed = updateSettingsSchema.safeParse(data)
  if (!parsed.success) {
    // Surface a structured field error (field + message) rather than
    // persisting, so the UI can highlight the offending input. Requirement
    // 12.4: reject malformed email / empty store name with a message that
    // identifies the invalid field.
    const issue = parsed.error.issues[0]
    const field = typeof issue.path[0] === 'string' ? issue.path[0] : undefined
    return { success: false, error: issue.message, field }
  }

  const { paymentQr, smtpPass, ...settingsWithoutPaymentQr } = parsed.data
  const { whatsappNumber, logo, ...settingsWithoutExtras } = settingsWithoutPaymentQr
  // A blank SMTP password means "keep the saved one" (the form never receives it).
  const smtpPassData = typeof smtpPass === 'string' && smtpPass.trim() !== '' ? { smtpPass } : {}

  // Logo replacement guard (Requirement 12.4): a logo only overwrites the
  // stored value when a real, non-empty URL is supplied. A blank/whitespace
  // value (e.g. surfaced after a failed upload) is ignored so the prior logo
  // stays intact instead of being wiped.
  const hasValidLogo = typeof logo === 'string' && logo.trim() !== ''

  const settingsData = {
    ...settingsWithoutExtras,
    ...smtpPassData,
    ...(hasValidLogo ? { logo } : {}),
    ...(supportsStoreSettingsPaymentQr && paymentQr !== undefined ? { paymentQr } : {}),
    ...(supportsStoreSettingsWhatsappNumber && whatsappNumber !== undefined ? { whatsappNumber } : {}),
  }

  const settings = await prisma.storeSettings.upsert({
    where: { id: 1 },
    update: settingsData,
    create: { id: 1, ...settingsData },
  })

  if (!supportsStoreSettingsPaymentQr && paymentQr !== undefined) {
    try {
      await prisma.$executeRaw`
        UPDATE "StoreSettings"
        SET "paymentQr" = ${paymentQr}
        WHERE "id" = 1
      `
    } catch {
      return {
        success: false,
        error: 'Payment QR field is not available yet. Run `npx prisma generate`, `npx prisma db push`, and restart the dev server.',
      }
    }
  }

  if (!supportsStoreSettingsWhatsappNumber && whatsappNumber !== undefined) {
    try {
      await prisma.$executeRaw`
        UPDATE "StoreSettings"
        SET "whatsappNumber" = ${whatsappNumber}
        WHERE "id" = 1
      `
    } catch {
      return {
        success: false,
        error: 'WhatsApp number field is not available yet. Run `npx prisma generate`, `npx prisma db push`, and restart the dev server.',
      }
    }
  }

  const resolvedPaymentQr = supportsStoreSettingsPaymentQr
    ? ((settings as { paymentQr?: string | null }).paymentQr ?? null)
    : await readPaymentQrFromDb()

  const resolvedWhatsappNumber = supportsStoreSettingsWhatsappNumber
    ? ((settings as { whatsappNumber?: string | null }).whatsappNumber ?? null)
    : await readWhatsappNumberFromDb()

  revalidatePath('/settings')
  return { success: true, data: { ...settings, paymentQr: resolvedPaymentQr, whatsappNumber: resolvedWhatsappNumber } }
}

export async function getMarketplaceChannels(...args: Parameters<typeof _getMarketplaceChannels>): Promise<Awaited<ReturnType<typeof _getMarketplaceChannels>>> {
  return guarded('getMarketplaceChannels', () => _getMarketplaceChannels(...args))
}

async function _getMarketplaceChannels() {
  try { await requireAuth() } catch { return { success: false as const, error: 'Please sign in again', data: [] } }
  const channels = await prisma.marketplaceChannel.findMany({
    orderBy: { name: 'asc' },
  })

  return {
    success: true,
    data: channels.map(ch => ({
      id: ch.id,
      slug: ch.slug,
      name: ch.name,
      logo: ch.logo,
      color: ch.color,
      connected: ch.connected,
      lastSync: ch.lastSync?.toISOString() || null,
      sellerId: ch.sellerId,
    })),
  }
}

const marketplaceChannelSchema = z.object({ connected: z.boolean().optional(), sellerId: z.string().trim().max(100).optional() }).strict()

export async function updateMarketplaceChannel(...args: Parameters<typeof _updateMarketplaceChannel>): Promise<Awaited<ReturnType<typeof _updateMarketplaceChannel>>> {
  return guarded('updateMarketplaceChannel', () => _updateMarketplaceChannel(...args))
}

async function _updateMarketplaceChannel(id: number, data: { connected?: boolean; sellerId?: string }) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  // Only these two fields may change (no mass assignment of other columns).
  const parsed = marketplaceChannelSchema.safeParse(data)
  if (!parsed.success || !Number.isSafeInteger(id)) return { success: false, error: 'Invalid channel update' }
  const channel = await prisma.marketplaceChannel.update({
    where: { id },
    data: parsed.data,
  })

  revalidatePath('/settings')
  return { success: true, data: channel }
}

export async function getStoreCampaigns(...args: Parameters<typeof _getStoreCampaigns>): Promise<Awaited<ReturnType<typeof _getStoreCampaigns>>> {
  return guarded('getStoreCampaigns', () => _getStoreCampaigns(...args))
}

async function _getStoreCampaigns() {
  try { await requireAuth() } catch { return { success: false as const, error: 'Please sign in again', data: [] } }
  const campaigns = await prisma.storeCampaign.findMany({
    orderBy: { createdAt: 'desc' },
  })

  return {
    success: true,
    data: campaigns.map(c => ({
      id: c.id,
      name: c.name,
      type: c.type,
      location: c.location,
      scans: c.scans,
      leads: c.leads,
      status: c.status,
      purpose: c.purpose,
    })),
  }
}
