'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { createStaffSchema, updateStaffSchema } from '@/lib/validations/staff'
import { requireAuth, requireRole } from '@/lib/auth-helpers'
import bcrypt from 'bcryptjs'
import type { Prisma, UserRole } from '@prisma/client'
import { adjustStock, inventoryError, lockInventoryProducts, resolveStockGodown } from '@/lib/inventory-stock'

// ─── IST helpers ─────────────────────────────────────────────────────────────
// All attendance dates/times must be in IST (Asia/Kolkata, UTC+5:30)
// regardless of the server's system timezone.
function getISTDate(): { today: Date; time: string } { 
  const now = new Date()
  // Current IST offset in ms (+5:30 = 19800 s)
  const istOffsetMs = 5.5 * 60 * 60 * 1000
  const istNow = new Date(now.getTime() + istOffsetMs)

  // midnight of today in IST, stored as UTC equivalent
  const today = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate())
  )

  // HH:mm in IST (24-hour)
  const hh = String(istNow.getUTCHours()).padStart(2, '0')
  const mm = String(istNow.getUTCMinutes()).padStart(2, '0')
  const time = `${hh}:${mm}`

  return { today, time }
}
// ─────────────────────────────────────────────────────────────────────────────

const staffPortalInclude: Prisma.StaffInclude = {
  attendance: { orderBy: { date: 'desc' }, take: 7 },
  activities: { orderBy: { date: 'desc' }, take: 10 },
  fieldVisits: { orderBy: { date: 'desc' }, take: 5 },
  stockUpdates: { orderBy: { date: 'desc' }, take: 5 },
  user: { select: { email: true, isActive: true } },
  _count: { select: { leads: true, invoices: true, customOrders: true } },
}

const defaultStaffStats = {
  leadsAssigned: 0,
  conversions: 0,
  revenue: 0,
  avgResponseTime: '0 min',
  todaySales: 0,
  todayRevenue: 0,
  rating: 0,
  conversionRate: 0,
}
const defaultStaffTarget = { monthly: 0, achieved: 0 }
const defaultStaffCommission = { rate: 0, earned: 0, pending: 0 }

function mergeStaffJson<T extends Record<string, unknown>>(value: unknown, defaults: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  return { ...defaults, ...(value as Partial<T>) }
}

const mapStaffForPortal = (s: any) => ({
  id: s.id,
  name: s.name,
  role: s.role,
  phone: s.phone,
  email: s.email,
  loginUsername: s.user?.email || null,
  hasLogin: !!s.user,
  loginActive: s.user?.isActive ?? false,
  status: s.status,
  joinDate: s.joinDate ? s.joinDate.toISOString().split('T')[0] : null,
  avatar: s.avatar,
  stats: mergeStaffJson(s.stats, defaultStaffStats),
  target: mergeStaffJson(s.target, defaultStaffTarget),
  commission: mergeStaffJson(s.commission, defaultStaffCommission),
  attendance: s.attendance.map((a: any) => ({
    date: a.date.toISOString().split('T')[0],
    clockIn: a.clockIn,
    clockOut: a.clockOut,
    hours: a.hours,
    status: a.status,
    isLate: a.isLate,
    method: a.method,
    clockInDist: a.clockInDist,
  })),
  activities: s.activities.map((a: any) => ({
    type: a.type,
    text: a.text,
    time: a.time,
    date: a.date.toISOString().split('T')[0],
  })),
  fieldVisits: s.fieldVisits.map((fv: any) => ({
    id: fv.displayId,
    customer: fv.customer,
    address: fv.address,
    date: fv.date.toISOString().split('T')[0],
    time: fv.time,
    status: fv.status,
    type: fv.type,
    notes: fv.notes,
    measurements: fv.measurements,
    photos: fv.photos,
  })),
  stockUpdates: s.stockUpdates.map((su: any) => ({
    product: su.product,
    warehouse: su.warehouse,
    action: su.action,
    qty: su.quantity,
    date: su.date.toISOString().split('T')[0],
    time: su.time,
  })),
})

