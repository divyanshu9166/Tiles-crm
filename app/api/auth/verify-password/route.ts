import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { getSession } from '@/lib/session'
import { prisma } from '@/lib/db'
import { passwordLimiter, tooManyAttemptsMessage } from '@/lib/password-limit'

export async function POST(request: Request) {
  const session = await getSession()
  if (!session?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as
    | { email?: string; password?: string }
    | null
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')
  if (!email || !password) {
    return NextResponse.json(
      { error: 'email and password are required' },
      { status: 400 },
    )
  }

  const sessionEmail = String(session.email ?? '').trim().toLowerCase()
  if (sessionEmail && sessionEmail !== email) {
    return NextResponse.json(
      { error: 'Email does not match current session' },
      { status: 403 },
    )
  }

  const userId = Number(session.id)
  const user = Number.isFinite(userId)
    ? await prisma.user.findUnique({ where: { id: userId } })
    : null
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const key = `verify-password|${user.id}`
  const wait = passwordLimiter.retryAfter(key)
  if (wait) return NextResponse.json({ error: tooManyAttemptsMessage(wait) }, { status: 429, headers: { 'Retry-After': String(wait) } })

  const ok = await bcrypt.compare(password, user.hashedPassword)
  if (!ok) {
    passwordLimiter.fail(key)
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }
  passwordLimiter.succeed(key)

  return NextResponse.json({
    user: {
      id: String(user.id),
      email: user.email,
      name: user.name,
      role: user.role,
      staffId: user.staffId,
      created_at: user.createdAt.toISOString(),
    },
  })
}

