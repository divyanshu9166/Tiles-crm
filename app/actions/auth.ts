'use server'

import { guarded } from '@/lib/action-guard'

import { prisma } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { requireAuth, requireRole } from '@/lib/auth-helpers'
import { createSession } from '@/lib/session'
import { passwordLimiter, tooManyAttemptsMessage } from '@/lib/password-limit'

const emailSchema = z.string().email()
const loginUsernameSchema = z
  .string()
  .trim()
  .min(3, 'Login username must be at least 3 characters')
  .max(64, 'Login username must be at most 64 characters')
  .refine((value) => {
    const isEmail = emailSchema.safeParse(value).success
    const isUsername = /^[A-Za-z0-9._-]+$/.test(value)
    return isEmail || isUsername
  }, 'Login username must be a valid email or username')

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(6),
  role: z.enum(['ADMIN', 'MANAGER', 'STAFF']),
  staffId: z.number().optional(),
})

const updatePasswordSchema = z.object({
  userId: z.number(),
  oldPassword: z.string(),
  newPassword: z.string().min(6),
})

const updateAccountSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newUsername: z.string().optional(),
  newPassword: z.string().optional(),
})

export async function createUser(...args: Parameters<typeof _createUser>): Promise<Awaited<ReturnType<typeof _createUser>>> {
  return guarded('createUser', () => _createUser(...args))
}

async function _createUser(data: unknown) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const parsed = createUserSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } })
  if (existing) return { success: false, error: 'Email already in use' }

  const hashedPassword = await bcrypt.hash(parsed.data.password, 12)

  const user = await prisma.user.create({
    data: {
      email: parsed.data.email,
      name: parsed.data.name,
      hashedPassword,
      role: parsed.data.role as UserRole,
      staffId: parsed.data.staffId,
    },
  })

  return {
    success: true,
    data: { id: user.id, email: user.email, name: user.name, role: user.role },
  }
}

export async function updatePassword(...args: Parameters<typeof _updatePassword>): Promise<Awaited<ReturnType<typeof _updatePassword>>> {
  return guarded('updatePassword', () => _updatePassword(...args))
}

async function _updatePassword(data: unknown) {
  let session
  try { session = await requireAuth() } catch { return { success: false, error: 'Please sign in again' } }
  const parsed = updatePasswordSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  // Only your own password; admins reset others through user management.
  if (String(parsed.data.userId) !== String(session.user.id)) return { success: false, error: 'You can only change your own password' }

  const key = `password-change|${session.user.id}`
  const wait = passwordLimiter.retryAfter(key)
  if (wait) return { success: false, error: tooManyAttemptsMessage(wait) }

  const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } })
  if (!user) return { success: false, error: 'User not found' }

  const valid = await bcrypt.compare(parsed.data.oldPassword, user.hashedPassword)
  if (!valid) {
    passwordLimiter.fail(key)
    return { success: false, error: 'Incorrect current password' }
  }
  passwordLimiter.succeed(key)

  const hashedPassword = await bcrypt.hash(parsed.data.newPassword, 12)
  await prisma.user.update({
    where: { id: parsed.data.userId },
    data: { hashedPassword },
  })

  return { success: true }
}

export async function listUsers(...args: Parameters<typeof _listUsers>): Promise<Awaited<ReturnType<typeof _listUsers>>> {
  return guarded('listUsers', () => _listUsers(...args))
}

async function _listUsers() {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required', data: [] } }
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      staffId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  return { success: true, data: users }
}

export async function updateAccountCredentials(...args: Parameters<typeof _updateAccountCredentials>): Promise<Awaited<ReturnType<typeof _updateAccountCredentials>>> {
  return guarded('updateAccountCredentials', () => _updateAccountCredentials(...args))
}

async function _updateAccountCredentials(data: unknown) {
  let session
  try { session = await requireAuth() } catch { return { success: false, error: 'Unauthorized' } }

  const parsed = updateAccountSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const userId = Number(session.user.id)
  const sessionEmail = session.user.email?.toLowerCase()

  let user = Number.isFinite(userId)
    ? await prisma.user.findUnique({ where: { id: userId } })
    : null

  if (!user && sessionEmail) {
    user = await prisma.user.findUnique({ where: { email: sessionEmail } })
  }

  if (!user) return { success: false, error: 'User not found. Please log in again.' }

  const valid = await bcrypt.compare(parsed.data.currentPassword, user.hashedPassword)
  if (!valid) return { success: false, error: 'Incorrect current password' }

  const rawUsername = parsed.data.newUsername?.trim() || ''
  const normalizedUsername = rawUsername ? rawUsername.toLowerCase() : ''
  const trimmedPassword = parsed.data.newPassword?.trim() || ''

  if (!normalizedUsername && !trimmedPassword) {
    return { success: false, error: 'Provide a new username or new password' }
  }

  const updates: { email?: string; hashedPassword?: string } = {}

  if (normalizedUsername && normalizedUsername !== user.email) {
    const usernameParsed = loginUsernameSchema.safeParse(normalizedUsername)
    if (!usernameParsed.success) return { success: false, error: usernameParsed.error.issues[0].message }

    const existing = await prisma.user.findUnique({ where: { email: normalizedUsername } })
    if (existing && existing.id !== user.id) {
      return { success: false, error: 'Login username is already in use' }
    }
    updates.email = normalizedUsername
  }

  if (trimmedPassword) {
    if (trimmedPassword.length < 6) return { success: false, error: 'New password must be at least 6 characters' }
    updates.hashedPassword = await bcrypt.hash(trimmedPassword, 12)
  }

  if (!Object.keys(updates).length) {
    return { success: false, error: 'No changes detected' }
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: updates,
  })

  await createSession({
    id: String(updated.id),
    email: updated.email,
    name: updated.name,
    role: updated.role,
    staffId: updated.staffId,
  })

  return { success: true, data: { email: updated.email } }
}

export async function toggleUserActive(...args: Parameters<typeof _toggleUserActive>): Promise<Awaited<ReturnType<typeof _toggleUserActive>>> {
  return guarded('toggleUserActive', () => _toggleUserActive(...args))
}

async function _toggleUserActive(userId: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) return { success: false, error: 'User not found' }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { isActive: !user.isActive },
  })

  return { success: true, data: { id: updated.id, isActive: updated.isActive } }
}
