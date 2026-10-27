import { cookies } from 'next/headers'

const COOKIE_NAME = 'session'

// Never fall back to a default: a known secret lets anyone forge an ADMIN
// cookie. Read lazily so builds without the env var still compile.
export function sessionSecret() {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be set to at least 32 characters')
  return secret
}

export interface SessionPayload {
  id: string
  email: string
  name: string
  role: string
  staffId: number | null
  expiresAt: Date
}

// Edge-compatible base64url encode/decode
function b64urlEncode(str: string) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str).toString('base64url');
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(str: string) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'base64url').toString('utf8');
  }
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64);
}

// Edge-compatible HMAC signing using Web Crypto API
async function sign(payload: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );

  // Convert ArrayBuffer to base64url
  const uint8View = new Uint8Array(signature);
  const base64 = typeof Buffer !== 'undefined' 
    ? Buffer.from(uint8View).toString('base64url')
    : btoa(String.fromCharCode(...uint8View)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    
  return base64;
}

export async function encrypt(payload: SessionPayload) {
  const data = b64urlEncode(JSON.stringify(payload))
  const signature = await sign(data, sessionSecret())
  return `${data}.${signature}`
}

// Edge compatible constant-time comparison
function timingSafeEqualEdge(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function decrypt(session: string | undefined): Promise<SessionPayload | null> {
  if (!session) return null

  const [data, signature] = session.split('.')
  if (!data || !signature) return null

  const expectedSignature = await sign(data, sessionSecret())

  if (!timingSafeEqualEdge(signature, expectedSignature)) {
    return null
  }

  try {
    const payload = JSON.parse(b64urlDecode(data)) as SessionPayload
    if (new Date(payload.expiresAt) < new Date()) {
      return null
    }
    return payload
  } catch (e) {
    return null
  }
}

export async function createSession(user: Omit<SessionPayload, 'expiresAt'>) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
  const session = await encrypt({ ...user, expiresAt })
  const cookieStore = await cookies()

  cookieStore.set(COOKIE_NAME, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    expires: expiresAt,
    sameSite: 'lax',
    path: '/',
  })
}

export async function getSession() {
  const cookieStore = await cookies()
  const session = cookieStore.get(COOKIE_NAME)?.value
  return await decrypt(session)
}

export async function deleteSession() {
  const cookieStore = await cookies()
  cookieStore.delete(COOKIE_NAME)
}
