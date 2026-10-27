'use server'

import { prisma } from '@/lib/db'
import { requireRole, requireAuth } from '@/lib/auth-helpers'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { syncStoneLotTotals } from '@/lib/stone-inventory'
import { inventoryError, lockInventoryProducts } from '@/lib/inventory-stock'

const slabStatus = z.enum(['AVAILABLE', 'RESERVED', 'SOLD', 'DAMAGED', 'IN_PROCESSING'])

const createLotSchema = z.object({
  lotNumber: z.string().trim().min(1, 'Lot number is required'),
  productId: z.number().int().positive(),
  supplierId: z.number().int().positive().optional(),
  godownId: z.number().int().positive().optional(),
  origin: z.string().trim().optional(),
  shadeCode: z.string().trim().optional(),
  qualityGrade: z.string().trim().optional(),
  avgThicknessMm: z.number().positive().optional(),
  costPerSqft: z.number().int().min(0).default(0),
  notes: z.string().trim().optional(),
  photos: z.array(z.string()).default([]),
  slabs: z.array(z.object({
    slabNumber: z.string().trim().min(1),
    lengthInches: z.number().positive(),
    widthInches: z.number().positive(),
    thicknessMm: z.number().positive().optional(),
    photo: z.string().optional(),
    qcGrade: z.string().optional(),
  })).min(1, 'Add at least one slab').superRefine((slabs, ctx) => {
    const seen = new Set<string>()
    slabs.forEach((slab, index) => {
      const key = slab.slabNumber.toLowerCase()
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'slabNumber'], message: `Duplicate slab number: ${slab.slabNumber}` })
      }
      seen.add(key)
    })
  }),
})

const updateSlabSchema = z.object({
  slabId: z.number().int().positive(),
  status: slabStatus.optional(),
  godownId: z.number().int().positive().nullable().optional(),
  qcGrade: z.string().trim().nullable().optional(),
  photo: z.string().trim().nullable().optional(),
  reservedForCustomId: z.number().int().positive().nullable().optional(),
  soldPrice: z.number().int().min(0).nullable().optional(),
})

const sampleLoanSchema = z.object({
  contactId: z.number().int().positive().optional(),
  customerName: z.string().trim().min(1).optional(),
  customerPhone: z.string().trim().min(10).optional(),
  productId: z.number().int().positive().optional(),
  slabId: z.number().int().positive().optional(),
  expectedReturn: z.string().optional(),
  notes: z.string().trim().optional(),
}).refine(data => data.contactId || (data.customerName && data.customerPhone), { message: 'Select or enter the customer receiving the sample' })
  .refine(data => data.productId || data.slabId, { message: 'Select a product or slab sample' })

const sampleLoanStatusSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(['RETURNED', 'LOST', 'CONVERTED_TO_SALE']),
})

const bookMatchSchema = z.object({
  slabId: z.number().int().positive(),
  partnerId: z.number().int().positive().nullable(),
})

const sqft = (lengthInches: number, widthInches: number) =>
  Math.round((lengthInches * widthInches / 144) * 100) / 100

const stoneOffcutSchema = z.object({
  sourceSlabId: z.number().int().positive(),
  sourceCustomOrderId: z.number().int().positive().optional(),
  lengthInches: z.number().positive(),
  widthInches: z.number().positive(),
  shadeCode: z.string().trim().optional(),
  photo: z.string().trim().optional(),
  salePrice: z.number().int().min(0).optional(),
  notes: z.string().trim().optional(),
})

