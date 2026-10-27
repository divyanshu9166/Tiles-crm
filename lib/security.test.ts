import { beforeEach, describe, expect, it, vi } from 'vitest'

// Behaviour of the Phase 1 security fixes, with the session and database mocked.

type Session = { user: { id: string; email: string; name: string; role: 'ADMIN' | 'MANAGER' | 'STAFF'; staffId: number | null } } | null
const state = vi.hoisted(() => ({ session: null as Session }))

vi.mock('@/lib/auth-helpers', () => ({
  requireAuth: vi.fn(async () => {
    if (!state.session) throw new Error('Unauthorized')
    return state.session
  }),
  requireRole: vi.fn(async (...roles: string[]) => {
    if (!state.session) throw new Error('Unauthorized')
    if (!roles.includes(state.session.user.role)) throw new Error('Forbidden')
    return state.session
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const db = vi.hoisted(() => {
  const fn = () => vi.fn(async (..._args: unknown[]) => null as unknown)
  return {
    storeSettings: { findFirst: fn(), create: fn(), upsert: fn() },
    staff: { findUnique: fn(), findMany: vi.fn(async () => [] as unknown[]) },
    dailyPayment: { deleteMany: fn(), updateMany: fn() },
    expense: { create: fn(), updateMany: fn(), findUnique: fn() },
    dailyCashRegister: { upsert: fn(), updateMany: fn() },
    channelConfig: { findMany: vi.fn(async () => [] as unknown[]), findUnique: fn(), upsert: fn() },
    attendance: { findUnique: fn() },
    $queryRaw: fn(),
    $executeRaw: fn(),
    $transaction: vi.fn(async (fnOrList: unknown) => (typeof fnOrList === 'function' ? (fnOrList as (tx: unknown) => unknown)(db) : fnOrList)),
  }
})
vi.mock('@/lib/db', () => ({ prisma: db }))

import { getStoreSettings, updateStoreSettings } from '@/app/actions/settings'
import { getStaff, getStaffMember, clockIn, verifyStaffPortalPassword } from '@/app/actions/staff'
import { deleteDailyPayment, reversePayment, updateOpeningCash } from '@/app/actions/payments'
import { createExpense, approveExpense } from '@/app/actions/expenses'
import { getChannelConfigs, upsertChannelConfig } from '@/app/actions/channels'

const admin: Session = { user: { id: '1', email: 'a@x', name: 'Admin', role: 'ADMIN', staffId: null } }
const staff5: Session = { user: { id: '9', email: 's@x', name: 'Ravi', role: 'STAFF', staffId: 5 } }

beforeEach(() => {
  vi.clearAllMocks()
  state.session = null
})

describe('signed-out callers are refused before any data is read', () => {
  it.each([
    ['getStoreSettings', () => getStoreSettings()],
    ['getStaff', () => getStaff()],
    ['getChannelConfigs', () => getChannelConfigs()],
    ['deleteDailyPayment', () => deleteDailyPayment(1)],
    ['createExpense', () => createExpense({ date: '2026-10-27', categoryId: 1, amount: 500, description: 'x' })],
  ])('%s', async (_name, call) => {
    const res = await call() as { success: boolean }
    expect(res.success).toBe(false)
    expect(db.storeSettings.findFirst).not.toHaveBeenCalled()
    expect(db.staff.findMany).not.toHaveBeenCalled()
    expect(db.channelConfig.findMany).not.toHaveBeenCalled()
    expect(db.dailyPayment.deleteMany).not.toHaveBeenCalled()
    expect(db.expense.create).not.toHaveBeenCalled()
  })
})

describe('staff are limited to their own records', () => {
  beforeEach(() => { state.session = staff5 })

  it('cannot clock in someone else or test a colleague\'s password', async () => {
    expect((await clockIn(6)).error).toMatch(/your own staff record/)
    expect((await verifyStaffPortalPassword(6, 'guess')).error).toMatch(/your own staff record/)
    expect(db.attendance.findUnique).not.toHaveBeenCalled()
  })

  it('cannot read salary/bank details or touch the cash book', async () => {
    expect((await getStaffMember(5)).success).toBe(false)
    expect((await deleteDailyPayment(1)).error).toMatch(/admin/i)
    expect((await reversePayment(1)).success).toBe(false)
    expect((await updateOpeningCash('2026-10-27', 1000)).success).toBe(false)
    expect((await approveExpense(1)).success).toBe(false)
  })

  it('submits expenses for approval, as themselves, without moving cash', async () => {
    db.expense.create.mockImplementationOnce(async (...args: unknown[]) => ({ id: 1, ...(args[0] as { data: Record<string, unknown> }).data }))
    await createExpense({ date: '2026-10-27', categoryId: 1, amount: 500, description: 'Tea', paymentMode: 'Cash', staffId: 99 })
    const data = (db.expense.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data
    expect(data.status).toBe('Pending')
    expect(data.staffId).toBe(5)
    expect(db.dailyCashRegister.upsert).not.toHaveBeenCalled()
  })

  it('sees colleagues by name only', async () => {
    db.staff.findMany.mockResolvedValueOnce([
      { id: 5, name: 'Ravi', role: 'Sales', status: 'Active', avatar: null, phone: '1', email: 'r@x', user: null, attendance: [], activities: [], fieldVisits: [], stockUpdates: [], stats: null, target: null, commission: null, joinDate: null },
      { id: 6, name: 'Meena', role: 'Sales', status: 'Active', avatar: null, phone: '2', email: 'm@x', user: null, attendance: [], activities: [], fieldVisits: [], stockUpdates: [], stats: null, target: null, commission: null, joinDate: null },
    ])
    const res = await getStaff()
    const colleague = res.data.find((member: { id: number }) => member.id === 6)
    expect(colleague).toEqual({ id: 6, name: 'Meena', role: 'Sales', status: 'Active', avatar: null })
    expect(res.data.find((member: { id: number }) => member.id === 5)).toHaveProperty('phone', '1')
  })
})

describe('secrets never leave the server', () => {
  beforeEach(() => { state.session = admin })

  it('store settings report whether an SMTP password is set, never the password', async () => {
    db.storeSettings.findFirst.mockResolvedValueOnce({ id: 1, storeName: 'Shop', smtpPass: 'app-password-123', smtpHost: 'smtp.x' } as never)
    const res = await getStoreSettings()
    expect(res.success).toBe(true)
    expect(JSON.stringify(res)).not.toContain('app-password-123')
    expect(res.success && res.data.smtpPassSet).toBe(true)
  })

  it('saving settings with a blank SMTP password keeps the stored one', async () => {
    db.storeSettings.upsert.mockResolvedValueOnce({} as never)
    await updateStoreSettings({ smtpHost: 'smtp.x', smtpPass: '' })
    const args = (db.storeSettings.upsert.mock.calls[0] as unknown as [{ update: Record<string, unknown> }])[0]
    expect(args.update).not.toHaveProperty('smtpPass')
  })

  it('channel tokens are masked, and a masked token is not saved over the real one', async () => {
    db.channelConfig.findMany.mockResolvedValueOnce([{ id: 1, channel: 'WhatsApp', enabled: true, webhookUrl: null, config: { apiToken: 'EAAG-real-token', phoneNumberId: '123' } }])
    const res = await getChannelConfigs()
    expect(JSON.stringify(res)).not.toContain('EAAG-real-token')
    expect(res.data[0].config.phoneNumberId).toBe('123')

    db.channelConfig.findUnique.mockResolvedValueOnce({ config: { apiToken: 'EAAG-real-token' } } as never)
    db.channelConfig.upsert.mockResolvedValueOnce({ id: 1, webhookUrl: '' } as never)
    await upsertChannelConfig({ channel: 'WhatsApp', enabled: true, config: { apiToken: res.data[0].config.apiToken, phoneNumberId: '456' } })
    const saved = (db.channelConfig.upsert.mock.calls[0] as unknown as [{ update: { config: Record<string, string> } }])[0].update.config
    expect(saved).toEqual({ apiToken: 'EAAG-real-token', phoneNumberId: '456' })
  })
})
