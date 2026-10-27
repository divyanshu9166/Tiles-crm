// Odoo purchase "bill control": a vendor bill line is checked against its PO
// line on quantity (never bill more than was received) and on price.

export type PoLineState = { quantity: number; receivedQty: number; billedQty: number; unitCost: number }
export type BillLineState = { quantity: number; unitCost: number; poItem?: PoLineState | null }

export type LineMatch = {
  qtyOk: boolean
  priceOk: boolean
  billable: number // received but not yet billed (before this bill)
  priceVariance: number // (bill price − PO price) × qty
}

export function billableQty(po: PoLineState) {
  return Math.max(0, po.receivedQty - po.billedQty)
}

export function matchLine(line: BillLineState): LineMatch {
  if (!line.poItem) return { qtyOk: true, priceOk: true, billable: line.quantity, priceVariance: 0 }
  const billable = billableQty(line.poItem)
  return {
    qtyOk: line.quantity <= billable,
    priceOk: line.unitCost === line.poItem.unitCost,
    billable,
    priceVariance: (line.unitCost - line.poItem.unitCost) * line.quantity,
  }
}

export function billMatchStatus(lines: BillLineState[]) {
  return lines.every(line => {
    const match = matchLine(line)
    return match.qtyOk && match.priceOk
  }) ? 'MATCHED' as const : 'TO_CHECK' as const
}

// Odoo purchase_order.invoice_status on received quantities.
export function poBillingStatus(items: PoLineState[]) {
  if (items.some(item => billableQty(item) > 0)) return 'TO_BILL' as const
  if (items.length > 0 && items.every(item => item.billedQty >= item.quantity)) return 'BILLED' as const
  return 'NOTHING' as const
}

// discountFactor: the PO's (subtotal − discount) / subtotal. A PO discount
// lowers the untaxed amount and the GST the same way the PO did, so the bill
// matches what is actually owed (it used to bill the undiscounted prices).
export function billTotals(lines: { quantity: number; unitCost: number; gstRate: number }[], supplyType: string, discountFactor = 1) {
  const interstate = supplyType === 'INTERSTATE'
  const factor = Math.min(1, Math.max(0, discountFactor))
  let gross = 0
  let gst = 0
  for (const line of lines) {
    const amount = line.quantity * line.unitCost
    gross += amount
    gst += Math.round(amount * factor * line.gstRate / 100)
  }
  const subtotal = Math.round(gross * factor)
  const cgst = interstate ? 0 : Math.round(gst / 2)
  return { subtotal, gst, cgst, sgst: interstate ? 0 : gst - cgst, igst: interstate ? gst : 0, total: subtotal + gst }
}

export function poDiscountFactor(po: { subtotal: number; discount: number } | null | undefined) {
  if (!po || !(po.subtotal > 0) || !(po.discount > 0)) return 1
  return Math.max(0, po.subtotal - po.discount) / po.subtotal
}
