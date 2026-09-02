"""Project KOTOBA - Live Speech-to-Text & Translation Backend.

FastAPI application providing:
- Real-time tab audio streaming to Deepgram Nova-3 (Linear16 PCM, 16kHz).
- Incremental sentence buffering with 2-sentence lookahead.
- Context-aware Japanese-to-English translation via Google Gemini (Lore + Chat grounding).
- VTuber Knowledge Base entity resolution and REST endpoints.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import uuid

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from pydantic import BaseModel, Field
import uvicorn
import websockets

# ==============================================================================
# Environment & Configuration Settings
# ==============================================================================

base_dir = Path(__file__).resolve().parent
env_candidate_paths = [
    base_dir / ".env",
    base_dir.parent / ".env",
    Path.cwd() / ".env",
    Path.cwd() / "backend" / ".env",
]

for env_path in env_candidate_paths:
    if env_path.exists():
        load_dotenv(env_path)
        break
else:
    load_dotenv()

# --- Customizable Parameters & Settings ---

# 1. Server Network Settings
SERVER_HOST: str = "127.0.0.1"
SERVER_PORT: int = 8000

# 2. Gemini AI Translation Parameters
DEBUG_MOCK_TRANSLATION: bool = False  # Temporary debug mock: returns '<translation>' instead of calling Gemini
GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
GEMINI_TEMPERATURE: float = 0.3
GEMINI_MAX_OUTPUT_TOKENS: int = 800
CHAT_CONTEXT_COUNT: int = 20  # Number of recent live chat messages to pass to Gemini
CONTEXT_HISTORY_MAX: int = 50  # Maximum translated sentences retained for context memory
SUMMARY_MAX_WORDS: int = 500  # Maximum target word count for running stream summary

# 3. Sentence Buffering & Punctuation Flushing
BUFFER_MIN_CHARS_THRESHOLD: int = 30  # Min character threshold before watching for punctuation
BUFFER_FLUSH_DELAY_SECONDS: float = 3.0  # Delay in seconds before auto-flushing completed sentences
PUNCTUATION_PATTERN: re.Pattern = re.compile(r"[.?!。！？…\n|।؟]")

# 4. Translation Lookahead Buffer
TRANSLATION_LOOKAHEAD_TIMEOUT_SECONDS: float = 3.0  # Lookahead wait timeout for 2nd sentence

# 5. Deepgram Speech-to-Text Parameters
DEEPGRAM_MODEL: str = "nova-3"
DEEPGRAM_DEFAULT_LANGUAGE: str = "ja"
DEEPGRAM_SMART_FORMAT: str = "true"
DEEPGRAM_ENCODING: str = "linear16"
DEEPGRAM_SAMPLE_RATE: str = "16000"
DEEPGRAM_CHANNELS: str = "1"
DEEPGRAM_ENDPOINTING_MS: str = "300"
DEEPGRAM_UTTERANCE_END_MS: str = "1000"
DEEPGRAM_VAD_EVENTS: str = "true"
DEEPGRAM_KEEPALIVE_INTERVAL_SECONDS: float = 5.0

# 6. In-Memory Session Cache Limits
LIVE_CHAT_BUFFER_MAX: int = 40  # Maximum live chat items stored per session

# --- API Keys & Clients ---
deepgram_api_key = os.getenv("DEEPGRAM_API_KEY")
if not deepgram_api_key:
    raise ValueError("DEEPGRAM_API_KEY environment variable is not set.")

gemini_api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")

app = FastAPI(title="Project KOTOBA Backend - Live STT & Translation")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

gemini_client = genai.Client(api_key=gemini_api_key) if gemini_api_key else None
if gemini_client:
    print(f">> [Init] Translation Client Ready! Model: {GEMINI_MODEL}", flush=True)
else:
    print(">> [Init] GEMINI_API_KEY not found. Translations will be skipped.", flush=True)


# ==============================================================================
# VTuber Knowledge Base
# ==============================================================================

class VTuberKnowledgeBase:
    """Manages the in-memory database of VTubers, affiliated agencies/offices, and channels."""

    def __init__(self, kb_dir: Path) -> None:
        self.vtubers: list[dict] = []
        self.offices: dict[int, str] = {}
        vtubers_file = kb_dir / "vtubers.json"
        offices_file = kb_dir / "offices.json"

        if vtubers_file.exists():
            try:
                with open(vtubers_file, "r", encoding="utf-8") as f:
                    self.vtubers = json.load(f)
                print(f">> [Init] Loaded {len(self.vtubers)} VTuber records from {vtubers_file.name}", flush=True)
            except Exception as e:
                print(f"[Init Warning] Failed to load vtubers.json: {e}", flush=True)

        if offices_file.exists():
            try:
                with open(offices_file, "r", encoding="utf-8") as f:
                    offices_list = json.load(f)
                    self.offices = {
                        item["office_id"]: item.get("office_name", "")
                        for item in offices_list
                        if "office_id" in item
                    }
                print(f">> [Init] Loaded {len(self.offices)} office records from {offices_file.name}", flush=True)
            except Exception as e:
                print(f"[Init Warning] Failed to load offices.json: {e}", flush=True)

    def get_office_name(self, office_id: int | None) -> str:
        """Return the agency name for a given office ID."""
        if office_id is None:
            return ""
        return self.offices.get(office_id, "")

    def format_display_name(self, vtuber: dict | None, fallback: str = "") -> str:
        """Format VTuber name syntax: 'english_name - kanji_name' or fallback."""
        if not vtuber:
            return fallback

        names = vtuber.get("vtuber_names", {})
        eng = (names.get("english_name") or "").strip()
        kanji = (names.get("kanji_name") or "").strip()

        if eng and kanji:
            return f"{eng} - {kanji}"
        return eng or kanji or fallback

    def lookup(self, channel_name: str = "", channel_link: str = "") -> dict | None:
        """Match a VTuber by channel URL, channel name, kanji name, or English name."""
        if not self.vtubers:
            return None

        link_clean = (channel_link or "").strip().rstrip("/")
        name_clean = (channel_name or "").strip()

        # 1. Exact or partial match on channel_link
        if link_clean:
            for vt in self.vtubers:
                for ch in vt.get("channels", []):
                    cl = (ch.get("channel_link") or "").strip().rstrip("/")
                    if cl and (cl == link_clean or cl in link_clean or link_clean in cl):
                        return vt

        # 2. Match on channel_name in channels list
        if name_clean:
            name_lower = name_clean.lower()
            for vt in self.vtubers:
                for ch in vt.get("channels", []):
                    cn = (ch.get("channel_name") or "").strip().lower()
                    if cn and (cn == name_lower or cn in name_lower or name_lower in cn):
                        return vt

            # 3. Match on kanji_name (exact substring, min 2 chars)
            for vt in self.vtubers:
                kanji = (vt.get("vtuber_names", {}).get("kanji_name") or "").strip()
                if kanji and len(kanji) >= 2 and kanji in name_clean:
                    return vt

            # 4. Match on english_name (word boundary match, exclude generic words)
            for vt in self.vtubers:
                eng = (vt.get("vtuber_names", {}).get("english_name") or "").strip()
                if eng and len(eng) >= 3 and eng.lower() not in ("unknown", "none", "null"):
                    if eng.lower() == name_lower or re.search(r"\b" + re.escape(eng.lower()) + r"\b", name_lower):
                        return vt

        return None


# Initialize VTuber Knowledge Base
kb_dir = base_dir.parent / "dataset" / "kb"
if not kb_dir.exists():
    kb_dir = Path.cwd() / "dataset" / "kb"
kb = VTuberKnowledgeBase(kb_dir)


# ==============================================================================
# Translation Schema & Sentence Utilities
# ==============================================================================

class TranslationResponse(BaseModel):
    """Structured response schema returned by Google Gemini for stream translation."""

    translation: str = Field(description="Natural English translation for the target Japanese speech.")
    sentences: int = Field(description="Number of Japanese sentences consumed (1 or 2).")
    relevant_comment: int = Field(
        default=0,
        description=f"1-based index (1-{CHAT_CONTEXT_COUNT}) of the chat comment the speaker is responding to, or 0 if none.",
    )
    relevant_comment_translation: str | None = Field(
        default=None,
        description="English translation of the relevant chat comment, or null.",
    )
    summary: str | None = Field(
        default=None,
        description=f"Concise running summary of the current conversation/stream topic and context so far, maximum {SUMMARY_MAX_WORDS} words.",
    )


def extract_sentences_and_remainder(text: str, min_length: int = 0) -> tuple[list[str], str]:
    """Extract text from start to the last punctuation mark as a sentence, returning remainder."""
    if not text or len(text) < min_length:
        return [], text

    matches = list(PUNCTUATION_PATTERN.finditer(text))
    if not matches:
        return [], text.strip()

    last_end = matches[-1].end()
    sentence = text[:last_end].strip()
    remainder = text[last_end:].strip()
    return ([sentence], remainder) if sentence else ([], remainder)


def split_sentences(text: str) -> list[str]:
    """Split transcript text into individual sentences."""
    text = text.strip()
    if not text:
        return []

    pattern = r"([^.?!。！？…\n|।؟]+[.?!。！？…\n|।؟]+)"
    matches = list(re.finditer(pattern, text))
    sentences = [m.group(1).strip() for m in matches if m.group(1).strip()]
    last_end = matches[-1].end() if matches else 0
    remainder = text[last_end:].strip()
    if remainder:
        sentences.append(remainder)
    return sentences if sentences else [text]


# ==============================================================================
# Gemini Translation Pipeline
# ==============================================================================

TRANSLATION_SYSTEM_PROMPT = f"""You are a real-time translator specializing in Japanese live streams, VTubers, gaming, and internet culture.
Your goal is to translate Japanese spoken stream speech into clear, natural, and expressive English subtitles.

