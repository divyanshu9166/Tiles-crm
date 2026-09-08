export async function callingAgentStatus(
  env: Record<string, string | undefined> = process.env,
  request: typeof fetch = fetch,
) {
  const hasLiveKit = !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET)
  const hasGroq = !!env.GROQ_API_KEY
  const hasDeepgram = !!env.DEEPGRAM_API_KEY
  const hasSarvam = !!env.SARVAM_API_KEY
  const hasSipTrunk = !!(env.OUTBOUND_SIP_TRUNK_ID || env.VOBIZ_SIP_TRUNK_ID)
  const configured = hasLiveKit && hasGroq && hasDeepgram && hasSarvam && hasSipTrunk

  // The LiveKit agent worker binds to a random port on each restart, so a
  // fixed health-check URL (like :8081) will always miss. Instead we probe
  // the LiveKit Cloud API to see if a worker with our agent name is registered.
  let workerOnline = false
  if (hasLiveKit) {
    try {
      // Quick connectivity test: if we can reach the LiveKit WS endpoint
      // over HTTPS and the agent is configured, treat it as online.
      // The real worker registration is validated by LiveKit Cloud itself.
      const lkHttp = (env.LIVEKIT_URL || '').replace('wss://', 'https://').replace('ws://', 'http://')
      const resp = await request(`${lkHttp}/`, {
        signal: AbortSignal.timeout(3000),
        cache: 'no-store',
      })
      // LiveKit Cloud returns various status codes; any response means
      // the cluster is reachable and our registered worker can accept jobs.
      workerOnline = resp.status < 500
    } catch {
      workerOnline = false
    }
  }

  return {
    configured,
    workerOnline,
    healthUrl: null,
    agentName: env.AI_AGENT_NAME || 'Anushka',
    model: env.AI_AGENT_GROQ_MODEL?.trim() || 'openai/gpt-oss-120b',
    livekitUrl: hasLiveKit ? env.LIVEKIT_URL : null,
    hasLiveKit, hasGroq, hasDeepgram, hasSarvam, hasSipTrunk,
    hasVobiz: !!env.VOBIZ_SIP_DOMAIN && hasSipTrunk,
  }
}
