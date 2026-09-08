import { NextResponse } from 'next/server'

/** Retired alongside the unsafe legacy direct-SIP dispatch endpoint. */
export async function POST() {
  return NextResponse.json({
    error: 'This legacy bulk-dial endpoint is disabled. Use the CRM Call Center flow.',
  }, { status: 410 })
}
