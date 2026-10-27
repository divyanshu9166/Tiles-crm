import { getBillableArea } from '@/lib/units'

// One set of rules for a sold line, shared by the POS and quotation screens
// and their server actions, so the total a cashier sees is the total saved
// and the stock that leaves matches what was billed.

export type SoldLine = {
  quantity: number
  rate: number
  unitOfMeasure?: string | null
  areaSqft?: number | null
  coveragePerBox?: number | null
}

const AREA_UNITS = new Set(['SQFT', 'SQM', 'SLAB'])

function unitOf(line: SoldLine) {
  return String(line.unitOfMeasure || 'PCS').toUpperCase()
}

// Boxes needed to cover an area (tolerates float noise like 300/15 = 20.0000001).
export function boxesForArea(areaSqft: number, coveragePerBox: number) {
  if (!(areaSqft > 0) || !(coveragePerBox > 0)) return 0
  return Math.ceil(Math.round((areaSqft / coveragePerBox) * 1e6) / 1e6)
}

// Pieces/boxes that leave stock. A BOX tile sold by area takes the boxes
// needed for that area, not the typed quantity (same rule as sales orders).
// Area-priced units (SQFT/SQM) keep their typed stock quantity.
export function stockQuantity(line: SoldLine) {
  const unit = unitOf(line)
  const quantity = Math.max(1, Math.round(Number(line.quantity) || 1))
  const area = Math.max(0, Number(line.areaSqft) || 0)
  const coverage = Math.max(0, Number(line.coveragePerBox) || 0)
  if (unit === 'BOX' && area > 0 && coverage > 0) return boxesForArea(area, coverage)
  return quantity
}

// Freight, loading, installation and transport billed with the goods are part
// of the value of supply (composite supply), so they carry GST at the rate of
// the principal supply: the line with the largest taxable value.
export function principalGstRate(lines: { taxable: number; gstRate: number }[], fallbackRate: number) {
  const principal = lines.reduce<{ taxable: number; gstRate: number } | null>((best, line) => (!best || line.taxable > best.taxable ? line : best), null)
  return principal ? principal.gstRate : fallbackRate
}

export function chargesTax(charges: number, rate: number, interstate: boolean) {
  const gst = charges > 0 ? Math.round(charges * rate / 100) : 0
  const cgst = interstate ? 0 : Math.round(gst / 2)
  return { gst, cgst, sgst: interstate ? 0 : gst - cgst, igst: interstate ? gst : 0 }
}

// Line amount in whole rupees, plus what the screen shows (boxes for an area).
export function linePrice(line: SoldLine): { amount: number; boxes?: number; area?: number; billableArea?: number } {
  const unit = unitOf(line)
  const rate = Math.max(0, Number(line.rate) || 0)
  const quantity = Math.max(1, Number(line.quantity) || 1)
  const area = Math.max(0, Number(line.areaSqft) || 0)
  const coverage = Math.max(0, Number(line.coveragePerBox) || 0)
  const boxes = area > 0 && coverage > 0 ? boxesForArea(area, coverage) : undefined

  if (AREA_UNITS.has(unit)) {
    const billableArea = getBillableArea(area, quantity, unit)
    return { amount: Math.round(billableArea * rate), billableArea, ...(boxes !== undefined && unit !== 'SLAB' ? { boxes, area } : {}) }
  }
  if (unit === 'BOX' && boxes !== undefined) return { amount: Math.round(boxes * rate), boxes, area }
  return { amount: Math.round(quantity * rate) }
}
