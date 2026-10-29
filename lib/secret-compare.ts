import crypto from 'node:crypto'

// Constant-time comparison of a presented secret with the configured one.
// An unset or empty configured secret never matches (the route stays closed).
export function secretMatches(provided: string | null | undefined, expected: string | null | undefined) {
  if (!expected || !provided) return false
  const a = crypto.createHash('sha256').update(provided).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}
