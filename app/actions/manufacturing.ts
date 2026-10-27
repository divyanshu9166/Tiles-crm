'use server'

import { prisma } from '@/lib/db'
import { lockInventoryProducts } from '@/lib/inventory-stock'
import { revalidatePath } from 'next/cache'
import { unstable_noStore } from 'next/cache'
import { requireRole } from '@/lib/auth-helpers'
import { syncStoneLotTotals } from '@/lib/stone-inventory'
import { computeForecast } from '@/lib/erp/forecast'
import { componentRequirement } from '@/lib/erp/mrp'
import { z } from 'zod'
import type { CustomOrderStatus } from '@prisma/client'
import {
  createWorkCenterSchema,
  createBOMSchema,
  createProductionOrderSchema,
  completeProductionSchema,
  qualityCheckSchema,
  addBOMItemSchema,
  updateBOMItemSchema,
  addBOMStepSchema,
  updateBOMStepSchema,
  createBomTemplateSchema,
} from '@/lib/validations/manufacturing'

const roundQty = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000
type ProductionStepTiming = {
  plannedMins?: number | null
  actualMins?: number | null
  labourRatePerHour?: number | null
  startedAt?: Date | null
  completedAt?: Date | null
}
type GodownStockRow = {
  id: number
  godownId: number
  quantity: number
  godown: { id: number; name: string; isDefault: boolean }
}

function getActualStepMins(step: ProductionStepTiming) {
  if ((step.actualMins || 0) > 0) return step.actualMins || 0
  if (step.startedAt && step.completedAt) {
    return Math.max(0, Math.round((step.completedAt.getTime() - step.startedAt.getTime()) / 60000))
  }
  return 0
}

function calculateBomMetrics(bom: {
  items?: Array<{ quantity: number; wastagePercent?: number | null; unitCost?: number | null; rawMaterial?: { costPrice?: number | null } | null }>
  steps?: Array<{ durationMins?: number | null; labourRatePerHour?: number | null; machineCostPerUnit?: number | null }>
}, qty = 1) {
  const materialCost = (bom.items || []).reduce((sum, item) => {
    const unitCost = (item.unitCost || 0) > 0 ? item.unitCost || 0 : item.rawMaterial?.costPrice || 0
    const requiredQty = (item.quantity || 0) * (1 + (item.wastagePercent || 0) / 100) * qty
    return sum + requiredQty * unitCost
  }, 0)

  const standardMins = (bom.steps || []).reduce((sum, step) => sum + (step.durationMins || 0) * qty, 0)
  const labourCost = (bom.steps || []).reduce((sum, step) => {
    return sum + (((step.durationMins || 0) / 60) * (step.labourRatePerHour || 0) * qty)
  }, 0)
  const machineCost = (bom.steps || []).reduce((sum, step) => sum + (step.machineCostPerUnit || 0) * qty, 0)

  return {
    standardMins,
    standardHours: Math.round((standardMins / 60) * 10) / 10,
    standardMaterialCost: Math.round(materialCost),
    standardLabourCost: Math.round(labourCost),
    standardMachineCost: Math.round(machineCost),
    standardTotalCost: Math.round(materialCost + labourCost + machineCost),
  }
}

function decorateBOM<T extends {
  items?: Array<{ quantity: number; wastagePercent?: number | null; unitCost?: number | null; rawMaterial?: { costPrice?: number | null } | null }>
  steps?: Array<{ durationMins?: number | null; labourRatePerHour?: number | null; machineCostPerUnit?: number | null }>
}>(bom: T) {
  return { ...bom, ...calculateBomMetrics(bom, 1) }
}

async function getDefaultGodownWithTx(tx: any) {
  let godown = await tx.godown.findFirst({ where: { isDefault: true } })
  if (!godown) {
    godown = await tx.godown.findFirst({ orderBy: { id: 'asc' } })
    if (godown) {
      godown = await tx.godown.update({ where: { id: godown.id }, data: { isDefault: true } })
    } else {
      godown = await tx.godown.create({ data: { name: 'Main Showroom', type: 'Showroom', isDefault: true } })
    }
  }
  return godown
}

async function adjustManufacturingStockWithTx(tx: any, productId: number, quantity: number, entryType: string, options?: {
  referenceType?: string
  referenceId?: number
  notes?: string
  createdBy?: string
}) {
  await lockInventoryProducts(tx, [productId])
  const qty = roundQty(quantity)
  if (qty === 0) return

  const godownCount = await tx.godown.count()
  if (godownCount > 0) {
    const defaultGodown = await getDefaultGodownWithTx(tx)

    if (qty > 0) {
      const existing = await tx.godownStock.findUnique({
        where: { productId_godownId: { productId, godownId: defaultGodown.id } },
      })
      const currentQty = existing?.quantity || 0
      const newQty = roundQty(currentQty + qty)

      await tx.godownStock.upsert({
        where: { productId_godownId: { productId, godownId: defaultGodown.id } },
        create: { productId, godownId: defaultGodown.id, quantity: newQty },
        update: { quantity: newQty },
      })
      await tx.stockLedger.create({
        data: {
          productId,
          godownId: defaultGodown.id,
          entryType,
          quantity: qty,
          balanceAfter: newQty,
          referenceType: options?.referenceType,
          referenceId: options?.referenceId,
          notes: options?.notes,
          createdBy: options?.createdBy,
        },
      })
      const total = await tx.godownStock.aggregate({ where: { productId }, _sum: { quantity: true } })
      await tx.product.update({ where: { id: productId }, data: { stock: total._sum.quantity || 0 } })
      return
    }

    let remainingToIssue = Math.abs(qty)
    const stockRows = await tx.godownStock.findMany({
      where: { productId, quantity: { gt: 0 } },
      include: { godown: { select: { id: true, name: true, isDefault: true } } },
      orderBy: { quantity: 'desc' },
    }) as GodownStockRow[]
    stockRows.sort((a, b) => Number(b.godown.isDefault) - Number(a.godown.isDefault))

    const totalAvailable = stockRows.reduce((sum, row) => sum + row.quantity, 0)
    if (totalAvailable + 0.0001 < remainingToIssue) throw new Error('Insufficient raw material stock')

    for (const row of stockRows) {
      if (remainingToIssue <= 0) break
      const issuedQty = roundQty(Math.min(row.quantity, remainingToIssue))
      const newQty = roundQty(row.quantity - issuedQty)
      await tx.godownStock.update({ where: { id: row.id }, data: { quantity: newQty } })
      await tx.stockLedger.create({
        data: {
          productId,
          godownId: row.godownId,
          entryType,
          quantity: -issuedQty,
          balanceAfter: newQty,
          referenceType: options?.referenceType,
          referenceId: options?.referenceId,
          notes: options?.notes,
          createdBy: options?.createdBy,
        },
      })
      remainingToIssue = roundQty(remainingToIssue - issuedQty)
    }

    const total = await tx.godownStock.aggregate({ where: { productId }, _sum: { quantity: true } })
    await tx.product.update({ where: { id: productId }, data: { stock: total._sum.quantity || 0 } })
    return
  }

  if (qty < 0) {
    const product = await tx.product.findUnique({ where: { id: productId }, select: { stock: true, name: true } })
    if (!product) throw new Error('Product not found')
    if ((product.stock || 0) + qty < 0) throw new Error(`Insufficient stock for ${product.name}`)
  }
  await tx.product.update({
    where: { id: productId },
    data: { stock: { increment: qty } },
  })
}