export async function getStaff() {
  const staff = await prisma.staff.findMany({
    include: staffPortalInclude,
    orderBy: { name: 'asc' },
  })

  return {
    success: true,
    data: staff.map(mapStaffForPortal),
  }
}

export async function getStaffPortalProfile(staffId: number) {
  let session
  try { session = await requireAuth() } catch { return { success: false, error: 'Unauthorized' } }

  if (session.user.role !== 'ADMIN' && session.user.role !== 'MANAGER' && session.user.staffId !== staffId) {
    return { success: false, error: 'Forbidden' }
  }

  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    include: staffPortalInclude,
  })

  if (!staff) return { success: false, error: 'Staff not found' }

  return { success: true, data: mapStaffForPortal(staff) }
}

export async function getStaffMember(id: number) {
  const staff = await prisma.staff.findUnique({
    where: { id },
    include: {
      attendance: { orderBy: { date: 'desc' } },
      activities: { orderBy: { date: 'desc' } },
      fieldVisits: { orderBy: { date: 'desc' } },
      stockUpdates: { orderBy: { date: 'desc' } },
    },
  })
  if (!staff) return { success: false, error: 'Staff not found' }
  return { success: true, data: staff }
}

export async function createStaff(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }
  const parsed = createStaffSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const loginUsername = parsed.data.loginUsername?.trim() || undefined
  const loginPassword = parsed.data.loginPassword?.trim() || undefined

  if ((loginUsername && !loginPassword) || (!loginUsername && loginPassword)) {
    return { success: false, error: 'Provide both login username and password, or leave both empty' }
  }

  if (loginUsername) {
    const existingUser = await prisma.user.findUnique({ where: { email: loginUsername } })
    if (existingUser) return { success: false, error: 'Login username is already in use' }
  }

  const staff = await prisma.$transaction(async tx => {
    const createdStaff = await tx.staff.create({
      data: {
        name: parsed.data.name,
        role: parsed.data.role,
        phone: parsed.data.phone,
        email: parsed.data.email,
        joinDate: new Date(parsed.data.joinDate),
        avatar: parsed.data.name.split(' ').map(n => n[0]).join('').toUpperCase(),
        stats: { leadsAssigned: 0, conversions: 0, revenue: 0, avgResponseTime: '0 min', todaySales: 0, todayRevenue: 0, rating: 0, conversionRate: 0 },
        target: { monthly: 0, achieved: 0 },
        commission: { rate: 0, earned: 0, pending: 0 },
      },
    })

    if (loginUsername && loginPassword) {
      const hashedPassword = await bcrypt.hash(loginPassword, 12)
      await tx.user.create({
        data: {
          email: loginUsername,
          name: parsed.data.name,
          hashedPassword,
          role: 'STAFF' as UserRole,
          staffId: createdStaff.id,
        },
      })
    }

    return createdStaff
  })

  revalidatePath('/staff')
  revalidatePath('/settings')
  return { success: true, data: staff }
}

export async function assignStaffLogin(staffId: number, loginUsername: string, loginPassword: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }

  const username = loginUsername.trim()
  const password = loginPassword.trim()

  if (!username) return { success: false, error: 'Login username is required' }
  if (!password || password.length < 4) return { success: false, error: 'Password/PIN must be at least 4 characters' }

  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    include: { user: { select: { id: true } } },
  })
  if (!staff) return { success: false, error: 'Staff not found' }
  if (staff.user) return { success: false, error: 'This team member already has login credentials' }

  const existingUser = await prisma.user.findUnique({ where: { email: username } })
  if (existingUser) return { success: false, error: 'Login username is already in use' }

  const hashedPassword = await bcrypt.hash(password, 12)

  await prisma.user.create({
    data: {
      email: username,
      name: staff.name,
      hashedPassword,
      role: 'STAFF' as UserRole,
      staffId: staff.id,
    },
  })

  revalidatePath('/staff')
  revalidatePath('/settings')

  return { success: true }
}

