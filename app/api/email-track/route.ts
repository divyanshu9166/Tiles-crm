import { NextRequest, NextResponse } from 'next/server'
import { recordEmailEvent } from '@/lib/email-events'

// 1x1 transparent GIF pixel
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

// GET /api/email-track?rid=123&t=open
// GET /api/email-track?rid=123&t=click&url=https://...
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const recipientId = parseInt(searchParams.get('rid') || '0')
  const type = searchParams.get('t') as 'open' | 'click' | null
  const redirectUrl = searchParams.get('url')

  if (!recipientId || !type) {
    return new NextResponse(PIXEL, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' } })
  }

  const metadata: Record<string, unknown> = {}
  const ua = req.headers.get('user-agent')
  if (ua) metadata.userAgent = ua

  // Fire-and-forget the tracking event
  recordEmailEvent(recipientId, type, metadata).catch(() => {})

  if (type === 'click' && redirectUrl) {
    return NextResponse.redirect(redirectUrl)
  }

  // Return tracking pixel for opens
  return new NextResponse(PIXEL, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })
}

// POST /api/email-track/unsubscribe
export async function POST(req: NextRequest) {
  try {
    const { recipientId } = await req.json()
    if (!recipientId) return NextResponse.json({ error: 'Missing recipientId' }, { status: 400 })

    await recordEmailEvent(recipientId, 'unsubscribe')
    return NextResponse.json({ success: true, message: 'You have been unsubscribed.' })
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}