async function releaseCustomOrderSlabsWithTx(tx: any, customOrderId: number) {
  const slabs = await tx.slab.findMany({
    where: { reservedForCustomId: customOrderId, status: { in: ['RESERVED', 'IN_PROCESSING'] } },
    select: { id: true, lotId: true },
  })
  if (slabs.length === 0) return

  await tx.slab.updateMany({
    where: { reservedForCustomId: customOrderId, status: { in: ['RESERVED', 'IN_PROCESSING'] } },
    data: { status: 'AVAILABLE', reservedForCustomId: null },
  })
  for (const lotId of new Set<number>(slabs.map((slab: { lotId: number }) => slab.lotId))) {
    await syncStoneLotTotals(tx, lotId)
  }
}

async function resetCustomOrderAfterProductionChange(tx: any, customOrderId: number, event: string) {
  const remainingProduction = await tx.productionOrder.count({
    where: { customOrderId, status: { not: 'CANCELLED' } },
  })
  if (remainingProduction > 0) return

  await tx.customOrder.update({
    where: { id: customOrderId },
    data: { status: 'MEASUREMENT_SCHEDULED' },
  })
  await tx.customOrderTimeline.create({
    data: {
      customOrderId,
      date: new Date(),
      event,
      status: 'pending',
      updatedBy: 'Manager',
    },
  })
}

async function updateProductionTimeVarianceWithTx(tx: any, productionOrderId: number) {
  const order = await tx.productionOrder.findUnique({
    where: { id: productionOrderId },
    include: { productionSteps: true },
  })
  if (!order) return

  const steps = order.productionSteps as ProductionStepTiming[]
  const standardMins = order.standardMins || steps.reduce((sum, s) => sum + (s.plannedMins || 0), 0)
  const actualMins = steps.reduce((sum, s) => sum + getActualStepMins(s), 0)
  const labourVarianceMins = actualMins > 0 ? actualMins - standardMins : 0
  const labourVarianceCost = steps.reduce((sum, s) => {
    const extraMins = Math.max(0, getActualStepMins(s) - (s.plannedMins || 0))
    return sum + (extraMins / 60) * (s.labourRatePerHour || 0)
  }, 0)

  await tx.productionOrder.update({
    where: { id: productionOrderId },
    data: {
      standardMins,
      actualMins,
      labourVarianceMins,
      labourVarianceCost: Math.round(labourVarianceCost),
    },
  })
}

// ─── WORK CENTERS ────────────────────────────────────

export async function getWorkCenters() {
  const centers = await prisma.workCenter.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { productionOrders: true } },
    },
  })
  return { success: true, data: centers }
}

export async function createWorkCenter(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createWorkCenterSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const existing = await prisma.workCenter.findFirst({ where: { name: parsed.data.name } })
  if (existing) return { success: false, error: 'Work center with this name already exists' }

  const center = await prisma.workCenter.create({ data: parsed.data })
  revalidatePath('/manufacturing')
  return { success: true, data: center }
}

export async function updateWorkCenterStatus(id: number, status: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  await prisma.workCenter.update({ where: { id }, data: { status } })
  revalidatePath('/manufacturing')
  return { success: true }
}

export async function deleteWorkCenter(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const center = await prisma.workCenter.findUnique({ where: { id }, include: { _count: { select: { productionOrders: true } } } })
  if (!center) return { success: false, error: 'Not found' }
  if (center._count.productionOrders > 0) return { success: false, error: 'Cannot delete: work center has production orders' }
  await prisma.workCenter.delete({ where: { id } })
  revalidatePath('/manufacturing')
  return { success: true }
}

// ─── BILL OF MATERIALS ───────────────────────────────

export async function getBOMs() {
  const boms = await prisma.billOfMaterials.findMany({
    orderBy: { name: 'asc' },
    include: {
      finishedProduct: { select: { name: true, sku: true, price: true, costPrice: true } },
      items: {
        include: { rawMaterial: { select: { name: true, sku: true, stock: true, unitOfMeasure: true, costPrice: true } } },
      },
      steps: {
        include: { workCenter: { select: { name: true, type: true } } },
        orderBy: { stepNumber: 'asc' },
      },
      _count: { select: { productionOrders: true } },
    },
  })
  return { success: true, data: boms.map(decorateBOM) }
}

export async function createBOM(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createBOMSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { name, finishedProductId, version, estimatedDays, notes, items, steps } = parsed.data

  const bom = await prisma.billOfMaterials.create({
    data: {
      name,
      finishedProductId,
      version,
      estimatedDays,
      notes,
      items: {
        create: items.map(i => ({
          rawMaterialId: i.rawMaterialId,
          quantity: i.quantity,
          unitOfMeasure: i.unitOfMeasure,
          wastagePercent: i.wastagePercent,
          unitCost: i.unitCost ?? 0,
          notes: i.notes,
        })),
      },
      steps: steps ? {
        create: steps.map(s => ({
          stepNumber: s.stepNumber,
          operationName: s.operationName,
          workCenterId: s.workCenterId,
          durationMins: s.durationMins,
          labourRatePerHour: s.labourRatePerHour ?? 0,
          machineCostPerUnit: s.machineCostPerUnit ?? 0,
          notes: s.notes,
        })),
      } : undefined,
    },
    include: { items: true, steps: true },
  })
  revalidatePath('/manufacturing')
  return { success: true, data: bom }
}

export async function toggleBOMStatus(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const bom = await prisma.billOfMaterials.findUnique({ where: { id } })
  if (!bom) return { success: false, error: 'BOM not found' }
  await prisma.billOfMaterials.update({ where: { id }, data: { isActive: !bom.isActive } })
  revalidatePath('/manufacturing')
  return { success: true }
}

export async function deleteBOM(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const bom = await prisma.billOfMaterials.findUnique({ where: { id }, include: { _count: { select: { productionOrders: true } } } })
  if (!bom) return { success: false, error: 'Not found' }
  if (bom._count.productionOrders > 0) return { success: false, error: 'Cannot delete BOM with existing production orders' }
  await prisma.billOfMaterials.delete({ where: { id } })
  revalidatePath('/manufacturing')
  return { success: true }
}

// ─── BOM ITEM MANAGEMENT ─────────────────────────────

export async function addBOMItem(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = addBOMItemSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { bomId, rawMaterialId, quantity, unitOfMeasure, wastagePercent, unitCost, notes } = parsed.data
  const item = await prisma.bomItem.create({
    data: { bomId, rawMaterialId, quantity, unitOfMeasure, wastagePercent, unitCost: unitCost ?? 0, notes },
    include: { rawMaterial: { select: { name: true, sku: true, stock: true, unitOfMeasure: true, costPrice: true } } },
  })
  revalidatePath('/manufacturing')
  return { success: true, data: item }
}

export async function updateBOMItem(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = updateBOMItemSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { id, ...updateData } = parsed.data
  const item = await prisma.bomItem.update({ where: { id }, data: updateData })
  revalidatePath('/manufacturing')
  return { success: true, data: item }
}

export async function removeBOMItem(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  await prisma.bomItem.delete({ where: { id } })
  revalidatePath('/manufacturing')
  return { success: true }
}

// ─── BOM STEP MANAGEMENT ─────────────────────────────

export async function addBOMStep(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = addBOMStepSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  // Find the max step number for this BOM
  const maxStep = await prisma.bomStep.findFirst({
    where: { bomId: parsed.data.bomId },
    orderBy: { stepNumber: 'desc' },
    select: { stepNumber: true },
  })
  const stepNumber = (maxStep?.stepNumber ?? 0) + 1

  const step = await prisma.bomStep.create({
    data: { ...parsed.data, stepNumber },
    include: { workCenter: { select: { name: true, type: true } } },
  })
  revalidatePath('/manufacturing')
  return { success: true, data: step }
}