export async function getStoneLots(filters?: { query?: string; status?: string; godownId?: number }) {
  await requireAuth()
  const query = filters?.query?.trim()
  const lots = await prisma.stoneLot.findMany({
    where: {
      ...(filters?.godownId ? { slabs: { some: { godownId: filters.godownId } } } : {}),
      ...(filters?.status && filters.status !== 'ALL' ? { status: filters.status } : {}),
      ...(query ? {
        OR: [
          { lotNumber: { contains: query, mode: 'insensitive' } },
          { shadeCode: { contains: query, mode: 'insensitive' } },
          { product: { name: { contains: query, mode: 'insensitive' } } },
        ],
      } : {}),
    },
    include: {
      product: { select: { id: true, name: true, sku: true, price: true, hsnCode: true, materialCategory: true, thicknessMm: true, finish: true } },
      supplier: { select: { id: true, name: true } },
      slabs: {
        where: filters?.godownId ? { godownId: filters.godownId } : undefined,
        include: { godown: { select: { id: true, name: true } }, reservedForCustom: { select: { displayId: true } } },
        orderBy: { slabNumber: 'asc' },
      },
    },
    orderBy: { purchaseDate: 'desc' },
  })

  return {
    success: true,
    data: lots.map(lot => ({
      ...lot,
      totalSlabs: lot.slabs.length,
      totalSqft: lot.slabs.reduce((sum, slab) => sum + slab.sqft, 0),
      availableSlabs: lot.slabs.filter(s => s.status === 'AVAILABLE').length,
      availableSqft: Math.round(lot.slabs.filter(s => s.status === 'AVAILABLE').reduce((sum, slab) => sum + slab.sqft, 0) * 100) / 100,
      reservedSlabs: lot.slabs.filter(s => s.status === 'RESERVED' || s.status === 'IN_PROCESSING').length,
    })),
  }
}

export async function createStoneLot(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createLotSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const input = parsed.data
  const product = await prisma.product.findUnique({ where: { id: input.productId }, select: { isSlabTracked: true, thicknessMm: true } })
  if (!product) return { success: false, error: 'Stone product not found' }
  if (!product.isSlabTracked) return { success: false, error: 'Enable slab tracking on the selected product first' }
  if (input.godownId) {
    const godown = await prisma.godown.findUnique({ where: { id: input.godownId }, select: { id: true } })
    if (!godown) return { success: false, error: 'Selected stone yard / godown was not found' }
  }
  if (input.supplierId) {
    const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true } })
    if (!supplier) return { success: false, error: 'Selected supplier was not found' }
  }

  try {
    const lot = await prisma.$transaction(async tx => {
      await lockInventoryProducts(tx, [input.productId])
      const liveProduct = await tx.product.findUnique({ where: { id: input.productId } })
      if (!liveProduct?.isSlabTracked) throw new Error('Product is no longer configured for slab tracking')
      const created = await tx.stoneLot.create({
        data: {
          lotNumber: input.lotNumber,
          productId: input.productId,
          supplierId: input.supplierId,
          origin: input.origin || null,
          shadeCode: input.shadeCode || null,
          qualityGrade: input.qualityGrade || null,
          avgThicknessMm: input.avgThicknessMm ?? product.thicknessMm ?? null,
          costPerSqft: input.costPerSqft,
          notes: input.notes || null,
          photos: input.photos,
          slabs: {
            create: input.slabs.map(slab => ({
              slabNumber: slab.slabNumber,
              lengthInches: slab.lengthInches,
              widthInches: slab.widthInches,
              sqft: sqft(slab.lengthInches, slab.widthInches),
              thicknessMm: slab.thicknessMm ?? product.thicknessMm ?? null,
              photo: slab.photo || null,
              qcGrade: slab.qcGrade || null,
              godownId: input.godownId,
            })),
          },
        },
      })
      await syncStoneLotTotals(tx, created.id)
      return created
    })
    revalidatePath('/inventory')
    return { success: true, data: lot }
  } catch (error: any) {
    if (error?.code === 'P2002') return { success: false, error: 'That lot number or slab number already exists' }
    if (error?.code === 'P2003') return { success: false, error: 'A selected inventory relation no longer exists. Refresh and try again.' }
    return { success: false, error: error?.message || 'Could not create stone lot' }
  }
}

