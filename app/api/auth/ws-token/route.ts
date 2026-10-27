/**
 * app/api/auth/ws-token/route.ts
 *
 * Issues a short-lived standard JWT for the WebSocket handshake.
 *
 * Why a separate token?
 *   The main session cookie uses a custom HMAC format (base64.hmac) that
 *   cannot be verified by the standard `jsonwebtoken` library used in the
 *   ws-server container. Rather than duplicating the custom crypto in a
 *   plain-JS service, we issue a proper RS256/HS256 JWT here that the
 *   ws-server can verify with a single `jwt.verify()` call.
 *
 * Security:
 *   - This route is session-gated: unauthenticated requests get 401.
 *   - The JWT expires in 1 hour. The frontend re-fetches transparently
 *     on each socket reconnect (socket.io reconnects pass a fresh token).
 *   - The same SESSION_SECRET signs both the session cookie and the JWT,
 *     so no extra key management is required.
 */

import { NextResponse } from 'next/server'
import { getSession, sessionSecret } from '@/lib/session'
import { SignJWT } from 'jose'

export async function GET() {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Sign a compact JWT with the session user's id embedded.
  // `jose` is already a transitive dependency via @supabase/* and works
  // in the edge runtime too. HS256 keeps it symmetric — same secret.
  const secret = new TextEncoder().encode(sessionSecret())
  const token = await new SignJWT({ id: session.id, email: session.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret)

  return NextResponse.json({ token })
}
