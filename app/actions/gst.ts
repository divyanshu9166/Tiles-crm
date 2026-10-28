'use server'

import { prisma } from '@/lib/db'
import { creditNoteTax, invoiceCharges, taxableOf } from '@/lib/erp/gst-math'
import { revalidatePath } from 'next/cache'
import { requireRole, requireAuth } from '@/lib/auth-helpers'
import { createHsnCodeSchema, createEWayBillSchema } from '@/lib/validations/gst'

// ─── HSN MASTER ──────────────────────────────────────

export async function getHsnCodes() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const codes = await prisma.hsnCode.findMany({ orderBy: { code: 'asc' } })
  return { success: true, data: codes }
}

export async function createHsnCode(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createHsnCodeSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const code = await prisma.hsnCode.create({ data: parsed.data })
  revalidatePath('/gst')
  return { success: true, data: code }
}

export async function deleteHsnCode(id: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  await prisma.hsnCode.delete({ where: { id } })
  revalidatePath('/gst')
  return { success: true }
}

// ─── HELPER: date range from YYYY-MM period ──────────

function periodRange(period: string) {
  const [year, month] = period.split('-').map(Number)
  return {
    from: new Date(year, month - 1, 1),
    to: new Date(year, month, 1),
    year,
    month,
  }
}

function gstUqc(unitOfMeasure?: string) {
  switch (String(unitOfMeasure || 'PCS').toUpperCase()) {
    case 'SQFT': return 'SQF'
    case 'SQM': return 'SQM'
    case 'RFT': return 'MTR'
    case 'BOX': return 'BOX'
    default: return 'NOS'
  }
}

// ─── GSTR-1 (Outward Supplies) ───────────────────────