export async function updateSlab(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = updateSlabSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const input = parsed.data
  if (input.reservedForCustomId !== undefined || input.soldPrice !== undefined) return { success: false, error: 'Change allocations and sale prices through their fabrication or invoice workflow' }
  try {
    const updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Slab" WHERE id = ${input.slabId} FOR UPDATE`
      const slab = await tx.slab.findUnique({ where: { id: input.slabId }, include: { sampleLoans: { where: { status: 'OUT' }, select: { id: true } } } })
      if (!slab) throw new Error('Slab not found')
      const statusChanged = input.status !== undefined && input.status !== slab.status
      const locationChanged = input.godownId !== undefined && input.godownId !== slab.godownId
      if ((statusChanged || locationChanged) && (slab.status !== 'AVAILABLE' || slab.reservedForCustomId || slab.reservedForOrderId || slab.sampleLoans.length)) throw new Error('Only unallocated available slabs can be moved or written off from inventory')
      if (statusChanged && input.status !== 'DAMAGED') throw new Error('Allocate, sell or release slabs through their fabrication, invoice or sample workflow')
      if (input.godownId && !await tx.godown.findUnique({ where: { id: input.godownId } })) throw new Error('Location not found')
      const next = await tx.slab.update({ where: { id: slab.id }, data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.godownId !== undefined ? { godownId: input.godownId } : {}),
        ...(input.qcGrade !== undefined ? { qcGrade: input.qcGrade } : {}),
        ...(input.photo !== undefined ? { photo: input.photo } : {}),
      } })
      await syncStoneLotTotals(tx, slab.lotId)
      return next
    })
    revalidatePath('/inventory')
    revalidatePath('/custom-orders')
    return { success: true, data: updated }
  } catch (error) { return { success: false, error: inventoryError(error) } }
}

export async function createStoneOffcut(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = stoneOffcutSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const input = parsed.data
  const areaSqft = sqft(input.lengthInches, input.widthInches)
  let offcut
  try {
    offcut = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Slab" WHERE id = ${input.sourceSlabId} FOR UPDATE`
    const source = await tx.slab.findUnique({
      where: { id: input.sourceSlabId },
      select: {
        id: true,
        lotId: true,
        sqft: true,
        lengthInches: true, widthInches: true,
        status: true,
        reservedForCustomId: true,
        photo: true,
        lot: { select: { productId: true, costPerSqft: true, shadeCode: true } },
      },
    })
    if (!source) throw new Error('Source slab not found')
    if (!['IN_PROCESSING', 'SOLD'].includes(source.status)) {
      throw new Error('Only a slab being fabricated or already sold can produce an offcut')
    }
    if (source.reservedForCustomId && input.sourceCustomOrderId !== source.reservedForCustomId) {
      throw new Error('This slab belongs to a fabrication job. Record its offcut from that job so dimensions stay linked.')
    }
    if (input.sourceCustomOrderId) {
      const customOrder = await tx.customOrder.findUnique({ where: { id: input.sourceCustomOrderId }, select: { id: true } })
      if (!customOrder) throw new Error('Fabrication job not found')
    }
    const fits = (input.lengthInches <= source.lengthInches && input.widthInches <= source.widthInches) || (input.widthInches <= source.lengthInches && input.lengthInches <= source.widthInches)
    if (!fits || areaSqft <= 0) throw new Error('Offcut dimensions must fit inside the physical source slab')
    if (areaSqft > source.sqft + 0.01) {
      throw new Error('Offcut dimensions cannot exceed the source slab area')
    }

    const existingOffcuts = await tx.scrapInventory.findMany({
      where: { sourceSlabId: source.id },
      select: { areaSqft: true },
    })
    const recordedArea = existingOffcuts.reduce((sum, entry) => sum + (entry.areaSqft || 0), 0)
    if (recordedArea + areaSqft > source.sqft + 0.01) {
      throw new Error(`This slab has only ${(Math.max(0, source.sqft - recordedArea)).toFixed(2)} sq.ft left for offcuts`)
    }

    const unitCost = source.lot.costPerSqft || 0
    const estimatedValue = input.salePrice ?? Math.round(areaSqft * unitCost)
    return tx.scrapInventory.create({
      data: {
        rawMaterialId: source.lot.productId,
        sourceSlabId: source.id,
        sourceCustomOrderId: input.sourceCustomOrderId,
        lengthInches: input.lengthInches,
        widthInches: input.widthInches,
        areaSqft,
        shadeCode: input.shadeCode || source.lot.shadeCode || null,
        photo: input.photo || source.photo || null,
        salePrice: input.salePrice ?? null,
        quantity: areaSqft,
        unitOfMeasure: 'SQFT',
        unitCost,
        estimatedValue,
        reason: 'Stone fabrication offcut',
        disposition: 'REUSABLE',
        status: 'IN_STOCK',
        notes: input.notes || null,
      },
    })
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not record stone offcut' }
  }
  revalidatePath('/manufacturing')
  return { success: true, data: offcut }
}