export async function updateBOMStep(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = updateBOMStepSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { id, ...updateData } = parsed.data
  const step = await prisma.bomStep.update({
    where: { id },
    data: updateData,
    include: { workCenter: { select: { name: true, type: true } } },
  })
  revalidatePath('/manufacturing')
  return { success: true, data: step }
}

export async function removeBOMStep(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const step = await prisma.bomStep.findUnique({ where: { id }, select: { bomId: true } })
  if (!step) return { success: false, error: 'Step not found' }
  await prisma.bomStep.delete({ where: { id } })
  // Re-number remaining steps
  const remaining = await prisma.bomStep.findMany({ where: { bomId: step.bomId }, orderBy: { stepNumber: 'asc' } })
  for (let i = 0; i < remaining.length; i++) {
    await prisma.bomStep.update({ where: { id: remaining[i].id }, data: { stepNumber: i + 1 } })
  }
  revalidatePath('/manufacturing')
  return { success: true }
}

// ─── BOM EXPORT ──────────────────────────────────────

export async function exportBOM(id: number) {
  const bom = await prisma.billOfMaterials.findUnique({
    where: { id },
    include: {
      finishedProduct: { select: { name: true, sku: true, price: true } },
      items: {
        include: { rawMaterial: { select: { name: true, sku: true, unitOfMeasure: true, costPrice: true } } },
      },
      steps: {
        include: { workCenter: { select: { name: true } } },
        orderBy: { stepNumber: 'asc' },
      },
    },
  })
  if (!bom) return { success: false, error: 'BOM not found' }

  return { success: true, data: decorateBOM(bom) }
}

// ─── BOM TEMPLATES ───────────────────────────────────

export async function getBomTemplates() {
  const templates = await prisma.bomTemplate.findMany({ orderBy: { name: 'asc' } })
  return { success: true, data: templates }
}

export async function createBomTemplate(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createBomTemplateSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const existing = await prisma.bomTemplate.findFirst({ where: { name: parsed.data.name } })
  if (existing) return { success: false, error: 'Template with this name already exists' }

  const template = await prisma.bomTemplate.create({ data: parsed.data })
  revalidatePath('/manufacturing')
  return { success: true, data: template }
}

export async function deleteBomTemplate(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  await prisma.bomTemplate.delete({ where: { id } })
  revalidatePath('/manufacturing')
  return { success: true }
}

// ─── MRP ANALYSIS ────────────────────────────────────

export async function getMRPAnalysis(bomId: number, qty: number) {
  const bom = await prisma.billOfMaterials.findUnique({
    where: { id: bomId },
    include: {
      items: {
        include: { rawMaterial: { select: { id: true, name: true, sku: true, stock: true, unitOfMeasure: true, costPrice: true } } },
      },
      steps: {
        include: { workCenter: { select: { name: true } } },
        orderBy: { stepNumber: 'asc' },
      },
      finishedProduct: { select: { name: true, price: true, costPrice: true } },
    },
  })
  if (!bom) return { success: false, error: 'BOM not found' }

  // Odoo MRP: plan against forecasted availability — on hand minus what open
  // deliveries and other production orders already reserved, plus incoming.
  const forecast = await computeForecast(prisma, { productIds: bom.items.map(item => item.rawMaterialId) })
  const requirements = bom.items.map(item => {
    const effectiveUnitCost = item.unitCost > 0 ? item.unitCost : item.rawMaterial.costPrice
    const required = componentRequirement(item.quantity, qty, item.wastagePercent)
    const row = forecast.get(item.rawMaterialId)
    const onHand = row?.onHand ?? item.rawMaterial.stock
    const reserved = row?.reserved ?? 0
    const incoming = row?.incoming ?? 0
    const available = Math.round((onHand - reserved) * 100) / 100
    const shortage = Math.max(0, required - Math.max(0, available))
    const shortageAfterIncoming = Math.max(0, required - Math.max(0, available + incoming))
    return {
      materialId: item.rawMaterialId,
      materialName: item.rawMaterial.name,
      sku: item.rawMaterial.sku,
      unitOfMeasure: item.unitOfMeasure || item.rawMaterial.unitOfMeasure,
      required: Math.ceil(required * 100) / 100,
      onHand,
      reserved: Math.round(reserved * 100) / 100,
      incoming,
      available,
      shortage: Math.ceil(shortage * 100) / 100,
      shortageAfterIncoming: Math.ceil(shortageAfterIncoming * 100) / 100,
      canProduce: shortage === 0,
      unitCost: effectiveUnitCost,
      estimatedCost: Math.round(required * effectiveUnitCost),
    }
  })

  // Labour cost from steps: sum of (durationMins/60 * labourRatePerHour) per unit * qty
  const stepCostings = bom.steps.map(s => {
    const labourCostPerUnit = (s.durationMins / 60) * s.labourRatePerHour
    const machineCostPerUnit = s.machineCostPerUnit
    return {
      stepNumber: s.stepNumber,
      operationName: s.operationName,
      workCenter: s.workCenter?.name ?? '—',
      durationMins: s.durationMins,
      labourRatePerHour: s.labourRatePerHour,
      machineCostPerUnit,
      labourCostPerUnit,
      totalLabourCost: Math.round(labourCostPerUnit * qty),
      totalMachineCost: Math.round(machineCostPerUnit * qty),
    }
  })

  const canProduceAll = requirements.every(r => r.canProduce)
  const totalMaterialCost = requirements.reduce((s, r) => s + r.estimatedCost, 0)
  const totalLabourCost = stepCostings.reduce((s, c) => s + c.totalLabourCost, 0)
  const totalMachineCost = stepCostings.reduce((s, c) => s + c.totalMachineCost, 0)
  const totalManufacturingCost = totalMaterialCost + totalLabourCost + totalMachineCost
  const totalStandardMins = bom.steps.reduce((s, step) => s + step.durationMins * qty, 0)
  const sellingPrice = (bom.finishedProduct.price || 0) * qty
  const estimatedProfit = sellingPrice - totalManufacturingCost

  return {
    success: true,
    data: {
      bomName: bom.name,
      finishedProduct: bom.finishedProduct.name,
      qty,
      requirements,
      stepCostings,
      canProduceAll,
      shortages: requirements.filter(r => !r.canProduce),
      totalMaterialCost,
      totalLabourCost,
      totalMachineCost,
      totalManufacturingCost,
      totalStandardMins,
      totalStandardHours: Math.round((totalStandardMins / 60) * 10) / 10,
      sellingPrice,
      estimatedProfit,
      estimatedMargin: sellingPrice > 0 ? Math.round((estimatedProfit / sellingPrice) * 100) : 0,
    },
  }
}

// ─── PRODUCTION ORDERS ───────────────────────────────

const PRIORITY_SORT: Record<string, number> = { URGENT: 1, HIGH: 2, MEDIUM: 3, LOW: 4 }

