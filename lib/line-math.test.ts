import { describe, expect, it } from 'vitest'
import { chargesTax, linePrice, principalGstRate, stockQuantity } from './line-math'

describe('GST on freight, loading and installation', () => {
  it('uses the rate of the largest line and splits CGST/SGST or IGST', () => {
    const rate = principalGstRate([{ taxable: 10000, gstRate: 18 }, { taxable: 30000, gstRate: 12 }], 18)
    expect(rate).toBe(12)
    expect(chargesTax(2500, rate, false)).toEqual({ gst: 300, cgst: 150, sgst: 150, igst: 0 })
    expect(chargesTax(2500, 18, true)).toEqual({ gst: 450, cgst: 0, sgst: 0, igst: 450 })
    expect(chargesTax(0, 18, false).gst).toBe(0)
    expect(principalGstRate([], 18)).toBe(18)
  })
})

describe('sold line rules (POS, quotations, servers)', () => {
  it('BOX tile sold by area bills and deducts the boxes the area needs', () => {
    const line = { quantity: 1, rate: 1480, unitOfMeasure: 'BOX', areaSqft: 300, coveragePerBox: 15 }
    expect(stockQuantity(line)).toBe(20)
    expect(linePrice(line)).toMatchObject({ amount: 29600, boxes: 20 })
  })

  it('BOX without area bills and deducts the box count', () => {
    const line = { quantity: 3, rate: 1480, unitOfMeasure: 'BOX', areaSqft: 0, coveragePerBox: 15 }
    expect(stockQuantity(line)).toBe(3)
    expect(linePrice(line).amount).toBe(4440)
  })

  it('SQFT bills the measured area and keeps its typed stock quantity', () => {
    const line = { quantity: 2, rate: 50, unitOfMeasure: 'SQFT', areaSqft: 100, coveragePerBox: 15.5 }
    expect(linePrice(line)).toMatchObject({ amount: 5000, boxes: 7 })
    expect(stockQuantity(line)).toBe(2)
  })

  it('SQFT without coverage bills the area (the screen used to show qty x rate)', () => {
    expect(linePrice({ quantity: 1, rate: 50, unitOfMeasure: 'SQFT', areaSqft: 100 }).amount).toBe(5000)
    expect(linePrice({ quantity: 4, rate: 50, unitOfMeasure: 'SQFT', areaSqft: 0, coveragePerBox: 15 }).amount).toBe(200)
  })

  it('rounds to whole rupees instead of truncating paise', () => {
    expect(linePrice({ quantity: 1, rate: 45, unitOfMeasure: 'SQFT', areaSqft: 100.5 }).amount).toBe(4523)
    expect(linePrice({ quantity: 2, rate: 99.5, unitOfMeasure: 'PCS' }).amount).toBe(199)
  })

  it('slabs bill their measured area and leave as one piece', () => {
    expect(linePrice({ quantity: 1, rate: 300, unitOfMeasure: 'SLAB', areaSqft: 52.5 }).amount).toBe(15750)
    expect(stockQuantity({ quantity: 1, rate: 300, unitOfMeasure: 'SLAB', areaSqft: 52.5 })).toBe(1)
  })
})
