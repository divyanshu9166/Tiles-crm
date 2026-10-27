// Odoo pricelist rule resolution: the most specific rule that matches wins
// (product > category > all products), then the highest minimum quantity
// that the ordered quantity reaches. Dates bound when a rule is valid.

export type PriceRule = {
  id: number
  appliesTo: string // ALL | CATEGORY | PRODUCT
  productId: number | null
  categoryId: number | null
  minQty: number
  computeType: string // FIXED | DISCOUNT | MARKUP
  fixedPrice: number | null
  discountPct: number | null
  markupPct: number | null
  validFrom: Date | null
  validTo: Date | null
}

export type PricedProduct = { id: number; categoryId: number; price: number; costPrice: number }

const SPECIFICITY: Record<string, number> = { PRODUCT: 3, CATEGORY: 2, ALL: 1 }

export function matchingRule(rules: PriceRule[], product: PricedProduct, quantity: number, at = new Date()) {
  return rules
    .filter(rule => {
      if (rule.appliesTo === 'PRODUCT' && rule.productId !== product.id) return false
      if (rule.appliesTo === 'CATEGORY' && rule.categoryId !== product.categoryId) return false
      if (quantity < rule.minQty) return false
      if (rule.validFrom && at < rule.validFrom) return false
      if (rule.validTo && at > rule.validTo) return false
      return true
    })
    .sort((a, b) => (SPECIFICITY[b.appliesTo] || 0) - (SPECIFICITY[a.appliesTo] || 0) || b.minQty - a.minQty || b.id - a.id)[0] || null
}

export function rulePrice(rule: PriceRule | null, product: PricedProduct) {
  if (!rule) return product.price
  if (rule.computeType === 'FIXED' && rule.fixedPrice != null) return Math.max(0, Math.round(rule.fixedPrice))
  if (rule.computeType === 'MARKUP' && rule.markupPct != null && product.costPrice > 0) return Math.round(product.costPrice * (1 + rule.markupPct / 100))
  if (rule.computeType === 'DISCOUNT' && rule.discountPct != null) return Math.max(0, Math.round(product.price * (1 - rule.discountPct / 100)))
  return product.price
}

export function describeRule(rule: PriceRule) {
  if (rule.computeType === 'FIXED') return `₹${rule.fixedPrice ?? 0} fixed`
  if (rule.computeType === 'MARKUP') return `cost + ${rule.markupPct ?? 0}%`
  return `${rule.discountPct ?? 0}% off list`
}
