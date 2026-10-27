'use server'

import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/auth-helpers'
import { revalidatePath } from 'next/cache'
import type { DealerOrderStatus } from '@prisma/client'
import {
  createDealerSchema, updateDealerSchema, dealerTaskSchema, dealerVisitSchema,
  dealerOrderSchema, dealerPaymentSchema, dealerClaimSchema, dealerPriceListSchema, dealerTeamSchema,
  dealerStatuses, dealerTaskStatuses, dealerOrderStatuses, dealerClaimStatuses,
} from '@/lib/validations/dealer'

const DEALER_PATH = '/dealers'

const statusLabels: Record<string, string> = {
  PROSPECT: 'New Prospect', CONTACTED: 'Contacted', MEETING_SCHEDULED: 'Meeting Scheduled',
  CATALOGUE_SHARED: 'Catalogue Shared', PRICE_LIST_SHARED: 'Price List Shared',
  TRIAL_ORDER: 'Trial Order', ACTIVE: 'Active', DORMANT: 'Dormant',
  NOT_INTERESTED: 'Not Interested', LOST: 'Lost',
}

const orderStatusLabels: Record<string, string> = {
  ENQUIRY: 'Enquiry', QUOTATION_SHARED: 'Quotation Shared', ORDER_RECEIVED: 'Order Received',
  APPROVAL_PENDING: 'Approval Pending', APPROVED: 'Approved', ALLOCATED: 'Stock Allocated',
  DISPATCHED: 'Dispatched', DELIVERED: 'Delivered', CANCELLED: 'Cancelled', RETURNED: 'Returned',
}

const financiallyCommittedOrderStatuses: DealerOrderStatus[] = ['ORDER_RECEIVED', 'APPROVAL_PENDING', 'APPROVED', 'ALLOCATED', 'DISPATCHED', 'DELIVERED']

const dealerStatusOrder: Record<string, number> = {
  PROSPECT: 1, CONTACTED: 2, MEETING_SCHEDULED: 3, CATALOGUE_SHARED: 4,
  PRICE_LIST_SHARED: 5, TRIAL_ORDER: 6, ACTIVE: 7, DORMANT: 8,
  NOT_INTERESTED: 9, LOST: 10,
}

const paymentStatusLabel = (status: string) => status === 'PAID' ? 'Paid' : status === 'PARTIAL' ? 'Partial' : 'Pending'
const iso = (value: Date | null | undefined) => value ? value.toISOString() : null

async function actor() {
  try { return await requireAuth() } catch { return null }
}

async function canAccessDealer(dealerId: number, session: any, managerOnly = false) {
  if (!session?.user) return false
  if (managerOnly) return session.user.role === 'ADMIN' || session.user.role === 'MANAGER'
  if (session.user.role !== 'STAFF') return true
  if (!session.user.staffId) return false
  const dealer = await prisma.dealer.findFirst({
    where: { id: dealerId, OR: [{ assignedStaffId: session.user.staffId }, { tasks: { some: { assignedStaffId: session.user.staffId } } }, { teamAssignments: { some: { staffId: session.user.staffId } } }] },
    select: { id: true },
  })
  return !!dealer
}

async function addActivity(dealerId: number, session: any, type: string, title: string, description?: string) {
  await prisma.dealerActivity.create({
    data: { dealerId, staffId: session?.user?.staffId || null, type, title, description: description || null },
  })
}

async function isActiveStaff(staffId: number | null | undefined) {
  if (!staffId) return false
  const staff = await prisma.staff.findFirst({ where: { id: staffId, status: { not: 'Inactive' } }, select: { id: true } })
  return !!staff
}

