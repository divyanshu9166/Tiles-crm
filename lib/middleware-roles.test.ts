import { beforeAll, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'

// Who may open which screen by address. The menu (components/nav-config.js) is
// the policy; the middleware must agree with it, because hiding a link does
// not stop someone typing the address.

let middleware: (req: NextRequest) => Promise<Response>
let encrypt: (payload: { id: string; email: string; name: string; role: string; staffId: number | null; expiresAt: Date }) => Promise<string>

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-only-session-secret-0123456789abcdef'
  ;({ middleware } = await import('../middleware'))
  ;({ encrypt } = await import('./session'))
})

async function visit(role: 'ADMIN' | 'MANAGER' | 'STAFF' | null, path: string) {
  const headers = new Headers()
  if (role) {
    const cookie = await encrypt({ id: '1', email: `${role}@test.local`, name: role, role, staffId: role === 'STAFF' ? 7 : null, expiresAt: new Date(Date.now() + 3600_000) })
    headers.set('cookie', `session=${cookie}`)
  }
  const res = await middleware(new NextRequest(`http://localhost:3001${path}`, { headers }))
  const location = res.headers.get('location')
  return location ? new URL(location).pathname : 'ALLOWED'
}

const ADMIN_ONLY = ['/settings', '/financials', '/payroll']
const ADMIN_AND_MANAGER = [
  '/staff', '/billing', '/drafts', '/whatsapp-marketing', '/email-marketing', '/sales-orders', '/pricelists', '/operations',
  '/replenishment', '/purchases', '/vendor-bills', '/landed-costs', '/accounting', '/accounts', '/gst', '/indiamart-leads',
  '/social-inbox', '/facebook-inbox', '/instagram-inbox', '/broadcasts', '/automations', '/marketing',
]
// Menu items every role sees.
const EVERYONE = ['/', '/leads', '/walkins', '/appointments', '/quotations', '/orders', '/sales-teams', '/dealers', '/inventory', '/inventory-counts', '/custom-orders', '/calls', '/payments', '/godowns', '/manufacturing', '/expenses']

describe('screen access by role', () => {
  it('sends signed-out visitors to the login page', async () => {
    for (const path of ['/', '/billing', '/payroll', '/inventory']) expect(await visit(null, path)).toBe('/login')
  })

  it('admins can open everything', async () => {
    for (const path of [...ADMIN_ONLY, ...ADMIN_AND_MANAGER, ...EVERYONE]) expect(await visit('ADMIN', path), path).toBe('ALLOWED')
  })

  it('managers cannot open the admin-only screens, and are not sent to the staff portal', async () => {
    for (const path of ADMIN_ONLY) expect(await visit('MANAGER', path), path).toBe('/')
    for (const path of [...ADMIN_AND_MANAGER, ...EVERYONE]) expect(await visit('MANAGER', path), path).toBe('ALLOWED')
  })

  it('staff are sent to their portal from every screen the menu hides from them', async () => {
    for (const path of [...ADMIN_ONLY, ...ADMIN_AND_MANAGER]) expect(await visit('STAFF', path), path).toBe('/staff-portal')
  })

  it('staff can open the screens in their menu and their own portal', async () => {
    for (const path of [...EVERYONE, '/staff-portal']) expect(await visit('STAFF', path), path).toBe('ALLOWED')
  })

  it('admins are not sent to the staff portal either', async () => {
    expect(await visit('ADMIN', '/staff-portal')).toBe('/')
  })
})
