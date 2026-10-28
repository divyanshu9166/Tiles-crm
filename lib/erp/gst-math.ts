// Taxable value of an invoice. Since Oct 2026 transport/freight/loading/
// installation carry GST (chargesGst > 0) and are part of the taxable value;
// older bills billed them untaxed and keep reporting goods only.
export type TaxableInvoice = { subtotal: number; discount: number; chargesGst?: number | null; transportCost?: number | null; freightCharge?: number | null; loadingCharge?: number | null; installationCharge?: number | null }

type Charges = Pick<TaxableInvoice, 'transportCost' | 'freightCharge' | 'loadingCharge' | 'installationCharge'>

export function invoiceCharges(inv: Charges) {
  return (inv.transportCost || 0) + (inv.freightCharge || 0) + (inv.loadingCharge || 0) + (inv.installationCharge || 0)
}

export function taxableOf(inv: TaxableInvoice) {
  return inv.subtotal - inv.discount + ((inv.chargesGst || 0) > 0 ? invoiceCharges(inv) : 0)
}

// A credit note reverses part of its invoice: the same share of taxable value
// and tax, split CGST/SGST or IGST like the invoice.
export type CreditedInvoice = TaxableInvoice & { total: number; gst: number; supplyType: string }

export function creditNoteTax(amount: number, inv: CreditedInvoice) {
  const taxable = inv.total > 0 ? Math.round(amount * taxableOf(inv) / inv.total) : amount
  const tax = inv.total > 0 ? Math.round(amount * inv.gst / inv.total) : 0
  const interstate = inv.supplyType === 'INTERSTATE'
  const cgst = interstate ? 0 : Math.round(tax / 2)
  return { taxableValue: taxable, tax, cgst, sgst: interstate ? 0 : tax - cgst, igst: interstate ? tax : 0 }
}

// Splits a credit note into the same shares its invoice booked: goods revenue,
// freight/loading/installation income and output GST.
export function creditNoteSplit(amount: number, inv: { total: number; gst: number; transportCost?: number | null; freightCharge?: number | null; loadingCharge?: number | null; installationCharge?: number | null }) {
  const gst = inv.total > 0 ? Math.round(amount * inv.gst / inv.total) : 0
  const charges = inv.total > 0 ? Math.round(amount * invoiceCharges(inv) / inv.total) : 0
  return { gst, charges, goods: amount - gst - charges }
}

// GSTIN starts with the two-digit state code (27 = Maharashtra, 29 = Karnataka…).
export function gstinState(gstin?: string | null) {
  const code = String(gstin || '').trim().slice(0, 2)
  return /^\d{2}$/.test(code) ? code : null
}

// Interstate when both parties' GSTIN state codes are known and differ.
// When either GSTIN is missing (walk-in customer, store GSTIN not set) the
// state can't be told, so the user's choice stands (intrastate by default).
export function supplyTypeFor(ourGstin?: string | null, theirGstin?: string | null, chosen?: string | null): 'INTRASTATE' | 'INTERSTATE' {
  const ours = gstinState(ourGstin)
  const theirs = gstinState(theirGstin)
  if (ours && theirs) return ours !== theirs ? 'INTERSTATE' : 'INTRASTATE'
  return chosen === 'INTERSTATE' ? 'INTERSTATE' : 'INTRASTATE'
}

// Splits a GST amount into CGST+SGST (intrastate) or IGST (interstate).
export function splitGst(gst: number, supplyType: string) {
  const interstate = supplyType === 'INTERSTATE'
  const cgst = interstate ? 0 : Math.round(gst / 2)
  return { cgst, sgst: interstate ? 0 : gst - cgst, igst: interstate ? gst : 0 }
}
