'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireActor, actionError } from '@/lib/erp/actor'

const policySchema = z.object({
  costingMethod: z.enum(['AVCO', 'LAST']),
  poApprovalLimit: z.number().int().min(0).max(1_000_000_000),
})

export async function getErpPolicies() {
  try {
    await requireActor('ADMIN', 'MANAGER')
    const settings = await prisma.storeSettings.findFirst({ where: { id: 1 }, select: { costingMethod: true, poApprovalLimit: true } })
    return { success: true as const, data: { costingMethod: settings?.costingMethod || 'AVCO', poApprovalLimit: settings?.poApprovalLimit || 0 } }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not load ERP policies') }
  }
}

export async function updateErpPolicies(data: unknown) {
  try {
    await requireActor('ADMIN')
    const input = policySchema.parse(data)
    await prisma.storeSettings.upsert({ where: { id: 1 }, create: { id: 1, ...input }, update: input })
    revalidatePath('/settings')
    return { success: true as const }
  } catch (error) {
    return { success: false as const, error: actionError(error, 'Could not save ERP policies') }
  }
}
