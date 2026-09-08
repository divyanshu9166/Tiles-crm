# Sekol Tiles calling agent

LiveKit voice worker: Deepgram Nova-3 multilingual STT, Sarvam Bulbul v3 TTS and
the Groq model selected by `AI_AGENT_GROQ_MODEL`. The existing streaming audio, VAD and interruption
settings are preserved. The opening greeting goes directly to TTS without an LLM request.

## Configuration and startup

Install `requirements.txt` in a clean virtual environment and run `python agent.py start`.
The worker loads the repository `.env`; set `AI_AGENT_VERTICAL=tiles` to load `.env.tiles`,
or `AI_AGENT_ENV_FILE` to an explicit path. Process environment takes precedence.

Required: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `GROQ_API_KEY`,
`DEEPGRAM_API_KEY`, `SARVAM_API_KEY`. Outbound calls also require
`OUTBOUND_SIP_TRUNK_ID` (or `VOBIZ_SIP_TRUNK_ID`). Set `CRM_API_URL` and
`CRM_API_SECRET` for call logging and appointments. Configure `DEFAULT_TRANSFER_NUMBER`
for human transfers. The worker and CRM must use the same `LIVEKIT_AGENT_NAME`.

`AI_AGENT_GROQ_MODEL` controls the calling model (the local `.env` selects
`qwen/qwen3.8-27b`; GPT OSS is the fallback only when this variable is empty). The shared
legacy `GROQ_MODEL` setting is intentionally not read by this voice worker because
it also controls WhatsApp. GPT OSS uses low reasoning effort and
`include_reasoning=false`; Groq does not support `reasoning_format` for this model.
Qwen uses a 256-token output allowance: reserving 1024 tokens exceeded this
account's 1000 output-tokens-per-minute limit and caused HTTP 429 responses.
GPT OSS retains a 1024-token allowance for reasoning and tool arguments. The prompt
keeps spoken answers short. Missing Groq credentials fail visibly rather than
silently switching providers.

For the tiles vertical, the voice identity defaults to Sekol Tiles. Optional overrides:
`AI_AGENT_NAME`, `AI_AGENT_BRAND_NAME`, `AI_AGENT_WEBSITE`, `AI_AGENT_EMAIL`,
`AI_AGENT_PHONE`. `AI_AGENT_NAME` is the spoken name, not the worker dispatch name.

After deploying changes, rebuild/restart the worker (`docker compose up -d --build ai-agent`
for the repository compose setup) and deploy the CRM changes. Local file edits alone
do not update a running worker on a remote server.

## Knowledge and call context

Company facts were verified on 7 September 2026 from:
- [Sekol Tiles products and company overview](https://sekoltiles.com/)
- [Sekol Tiles contact details and hours](https://sekoltiles.com/contact-us/)
- [Groq GPT OSS model settings](https://console.groq.com/docs/model/openai/gpt-oss-120b)
- [Groq reasoning parameters](https://console.groq.com/docs/reasoning)

The prompt contains static verified facts, avoiding network retrieval on each turn.
Prices, stock, order/payment status and unverified services require team confirmation.

Dispatch metadata uses `call_type`, `phone_number` (E.164), `customer_name`, and
`reason`. `CallContext` puts these into persistent per-call agent instructions along
with the India date. LiveKit maintains the conversation history, including the
direct greeting. Supplied details are reused, and customer corrections take priority.
This is memory within one call; it does not fetch previous calls or CRM order data.
Custom context stays complete in the instructions and is addressed after the
customer agrees to talk; private/free-text notes are not recited in the opening.

## Verification

From the repository root:

```sh
python -m unittest discover -s ai-agent -p 'test_*.py' -v
npx vitest run lib/validations/ai-call.test.ts
npx tsc --noEmit
```

Use a browser test for voice quality and a controlled phone test for SIP transfer,
hangup and full speech latency. The CRM's “Configured” status checks settings; it
does not establish whether a remote worker is online. “Call Requested” means a
dispatch was accepted, not that the customer answered.