function parseDate(value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function dealerScopeForSession(session: any) {
  if (session?.user?.role !== 'STAFF') return {}
  const staffId = session.user.staffId || -1
  return { OR: [{ assignedStaffId: staffId }, { tasks: { some: { assignedStaffId: staffId } } }, { teamAssignments: { some: { staffId } } }] }
}

function mapDealer(dealer: any) {
  const orders = dealer.orders || []
  const tasks = dealer.tasks || []
  const committedOrders = orders.filter((order: any) => financiallyCommittedOrderStatuses.includes(order.status))
  return {
    id: dealer.id,
    businessName: dealer.businessName,
    contactPerson: dealer.contactPerson,
    phone: dealer.phone,
    alternatePhone: dealer.alternatePhone,
    whatsappNumber: dealer.whatsappNumber,
    email: dealer.email,
    gstNumber: dealer.gstNumber,
    address: dealer.address,
    city: dealer.city,
    state: dealer.state,
    pincode: dealer.pincode,
    territory: dealer.territory,
    dealerType: dealer.dealerType,
    status: dealer.status,
    statusLabel: statusLabels[dealer.status] || dealer.status,
    preferredCategories: Array.isArray(dealer.preferredCategories) ? dealer.preferredCategories : [],
    estimatedMonthlyBusiness: dealer.estimatedMonthlyBusiness,
    monthlySalesTarget: dealer.monthlySalesTarget,
    performanceTier: dealer.performanceTier,
    creditLimit: dealer.creditLimit,
    creditDays: dealer.creditDays,
    paymentTerms: dealer.paymentTerms,
    priceTier: dealer.priceTier,
    defaultDiscountPercent: dealer.defaultDiscountPercent,
    assignedStaffId: dealer.assignedStaffId,
    assignedStaff: dealer.assignedStaff ? { id: dealer.assignedStaff.id, name: dealer.assignedStaff.name } : null,
    source: dealer.source,
    lastContactAt: iso(dealer.lastContactAt),
    nextFollowUpAt: iso(dealer.nextFollowUpAt),
    lostReason: dealer.lostReason,
    notes: dealer.notes,
    createdAt: iso(dealer.createdAt),
    updatedAt: iso(dealer.updatedAt),
    orderCount: dealer._count?.orders ?? orders.length,
    totalOrderValue: committedOrders.reduce((sum: number, order: any) => sum + Number(order.total || 0), 0),
    outstanding: committedOrders.reduce((sum: number, order: any) => sum + Number(order.balanceDue || 0), 0),
    pendingTasks: tasks.filter((task: any) => task.status === 'PENDING' || task.status === 'IN_PROGRESS').length,
  }
}

function dealerPerformance(dealer: any) {
  const committed = (dealer.orders || []).filter((order: any) => financiallyCommittedOrderStatuses.includes(order.status))
  const paidAmount = committed.reduce((sum: number, order: any) => sum + Number(order.amountPaid || 0), 0)
  const orderValue = committed.reduce((sum: number, order: any) => sum + Number(order.total || 0), 0)
  const outstanding = committed.reduce((sum: number, order: any) => sum + Number(order.balanceDue || 0), 0)
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const monthlySales = committed.filter((order: any) => new Date(order.orderDate) >= monthStart).reduce((sum: number, order: any) => sum + Number(order.total || 0), 0)
  const categorySales: Record<string, number> = {}
  for (const order of committed) for (const item of order.items || []) {
    const category = item.product?.category?.name || 'Custom / uncategorized'
    categorySales[category] = (categorySales[category] || 0) + Number(item.amount || 0)
  }
  const firstOrderAt = committed.length ? new Date(committed[committed.length - 1].orderDate) : null
  const activeMonths = firstOrderAt ? Math.max(1, Math.ceil((Date.now() - firstOrderAt.getTime()) / (30 * 86400000))) : 0
  const overdueOrders = committed.filter((order: any) => Number(order.balanceDue || 0) > 0 && order.paymentDueDate && new Date(order.paymentDueDate) < new Date())
  return {
    totalOrders: committed.length,
    orderValue,
    paidAmount,
    outstanding,
    lastOrderDate: committed[0] ? iso(committed[0].orderDate) : null,
    monthlySales,
    target: Number(dealer.monthlySalesTarget || 0),
    targetAchievementPercent: dealer.monthlySalesTarget ? Math.round((monthlySales / dealer.monthlySalesTarget) * 100) : null,
    averageOrderValue: committed.length ? Math.round(orderValue / committed.length) : 0,
    repeatOrderFrequency: activeMonths ? Number((committed.length / activeMonths).toFixed(1)) : 0,
    categorySales: Object.entries(categorySales).sort(([, a], [, b]) => b - a).map(([category, value]) => ({ category, value })),
    overdueCount: overdueOrders.length,
    overdueAmount: overdueOrders.reduce((sum: number, order: any) => sum + Number(order.balanceDue || 0), 0),
  }
}

const dealerInclude = {
  assignedStaff: { select: { id: true, name: true, role: true, phone: true } },
  tasks: { orderBy: { dueDate: 'asc' as const }, take: 25, include: { assignedStaff: { select: { id: true, name: true } } } },
  orders: { orderBy: { orderDate: 'desc' as const }, take: 50, include: { items: { include: { product: { include: { category: { select: { name: true } } } } } }, payments: true, claims: true } },
  visits: { orderBy: { visitDate: 'desc' as const }, take: 20, include: { staff: { select: { id: true, name: true } } } },
  claims: { orderBy: { openedAt: 'desc' as const }, take: 20, include: { assignedStaff: { select: { id: true, name: true } }, dealerOrder: { select: { displayId: true } } } },
  payments: { orderBy: { paymentDate: 'desc' as const }, take: 20, include: { dealerOrder: { select: { displayId: true } } } },
  activities: { orderBy: { createdAt: 'desc' as const }, take: 30 },
  priceLists: { orderBy: { createdAt: 'desc' as const }, take: 10, include: { items: { include: { product: true } } } },
  teamAssignments: { include: { staff: { select: { id: true, name: true, role: true, phone: true } } }, orderBy: { createdAt: 'asc' as const } },
  _count: { select: { orders: true } },
}

export async function getDealerStaff() {
  const session = await actor()
  if (!session) return { success: false, error: 'Unauthorized' }
  const staffWhere: any = { status: { not: 'Inactive' } }
  if (session.user.role === 'STAFF') staffWhere.id = session.user.staffId || -1
  const staff = await prisma.staff.findMany({ where: staffWhere, select: { id: true, name: true, role: true, phone: true }, orderBy: { name: 'asc' } })
  return { success: true, data: staff }
}

export async function getDealers(filters?: { status?: string; search?: string; territory?: string }) {
  const session = await actor()
  if (!session) return { success: false, error: 'Unauthorized' }
  const where: any = {}
  if (filters?.status && dealerStatuses.includes(filters.status as any)) where.status = filters.status
  if (filters?.territory) where.territory = filters.territory
  const andFilters: any[] = []
  const scope = dealerScopeForSession(session)
  if (Object.keys(scope).length) andFilters.push(scope)
  if (filters?.search?.trim()) {
    const search = filters.search.trim()
    andFilters.push({ OR: [
      { businessName: { contains: search, mode: 'insensitive' } },
      { contactPerson: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
      { city: { contains: search, mode: 'insensitive' } },
    ] })
  }
  if (andFilters.length) where.AND = andFilters
  const dealers = await prisma.dealer.findMany({
    where,
    include: {
      assignedStaff: { select: { id: true, name: true, role: true, phone: true } },
      orders: { select: { total: true, balanceDue: true, status: true } },
      tasks: { where: { status: { in: ['PENDING', 'IN_PROGRESS'] } }, select: { status: true } },
      _count: { select: { orders: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })
  return { success: true, data: dealers.map(mapDealer).sort((a, b) => (dealerStatusOrder[a.status] || 99) - (dealerStatusOrder[b.status] || 99) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))) }
}

export async function getDealer(id: number) {
  const session = await actor()
  if (!session || !(await canAccessDealer(id, session))) return { success: false, error: 'Dealer not found or access denied' }
  const dealer = await prisma.dealer.findUnique({ where: { id }, include: dealerInclude })
  if (!dealer) return { success: false, error: 'Dealer not found' }
  return { success: true, data: { ...mapDealer(dealer), details: dealer, performance: dealerPerformance(dealer) } }
}

export async function getDealerDashboard() {
  const session = await actor()
  if (!session) return { success: false, error: 'Unauthorized' }
  const dealerWhere: any = dealerScopeForSession(session)
  const staffWhere: any = { status: { not: 'Inactive' } }
  if (session.user.role === 'STAFF') staffWhere.id = session.user.staffId || -1
  const [total, grouped, tasks, claims, orderAggregate, topDealers, overdueAggregate, staffStats] = await Promise.all([
    prisma.dealer.count({ where: dealerWhere }),
    prisma.dealer.groupBy({ by: ['status'], where: dealerWhere, _count: { _all: true } }),
    prisma.dealerTask.count({ where: { status: { in: ['PENDING', 'IN_PROGRESS'] }, dealer: dealerWhere } }),
    prisma.dealerClaim.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] }, dealer: dealerWhere } }),
    prisma.dealerOrder.aggregate({ where: { dealer: dealerWhere, status: { in: financiallyCommittedOrderStatuses } }, _sum: { total: true, balanceDue: true } }),
    prisma.dealer.findMany({ where: dealerWhere, take: 100, include: { orders: { where: { status: { in: financiallyCommittedOrderStatuses } }, select: { total: true } } } }),
    prisma.dealerOrder.aggregate({ where: { dealer: dealerWhere, status: { in: financiallyCommittedOrderStatuses }, balanceDue: { gt: 0 }, paymentDueDate: { lt: new Date() } }, _sum: { balanceDue: true }, _count: { _all: true } }),
    prisma.staff.findMany({ where: staffWhere, select: { id: true, name: true, role: true, dealersAssigned: { select: { status: true } }, dealerTeamAssignments: { select: { dealerId: true } }, dealerTasks: { where: { status: { in: ['PENDING', 'IN_PROGRESS'] } }, select: { id: true } }, dealerOrders: { where: { status: { in: financiallyCommittedOrderStatuses } }, select: { total: true } } }, orderBy: { name: 'asc' } }),
  ])
  const byStatus: Record<string, number> = {}
  for (const row of grouped) byStatus[row.status] = row._count._all
  return {
    success: true,
    data: {
      total,
      active: byStatus.ACTIVE || 0,
      prospects: (byStatus.PROSPECT || 0) + (byStatus.CONTACTED || 0) + (byStatus.MEETING_SCHEDULED || 0),
      dormant: byStatus.DORMANT || 0,
      openTasks: tasks,
      openClaims: claims,
      orderValue: orderAggregate._sum?.total || 0,
      outstanding: orderAggregate._sum?.balanceDue || 0,
      overdueInvoices: overdueAggregate._count?._all || 0,
      overdueAmount: overdueAggregate._sum?.balanceDue || 0,
      byStatus,
      topDealers: topDealers.map((dealer: any) => ({ id: dealer.id, businessName: dealer.businessName, value: dealer.orders.reduce((sum: number, order: any) => sum + Number(order.total || 0), 0) })).sort((a, b) => b.value - a.value).slice(0, 10),
      staffPerformance: staffStats.map((staff: any) => ({ id: staff.id, name: staff.name, role: staff.role, ownedDealers: staff.dealersAssigned.length, teamDealers: new Set(staff.dealerTeamAssignments.map((assignment: any) => assignment.dealerId)).size, activeDealers: staff.dealersAssigned.filter((dealer: any) => dealer.status === 'ACTIVE').length, pendingFollowUps: staff.dealerTasks.length, orderValue: staff.dealerOrders.reduce((sum: number, order: any) => sum + Number(order.total || 0), 0) })),
    },
  }
}