export async function pairSlabs(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = bookMatchSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const { slabId, partnerId } = parsed.data
  if (partnerId === slabId) return { success: false, error: 'A slab cannot be paired with itself' }
  try {
    await prisma.$transaction(async tx => {
      const original = await tx.slab.findUnique({ where: { id: slabId }, select: { lotId: true } })
      if (!original) throw new Error('Slab not found')
      // Lock all slabs in stable order, so pairs and previous partners cannot change.
      await tx.$queryRaw`SELECT id FROM "Slab" WHERE "lotId" = ${original.lotId} ORDER BY id FOR UPDATE`
      const slabs = await tx.slab.findMany({ where: { lotId: original.lotId } })
      const slab = slabs.find(row => row.id === slabId)!
      const partner = partnerId ? slabs.find(row => row.id === partnerId) : undefined
      if (partnerId && !partner) throw new Error('Book-match slabs must come from the same lot')
      const affectedIds = [...new Set([slabId, partnerId, slab.bookMatchPairId, partner?.bookMatchPairId].filter((id): id is number => !!id))]
      if (slabs.some(row => affectedIds.includes(row.id) && (row.status !== 'AVAILABLE' || row.reservedForCustomId || row.reservedForOrderId))) throw new Error('All affected book-match slabs must be available and unallocated')
      await tx.slab.updateMany({ where: { id: { in: affectedIds } }, data: { bookMatchPairId: null } })
      if (partnerId) {
        await tx.slab.update({ where: { id: slabId }, data: { bookMatchPairId: partnerId } })
        await tx.slab.update({ where: { id: partnerId }, data: { bookMatchPairId: slabId } })
      }
    })
    revalidatePath('/inventory')
    return { success: true }
  } catch (error) { return { success: false, error: inventoryError(error) } }
}

export async function getSampleLoans() {
  await requireAuth()
  const loans = await prisma.sampleLoan.findMany({
    include: {
      contact: { select: { name: true, phone: true } },
      product: { select: { name: true, sku: true } },
      slab: { select: { slabNumber: true, sqft: true, lot: { select: { lotNumber: true } } } },
    },
    orderBy: { checkoutDate: 'desc' },
  })
  return { success: true, data: loans }
}

