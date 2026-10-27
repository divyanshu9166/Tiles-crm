import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { timingSafeEqual } from 'node:crypto'

export async function GET(request: Request) {
  try {
    // This deletes WhatsApp history, so it never runs without CRON_SECRET
    // (it used to run for anyone when the variable was missing).
    const authHeader = request.headers.get('authorization') || ''
    const secret = process.env.CRON_SECRET
    if (!secret) {
      console.error('[cron/cleanup] CRON_SECRET is not set; refusing to run')
      return NextResponse.json({ error: 'Cron is not configured' }, { status: 503 })
    }
    const expected = Buffer.from(`Bearer ${secret}`)
    const given = Buffer.from(authHeader)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    // 1. Delete messages older than 30 days (even if the conversation is still active)
    const deletedMessages = await prisma.waMessage.deleteMany({
      where: {
        created_at: {
          lt: thirtyDaysAgo
        }
      }
    })

    // 2. Delete empty/stale conversations
    // (Created > 30 days ago AND last message was > 30 days ago, or never had a message)
    const deletedConversations = await prisma.waConversation.deleteMany({
      where: {
        AND: [
          { created_at: { lt: thirtyDaysAgo } },
          {
            OR: [
              { last_message_at: { lt: thirtyDaysAgo } },
              { last_message_at: null }
            ]
          }
        ]
      }
    })

    return NextResponse.json({
      success: true,
      message: 'Retention cleanup complete',
      deletedMessages: deletedMessages.count,
      deletedConversations: deletedConversations.count
    })
  } catch (error) {
    console.error('[cron] cleanup error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