export async function generateGSTR1(period: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const { from, to } = periodRange(period)

  const [invoices, creditNotes, store, cancelledCount] = await Promise.all([
    prisma.invoice.findMany({
      where: { date: { gte: from, lt: to }, invoiceStatus: { in: ['ACTIVE', 'REFUNDED'] }, heldAt: null },
      include: {
        contact: { select: { name: true, gstNumber: true, state: true, address: true } },
        items: true,
      },
      orderBy: { displayId: 'asc' },
    }),
    prisma.creditNote.findMany({
      where: { date: { gte: from, lt: to } },
      include: {
        invoice: {
          include: { contact: { select: { name: true, gstNumber: true, state: true } } },
        },
      },
    }),
    prisma.storeSettings.findFirst({ where: { id: 1 } }),
    prisma.invoice.count({ where: { date: { gte: from, lt: to }, invoiceStatus: 'CANCELLED', heldAt: null } }),
  ])

  const storeGSTIN = store?.gstNumber || ''
  const storeState = store?.address?.split(',').pop()?.trim() || 'Maharashtra'

  // ── Classify invoices ──────────────────────────────
  const b2b: typeof invoices = []       // Registered buyers (have GSTIN)
  const b2cl: typeof invoices = []      // Unregistered, interstate, total > 2.5L
  const b2cs: typeof invoices = []      // All other B2C (intrastate or small interstate)
  const exports_: typeof invoices = []
  const nilExempt: typeof invoices = []

  for (const inv of invoices) {
    if (inv.supplyType === 'EXPORT') { exports_.push(inv); continue }
    if (inv.supplyType === 'EXEMPT' || inv.supplyType === 'NIL_RATED') { nilExempt.push(inv); continue }
    if (inv.contact.gstNumber) { b2b.push(inv); continue }
    if (inv.supplyType === 'INTERSTATE' && inv.total > 250000) { b2cl.push(inv); continue }
    b2cs.push(inv)
  }

  // ── Credit note classification ─────────────────────
  const notes = creditNotes.map(c => ({ ...c, tax: creditNoteTax(c.amount, c.invoice) }))
  const cdnr = notes.filter(c => c.invoice.contact.gstNumber)  // to registered
  const cdns = notes.filter(c => !c.invoice.contact.gstNumber)  // to unregistered
  const sumNotes = (key: 'taxableValue' | 'cgst' | 'sgst' | 'igst') => notes.reduce((s, c) => s + c.tax[key], 0)
  const creditNoteTotals = { taxableValue: sumNotes('taxableValue'), cgst: sumNotes('cgst'), sgst: sumNotes('sgst'), igst: sumNotes('igst'), count: notes.length }

  // ── HSN Summary (all invoices) ─────────────────────
  const hsnMap: Record<string, { description: string; uqc: string; qty: number; taxableValue: number; igst: number; cgst: number; sgst: number; cess: number }> = {}
  for (const inv of invoices) {
    for (const item of inv.items) {
      const hsn = item.hsnCode || 'OTHERS'
      const uqc = gstUqc(item.unitOfMeasure)
      const key = `${hsn}:${uqc}`
      if (!hsnMap[key]) hsnMap[key] = { description: item.name, uqc, qty: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
      const taxable = item.taxableAmount || item.quantity * item.price
      const rate = item.gstRate || (store?.gstRate || 18)
      const itemGST = Math.round(taxable * rate / 100)
      const measuredQty = ['SQFT', 'SQM'].includes(String(item.unitOfMeasure || '').toUpperCase()) && item.areaSqft
        ? item.areaSqft
        : item.quantity
      hsnMap[key].qty += measuredQty
      hsnMap[key].taxableValue += taxable
      if (inv.supplyType === 'INTERSTATE') {
        hsnMap[key].igst += itemGST
      } else {
        hsnMap[key].cgst += Math.round(itemGST / 2)
        hsnMap[key].sgst += itemGST - Math.round(itemGST / 2)
      }
      hsnMap[key].cess += item.cess || 0
    }
    if ((inv.chargesGst || 0) > 0 && inv.items.length > 0) {
      const principal = inv.items.reduce((best, item) => ((item.taxableAmount || 0) > (best.taxableAmount || 0) ? item : best), inv.items[0])
      const key = `${principal.hsnCode || 'OTHERS'}:${gstUqc(principal.unitOfMeasure)}`
      hsnMap[key].taxableValue += invoiceCharges(inv)
      if (inv.supplyType === 'INTERSTATE') {
        hsnMap[key].igst += inv.chargesGst || 0
      } else {
        hsnMap[key].cgst += Math.round((inv.chargesGst || 0) / 2)
        hsnMap[key].sgst += (inv.chargesGst || 0) - Math.round((inv.chargesGst || 0) / 2)
      }
    }
  }

  // ── Document Serial Summary ────────────────────────
  const sortedIds = invoices.map(i => i.displayId).sort()
  const docSummary = sortedIds.length > 0 ? {
    from: sortedIds[0],
    to: sortedIds[sortedIds.length - 1],
    count: sortedIds.length + cancelledCount,
    cancelled: cancelledCount,
  } : null

  // ── Totals ─────────────────────────────────────────
  const totals = {
    taxableValue: invoices.reduce((s, i) => s + taxableOf(i), 0),
    cgst: invoices.reduce((s, i) => s + i.cgst, 0),
    sgst: invoices.reduce((s, i) => s + i.sgst, 0),
    igst: invoices.reduce((s, i) => s + i.igst, 0),
    cess: invoices.reduce((s, i) => s + i.cess, 0),
    totalInvoices: invoices.length,
    // Credit notes issued in the period reduce the tax payable (GSTR-3B 3.1).
    creditNotes: creditNoteTotals,
  }

  const returnData = {
    period, gstin: storeGSTIN, storeState,
    totals,
    b2b: b2b.map(inv => ({
      displayId: inv.displayId, date: inv.date,
      customer: inv.contact.name, gstin: inv.contact.gstNumber,
      placeOfSupply: inv.placeOfSupply || inv.contact.state || storeState,
      supplyType: inv.supplyType,
      taxableValue: taxableOf(inv),
      cgst: inv.cgst, sgst: inv.sgst, igst: inv.igst, cess: inv.cess, total: inv.total,
    })),
    b2cl: b2cl.map(inv => ({
      displayId: inv.displayId, date: inv.date,
      customer: inv.contact.name,
      placeOfSupply: inv.placeOfSupply || inv.contact.state || storeState,
      taxableValue: taxableOf(inv),
      igst: inv.igst, cess: inv.cess, total: inv.total,
    })),
    b2cs: b2cs.map(inv => ({
      displayId: inv.displayId, date: inv.date,
      customer: inv.contact.name,
      supplyType: inv.supplyType,
      taxableValue: taxableOf(inv),
      cgst: inv.cgst, sgst: inv.sgst, igst: inv.igst, total: inv.total,
    })),
    exports: exports_.map(inv => ({
      displayId: inv.displayId, date: inv.date, customer: inv.contact.name,
      taxableValue: taxableOf(inv), igst: inv.igst, total: inv.total,
    })),
    nilExempt: {
      nilRated: nilExempt.filter(i => i.supplyType === 'NIL_RATED').reduce((s, i) => s + taxableOf(i), 0),
      exempt: nilExempt.filter(i => i.supplyType === 'EXEMPT').reduce((s, i) => s + taxableOf(i), 0),
      count: nilExempt.length,
    },
    cdnr: cdnr.map(c => ({
      displayId: c.displayId, date: c.date,
      customer: c.invoice.contact.name, gstin: c.invoice.contact.gstNumber,
      invoice: c.invoice.displayId,
      amount: c.amount, reason: c.reason, ...c.tax,
    })),
    cdns: cdns.map(c => ({
      displayId: c.displayId, date: c.date,
      customer: c.invoice.contact.name,
      invoice: c.invoice.displayId,
      amount: c.amount, reason: c.reason, ...c.tax,
    })),
    hsnSummary: Object.entries(hsnMap).map(([hsn, vals]) => ({ hsn, ...vals })),
    docSummary,
  }

  const ret = await prisma.gSTReturn.upsert({
    where: { returnType_period: { returnType: 'GSTR1', period } },
    create: { returnType: 'GSTR1', period, data: returnData },
    update: { data: returnData, status: 'DRAFT' },
  })

  revalidatePath('/gst')
  return { success: true, data: ret }
}

// ─── GSTR-2 (Inward Supplies / ITC) ─────────────────

export async function generateGSTR2(period: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const { from, to } = periodRange(period)

  const bills = await prisma.vendorBill.findMany({
    where: { billDate: { gte: from, lt: to }, status: 'POSTED' },
    include: { supplier: { select: { name: true, gstNumber: true } }, po: { select: { displayId: true, isRCM: true, itcEligible: true, itcCategory: true } } },
    orderBy: { displayId: 'asc' },
  })
  const pos = bills.map(bill => ({
    displayId: bill.vendorRef ? `${bill.displayId} (${bill.vendorRef})` : bill.displayId,
    date: bill.billDate,
    supplier: bill.supplier,
    subtotal: bill.subtotal, discount: 0,
    gst: bill.gst, cgst: bill.cgst, sgst: bill.sgst, igst: bill.igst,
    isRCM: bill.po?.isRCM ?? false,
    itcEligible: bill.po?.itcEligible ?? true,
    itcCategory: bill.po?.itcCategory ?? 'INPUTS',
  }))

  // ITC classification
  const itcInputs    = pos.filter(p => p.itcCategory === 'INPUTS' && p.itcEligible)
  const itcServices  = pos.filter(p => p.itcCategory === 'SERVICES' && p.itcEligible)
  const itcCapital   = pos.filter(p => p.itcCategory === 'CAPITAL_GOODS' && p.itcEligible)
  const itcIneligible = pos.filter(p => !p.itcEligible || p.itcCategory === 'INELIGIBLE')
  const rcmPos       = pos.filter(p => p.isRCM)

  function sumITC(list: typeof pos) {
    return {
      taxable: list.reduce((s, p) => s + (p.subtotal - p.discount), 0),
      cgst: list.reduce((s, p) => s + p.cgst, 0),
      sgst: list.reduce((s, p) => s + p.sgst, 0),
      igst: list.reduce((s, p) => s + p.igst, 0),
      total: list.reduce((s, p) => s + p.gst, 0),
    }
  }

  const returnData = {
    period,
    summary: {
      totalPOs: pos.length,
      totalTaxableValue: pos.reduce((s, p) => s + (p.subtotal - p.discount), 0),
      totalITC: pos.filter(p => p.itcEligible && p.itcCategory !== 'INELIGIBLE').reduce((s, p) => s + p.gst, 0),
      cgst: pos.filter(p => p.itcEligible && p.itcCategory !== 'INELIGIBLE').reduce((s, p) => s + p.cgst, 0),
      sgst: pos.filter(p => p.itcEligible && p.itcCategory !== 'INELIGIBLE').reduce((s, p) => s + p.sgst, 0),
      igst: pos.filter(p => p.itcEligible && p.itcCategory !== 'INELIGIBLE').reduce((s, p) => s + p.igst, 0),
    },
    itcClassification: {
      inputs: sumITC(itcInputs),
      services: sumITC(itcServices),
      capitalGoods: sumITC(itcCapital),
      ineligible: sumITC(itcIneligible),
    },
    rcmSupplies: rcmPos.map(p => ({
      displayId: p.displayId, date: p.date,
      supplier: p.supplier.name, gstin: p.supplier.gstNumber,
      taxableValue: p.subtotal - p.discount,
      cgst: p.cgst, sgst: p.sgst, igst: p.igst,
    })),
    supplierWise: pos.map(po => ({
      displayId: po.displayId, date: po.date,
      supplier: po.supplier.name, gstin: po.supplier.gstNumber || '',
      taxableValue: po.subtotal - po.discount,
      cgst: po.cgst, sgst: po.sgst, igst: po.igst,
      totalGST: po.gst,
      itcEligible: po.itcEligible && po.itcCategory !== 'INELIGIBLE' ? po.gst : 0,
      itcCategory: po.itcCategory,
      isRCM: po.isRCM,
    })),
  }

  const ret = await prisma.gSTReturn.upsert({
    where: { returnType_period: { returnType: 'GSTR2', period } },
    create: { returnType: 'GSTR2', period, data: returnData },
    update: { data: returnData, status: 'DRAFT' },
  })

  revalidatePath('/gst')
  return { success: true, data: ret }
}

// ─── GSTR-3B (Summary Return — all tables) ──────────

export async function generateGSTR3B(period: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }

  const [g1Existing, g2Existing] = await Promise.all([
    prisma.gSTReturn.findFirst({ where: { returnType: 'GSTR1', period } }),
    prisma.gSTReturn.findFirst({ where: { returnType: 'GSTR2', period } }),
  ])
  if (g1Existing?.status !== 'FILED') await generateGSTR1(period)
  if (g2Existing?.status !== 'FILED') await generateGSTR2(period)
  const [gstr1Rec, gstr2Rec] = await Promise.all([
    prisma.gSTReturn.findFirst({ where: { returnType: 'GSTR1', period } }),
    prisma.gSTReturn.findFirst({ where: { returnType: 'GSTR2', period } }),
  ])

  const g1 = (gstr1Rec?.data as Record<string, unknown>) || {}
  const g2 = (gstr2Rec?.data as Record<string, unknown>) || {}
  const g1totals = (g1.totals as Record<string, number>) || {}
  const g2summary = (g2.summary as Record<string, number>) || {}
  const g2itc = (g2.itcClassification as Record<string, Record<string, number>>) || {}
  const g1nil = (g1.nilExempt as Record<string, number>) || {}
  const g1notes = ((g1.totals as Record<string, unknown>)?.creditNotes as Record<string, number>) || {}

  // Table 3.1 — Outward taxable supplies, net of credit notes issued in the period
  const outwardTaxable = {
    a_taxable: (g1totals.taxableValue || 0) - (g1notes.taxableValue || 0),
    a_cgst: (g1totals.cgst || 0) - (g1notes.cgst || 0),
    a_sgst: (g1totals.sgst || 0) - (g1notes.sgst || 0),
    a_igst: (g1totals.igst || 0) - (g1notes.igst || 0),
    a_cess: g1totals.cess || 0,
    b_zeroRated: 0,
    c_nil: (g1nil.nilRated || 0) + (g1nil.exempt || 0),
    d_rcm: 0,
  }

  // Table 3.2 — Interstate supplies (from GSTR-1 B2CS interstate + B2CL)
  const b2clList = (g1.b2cl as Array<Record<string, number>>) || []
  const interstate3_2 = {
    unregistered: b2clList.reduce((s, i) => s + (i.taxableValue || 0), 0),
    igst: b2clList.reduce((s, i) => s + (i.igst || 0), 0),
  }

  // Table 4 — ITC Available
  const itcAvailable = {
    a5_inputs: (g2itc.inputs?.total || 0),
    a5_services: (g2itc.services?.total || 0),
    a5_capitalGoods: (g2itc.capitalGoods?.total || 0),
    total: (g2summary.totalITC || 0),
    cgst: (g2summary.cgst || 0),
    sgst: (g2summary.sgst || 0),
    igst: (g2summary.igst || 0),
    b_reversed: 0,         // ITC reversed (not applicable here)
    d_ineligible: (g2itc.ineligible?.total || 0),
  }

  // Table 5 — Exempt/Nil inward supplies
  const inwardExempt = {
    interState: 0,
    intraState: g2summary.totalTaxableValue || 0,
  }

  // Table 6.1 — Net Tax Payable
  const netCGST = Math.max(0, outwardTaxable.a_cgst - itcAvailable.cgst)
  const netSGST = Math.max(0, outwardTaxable.a_sgst - itcAvailable.sgst)
  const netIGST = Math.max(0, outwardTaxable.a_igst - itcAvailable.igst)

  const returnData = {
    period,
    gstr1Generated: !!gstr1Rec,
    gstr2Generated: !!gstr2Rec,
    table3_1: outwardTaxable,
    table3_2: interstate3_2,
    table4: itcAvailable,
    table5: inwardExempt,
    table6_1: {
      cgst: netCGST,
      sgst: netSGST,
      igst: netIGST,
      total: netCGST + netSGST + netIGST,
    },
  }

  const ret = await prisma.gSTReturn.upsert({
    where: { returnType_period: { returnType: 'GSTR3B', period } },
    create: { returnType: 'GSTR3B', period, data: returnData },
    update: { data: returnData, status: 'DRAFT' },
  })

  revalidatePath('/gst')
  return { success: true, data: ret }
}

