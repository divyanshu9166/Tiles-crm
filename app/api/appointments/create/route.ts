import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  normalizeCustomerPhone,
  timeToMinutes,
  APPOINTMENT_SLOTS,
} from '@/lib/appointments/booking'

/**
 * POST /api/appointments/create
 * Called by the AI agent (Anushka) to book callbacks, showroom visits, and appointments.
 */
export async function POST(req: NextRequest) {
  const apiSecret = req.headers.get('x-api-secret')
  if (apiSecret !== process.env.CRM_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let bookingDate: string | null = null
  try {
    const body = await req.json()
    const { customerName, phone, date: rawDate, time: rawTime, purpose, notes } = body

    if (typeof customerName !== 'string' || !customerName.trim() || !phone || !rawDate || !rawTime) {
      return NextResponse.json({ error: 'customerName, phone, date, and time are required' }, { status: 400 })
    }
    const date = normalizeAppointmentDate(rawDate)
    const time = normalizeAppointmentTime(rawTime)
    const normalizedPhone = normalizeCustomerPhone(phone)
    if (!date || !time || !normalizedPhone) {
      return NextResponse.json({ error: 'Use a valid future date, listed showroom slot, and E.164 phone number.' }, { status: 400 })
    }
    bookingDate = date
    const customer = customerName.trim().slice(0, 120)
    const appointmentPurpose = typeof purpose === 'string' && purpose.trim()
      ? purpose.trim().slice(0, 500) : 'Showroom Visit'
    const appointmentNotes = typeof notes === 'string' && notes.trim()
      ? notes.trim().slice(0, 2000) : 'Booked via AI Agent Anushka'

    const dayStart = new Date(`${date}T00:00:00.000Z`)
    const dayEnd = new Date(`${date}T23:59:59.999Z`)
    const requestedMinutes = timeToMinutes(time)
    const existingAppointments = await prisma.appointment.findMany({
      where: { date: { gte: dayStart, lte: dayEnd }, status: { not: 'Cancelled' } },
      select: { time: true },
    })
    const isTaken = existingAppointments.some((appointment) => {
      const bookedMinutes = timeToMinutes(appointment.time)
      return bookedMinutes !== null && requestedMinutes !== null && Math.abs(bookedMinutes - requestedMinutes) < 60
    })
    if (isTaken) return slotTakenResponse(existingAppointments.map((appointment) => appointment.time))

    const appointment = await prisma.$transaction(async (tx) => {
      // Upsert prevents an orphaned contact or a duplicate-phone race.
      const contact = await tx.contact.upsert({
        where: { phone: normalizedPhone },
        update: {},
        create: { name: customer, phone: normalizedPhone },
      })
      // The [date,time] database constraint is the final authority if another
      // request passes the availability check at the same moment.
      return tx.appointment.create({
        data: {
          contactId: contact.id,
          date: new Date(date),
          time,
          purpose: appointmentPurpose,
          notes: appointmentNotes,
          status: 'Scheduled',
        },
      })
    })

    return NextResponse.json({
      success: true,
      data: {
        id: appointment.id,
        date,
        time,
        purpose: appointment.purpose,
      },
    })
  } catch (error: unknown) {
    if (isUniqueConstraintError(error) && bookingDate) {
      const existing = await prisma.appointment.findMany({
        where: { date: { gte: new Date(`${bookingDate}T00:00:00.000Z`), lte: new Date(`${bookingDate}T23:59:59.999Z`) }, status: { not: 'Cancelled' } },
        select: { time: true },
      })
      return slotTakenResponse(existing.map((appointment) => appointment.time))
    }
    console.error('Failed to create appointment:', error)
    return NextResponse.json({ error: 'Failed to create appointment' }, { status: 500 })
  }
}

function slotTakenResponse(bookedTimes: string[]) {
  const bookedMinutes = bookedTimes.map(timeToMinutes).filter((minutes): minutes is number => minutes !== null)
  const suggestions = APPOINTMENT_SLOTS.filter((slot) => {
    const slotMinutes = timeToMinutes(slot)
    return slotMinutes !== null && !bookedMinutes.some((booked) => Math.abs(booked - slotMinutes) < 60)
  }).slice(0, 4)
  return NextResponse.json({ error: 'That slot was just booked.', available: false, suggestions }, { status: 409 })
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002'
}