export async function verifyStaffPortalPassword(staffId: number, password: string) {
  try { await requireAuth() } catch { return { success: false, error: 'Unauthorized' } }

  const pass = password.trim()
  if (!pass) return { success: false, error: 'Password is required' }

  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    include: { user: { select: { hashedPassword: true, isActive: true } } },
  })

  if (!staff || staff.status !== 'Active') return { success: false, error: 'Staff not active' }
  if (!staff.user || !staff.user.isActive) return { success: false, error: 'Login is not assigned for this staff member' }

  const valid = await bcrypt.compare(pass, staff.user.hashedPassword)
  if (!valid) return { success: false, error: 'Invalid password' }

  return { success: true }
}

export async function updateStaffMember(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }

  const parsed = updateStaffSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const existing = await prisma.staff.findUnique({
    where: { id: parsed.data.id },
    include: { user: { select: { id: true, email: true } } },
  })
  if (!existing) return { success: false, error: 'Staff not found' }

  const loginUsername = parsed.data.loginUsername?.trim() || undefined
  const loginPassword = parsed.data.loginPassword?.trim() || undefined

  if (!existing.user && loginPassword && !loginUsername) {
    return { success: false, error: 'Provide login username to create credentials' }
  }

  if (existing.user && !loginUsername && loginPassword) {
    return { success: false, error: 'Provide login username when updating password' }
  }

  if (!existing.user && ((loginUsername && !loginPassword) || (!loginUsername && loginPassword))) {
    return { success: false, error: 'Provide both login username and password to create login' }
  }

  if (loginUsername) {
    const used = await prisma.user.findUnique({ where: { email: loginUsername } })
    if (used && used.id !== existing.user?.id) {
      return { success: false, error: 'Login username is already in use' }
    }
  }

  await prisma.$transaction(async tx => {
    await tx.staff.update({
      where: { id: parsed.data.id },
      data: {
        name: parsed.data.name,
        role: parsed.data.role,
        phone: parsed.data.phone,
        email: parsed.data.email,
        status: parsed.data.status,
        joinDate: new Date(parsed.data.joinDate),
      },
    })

    if (existing.user) {
      const userData: { name: string; email?: string; hashedPassword?: string } = {
        name: parsed.data.name,
      }

      if (loginUsername) userData.email = loginUsername
      if (loginPassword) userData.hashedPassword = await bcrypt.hash(loginPassword, 12)

      await tx.user.update({ where: { id: existing.user.id }, data: userData })
    } else if (loginUsername && loginPassword) {
      await tx.user.create({
        data: {
          email: loginUsername,
          name: parsed.data.name,
          hashedPassword: await bcrypt.hash(loginPassword, 12),
          role: 'STAFF' as UserRole,
          staffId: parsed.data.id,
        },
      })
    }
  })

  revalidatePath('/staff')
  revalidatePath('/settings')
  revalidatePath('/staff-portal')

  return { success: true }
}

export async function updateStaffTarget(staffId: number, data: {
  monthlyTarget: number
  achieved: number
  commissionRate: number
  commissionEarned: number
  commissionPending: number
}) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } }

  const staff = await prisma.staff.findUnique({ where: { id: staffId } })
  if (!staff) return { success: false, error: 'Staff not found' }

  await prisma.staff.update({
    where: { id: staffId },
    data: {
      target: { monthly: data.monthlyTarget, achieved: data.achieved },
      commission: { rate: data.commissionRate, earned: data.commissionEarned, pending: data.commissionPending },
    },
  })

  revalidatePath('/staff')
  return { success: true }
}