export async function getProductionOrders() {
  unstable_noStore()
  const orders = await prisma.productionOrder.findMany({
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    include: {
      bom: {
        select: {
          name: true,
          version: true,
          steps: { select: { stepNumber: true, durationMins: true, labourRatePerHour: true, machineCostPerUnit: true } },
        },
      },
      finishedProduct: { select: { name: true, sku: true, price: true } },
      customOrder: {
        select: {
          id: true,
          displayId: true,
          type: true,
          contact: { select: { name: true } },
          slabAllocations: {
            select: {
              id: true,
              slabNumber: true,
              sqft: true,
              status: true,
              photo: true,
              lot: { select: { lotNumber: true, shadeCode: true, product: { select: { name: true } } } },
            },
          },
        },
      },
      workCenter: { select: { name: true, type: true } },
      assignedStaff: { select: { name: true } },
      consumptions: {
        include: { rawMaterial: { select: { name: true, sku: true, unitOfMeasure: true } } },
      },
      scrapEntries: {
        include: { rawMaterial: { select: { name: true, sku: true, unitOfMeasure: true } } },
        orderBy: { createdAt: 'desc' },
      },
      customInventoryItems: true,
      productionSteps: {
        include: { workCenter: { select: { name: true } } },
        orderBy: { stepNumber: 'asc' },
      },
    },
  })
  return {
    success: true,
    data: orders
      .map(order => {
        const standardMins = order.standardMins || order.productionSteps.reduce((sum, step) => sum + (step.plannedMins || 0), 0)
        const actualMins = order.actualMins || order.productionSteps.reduce((sum, step) => sum + getActualStepMins(step), 0)
        const labourVarianceMins = actualMins > 0 ? actualMins - standardMins : order.labourVarianceMins
        return { ...order, standardMins, actualMins, labourVarianceMins }
      })
      // Sort: URGENT → HIGH → MEDIUM → LOW, then by due date
      .sort((a, b) => {
        const pa = PRIORITY_SORT[a.priority] ?? 9
        const pb = PRIORITY_SORT[b.priority] ?? 9
        if (pa !== pb) return pa - pb
        if (a.dueDate && b.dueDate) return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
        return 0
      }),
  }
}

export async function getAssignableStaff() {
  const staff = await prisma.staff.findMany({
    where: { status: 'Active' },
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
  })
  return { success: true, data: staff }
}

export async function getManufacturingCustomOrders() {
  const orders = await prisma.customOrder.findMany({
    where: { status: { not: 'DELIVERED' } },
    select: {
      id: true,
      displayId: true,
      type: true,
      status: true,
      quotedPrice: true,
      contact: { select: { name: true } },
    },
    orderBy: { date: 'desc' },
  })
  return {
    success: true,
    data: orders.map(o => ({
      id: o.id,
      displayId: o.displayId,
      type: o.type,
      status: o.status,
      customerName: o.contact.name,
      quotedPrice: o.quotedPrice,
    })),
  }
}

export async function getScrapInventory() {
  const entries = await prisma.scrapInventory.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      rawMaterial: { select: { name: true, sku: true, unitOfMeasure: true } },
      productionOrder: { select: { displayId: true, finishedProduct: { select: { name: true } } } },
      sourceSlab: { select: { slabNumber: true, sqft: true, lot: { select: { lotNumber: true, shadeCode: true } } } },
      sourceCustomOrder: { select: { displayId: true } },
    },
  })
  return { success: true, data: entries }
}

const scrapStatusSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(['USED', 'DISPOSED']),
  notes: z.string().trim().optional(),
})

export async function updateScrapInventoryStatus(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = scrapStatusSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const entry = await prisma.scrapInventory.findUnique({ where: { id: parsed.data.id }, select: { id: true, status: true, quantity: true } })
  if (!entry) return { success: false, error: 'Offcut entry not found' }
  if (entry.status !== 'IN_STOCK') return { success: false, error: 'Only reusable offcuts in stock can be closed' }
  if (entry.quantity <= 0) return { success: false, error: 'This offcut has no remaining quantity' }

  const updated = await prisma.scrapInventory.update({
    where: { id: entry.id },
    data: { status: parsed.data.status, notes: parsed.data.notes || undefined },
  })
  revalidatePath('/manufacturing')
  return { success: true, data: updated }
}

export async function getCustomOrderInventory() {
  const entries = await prisma.customOrderInventory.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      customOrder: { select: { displayId: true, type: true, contact: { select: { name: true } } } },
      product: { select: { name: true, sku: true } },
      productionOrder: { select: { displayId: true } },
    },
  })
  return { success: true, data: entries }
}

export async function createProductionOrder(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = createProductionOrderSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { bomId, customOrderId, plannedQty, priority, dueDate, startDate, workCenterId, assignedStaffId, assignedTo, notes } = parsed.data

  const bom = await prisma.billOfMaterials.findUnique({
    where: { id: bomId },
    include: {
      items: { include: { rawMaterial: { select: { costPrice: true } } } },
      steps: { orderBy: { stepNumber: 'asc' } },
    },
  })
  if (!bom) return { success: false, error: 'BOM not found' }
  if (!bom.isActive) return { success: false, error: 'This BOM is inactive' }

  let customOrder: { id: number; displayId: string; status: CustomOrderStatus } | null = null
  if (customOrderId) {
    customOrder = await prisma.customOrder.findUnique({
      where: { id: customOrderId },
      select: { id: true, displayId: true, status: true },
    })
    if (!customOrder) return { success: false, error: 'Custom order not found' }
    if (customOrder.status === 'DELIVERED') return { success: false, error: 'Cannot create production for a delivered custom order' }
    const existingProduction = await prisma.productionOrder.count({
      where: { customOrderId, status: { not: 'CANCELLED' } },
    })
    if (existingProduction > 0) return { success: false, error: 'This fabrication job already has an active production order' }
  }

  if (workCenterId) {
    const workCenter = await prisma.workCenter.findUnique({ where: { id: workCenterId }, select: { status: true } })
    if (!workCenter) return { success: false, error: 'Selected work center was not found' }
    if (workCenter.status !== 'Active') return { success: false, error: 'Select an active work center' }
  }

  let assigneeName = assignedTo?.trim() || null
  if (assignedStaffId) {
    const staff = await prisma.staff.findUnique({
      where: { id: assignedStaffId },
      select: { name: true, status: true },
    })
    if (!staff) return { success: false, error: 'Selected staff member was not found' }
    if (staff.status !== 'Active') return { success: false, error: 'Selected staff member is not active' }
    assigneeName = staff.name
  }

  const lastOrder = await prisma.productionOrder.findFirst({
    where: { displayId: { startsWith: 'PRD-' } },
    orderBy: { id: 'desc' },
    select: { displayId: true },
  })
  let nextNum = 1
  if (lastOrder?.displayId) {
    const m = lastOrder.displayId.match(/PRD-(\d+)/)
    if (m) nextNum = parseInt(m[1]) + 1
  }
  const displayId = `PRD-${String(nextNum).padStart(4, '0')}`
  const standardMins = bom.steps.reduce((sum, step) => sum + step.durationMins * plannedQty, 0)

  const baseCreateData = {
    displayId,
    bomId,
    finishedProductId: bom.finishedProductId,
    customOrderId: customOrderId || null,
    workCenterId: workCenterId || null,
    plannedQty,
    standardMins,
    priority,
    dueDate: dueDate ? new Date(dueDate) : null,
    startDate: startDate ? new Date(startDate) : null,
    assignedTo: assigneeName,
    notes,
    consumptions: {
      create: bom.items.map(i => {
        const effectiveUnitCost = i.unitCost > 0 ? i.unitCost : i.rawMaterial.costPrice
        return {
          rawMaterialId: i.rawMaterialId,
          plannedQty: i.quantity * plannedQty * (1 + i.wastagePercent / 100),
          unitCost: effectiveUnitCost,
          totalCost: Math.round(i.quantity * plannedQty * (1 + i.wastagePercent / 100) * effectiveUnitCost),
        }
      }),
    },
    productionSteps: bom.steps.length > 0 ? {
      create: bom.steps.map(s => ({
        stepNumber: s.stepNumber,
        operationName: s.operationName,
        workCenterId: s.workCenterId || null,
        plannedMins: s.durationMins * plannedQty,
        labourRatePerHour: s.labourRatePerHour || 0,
        machineCostPerUnit: s.machineCostPerUnit || 0,
        status: 'PENDING',
      })),
    } : undefined,
  }

  let order
  let createdWithoutAssignedStaffField = false
  try {
    order = await prisma.productionOrder.create({
      data: {
        ...baseCreateData,
        assignedStaffId: assignedStaffId || null,
      },
    })
  } catch (error) {
    const staleClientMissingField =
      assignedStaffId &&
      error instanceof Error &&
      error.message.includes('Unknown argument `assignedStaffId`')

    if (!staleClientMissingField) throw error

    // Fallback for stale Prisma client cache: create without relation field, then update via SQL.
    order = await prisma.productionOrder.create({ data: baseCreateData })
    createdWithoutAssignedStaffField = true
  }

  if (assignedStaffId && createdWithoutAssignedStaffField) {
    try {
      await prisma.$executeRaw`
        UPDATE "ProductionOrder"
        SET "assignedStaffId" = ${assignedStaffId}
        WHERE "id" = ${order.id}
      `
    } catch {
      // Keep order creation successful even if relation update fails in stale environments.
    }
  }
  if (customOrderId) {
    await prisma.$transaction([
      prisma.customOrder.update({ where: { id: customOrderId }, data: { status: 'IN_PRODUCTION' } }),
      prisma.customOrderTimeline.create({
        data: {
          customOrderId,
          date: new Date(),
          event: `Production order ${displayId} created`,
          status: 'done',
          updatedBy: 'Manager',
        },
      }),
    ])
  }
  revalidatePath('/manufacturing')
  revalidatePath('/custom-orders')
  return { success: true, data: order }
}

