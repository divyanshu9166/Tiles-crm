import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  APPOINTMENT_SLOTS,
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  timeToMinutes,
} from '@/lib/appointments/booking'

/**
 * GET /api/appointments/check-slot?date=YYYY-MM-DD&time=HH:MM+AM
 *
 * Checks whether a specific date+time slot is available for a new appointment.
 * A slot is considered taken if any appointment exists on the same date
 * within ±60 minutes of the requested time.
 *
 * Returns:
 *   { available: true }
 *   { available: false, suggestions: ["10:00 AM", "2:00 PM", ...] }
 *
 * Called by:
 *   - AI calling agent (Anushka) before confirming appointment on call
 *   - WhatsApp appointment chatbot after customer picks a time
 */

export async function GET(req: NextRequest) {
  const apiSecret = req.headers.get('x-api-secret')
  if (apiSecret !== process.env.CRM_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const dateStr = searchParams.get('date')   // e.g. "2026-06-10"
  const timeStr = searchParams.get('time')   // e.g. "11:00 AM"

  if (!dateStr || !timeStr) {
    return NextResponse.json(
      { error: 'date and time query parameters are required' },
      { status: 400 },
    )
  }

  // Parse date — accept YYYY-MM-DD
  const date = normalizeAppointmentDate(dateStr)
  if (!date) return NextResponse.json({ error: 'Use a real current or future date in YYYY-MM-DD format.' }, { status: 400 })
  const time = normalizeAppointmentTime(timeStr)
  if (!time) {
    return NextResponse.json(
      { error: 'Choose a listed showroom slot, e.g. 11:00 AM or 2:00 PM.' },
      { status: 400 },
    )
  }
  const requestedMinutes = timeToMinutes(time)
  if (requestedMinutes === null) return NextResponse.json({ error: 'Invalid appointment time.' }, { status: 400 })

  try {
    // Fetch all appointments on the requested date
    const dayStart = new Date(`${date}T00:00:00.000Z`)
    const dayEnd = new Date(`${date}T23:59:59.999Z`)

    const existingAppointments = await prisma.appointment.findMany({
      where: {
        date: { gte: dayStart, lte: dayEnd },
        status: { not: 'Cancelled' },
      },
      select: { time: true },
    })

    // Check if requested slot conflicts (±60 minutes)
    const CONFLICT_WINDOW_MINUTES = 60
    const conflictingSlot = existingAppointments.find((appt) => {
      const apptMinutes = timeToMinutes(appt.time)
      return apptMinutes !== null && Math.abs(apptMinutes - requestedMinutes) < CONFLICT_WINDOW_MINUTES
    })

    if (!conflictingSlot) {
      return NextResponse.json({ available: true })
    }

    // Slot is taken — find available slots from the fixed list
    const bookedMinutes = new Set(
      existingAppointments.map((a) => timeToMinutes(a.time)).filter((m): m is number => m !== null),
    )

    const suggestions = APPOINTMENT_SLOTS.filter((slot) => {
      const slotMin = timeToMinutes(slot)
      if (slotMin === null) return false
      return !Array.from(bookedMinutes).some(
        (booked) => Math.abs(booked - slotMin) < CONFLICT_WINDOW_MINUTES,
      )
    })

    return NextResponse.json({
      available: false,
      suggestions: suggestions.slice(0, 4), // return up to 4 alternatives
    })
  } catch (error) {
    console.error('[check-slot] error:', error)
    return NextResponse.json({ error: 'Failed to check slot availability' }, { status: 500 })
  }
}
