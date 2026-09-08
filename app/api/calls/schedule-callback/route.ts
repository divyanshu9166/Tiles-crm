import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

/**
 * POST /api/calls/schedule-callback
 * Called by the AI agent when a customer requests a callback.
 * Creates a call log entry with the callback details.
 */
export async function POST(req: NextRequest) {
  const apiSecret = req.headers.get('x-api-secret')
  if (apiSecret !== process.env.CRM_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { customerName, phone, preferredTime, reason } = await req.json()
    if (
      typeof customerName !== 'string' || !customerName.trim() ||
      typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone.replace(/[\s().-]/g, '')) ||
      typeof preferredTime !== 'string' || !preferredTime.trim()
    ) {
      return NextResponse.json({ error: 'customerName, E.164 phone, and preferredTime are required' }, { status: 400 })
    }
    const normalizedPhone = phone.replace(/[\s().-]/g, '')

    // Try to link to existing contact
    const contact = await prisma.contact.findFirst({ where: { phone: normalizedPhone } })

    const now = new Date()

    const callLog = await prisma.callLog.create({
      data: {
        contactId: contact?.id,
        customerName: customerName.trim().slice(0, 120),
        phone: normalizedPhone,
        direction: 'OUTBOUND',
        status: 'QUEUED',
        duration: '0:00',
        durationSec: 0,
        agent: 'AI Agent - Anushka',
        date: now,
        time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
        purpose: `Callback requested: ${reason || 'General'}`,
        outcome: 'Callback Scheduled',
        notes: `Customer requested callback at ${preferredTime.trim().slice(0, 200)}. Reason: ${typeof reason === 'string' ? reason.slice(0, 500) : 'General'}`,
        recording: false,
        callType: 'ai_inbound',
        aiHandled: true,
      },
    })

    return NextResponse.json({ success: true, data: { id: callLog.id } })
  } catch (error) {
    console.error('Failed to schedule callback:', error)
    return NextResponse.json({ error: 'Failed to schedule callback' }, { status: 500 })
  }
}