Guidelines:
1. Preserve conversational tone, emotions, humor, colloquialisms, and stream slang.
2. The original text might be incomplete or malformed due to real-time speech recognition; translate based on natural spoken intent and phonetics.
3. You will receive:
   - "Recent Live Stream Chat": Numbered list (1 to {CHAT_CONTEXT_COUNT}) of viewer comments the speaker may be reacting or replying to.
   - "Running Stream Context Summary": Summary of the stream/conversation topic up to this point.
   - "Sentence 1 (Target Japanese)": The primary sentence to translate.
   - "Sentence 2 (Lookahead Japanese)": The immediate next sentence spoken, provided as forward context.
4. Coherence and Sentence Count Decision:
   - If Sentence 1 is a standalone thought, translate ONLY Sentence 1 and return `sentences: 1`.
   - If Sentence 1 and Sentence 2 form a single cohesive thought that MUST be translated together, translate BOTH and return `sentences: 2`.
5. Chat Response Attribution:
   - If the speaker is responding to a specific comment, set `relevant_comment` to its 1-based index (1-{CHAT_CONTEXT_COUNT}) and provide `relevant_comment_translation`.
   - If speaking independently, set `relevant_comment: 0` and `relevant_comment_translation: null`.
6. Context Summary:
   - In `summary`, provide an updated running summary of the current stream context, topic, and storyline so far based on the inputs and previous summary (maximum {SUMMARY_MAX_WORDS} words, no minimum constraints). Keep it concise, coherent, and informative.
