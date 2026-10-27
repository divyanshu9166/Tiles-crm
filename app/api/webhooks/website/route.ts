import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// POST — Receive messages from embedded website chat widget
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { sessionId, customerName, message } = body

    if (!sessionId || !message) {
      return NextResponse.json({ error: 'sessionId and message are required' }, { status: 400 })
    }

    const config = await prisma.channelConfig.findUnique({ where: { channel: 'Website' } })
    if (!config?.enabled) {
      return NextResponse.json({ error: 'Website chat integration disabled' }, { status: 403 })
    }

    const now = new Date()
    const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
    const name = customerName || `Website Visitor`

    let conversation = await prisma.conversation.findFirst({
      where: { externalId: sessionId, channel: 'Website' },
    })

    if (conversation) {
      const existingMessages = (conversation.messages as any[]) || []
      existingMessages.push({ from: 'customer', text: message, time })

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          messages: existingMessages,
          lastMessage: message,
          unread: conversation.unread + 1,
          date: now,
        },
      })
    } else {
      conversation = await prisma.conversation.create({
        data: {
          customerName: name,
          channel: 'Website',
          externalId: sessionId,
          status: 'AI_HANDLED',
          lastMessage: message,
          unread: 1,
          date: now,
          messages: [{ from: 'customer', text: message, time }],
        },
      })
    }

    // Return conversation for the widget to poll replies
    const updated = await prisma.conversation.findUnique({ where: { id: conversation.id } })
    const messages = (updated?.messages as any[]) || []

    return NextResponse.json({
      success: true,
      conversationId: conversation.id,
      messages: messages.filter((m: any) => m.from !== 'customer'),
    })
  } catch (error: any) {
    console.error('Website webhook error:', error)
    return NextResponse.json({ error: 'Could not process the message' }, { status: 500 })
  }
}

// GET — Poll for new replies (used by website chat widget).
// Public route: the visitor must present the sessionId they chat with, and only
// their own Website conversation is returned (ids are sequential, so an id
// alone would expose every WhatsApp/Instagram/website chat).
export async function GET(req: NextRequest) {
  const conversationId = Number(req.nextUrl.searchParams.get('conversationId'))
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0 || !sessionId) {
    return NextResponse.json({ error: 'conversationId and sessionId required' }, { status: 400 })
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, channel: 'Website', externalId: sessionId },
  })
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const messages = (conversation.messages as any[]) || []

  return NextResponse.json({
    success: true,
    messages,
  })
}
