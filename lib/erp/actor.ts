import { requireAuth, requireRole } from '@/lib/auth-helpers'
import type { UserRole } from '@prisma/client'

export type Actor = { id: number | null; name: string; role: UserRole }

function toActor(session: Awaited<ReturnType<typeof requireAuth>>): Actor {
  const id = Number(session.user.id)
  return { id: Number.isSafeInteger(id) && id > 0 ? id : null, name: session.user.name || 'User', role: session.user.role }
}

export async function currentActor() {
  return toActor(await requireAuth())
}

export async function requireActor(...roles: UserRole[]) {
  return toActor(roles.length ? await requireRole(...roles) : await requireAuth())
}

export function actionError(error: unknown, fallback: string) {
  if (error instanceof Error) {
    if (error.message === 'Unauthorized') return 'Please sign in again'
    if (error.message === 'Forbidden') return 'You do not have access to this action'
    const code = (error as { code?: string }).code
    if (code === 'P2034' || code === '40P01') return 'Stock changed at the same time. Refresh and retry.'
    if (code === 'P2025') return 'This record no longer exists. Refresh and try again.'
    const issue = (error as unknown as { issues?: { message: string }[] }).issues?.[0]
    if (issue) return issue.message
    return error.message
  }
  return fallback
}
