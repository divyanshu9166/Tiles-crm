'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { createCallLogSchema } from '@/lib/validations/call'
import type { CallDirection, CallStatus } from '@prisma/client'
import { outboundAICallSchema } from '@/lib/validations/ai-call'
import { callingAgentStatus } from '@/lib/calling-agent-status'

export async function getCallLogs() {
  const calls = await prisma.callLog.findMany({
    include: { contact: true, transcript: true },
    orderBy: { date: 'desc' },
  })

  return {
    success: true,
    data: calls.map(c => ({
      id: c.id,
      customer: c.customerName,
      phone: c.phone,
      direction: c.direction === 'INBOUND' ? 'Inbound' : 'Outbound',
      status: c.status.charAt(0) + c.status.slice(1).toLowerCase().replace('_', ' '),
      duration: c.duration,
      durationSec: c.durationSec,
      agent: c.agent,
      date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(c.date),
      time: c.date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
      purpose: c.purpose,
      outcome: c.outcome,
      notes: c.notes,
      recording: c.recording,
      aiHandled: c.aiHandled,
      callType: c.callType,
      transcript: c.transcript ? {
        summary: c.transcript.summary,
        sentiment: c.transcript.sentiment,
        messages: c.transcript.messages,
      } : null,
    })),
  }
}

export async function createCallLog(data: unknown) {
  const parsed = createCallLogSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { customerName, phone, direction, status, duration, durationSec, agent, purpose, outcome, notes, recording } = parsed.data

  // Try to link to existing contact
  const contact = await prisma.contact.findFirst({ where: { phone } })

  const now = new Date()
  const callLog = await prisma.callLog.create({
    data: {
      contactId: contact?.id,
      customerName,
      phone,
      direction: direction as CallDirection,
      status: status as CallStatus,
      duration,
      durationSec,
      agent,
      date: now,
      time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
      purpose,
      outcome,
      notes,
      recording,
    },
  })

  revalidatePath('/calls')
  return { success: true, data: callLog }
}

export async function getCallStats() {
  const [total, completed, missed, totalDuration, aiHandled] = await Promise.all([
    prisma.callLog.count(),
    prisma.callLog.count({ where: { status: 'COMPLETED' } }),
    prisma.callLog.count({ where: { status: 'MISSED' } }),
    prisma.callLog.aggregate({ _sum: { durationSec: true } }),
    prisma.callLog.count({ where: { aiHandled: true } }),
  ])

  return {
    success: true,
    data: {
      total,
      completed,
      missed,
      aiHandled,
      avgDuration: total > 0 ? Math.round((totalDuration._sum.durationSec || 0) / total) : 0,
    },
  }
}

export async function initiateAICall(phoneNumber: string, reason: string, customerName: string = '') {
  const parsed = outboundAICallSchema.safeParse({ phoneNumber, reason, customerName })
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  try {
    const LIVEKIT_URL = process.env.LIVEKIT_URL
    const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY
    const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET

    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return { success: false, error: 'LiveKit not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET in .env' }
    }

    const { startOutboundAICall } = await import('@/lib/calling-agent/outbound')
    const { roomName, callLogId } = await startOutboundAICall(parsed.data)

    revalidatePath('/calls')
    return { success: true, data: { roomName, callLogId, message: `Call queued for ${phoneNumber}` } }
  } catch (error: unknown) {
    console.error('Failed to initiate AI call:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to initiate call' }
  }
}

export async function getAIAgentStatus() {
  return { success: true, data: await callingAgentStatus() }
}
