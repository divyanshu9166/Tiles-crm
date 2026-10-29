import { NextRequest, NextResponse } from 'next/server'
import { secretMatches } from '@/lib/secret-compare'
import { prisma } from '@/lib/db'
import { notifyManagers } from '@/lib/notify'

type FinancialSignal = {
  alertKey: string
  title: string
  subtitle: string
  severity: 'high' | 'medium'
}

function pct(value: number) {
  return `${value.toFixed(1)}%`
}

function rupees(value: number) {
  return `INR ${Math.round(value).toLocaleString('en-IN')}`
}

function toStartOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function toEndOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

export async function GET(req: NextRequest) {
  const apiSecret = req.headers.get('x-api-secret')
  if (!secretMatches(apiSecret, process.env.CRM_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const now = new Date()
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const recent = await prisma.notification.findMany({
      where: { type: 'financial_alert', createdAt: { gte: oneDayAgo } },
      select: { metadata: true },
    })
    const recentKeys = new Set(
      recent
        .map(n => (n.metadata as Record<string, unknown> | null)?.alertKey)
        .filter(Boolean)
        .map(String)
    )

    const signals: FinancialSignal[] = []

    // 1) High over-90 receivable concentration
    const invoices = await prisma.invoice.findMany({
      where: { invoiceStatus: 'ACTIVE', heldAt: null, balanceDue: { gt: 0 } },
      select: { date: true, dueDate: true, balanceDue: true },
    })

    const totalRec = invoices.reduce((s, i) => s + i.balanceDue, 0)
    const over90Rec = invoices.reduce((s, i) => {
      const base = i.dueDate || i.date
      const age = Math.max(0, Math.floor((toStartOfDay(now).getTime() - toStartOfDay(base).getTime()) / (1000 * 60 * 60 * 24)))
      return age > 90 ? s + i.balanceDue : s
    }, 0)
    const over90Share = totalRec > 0 ? (over90Rec / totalRec) * 100 : 0

    if (over90Share >= 35 && !recentKeys.has('receivables_over90_high')) {
      signals.push({
        alertKey: 'receivables_over90_high',
        title: 'Financial Alert: Receivables Aging Risk',
        subtitle: `${pct(over90Share)} of receivables are 90+ days (${rupees(over90Rec)})`,
        severity: 'high',
      })
    }

    // 2) Sudden margin drop: current 30d vs previous 30d
    const currentTo = toEndOfDay(now)
    const currentFrom = toStartOfDay(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000))
    const prevTo = toEndOfDay(new Date(currentFrom.getTime() - 24 * 60 * 60 * 1000))
    const prevFrom = toStartOfDay(new Date(prevTo.getTime() - 29 * 24 * 60 * 60 * 1000))

    const [currInvAgg, currCreditAgg, currItems, prevInvAgg, prevCreditAgg, prevItems] = await Promise.all([
      prisma.invoice.aggregate({ where: { invoiceStatus: 'ACTIVE', heldAt: null, date: { gte: currentFrom, lte: currentTo } }, _sum: { subtotal: true, discount: true } }),
      prisma.creditNote.aggregate({ where: { date: { gte: currentFrom, lte: currentTo } }, _sum: { amount: true } }),
      prisma.invoiceItem.findMany({ where: { invoice: { invoiceStatus: 'ACTIVE', heldAt: null, date: { gte: currentFrom, lte: currentTo } } }, include: { product: { select: { costPrice: true } } } }),
      prisma.invoice.aggregate({ where: { invoiceStatus: 'ACTIVE', heldAt: null, date: { gte: prevFrom, lte: prevTo } }, _sum: { subtotal: true, discount: true } }),
      prisma.creditNote.aggregate({ where: { date: { gte: prevFrom, lte: prevTo } }, _sum: { amount: true } }),
      prisma.invoiceItem.findMany({ where: { invoice: { invoiceStatus: 'ACTIVE', heldAt: null, date: { gte: prevFrom, lte: prevTo } } }, include: { product: { select: { costPrice: true } } } }),
    ])

    const currRevenue = (currInvAgg._sum.subtotal || 0) - (currInvAgg._sum.discount || 0) - (currCreditAgg._sum.amount || 0)
    const currCogs = currItems.reduce((s, i) => s + i.quantity * (i.product.costPrice || 0), 0)
    const currMargin = currRevenue > 0 ? ((currRevenue - currCogs) / currRevenue) * 100 : 0

    const prevRevenue = (prevInvAgg._sum.subtotal || 0) - (prevInvAgg._sum.discount || 0) - (prevCreditAgg._sum.amount || 0)
    const prevCogs = prevItems.reduce((s, i) => s + i.quantity * (i.product.costPrice || 0), 0)
    const prevMargin = prevRevenue > 0 ? ((prevRevenue - prevCogs) / prevRevenue) * 100 : 0

    const marginDrop = currMargin - prevMargin
    if (marginDrop <= -8 && !recentKeys.has('gross_margin_drop')) {
      signals.push({
        alertKey: 'gross_margin_drop',
        title: 'Financial Alert: Gross Margin Drop',
        subtitle: `Gross margin moved from ${pct(prevMargin)} to ${pct(currMargin)} (${marginDrop.toFixed(1)}pp)`,
        severity: 'high',
      })
    }

    // 3) GST mismatch drift (month-to-date)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const [gstOut, gstIn] = await Promise.all([
      prisma.invoice.aggregate({ where: { invoiceStatus: 'ACTIVE', heldAt: null, date: { gte: monthStart, lte: currentTo } }, _sum: { gst: true } }),
      prisma.purchaseOrder.aggregate({ where: { status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] }, itcEligible: true, date: { gte: monthStart, lte: currentTo } }, _sum: { gst: true } }),
    ])

    const outputGst = gstOut._sum.gst || 0
    const inputGst = gstIn._sum.gst || 0
    const drift = outputGst - inputGst
    const driftAbs = Math.abs(drift)
    const driftPct = outputGst > 0 ? (driftAbs / outputGst) * 100 : 0

    if ((driftAbs >= 50000 || driftPct >= 25) && !recentKeys.has('gst_mismatch_drift')) {
      signals.push({
        alertKey: 'gst_mismatch_drift',
        title: 'Financial Alert: GST Drift',
        subtitle: `Output GST ${rupees(outputGst)} vs ITC ${rupees(inputGst)} (drift ${rupees(drift)})`,
        severity: 'medium',
      })
    }

    if (signals.length === 0) {
      return NextResponse.json({ success: true, alertsSent: 0, message: 'No new financial anomalies' })
    }

    for (const sig of signals) {
      await notifyManagers({
        type: 'financial_alert',
        title: sig.title,
        subtitle: sig.subtitle,
        href: '/financials',
        metadata: { alertKey: sig.alertKey, severity: sig.severity },
        emailSubject: `⚠️ ${sig.title}`,
        emailHtml: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;"><h2 style="margin:0 0 8px;color:#b45309;">${sig.title}</h2><p style="font-size:14px;color:#111827;">${sig.subtitle}</p><p style="font-size:12px;color:#6b7280;">Open Financials dashboard to review executive summary and aging details.</p></div>`,
        whatsappText: `⚠️ ${sig.title}\n${sig.subtitle}\nReview: /financials`,
      })
    }

    return NextResponse.json({
      success: true,
      alertsSent: signals.length,
      alerts: signals.map(s => ({ key: s.alertKey, title: s.title, severity: s.severity })),
    })
  } catch (err) {
    console.error('[financial-alerts] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
