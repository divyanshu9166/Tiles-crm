import { describe, expect, it } from 'vitest'
import { contactPhoneWhere, normalizePhone } from './phone'

describe('customer phone numbers', () => {
  it('reduces every Indian format to the same 10 digits', () => {
    for (const raw of ['9876543210', '98765 43210', '+91 98765-43210', '+919876543210', '919876543210', '09876543210', ' 98765 43210 ']) {
      expect(normalizePhone(raw)).toBe('9876543210')
    }
  })

  it('keeps foreign numbers recognisable', () => {
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100')
  })

  it('looks up customers saved in older formats too', () => {
    const where = contactPhoneWhere('98765 43210')
    expect(where.OR).toContainEqual({ phone: '9876543210' })
    expect(where.OR).toContainEqual({ phone: { endsWith: '9876543210' } })
  })
})
