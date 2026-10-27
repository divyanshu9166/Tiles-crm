import { z } from 'zod'

export const createBranchSchema = z.object({
  name: z.string().trim().min(1, 'Branch name is required'),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  managerName: z.string().optional(),
  isHeadOffice: z.boolean().default(false),
})

export const createGodownSchema = z.object({
  name: z.string().trim().min(1, 'Godown name is required'),
  address: z.string().optional(),
  type: z.string().default('Warehouse'),
  capacity: z.number().positive().optional(),
  isDefault: z.boolean().default(false),
  branchId: z.number().int().positive().optional(),
})

export const createTransferSchema = z.object({
  fromGodownId: z.number().int().positive(),
  toGodownId: z.number().int().positive(),
  notes: z.string().optional(),
  requestedBy: z.string().optional(),
  items: z.array(z.object({
    productId: z.number().int().positive(),
    name: z.string(),
    sku: z.string(),
    quantity: z.number().int().min(1),
  })).min(1, 'At least one item required'),
})
