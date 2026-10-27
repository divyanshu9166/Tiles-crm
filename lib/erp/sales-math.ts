import { getBillableArea } from '@/lib/units'

export type PricedLine = {
  quantity: number
  price: number
  unitOfMeasure?: string | null
  areaSqft?: number | null
  coveragePerBox?: number | null
  gstRate?: number | null
}

// Same unit rules as POS invoices: area units bill measured area, boxes bill
// the box count, everything else bills quantity.
export function lineAmount(line: PricedLine) {
  const unit = String(line.unitOfMeasure || 'PCS').toUpperCase()
  const quantity = Math.max(0, Number(line.quantity) || 0)
  const price = Math.max(0, Number(line.price) || 0)
  if (quantity === 0) return 0
  if (unit === 'SQFT' || unit === 'SQM' || unit === 'SLAB') return Math.round(getBillableArea(line.areaSqft, quantity, unit) * price)
  return Math.round(quantity * price)
}

// Boxes needed to cover an area — the order quantity for BOX lines.
export function boxesForArea(areaSqft: number, coveragePerBox: number) {
  if (!(areaSqft > 0) || !(coveragePerBox > 0)) return 0
  return Math.ceil(Math.round((areaSqft / coveragePerBox) * 1e6) / 1e6)
}

// Portion of a line for partial delivery / invoicing; measured area is prorated.
export function portionOf<T extends PricedLine>(line: T, quantity: number): T {
  const total = Math.max(1, Number(line.quantity) || 1)
  const area = line.areaSqft ? Math.round((line.areaSqft * quantity / total) * 100) / 100 : line.areaSqft
  return { ...line, quantity, areaSqft: area }
}

export type DiscountType = 'none' | 'percent' | 'flat'

export function orderDiscount(subtotal: number, type: DiscountType, value: number) {
  if (subtotal <= 0 || !(value > 0)) return 0
  if (type === 'percent') return Math.round(subtotal * Math.min(value, 100) / 100)
  if (type === 'flat') return Math.min(Math.round(value), subtotal)
  return 0
}

export type TaxedLine = { amount: number; discount: number; taxable: number; gstRate: number; gst: number; cgst: number; sgst: number; igst: number }

// Spread an order discount over lines by value (last line takes the rounding
// remainder), then compute GST per line for the place of supply.
export function computeTaxes(lines: { amount: number; gstRate: number }[], discount: number, supplyType: string) {
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0)
  let left = Math.min(discount, subtotal)
  const interstate = supplyType === 'INTERSTATE'
  const taxed: TaxedLine[] = lines.map((line, index) => {
    const share = subtotal <= 0 ? 0 : index === lines.length - 1 ? left : Math.round(line.amount / subtotal * discount)
    left -= share
    const taxable = Math.max(0, line.amount - share)
    const gst = Math.round(taxable * line.gstRate / 100)
    const cgst = interstate ? 0 : Math.round(gst / 2)
    return { amount: line.amount, discount: share, taxable, gstRate: line.gstRate, gst, igst: interstate ? gst : 0, cgst, sgst: interstate ? 0 : gst - cgst }
  })
  const sum = (key: keyof TaxedLine) => taxed.reduce((total, line) => total + line[key], 0)
  return { lines: taxed, subtotal, discount: sum('discount'), taxable: sum('taxable'), gst: sum('gst'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst') }
}

export type OrderLineState = { quantity: number; qtyDelivered: number; qtyInvoiced: number }

// Odoo's delivery_status / invoice_status on sale.order.
export function deliveryStatus(lines: OrderLineState[]) {
  const ordered = lines.reduce((sum, line) => sum + line.quantity, 0)
  const delivered = lines.reduce((sum, line) => sum + Math.min(line.qtyDelivered, line.quantity), 0)
  if (delivered === 0) return 'PENDING' as const
  return delivered >= ordered ? 'DELIVERED' as const : 'PARTIAL' as const
}

export function invoiceableQty(line: OrderLineState, policy: string) {
  const basis = policy === 'ORDERED' ? line.quantity : line.qtyDelivered
  return Math.max(0, basis - line.qtyInvoiced)
}

// Invoiced beyond what the customer kept (goods returned): to be refunded.
export function refundableQty(line: OrderLineState, policy: string) {
  const basis = policy === 'ORDERED' ? line.quantity : line.qtyDelivered
  return Math.max(0, line.qtyInvoiced - basis)
}

export function invoiceStatus(lines: OrderLineState[], policy: string) {
  if (lines.some(line => refundableQty(line, policy) > 0)) return 'TO_REFUND' as const
  if (lines.some(line => invoiceableQty(line, policy) > 0)) return 'TO_INVOICE' as const
  if (lines.length > 0 && lines.every(line => line.qtyInvoiced >= line.quantity)) return 'INVOICED' as const
  return 'NOTHING' as const
}
