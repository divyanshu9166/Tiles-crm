import { NextResponse } from 'next/server'

/**
 * Retired: this separate dashboard bypassed the CRM's worker-health, logging,
 * transcript, and appointment safeguards. The canonical flow is Call Center.
 */
export async function POST() {
  return NextResponse.json({
    error: 'This legacy calling endpoint is disabled. Use the CRM Call Center endpoint.',
  }, { status: 410 })
}
