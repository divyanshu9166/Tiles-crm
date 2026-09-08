/**
 * LiveKit Server API utilities for the Furniture CRM.
 * Used by API routes to create rooms, dispatch agents, and generate tokens.
 * Uses LiveKit's REST API directly (no heavy SDK dependency in Next.js).
 */

import crypto from 'crypto'

const LIVEKIT_URL = () => process.env.LIVEKIT_URL || ''
const LIVEKIT_API_KEY = () => process.env.LIVEKIT_API_KEY || ''
const LIVEKIT_API_SECRET = () => process.env.LIVEKIT_API_SECRET || ''
// LIVEKIT_AGENT_NAME must match the agent_name in agent.py WorkerOptions
const LIVEKIT_AGENT_NAME = () => process.env.LIVEKIT_AGENT_NAME || (
  String(process.env.BUSINESS_TYPE || process.env.NEXT_PUBLIC_BUSINESS_TYPE || '').trim().toLowerCase() === 'tiles'
    ? 'tgm-crm-agent'
    : 'furniture-crm-agent'
)

/**
 * Get the HTTP URL for LiveKit API from the WebSocket URL.
 */
function getHttpUrl(): string {
  const url = LIVEKIT_URL()
  return url.replace('wss://', 'https://').replace('ws://', 'http://')
}

/**
 * Create a JWT token for LiveKit API authentication.
 */
function createJWT(claims: Record<string, unknown>, ttl: number = 600): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)

  const payload = {
    iss: LIVEKIT_API_KEY(),
    nbf: now,
    exp: now + ttl,
    ...claims,
  }

  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')

  const headerB64 = encode(header)
  const payloadB64 = encode(payload)
  const signature = crypto
    .createHmac('sha256', LIVEKIT_API_SECRET())
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url')

  return `${headerB64}.${payloadB64}.${signature}`
}

/**
 * Create a LiveKit access token for a participant to join a room.
 */
export async function createToken(
  roomName: string,
  identity: string,
  name: string = ''
): Promise<string> {
  const claims = {
    sub: identity,
    name: name || identity,
    video: {
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    },
  }

  return createJWT(claims, 3600)
}

/**
 * Create a LiveKit room via the REST API.
 */
export async function createRoom(roomName: string): Promise<void> {
  const httpUrl = getHttpUrl()
  const token = createJWT({ video: { roomCreate: true } })

  const response = await fetch(`${httpUrl}/twirp/livekit.RoomService/CreateRoom`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name: roomName, empty_timeout: 300, max_participants: 5 }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to create room: ${response.status} ${text}`)
  }
}

/** Delete a room created for a call that could not be dispatched. */
export async function deleteRoom(roomName: string): Promise<void> {
  const httpUrl = getHttpUrl()
  const token = createJWT({ video: { roomAdmin: true, room: roomName } })
  const response = await fetch(`${httpUrl}/twirp/livekit.RoomService/DeleteRoom`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ room: roomName }),
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete room: ${response.status} ${await response.text()}`)
  }
}

/**
 * Dispatch the AI agent to a room via the REST API.
 */
export async function dispatchAgent(
  roomName: string,
  metadata: Record<string, string>
): Promise<void> {
  const httpUrl = getHttpUrl()
  const token = createJWT({ video: { roomAdmin: true, room: roomName } })

  const response = await fetch(`${httpUrl}/twirp/livekit.AgentDispatchService/CreateDispatch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      room: roomName,
      agent_name: LIVEKIT_AGENT_NAME(),
      metadata: JSON.stringify(metadata),
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to dispatch agent: ${response.status} ${text}`)
  }
}
