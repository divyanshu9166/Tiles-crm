import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import type { CallDirection, CallStatus } from '@prisma/client'

/**
 * POST /api/calls/log
 * Called by the Python AI agent to create/update calls while they are active.
 * Replaces the Airtable integration from the original repo.
 */
export async function POST(req: NextRequest) {
  // Verify API secret
  const apiSecret = req.headers.get('x-api-secret')
  if (apiSecret !== process.env.CRM_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const {
      customerName,
      phone,
      direction,
      status,
      durationSec,
      agent,
      purpose,
      outcome,
      notes,
      recording,
      transcript,
      livekitRoomId,
      callType,
    } = body

    // Try to link to existing contact
    const contact = phone ? await prisma.contact.findFirst({ where: { phone } }) : null

    // Format duration string
    const totalSec = Math.round(durationSec || 0)
    const mins = Math.floor(totalSec / 60)
    const secs = totalSec % 60
    const durationStr = `${mins}:${String(secs).padStart(2, '0')}`

    const now = new Date()

    const statusValue = (['QUEUED', 'IN_PROGRESS', 'FAILED', 'COMPLETED', 'MISSED', 'NO_ANSWER', 'BUSY'].includes(status)
      ? status : 'COMPLETED') as CallStatus
    const mutableData = {
      contactId: contact?.id,
      customerName: customerName || 'Unknown Customer',
      phone: phone || 'Unknown',
      direction: (direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND') as CallDirection,
      status: statusValue,
      duration: durationStr,
      durationSec: totalSec,
      agent: agent || 'AI Agent - Anushka',
      purpose: purpose || 'AI Call',
      outcome: outcome || 'Completed',
      notes: notes || '',
      recording: recording || false,
      livekitRoomId: livekitRoomId || null,
      callType: callType || 'ai_outbound',
      aiHandled: true,
    }

    // A worker sends several snapshots for one call. Reuse its room ID so
    // transcripts grow in one record instead of creating duplicate calls.
    const callLog = livekitRoomId
      ? await prisma.callLog.upsert({
          where: { livekitRoomId },
          update: mutableData,
          create: {
            ...mutableData,
            date: now,
            time: now.toLocaleTimeString('en-IN', {
              hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
            }),
          },
        })
      : await prisma.callLog.create({
          data: {
            ...mutableData,
            date: now,
            time: now.toLocaleTimeString('en-IN', {
              hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
            }),
          },
        })

    // Create transcript if provided
    if (transcript) {
      // Parse transcript text into message objects
      const messages = parseTranscript(transcript)
      const sentiment = analyzeSentiment(transcript)

      await prisma.callTranscript.upsert({
        where: { callLogId: callLog.id },
        update: {
          summary: generateSummary(transcript),
          sentiment,
          messages,
        },
        create: {
          callLogId: callLog.id,
          summary: generateSummary(transcript),
          sentiment,
          messages,
        },
      })
    }

    return NextResponse.json({ success: true, data: { id: callLog.id } })
  } catch (error) {
    console.error('Failed to log call:', error)
    return NextResponse.json({ error: 'Failed to log call' }, { status: 500 })
  }
}

/**
 * Parse raw transcript text into structured messages.
 * Input format: "Agent: Hello\nCustomer: Hi there"
 */
function parseTranscript(transcript: string): Array<{ from: string; text: string; time: string }> {
  if (typeof transcript !== 'string') return []

  const lines = transcript.split('\n').filter(Boolean)
  const messages: Array<{ from: string; text: string; time: string }> = []
  let timeOffset = 0

  for (const line of lines) {
    const agentMatch = line.match(/^Agent:\s*(.+)/)
    const customerMatch = line.match(/^Customer:\s*(.+)/)

    if (agentMatch) {
      const mins = Math.floor(timeOffset / 60)
      const secs = timeOffset % 60
      messages.push({
        from: 'agent',
        text: agentMatch[1].trim(),
        time: `${mins}:${String(secs).padStart(2, '0')}`,
      })
      timeOffset += 8
    } else if (customerMatch) {
      const mins = Math.floor(timeOffset / 60)
      const secs = timeOffset % 60
      messages.push({
        from: 'customer',
        text: customerMatch[1].trim(),
        time: `${mins}:${String(secs).padStart(2, '0')}`,
      })
      timeOffset += 6
    }
  }

  return messages
}

/**
 * Simple sentiment analysis based on keyword matching.
 */
function analyzeSentiment(transcript: string): string {
  const lower = transcript.toLowerCase()
  const positiveWords = ['thank', 'great', 'wonderful', 'happy', 'love', 'perfect', 'excellent', 'appreciate', 'interested', 'yes please']
  const negativeWords = ['complaint', 'unhappy', 'frustrated', 'angry', 'terrible', 'worst', 'cancel', 'refund', 'problem', 'issue']

  const positiveCount = positiveWords.filter(w => lower.includes(w)).length
  const negativeCount = negativeWords.filter(w => lower.includes(w)).length

  if (positiveCount > negativeCount) return 'Positive'
  if (negativeCount > positiveCount) return 'Negative'
  return 'Neutral'
}

/**
 * Generate a brief summary from transcript text.
 */
function generateSummary(transcript: string): string {
  const lines = transcript.split('\n').filter(Boolean)
  if (lines.length === 0) return 'AI-handled call'

  // Take first customer message and last agent message for summary
  const customerMessages = lines.filter(l => l.startsWith('Customer:'))
  const agentMessages = lines.filter(l => l.startsWith('Agent:'))

  const firstCustomer = customerMessages[0]?.replace('Customer: ', '') || ''
  const summary = firstCustomer
    ? `Customer inquiry: ${firstCustomer.substring(0, 100)}${firstCustomer.length > 100 ? '...' : ''}`
    : `AI-handled call with ${lines.length} exchanges`

  return summary
}
