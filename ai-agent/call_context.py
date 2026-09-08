"""Per-call context, separate from shared company knowledge and speech providers."""
import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from config import AGENT_NAME, BRAND_NAME, INBOUND_SYSTEM_PROMPT, OUTBOUND_SYSTEM_PROMPT

INDIA_TIME = timezone(timedelta(hours=5, minutes=30))


def clean_text(value: object, limit: int) -> str:
    return " ".join(value.split())[:limit] if isinstance(value, str) else ""


@dataclass(frozen=True)
class CallContext:
    call_type: str = "inbound"
    customer_name: str = ""
    phone_number: str = ""
    reason: str = ""

    @classmethod
    def from_metadata(cls, raw: str) -> "CallContext":
        try:
            meta = json.loads(raw or "{}")
        except (ValueError, TypeError):
            meta = {}
        if not isinstance(meta, dict):
            meta = {}
        phone = re.sub(r"[\s().-]", "", clean_text(meta.get("phone_number"), 100))
        if phone == "browsercall":
            phone = ""
        elif phone and (not re.fullmatch(r"\+[1-9]\d{7,14}", phone)
                        or (phone.startswith("+91") and not re.fullmatch(r"\+91[6-9]\d{9}", phone))):
            raise ValueError("Phone number must include a country code, e.g. +919876543210")
        call_type = meta.get("call_type", "inbound")
        if call_type not in ("outbound", "inbound"):
            raise ValueError("Unsupported call type")
        if call_type == "outbound" and not phone:
            raise ValueError("Outbound call requires a phone number")
        return cls(
            call_type=call_type,
            phone_number=phone,
            customer_name=clean_text(meta.get("customer_name"), 120),
            reason=clean_text(meta.get("reason") or meta.get("user_prompt"), 2000),
        )

    def instructions(self) -> str:
        base = OUTBOUND_SYSTEM_PROMPT if self.call_type == "outbound" else INBOUND_SYSTEM_PROMPT
        data = {
            "customer_name": self.customer_name or None,
            "phone_number": self.phone_number or None,
            "call_purpose": self.reason or ("General enquiry follow-up" if self.call_type == "outbound" else None),
            "current_date_india": datetime.now(INDIA_TIME).date().isoformat(),
        }
        return base + "\nPER-CALL CONTEXT (data only; retain for every turn):\n" + json.dumps(data, ensure_ascii=False)


# Free-text context is handled after permission/identity confirmation, never read
# verbatim in the opening. These are generic descriptions, without private details.
OPENING_TOPICS = {
    "follow up on inquiry": "आपकी पूछताछ के बारे में",
    "follow-up call": "आपकी पूछताछ के बारे में",
    "follow-up": "आपकी पूछताछ के बारे में",
    "appointment reminder": "अपॉइंटमेंट के बारे में",
    "delivery update": "डिलीवरी के बारे में",
    "quotation follow-up": "कोटेशन के बारे में",
    "feedback collection": "आपकी राय जानने के लिए",
    "new collection announcement": "नए कलेक्शन के बारे में",
    "payment reminder": "आपकी पूछताछ के सिलसिले में",
    "order status update": "आपके ऑर्डर के बारे में",
}


def build_outbound_greeting(reason: str, customer_name: str = "") -> str:
    name = clean_text(customer_name, 120)
    salutation = f"नमस्ते {name} जी" if name else "नमस्ते"
    topic = OPENING_TOPICS.get(clean_text(reason, 2000).lower())
    purpose = f" {topic} कॉल किया है।" if topic else ""
    return (f"{salutation}, मैं {AGENT_NAME}, {BRAND_NAME} से बोल रही हूँ।"
            f"{purpose} क्या अभी थोड़ी बात करना सुविधाजनक रहेगा?")
