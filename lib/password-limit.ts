// Failed-attempt limiter for password checks (login, staff-portal unlock,
// password change). In-memory and per server process: enough to stop online
// guessing of short staff passwords on a single-instance deployment. A
// multi-instance deployment should back this with Redis.

type Bucket = { failures: number; firstAt: number; lockedUntil: number }

export type LimitRule = { maxFailures: number; windowMs: number; lockMs: number }

export const PASSWORD_RULE: LimitRule = { maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 }

export function createLimiter(rule: LimitRule, now: () => number = Date.now) {
  const buckets = new Map<string, Bucket>()

  function bucket(key: string) {
    const at = now()
    let entry = buckets.get(key)
    if (!entry || (entry.lockedUntil <= at && at - entry.firstAt > rule.windowMs)) {
      entry = { failures: 0, firstAt: at, lockedUntil: 0 }
      buckets.set(key, entry)
    }
    return entry
  }

  return {
    // Seconds until the key may try again, or 0 when allowed.
    retryAfter(key: string) {
      const entry = buckets.get(key)
      if (!entry) return 0
      const wait = entry.lockedUntil - now()
      return wait > 0 ? Math.ceil(wait / 1000) : 0
    },
    fail(key: string) {
      const entry = bucket(key)
      entry.failures += 1
      if (entry.failures >= rule.maxFailures) entry.lockedUntil = now() + rule.lockMs
    },
    succeed(key: string) {
      buckets.delete(key)
    },
  }
}

// One shared limiter for every password check in this process.
export const passwordLimiter = createLimiter(PASSWORD_RULE)

export function clientIp(req: Request) {
  const forwarded = req.headers.get('x-forwarded-for')
  return (forwarded?.split(',')[0] || req.headers.get('x-real-ip') || 'unknown').trim()
}

export function tooManyAttemptsMessage(seconds: number) {
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
}