export async function createDealer(input: unknown) {
  const session = await actor()
  if (!session || !(await canAccessDealer(0, session, true))) return { success: false, error: 'Manager access required' }
  const parsed = createDealerSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  if (parsed.data.assignedStaffId) {
    const staff = await prisma.staff.findFirst({ where: { id: parsed.data.assignedStaffId, status: { not: 'Inactive' } }, select: { id: true } })
    if (!staff) return { success: false, error: 'Assigned staff member not found' }
  }
  const duplicate = await prisma.dealer.findFirst({ where: { phone: parsed.data.phone.trim() }, select: { id: true, businessName: true } })
  if (duplicate) return { success: false, error: `A dealer with this phone already exists: ${duplicate.businessName}` }
  const data = parsed.data
  const dealer = await prisma.dealer.create({
    data: {
      businessName: data.businessName, contactPerson: data.contactPerson, phone: data.phone,
      alternatePhone: data.alternatePhone || null, whatsappNumber: data.whatsappNumber || data.alternatePhone || data.phone, email: data.email || null, gstNumber: data.gstNumber || null,
      address: data.address || null, city: data.city || null, state: data.state || null, pincode: data.pincode || null,
      territory: data.territory || null, dealerType: data.dealerType, status: data.status,
      preferredCategories: data.preferredCategories, estimatedMonthlyBusiness: data.estimatedMonthlyBusiness || 0, monthlySalesTarget: data.monthlySalesTarget || 0, performanceTier: data.performanceTier || 'UNCLASSIFIED',
      creditLimit: data.creditLimit || 0, creditDays: data.creditDays || 0, paymentTerms: data.paymentTerms || null,
      priceTier: data.priceTier, defaultDiscountPercent: data.defaultDiscountPercent || 0, assignedStaffId: data.assignedStaffId || null,
      source: data.source || null, nextFollowUpAt: parseDate(data.nextFollowUpAt), lostReason: data.lostReason || null, notes: data.notes || null,
    },
  })
  await addActivity(dealer.id, session, 'CREATED', 'Dealer profile created')
  revalidatePath(DEALER_PATH)
  return { success: true, data: dealer }
}

