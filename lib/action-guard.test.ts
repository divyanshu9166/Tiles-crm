import { describe, expect, it, vi } from 'vitest'
import { friendlyError, guarded } from './action-guard'

describe('guarded server actions', () => {
  it('passes a normal result through untouched', async () => {
    expect(await guarded('ok', async () => ({ success: true, data: 1 }))).toEqual({ success: true, data: 1 })
  })

  it('turns a throw into { success: false, error }', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await guarded('boom', async () => { throw new Error('Insufficient stock') })
    expect(result).toEqual({ success: false, error: 'Insufficient stock' })
    spy.mockRestore()
  })

  it('never shows database text to the user', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prismaError = Object.assign(new Error('Invalid `prisma.invoice.create()` invocation: Unique constraint failed on the fields: (`displayId`)'), { name: 'PrismaClientKnownRequestError' })
    const result = await guarded('db', async () => { throw prismaError }) as { error: string }
    expect(result.error).not.toMatch(/prisma|constraint|displayId/i)
    expect(friendlyError(Object.assign(new Error('x'), { code: 'P2002' }))).toMatch(/already exists/)
    expect(friendlyError(Object.assign(new Error('x'), { code: 'P2025' }))).toMatch(/no longer exists/)
    spy.mockRestore()
  })

  it('maps sign-in and permission errors to plain messages', async () => {
    expect(await guarded('a', async () => { throw new Error('Unauthorized') })).toEqual({ success: false, error: 'Please sign in again' })
    expect(await guarded('b', async () => { throw new Error('Forbidden') })).toEqual({ success: false, error: 'You do not have access to this action' })
  })

  it('lets Next.js redirects and not-found signals through', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' })
    await expect(guarded('r', async () => { throw redirect })).rejects.toBe(redirect)
  })
})