7. Return valid JSON with: "translation", "sentences" (1 or 2), "relevant_comment" (0-{CHAT_CONTEXT_COUNT}), "relevant_comment_translation", "summary"."""


async def translate_japanese_stream(
    sentence_1: str,
    sentence_2: str = "",
    current_summary: str = "",
    stream_title: str = "",
    stream_channel: str = "",
    recent_chat: list[dict] | None = None,
    vtuber_info: dict | None = None,
) -> tuple[str, int, int, str, str]:
    """Translate Japanese transcript to English using running summary context.

    Returns:
        (translation, sentences_consumed, relevant_comment_idx, relevant_comment_translation, summary)
    """
    if not gemini_client or not sentence_1.strip():
        return "", 1, 0, "", ""

    prompt_parts: list[str] = []

    # Streamer & VTuber Lore Context
    if vtuber_info:
        v_lines: list[str] = []
        eng = vtuber_info.get("vtuber_names", {}).get("english_name")
        kanji = vtuber_info.get("vtuber_names", {}).get("kanji_name")
        if eng or kanji:
            v_lines.append(f"VTuber / Streamer: {eng or ''} ({kanji or ''})")
        facts = vtuber_info.get("facts", [])
        if facts:
            v_lines.append("Key Facts & Lore: " + " ".join(facts[:3]))
        if v_lines:
            prompt_parts.append("Streamer Profile Context:\n" + "\n".join(v_lines))

    if stream_channel or stream_title:
        meta: list[str] = []
        if stream_channel:
            meta.append(f"Channel / Speaker: {stream_channel}")
        if stream_title:
            meta.append(f"Stream / Video Title: {stream_title}")
        prompt_parts.append("Media Metadata:\n" + "\n".join(meta))

    if recent_chat:
        lines = "\n".join(
            [
                f"{i + 1}. [{c.get('author', 'Viewer')}]: {c.get('message', '')}"
                for i, c in enumerate(recent_chat[-CHAT_CONTEXT_COUNT:])
                if c.get("message")
            ]
        )
        if lines:
            prompt_parts.append(f"Recent Live Stream Chat (Context):\n{lines}")

    if current_summary:
        prompt_parts.append(f"Running Stream Context Summary:\n{current_summary}")

    prompt_parts.append(f"Sentence 1 (Target Japanese):\n{sentence_1}")
    if sentence_2:
        prompt_parts.append(f"Sentence 2 (Lookahead Japanese):\n{sentence_2}")

    # Temporary Debug Mock Translation
    if DEBUG_MOCK_TRANSLATION:
        print(f">> [DEBUG MOCK] Bypassing Gemini: returning '<translation>' for '{sentence_1}'", flush=True)
        return "<translation>", 1, 0, "", current_summary

    try:
        response = await gemini_client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents="\n\n".join(prompt_parts),
            config=types.GenerateContentConfig(
                system_instruction=TRANSLATION_SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=TranslationResponse,
                temperature=GEMINI_TEMPERATURE,
                max_output_tokens=GEMINI_MAX_OUTPUT_TOKENS,
            ),
        )
        if response and response.text:
            data = json.loads(response.text)
            trans = str(data.get("translation", "")).strip()
            count = int(data.get("sentences", 1))
            if count not in (1, 2):
                count = 1
            if not sentence_2:
                count = 1
            rel = data.get("relevant_comment", 0)
            rel_trans = str(data.get("relevant_comment_translation") or "").strip()
            rel_idx = rel if isinstance(rel, int) and 1 <= rel <= CHAT_CONTEXT_COUNT else 0
            summary = str(data.get("summary") or "").strip()
            return trans, count, rel_idx, rel_trans, summary
    except Exception as e:
        print(f"[Translation Error]: {e}", flush=True)

    return "", 1, 0, "", ""


# ==============================================================================
# REST Endpoints
# ==============================================================================

@app.get("/")
async def health_check() -> dict:
    """Return backend health and connection readiness status."""
    return {
        "status": "online",
        "service": "Project KOTOBA",
        "ws_url": "ws://127.0.0.1:8000/listen",
        "deepgram_ready": bool(deepgram_api_key),
        "gemini_ready": bool(gemini_client),
        "translation_model": GEMINI_MODEL if gemini_client else "none",
        "vtuber_database_count": len(kb.vtubers),
    }


@app.get("/api/vtuber/lookup")
async def lookup_vtuber_endpoint(channel_name: str = "", channel_link: str = "") -> dict:
    """Lookup a VTuber by channel name and/or channel link."""
    vt = kb.lookup(channel_name=channel_name, channel_link=channel_link)
    display_name = kb.format_display_name(vt, fallback=channel_name)
    office_id = vt.get("office_id") if vt else None
    office_name = kb.get_office_name(office_id)
    return {
        "found": bool(vt),
        "display_name": display_name,
        "vtuber_id": vt.get("vtuber_id") if vt else None,
        "vtuber_names": vt.get("vtuber_names", {}) if vt else {},
        "office_id": office_id,
        "office_name": office_name,
        "facts": vt.get("facts", []) if vt else [],
        "channels": vt.get("channels", []) if vt else [],
        "description": vt.get("description", "") if vt else "",
    }


# ==============================================================================
# WebSocket Audio & Translation Pipeline
# ==============================================================================

@app.websocket("/listen")
async def listen(
    websocket: WebSocket,
    language: str = "ja",
    model: str = "nova-3",
    title: str = "",
    channel: str = "",
    channel_link: str = "",
    translate: bool = False,
) -> None:
    """Accept browser audio streams, proxy to Deepgram, and translate in batches."""
    await websocket.accept()

    sid = uuid.uuid4().hex[:8]
    context_history: list[str] = []
    sentence_buffer: list[dict] = []
    live_chat_buffer: list[dict] = []
    pending_buffer: str = ""
    buffer_event = asyncio.Event()

    # Match VTuber from Knowledge Base
    matched_vtuber = kb.lookup(channel_name=channel, channel_link=channel_link)
    display_channel_name = kb.format_display_name(matched_vtuber, fallback=channel)
    req_lang = language.strip() if language else "ja"

    print("\n==========================================", flush=True)
    print(f">> [Session {sid}] Connected | Channel: '{display_channel_name}' | Title: '{title}'", flush=True)
    if matched_vtuber:
        print(f">> [VTuber Matched] ID: {matched_vtuber.get('vtuber_id')} -> {display_channel_name}", flush=True)
    print(f">> STT: nova-3/{req_lang} | Translator: {GEMINI_MODEL if gemini_client else 'None'}", flush=True)
    print("==========================================", flush=True)

    try:
        await websocket.send_json({
            "type": "status",
            "status": "connected",
            "model": "nova-3",
            "language": req_lang,
            "translation_ready": bool(gemini_client),
            "translation_model": GEMINI_MODEL if gemini_client else None,
            "vtuber_found": bool(matched_vtuber),
            "display_name": display_channel_name,
            "vtuber_names": matched_vtuber.get("vtuber_names", {}) if matched_vtuber else {},
        })
    except Exception:
        pass

    dg_params = {
        "model": DEEPGRAM_MODEL,
        "language": req_lang,
        "punctuate": "true",
        "interim_results": "true",
        "smart_format": DEEPGRAM_SMART_FORMAT,
        "encoding": DEEPGRAM_ENCODING,
        "sample_rate": DEEPGRAM_SAMPLE_RATE,
        "channels": DEEPGRAM_CHANNELS,
        "endpointing": DEEPGRAM_ENDPOINTING_MS,
        "utterance_end_ms": DEEPGRAM_UTTERANCE_END_MS,
        "vad_events": DEEPGRAM_VAD_EVENTS,
    }
    dg_url = f"wss://api.deepgram.com/v1/listen?{urllib.parse.urlencode(dg_params)}"

    try:
        async with websockets.connect(
            dg_url,
            additional_headers={"Authorization": f"Token {deepgram_api_key}"},
            open_timeout=10,
        ) as dg_ws:
            print(f">> [Session {sid}] Deepgram connected. Streaming audio...", flush=True)

            async def forward_audio() -> None:
                chunk_count = 0
                try:
                    while True:
                        msg = await websocket.receive()
                        if msg.get("type") == "websocket.disconnect":
                            break

                        if "bytes" in msg and msg["bytes"]:
                            chunk_count += 1
                            if chunk_count == 1:
                                print(f">> [Session {sid}] Receiving PCM audio ({len(msg['bytes'])} bytes/chunk)", flush=True)
                            await dg_ws.send(msg["bytes"])

                        elif "text" in msg and msg["text"]:
                            try:
                                payload = json.loads(msg["text"])
                                if payload.get("type") == "chat" and "data" in payload:
                                    item = payload["data"]
                                    if not item.get("id"):
                                        item["id"] = f"chat_{int(time.time() * 1000)}_{uuid.uuid4().hex[:4]}"
                                    live_chat_buffer.append(item)
                                    if len(live_chat_buffer) > LIVE_CHAT_BUFFER_MAX:
                                        del live_chat_buffer[:-LIVE_CHAT_BUFFER_MAX]
                                elif payload.get("type") == "chat_batch" and "messages" in payload:
                                    for item in payload["messages"]:
                                        if not item.get("id"):
                                            item["id"] = f"chat_{int(time.time() * 1000)}_{uuid.uuid4().hex[:4]}"
                                        live_chat_buffer.append(item)
                                    if len(live_chat_buffer) > LIVE_CHAT_BUFFER_MAX:
                                        del live_chat_buffer[:-LIVE_CHAT_BUFFER_MAX]
                            except Exception:
                                pass
                except (WebSocketDisconnect, asyncio.CancelledError):
                    pass

            async def receive_transcripts() -> None:
                nonlocal pending_buffer
                flush_timer_task: asyncio.Task | None = None

                def cancel_flush_timer() -> None:
                    nonlocal flush_timer_task
                    if flush_timer_task and not flush_timer_task.done():
                        flush_timer_task.cancel()
                    flush_timer_task = None

                async def flush_sentence(s: str, is_speech_final: bool = False) -> None:
                    nonlocal sentence_buffer
                    if not s.strip():
                        return
                    ts = datetime.now().strftime("%H:%M:%S")
                    s_id = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:4]}"
                    print(f">> [Sentence] ({ts}): {s}", flush=True)
                    try:
                        await websocket.send_json({
                            "type": "transcript",
                            "id": s_id,
                            "transcript": s,
                            "is_final": True,
                            "speech_final": is_speech_final,
                            "time": ts,
                        })
                    except Exception:
                        pass
                    sentence_buffer.append({"id": s_id, "text": s, "time": ts, "speech_final": is_speech_final})
                    if sentence_buffer:
                        buffer_event.set()

                async def flush_completed_sentences(is_speech_final: bool = False) -> None:
                    nonlocal pending_buffer
                    if not pending_buffer:
                        return

                    completed, pending_buffer = extract_sentences_and_remainder(pending_buffer, min_length=0)
                    for s in completed:
                        await flush_sentence(s, is_speech_final=is_speech_final)

                    try:
                        await websocket.send_json({
                            "type": "transcript",
                            "transcript": pending_buffer,
                            "is_final": False,
                            "speech_final": False,
                        })
                    except Exception:
                        pass

                async def delayed_flush_runner() -> None:
                    try:
                        await asyncio.sleep(BUFFER_FLUSH_DELAY_SECONDS)
                        await flush_completed_sentences(is_speech_final=False)
                        check_and_schedule_flush()
                    except asyncio.CancelledError:
                        pass
                    finally:
                        nonlocal flush_timer_task
                        flush_timer_task = None

                def check_and_schedule_flush() -> None:
                    nonlocal flush_timer_task
                    # When remainder reaches threshold AND has at least 1 completed sentence
                    if len(pending_buffer) >= BUFFER_MIN_CHARS_THRESHOLD:
                        test_completed, _ = extract_sentences_and_remainder(pending_buffer, min_length=0)
                        if len(test_completed) >= 1:
                            if flush_timer_task is None or flush_timer_task.done():
                                flush_timer_task = asyncio.create_task(delayed_flush_runner())
                            return

                    # If condition is not met, cancel timer
                    cancel_flush_timer()

                try:
                    async for raw in dg_ws:
                        try:
                            result = json.loads(raw)
                        except Exception:
                            continue

                        msg_type = result.get("type")

                        if msg_type == "UtteranceEnd":
                            cancel_flush_timer()
                            await flush_completed_sentences(is_speech_final=True)
                            continue

                        if msg_type != "Results":
                            if msg_type == "Error":
                                try:
                                    await websocket.send_json({
                                        "type": "error",
                                        "message": result.get("message", "Deepgram Error"),
                                    })
                                except Exception:
                                    pass
                            continue

                        alts = result.get("channel", {}).get("alternatives", [])
                        if not alts:
                            continue
                        transcript = alts[0].get("transcript", "")
                        if not transcript:
                            continue

                        is_final = result.get("is_final", False)
                        speech_final = result.get("speech_final", False)

                        if is_final:
                            pending_buffer = f"{pending_buffer} {transcript}".strip() if pending_buffer else transcript.strip()
                            if speech_final:
                                cancel_flush_timer()
                                await flush_completed_sentences(is_speech_final=True)
                            else:
                                check_and_schedule_flush()
                                try:
                                    await websocket.send_json({
                                        "type": "transcript",
                                        "transcript": pending_buffer,
                                        "is_final": False,
                                        "speech_final": False,
                                    })
                                except Exception:
                                    pass
                        else:
                            display = f"{pending_buffer} {transcript}".strip() if pending_buffer else transcript.strip()
                            try:
                                await websocket.send_json({
                                    "type": "transcript",
                                    "transcript": display,
                                    "is_final": False,
                                    "speech_final": False,
                                })
                            except Exception:
                                pass
                except (asyncio.CancelledError, websockets.ConnectionClosed):
                    pass
                finally:
                    cancel_flush_timer()

            current_summary = ""

            async def process_translation_buffer() -> None:
                nonlocal current_summary
                if not translate:
                    return
                try:
                    while True:
                        while not sentence_buffer:
                            buffer_event.clear()
                            await buffer_event.wait()

                        # If only 1 sentence is in the buffer and timeout is set, wait for lookahead or next sentence
                        if len(sentence_buffer) < 2 and TRANSLATION_LOOKAHEAD_TIMEOUT_SECONDS > 0:
                            buffer_event.clear()
                            if len(sentence_buffer) < 2:
                                try:
                                    await asyncio.wait_for(
                                        buffer_event.wait(),
                                        timeout=TRANSLATION_LOOKAHEAD_TIMEOUT_SECONDS,
                                    )
                                except asyncio.TimeoutError:
                                    pass

                        if not sentence_buffer:
                            continue

                        s1 = sentence_buffer[0]
                        s2_text = sentence_buffer[1]["text"] if len(sentence_buffer) > 1 else ""

                        ctx = list(context_history)
                        chat = list(live_chat_buffer[-CHAT_CONTEXT_COUNT:])

                        # Broadcast target sentence indicator to frontend
                        ts_now = datetime.now().strftime("%H:%M:%S")
                        lookahead_info = f" | Lookahead: {s2_text}" if s2_text else ""
                        print(f">> [Target Sentence] ({ts_now}): {s1['text']}{lookahead_info}", flush=True)
                        try:
                            await websocket.send_json({
                                "type": "translating",
                                "id": s1.get("id"),
                                "text": s1.get("text"),
                                "time": ts_now,
                            })
                        except Exception:
                            pass

                        if not gemini_client:
                            del sentence_buffer[0]
                            context_history.append(s1["text"])
                            if len(context_history) > CONTEXT_HISTORY_MAX:
                                del context_history[:-CONTEXT_HISTORY_MAX]
                            continue

                        trans, consumed, rel_idx, rel_trans, summary_text = await translate_japanese_stream(
                            s1["text"],
                            s2_text,
                            current_summary,
                            title,
                            display_channel_name,
                            chat,
                            vtuber_info=matched_vtuber,
                        )
                        if summary_text:
                            current_summary = summary_text

                        matched = None
                        if 1 <= rel_idx <= len(chat):
                            c = chat[rel_idx - 1]
                            matched = {
                                "id": c.get("id"),
                                "author": c.get("author", "Viewer"),
                                "message": c.get("message", ""),
                                "translation": rel_trans or c.get("message", ""),
                                "time": c.get("time", ""),
                                "index": rel_idx,
                            }

                        consumed = max(1, min(consumed, len(sentence_buffer)))
                        items = sentence_buffer[:consumed]
                        del sentence_buffer[:consumed]

                        for it in items:
                            context_history.append(it["text"])
                        if len(context_history) > CONTEXT_HISTORY_MAX:
                            del context_history[:-CONTEXT_HISTORY_MAX]

                        if trans:
                            original = " ".join([it["text"] for it in items])
                            ts = datetime.now().strftime("%H:%M:%S")
                            rel_info = f" | #{rel_idx} [{matched['author']}: {matched['message']}]" if matched else ""
                            print(f">> [Translation] ({ts}) [{consumed}s]{rel_info}: {original} → {trans}", flush=True)
                            try:
                                await websocket.send_json({
                                    "type": "translation",
                                    "id": items[-1]["id"],
                                    "ids": [it["id"] for it in items],
                                    "original": original,
                                    "original_items": items,
                                    "translation": trans,
                                    "sentences": consumed,
                                    "relevant_comment_index": rel_idx,
                                    "relevant_comment": matched,
                                    "summary": current_summary,
                                    "model": GEMINI_MODEL,
                                    "time": ts,
                                })
                            except Exception:
                                pass
                except (asyncio.CancelledError, WebSocketDisconnect):
                    pass

            async def keep_alive() -> None:
                try:
                    while True:
                        await asyncio.sleep(DEEPGRAM_KEEPALIVE_INTERVAL_SECONDS)
                        await dg_ws.send(json.dumps({"type": "KeepAlive"}))
                except (asyncio.CancelledError, websockets.ConnectionClosed):
                    pass

            tasks = [
                asyncio.create_task(forward_audio()),
                asyncio.create_task(receive_transcripts()),
                asyncio.create_task(process_translation_buffer()),
                asyncio.create_task(keep_alive()),
            ]

            done, pending = await asyncio.wait(tasks[:2], return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            tasks[2].cancel()
            tasks[3].cancel()

    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as exc:
        print(f"[Session {sid}] Error: {exc}", flush=True)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        print(f">> [Session {sid}] Disconnected\n", flush=True)


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=SERVER_HOST,
        port=SERVER_PORT,
        reload=True,
        reload_dirs=[str(Path(__file__).parent)],
        app_dir=str(Path(__file__).parent),
    )
