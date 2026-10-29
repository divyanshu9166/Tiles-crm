import { describe, expect, it } from 'vitest'
import { secretMatches } from './secret-compare'

describe('secretMatches', () => {
  it('accepts the exact secret only', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true)
    expect(secretMatches('s3cre', 's3cret')).toBe(false)
    expect(secretMatches('s3cretx', 's3cret')).toBe(false)
  })
  it('stays closed when either side is missing', () => {
    expect(secretMatches(null, 's3cret')).toBe(false)
    expect(secretMatches('', '')).toBe(false)
    expect(secretMatches('anything', undefined)).toBe(false)
  })
})
