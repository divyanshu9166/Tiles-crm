import { getSession as getCustomSession } from './session'
import { prisma } from './db'
import type { UserRole } from '@prisma/client'

export async function getSession() {
  const session = await getCustomSession()
  if (!session) return null

  // The cookie lives 7 days; re-read the account so a deactivated user or a
  // changed role takes effect on the next action, not at cookie expiry.
  const userId = Number(session.id)
  const user = Number.isSafeInteger(userId) && userId > 0
    ? await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, role: true, name: true, staffId: true } })
    : null
  if (!user || !user.isActive) return null

  return {
    user: {
      id: session.id,
      email: session.email,
      name: user.name || session.name,
      role: user.role as UserRole,
      staffId: user.staffId ?? session.staffId,
    }
  }
}

export async function requireAuth() {
  const session = await getSession()
  if (!session?.user) {
    throw new Error('Unauthorized')
  }
  return session
}

export async function requireRole(...roles: UserRole[]) {
  const session = await requireAuth()
  if (!roles.includes(session.user.role)) {
    throw new Error('Forbidden')
  }
  return session
}