// Haversine distance in meters
function getDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export async function clockIn(staffId: number, gps?: { lat: number; lng: number }) {
  const { today, time } = getISTDate()

  // 1. Check if already clocked in
  const existing = await prisma.attendance.findUnique({
    where: { staffId_date: { staffId, date: today } }
  })

  if (existing?.clockIn) {
    return { success: false, error: 'Already clocked in for today' }
  }

  // Fetch settings once for both geofence and shift-time checks
  const settings = await prisma.storeSettings.findFirst({ where: { id: 1 } })

  // 2. Check geofence if GPS provided
  let distance: number | null = null
  let method = 'manual'
  if (gps) {
    method = 'gps'
    if (settings?.storeLat && settings?.storeLng) {
      distance = Math.round(getDistance(gps.lat, gps.lng, settings.storeLat, settings.storeLng))
      if (distance > (settings.geofenceRadius ?? 100)) {
        return { success: false, error: `You are ${distance}m away from the store. Must be within ${settings.geofenceRadius ?? 100}m to clock in.` }
      }
    }
  }

  // 3. Check if late (compare IST clock time vs configured shift start)
  // Standard ERP feature: Add a 15-minute grace period
  const shiftStart = settings?.shiftStartTime || '09:30'
  const [shiftH, shiftM] = shiftStart.split(':').map(Number)
  const [nowH, nowM] = time.split(':').map(Number)
  
  const graceMinutes = 15
  const isLate = (nowH * 60 + nowM) > (shiftH * 60 + shiftM + graceMinutes)

  const attendance = await prisma.attendance.upsert({
    where: { staffId_date: { staffId, date: today } },
    create: {
      staffId, date: today, clockIn: time, status: isLate ? 'Late' : 'Present',
      clockInLat: gps?.lat, clockInLng: gps?.lng, clockInDist: distance, method, isLate,
    },
    update: {
      clockIn: time, status: isLate ? 'Late' : 'Present',
      clockInLat: gps?.lat, clockInLng: gps?.lng, clockInDist: distance, method, isLate,
    },
  })

  revalidatePath('/staff')
  revalidatePath('/staff-portal')
  return { success: true, data: { ...attendance, isLate, distance } }
}

export async function clockOut(staffId: number, gps?: { lat: number; lng: number }) {
  const { today, time } = getISTDate()

  const existing = await prisma.attendance.findUnique({
    where: { staffId_date: { staffId, date: today } },
  })

  if (!existing || !existing.clockIn) {
    return { success: false, error: 'Must clock in first' }
  }
  
  if (existing.clockOut) {
    return { success: false, error: 'Already clocked out for today' }
  }

  // Check geofence if GPS provided (informational only on clock-out)
  let distance: number | null = null
  const settings = await prisma.storeSettings.findFirst({ where: { id: 1 } })
  if (gps) {
    if (settings?.storeLat && settings?.storeLng) {
      distance = Math.round(getDistance(gps.lat, gps.lng, settings.storeLat, settings.storeLng))
    }
  }

  // Calculate hours worked (guard against midnight crossover giving negative)
  const [inH, inM] = existing.clockIn.split(':').map(Number)
  const [outH, outM] = time.split(':').map(Number)
  let totalMins = (outH * 60 + outM) - (inH * 60 + inM)
  if (totalMins < 0) totalMins += 24 * 60 // midnight crossover
  const hours = Math.round(totalMins / 60 * 100) / 100
  
  // Standard ERP feature: Check for Half Day based on shift duration
  const shiftStart = settings?.shiftStartTime || '09:30'
  const shiftEnd = settings?.shiftEndTime || '20:00'
  const [startH, startM] = shiftStart.split(':').map(Number)
  const [endH, endM] = shiftEnd.split(':').map(Number)
  
  let shiftTotalMins = (endH * 60 + endM) - (startH * 60 + startM)
  if (shiftTotalMins <= 0) shiftTotalMins = 9 * 60 // fallback to 9 hours if configured incorrectly
  const halfDayThresholdHours = (shiftTotalMins / 2) / 60
  
  let newStatus = existing.status
  // If they worked less than half the shift, automatically mark as Half Day
  if (hours > 0 && hours < halfDayThresholdHours) {
    newStatus = 'Half Day'
  }

  const attendance = await prisma.attendance.update({
    where: { staffId_date: { staffId, date: today } },
    data: { clockOut: time, hours, status: newStatus, clockOutLat: gps?.lat, clockOutLng: gps?.lng, clockOutDist: distance },
  })

  revalidatePath('/staff')
  revalidatePath('/staff-portal')
  return { success: true, data: attendance }
}