export async function createSampleLoan(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER', 'STAFF') } catch { return { success: false, error: 'Access denied' } }
  const parsed = sampleLoanSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const input = parsed.data

  let sampleProductId = input.productId
  if (input.productId) {
    const product = await prisma.product.findUnique({ where: { id: input.productId }, select: { id: true, isSlabTracked: true } })
    if (!product) return { success: false, error: 'Product not found' }
    if (product.isSlabTracked && !input.slabId) return { success: false, error: 'Select a physical slab when issuing a sample for slab-tracked stone' }
  }

  if (input.slabId) {
    const slab = await prisma.slab.findUnique({ where: { id: input.slabId }, select: { status: true, lot: { select: { productId: true } } } })
    if (!slab) return { success: false, error: 'Slab not found' }
    if (input.productId && slab.lot.productId !== input.productId) return { success: false, error: 'Selected slab does not belong to the selected product' }
    if (slab.status !== 'AVAILABLE') return { success: false, error: 'Only available slabs can be issued as samples' }
    sampleProductId = slab.lot.productId
  }
  if (input.expectedReturn && Number.isNaN(new Date(input.expectedReturn).getTime())) return { success: false, error: 'Enter a valid expected return date' }

  let loan
  try {
    loan = await prisma.$transaction(async tx => {
      if (input.slabId) await tx.$queryRaw`SELECT id FROM "Slab" WHERE id = ${input.slabId} FOR UPDATE`
      let contactId = input.contactId
      if (contactId) {
        if (!await tx.contact.findUnique({ where: { id: contactId } })) throw new Error('Customer not found')
      } else {
        const contact = await tx.contact.findFirst({ where: { phone: input.customerPhone } })
        contactId = contact?.id || (await tx.contact.create({ data: { name: input.customerName!, phone: input.customerPhone! } })).id
      }
      const created = await tx.sampleLoan.create({
        data: {
          contactId,
          productId: sampleProductId,
          slabId: input.slabId,
          expectedReturn: input.expectedReturn ? new Date(input.expectedReturn) : null,
          notes: input.notes || null,
        },
      })
      if (input.slabId) {
        const reserved = await tx.slab.updateMany({
          where: { id: input.slabId, status: 'AVAILABLE', reservedForCustomId: null, reservedForOrderId: null },
          data: { status: 'RESERVED' },
        })
        if (reserved.count !== 1) throw new Error('That slab is no longer available for sample issue')
        const slab = await tx.slab.findUnique({ where: { id: input.slabId }, select: { lotId: true } })
        if (slab) await syncStoneLotTotals(tx, slab.lotId)
      }
      return created
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not issue sample' }
  }
  revalidatePath('/inventory')
  return { success: true, data: loan }
}

export async function updateSampleLoanStatus(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER', 'STAFF') } catch { return { success: false, error: 'Access denied' } }
  const parsed = sampleLoanStatusSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  if (parsed.data.status === 'CONVERTED_TO_SALE') {
    return { success: false, error: 'Create the customer invoice first. A sample loan is converted automatically only through the invoice workflow.' }
  }
  try {
    await prisma.$transaction(async tx => {
      const original = await tx.sampleLoan.findUnique({ where: { id: parsed.data.id }, select: { slabId: true } })
      if (!original) throw new Error('Sample loan not found')
      // Invoicing locks the slab before closing its loan; preserve that order.
      if (original.slabId) await tx.$queryRaw`SELECT id FROM "Slab" WHERE id = ${original.slabId} FOR UPDATE`
      const loan = await tx.sampleLoan.findUnique({ where: { id: parsed.data.id }, include: { slab: true } })
      if (!loan || loan.status !== 'OUT') throw new Error('This sample loan has already been closed')
      const closed = await tx.sampleLoan.updateMany({ where: { id: loan.id, status: 'OUT' }, data: { status: parsed.data.status, returnedDate: new Date() } })
      if (closed.count !== 1) throw new Error('This sample loan has already been closed')
      if (loan.slabId) {
        const released = await tx.slab.updateMany({
          where: { id: loan.slabId, status: 'RESERVED', reservedForCustomId: null, reservedForOrderId: null },
          data: { status: parsed.data.status === 'RETURNED' ? 'AVAILABLE' : 'DAMAGED' },
        })
        if (released.count !== 1) throw new Error('This slab was sold or allocated elsewhere. Refresh before closing the loan.')
      }
      if (loan.slab?.lotId) await syncStoneLotTotals(tx, loan.slab.lotId)
    })
    revalidatePath('/inventory')
    return { success: true }
  } catch (error) { return { success: false, error: inventoryError(error) } }
}
