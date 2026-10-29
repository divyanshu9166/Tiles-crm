'use server'

import { guarded } from '@/lib/action-guard'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { requireRole, requireAuth } from '@/lib/auth-helpers'
import { z } from 'zod'
import { inventoryError } from '@/lib/inventory-stock'

const createStockGroupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  parentId: z.number().int().positive().optional(),
})

export async function getStockGroups(...args: Parameters<typeof _getStockGroups>): Promise<Awaited<ReturnType<typeof _getStockGroups>>> {
  return guarded('getStockGroups', () => _getStockGroups(...args))
}

async function _getStockGroups() {
  await requireAuth()
  const groups = await prisma.stockGroup.findMany({
    orderBy: { name: 'asc' },
    include: {
      parent: { select: { name: true } },
      _count: { select: { products: true, children: true } },
    },
  })
  return { success: true, data: groups }
}

export async function createStockGroup(...args: Parameters<typeof _createStockGroup>): Promise<Awaited<ReturnType<typeof _createStockGroup>>> {
  return guarded('createStockGroup', () => _createStockGroup(...args))
}

async function _createStockGroup(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createStockGroupSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const existing = await prisma.stockGroup.findUnique({ where: { name: parsed.data.name } })
  if (existing) return { success: false, error: 'Stock group with this name already exists' }

  try {
    const group = await prisma.stockGroup.create({ data: parsed.data })
    revalidatePath('/inventory')
    return { success: true, data: group }
  } catch (error) { return { success: false, error: inventoryError(error) } }
}
