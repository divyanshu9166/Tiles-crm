"""
Vertical-aware AI Calling Agent (livekit-agents v1.5.x)
Uses LiveKit + Deepgram STT/TTS + Groq LLM + Vobiz sip
Handles both inbound and outbound calls for the configured business vertical.
"""

import asyncio
import logging
import os
import re
import sys
import time
from datetime import date as CalendarDate, datetime
from typing import Optional

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import aiohttp
from dotenv import load_dotenv
from livekit import api
from livekit.agents import AutoSubscribe, JobContext, JobProcess, WorkerOptions, cli, llm
from livekit.agents.voice import Agent, AgentSession, RunContext
from livekit.agents.voice.room_io import AudioInputOptions, AudioOutputOptions, RoomOptions
from livekit.plugins import deepgram, noise_cancellation, openai, sarvam, silero

from config import (
    DEFAULT_TTS_VOICE,
    GROQ_MAX_TOKENS,
    GROQ_MODEL,
    GROQ_TEMPERATURE,
    GROQ_TOP_P,
    GROQ_EXTRA_OPTIONS,
    SARVAM_LANGUAGE,
    SARVAM_MODEL,
    STT_LANGUAGE,
    STT_KEYTERMS,
    STT_MODEL,
    BRAND_NAME,
    IS_TGM,
    ENV_FILE,
    AGENT_NAME,
)
from call_context import CallContext, INDIA_TIME, build_outbound_greeting

load_dotenv(dotenv_path=ENV_FILE, override=False)

WORKER_NAME = os.getenv("LIVEKIT_AGENT_NAME", "tgm-crm-agent" if IS_TGM else "furniture-crm-agent")
logger = logging.getLogger(WORKER_NAME)
logger.setLevel(logging.INFO)

# ─── Config ───
CRM_API_URL = os.getenv("CRM_API_URL", "http://localhost:3000").rstrip("/")
CRM_API_SECRET = os.getenv("CRM_API_SECRET", "")
MAX_CALL_DURATION = int(os.getenv("MAX_CALL_DURATION_SECONDS", "600"))
DEFAULT_TRANSFER_NUMBER = os.getenv("DEFAULT_TRANSFER_NUMBER", "")
OUTBOUND_SIP_TRUNK_ID = os.getenv("OUTBOUND_SIP_TRUNK_ID") or os.getenv("VOBIZ_SIP_TRUNK_ID", "")
APPOINTMENT_SLOTS = ("10:00 AM", "11:00 AM", "12:00 PM", "2:00 PM", "3:00 PM", "4:00 PM", "5:00 PM")


async def resolve_outbound_trunk(ctx: JobContext) -> str:
    configured = (os.getenv("OUTBOUND_SIP_TRUNK_ID") or os.getenv("VOBIZ_SIP_TRUNK_ID", "")).strip()
    try:
        response = await ctx.api.sip.list_outbound_trunk(api.ListSIPOutboundTrunkRequest())
        trunks = response.items
        if configured and any(trunk.sip_trunk_id == configured for trunk in trunks):
            return configured
        if len(trunks) == 1:
            discovered = trunks[0].sip_trunk_id
            logger.warning(
                "Configured trunk %s is not an outbound trunk; using discovered outbound trunk %s.",
                configured or "<empty>",
                discovered,
            )
            return discovered
        if configured:
            logger.error(
                "Configured trunk %s is not an outbound trunk. Available outbound trunks: %s",
                configured,
                [trunk.sip_trunk_id for trunk in trunks],
            )
        return ""
    except Exception as exc:
        logger.warning("Could not validate outbound SIP trunks: %s", exc)
        return configured


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_threshold(name: str, default: float) -> float:
    value = _env_float(name, default)
    return min(5.0, max(0.05, value))


