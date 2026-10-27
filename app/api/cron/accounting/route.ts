import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { postAutoJournals } from '@/lib/erp/accounting'

/**
 * GET /api/cron/accounting
 *
 * Posts double-entry journals for every document event since the last run
 * (invoices, payments, stock moves, slabs, vendor bills, expenses, payroll).
 * Idempotent, so it is safe to call every few minutes.
 * Secured with the x-api-secret header, like the stock-alerts cron.
 */
export async function GET(req: NextRequest) {
  const apiSecret = req.headers.get('x-api-secret')
  if (!process.env.CRM_API_SECRET || apiSecret !== process.env.CRM_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await postAutoJournals(prisma, 'Cron')
    return NextResponse.json({ success: true, posted: result.posted, skipped: result.skipped })
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Posting failed' }, { status: 500 })
  }
}