export async function startProduction(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const order = await prisma.productionOrder.findUnique({ where: { id }, select: { status: true, customOrderId: true } })
  if (!order) return { success: false, error: 'Production order not found' }
  if (!['PLANNED', 'ON_HOLD'].includes(order.status)) return { success: false, error: 'Only planned or held production can be started' }
  await prisma.$transaction(async tx => {
    await tx.productionOrder.update({
      where: { id },
      data: { status: 'IN_PROGRESS', startDate: new Date() },
    })
    if (order.customOrderId) {
      const slabs = await tx.slab.findMany({
        where: { reservedForCustomId: order.customOrderId, status: 'RESERVED' },
        select: { id: true, lotId: true },
      })
      await tx.slab.updateMany({
        where: { reservedForCustomId: order.customOrderId, status: 'RESERVED' },
        data: { status: 'IN_PROCESSING' },
      })
      for (const lotId of new Set<number>(slabs.map((slab: { lotId: number }) => slab.lotId))) {
        await syncStoneLotTotals(tx, lotId)
      }
    }
  })
  revalidatePath('/manufacturing')
  revalidatePath('/inventory')
  revalidatePath('/custom-orders')
  return { success: true }
}

export async function holdProduction(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const order = await prisma.productionOrder.findUnique({ where: { id }, select: { status: true } })
  if (!order) return { success: false, error: 'Production order not found' }
  if (order.status !== 'IN_PROGRESS') return { success: false, error: 'Only in-progress production can be put on hold' }
  await prisma.productionOrder.update({ where: { id }, data: { status: 'ON_HOLD' } })
  revalidatePath('/manufacturing')
  return { success: true }
}

export async function cancelProductionOrder(id: number, reason: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const order = await prisma.productionOrder.findUnique({
    where: { id },
    include: {
      customOrder: { select: { displayId: true } },
      consumptions: {
        select: { rawMaterialId: true, issuedQty: true, rawMaterial: { select: { name: true } } },
      },
    },
  })
  if (!order) return { success: false, error: 'Order not found' }
  if (order.status === 'COMPLETED') return { success: false, error: 'Cannot cancel a completed order' }
  if (order.status === 'CANCELLED') return { success: true }
  if (!reason?.trim()) return { success: false, error: 'Enter a cancellation reason' }

  await prisma.$transaction(async (tx) => {
    // This workflow issues and consumes material at completion time. The
    // issuedQty field is an audit/planning value, not a prior stock movement,
    // so cancellation must not add it back to inventory.
    await tx.productionOrder.update({
      where: { id },
      data: { status: 'CANCELLED', cancelReason: reason, cancelledDate: new Date() },
    })
    if (order.customOrderId) {
      await releaseCustomOrderSlabsWithTx(tx, order.customOrderId)
      await resetCustomOrderAfterProductionChange(tx, order.customOrderId, `Production ${order.displayId} cancelled`)
    }
  })

  revalidatePath('/manufacturing')
  revalidatePath('/inventory')
  revalidatePath('/custom-orders')
  return { success: true }
}

export async function deleteProductionOrder(id: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const order = await prisma.productionOrder.findUnique({ where: { id } })
  if (!order) return { success: false, error: 'Order not found' }
  if (order.status === 'COMPLETED') return { success: false, error: 'Cannot delete a completed production order' }
  if (!['PLANNED', 'CANCELLED'].includes(order.status)) return { success: false, error: 'Only planned or cancelled production orders can be deleted' }

  await prisma.$transaction(async tx => {
    await tx.productionOrder.delete({ where: { id } })
    if (order.customOrderId) {
      await releaseCustomOrderSlabsWithTx(tx, order.customOrderId)
      await resetCustomOrderAfterProductionChange(tx, order.customOrderId, `Production ${order.displayId} removed`)
    }
  })
  revalidatePath('/manufacturing')
  revalidatePath('/inventory')
  revalidatePath('/custom-orders')
  return { success: true }
}

export async function updateProductionStep(stepId: number, status: string, actualMins?: number, assignedWorker?: string) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  if (!['PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED'].includes(status)) return { success: false, error: 'Invalid production step status' }
  if (actualMins !== undefined && (!Number.isFinite(actualMins) || actualMins < 0)) return { success: false, error: 'Actual minutes cannot be negative' }
  await prisma.$transaction(async (tx) => {
    const current = await tx.productionStep.findUnique({ where: { id: stepId }, include: { productionOrder: { select: { status: true } } } })
    if (!current) throw new Error('Step not found')
    if (!['IN_PROGRESS', 'ON_HOLD'].includes(current.productionOrder.status)) throw new Error('Steps can only be updated while production is active or on hold')
    if (current.status === 'DONE' && status !== 'DONE') throw new Error('A completed production step cannot be reopened')
    const completedAt = status === 'DONE' ? new Date() : undefined
    const computedActualMins = actualMins ?? (
      status === 'DONE' && current.startedAt
        ? Math.max(0, Math.round(((completedAt as Date).getTime() - current.startedAt.getTime()) / 60000))
        : undefined
    )
    await tx.productionStep.update({
      where: { id: stepId },
      data: {
        status,
        actualMins: computedActualMins,
        assignedWorker: assignedWorker ?? undefined,
        startedAt: status === 'IN_PROGRESS' ? new Date() : undefined,
        completedAt,
      },
    })
    await updateProductionTimeVarianceWithTx(tx, current.productionOrderId)
  })
  revalidatePath('/manufacturing')
  return { success: true }
}

