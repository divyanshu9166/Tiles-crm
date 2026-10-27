import { describe, expect, it } from 'vitest'
import { istDate, istMonthStart } from './local-date'

describe('istDate', () => {
  it('uses India time, not UTC, for the calendar day', () => {
    // 01:00 IST on 1 Nov is still 31 Oct in UTC.
    expect(istDate(new Date('2026-10-31T19:30:00Z'))).toBe('2026-11-01')
    expect(istDate(new Date('2026-10-31T18:00:00Z'))).toBe('2026-10-31')
  })
  it('gives the IST month start', () => {
    expect(istMonthStart(new Date('2026-10-31T19:30:00Z'))).toBe('2026-11-01')
  })
})
