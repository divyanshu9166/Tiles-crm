import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'

type Db = Prisma.TransactionClient | typeof prisma

// Documents that expose a chatter. Keeping the list explicit prevents the
// generic chatter actions from being used to probe arbitrary tables.
export const CHATTER_MODELS = [
  'SalesOrder', 'StockPicking', 'PurchaseOrder', 'InventoryCount', 'Quotation',
  'Invoice', 'Lead', 'Contact', 'CustomOrder', 'ProductionOrder', 'Product', 'Supplier', 'VendorBill', 'LandedCost',
] as const
export type ChatterModel = typeof CHATTER_MODELS[number]

export const ACTIVITY_TYPES = ['TODO', 'CALL', 'MEETING', 'EMAIL', 'FOLLOW_UP', 'DOCUMENT'] as const

export type Author = { id?: number | null; name?: string | null }
export type TrackedChange = { field: string; from: unknown; to: unknown }

export function isChatterModel(value: string): value is ChatterModel {
  return (CHATTER_MODELS as readonly string[]).includes(value)
}

// Odoo's mail.thread "tracking": log only fields whose value actually changed.
export function diffTracked(before: Record<string, unknown>, after: Record<string, unknown>, fields: Record<string, string>) {
  const changes: TrackedChange[] = []
  for (const [key, label] of Object.entries(fields)) {
    const from = normalize(before[key])
    const to = normalize(after[key])
    if (from !== to) changes.push({ field: label, from, to })
  }
  return changes
}

function normalize(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (value === undefined || value === '') return null
  return value as string | number | boolean | null
}

export async function logMessage(db: Db, resModel: ChatterModel, resId: number, body: string, options: { kind?: 'NOTE' | 'TRACKING' | 'SYSTEM'; author?: Author; tracking?: TrackedChange[] } = {}) {
  return db.recordMessage.create({
    data: {
      resModel,
      resId,
      body,
      kind: options.kind || 'SYSTEM',
      tracking: options.tracking?.length ? (options.tracking as unknown as Prisma.InputJsonValue) : undefined,
      authorId: options.author?.id ?? null,
      authorName: options.author?.name ?? null,
    },
  })
}

export async function logTracking(db: Db, resModel: ChatterModel, resId: number, body: string, changes: TrackedChange[], author?: Author) {
  if (changes.length === 0) return null
  return logMessage(db, resModel, resId, body, { kind: 'TRACKING', tracking: changes, author })
}

export function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export function activityState(dueDate: Date, now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfTomorrow = new Date(startOfToday.getTime() + 86_400_000)
  if (dueDate < startOfToday) return 'overdue' as const
  if (dueDate < startOfTomorrow) return 'today' as const
  return 'planned' as const
}
