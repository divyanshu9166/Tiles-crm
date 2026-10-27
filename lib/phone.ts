// One customer per phone number, whatever way it was typed: "98765 43210",
// "+91 98765-43210", "09876543210" and "9876543210" are the same customer.

// Indian mobile/landline numbers reduce to their last 10 digits; anything else
// (foreign numbers) keeps its digits with a leading + if it had one.
export function normalizePhone(raw: string | null | undefined) {
  const text = String(raw ?? '').trim()
  const digits = text.replace(/\D/g, '')
  if (digits.length === 10) return digits
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  return text.startsWith('+') ? `+${digits}` : digits || text
}

// Prisma where-clause that also finds customers saved before normalization
// ("+919876543210", "919876543210", "09876543210").
export function contactPhoneWhere(raw: string | null | undefined) {
  const phone = normalizePhone(raw)
  const original = String(raw ?? '').trim()
  const variants = [...new Set([phone, original].filter(Boolean))]
  if (/^\d{10}$/.test(phone)) return { OR: [...variants.map(value => ({ phone: value })), { phone: { endsWith: phone } }] }
  return { OR: variants.map(value => ({ phone: value })) }
}