export async function updateDealer(input: unknown) {
  const parsed = updateDealerSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const session = await actor()
  if (!session || !(await canAccessDealer(parsed.data.id, session, true))) return { success: false, error: 'Manager access required' }
  const { id, preferredCategories, nextFollowUpAt, assignedStaffId, status, ...rest } = parsed.data
  if (rest.phone) {
    const duplicate = await prisma.dealer.findFirst({ where: { phone: rest.phone.trim(), id: { not: id } }, select: { businessName: true } })
    if (duplicate) return { success: false, error: `A dealer with this phone already exists: ${duplicate.businessName}` }
  }
  if ((status === 'LOST' || status === 'NOT_INTERESTED') && !rest.lostReason?.trim()) return { success: false, error: 'Please record a reason before closing the dealer' }
  if (assignedStaffId) {
    const staff = await prisma.staff.findFirst({ where: { id: assignedStaffId, status: { not: 'Inactive' } }, select: { id: true } })
    if (!staff) return { success: false, error: 'Assigned staff member not found' }
  }
  const dealer = await prisma.dealer.update({ where: { id }, data: {
    ...rest,
    ...(preferredCategories !== undefined ? { preferredCategories } : {}),
    ...(nextFollowUpAt !== undefined ? { nextFollowUpAt: parseDate(nextFollowUpAt) } : {}),
    ...(assignedStaffId !== undefined ? { assignedStaffId: assignedStaffId || null } : {}),
    ...(status ? { status } : {}),
  } as any })
  await addActivity(id, session, 'UPDATED', 'Dealer profile updated')
  revalidatePath(DEALER_PATH)
  return { success: true, data: dealer }
}

export async function updateDealerStatus(id: number, status: string, reason?: string) {
  const session = await actor()
  if (!session || !(await canAccessDealer(id, session))) return { success: false, error: 'Access denied' }
  if (!dealerStatuses.includes(status as any)) return { success: false, error: 'Invalid dealer status' }
  if ((status === 'LOST' || status === 'NOT_INTERESTED') && !reason?.trim()) return { success: false, error: 'Please record a reason before closing the dealer' }
  const dealer = await prisma.dealer.update({ where: { id }, data: { status: status as any, lostReason: status === 'LOST' || status === 'NOT_INTERESTED' ? reason?.trim() : null } })
  await addActivity(id, session, 'STATUS', `Status changed to ${statusLabels[status] || status}`, reason)
  revalidatePath(DEALER_PATH)
  return { success: true, data: dealer }
}

export async function assignDealer(id: number, staffId: number | null) {
  const session = await actor()
  if (!session || !(await canAccessDealer(id, session, true))) return { success: false, error: 'Manager access required' }
  if (staffId) {
    const staff = await prisma.staff.findFirst({ where: { id: staffId, status: { not: 'Inactive' } }, select: { id: true } })
    if (!staff) return { success: false, error: 'Staff member not found' }
  }
  const dealer = await prisma.dealer.update({ where: { id }, data: { assignedStaffId: staffId } })
  await addActivity(id, session, 'ASSIGNMENT', staffId ? 'Dealer assigned to staff' : 'Dealer unassigned')
  revalidatePath(DEALER_PATH)
  return { success: true, data: dealer }
}

export async function saveDealerTeam(input: unknown) {
  const parsed = dealerTeamSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const session = await actor()
  if (!session || !(await canAccessDealer(parsed.data.dealerId, session, true))) return { success: false, error: 'Manager access required' }
  const uniqueAssignments = new Map(parsed.data.assignments.map(assignment => [`${assignment.staffId}:${assignment.role}`, assignment]))
  const assignments = [...uniqueAssignments.values()]
  if (assignments.filter(assignment => assignment.role === 'OWNER').length > 1) return { success: false, error: 'Assign only one dealer owner' }
  if (assignments.length) {
    const activeStaff = await prisma.staff.count({ where: { id: { in: assignments.map(assignment => assignment.staffId) }, status: { not: 'Inactive' } } })
    if (activeStaff !== new Set(assignments.map(assignment => assignment.staffId)).size) return { success: false, error: 'Every team member must be an active staff member' }
  }
  const owner = assignments.find(assignment => assignment.role === 'OWNER')
  await prisma.$transaction([
    prisma.dealerStaffAssignment.deleteMany({ where: { dealerId: parsed.data.dealerId } }),
    prisma.dealerStaffAssignment.createMany({ data: assignments.map(assignment => ({ dealerId: parsed.data.dealerId, staffId: assignment.staffId, role: assignment.role })) }),
    ...(owner ? [prisma.dealer.update({ where: { id: parsed.data.dealerId }, data: { assignedStaffId: owner.staffId } })] : []),
  ])
  await addActivity(parsed.data.dealerId, session, 'TEAM', `Dealer team updated (${assignments.length} role assignments)`)
  revalidatePath(DEALER_PATH)
  return { success: true }
}

export async function createDealerTask(input: unknown) {
  const parsed = dealerTaskSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const session = await actor()
  if (!session || !(await canAccessDealer(parsed.data.dealerId, session))) return { success: false, error: 'Access denied' }
  const dueDate = parseDate(parsed.data.dueDate)
  if (!dueDate) return { success: false, error: 'Enter a valid due date' }
  if (session.user.role === 'STAFF' && !session.user.staffId) return { success: false, error: 'Your staff account is not linked to a staff profile' }
  const dealer = await prisma.dealer.findUnique({ where: { id: parsed.data.dealerId }, select: { assignedStaffId: true } })
  const explicitlyAssigned = parsed.data.assignedStaffId || null
  if (explicitlyAssigned && !(await isActiveStaff(explicitlyAssigned))) return { success: false, error: 'Assigned staff member not found or inactive' }
  const assignedStaffId = session.user.role === 'STAFF' ? session.user.staffId : (explicitlyAssigned || dealer?.assignedStaffId || null)
  if (assignedStaffId && !(await isActiveStaff(assignedStaffId))) return { success: false, error: 'Dealer owner is inactive; assign an active staff member first' }
  const reminderAt = parseDate(parsed.data.reminderAt)
  // Due dates are entered as dates (midnight). Let a reminder be set at any time
  // during that same due day instead of incorrectly rejecting it after 12:00 AM.
  const reminderDeadline = new Date(dueDate)
  reminderDeadline.setHours(23, 59, 59, 999)
  if (reminderAt && reminderAt > reminderDeadline) return { success: false, error: 'Task reminder must be on or before the due date' }
  const task = await prisma.dealerTask.create({ data: { ...parsed.data, dueDate, reminderAt, assignedStaffId, description: parsed.data.description || null, notes: parsed.data.notes || null, type: parsed.data.type, priority: parsed.data.priority, status: 'PENDING' } as any })
  await addActivity(task.dealerId, session, 'TASK', `Task created: ${task.title}`)
  revalidatePath(DEALER_PATH)
  return { success: true, data: task }
}

