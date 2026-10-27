'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth-helpers'

export interface BulkContactRow {
  name: string
  phone: string
  email?: string
  address?: string
  city?: string
  source?: string
  notes?: string
}

export async function bulkImportContacts(rows: BulkContactRow[]) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  if (!rows || rows.length === 0) return { success: false, error: 'No contacts to import' }

  // Validate — every row needs at least name and phone
  const valid = rows.filter(r => r.name?.trim() && r.phone?.trim())
  if (valid.length === 0) return { success: false, error: 'No valid rows (name and phone required)' }

  // Normalise phone — strip spaces/dashes
  const normalised = valid.map(r => ({
    name: r.name.trim(),
    phone: r.phone.replace(/[\s\-().+]/g, '').slice(-10), // keep last 10 digits
    email: r.email?.trim() || undefined,
    address: r.city ? `${r.address || ''}, ${r.city}`.replace(/^,\s*/, '') : r.address?.trim() || undefined,
    source: r.source?.trim() || 'Import',
    notes: r.notes?.trim() || undefined,
  }))

  // Upsert — skip rows whose phone already exists
  let created = 0
  let skipped = 0

  for (const row of normalised) {
    try {
      const existing = await prisma.contact.findFirst({ where: { phone: row.phone } })
      if (existing) {
        skipped++
        continue
      }
      await prisma.contact.create({ data: row })
      created++
    } catch {
      skipped++
    }
  }

  revalidatePath('/marketing')
  return {
    success: true,
    data: { total: valid.length, created, skipped },
  }
}
