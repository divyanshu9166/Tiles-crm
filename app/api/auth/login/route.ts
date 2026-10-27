import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { createSession } from '@/lib/session'
import { clientIp, passwordLimiter, tooManyAttemptsMessage } from '@/lib/password-limit'

function locked(seconds: number) {
  return NextResponse.json({ error: tooManyAttemptsMessage(seconds) }, { status: 429, headers: { 'Retry-After': String(seconds) } })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { email, password, staffId, type } = body
    const ip = clientIp(req)

    if (type === 'credentials') {
      if (!email || !password) {
        return NextResponse.json({ error: 'Missing email or password' }, { status: 400 })
      }

      const normalizedEmail = String(email).trim().toLowerCase()
      // Online guessing is capped per IP + account.
      const key = `login|${ip}|${normalizedEmail}`
      const wait = passwordLimiter.retryAfter(key)
      if (wait) return locked(wait)
      const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      })

      if (!user || !user.isActive) {
        passwordLimiter.fail(key)
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
      }

      const isValid = await bcrypt.compare(String(password), user.hashedPassword)
      if (!isValid) {
        passwordLimiter.fail(key)
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
      }
      passwordLimiter.succeed(key)

      await createSession({
        id: String(user.id),
        email: user.email,
        name: user.name,
        role: user.role,
        staffId: user.staffId,
      })

      return NextResponse.json({ success: true })
    }

    if (type === 'staff-credentials') {
      if (!staffId || !password) {
        return NextResponse.json({ error: 'Missing staff ID or password' }, { status: 400 })
      }

      const sId = parseInt(staffId)
      if (Number.isNaN(sId)) {
        return NextResponse.json({ error: 'Invalid staff ID' }, { status: 400 })
      }

      const key = `login|${ip}|staff:${sId}`
      const wait = passwordLimiter.retryAfter(key)
      if (wait) return locked(wait)

      const staff = await prisma.staff.findUnique({
        where: { id: sId },
        include: { user: true },
      })

      if (!staff || staff.status !== 'Active') {
        return NextResponse.json({ error: 'Staff not found or inactive' }, { status: 401 })
      }

      if (!staff.user) {
        return NextResponse.json(
          { error: 'Login credentials are not assigned for this staff member' },
          { status: 401 },
        )
      }

      if (!staff.user.isActive) {
        return NextResponse.json(
          { error: 'Staff login is disabled. Please contact admin.' },
          { status: 401 },
        )
      }

      const isValid = await bcrypt.compare(String(password), staff.user.hashedPassword)
      if (!isValid) {
        passwordLimiter.fail(key)
        return NextResponse.json({ error: 'Invalid staff credentials' }, { status: 401 })
      }
      passwordLimiter.succeed(key)

      await createSession({
        id: String(staff.user.id),
        email: staff.user.email,
        name: staff.user.name,
        role: staff.user.role,
        staffId: staff.id,
      })

      return NextResponse.json({ success: true })
    }

    if (type === 'staff-pin') {
      return NextResponse.json(
        { error: 'PIN login is no longer supported. Please use your assigned login password.' },
        { status: 400 },
      )
    }

    return NextResponse.json({ error: 'Invalid login type' }, { status: 400 })
  } catch (error) {
    console.error('Login error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
