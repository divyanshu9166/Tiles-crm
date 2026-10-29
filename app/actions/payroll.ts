'use server'

import { guarded } from '@/lib/action-guard'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth-helpers'
import { generatePayrollSchema, updateStaffPayrollSchema } from '@/lib/validations/payroll'
import { z } from 'zod'

// ─── ATTENDANCE SUMMARY FOR PAYROLL ──────────────────
// Used to display per-staff attendance breakdown before payroll generation
// (Like Keka / GreytHR's "Attendance Summary" pre-payroll screen)

export async function getAttendanceSummaryForPayroll(...args: Parameters<typeof _getAttendanceSummaryForPayroll>): Promise<Awaited<ReturnType<typeof _getAttendanceSummaryForPayroll>>> {
  return guarded('getAttendanceSummaryForPayroll', () => _getAttendanceSummaryForPayroll(...args))
}

async function _getAttendanceSummaryForPayroll(period: string) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required', data: [] } }

  const [year, month] = period.split('-').map(Number)
  const monthStart = new Date(year, month - 1, 1)
  const nextMonth  = month === 12 ? new Date(year + 1, 0, 1) : new Date(year, month, 1)

  const staffList = await prisma.staff.findMany({
    where: { status: 'Active' },
    select: {
      id: true,
      name: true,
      role: true,
      basicSalary: true,
      attendance: {
        where: { date: { gte: monthStart, lt: nextMonth } },
        select: { status: true, hours: true, clockIn: true, clockOut: true, date: true, isLate: true },
        orderBy: { date: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  })

  const summary = staffList.map(s => {
    const att = s.attendance
    const present  = att.filter(a => { const n = (a.status||'').toLowerCase(); return n === 'present' || n === 'late' }).length
    const absent   = att.filter(a => { const n = (a.status||'').toLowerCase(); return n === 'absent' }).length
    const halfDay  = att.filter(a => { const n = (a.status||'').toLowerCase(); return n === 'half day' || n === 'half-day' }).length
    const late     = att.filter(a => a.isLate).length
    const otDays   = att.filter(a => (a.status||'').toUpperCase() === 'OT').length
    const totalHrs = att.reduce((sum, a) => sum + (a.hours || 0), 0)
    const otHours  = att.reduce((sum, a) => {
      const status = (a.status || '').toUpperCase()
      if (status === 'OT') return sum + Math.max(0, a.hours || 0)
      const dayCredit = (status === 'ABSENT' || status === 'OFF DUTY') ? 0 : (status === 'HALF DAY' || status === 'HALF-DAY') ? 0.5 : 1
      if (dayCredit <= 0 || a.hours == null) return sum
      const baseline = dayCredit >= 1 ? 8 : 4
      return sum + Math.max(0, a.hours - baseline)
    }, 0)

    const payableDays  = present + (halfDay * 0.5)
    const lopDays      = absent + (halfDay * 0.5)

    return {
      id: s.id,
      name: s.name,
      role: s.role,
      basicSalary: s.basicSalary || 0,
      totalLogged: att.length,
      present,
      absent,
      halfDay,
      late,
      otDays,
      otHours: Math.round(otHours * 10) / 10,
      totalHrs: Math.round(totalHrs * 10) / 10,
      payableDays: Math.round(payableDays * 10) / 10,
      lopDays: Math.round(lopDays * 10) / 10,
      hasAttendance: att.length > 0,
    }
  })

  return { success: true, data: summary }
}

// ─── PROFESSIONAL TAX SLABS (state-wise) ─────────────
// Monthly gross → PT amount
const PT_SLABS: Record<string, { upTo: number; tax: number }[]> = {
  Maharashtra: [
    { upTo: 7500, tax: 0 },
    { upTo: 10000, tax: 175 },
    { upTo: Infinity, tax: 200 }, // 300 in Feb
  ],
  Karnataka: [
    { upTo: 15000, tax: 0 },
    { upTo: 25000, tax: 150 },
    { upTo: 35000, tax: 200 },
    { upTo: Infinity, tax: 200 },
  ],
  'West Bengal': [
    { upTo: 10000, tax: 0 },
    { upTo: 15000, tax: 110 },
    { upTo: 25000, tax: 130 },
    { upTo: 40000, tax: 150 },
    { upTo: Infinity, tax: 200 },
  ],
  'Tamil Nadu': [
    { upTo: 21000, tax: 0 },
    { upTo: Infinity, tax: 208 },
  ],
  Gujarat: [
    { upTo: 5999, tax: 0 },
    { upTo: 8999, tax: 80 },
    { upTo: 11999, tax: 150 },
    { upTo: Infinity, tax: 200 },
  ],
  Andhra: [
    { upTo: 15000, tax: 0 },
    { upTo: 20000, tax: 150 },
    { upTo: Infinity, tax: 200 },
  ],
  Telangana: [
    { upTo: 15000, tax: 0 },
    { upTo: 20000, tax: 150 },
    { upTo: Infinity, tax: 200 },
  ],
  // Default (no PT state)
  None: [{ upTo: Infinity, tax: 0 }],
}

function calcProfessionalTax(state: string, grossSalary: number, period?: string): number {
  const slabs = PT_SLABS[state] || PT_SLABS['None']
  for (const slab of slabs) {
    if (grossSalary <= slab.upTo) {
      // Maharashtra has an extra PT charge in February for higher salary slabs.
      if (state === 'Maharashtra' && slab.tax === 200 && grossSalary > 10000 && period) {
        const month = Number(period.split('-')[1])
        if (month === 2) return 300
      }
      return slab.tax
    }
  }
  return 0
}

function attendanceDayCredit(status: string): number {
  const normalized = (status || '').trim().toLowerCase()
  if (normalized === 'absent' || normalized === 'off duty' || normalized === 'off-duty') return 0
  if (normalized === 'half day' || normalized === 'half-day') return 0.5
  return 1
}

function overtimeHoursFromAttendance(entries: { status: string; hours: number | null }[]): number {
  return entries.reduce((sum, entry) => {
    const status = (entry.status || '').trim().toUpperCase()

    if (status === 'OT') {
      return sum + Math.max(0, entry.hours || 0)
    }

    const dayCredit = attendanceDayCredit(entry.status)
    if (dayCredit <= 0 || entry.hours == null) return sum

    const baselineHours = dayCredit >= 1 ? 8 : 4
    return sum + Math.max(0, entry.hours - baselineHours)
  }, 0)
}

// ─── PRE-PAYROLL READINESS ──────────────────────────

export async function getPayrollReadiness(...args: Parameters<typeof _getPayrollReadiness>): Promise<Awaited<ReturnType<typeof _getPayrollReadiness>>> {
  return guarded('getPayrollReadiness', () => _getPayrollReadiness(...args))
}

async function _getPayrollReadiness(period?: string) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }

  const targetPeriod = period || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
  const [year, month] = targetPeriod.split('-').map(Number)
  const monthStart = new Date(year, month - 1, 1)
  const nextMonth = month === 12 ? new Date(year + 1, 0, 1) : new Date(year, month, 1)

  const [staffList, attendanceRows] = await Promise.all([
    prisma.staff.findMany({
      where: { status: 'Active' },
      select: {
        id: true,
        name: true,
        basicSalary: true,
        bankAccount: true,
        bankName: true,
        ifscCode: true,
        pfEnrolled: true,
        uanNumber: true,
        esiEnrolled: true,
        esiNumber: true,
        panNumber: true,
        tdsMonthly: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.attendance.findMany({
      where: { date: { gte: monthStart, lt: nextMonth } },
      select: { staffId: true },
    }),
  ])

  const staffWithAttendance = new Set(attendanceRows.map(row => row.staffId))

  const missingBasic = staffList.filter(s => !s.basicSalary).map(s => s.name)
  const missingBankDetails = staffList
    .filter(s => !s.bankAccount || !s.bankName || !s.ifscCode)
    .map(s => s.name)
  const missingPFCompliance = staffList
    .filter(s => s.pfEnrolled && !s.uanNumber)
    .map(s => s.name)
  const missingESICompliance = staffList
    .filter(s => s.esiEnrolled && !s.esiNumber)
    .map(s => s.name)
  const missingPanForTds = staffList
    .filter(s => (s.tdsMonthly || 0) > 0 && !s.panNumber)
    .map(s => s.name)
  const noAttendanceConfigured = staffList
    .filter(s => !staffWithAttendance.has(s.id))
    .map(s => s.name)

  const blockers: string[] = []
  const warnings: string[] = []

  if (staffList.length === 0) blockers.push('No active staff found.')
  if (missingBasic.length > 0) blockers.push(`${missingBasic.length} staff are missing basic salary.`)
  if (missingBankDetails.length > 0) warnings.push(`${missingBankDetails.length} staff are missing bank details (A/C, bank name, or IFSC).`)
  if (missingPFCompliance.length > 0) warnings.push(`${missingPFCompliance.length} PF-enrolled staff are missing UAN.`)
  if (missingESICompliance.length > 0) warnings.push(`${missingESICompliance.length} ESI-enrolled staff are missing ESI number.`)
  if (missingPanForTds.length > 0) warnings.push(`${missingPanForTds.length} staff have TDS set but PAN is missing.`)
  if (noAttendanceConfigured.length > 0) warnings.push(`${noAttendanceConfigured.length} staff have no attendance in this period; full working days will be assumed.`)

  return {
    success: true,
    data: {
      period: targetPeriod,
      activeStaff: staffList.length,
      blockers,
      warnings,
      details: {
        missingBasic,
        missingBankDetails,
        missingPFCompliance,
        missingESICompliance,
        missingPanForTds,
        noAttendanceConfigured,
      },
    },
  }
}

// ─── STAFF PAYROLL SETTINGS ──────────────────────────

export async function getStaffForPayroll(...args: Parameters<typeof _getStaffForPayroll>): Promise<Awaited<ReturnType<typeof _getStaffForPayroll>>> {
  return guarded('getStaffForPayroll', () => _getStaffForPayroll(...args))
}

async function _getStaffForPayroll() {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required', data: [] } }

  const staff = await prisma.staff.findMany({
    where: { status: 'Active' },
    select: {
      id: true, name: true, role: true, designation: true,
      basicSalary: true, panNumber: true, bankAccount: true,
      bankName: true, ifscCode: true, pfEnrolled: true, esiEnrolled: true,
      uanNumber: true, pfNumber: true, esiNumber: true,
      professionalTaxState: true, tdsMonthly: true,
      loans: { where: { status: 'Active' }, select: { id: true, purpose: true, remainingAmount: true, monthlyInstallment: true } },
    },
    orderBy: { name: 'asc' },
  })
  return { success: true, data: staff }
}

export async function updateStaffPayrollInfo(...args: Parameters<typeof _updateStaffPayrollInfo>): Promise<Awaited<ReturnType<typeof _updateStaffPayrollInfo>>> {
  return guarded('updateStaffPayrollInfo', () => _updateStaffPayrollInfo(...args))
}

async function _updateStaffPayrollInfo(data: unknown) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const parsed = updateStaffPayrollSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { staffId, ...rest } = parsed.data
  await prisma.staff.update({ where: { id: staffId }, data: rest })
  revalidatePath('/payroll')
  return { success: true }
}

// ─── LOANS & ADVANCES ────────────────────────────────

const loanSchema = z.object({
  staffId: z.number(),
  purpose: z.string().min(1),
  principalAmount: z.number().min(1),
  monthlyInstallment: z.number().min(1),
  startPeriod: z.string().regex(/^\d{4}-\d{2}$/),
  notes: z.string().optional(),
}).refine((data) => data.monthlyInstallment <= data.principalAmount, {
  message: 'Monthly installment cannot exceed principal amount',
  path: ['monthlyInstallment'],
})

export async function getStaffLoans(...args: Parameters<typeof _getStaffLoans>): Promise<Awaited<ReturnType<typeof _getStaffLoans>>> {
  return guarded('getStaffLoans', () => _getStaffLoans(...args))
}

async function _getStaffLoans(staffId?: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required', data: [] } }

  const loans = await prisma.staffLoan.findMany({
    where: staffId ? { staffId } : undefined,
    include: { staff: { select: { name: true, role: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return { success: true, data: loans }
}

export async function createStaffLoan(...args: Parameters<typeof _createStaffLoan>): Promise<Awaited<ReturnType<typeof _createStaffLoan>>> {
  return guarded('createStaffLoan', () => _createStaffLoan(...args))
}

async function _createStaffLoan(data: unknown) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const parsed = loanSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const staff = await prisma.staff.findUnique({ where: { id: parsed.data.staffId }, select: { status: true } })
  if (!staff || staff.status !== 'Active') {
    return { success: false, error: 'Loan can only be created for active staff.' }
  }

  const loan = await prisma.staffLoan.create({
    data: {
      ...parsed.data,
      remainingAmount: parsed.data.principalAmount,
    },
  })
  revalidatePath('/payroll')
  return { success: true, data: loan }
}

export async function closeStaffLoan(...args: Parameters<typeof _closeStaffLoan>): Promise<Awaited<ReturnType<typeof _closeStaffLoan>>> {
  return guarded('closeStaffLoan', () => _closeStaffLoan(...args))
}

async function _closeStaffLoan(id: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  await prisma.staffLoan.update({ where: { id }, data: { status: 'Closed', remainingAmount: 0 } })
  revalidatePath('/payroll')
  return { success: true }
}

// ─── GENERATE PAYROLL ────────────────────────────────

export async function generatePayroll(...args: Parameters<typeof _generatePayroll>): Promise<Awaited<ReturnType<typeof _generatePayroll>>> {
  return guarded('generatePayroll', () => _generatePayroll(...args))
}

async function _generatePayroll(data: unknown) {
  let session
  try { session = await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const parsed = generatePayrollSchema.safeParse(data)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { period, workingDays, lopOverrides = {} } = parsed.data

  // Check if already finalized
  const existing = await prisma.payrollRun.findFirst({ where: { period } })
  if (existing && existing.status !== 'DRAFT') {
    return { success: false, error: `Payroll for ${period} is already ${existing.status}. Cannot re-generate.` }
  }

  // Build date range for attendance
  const [year, month] = period.split('-').map(Number)
  const currentMonth = new Date(year, month - 1, 1)
  const nextMonth = month === 12 ? new Date(year + 1, 0, 1) : new Date(year, month, 1)

  // Fetch all active staff with attendance + active loans
  const staffList = await prisma.staff.findMany({
    where: { status: 'Active' },
    include: {
      attendance: {
        where: { date: { gte: currentMonth, lt: nextMonth } },
        select: { status: true, hours: true },
      },
      loans: { where: { status: 'Active' } },
    },
    orderBy: { name: 'asc' },
  })

  if (staffList.length === 0) {
    return { success: false, error: 'No active staff found. Add staff before generating payroll.' }
  }

  const staffMissingBasic = staffList.filter(staff => (staff.basicSalary || 0) <= 0)
  if (staffMissingBasic.length > 0) {
    return { success: false, error: `Configure basic salary for ${staffMissingBasic.length} staff before generating payroll.` }
  }

  let totalGross = 0, totalDeductions = 0, totalNet = 0, totalEmployerContributions = 0

  const payslipData = staffList.map(staff => {
    // ── Attendance-based day credits ──────────────────────────────────────
    // If admin has provided a manual LOP override for this staff, use it.
    // Otherwise fall back to attendance records (or assume full month if none logged).
    const hasAttendance = staff.attendance.length > 0
    const manualLopDays = lopOverrides[String(staff.id)] !== undefined
      ? Number(lopOverrides[String(staff.id)])
      : null

    let attendanceCredits: number
    let presentDaysCalc: number

    if (manualLopDays !== null) {
      // Admin explicitly set LOP — trust it
      attendanceCredits = workingDays - manualLopDays
      presentDaysCalc   = attendanceCredits
    } else if (hasAttendance) {
      attendanceCredits = staff.attendance.reduce((sum, entry) => sum + attendanceDayCredit(entry.status), 0)
      presentDaysCalc   = staff.attendance.reduce((sum, entry) => {
        const credit = attendanceDayCredit(entry.status)
        return sum + (credit > 0 ? credit : 0)
      }, 0)
    } else {
      // No attendance logged → full working days (warning already surfaced in readiness)
      attendanceCredits = workingDays
      presentDaysCalc   = workingDays
    }

    const payableDays = Math.min(workingDays, Math.max(0, attendanceCredits))
    // presentDays stored as Int (schema); round to nearest half
    const presentDays = Math.round(Math.min(workingDays, presentDaysCalc) * 2) / 2

    // OT: explicitly marked OT entries or hours beyond baseline shift.
    const otHours = overtimeHoursFromAttendance(staff.attendance)

    // Basic (pro-rated)
    const basic = staff.basicSalary || 0
    const dailyRate = workingDays > 0 ? basic / workingDays : 0
    const effectiveBasic = Math.round(dailyRate * payableDays)

    // Earnings
    const hra = Math.round(effectiveBasic * 0.40)           // 40%
    const da = Math.round(effectiveBasic * 0.10)            // 10%
    const hourlyRate = effectiveBasic > 0 ? Math.round(effectiveBasic / (workingDays * 8)) : 0
    const otPay = Math.round(hourlyRate * otHours * 2)      // OT at double rate

    // Statutory Bonus: 8.33% of basic (payable monthly as provision)
    const bonus = staff.pfEnrolled ? Math.round(effectiveBasic * 0.0833) : 0

    const grossSalary = effectiveBasic + hra + da + otPay   // bonus kept separate (employer expense)

    // Deductions
    const pfEmployee = staff.pfEnrolled ? Math.round(effectiveBasic * 0.12) : 0
    const pfEmployer = staff.pfEnrolled ? Math.round(effectiveBasic * 0.12) : 0
    const esiEmployee = (staff.esiEnrolled && grossSalary <= 21000) ? Math.round(grossSalary * 0.0075) : 0
    const esiEmployer = (staff.esiEnrolled && grossSalary <= 21000) ? Math.round(grossSalary * 0.0325) : 0

    // Professional Tax (state-wise slab on gross)
    const professionalTax = calcProfessionalTax(staff.professionalTaxState || 'None', grossSalary, period)

    // TDS (fixed monthly amount configured per staff)
    const tds = staff.tdsMonthly || 0

    // Loan deductions — only loans that have started by this payroll period
    let requestedLoanDeduction = 0
    const eligibleLoans = staff.loans.filter(loan => loan.startPeriod <= period)
    for (const loan of eligibleLoans) {
      const installment = Math.min(loan.monthlyInstallment, loan.remainingAmount)
      requestedLoanDeduction += installment
    }

    // Guard against over-deduction; loan recovery should not push net below zero by itself.
    const maxLoanRecoverable = Math.max(0, grossSalary - (pfEmployee + esiEmployee + professionalTax + tds))
    const loanDeduction = Math.min(requestedLoanDeduction, maxLoanRecoverable)

    const totalDeductionsStaff = pfEmployee + esiEmployee + professionalTax + tds + loanDeduction
    const netSalary = Math.max(0, grossSalary - totalDeductionsStaff)

    totalGross += grossSalary
    totalDeductions += totalDeductionsStaff
    totalNet += netSalary
    totalEmployerContributions += pfEmployer + esiEmployer + bonus

    return {
      staffId: staff.id,
      workingDays,
      presentDays,
      basicSalary: effectiveBasic,
      hra, da,
      specialAllowance: 0,
      otHours,
      otPay,
      bonus,
      grossSalary,
      pfEmployee,
      pfEmployer,
      esiEmployee,
      esiEmployer,
      professionalTax,
      tds,
      loanDeduction,
      otherDeductions: 0,
      totalDeductions: totalDeductionsStaff,
      netSalary,
    }
  })

  const displayId = `PAY-${period}`

  const run = await prisma.$transaction(async (tx) => {
    // Delete existing draft if re-generating
    if (existing) {
      await tx.payslip.deleteMany({ where: { payrollRunId: existing.id } })
      await tx.payrollRun.delete({ where: { id: existing.id } })
    }

    // Create payroll run
    const newRun = await tx.payrollRun.create({
      data: {
        displayId,
        period,
        totalGross,
        totalDeductions,
        totalNet,
        employerContributions: totalEmployerContributions,
        processedBy: session?.user?.name || session?.user?.email || null,
        payslips: { create: payslipData },
      },
      include: {
        payslips: {
          include: {
            staff: {
              select: {
                name: true, role: true, designation: true,
                bankAccount: true, bankName: true, ifscCode: true,
                panNumber: true, uanNumber: true, pfNumber: true, esiNumber: true,
              },
            },
          },
          orderBy: { staff: { name: 'asc' } },
        },
      },
    })

    return newRun
  })

  revalidatePath('/payroll')
  return { success: true, data: run }
}

// ─── PAYROLL RUNS ────────────────────────────────────

export async function getPayrollHistory(...args: Parameters<typeof _getPayrollHistory>): Promise<Awaited<ReturnType<typeof _getPayrollHistory>>> {
  return guarded('getPayrollHistory', () => _getPayrollHistory(...args))
}

async function _getPayrollHistory() {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required', data: [] } }

  const runs = await prisma.payrollRun.findMany({
    orderBy: { period: 'desc' },
    include: { _count: { select: { payslips: true } } },
  })
  return { success: true, data: runs }
}

export async function getPayrollRun(...args: Parameters<typeof _getPayrollRun>): Promise<Awaited<ReturnType<typeof _getPayrollRun>>> {
  return guarded('getPayrollRun', () => _getPayrollRun(...args))
}

async function _getPayrollRun(id: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }

  const run = await prisma.payrollRun.findUnique({
    where: { id },
    include: {
      payslips: {
        include: {
          staff: {
            select: {
              name: true, role: true, designation: true,
              phone: true, email: true,
              bankAccount: true, bankName: true, ifscCode: true,
              panNumber: true, uanNumber: true, pfNumber: true, esiNumber: true,
            },
          },
        },
        orderBy: { staff: { name: 'asc' } },
      },
    },
  })
  if (!run) return { success: false, error: 'Payroll run not found' }
  return { success: true, data: run }
}

export async function getAllPayslips(...args: Parameters<typeof _getAllPayslips>): Promise<Awaited<ReturnType<typeof _getAllPayslips>>> {
  return guarded('getAllPayslips', () => _getAllPayslips(...args))
}

async function _getAllPayslips(period?: string) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required', data: [] } }

  const payslips = await prisma.payslip.findMany({
    where: period ? { payrollRun: { period } } : undefined,
    include: {
      staff: {
        select: {
          name: true,
          role: true,
          designation: true,
          phone: true,
          email: true,
          panNumber: true,
          uanNumber: true,
          bankAccount: true,
          bankName: true,
        },
      },
      payrollRun: { select: { period: true, status: true, displayId: true } },
    },
    orderBy: [{ payrollRun: { period: 'desc' } }, { staff: { name: 'asc' } }],
  })
  return { success: true, data: payslips }
}

export async function approvePayroll(...args: Parameters<typeof _approvePayroll>): Promise<Awaited<ReturnType<typeof _approvePayroll>>> {
  return guarded('approvePayroll', () => _approvePayroll(...args))
}

async function _approvePayroll(id: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const run = await prisma.payrollRun.findUnique({ where: { id }, select: { status: true } })
  if (!run) return { success: false, error: 'Payroll run not found' }
  if (run.status !== 'DRAFT') return { success: false, error: `Cannot approve a ${run.status} payroll` }

  await prisma.payrollRun.update({ where: { id }, data: { status: 'APPROVED' } })
  revalidatePath('/payroll')
  return { success: true }
}

export async function markPayrollPaid(...args: Parameters<typeof _markPayrollPaid>): Promise<Awaited<ReturnType<typeof _markPayrollPaid>>> {
  return guarded('markPayrollPaid', () => _markPayrollPaid(...args))
}

async function _markPayrollPaid(id: number) {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }
  const run = await prisma.payrollRun.findUnique({
    where: { id },
    select: {
      status: true,
      period: true,
      payslips: { select: { staffId: true, loanDeduction: true } },
    },
  })
  if (!run) return { success: false, error: 'Payroll run not found' }
  if (run.status !== 'APPROVED') return { success: false, error: 'Payroll must be APPROVED before marking as paid' }

  await prisma.$transaction(async (tx) => {
    await tx.payrollRun.update({ where: { id }, data: { status: 'PAID', paidAt: new Date() } })

    // Apply loan deductions only when payroll is actually paid.
    for (const payslip of run.payslips) {
      let pendingDeduction = payslip.loanDeduction || 0
      if (pendingDeduction <= 0) continue

      const loans = await tx.staffLoan.findMany({
        where: {
          staffId: payslip.staffId,
          status: 'Active',
          startPeriod: { lte: run.period },
        },
        orderBy: { createdAt: 'asc' },
      })

      for (const loan of loans) {
        if (pendingDeduction <= 0) break

        const scheduledInstallment = Math.min(loan.monthlyInstallment, loan.remainingAmount)
        const applied = Math.min(scheduledInstallment, pendingDeduction)
        if (applied <= 0) continue

        const newRemaining = loan.remainingAmount - applied
        await tx.staffLoan.update({
          where: { id: loan.id },
          data: {
            remainingAmount: newRemaining,
            status: newRemaining <= 0 ? 'Closed' : 'Active',
          },
        })

        pendingDeduction -= applied
      }
    }
  })

  revalidatePath('/payroll')
  return { success: true }
}