def _normalize_appointment_details(customer_name: Optional[str], phone: Optional[str], date: str, appointment_time: str) -> tuple[str, str, str, str] | None:
    """Validate locally before making CRM calls; the HTTP API validates again."""
    name = " ".join((customer_name or "").split())[:120]
    normalized_phone = re.sub(r"[\s().-]", "", phone or "")
    if (not name or not re.fullmatch(r"\+[1-9]\d{7,14}", normalized_phone)
            or (normalized_phone.startswith("+91") and not re.fullmatch(r"\+91[6-9]\d{9}", normalized_phone))):
        return None
    try:
        appointment_date = CalendarDate.fromisoformat(date)
    except (TypeError, ValueError):
        return None
    if appointment_date < datetime.now(INDIA_TIME).date():
        return None
    match = re.fullmatch(r"\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*", appointment_time.upper())
    if not match:
        return None
    hour, minute, period = int(match.group(1)), int(match.group(2) or 0), match.group(3)
    if not 1 <= hour <= 12 or minute > 59:
        return None
    normalized_time = f"{hour}:{minute:02d} {period}"
    if normalized_time not in APPOINTMENT_SLOTS:
        return None
    return name, normalized_phone, appointment_date.isoformat(), normalized_time


def _dial_failure_status(exc: Exception) -> tuple[str, str]:
    """Map a provider failure to an honest, useful CRM status."""
    message = str(exc).lower()
    if "busy" in message or "486" in message:
        return "BUSY", "Customer line was busy"
    if any(token in message for token in ("no answer", "unanswered", "timeout", "480", "408")):
        return "NO_ANSWER", "Customer did not answer"
    return "FAILED", "Call setup failed"


# ─── Tools ───