export async function updateDealerTask(id: number, status: string, notes?: string) {
  const session = await actor()
  const task = await prisma.dealerTask.findUnique({ where: { id }, select: { dealerId: true, assignedStaffId: true, title: true } })
  if (!task || !session || (session.user.role === 'STAFF' && task.assignedStaffId !== session.user.staffId)) return { success: false, error: 'Access denied' }
  if (!dealerTaskStatuses.includes(status as any)) return { success: false, error: 'Invalid task status' }
  const updated = await prisma.dealerTask.update({ where: { id }, data: { status: status as any, notes: notes || undefined, completedAt: status === 'COMPLETED' ? new Date() : null } })
  await addActivity(task.dealerId, session, 'TASK', `Task ${status.toLowerCase()}: ${task.title}`)
  revalidatePath(DEALER_PATH)
  return { success: true, data: updated }
}

export async function createDealerVisit(input: unknown) {
  const parsed = dealerVisitSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const session = await actor()
  if (!session || !(await canAccessDealer(parsed.data.dealerId, session))) return { success: false, error: 'Access denied' }
  const visitDate = parseDate(parsed.data.visitDate)
  if (!visitDate) return { success: false, error: 'Enter a valid visit date' }
  if (session.user.role === 'STAFF' && !session.user.staffId) return { success: false, error: 'Your staff account is not linked to a staff profile' }
  const dealer = await prisma.dealer.findUnique({ where: { id: parsed.data.dealerId }, select: { assignedStaffId: true } })
  const explicitlyAssigned = parsed.data.staffId || null
  if (explicitlyAssigned && !(await isActiveStaff(explicitlyAssigned))) return { success: false, error: 'Visit staff member not found or inactive' }
  const visitStaffId = session.user.role === 'STAFF' ? session.user.staffId : (explicitlyAssigned || dealer?.assignedStaffId || null)
  if (visitStaffId && !(await isActiveStaff(visitStaffId))) return { success: false, error: 'Dealer owner is inactive; assign an active staff member first' }
  const nextFollowUpAt = parseDate(parsed.data.nextFollowUpAt)
  const visit = await prisma.dealerVisit.create({ data: { dealerId: parsed.data.dealerId, staffId: visitStaffId, visitDate, purpose: parsed.data.purpose, personMet: parsed.data.personMet || null, outcome: parsed.data.outcome || null, nextAction: parsed.data.nextAction || null, nextFollowUpAt, nextMeetingAt: parseDate(parsed.data.nextMeetingAt), samplesShown: parsed.data.samplesShown || null, priceListShared: parsed.data.priceListShared, dealerFeedback: parsed.data.dealerFeedback || null, photoUrls: parsed.data.photoUrls, documentUrls: parsed.data.documentUrls, notes: parsed.data.notes || null } })
  await prisma.dealer.update({ where: { id: visit.dealerId }, data: { lastContactAt: visitDate, ...(nextFollowUpAt ? { nextFollowUpAt } : {}) } })
  await addActivity(visit.dealerId, session, 'VISIT', `Dealer visit recorded: ${visit.purpose}`, visit.outcome || undefined)
  revalidatePath(DEALER_PATH)
  return { success: true, data: visit }
}

const allowedOrderTransitions: Record<string, string[]> = {
  ENQUIRY: ['QUOTATION_SHARED', 'CANCELLED'], QUOTATION_SHARED: ['ORDER_RECEIVED', 'APPROVAL_PENDING', 'CANCELLED'],
  ORDER_RECEIVED: ['APPROVAL_PENDING', 'CANCELLED'], APPROVAL_PENDING: ['APPROVED', 'CANCELLED'],
  APPROVED: ['ALLOCATED', 'CANCELLED'], ALLOCATED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED', 'RETURNED'], DELIVERED: ['RETURNED'], CANCELLED: [], RETURNED: [],
}

