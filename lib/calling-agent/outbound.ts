import { prisma } from '@/lib/db'
import { createRoom, deleteRoom, dispatchAgent } from '@/lib/livekit'

type OutboundCall = {
  phoneNumber: string
  customerName: string
  reason: string
}

/** Creates the durable call record before asking LiveKit to assign a worker. */
export async function startOutboundAICall({ phoneNumber, customerName, reason }: OutboundCall) {
  const roomName = `outbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date()
  const contact = await prisma.contact.findUnique({ where: { phone: phoneNumber } })

  await createRoom(roomName)
  const callLog = await prisma.callLog.create({
    data: {
      contactId: contact?.id,
      customerName: customerName || 'Unknown Customer',
      phone: phoneNumber,
      direction: 'OUTBOUND',
      status: 'QUEUED',
      duration: '0:00',
      durationSec: 0,
      agent: 'AI Agent - Anushka',
      date: now,
      time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
      purpose: reason,
      outcome: 'Queued for AI worker',
      notes: 'Outbound AI call requested',
      recording: false,
      callType: 'ai_outbound',
      aiHandled: true,
      livekitRoomId: roomName,
    },
  })

  try {
    await dispatchAgent(roomName, {
      call_type: 'outbound',
      phone_number: phoneNumber,
      reason,
      customer_name: customerName,
    })
  } catch (error) {
    await prisma.callLog.update({
      where: { id: callLog.id },
      data: { status: 'FAILED', outcome: 'LiveKit could not dispatch an AI worker' },
    })
    await deleteRoom(roomName).catch((cleanupError) => {
      console.error('Failed to clean up undispatched call room:', cleanupError)
    })
    throw error
  }

  return { roomName, callLogId: callLog.id }
}