class CRMTools(llm.ToolContext):
    def __init__(self, ctx: JobContext, phone_number: Optional[str] = None, customer_name: Optional[str] = None, call_type: str = "inbound") -> None:
        super().__init__(tools=[])
        self._ctx = ctx
        self._phone_number = phone_number
        self._customer_name = customer_name
        self._call_type = call_type
        self.call_outcome = ""

    @llm.function_tool(
        description=(
            "Transfer the call to a human team member. "
            "Call this tool in TWO situations: "
            "(1) The customer asks to speak to a person/human/manager, OR "
            "(2) The customer asks something you cannot answer (unknown price, policy, complaint, etc.). "
            "Always say a brief goodbye sentence BEFORE calling this tool, e.g. 'जी, अभी हमारे टीम मेंबर से कनेक्ट करती हूँ।'"
        )
    )
    async def transfer_call(self, context: RunContext) -> str:
        # The model must not redirect calls to an arbitrary, unconfigured number.
        target = DEFAULT_TRANSFER_NUMBER
        if not target:
            return "No transfer number configured. Apologise and offer to have someone call them back."

        sip_domain = os.getenv("VOBIZ_SIP_DOMAIN") or os.getenv("TWILIO_SIP_DOMAIN", "")
        if not target.startswith(("sip:", "tel:")):
            clean = target.replace("tel:", "").replace("sip:", "").replace(" ", "")
            if sip_domain:
                target = f"sip:{clean}@{sip_domain}"
            else:
                target = f"tel:{clean}"
        elif target.startswith("tel:") and sip_domain:
            clean = target.replace("tel:", "").replace("sip:", "").replace(" ", "")
            target = f"sip:{clean}@{sip_domain}"

        participant_identity = None
        for p in self._ctx.room.remote_participants.values():
            if p.kind == api.ParticipantInfo.Kind.SIP:
                participant_identity = p.identity
                break

        if not participant_identity:
            return "Transfer is only available for telephone calls. Offer the team's contact number."

        logger.info("Transferring call | participant=%s | target=%s", participant_identity, target)
        try:
            await context.wait_for_playout()
            await self._ctx.api.sip.transfer_sip_participant(
                api.TransferSIPParticipantRequest(
                    room_name=self._ctx.room.name,
                    participant_identity=participant_identity,
                    transfer_to=target,
                    play_dialtone=False,
                )
            )
            self.call_outcome = "Transferred to human team"
            return "Transfer initiated successfully."
        except Exception as exc:
            logger.error("Transfer failed: %s", exc)
            return f"Transfer failed: {exc}"

    @llm.function_tool(
        description=(
            "Schedule a showroom visit or appointment for the customer. "
            "For outbound calls, customer_name and phone are already stored from the call context: "
            "do not ask for them and omit them unless the customer explicitly corrects either detail. "
            "After confirming date in YYYY-MM-DD and one time (10 AM, 11 AM, 12 PM, 2 PM, 3 PM, 4 PM, or 5 PM), call this tool. "
            "For inbound calls with no stored details, provide customer_name and E.164 phone. "
            "Never use placeholder values like 'unknown'."
        )
    )
    async def schedule_appointment(
        self,
        context: RunContext,
        date: str,
        time: str,
        purpose: Optional[str] = None,
        notes: Optional[str] = None,
        customer_name: Optional[str] = None,
        phone: Optional[str] = None,
    ) -> str:
        async def respond(spoken: str, result: str) -> str:
            """Guarantee an audible tool result instead of relying on another LLM turn."""
            await context.session.say(spoken, allow_interruptions=True)
            return f"The booking result was already spoken to the customer. Do not repeat it. {result}"

        # Guard against placeholder values the LLM sometimes sends
        invalid = {"unknown", "none", "n/a", "tbd", "", "null"}
        # Outbound identity is owned by the dispatch record. Do not let an LLM
        # guess replacement details; a confirmed correction uses the dedicated
        # tool below first.
        supplied_name = (self._customer_name or "") if self._call_type == "outbound" else (customer_name or self._customer_name or "")
        supplied_phone = (self._phone_number or "") if self._call_type == "outbound" else (phone or self._phone_number or "")
        if any(not isinstance(v, str) or v.strip().lower() in invalid for v in [supplied_name, supplied_phone, date, time]):
            return await respond(
                "माफ़ कीजिए, बुकिंग की जानकारी पूरी नहीं है। कृपया तारीख और समय बताइए।",
                "For inbound calls collect missing identity; for outbound calls ask only for date and time.",
            )
        normalized = _normalize_appointment_details(supplied_name, supplied_phone, date, time)
        if not normalized:
            return await respond(
                "कृपया आज या आगे की तारीख और उपलब्ध समय चुनिए: दस, ग्यारह, बारह, दो, तीन, चार या पाँच बजे।",
                "Wait for a valid current/future date and listed showroom slot.",
            )
        customer_name, phone, date, time = normalized

        # ── Step 1: Check slot availability before booking ──────────────────
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as http:
                async with http.get(
                    f"{CRM_API_URL}/api/appointments/check-slot",
                    params={"date": date, "time": time},
                    headers={"x-api-secret": CRM_API_SECRET},
                    allow_redirects=False,
                ) as resp:
                    if resp.status == 200:
                        slot_data = await resp.json(content_type=None)
                        if not isinstance(slot_data, dict) or not isinstance(slot_data.get("available"), bool):
                            logger.error("Invalid slot-check response: %r", slot_data)
                            return await respond(
                                "माफ़ कीजिए, अभी स्लॉट की उपलब्धता जाँची नहीं जा सकी।",
                                "Offer team assistance; do not promise a booking.",
                            )
                        if not slot_data["available"]:
                            suggestions = slot_data.get("suggestions", [])
                            if suggestions:
                                suggestion_str = ", ".join(suggestions)
                                return await respond(
                                    f"यह समय उपलब्ध नहीं है। उपलब्ध समय हैं: {suggestion_str}। इनमें से कौन सा समय ठीक रहेगा?",
                                    "Wait for a new time, then call this tool again.",
                                )
                            else:
                                return await respond(
                                    "इस तारीख के सभी स्लॉट भर चुके हैं। कृपया दूसरी तारीख बताइए।",
                                    "Wait for a different date.",
                                )
                    else:
                        return await respond(
                            "माफ़ कीजिए, अभी स्लॉट जाँचा नहीं जा सका। हमारी टीम आपकी सहायता करेगी।",
                            "Do not promise this slot; offer team assistance.",
                        )
        except Exception as exc:
            logger.warning("Slot check failed: %s", exc)
            return await respond(
                "माफ़ कीजिए, अभी स्लॉट जाँचा नहीं जा सका। हमारी टीम आपकी सहायता करेगी।",
                "Do not promise this slot; offer team assistance.",
            )

        # ── Step 2: Create the appointment ──────────────────────────────────
        payload = {
            "customerName": customer_name,
            "phone": phone,
            "date": date,
            "time": time,
            "purpose": purpose or "Showroom Visit",
            "notes": notes or f"Booked via AI Agent ({AGENT_NAME}) during call",
        }
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as http:
                async with http.post(
                    f"{CRM_API_URL}/api/appointments/create",
                    json=payload,
                    headers={"Content-Type": "application/json", "x-api-secret": CRM_API_SECRET},
                    allow_redirects=False,
                ) as resp:
                    if resp.status == 200:
                        result = await resp.json(content_type=None)
                        appt_id = result.get("data", {}).get("id") if isinstance(result, dict) else None
                        if not isinstance(result, dict) or result.get("success") is not True or not appt_id:
                            logger.error("Appointment API returned an unconfirmed success response: %r", result)
                            return await respond(
                                "माफ़ कीजिए, अपॉइंटमेंट सेव होने की पुष्टि नहीं मिली। कृपया हमारी टीम से पुष्टि कर लीजिए।",
                                "The database did not confirm the appointment; do not claim confirmation.",
                            )
                        logger.info("Appointment created: id=%s date=%s time=%s", appt_id, date, time)
                        self.call_outcome = f"Appointment booked (ID {appt_id})"
                        return await respond(
                            f"{customer_name} जी, आपकी अपॉइंटमेंट {date} को {time} के लिए बुक हो गई है।",
                            f"Saved appointment ID {appt_id}.",
                        )
                    if resp.status == 409:
                        result = await resp.json()
                        suggestions = result.get("suggestions", []) if isinstance(result, dict) else []
                        alternatives = ", ".join(suggestions)
                        return await respond(
                            f"यह स्लॉट अभी बुक हो गया है। उपलब्ध समय हैं: {alternatives}।" if alternatives
                            else "यह स्लॉट अभी बुक हो गया है। कृपया दूसरी तारीख चुनिए।",
                            "Wait for another selection, then call this tool again.",
                        )
                    else:
                        text = await resp.text()
                        logger.error("Appointment creation failed (%s): %s", resp.status, text)
                        return await respond(
                            "माफ़ कीजिए, अपॉइंटमेंट सेव नहीं हो सकी। कृपया हमारी टीम से पुष्टि कर लीजिए।",
                            "The appointment was not saved; do not claim confirmation.",
                        )
        except Exception as exc:
            logger.error("schedule_appointment error: %s", exc)
            return await respond(
                "माफ़ कीजिए, तकनीकी समस्या के कारण अपॉइंटमेंट सेव नहीं हो सकी।",
                "The appointment was not saved; offer team confirmation.",
            )

    @llm.function_tool(
        description=(
            "Use only after an OUTBOUND customer explicitly corrects their name or phone number. "
            "Never guess or replace identity from conversation context. Give the corrected full name and/or E.164 phone."
        )
    )
    async def update_customer_identity(
        self,
        customer_name: Optional[str] = None,
        phone: Optional[str] = None,
    ) -> str:
        if self._call_type != "outbound":
            return "Inbound identity must be collected when scheduling the appointment."
        name = " ".join((customer_name or self._customer_name or "").split())[:120]
        number = re.sub(r"[\s().-]", "", phone or self._phone_number or "")
        if not name or not re.fullmatch(r"\+[1-9]\d{7,14}", number):
            return "The corrected identity is incomplete. Ask the customer to repeat the missing detail."
        self._customer_name, self._phone_number = name, number
        return "Customer identity updated from an explicit correction. Continue with the known details."

    @llm.function_tool(
        description=(
            "Record a callback only after the customer asks for one and confirms a preferred callback time. "
            "For outbound calls, use the stored customer name and phone; do not ask again."
        )
    )
    async def schedule_callback(self, context: RunContext, preferred_time: str, reason: Optional[str] = None) -> str:
        name, phone = self._customer_name or "", self._phone_number or ""
        if not name or not re.fullmatch(r"\+[1-9]\d{7,14}", phone):
            return "Collect the customer's name and E.164 phone number before recording a callback."
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as http:
                async with http.post(
                    f"{CRM_API_URL}/api/calls/schedule-callback",
                    json={"customerName": name, "phone": phone, "preferredTime": preferred_time, "reason": reason or "Customer requested callback"},
                    headers={"Content-Type": "application/json", "x-api-secret": CRM_API_SECRET},
                    allow_redirects=False,
                ) as resp:
                    result = await resp.json(content_type=None)
                    if resp.status != 200 or not isinstance(result, dict) or result.get("success") is not True:
                        logger.error("Callback save failed (%s): %r", resp.status, result)
                        return "The callback was not saved. Do not promise that the team will call back."
        except Exception as exc:
            logger.error("schedule_callback error: %s", exc)
            return "The callback could not be saved. Do not promise that the team will call back."
        await context.session.say("जी, आपका कॉलबैक अनुरोध दर्ज हो गया है। हमारी टीम आपसे संपर्क करेगी।", allow_interruptions=False)
        self.call_outcome = "Callback scheduled"
        return "The callback confirmation was spoken. Do not repeat it."

    @llm.function_tool(
        description="End the call when finished or declined. This tool plays a Hindi goodbye itself; do not say a separate goodbye."
    )
    async def end_call(self, context: RunContext) -> str:
        logger.info("end_call tool invoked — draining goodbye before shutdown.")
        await context.wait_for_playout()
        await context.session.say("आपके समय के लिए धन्यवाद। नमस्ते!", allow_interruptions=False)
        context.session.shutdown(drain=True)
        return "Call ended."