export async function completeProduction(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = completeProductionSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const {
    productionOrderId,
    actualQty,
    totalLabourCost,
    overheadCost,
    machineCost,
    scrapQty,
    scrapReason,
    qualityStatus,
    qualityNotes,
    notes,
    stoneOffcuts,
    consumptions,
    stepActuals,
  } = parsed.data

  const order = await prisma.productionOrder.findUnique({
    where: { id: productionOrderId },
    include: { consumptions: { include: { rawMaterial: { select: { unitOfMeasure: true } } } }, productionSteps: true },
  })
  if (!order) return { success: false, error: 'Production order not found' }
  if (order.status !== 'IN_PROGRESS' && order.status !== 'ON_HOLD') {
    return { success: false, error: 'Order must be IN_PROGRESS or ON_HOLD to complete' }
  }
  const expectedMaterialIds = order.consumptions.map(material => material.rawMaterialId)
  const submittedMaterialIds = consumptions.map(material => material.rawMaterialId)
  if (
    expectedMaterialIds.length !== submittedMaterialIds.length ||
    expectedMaterialIds.some(materialId => !submittedMaterialIds.includes(materialId))
  ) {
    return { success: false, error: 'Submit actual consumption for every planned material before completing production' }
  }
  if (stepActuals?.some(step => !order.productionSteps.some(existing => existing.id === step.stepId))) {
    return { success: false, error: 'One or more production steps do not belong to this order' }
  }

  await prisma.$transaction(async (tx) => {
    let totalMaterialCost = 0

    for (const c of consumptions) {
      const planned = order.consumptions.find(oc => oc.rawMaterialId === c.rawMaterialId)
      const materialScrapQty = c.scrapQty || 0
      const issuedQty = roundQty(c.issuedQty || 0)  // Use issued instead of planned
      const actualQtyRounded = roundQty(c.actualQty || 0)
      const totalConsumedAndScrap = roundQty(actualQtyRounded + materialScrapQty)
      
      // Calculate returned: issued - actual - scrap
      const returnedQty = Math.max(0, roundQty(issuedQty - totalConsumedAndScrap))
      
      // Detect over-consumption: if actual + scrap > issued
      const isOverConsumed = totalConsumedAndScrap > issuedQty
      
      // Stock deduction is based on physical material consumed plus scrap.
      // issuedQty is retained for variance reporting and is not deducted twice.
      const consumedFromStock = totalConsumedAndScrap
      
      // Cost calculation based on actual consumption + scrap
      const cost = planned ? Math.round(totalConsumedAndScrap * planned.unitCost) : 0
      totalMaterialCost += cost

      await adjustManufacturingStockWithTx(tx, c.rawMaterialId, -consumedFromStock, 'PRODUCTION', {
        referenceType: 'Production',
        referenceId: productionOrderId,
        notes: `Consumed for production ${order.displayId}`,
        createdBy: 'Manufacturing',
      })
      if (planned) {
        await tx.materialConsumption.update({
          where: { id: planned.id },
          data: {
            issuedQty,
            actualQty: actualQtyRounded,
            scrapQty: materialScrapQty,
            returnedQty,
            isOverConsumed,
            scrapReason: c.scrapReason,
            totalCost: cost,
          },
        })
        if (materialScrapQty > 0) {
          await tx.scrapInventory.create({
            data: {
              productionOrderId,
              rawMaterialId: c.rawMaterialId,
              materialConsumptionId: planned.id,
              quantity: materialScrapQty,
              unitOfMeasure: planned.rawMaterial?.unitOfMeasure || 'PCS',
              unitCost: planned.unitCost,
              estimatedValue: Math.round(materialScrapQty * planned.unitCost),
              reason: c.scrapReason || scrapReason,
              disposition: 'REUSABLE',
              status: 'IN_STOCK',
              notes: `Recorded from ${order.displayId}`,
            },
          })
        }
      }
    }

    // Capture reusable natural-stone remnants while the fabrication job still
    // owns its allocated slabs. The source lot, shade, slab photo and cost are
    // copied into resale-ready inventory for full traceability.
    if (stoneOffcuts?.length) {
      if (!order.customOrderId) throw new Error('Stone offcuts can only be recorded for a fabrication job')
      const sourceSlabIds = stoneOffcuts.map(offcut => offcut.sourceSlabId)
      if (new Set(sourceSlabIds).size !== sourceSlabIds.length) throw new Error('A source slab can only be listed once per completion')
      const sourceSlabs = await tx.slab.findMany({
        where: { id: { in: sourceSlabIds }, reservedForCustomId: order.customOrderId },
        include: { lot: { select: { productId: true, costPerSqft: true, shadeCode: true } } },
      })
      if (sourceSlabs.length !== sourceSlabIds.length) {
        throw new Error('Every offcut must use a slab allocated to this fabrication job')
      }
      const sourceById = new Map(sourceSlabs.map(slab => [slab.id, slab]))
      const existingOffcuts = await tx.scrapInventory.findMany({
        where: { sourceSlabId: { in: sourceSlabIds } },
        select: { sourceSlabId: true, areaSqft: true },
      })
      const existingAreaBySlab = new Map<number, number>()
      for (const existing of existingOffcuts) {
        if (existing.sourceSlabId) existingAreaBySlab.set(existing.sourceSlabId, (existingAreaBySlab.get(existing.sourceSlabId) || 0) + (existing.areaSqft || 0))
      }
      for (const offcut of stoneOffcuts) {
        const source = sourceById.get(offcut.sourceSlabId)
        if (!source) throw new Error('Offcut source slab not found')
        const areaSqft = Math.round((offcut.lengthInches * offcut.widthInches / 144) * 100) / 100
        const recordedArea = existingAreaBySlab.get(source.id) || 0
        if (recordedArea + areaSqft > source.sqft + 0.01) throw new Error(`Offcut area exceeds the remaining source slab area for ${source.slabNumber}`)
        await tx.scrapInventory.create({
          data: {
            productionOrderId,
            rawMaterialId: source.lot.productId,
            sourceSlabId: source.id,
            sourceCustomOrderId: order.customOrderId,
            lengthInches: offcut.lengthInches,
            widthInches: offcut.widthInches,
            areaSqft,
            shadeCode: offcut.shadeCode || source.lot.shadeCode || null,
            photo: offcut.photo || source.photo || null,
            salePrice: offcut.salePrice ?? null,
            quantity: areaSqft,
            unitOfMeasure: 'SQFT',
            unitCost: source.lot.costPerSqft || 0,
            estimatedValue: offcut.salePrice ?? Math.round(areaSqft * (source.lot.costPerSqft || 0)),
            reason: 'Stone offcut from fabrication',
            disposition: 'REUSABLE',
            status: 'IN_STOCK',
            notes: offcut.notes || `Recorded from ${order.displayId}`,
          },
        })
      }
    }

    if (stepActuals?.length) {
      for (const stepActual of stepActuals) {
        await tx.productionStep.update({
          where: { id: stepActual.stepId },
          data: { actualMins: stepActual.actualMins },
        })
      }
    }

    // Only add finished goods for passed/partial quality
    const goodQty = qualityStatus === 'FAILED' ? 0 : actualQty - scrapQty
    if (goodQty > 0) {
      if (order.customOrderId) {
        await tx.customOrderInventory.create({
          data: {
            customOrderId: order.customOrderId,
            productionOrderId,
            productId: order.finishedProductId,
            quantity: goodQty,
            status: 'READY',
            notes: `Finished from ${order.displayId}`,
          },
        })
      } else {
        await adjustManufacturingStockWithTx(tx, order.finishedProductId, goodQty, 'PRODUCTION', {
          referenceType: 'Production',
          referenceId: productionOrderId,
          notes: `Finished goods from ${order.displayId}`,
          createdBy: 'Manufacturing',
        })
      }
    }

    await tx.productionStep.updateMany({
      where: { productionOrderId, status: { not: 'DONE' } },
      data: { status: 'DONE', completedAt: new Date() },
    })

    await updateProductionTimeVarianceWithTx(tx, productionOrderId)

    const refreshedOrder = await tx.productionOrder.findUnique({
      where: { id: productionOrderId },
      select: { actualMins: true, labourVarianceMins: true, labourVarianceCost: true },
    })
    const effectiveLabourCost = totalLabourCost > 0 ? totalLabourCost : order.productionSteps.reduce((sum, step) => {
      const actualMinsForStep = stepActuals?.find(s => s.stepId === step.id)?.actualMins ?? (step.actualMins || step.plannedMins)
      return sum + (actualMinsForStep / 60) * (step.labourRatePerHour || 0)
    }, 0)
    const roundedLabourCost = Math.round(effectiveLabourCost)
    const totalCost = totalMaterialCost + roundedLabourCost + (machineCost ?? 0) + overheadCost
    const costPerUnit = actualQty > 0 ? Math.round(totalCost / actualQty) : 0
    // Yield = good units / planned (good units = actual produced minus scrapped defects)
    const goodUnits = Math.max(0, actualQty - scrapQty)
    const yieldRate = order.plannedQty > 0 ? Math.round((goodUnits / order.plannedQty) * 100 * 10) / 10 : 0

    if (costPerUnit > 0 && !order.customOrderId) {
      await tx.product.update({
        where: { id: order.finishedProductId },
        data: { costPrice: costPerUnit },
      })
    }

    if (costPerUnit > 0 && order.customOrderId && goodQty > 0) {
      await tx.customOrderInventory.updateMany({
        where: { productionOrderId },
        data: { unitCost: costPerUnit, totalCost: costPerUnit * goodQty },
      })
    }

    await tx.productionOrder.update({
      where: { id: productionOrderId },
      data: {
        status: 'COMPLETED',
        actualQty,
        totalMaterialCost,
        totalLabourCost: roundedLabourCost,
        overheadCost: (machineCost ?? 0) + overheadCost, // store combined overhead
        totalCost,
        costPerUnit,
        actualMins: refreshedOrder?.actualMins || 0,
        labourVarianceMins: refreshedOrder?.labourVarianceMins || 0,
        labourVarianceCost: refreshedOrder?.labourVarianceCost || 0,
        yieldRate,
        scrapQty,
        scrapReason,
        qualityStatus,
        qualityNotes,
        completedDate: new Date(),
        notes,
      },
    })

    if (order.customOrderId) {
      await tx.customOrder.update({
        where: { id: order.customOrderId },
        data: { status: 'QUALITY_CHECK' }
      })

      await tx.customOrderTimeline.create({
        data: {
          customOrderId: order.customOrderId,
          date: new Date(),
          event: `Production completed (${order.displayId})`,
          status: 'done',
          updatedBy: 'Manager',
        },
      })
    }
  })

  revalidatePath('/manufacturing')
  revalidatePath('/inventory')
  revalidatePath('/godowns')
  revalidatePath('/custom-orders')
  return { success: true }
}

