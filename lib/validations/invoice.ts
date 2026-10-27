import { z } from 'zod'

export const invoiceItemSchema = z.object({
  productId: z.number(),
  name: z.string(),
  sku: z.string(),
  quantity: z.number().min(1),
  price: z.number().min(0),
  hsnCode: z.string().optional(),
  gstRate: z.number().min(0).max(100).optional(),
  unitOfMeasure: z.string().optional(),
  areaSqft: z.number().positive().optional(),
  coveragePerBox: z.number().positive().optional(),
  slabId: z.number().int().positive().optional(),
  batchId: z.number().int().positive().optional(),
})

export const paymentEntrySchema = z.object({
  amount: z.number().min(0, 'Payment amount cannot be negative'),
  method: z.enum(['Cash', 'UPI', 'Card', 'EMI', 'Bank Transfer', 'Cheque']),
  reference: z.string().optional(),
  notes: z.string().optional(),
})

const invoiceBaseSchema = z.object({
  customer: z.string().min(1),
  phone: z.string().min(10),
  address: z.string().optional(),
  gstNumber: z.string().optional(),
  items: z.array(invoiceItemSchema).min(1, 'At least one item required'),
  discount: z.number().min(0).default(0),
  discountType: z.enum(['none', 'flat', 'percent']).default('none'),
  payments: z.array(paymentEntrySchema).min(1, 'At least one payment required'),
  salespersonId: z.number().optional(),
  notes: z.string().optional(),
  dueDate: z.string().optional(), // ISO date string
  isHeld: z.boolean().optional(),  // park/hold the bill
  transportCost: z.number().min(0).default(0),
  freightCharge: z.number().min(0).default(0),
  loadingCharge: z.number().min(0).default(0),
  installationCharge: z.number().min(0).default(0),
  roadPermit: z.string().optional(),
  supplyType: z.enum(['INTRASTATE', 'INTERSTATE']).optional(),
  placeOfSupply: z.string().optional(),
  godownId: z.number().int().positive().optional(),
  pricelistId: z.number().int().positive().nullable().optional(), // pricelist the bill was priced from
})

// A bill needs a payment, or a due date when it is sold on credit (pay later).
export const createInvoiceSchema = invoiceBaseSchema.refine(data => data.isHeld || data.payments.some(payment => payment.amount > 0) || !!data.dueDate, {
  message: 'Enter a payment, or set a due date to sell on credit (pay later)',
  path: ['payments'],
})

export const updateInvoiceSchema = invoiceBaseSchema.omit({ payments: true }).extend({
  payments: z.array(paymentEntrySchema).optional(),
})

export const recordPaymentSchema = z.object({
  invoiceId: z.number(),
  amount: z.number().min(1),
  method: z.enum(['Cash', 'UPI', 'Card', 'EMI', 'Bank Transfer', 'Cheque']),
  reference: z.string().optional(),
  notes: z.string().optional(),
})

export const createCreditNoteSchema = z.object({
  invoiceId: z.number(),
  amount: z.number().min(1),
  reason: z.string().min(1, 'Reason is required'),
})

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>
export type PaymentEntry = z.infer<typeof paymentEntrySchema>
