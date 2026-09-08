import { describe, expect, it } from 'vitest'
import { outboundAICallSchema } from './ai-call'
import { callingAgentStatus } from '../calling-agent-status'

describe('outbound call metadata', () => {
  it('preserves complete custom context and normalizes phone formatting', () => {
    expect(outboundAICallSchema.parse({
      phoneNumber: ' +91 (98765) 43210 ', customerName: ' Rahul Shah ',
      reason: ' Discuss 600x600 GVT for 1200 sq.ft in Surat; quote follow-up. ',
    })).toEqual({
      phoneNumber: '+919876543210', customerName: 'Rahul Shah',
      reason: 'Discuss 600x600 GVT for 1200 sq.ft in Surat; quote follow-up.',
    })
  })
  it.each(['', '9876543210', '+00123', '+91916623128', 'browser-call', 123, null])('rejects invalid phone %s', phoneNumber => {
    expect(outboundAICallSchema.safeParse({ phoneNumber }).success).toBe(false)
  })
  it('rejects an unfilled custom reason', () => {
    expect(outboundAICallSchema.safeParse({ phoneNumber: '+919876543210', reason: 'Custom reason' }).success).toBe(false)
  })
  it('defaults optional fields', () => {
    expect(outboundAICallSchema.parse({ phoneNumber: '+919876543210' }).reason).toBe('Follow-up call')
  })
})

describe('calling agent configuration status', () => {
  const env = { LIVEKIT_URL: 'wss://test', LIVEKIT_API_KEY: 'test', LIVEKIT_API_SECRET: 'test', GROQ_API_KEY: 'test', DEEPGRAM_API_KEY: 'test', SARVAM_API_KEY: 'test', OUTBOUND_SIP_TRUNK_ID: 'test' }
  const online = async () => ({ ok: true }) as Response
  it('uses Groq and Deepgram without requiring Gemini', async () => {
    await expect(callingAgentStatus(env, online)).resolves.toMatchObject({ configured: true, workerOnline: true, model: 'openai/gpt-oss-120b' })
    await expect(callingAgentStatus({ ...env, GROQ_MODEL: 'legacy-llama' }, online)).resolves.toMatchObject({ model: 'openai/gpt-oss-120b' })
  })
  it.each(['GROQ_API_KEY', 'DEEPGRAM_API_KEY', 'SARVAM_API_KEY'])('requires %s', async key => {
    await expect(callingAgentStatus({ ...env, [key]: '' }, online)).resolves.toMatchObject({ configured: false })
  })
  it('recognizes the worker SIP trunk fallback', async () => {
    await expect(callingAgentStatus({ ...env, OUTBOUND_SIP_TRUNK_ID: '', VOBIZ_SIP_TRUNK_ID: 'test' }, online)).resolves.toMatchObject({ hasSipTrunk: true })
  })
  it('reports an offline worker separately from configuration', async () => {
    await expect(callingAgentStatus(env, async () => { throw new Error('offline') })).resolves.toMatchObject({ configured: true, workerOnline: false })
  })
})