export async function getMonthAttendance(staffId: number, year: number, month: number) {
  // month is 1-based (1 = January)
  const startDate = new Date(year, month - 1, 1)
  const endDate = new Date(year, month, 0, 23, 59, 59) // last day of month

  const records = await prisma.attendance.findMany({
    where: { staffId, date: { gte: startDate, lte: endDate } },
    orderBy: { date: 'asc' },
  })

  return {
    success: true,
    data: records.map(a => ({
      date: a.date.toISOString().split('T')[0],
      clockIn: a.clockIn,
      clockOut: a.clockOut,
      hours: a.hours,
      status: a.status,
      isLate: a.isLate,
      method: a.method,
      clockInDist: a.clockInDist,
    })),
  }
}

export async function getAttendance(staffId: number, days: number = 30) {
  const since = new Date()
  since.setDate(since.getDate() - days)

  const attendance = await prisma.attendance.findMany({
    where: { staffId, date: { gte: since } },
    orderBy: { date: 'desc' },
  })

  return { success: true, data: attendance }
}

export async function getDailyAttendanceReport() {
  const { today } = getISTDate()

  const allStaff = await prisma.staff.findMany({
    where: { status: 'Active' },
    select: { id: true, name: true, role: true, avatar: true, phone: true },
  })

  const todayRecords = await prisma.attendance.findMany({
    where: { date: today },
    include: { staff: { select: { name: true, role: true, avatar: true } } },
  })

  const recordMap = new Map(todayRecords.map(r => [r.staffId, r]))

  const report = allStaff.map(s => {
    const record = recordMap.get(s.id)
    return {
      staffId: s.id,
      name: s.name,
      role: s.role,
      avatar: s.avatar,
      status: record?.status || 'Absent',
      clockIn: record?.clockIn || null,
      clockOut: record?.clockOut || null,
      hours: record?.hours || null,
      isLate: record?.isLate || false,
      method: record?.method || null,
      distance: record?.clockInDist || null,
    }
  })

  const present = report.filter(r => r.status === 'Present' || r.status === 'Late').length
  const late = report.filter(r => r.isLate).length
  const absent = report.filter(r => r.status === 'Absent').length

  return { success: true, data: { report, summary: { total: allStaff.length, present, late, absent } } }
}

export async function staffStockUpdate(data: {
  staffId: number
  productId: number
  action: string
  quantity: number
}) {
  const { staffId, productId, action, quantity } = data
  let session
  try { session = await requireAuth() } catch { return { success: false, error: 'Unauthorized' } }
  // Staff can only post movements as themselves.
  if (session.user.role === 'STAFF' && session.user.staffId !== staffId) return { success: false, error: 'You can only record stock updates for yourself' }
  if (!Number.isInteger(quantity) || quantity <= 0) return { success: false, error: 'Enter a whole quantity greater than zero' }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { warehouse: true },
  })
  if (!product) return { success: false, error: 'Product not found' }
  if (product.isSlabTracked) return { success: false, error: 'Slab-tracked stone is moved from Inventory → Lot / Slab Explorer' }

  // Determine stock delta
  let delta = 0
  if (action === 'Received') delta = quantity
  else if (action === 'Stock Out' || action === 'Dispatched') delta = -quantity

  const now = new Date()
  const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
  let newStock = product.stock

  // Movements go through the location ledger so godown balances, the stock
  // total and the movement history stay in step (Low Stock Alert is informational).
  try {
    await prisma.$transaction(async tx => {
      if (delta !== 0) {
        await lockInventoryProducts(tx, [productId])
        const godown = await resolveStockGodown(tx)
        const result = await adjustStock(tx, productId, godown.id, delta, delta > 0 ? 'IN' : 'OUT', {
          referenceType: 'StaffPortal', referenceId: staffId, notes: `Staff portal: ${action}`, createdBy: session.user.name,
        })
        newStock = result.totalStock
      }
      await tx.stockUpdate.create({
        data: {
          staffId,
          product: product.name,
          warehouse: product.warehouse?.name || 'Unassigned',
          action,
          quantity,
          date: now,
          time,
        },
      })
    })
  } catch (error) {
    return { success: false, error: inventoryError(error) }
  }

  revalidatePath('/inventory')
  revalidatePath('/staff-portal')
  revalidatePath('/staff')

  return {
    success: true,
    data: {
      productName: product.name,
      previousStock: product.stock,
      newStock,
      action,
      quantity,
    },
  }
}