# ─── CRM logging ───

async def log_call_to_crm(
    called_number: str,
    duration_seconds: float,
    transcript: str,
    call_type: str = "outbound",
    purpose: str = "",
    outcome: str = "",
    customer_name: str = "",
    status: str = "COMPLETED",
    room_name: str = "",
) -> bool:
    payload = {
        "customerName": customer_name or "Unknown Customer",
        "phone": called_number or "Unknown",
        "direction": "INBOUND" if call_type == "inbound" else "OUTBOUND",
        "status": status,
        "durationSec": round(duration_seconds),
        "agent": f"AI Agent - {AGENT_NAME}",
        "purpose": purpose or f"AI {call_type} call",
        "outcome": outcome or "Completed",
        "notes": f"AI-handled {call_type} call",
        "recording": False,
        "transcript": transcript,
        "callType": f"ai_{call_type}",
        "livekitRoomId": room_name,
    }
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as http:
            async with http.post(
                f"{CRM_API_URL}/api/calls/log",
                json=payload,
                headers={"Content-Type": "application/json", "x-api-secret": CRM_API_SECRET},
                allow_redirects=False,
            ) as resp:
                if resp.status == 200:
                    result = await resp.json(content_type=None)
                    if not isinstance(result, dict) or result.get("success") is not True:
                        logger.error("CRM log returned invalid success response: %r", result)
                        return False
                    logger.info("Call logged to CRM: id=%s", result.get("data", {}).get("id"))
                    return True
                logger.error("CRM log failed (%s): %s", resp.status, await resp.text())
    except Exception as e:
        logger.error("Failed to log call to CRM: %s", e)
    return False


