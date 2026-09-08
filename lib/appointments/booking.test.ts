import { describe, expect, it } from 'vitest'
import {
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  normalizeCustomerPhone,
  timeToMinutes,
} from './booking'

describe('AI appointment booking rules', () => {
  it('only accepts today or a future real India date', () => {
    expect(normalizeAppointmentDate('2026-09-07', '2026-09-07')).toBe('2026-09-07')
    expect(normalizeAppointmentDate('2026-02-30', '2026-01-01')).toBeNull()
    expect(normalizeAppointmentDate('2026-09-06', '2026-09-07')).toBeNull()
  })

  it('canonicalizes only the fixed showroom slots', () => {
    expect(normalizeAppointmentTime('2 pm')).toBe('2:00 PM')
    expect(normalizeAppointmentTime('14:00')).toBe('2:00 PM')
    expect(normalizeAppointmentTime('2:30 PM')).toBeNull()
    expect(normalizeAppointmentTime('29:99')).toBeNull()
    expect(timeToMinutes('5 PM')).toBe(17 * 60)
  })

  it('accepts only a normalized E.164 customer phone', () => {
    expect(normalizeCustomerPhone('+91 (98765) 43210')).toBe('+919876543210')
    expect(normalizeCustomerPhone('9876543210')).toBeNull()
  })
})