export async function recordQualityCheck(data: unknown) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const parsed = qualityCheckSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { productionOrderId, qualityStatus, qualityNotes, scrapQty, scrapReason } = parsed.data
  const order = await prisma.productionOrder.findUnique({
    where: { id: productionOrderId },
    select: { status: true, plannedQty: true },
  })
  if (!order) return { success: false, error: 'Production order not found' }
  if (!['IN_PROGRESS', 'ON_HOLD'].includes(order.status)) {
    return { success: false, error: 'Quality check is available only while production is in progress or on hold' }
  }
  if (scrapQty > order.plannedQty) return { success: false, error: 'Scrap quantity cannot exceed planned quantity' }
  if (scrapQty > 0 && !scrapReason?.trim()) return { success: false, error: 'Add a reason when recording scrap' }
  await prisma.productionOrder.update({
    where: { id: productionOrderId },
    data: { qualityStatus, qualityNotes, scrapQty, scrapReason },
  })
  revalidatePath('/manufacturing')
  return { success: true }
}

// ─── ANALYTICS ───────────────────────────────────────

export async function getManufacturingStats() {
  const [allOrders, workCenters, scrapEntries, customInventory] = await Promise.all([
    prisma.productionOrder.findMany({
      include: {
        finishedProduct: { select: { name: true } },
        consumptions: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.workCenter.findMany(),
    prisma.scrapInventory.findMany(),
    prisma.customOrderInventory.findMany(),
  ])

  const completed = allOrders.filter(o => o.status === 'COMPLETED')
  const inProgress = allOrders.filter(o => o.status === 'IN_PROGRESS')
  const planned = allOrders.filter(o => o.status === 'PLANNED')

  // Yield rate average
  const avgYield = completed.length > 0
    ? Math.round(completed.reduce((s, o) => s + (o.yieldRate || 0), 0) / completed.length * 10) / 10
    : 0

  // Total production value
  const totalProduced = completed.reduce((s, o) => s + (o.actualQty || 0), 0)
  const totalMaterialCost = completed.reduce((s, o) => s + (o.totalMaterialCost || 0), 0)
  const totalLabourCost = completed.reduce((s, o) => s + (o.totalLabourCost || 0), 0)
  const totalOverhead = completed.reduce((s, o) => s + (o.overheadCost || 0), 0)
  const totalScrap = completed.reduce((s, o) => s + (o.scrapQty || 0), 0)
  const totalMaterialScrapQty = scrapEntries.reduce((s, e) => s + (e.quantity || 0), 0)
  const totalMaterialScrapValue = scrapEntries.reduce((s, e) => s + (e.estimatedValue || 0), 0)
  const totalTimeVarianceMins = completed.reduce((s, o) => s + (o.labourVarianceMins || 0), 0)
  const totalTimeVarianceCost = completed.reduce((s, o) => s + (o.labourVarianceCost || 0), 0)

  // Quality pass rate
  const qualityPassed = completed.filter(o => o.qualityStatus === 'PASSED').length
  const qualityRate = completed.length > 0 ? Math.round((qualityPassed / completed.length) * 100) : 0

  // Top produced products
  const productMap: Record<string, { name: string; qty: number; orders: number }> = {}
  completed.forEach(o => {
    const name = o.finishedProduct.name
    if (!productMap[name]) productMap[name] = { name, qty: 0, orders: 0 }
    productMap[name].qty += o.actualQty || 0
    productMap[name].orders++
  })
  const topProducts = Object.values(productMap).sort((a, b) => b.qty - a.qty).slice(0, 5)

  // Monthly production trend (last 6 months)
  const sixMonthsAgo = new Date()
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5)
  sixMonthsAgo.setDate(1)
  const monthlyOrders = completed.filter(o => o.completedDate && o.completedDate >= sixMonthsAgo)
  const monthlyMap: Record<string, { qty: number; orders: number; cost: number }> = {}
  monthlyOrders.forEach(o => {
    const m = o.completedDate!.toISOString().slice(0, 7)
    if (!monthlyMap[m]) monthlyMap[m] = { qty: 0, orders: 0, cost: 0 }
    monthlyMap[m].qty += o.actualQty || 0
    monthlyMap[m].orders++
    monthlyMap[m].cost += o.totalCost || 0
  })

  // Overdue production orders
  const now = new Date()
  const overdue = allOrders.filter(o =>
    o.dueDate && new Date(o.dueDate) < now &&
    o.status !== 'COMPLETED' && o.status !== 'CANCELLED'
  )

  return {
    success: true,
    data: {
      totals: {
        all: allOrders.length,
        planned: planned.length,
        inProgress: inProgress.length,
        completed: completed.length,
        overdue: overdue.length,
        totalProduced,
        totalScrap,
        totalMaterialScrapQty,
        totalMaterialScrapValue,
        totalCustomInventoryQty: customInventory.reduce((s, i) => s + (i.quantity || 0), 0),
        totalTimeVarianceMins,
        totalTimeVarianceCost,
        avgYield,
        qualityRate,
        totalMaterialCost,
        totalLabourCost,
        totalOverhead,
        totalCost: totalMaterialCost + totalLabourCost + totalOverhead,
      },
      topProducts,
      monthlyTrend: Object.entries(monthlyMap)
        .map(([month, data]) => ({ month, ...data }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      workCenterUtilization: workCenters.map(wc => ({
        id: wc.id,
        name: wc.name,
        type: wc.type,
        status: wc.status,
        ordersCount: allOrders.filter(o => o.workCenterId === wc.id).length,
      })),
      overdueOrders: overdue.map(o => ({
        displayId: o.displayId,
        product: o.finishedProduct.name,
        dueDate: o.dueDate?.toISOString().split('T')[0],
        status: o.status,
        priority: o.priority,
      })),
    },
  }
}

// ─── Staff Portal: Production Orders ────────────────────

export async function getStaffProductionOrders(staffId: number) {
  const orders = await prisma.productionOrder.findMany({
    where: { assignedStaffId: staffId },  // Only fetch orders assigned to THIS staff
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    include: {
      bom: {
        select: {
          name: true,
          version: true,
          items: {
            include: {
              rawMaterial: { select: { name: true, sku: true, unitOfMeasure: true, stock: true } },
            },
          },
        },
      },
      finishedProduct: { select: { name: true, sku: true } },
      workCenter: { select: { name: true } },
      customOrder: {
        select: {
          displayId: true,
          type: true,
          contact: { select: { name: true } },
        },
      },
      productionSteps: {
        include: { workCenter: { select: { name: true } } },
        orderBy: { stepNumber: 'asc' },
      },
    },
  })

  // Normalize customOrder to expose customer name cleanly
  return {
    success: true,
    data: orders.map(o => ({
      ...o,
      customOrder: o.customOrder
        ? { ...o.customOrder, customer: o.customOrder.contact?.name || o.customOrder.displayId }
        : null,
    })),
  }
}

export async function staffUpdateProductionStep(staffId: number, stepId: number, status: string, notes?: string) {
  // Verify the step belongs to an order assigned to this staff
  const step = await prisma.productionStep.findUnique({
    where: { id: stepId },
    include: { productionOrder: { select: { assignedStaffId: true, status: true } } },
  })
  if (!step) return { success: false, error: 'Step not found' }
  if (step.productionOrder.assignedStaffId !== staffId) {
    return { success: false, error: 'You are not assigned to this production order' }
  }
  if (step.productionOrder.status !== 'IN_PROGRESS') {
    return { success: false, error: 'Production order is not in progress' }
  }

  await prisma.$transaction(async (tx) => {
    const completedAt = status === 'DONE' ? new Date() : undefined
    const actualMins = status === 'DONE' && step.startedAt
      ? Math.max(0, Math.round(((completedAt as Date).getTime() - step.startedAt.getTime()) / 60000))
      : undefined
    await tx.productionStep.update({
      where: { id: stepId },
      data: {
        status,
        actualMins,
        startedAt: status === 'IN_PROGRESS' ? new Date() : undefined,
        completedAt,
        ...(notes !== undefined ? { notes } : {}),
      },
    })
    await updateProductionTimeVarianceWithTx(tx, step.productionOrderId)
  })
  revalidatePath('/staff-portal')
  revalidatePath('/manufacturing')
  return { success: true }
}

export async function staffAddStepNote(staffId: number, stepId: number, notes: string) {
  const step = await prisma.productionStep.findUnique({
    where: { id: stepId },
    include: { productionOrder: { select: { assignedStaffId: true } } },
  })
  if (!step) return { success: false, error: 'Step not found' }
  if (step.productionOrder.assignedStaffId !== staffId) {
    return { success: false, error: 'Not assigned to this order' }
  }
  await prisma.productionStep.update({ where: { id: stepId }, data: { notes } })
  revalidatePath('/staff-portal')
  revalidatePath('/manufacturing')
  return { success: true }
}


export async function staffUpdateProductionProgress(staffId: number, orderId: number, actualQty: number, notes?: string) {
  const order = await prisma.productionOrder.findUnique({ where: { id: orderId } })
  if (!order) return { success: false, error: 'Order not found' }
  if (order.assignedStaffId !== staffId) return { success: false, error: 'You are not assigned to this order' }
  if (order.status !== 'IN_PROGRESS') return { success: false, error: 'Order is not in progress' }
  if (actualQty < 0) return { success: false, error: 'Quantity cannot be negative' }
  if (actualQty > order.plannedQty) return { success: false, error: 'Cannot exceed planned quantity' }

  const updateData: Record<string, unknown> = {
    actualQty,
    yieldRate: order.plannedQty > 0 ? (actualQty / order.plannedQty) * 100 : 0,
  }
  if (notes !== undefined) updateData.notes = notes

  await prisma.productionOrder.update({ where: { id: orderId }, data: updateData })
  revalidatePath('/staff-portal')
  revalidatePath('/manufacturing')
  return { success: true }
}

// MRP "Order": draft POs for every component still short after incoming
// supply, from each material's preferred (or cheapest) vendor.
export async function orderMrpShortages(bomId: number, qty: number) {
  try { await requireRole('ADMIN', 'MANAGER') } catch { return { success: false, error: 'Access denied' } }
  const analysis = await getMRPAnalysis(bomId, qty)
  if (!analysis.success || !analysis.data) return { success: false, error: analysis.error || 'MRP analysis failed' }
  const short = analysis.data.requirements.filter(row => row.shortageAfterIncoming > 0)
  if (short.length === 0) return { success: false, error: 'Nothing to order: every component is covered by stock or incoming purchases' }
  const vendors = await prisma.productSupplier.findMany({
    where: { productId: { in: short.map(row => row.materialId) } },
    orderBy: [{ isPreferred: 'desc' }, { price: 'asc' }],
  })
  const items = short.flatMap(row => {
    const vendor = vendors.find(entry => entry.productId === row.materialId)
    return vendor ? [{ productId: row.materialId, supplierId: vendor.supplierId, quantity: Math.ceil(row.shortageAfterIncoming), unitCost: vendor.price || undefined }] : []
  })
  const noVendor = short.filter(row => !vendors.some(entry => entry.productId === row.materialId)).map(row => row.materialName)
  if (items.length === 0) return { success: false, error: `Add a vendor price for ${noVendor.join(', ')} in Replenishment → Vendor pricelists first` }
  const { orderReplenishment } = await import('./replenishment')
  const result = await orderReplenishment({ items })
  if (!result.success) return result
  return { success: true, data: { pos: result.data, noVendor } }
}
