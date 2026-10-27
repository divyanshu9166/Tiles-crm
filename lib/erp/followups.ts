// Odoo payment follow-ups: each overdue customer is at the highest level
// whose "days after due" has been reached (e.g. 7 → reminder email,
// 15 → phone call, 30 → final notice).

export type FollowUpLevelLite = { id: number; name: string; days: number; action: string }

export const DEFAULT_LEVELS = [
  { name: 'Friendly reminder', days: 7, action: 'EMAIL', message: 'This is a friendly reminder that the invoices below are past due. Please arrange payment at your earliest convenience.' },
  { name: 'Phone follow-up', days: 15, action: 'CALL', message: 'Call the customer about the overdue balance and agree a payment date.' },
  { name: 'Final notice', days: 30, action: 'LETTER', message: 'Despite our reminders the balance below is still unpaid. Please settle it within 7 days to avoid further action.' },
]

export function daysOverdue(dueDate: Date, today = new Date()) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const due = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate())
  return Math.max(0, Math.round((start.getTime() - due.getTime()) / 86_400_000))
}

// Invoices without an explicit due date are due on their invoice date.
export function invoiceDueDate(invoice: { date: Date; dueDate: Date | null }) {
  return invoice.dueDate || invoice.date
}

export function levelFor(days: number, levels: FollowUpLevelLite[]) {
  return [...levels].sort((a, b) => b.days - a.days).find(level => days >= level.days) || null
}

// A customer needs action when overdue, at a level, and not snoozed by a
// promised payment / next-action date in the future.
export function needsAction(days: number, level: FollowUpLevelLite | null, nextDate: Date | null, today = new Date()) {
  if (days === 0 || !level) return false
  if (!nextDate) return true
  return nextDate <= new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59)
}