// ─── GSTR-9 (Annual Return) ──────────────────────────

export async function generateGSTR9(year: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }

  // Aggregate all monthly GSTR-1 and GSTR-2 data for the financial year
  // Financial year: Apr year-1 to Mar year (e.g. FY 2024-25: Apr 2024 to Mar 2025)
  const months: string[] = []
  for (let m = 4; m <= 12; m++) months.push(`${year}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) months.push(`${year + 1}-${String(m).padStart(2, '0')}`)

  const [gstr1s, gstr2s] = await Promise.all([
    prisma.gSTReturn.findMany({ where: { returnType: 'GSTR1', period: { in: months } } }),
    prisma.gSTReturn.findMany({ where: { returnType: 'GSTR2', period: { in: months } } }),
  ])

  let totalOutwardTaxable = 0, totalOutwardCGST = 0, totalOutwardSGST = 0, totalOutwardIGST = 0
  let totalITC = 0, totalITCCGST = 0, totalITCSGST = 0, totalITCIGST = 0

  for (const r of gstr1s) {
    const d = (r.data as Record<string, unknown>)
    const t = (d?.totals as Record<string, number>) || {}
    totalOutwardTaxable += t.taxableValue || 0
    totalOutwardCGST += t.cgst || 0
    totalOutwardSGST += t.sgst || 0
    totalOutwardIGST += t.igst || 0
  }
  for (const r of gstr2s) {
    const d = (r.data as Record<string, unknown>)
    const s = (d?.summary as Record<string, number>) || {}
    totalITC += s.totalITC || 0
    totalITCCGST += s.cgst || 0
    totalITCSGST += s.sgst || 0
    totalITCIGST += s.igst || 0
  }

  const returnData = {
    financialYear: `${year}-${String(year + 1).slice(-2)}`,
    monthsCovered: months.length,
    gstr1Filed: gstr1s.filter(r => r.status === 'FILED').length,
    gstr3bFiled: 0, // track separately
    // Part II — Details of outward and inward supplies
    table4: { // Outward supplies
      a_taxableB2B: totalOutwardTaxable,
      b_taxableB2C: 0,
      cgst: totalOutwardCGST,
      sgst: totalOutwardSGST,
      igst: totalOutwardIGST,
    },
    table6: { // ITC
      a_itcAsPerGSTR2: totalITC,
      cgst: totalITCCGST,
      sgst: totalITCSGST,
      igst: totalITCIGST,
    },
    table9: { // Tax payable vs paid
      cgst: Math.max(0, totalOutwardCGST - totalITCCGST),
      sgst: Math.max(0, totalOutwardSGST - totalITCSGST),
      igst: Math.max(0, totalOutwardIGST - totalITCIGST),
      total: Math.max(0, (totalOutwardCGST + totalOutwardSGST + totalOutwardIGST) - totalITC),
    },
  }

  const period = `${year}-FY`
  const ret = await prisma.gSTReturn.upsert({
    where: { returnType_period: { returnType: 'GSTR9', period } },
    create: { returnType: 'GSTR9', period, data: returnData },
    update: { data: returnData, status: 'DRAFT' },
  })

  revalidatePath('/gst')
  return { success: true, data: ret }
}

// ─── RETURNS MANAGEMENT ──────────────────────────────

export async function getGSTReturns() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const returns = await prisma.gSTReturn.findMany({ orderBy: [{ period: 'desc' }, { returnType: 'asc' }] })
  return { success: true, data: returns }
}

export async function markReturnFiled(id: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  await prisma.gSTReturn.update({ where: { id }, data: { status: 'FILED', filedAt: new Date() } })
  revalidatePath('/gst')
  return { success: true }
}

export async function getReturnByTypePeriod(returnType: string, period: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const ret = await prisma.gSTReturn.findFirst({ where: { returnType, period } })
  return { success: true, data: ret }
}

// ─── E-WAY BILLS ─────────────────────────────────────

export async function getEWayBills() {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Manager access required' } as never }
  const bills = await prisma.eWayBill.findMany({
    include: { invoice: { select: { displayId: true, total: true, date: true, contact: { select: { name: true } } } } },
    orderBy: { createdAt: 'desc' },
  })
  return { success: true, data: bills }
}

export async function createEWayBill(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createEWayBillSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { validFrom, validUntil, ...rest } = parsed.data
  const bill = await prisma.eWayBill.create({
    data: {
      ...rest,
      validFrom: validFrom ? new Date(validFrom) : undefined,
      validUntil: validUntil ? new Date(validUntil) : undefined,
    },
  })
  revalidatePath('/gst')
  return { success: true, data: bill }
}

export async function cancelEWayBill(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  await prisma.eWayBill.update({ where: { id }, data: { status: 'CANCELLED' } })
  revalidatePath('/gst')
  return { success: true }
}
