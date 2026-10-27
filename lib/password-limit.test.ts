import { describe, expect, it } from 'vitest'
import { createLimiter } from './password-limit'

describe('password attempt limiter', () => {
  const rule = { maxFailures: 3, windowMs: 60_000, lockMs: 120_000 }

  it('locks a key after repeated failures and unlocks after the lock time', () => {
    let clock = 0
    const limiter = createLimiter(rule, () => clock)
    limiter.fail('ip|admin')
    limiter.fail('ip|admin')
    expect(limiter.retryAfter('ip|admin')).toBe(0)
    limiter.fail('ip|admin')
    expect(limiter.retryAfter('ip|admin')).toBe(120)
    expect(limiter.retryAfter('ip|other')).toBe(0) // other accounts unaffected
    clock = 120_001
    expect(limiter.retryAfter('ip|admin')).toBe(0)
  })

  it('forgets old failures outside the window and resets on success', () => {
    let clock = 0
    const limiter = createLimiter(rule, () => clock)
    limiter.fail('k'); limiter.fail('k')
    clock = 61_000
    limiter.fail('k') // window restarted: only 1 failure now
    expect(limiter.retryAfter('k')).toBe(0)
    limiter.fail('k')
    limiter.succeed('k')
    limiter.fail('k'); limiter.fail('k')
    expect(limiter.retryAfter('k')).toBe(0)
  })
})