const allowedClaimTransitions: Record<string, string[]> = {
  OPEN: ['UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['RESOLVED'],
  REJECTED: [],
  RESOLVED: [],
}

async function nextDealerOrderDisplayId() {
  const year = new Date().getFullYear()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const displayId = `DO-${year}-${Date.now().toString().slice(-7)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}${attempt ? `-${attempt}` : ''}`
    const existing = await prisma.dealerOrder.findUnique({ where: { displayId }, select: { id: true } })
    if (!existing) return displayId
  }
  return `DO-${year}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export async function createDealerOrder(input: unknown) {
  const parsed = dealerOrderSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const session = await actor()
  if (!session || !(await canAccessDealer(parsed.data.dealerId, session))) return { success: false, error: 'Access denied' }
  if (session.user.role === 'STAFF' && !session.user.staffId) return { success: false, error: 'Your staff account is not linked to a staff profile' }
  const dealer = await prisma.dealer.findUnique({ where: { id: parsed.data.dealerId }, select: { creditLimit: true, creditDays: true, businessName: true, assignedStaffId: true } })
  if (!dealer) return { success: false, error: 'Dealer not found' }
  const explicitlyAssigned = session.user.role === 'STAFF' ? session.user.staffId : (parsed.data.salespersonId || null)
  const salespersonId = explicitlyAssigned || dealer.assignedStaffId || null
  if (salespersonId) {
    if (!(await isActiveStaff(salespersonId))) return { success: false, error: explicitlyAssigned ? 'Sales owner not found or inactive' : 'Dealer owner is inactive; assign an active staff member first' }
  }
  const productIds = [...new Set(parsed.data.items.map(item => item.productId).filter(Boolean) as number[])]
  const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, sku: true, price: true, costPrice: true, unitOfMeasure: true } })
  const productMap = new Map(products.map(product => [product.id, product]))
  let items
  try {
    items = parsed.data.items.map(item => {
      const product = item.productId ? productMap.get(item.productId) : null
      if (item.productId && !product) throw new Error('One selected product no longer exists')
      const rate = Number(item.rate || product?.price || 0)
      const amount = Math.round(rate * Number(item.quantity))
      if (rate <= 0 || amount <= 0) throw new Error(`Enter a valid rate for ${product?.name || item.name || 'the custom item'}`)
      const costRate = Number(product?.costPrice || 0)
      const marginAmount = amount - Math.round(costRate * Number(item.quantity))
      return { productId: product?.id || null, name: product?.name || item.name || 'Custom material', sku: product?.sku || item.sku || null, quantity: item.quantity, unitOfMeasure: product?.unitOfMeasure || item.unitOfMeasure, areaSqft: item.areaSqft || null, rate, amount, costRate, marginAmount, shadeCode: item.shadeCode || null, lotNumber: item.lotNumber || null, notes: item.notes || null }
    })
  } catch (error: any) {
    return { success: false, error: error?.message || 'One order line is invalid' }
  }
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0)
  if (parsed.data.discount > subtotal) return { success: false, error: 'Discount cannot be higher than subtotal' }
  const taxable = subtotal - parsed.data.discount
  const gst = Math.round(taxable * (parsed.data.gstPercent / 100))
  const total = taxable + gst + parsed.data.freight + parsed.data.loading + parsed.data.installation
  const estimatedCost = items.reduce((sum, item) => sum + Math.round(Number(item.costRate || 0) * Number(item.quantity || 0)), 0)
  const marginAmount = taxable - estimatedCost
  const marginPercent = taxable > 0 ? Number(((marginAmount / taxable) * 100).toFixed(2)) : 0
  if (parsed.data.amountPaid > total) return { success: false, error: 'Advance cannot be higher than order total' }
  const current = await prisma.dealerOrder.aggregate({ where: { dealerId: parsed.data.dealerId, status: { in: financiallyCommittedOrderStatuses } }, _sum: { balanceDue: true } })
  const projectedDue = Number(current._sum?.balanceDue || 0) + total - parsed.data.amountPaid
  const requestedStatus = parsed.data.status || 'ENQUIRY'
  const creditLimitExceeded = dealer.creditLimit > 0 && projectedDue > dealer.creditLimit
  const status = creditLimitExceeded && requestedStatus !== 'ENQUIRY' ? 'APPROVAL_PENDING' : requestedStatus
  const displayId = await nextDealerOrderDisplayId()
  const order = await prisma.$transaction(async tx => {
    const paymentDueDate = financiallyCommittedOrderStatuses.includes(status as DealerOrderStatus) && dealer.creditDays > 0 ? new Date(Date.now() + dealer.creditDays * 86400000) : null
    const created = await tx.dealerOrder.create({ data: { displayId, dealerId: parsed.data.dealerId, status: status as any, expectedDispatchDate: parseDate(parsed.data.expectedDispatchDate), paymentDueDate, subtotal, discount: parsed.data.discount, gst, freight: parsed.data.freight, loading: parsed.data.loading, installation: parsed.data.installation, total, amountPaid: parsed.data.amountPaid, balanceDue: total - parsed.data.amountPaid, estimatedCost, marginAmount, marginPercent, paymentStatus: parsed.data.amountPaid >= total ? 'PAID' : parsed.data.amountPaid > 0 ? 'PARTIAL' : 'PENDING', salespersonId, deliveryAddress: parsed.data.deliveryAddress || null, allocationNotes: parsed.data.allocationNotes || null, notes: parsed.data.notes || null, items: { create: items } } })
    if (parsed.data.amountPaid > 0) await tx.dealerPayment.create({ data: { dealerId: parsed.data.dealerId, dealerOrderId: created.id, amount: parsed.data.amountPaid, method: 'Advance', notes: 'Advance received with dealer order' } })
    return created
  })
  await addActivity(parsed.data.dealerId, session, 'ORDER', `Dealer order created: ${displayId}`, creditLimitExceeded ? 'Credit limit exceeded; approval required.' : undefined)
  revalidatePath(DEALER_PATH)
  return { success: true, data: order, creditLimitExceeded }
}

export async function updateDealerOrderStatus(id: number, status: string, notes?: string) {
  const session = await actor()
  const order = await prisma.dealerOrder.findUnique({ where: { id }, select: { dealerId: true, status: true, displayId: true, balanceDue: true, paymentDueDate: true, allocationNotes: true } })
  if (!order || !session || !(await canAccessDealer(order.dealerId, session))) return { success: false, error: 'Access denied' }
  if (!dealerOrderStatuses.includes(status as any)) return { success: false, error: 'Invalid order status' }
  if (order.status !== status && !allowedOrderTransitions[order.status]?.includes(status)) return { success: false, error: `Cannot move ${orderStatusLabels[order.status]} to ${orderStatusLabels[status]}` }
  const isCreditApproval = order.status === 'APPROVAL_PENDING' && status === 'APPROVED'
  if (status === 'APPROVED' && !['ADMIN', 'MANAGER'].includes(session.user.role)) return { success: false, error: 'Only a manager can approve a dealer order' }
  if (status === 'ALLOCATED' && !(notes?.trim() || order.allocationNotes?.trim())) return { success: false, error: 'Record the allocated lot, slab, batch or production reference before allocating this order' }
  // Once approved (by the limit check or by a manager over the limit), later
  // steps don't re-check credit: that dead-ended manager-approved orders.
  const alreadyApproved = ['APPROVED', 'ALLOCATED', 'DISPATCHED'].includes(order.status)
  if (!isCreditApproval && !alreadyApproved && ['ORDER_RECEIVED', 'APPROVED', 'ALLOCATED', 'DISPATCHED'].includes(status)) {
    const dealer = await prisma.dealer.findUnique({ where: { id: order.dealerId }, select: { creditLimit: true } })
    if (dealer?.creditLimit && dealer.creditLimit > 0) {
      const outstanding = await prisma.dealerOrder.aggregate({ where: { dealerId: order.dealerId, id: { not: id }, status: { in: financiallyCommittedOrderStatuses } }, _sum: { balanceDue: true } })
      const projectedDue = Number(outstanding._sum?.balanceDue || 0) + Number(order.balanceDue || 0)
      if (projectedDue > dealer.creditLimit) return { success: false, error: `Credit limit exceeded (₹${projectedDue.toLocaleString('en-IN')} due). Move this order to Approval Pending first.` }
    }
  }
  const dateFields: any = {}
  if (status === 'DISPATCHED') dateFields.dispatchDate = new Date()
  if (status === 'DELIVERED') dateFields.deliveryDate = new Date()
  if (!order.paymentDueDate && financiallyCommittedOrderStatuses.includes(status as DealerOrderStatus)) {
    const dealerTerms = await prisma.dealer.findUnique({ where: { id: order.dealerId }, select: { creditDays: true } })
    if (dealerTerms?.creditDays && dealerTerms.creditDays > 0) dateFields.paymentDueDate = new Date(Date.now() + dealerTerms.creditDays * 86400000)
  }
  const updated = await prisma.dealerOrder.update({ where: { id }, data: { status: status as any, notes: notes || undefined, ...(status === 'ALLOCATED' && notes?.trim() ? { allocationNotes: notes.trim() } : {}), ...dateFields } })
  await addActivity(order.dealerId, session, 'ORDER_STATUS', `${order.displayId} moved to ${orderStatusLabels[status]}`, notes)
  revalidatePath(DEALER_PATH)
  return { success: true, data: updated }
}

export async function recordDealerPayment(input: unknown) {
  const parsed = dealerPaymentSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const session = await actor()
  if (!session || !(await canAccessDealer(parsed.data.dealerId, session))) return { success: false, error: 'Access denied' }
  let result
  try {
    result = await prisma.$transaction(async tx => {
      const amount = parsed.data.amount
      const paymentDate = parseDate(parsed.data.paymentDate) || new Date()
      const base = { dealerId: parsed.data.dealerId, method: parsed.data.method, reference: parsed.data.reference || null, paymentDate, notes: parsed.data.notes || null }
      // Apply money to an order with a guarded increment, so two cashiers
      // recording at once can never push the balance below zero.
      const applyToOrder = async (order: { id: number; total: number }, share: number) => {
        const claimed = await tx.dealerOrder.updateMany({
          where: { id: order.id, balanceDue: { gte: share } },
          data: { amountPaid: { increment: share }, balanceDue: { decrement: share } },
        })
        if (claimed.count !== 1) throw new Error('This order balance just changed. Refresh and try again.')
        const fresh = await tx.dealerOrder.findUnique({ where: { id: order.id }, select: { amountPaid: true, total: true } })
        await tx.dealerOrder.update({ where: { id: order.id }, data: { paymentStatus: (fresh?.amountPaid || 0) >= (fresh?.total || 0) ? 'PAID' : 'PARTIAL' } })
        return tx.dealerPayment.create({ data: { ...base, dealerOrderId: order.id, amount: share } })
      }
      if (parsed.data.dealerOrderId) {
        const order = await tx.dealerOrder.findFirst({ where: { id: parsed.data.dealerOrderId, dealerId: parsed.data.dealerId }, select: { id: true, total: true, balanceDue: true, status: true } })
        if (!order) throw new Error('Dealer order not found')
        if (!financiallyCommittedOrderStatuses.includes(order.status)) throw new Error('Collection can be recorded only after the dealer order is received')
        if (amount > order.balanceDue) throw new Error('Payment cannot be higher than the order balance')
        return applyToOrder(order, amount)
      }
      // On-account payment: settle the oldest open orders first (FIFO). Anything
      // left over is kept as an advance on the dealer's account.
      const open = await tx.dealerOrder.findMany({
        where: { dealerId: parsed.data.dealerId, status: { in: financiallyCommittedOrderStatuses }, balanceDue: { gt: 0 } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, total: true, balanceDue: true },
      })
      let left = amount
      let first: any = null
      for (const order of open) {
        if (left <= 0) break
        const share = Math.min(left, order.balanceDue)
        const payment = await applyToOrder(order, share)
        first = first || payment
        left -= share
      }
      if (left > 0) {
        const advance = await tx.dealerPayment.create({ data: { ...base, dealerOrderId: null, amount: left, notes: [parsed.data.notes, 'Advance (no open order)'].filter(Boolean).join(' · ') } })
        first = first || advance
      }
      return first
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not record the payment' }
  }
  await addActivity(parsed.data.dealerId, session, 'PAYMENT', `Payment received: ₹${parsed.data.amount.toLocaleString('en-IN')}`, parsed.data.reference || undefined)
  revalidatePath(DEALER_PATH)
  return { success: true, data: result }
}

export async function createDealerClaim(input: unknown) {
  const parsed = dealerClaimSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const session = await actor()
  if (!session || !(await canAccessDealer(parsed.data.dealerId, session))) return { success: false, error: 'Access denied' }
  if (session.user.role === 'STAFF' && !session.user.staffId) return { success: false, error: 'Your staff account is not linked to a staff profile' }
  if (parsed.data.dealerOrderId) {
    const order = await prisma.dealerOrder.findFirst({ where: { id: parsed.data.dealerOrderId, dealerId: parsed.data.dealerId }, select: { id: true } })
    if (!order) return { success: false, error: 'Linked order does not belong to this dealer' }
  }
  const dealer = await prisma.dealer.findUnique({ where: { id: parsed.data.dealerId }, select: { assignedStaffId: true } })
  const explicitlyAssigned = parsed.data.assignedStaffId || null
  if (explicitlyAssigned && !(await isActiveStaff(explicitlyAssigned))) return { success: false, error: 'Claim assignee not found or inactive' }
  const claimStaffId = session.user.role === 'STAFF' ? session.user.staffId : (explicitlyAssigned || dealer?.assignedStaffId || null)
  if (claimStaffId && !(await isActiveStaff(claimStaffId))) return { success: false, error: 'Dealer owner is inactive; assign an active staff member first' }
  const claim = await prisma.dealerClaim.create({ data: { dealerId: parsed.data.dealerId, dealerOrderId: parsed.data.dealerOrderId || null, assignedStaffId: claimStaffId, type: parsed.data.type, description: parsed.data.description, quantity: parsed.data.quantity || null, claimAmount: parsed.data.claimAmount, replacementStatus: parsed.data.replacementStatus, replacementNotes: parsed.data.replacementNotes || null, notes: parsed.data.notes || null } })
  await addActivity(claim.dealerId, session, 'CLAIM', `Claim opened: ${claim.type}`)
  revalidatePath(DEALER_PATH)
  return { success: true, data: claim }
}

export async function updateDealerClaim(id: number, status: string, resolution?: string) {
  const session = await actor()
  const claim = await prisma.dealerClaim.findUnique({ where: { id }, select: { dealerId: true, type: true, status: true, replacementStatus: true } })
  if (!claim || !session || !(await canAccessDealer(claim.dealerId, session))) return { success: false, error: 'Access denied' }
  if (!dealerClaimStatuses.includes(status as any)) return { success: false, error: 'Invalid claim status' }
  if (claim.status !== status && !allowedClaimTransitions[claim.status]?.includes(status)) return { success: false, error: `Cannot move this claim from ${claim.status.replaceAll('_', ' ')} to ${status.replaceAll('_', ' ')}` }
  if (['APPROVED', 'REJECTED', 'RESOLVED'].includes(status) && !['ADMIN', 'MANAGER'].includes(session.user.role)) return { success: false, error: 'Manager access is required for a final claim decision' }
  if (status === 'RESOLVED' && !resolution?.trim()) return { success: false, error: 'Add a resolution note before closing the claim' }
  if (status === 'RESOLVED' && !['NOT_REQUIRED', 'COMPLETED'].includes(claim.replacementStatus)) return { success: false, error: 'Complete or cancel the replacement before closing this claim' }
  const updated = await prisma.dealerClaim.update({ where: { id }, data: { status: status as any, resolution: resolution || null, resolvedAt: status === 'RESOLVED' ? new Date() : null } })
  await addActivity(claim.dealerId, session, 'CLAIM', `Claim ${status.toLowerCase()}: ${claim.type}`)
  revalidatePath(DEALER_PATH)
  return { success: true, data: updated }
}

export async function updateDealerClaimReplacement(id: number, replacementStatus: string, replacementNotes?: string) {
  const session = await actor()
  const claim = await prisma.dealerClaim.findUnique({ where: { id }, select: { dealerId: true, status: true, type: true } })
  if (!claim || !session || !(await canAccessDealer(claim.dealerId, session, true))) return { success: false, error: 'Manager access required' }
  const allowed = ['NOT_REQUIRED', 'PENDING', 'APPROVED', 'DISPATCHED', 'COMPLETED']
  if (!allowed.includes(replacementStatus)) return { success: false, error: 'Invalid replacement status' }
  const updated = await prisma.dealerClaim.update({ where: { id }, data: { replacementStatus, replacementNotes: replacementNotes || null } })
  await addActivity(claim.dealerId, session, 'CLAIM_REPLACEMENT', `Replacement ${replacementStatus.toLowerCase()}: ${claim.type}`, replacementNotes)
  revalidatePath(DEALER_PATH)
  return { success: true, data: updated }
}

export async function getDealerPriceLists() {
  const session = await actor()
  if (!session) return { success: false, error: 'Unauthorized' }
  const where: any = session.user.role === 'STAFF'
    ? { OR: [{ dealerId: null }, { dealer: dealerScopeForSession(session) }] }
    : {}
  const lists = await prisma.dealerPriceList.findMany({ where, include: { dealer: { select: { id: true, businessName: true } }, items: { include: { product: { select: { id: true, name: true, sku: true, price: true, costPrice: true, unitOfMeasure: true } } } } }, orderBy: { createdAt: 'desc' } })
  return { success: true, data: lists.map(list => ({ ...list, validFrom: iso(list.validFrom), validUntil: iso(list.validUntil), createdAt: iso(list.createdAt), updatedAt: iso(list.updatedAt) })) }
}

export async function createDealerPriceList(input: unknown) {
  const session = await actor()
  if (!session || !(await canAccessDealer(0, session, true))) return { success: false, error: 'Manager access required' }
  const parsed = dealerPriceListSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const ids = parsed.data.items.map(item => item.productId)
  if (new Set(ids).size !== ids.length) return { success: false, error: 'A product can appear only once in a price list' }
  if (parsed.data.dealerId) {
    const dealer = await prisma.dealer.findUnique({ where: { id: parsed.data.dealerId }, select: { id: true } })
    if (!dealer) return { success: false, error: 'Price list dealer was not found' }
  }
  const products = await prisma.product.count({ where: { id: { in: ids } } })
  if (products !== ids.length) return { success: false, error: 'One selected product was not found' }
  const list = await prisma.dealerPriceList.create({ data: { name: parsed.data.name, dealerId: parsed.data.dealerId || null, validFrom: parseDate(parsed.data.validFrom) || new Date(), validUntil: parseDate(parsed.data.validUntil), notes: parsed.data.notes || null, items: { create: parsed.data.items } }, include: { items: true } })
  revalidatePath(DEALER_PATH)
  return { success: true, data: list }
}

export async function toggleDealerPriceList(id: number, isActive: boolean) {
  const session = await actor()
  if (!session || !(await canAccessDealer(0, session, true))) return { success: false, error: 'Manager access required' }
  const list = await prisma.dealerPriceList.update({ where: { id }, data: { isActive } })
  revalidatePath(DEALER_PATH)
  return { success: true, data: list }
}
