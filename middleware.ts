import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { decrypt } from '@/lib/session'

const publicPaths = [
  '/login',
  '/api/auth',
  '/api/webhooks',
  '/api/social/webhook',
  '/walkin-form',
  '/api/walkin',
  '/api/email-track',
  '/api/calls/log',
  '/api/calls/schedule-callback',
  '/api/appointments/check-slot',
  '/api/appointments/create',
  '/api/whatsapp/webhook',
  // Secret-checked (x-api-secret = CRM_API_SECRET) inside the route
  '/api/cron/accounting',
  '/api/cron/stock-alerts',
  '/api/cron/financial-alerts',
  '/api/cron/indiamart-sync',
  '/api/cron/cleanup', // CRON_SECRET bearer, checked in the route
  // Uploaded files are fetched by WhatsApp/Meta to send media by link; names
  // are random UUIDs and the route serves them with nosniff + sandbox headers.
  '/api/uploads/',
]

// Real static assets only. Anything else with a dot (e.g. /sales-orders/1.x)
// still goes through the session and role checks below.
const STATIC_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|txt|xml|webmanifest|json|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf)$/i

// Role-based route restrictions
const routePermissions: Record<string, string[]> = {
  '/staff-portal': ['STAFF', 'MANAGER'],
  '/settings': ['ADMIN'],
  '/staff': ['ADMIN', 'MANAGER'],
  '/payroll': ['ADMIN'], // salaries and loans: same as the menu, which only shows it to admins
  '/billing': ['ADMIN', 'MANAGER'],
  '/drafts': ['ADMIN', 'MANAGER'],
  '/whatsapp-marketing': ['ADMIN', 'MANAGER'],
  '/email-marketing': ['ADMIN', 'MANAGER'],
  // ERP documents (Odoo-style flows) and modules that were only hidden in the nav
  '/sales-orders': ['ADMIN', 'MANAGER'],
  '/pricelists': ['ADMIN', 'MANAGER'],
  '/operations': ['ADMIN', 'MANAGER'],
  '/replenishment': ['ADMIN', 'MANAGER'],
  '/purchases': ['ADMIN', 'MANAGER'],
  '/vendor-bills': ['ADMIN', 'MANAGER'],
  '/landed-costs': ['ADMIN', 'MANAGER'],
  '/financials': ['ADMIN'],
  '/accounting': ['ADMIN', 'MANAGER'],
  '/accounts': ['ADMIN', 'MANAGER'],
  // Screens the menu hides from staff were still reachable by typing the address.
  '/gst': ['ADMIN', 'MANAGER'],
  '/indiamart-leads': ['ADMIN', 'MANAGER'],
  '/social-inbox': ['ADMIN', 'MANAGER'],
  '/facebook-inbox': ['ADMIN', 'MANAGER'],
  '/instagram-inbox': ['ADMIN', 'MANAGER'],
  '/broadcasts': ['ADMIN', 'MANAGER'],
  '/automations': ['ADMIN', 'MANAGER'],
  '/marketing': ['ADMIN', 'MANAGER'],
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Allow public paths
  if (publicPaths.some(path => pathname.startsWith(path))) {
    return NextResponse.next()
  }

  // Allow static files and Next.js internals
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    (!pathname.startsWith('/api/') && STATIC_FILE.test(pathname))
  ) {
    return NextResponse.next()
  }

  // Check custom session cookie
  const sessionCookie = req.cookies.get('session')?.value
  const session = await decrypt(sessionCookie)

  // Redirect unauthenticated users to login (without callbackUrl to avoid redirect loops)
  if (!session) {
    const loginUrl = new URL('/login', req.url)
    return NextResponse.redirect(loginUrl)
  }

  const role = session.role as string

  // Check route-level permissions and redirect unauthorized users to their home
  for (const [route, allowedRoles] of Object.entries(routePermissions)) {
    if (pathname.startsWith(route)) {
      if (!allowedRoles.includes(role)) {
        // ADMIN/MANAGER trying to access /staff-portal → redirect to dashboard
        // STAFF trying to access admin-only routes → redirect to staff-portal
        const fallback = role === 'STAFF' ? '/staff-portal' : '/'
        return NextResponse.redirect(new URL(fallback, req.url))
      }
      break
    }
  }

  // Inject user role into request headers for server components
  const response = NextResponse.next()
  response.headers.set('x-user-role', role)
  response.headers.set('x-user-id', session.id || '')
  response.headers.set('x-user-name', (session.name as string) || '')

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
