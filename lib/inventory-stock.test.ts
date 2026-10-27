import { describe, expect, it } from 'vitest'
import { createProductSchema, updateProductSchema, updateStockSchema } from './validations/product'
import { createTransferSchema } from './validations/godown'

const product = { sku: 'T-01', name: 'Tile', category: 'Tiles', price: 100 }

describe('inventory input safeguards', () => {
  it('trims names and normalizes units', () => {
    const result = createProductSchema.parse({ ...product, name: '  Tile  ', sku: ' T-01 ', unitOfMeasure: ' box ' })
    expect(result.name).toBe('Tile')
    expect(result.sku).toBe('T-01')
    expect(result.unitOfMeasure).toBe('BOX')
  })
  it.each([{ name: ' ' }, { price: -1 }, { price: 1.5 }, { costPrice: 1.5 }, { reorderLevel: 0.5 }, { stock: -1 }, { stock: NaN }, { godownId: 0 }, { tilesPerBox: 1.5 }])('rejects invalid product values %j', input => {
    expect(createProductSchema.safeParse({ ...product, ...input }).success).toBe(false)
  })
  it('preserves fractional stock and unit sizes', () => {
    expect(createProductSchema.parse({ ...product, stock: 2.75, unitSize: 0.5 }).stock).toBe(2.75)
  })
  it('allows clearing optional tile attributes and a zero reorder level', () => {
    expect(updateProductSchema.parse({ coveragePerBox: null, finish: null, stockGroupId: null, reorderLevel: 0 })).toEqual({ coveragePerBox: null, finish: null, stockGroupId: null, reorderLevel: 0 })
  })
  it('rejects stock edits through product metadata', () => {
    expect(updateProductSchema.safeParse({ stock: 100 }).success).toBe(false)
  })
  it('requires a quantity and prevents zero/negative removal', () => {
    for (const input of [{ id: 1 }, { id: 1, operation: 'REMOVE', quantity: 0 }, { id: 1, operation: 'ADD', quantity: -1 }, { id: 1, operation: 'SET', quantity: Infinity }]) expect(updateStockSchema.safeParse(input).success).toBe(false)
    expect(updateStockSchema.safeParse({ id: 1, operation: 'SET', quantity: 0 }).success).toBe(true)
  })
  it('accepts legacy absolute stock requests', () => {
    expect(updateStockSchema.parse({ id: 1, stock: 5, godownId: 2 }).stock).toBe(5)
  })
  it('rejects fractional transfers until their database supports them', () => {
    expect(createTransferSchema.safeParse({ fromGodownId: 1, toGodownId: 2, items: [{ productId: 1, name: 'Tile', sku: 'T', quantity: 0.5 }] }).success).toBe(false)
  })
})
