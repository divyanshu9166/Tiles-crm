// Quotations keep their bank details as a hidden [[BANK_DETAILS]]{…}[[/BANK_DETAILS]]
// block inside the notes. That block must never reach a sales order, a tax
// invoice or a print-out.
const START = '[[BANK_DETAILS]]'
const END = '[[/BANK_DETAILS]]'

export function stripBankDetails(notes: string | null | undefined) {
  let text = String(notes ?? '')
  for (let guard = 0; guard < 5; guard++) {
    const start = text.indexOf(START)
    if (start < 0) break
    const end = text.indexOf(END, start)
    text = end < 0 ? text.slice(0, start) : text.slice(0, start) + text.slice(end + END.length)
  }
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

export function escapeHtml(value: string | null | undefined) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string))
}