# ─── Worker ───

def prewarm(proc: JobProcess) -> None:
    # Load with telephony-tuned settings: higher threshold + longer silence to
    # avoid SIP background noise triggering false interruptions
    proc.userdata["vad"] = silero.VAD.load(
        min_speech_duration=0.2,
        min_silence_duration=0.35,
        prefix_padding_duration=0.3,
        # 0.65 can miss quieter speech on a PSTN/SIP line. This remains
        # configurable for noisy trunks without preventing normal replies.
        activation_threshold=_env_threshold("SILERO_ACTIVATION_THRESHOLD", 0.5),
    )
    logger.info("Silero VAD pre-warmed (telephony profile).")


async def entrypoint(ctx: JobContext) -> None:
    try:
        call_context = CallContext.from_metadata(ctx.job.metadata)
    except ValueError as exc:
        logger.error("Invalid call metadata: %s", exc)
        ctx.shutdown()
        return
    phone_number = call_context.phone_number or None
    call_reason = call_context.reason
    call_type = call_context.call_type
    customer_name = call_context.customer_name

    if not os.getenv("GROQ_API_KEY", "").strip():
        logger.error("GROQ_API_KEY missing — configure Groq before accepting calls.")
        ctx.shutdown()
        return

    logger.info("Job started | type=%s | number=%s | reason=%s", call_type, phone_number or "WEB-TEST", call_reason)

    # Connect to LiveKit room
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    logger.info("Connected to room: %s", ctx.room.name)

    call_start: Optional[float] = None
    call_status = "NO_ANSWER" if call_type == "outbound" else "MISSED"
    call_outcome = "Call did not connect"
    transcript_lines: list[str] = []

    # Snapshots are serialized and upserted by room ID. This makes the call and
    # transcript visible before hangup and still flushes the final duration.
    log_lock = asyncio.Lock()
    last_saved_snapshot: Optional[tuple] = None

    async def save_call() -> None:
        nonlocal last_saved_snapshot
        async with log_lock:
            duration_seconds = time.monotonic() - call_start if call_start is not None else 0
            transcript = "\n".join(transcript_lines)
            snapshot = (round(duration_seconds), transcript, call_status, call_outcome, phone_number)
            if snapshot == last_saved_snapshot:
                return
            saved = await log_call_to_crm(
                called_number=phone_number or "web-test",
                duration_seconds=duration_seconds,
                transcript=transcript, call_type=call_type,
                purpose=call_reason, customer_name=customer_name, status=call_status,
                outcome=call_outcome, room_name=ctx.room.name,
            )
            if saved is not False:
                last_saved_snapshot = snapshot

    ctx.add_shutdown_callback(save_call)

    # VAD — use prewarm instance (telephony-tuned settings already applied)
    vad_instance = ctx.proc.userdata.get("vad") or silero.VAD.load(
        min_speech_duration=0.2,
        min_silence_duration=0.35,
        prefix_padding_duration=0.3,
        activation_threshold=_env_threshold("SILERO_ACTIVATION_THRESHOLD", 0.5),
    )

    # Tools
    tools_ctx = CRMTools(ctx, phone_number, customer_name, call_type)

    # System prompt
    system_prompt = call_context.instructions()

    # LLM
    llm_instance = openai.LLM(
        model=GROQ_MODEL,
        base_url="https://api.groq.com/openai/v1",
        api_key=os.environ["GROQ_API_KEY"],
        temperature=GROQ_TEMPERATURE,
        top_p=GROQ_TOP_P,
        max_completion_tokens=GROQ_MAX_TOKENS,
        parallel_tool_calls=False,
        **GROQ_EXTRA_OPTIONS,
    )
    logger.info("LLM configured | provider=groq | model=%s", GROQ_MODEL)

    # Build agent — no VAD here; session owns VAD to avoid double processing
    tts_language = os.getenv("SARVAM_TTS_LANGUAGE", SARVAM_LANGUAGE)
    tts_model = os.getenv("SARVAM_TTS_MODEL", SARVAM_MODEL)
    tts_speaker = os.getenv("SARVAM_TTS_SPEAKER", DEFAULT_TTS_VOICE)

    logger.info(
        "STT configured | provider=deepgram | model=%s | language=%s",
        STT_MODEL,
        STT_LANGUAGE,
    )
    logger.info(
        "TTS configured | provider=sarvam | model=%s | speaker=%s | language=%s",
        tts_model,
        tts_speaker,
        tts_language,
    )

    tts_instance = sarvam.TTS(
        target_language_code=tts_language,
        model=tts_model,
        speaker=tts_speaker,
        speech_sample_rate=8000,
        pace=_env_float("SARVAM_TTS_PACE", 1.0),
        temperature=_env_float("SARVAM_TTS_TEMPERATURE", 0.6),
        min_buffer_size=_env_int("SARVAM_TTS_MIN_BUFFER_SIZE", 30),
        max_chunk_length=_env_int("SARVAM_TTS_MAX_CHUNK_LENGTH", 120),
    )

    agent = Agent(
        instructions=system_prompt,
        stt=deepgram.STT(
            model=STT_MODEL,
            language=STT_LANGUAGE,
            # Keyterms improve brand/product recognition even in Deepgram's
            # multilingual mode; suppressing them for "multi" loses Sekol and
            # tile-name accuracy on the exact calls this worker handles.
            keyterm=STT_KEYTERMS,
            smart_format=True,
            numerals=True,
        ),
        llm=llm_instance,
        tts=tts_instance,
        tools=list(tools_ctx.function_tools.values()),
        allow_interruptions=True,
        min_endpointing_delay=_env_float("AGENT_MIN_ENDPOINTING_DELAY", 0.38),
    )

    # Build session — VAD lives here only
    session = AgentSession(
        vad=vad_instance,
        allow_interruptions=True,
        min_interruption_duration=_env_float("SESSION_MIN_INTERRUPTION_DURATION", 0.8),
        min_interruption_words=_env_int("SESSION_MIN_INTERRUPTION_WORDS", 2),
        min_endpointing_delay=_env_float("SESSION_MIN_ENDPOINTING_DELAY", 0.25),
        max_endpointing_delay=_env_float("SESSION_MAX_ENDPOINTING_DELAY", 0.8),
        preemptive_generation=True,
    )
    voice_session_started = False

    # Transcript collector
    @session.on("conversation_item_added")
    def on_item(ev) -> None:
        msg = ev.item
        if not isinstance(msg, llm.ChatMessage):
            return
        text = (msg.text_content or "").strip()
        if not text:
            return
        if msg.role == "user":
            transcript_lines.append(f"Customer: {text}")
            logger.info("Customer: %s", text)
        elif msg.role == "assistant":
            transcript_lines.append(f"Agent: {text}")
            logger.info("%s: %s", AGENT_NAME, text)
            metrics = getattr(msg, "metrics", None)
            if metrics is not None:
                logger.info("Turn latency metrics: %s", metrics)
        asyncio.create_task(save_call())

    @session.on("user_input_transcribed")
    def on_transcription(ev) -> None:
        # This is intentionally separate from the saved transcript: it makes
        # it clear in the worker logs whether a non-response is STT or LLM/TTS.
        if ev.is_final:
            logger.info("Final STT transcription: %s", ev.transcript)

    @session.on("error")
    def on_session_error(ev) -> None:
        logger.error("Voice pipeline error | source=%s | error=%s", ev.source, ev.error)
        asyncio.create_task(save_call())

    session_closed = asyncio.Event()

    @session.on("close")
    def on_close(ev) -> None:
        logger.info("Session closed.")
        session_closed.set()

    room_options_kwargs = {
        "audio_input": AudioInputOptions(
            sample_rate=8000,
            num_channels=1,
            noise_cancellation=noise_cancellation.BVCTelephony(),
        ),
        "audio_output": AudioOutputOptions(sample_rate=8000, num_channels=1),
        # The session starts before dialing, but RoomIO only applies this after
        # a participant is linked. Close promptly when that callee hangs up.
        "close_on_disconnect": True,
    }

    # Outbound: start RoomIO before dialing.  It must be subscribed before the
    # SIP participant publishes its microphone track; starting it after the
    # answer can leave TTS working while no caller audio reaches Deepgram.
    outbound_trunk_id = await resolve_outbound_trunk(ctx) if call_type == "outbound" else ""
    if call_type == "outbound" and phone_number and outbound_trunk_id:
        logger.info("Dialling %s via trunk %s ...", phone_number, outbound_trunk_id)
        try:
            # The outbound SIP identity is deterministic. Bind RoomIO to it
            # before dialing so the only caller audio stream accepted is this
            # customer's stream, including frames published during SIP setup.
            room_options_kwargs["participant_identity"] = f"sip_{phone_number}"
            await session.start(
                agent,
                room=ctx.room,
                room_options=RoomOptions(**room_options_kwargs),
            )
            voice_session_started = True
            logger.info("Voice pipeline armed before SIP participant joins.")
            await ctx.api.sip.create_sip_participant(
                api.CreateSIPParticipantRequest(
                    room_name=ctx.room.name,
                    sip_trunk_id=outbound_trunk_id,
                    sip_call_to=phone_number,
                    participant_identity=f"sip_{phone_number}",
                    wait_until_answered=True,  # block until customer picks up
                )
            )
            call_start = time.monotonic()
            call_status, call_outcome = "IN_PROGRESS", "Customer answered; AI conversation in progress"
            # create_sip_participant returning means the phone answered. Wait
            # for the actual participant before publishing the greeting.
            participant = await asyncio.wait_for(
                ctx.wait_for_participant(identity=f"sip_{phone_number}"),
                timeout=10,
            )
            logger.info("Voice pipeline ready | participant=%s", participant.identity)
            logger.info("SIP participant ready | identity=%s | sending greeting via TTS.", participant.identity)
            await session.say(
                build_outbound_greeting(call_reason, customer_name),
                add_to_chat_ctx=True,
                allow_interruptions=False,
            )
            await save_call()
            logger.info("Greeting playback completed.")
        except Exception as exc:
            logger.error("Outbound call failed: %s", exc)
            call_status, call_outcome = _dial_failure_status(exc)
            if voice_session_started:
                await session.aclose()
            await save_call()
            try:
                await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
            except Exception:
                logger.warning("Could not clean up failed outbound room")
            ctx.shutdown()
            return

    elif call_type == "outbound" and not outbound_trunk_id:
        logger.error("No valid outbound SIP trunk found — cannot dial.")
        call_status, call_outcome = "FAILED", "Outbound SIP trunk not configured"
        await save_call()
        ctx.shutdown()
        return

    else:
        # Inbound or browser test — participant already in room
        logger.info("Inbound/browser mode — waiting for participant...")
        participant = await ctx.wait_for_participant()
        if participant.kind == api.ParticipantInfo.Kind.SIP:
            phone_number = participant.attributes.get("sip.phoneNumber") or phone_number
            # The caller ID arrives only after the participant joins. Keep the
            # appointment tool in sync with that late-bound inbound context.
            tools_ctx._phone_number = phone_number
            # Incoming caller ID is only available once the SIP participant joins.
            await agent.update_instructions(CallContext(
                call_type=call_type, customer_name=customer_name,
                phone_number=phone_number or "", reason=call_reason,
            ).instructions())
        room_options_kwargs["participant_identity"] = participant.identity
        await session.start(
            agent,
            room=ctx.room,
            room_options=RoomOptions(**room_options_kwargs),
        )
        voice_session_started = True
        logger.info("Voice pipeline ready | participant=%s", participant.identity)
        call_start = time.monotonic()
        call_status, call_outcome = "IN_PROGRESS", "AI conversation in progress"
        await session.say(
            f"नमस्ते! {BRAND_NAME} में आपका स्वागत है, मैं {AGENT_NAME} बोल रही हूँ — कैसे मदद करूँ?",
            add_to_chat_ctx=True,
            allow_interruptions=True,
        )
        await save_call()

    # Max duration guard
    async def enforce_max_duration() -> None:
        await asyncio.sleep(MAX_CALL_DURATION)
        logger.warning("Max call duration reached — ending call.")
        await session.say(
            "माफ़ कीजिए, कॉल का समय पूरा हो गया है। आप फिर कॉल कर सकते हैं। धन्यवाद, नमस्ते!",
            allow_interruptions=False,
        )
        session.shutdown(drain=True)

    max_duration_task = asyncio.create_task(enforce_max_duration())

    # Wait for session to close
    try:
        await session_closed.wait()
    finally:
        max_duration_task.cancel()
        if call_status == "IN_PROGRESS":
            call_status, call_outcome = "COMPLETED", tools_ctx.call_outcome or "Conversation completed"
        await save_call()
        # Leaving only the worker can leave the SIP participant connected.
        try:
            await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
        except Exception:
            logger.warning("Room already closed or could not be deleted")
        ctx.shutdown()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            agent_name=WORKER_NAME,
            # The SDK's production default (0.7) made this desktop worker
            # unavailable during ordinary CPU spikes, delaying outbound calls.
            load_threshold=_env_threshold("AI_WORKER_LOAD_THRESHOLD", 2.0),
            # A single-call CRM does not need four VAD runners pre-warmed.
            # Keeping one idle runner cuts background load without adding
            # cold-start latency to the next call.
            num_idle_processes=max(1, _env_int("AI_WORKER_IDLE_PROCESSES", 1)),
        ),
    )
