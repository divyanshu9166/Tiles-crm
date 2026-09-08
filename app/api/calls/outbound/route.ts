import { NextRequest, NextResponse } from 'next/server'
import { outboundAICallSchema } from '@/lib/validations/ai-call'

/**
 * POST /api/calls/outbound
 * Triggers an outbound AI call by dispatching a LiveKit agent.
 * Called from the CRM frontend when a user clicks "AI Call" button.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = outboundAICallSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })
    }
    const { phoneNumber, reason, customerName } = parsed.data

    const LIVEKIT_URL = process.env.LIVEKIT_URL
    const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY
    const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET

    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return NextResponse.json(
        { error: 'LiveKit not configured. Please set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.' },
        { status: 503 }
      )
    }

    const { startOutboundAICall } = await import('@/lib/calling-agent/outbound')
    const { roomName, callLogId } = await startOutboundAICall({
      phoneNumber,
      reason: reason || 'Follow-up call',
      customerName: customerName || '',
    })

    return NextResponse.json({
      success: true,
      data: {
        roomName,
        callLogId,
        message: `Call queued for ${phoneNumber}`,
      },
    })
  } catch (error) {
    console.error('Failed to initiate outbound call:', error)
    return NextResponse.json({ error: 'Failed to initiate call' }, { status: 500 })
  }
}
