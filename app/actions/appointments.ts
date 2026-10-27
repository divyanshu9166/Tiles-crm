'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { createAppointmentSchema } from '@/lib/validations/appointment'
import { requireAuth } from '@/lib/auth-helpers'
import { contactPhoneWhere, normalizePhone } from '@/lib/phone'

export async function getAppointments() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const appointments = await prisma.appointment.findMany({
    include: { contact: true },
    orderBy: { date: 'desc' },
  })

  return {
    success: true,
    data: appointments.map((a: any) => ({
      id: a.id,
      customer: a.contact.name,
      phone: a.contact.phone,
      date: a.date.toISOString().split('T')[0],
      time: a.time,
      purpose: a.purpose,
      status: a.status.charAt(0) + a.status.slice(1).toLowerCase(),
      notes: a.notes,
    })),
  }
}

export async function createAppointment(data: unknown) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const parsed = createAppointmentSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { customer, phone, date, time, purpose, notes } = parsed.data

  let contact = await prisma.contact.findFirst({ where: contactPhoneWhere(phone) })
  if (!contact) {
    contact = await prisma.contact.create({ data: { name: customer, phone: normalizePhone(phone) } })
  }

  let appointment
  try {
    appointment = await prisma.appointment.create({
      data: {
        contactId: contact.id,
        date: new Date(date),
        time,
        purpose,
        notes,
      },
    })
  } catch (error) {
    // One appointment per slot (@@unique date+time): say so instead of failing silently.
    if ((error as { code?: string }).code === 'P2002') return { success: false, error: `${time} on ${date} is already booked. Pick another slot.` }
    throw error
  }

  revalidatePath('/appointments')
  return { success: true, data: appointment }
}

export async function updateAppointmentStatus(id: number, status: string) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const appointment = await prisma.appointment.update({
    where: { id },
    data: { status },
  })

  revalidatePath('/appointments')
  return { success: true, data: appointment }
}

export async function cancelAppointment(id: number) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  return updateAppointmentStatus(id, 'Cancelled')
}
