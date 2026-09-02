import os
import re
import time
import json
import uuid
import asyncio
import urllib.parse
from datetime import datetime
from pathlib import Path
import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from google import genai
from google.genai import types

# --- Environment & Config ---

base_dir = Path(__file__).resolve().parent
for env_path in [base_dir / ".env", base_dir.parent / ".env", Path.cwd() / ".env", Path.cwd() / "backend" / ".env"]:
    if env_path.exists():
        load_dotenv(env_path)
        break
else:
    load_dotenv()

deepgram_api_key = os.getenv("DEEPGRAM_API_KEY")
if not deepgram_api_key:
    raise ValueError("DEEPGRAM_API_KEY environment variable is not set.")

gemini_api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")

app = FastAPI(title="Project KOTOBA Backend - Live STT & Translation")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

gemini_client = genai.Client(api_key=gemini_api_key) if gemini_api_key else None
if gemini_client:
    print(f">> [Init] Translation Client Ready! Model: {GEMINI_MODEL}", flush=True)
else:
    print(">> [Init] GEMINI_API_KEY not found. Translations will be skipped.", flush=True)

# --- Translation Schema ---

class TranslationResponse(BaseModel):
    translation: str = Field(description="Natural English translation for the target Japanese speech.")
    sentences: int = Field(description="Number of Japanese sentences consumed (1 or 2).")
    relevant_comment: int = Field(default=0, description="1-based index (1-10) of the chat comment the speaker is responding to, or 0 if none.")
    relevant_comment_translation: str | None = Field(default=None, description="English translation of the relevant chat comment, or null.")

# --- Sentence Extraction ---

def extract_sentences_and_remainder(text: str) -> tuple[list[str], str]:
    """Extract complete sentences ending in Japanese/standard punctuation and return remainder."""
    if not text:
        return [], ""
    pattern = r'([^。！？!?…\n]+[。！？!?…\n]+)'
    matches = list(re.finditer(pattern, text))
    sentences = [m.group(1).strip() for m in matches if m.group(1).strip()]
    last_end = matches[-1].end() if matches else 0
    return sentences, text[last_end:].strip()


def split_sentences(text: str) -> list[str]:
    """Split transcript text into individual sentences."""
    text = text.strip()
    if not text:
        return []
    sentences, remainder = extract_sentences_and_remainder(text)
    if remainder:
        sentences.append(remainder)
    return sentences if sentences else [text]

# --- Translation ---

TRANSLATION_SYSTEM_PROMPT = """You are a real-time translator specializing in Japanese live streams, VTubers, gaming, and internet culture.
Your goal is to translate Japanese spoken stream speech into clear, natural, and expressive English subtitles.

Guidelines:
1. Preserve conversational tone, emotions, humor, colloquialisms, and stream slang.
2. The original text might be incomplete or malformed due to real-time speech recognition; translate based on natural spoken intent and phonetics.
3. You will receive:
   - "Recent Live Stream Chat": Numbered list (1 to 10) of viewer comments the speaker may be reacting or replying to.
   - "Sentence 1 (Target Japanese)": The primary sentence to translate.
   - "Sentence 2 (Lookahead Japanese)": The immediate next sentence spoken, provided as forward context.
   - "Previous Context": Up to 10 previous sentences.
4. Coherence and Sentence Count Decision:
   - If Sentence 1 is a standalone thought, translate ONLY Sentence 1 and return `sentences: 1`.
   - If Sentence 1 and Sentence 2 form a single cohesive thought that MUST be translated together, translate BOTH and return `sentences: 2`.
5. Chat Response Attribution:
   - If the speaker is responding to a specific comment, set `relevant_comment` to its 1-based index (1-10) and provide `relevant_comment_translation`.
   - If speaking independently, set `relevant_comment: 0` and `relevant_comment_translation: null`.
6. Return valid JSON with: "translation", "sentences" (1 or 2), "relevant_comment" (0-10), "relevant_comment_translation"."""


async def translate_japanese_stream(
    sentence_1: str, sentence_2: str = "", context_history: list[str] = None,
    stream_title: str = "", stream_channel: str = "", recent_chat: list[dict] = None,
) -> tuple[str, int, int, str]:
    """Translate Japanese transcript to English. Returns (translation, sentences_consumed, relevant_comment_idx, relevant_comment_translation)."""
    if not gemini_client or not sentence_1.strip():
        return "", 1, 0, ""

    prompt_parts = []
    if stream_channel or stream_title:
        meta = []
        if stream_channel: meta.append(f"Channel / Speaker: {stream_channel}")
        if stream_title: meta.append(f"Stream / Video Title: {stream_title}")
        prompt_parts.append("Media Metadata:\n" + "\n".join(meta))

    if recent_chat:
        lines = "\n".join([f"{i+1}. [{c.get('author','Viewer')}]: {c.get('message','')}" for i, c in enumerate(recent_chat[-10:]) if c.get('message')])
        if lines:
            prompt_parts.append(f"Recent Live Stream Chat (Context):\n{lines}")

    if context_history:
        ctx = "\n".join([f"{i+1}. {c}" for i, c in enumerate(context_history[-10:])])
        prompt_parts.append(f"Previous Context:\n{ctx}")

    prompt_parts.append(f"Sentence 1 (Target Japanese):\n{sentence_1}")
    if sentence_2:
        prompt_parts.append(f"Sentence 2 (Lookahead Japanese):\n{sentence_2}")

    try:
        response = await gemini_client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents="\n\n".join(prompt_parts),
            config=types.GenerateContentConfig(
                system_instruction=TRANSLATION_SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=TranslationResponse,
                temperature=0.3, max_output_tokens=300,
            ),
        )
        if response and response.text:
            data = json.loads(response.text)
            trans = str(data.get("translation", "")).strip()
            count = int(data.get("sentences", 1))
            if count not in (1, 2): count = 1
            if not sentence_2: count = 1
            rel = data.get("relevant_comment", 0)
            rel_trans = str(data.get("relevant_comment_translation") or "").strip()
            rel_idx = rel if isinstance(rel, int) and 1 <= rel <= 10 else 0
            return trans, count, rel_idx, rel_trans
    except Exception as e:
        print(f"[Translation Error]: {e}", flush=True)
    return "", 1, 0, ""

# --- API ---

@app.get("/")
async def health_check():
    return {
        "status": "online", "service": "Project KOTOBA",
        "ws_url": "ws://127.0.0.1:8000/listen",
        "deepgram_ready": bool(deepgram_api_key), "gemini_ready": bool(gemini_client),
        "translation_model": GEMINI_MODEL if gemini_client else "none",
    }


@app.websocket("/listen")
async def listen(websocket: WebSocket, language: str = "ja", model: str = "nova-3", title: str = "", channel: str = ""):
    await websocket.accept()

    sid = uuid.uuid4().hex[:8]
    context_history: list[str] = []
    sentence_buffer: list[dict] = []
    live_chat_buffer: list[dict] = []
    pending_buffer: str = ""
    buffer_event = asyncio.Event()

    print(f"\n==========================================", flush=True)
    print(f">> [Session {sid}] Connected | Channel: '{channel}' | Title: '{title}'", flush=True)
    print(f">> STT: nova-3/ja | Translator: {GEMINI_MODEL if gemini_client else 'None'}", flush=True)
    print(f"==========================================", flush=True)

    try:
        await websocket.send_json({
            "type": "status", "status": "connected", "model": "nova-3", "language": "ja",
            "translation_ready": bool(gemini_client), "translation_model": GEMINI_MODEL if gemini_client else None,
        })
    except Exception:
        pass

    dg_params = {
        "model": "nova-3", "language": "ja", "punctuate": "true", "interim_results": "true",
        "smart_format": "true", "encoding": "linear16", "sample_rate": "16000",
        "channels": "1", "endpointing": "300", "vad_events": "true",
    }
    dg_url = f"wss://api.deepgram.com/v1/listen?{urllib.parse.urlencode(dg_params)}"

    try:
        async with websockets.connect(dg_url, additional_headers={"Authorization": f"Token {deepgram_api_key}"}, open_timeout=10) as dg_ws:
            print(f">> [Session {sid}] Deepgram connected. Streaming audio...", flush=True)

            async def forward_audio():
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
                                        item["id"] = f"chat_{int(time.time()*1000)}_{uuid.uuid4().hex[:4]}"
                                    live_chat_buffer.append(item)
                                    if len(live_chat_buffer) > 40: del live_chat_buffer[:-40]
                                elif payload.get("type") == "chat_batch" and "messages" in payload:
                                    for item in payload["messages"]:
                                        if not item.get("id"):
                                            item["id"] = f"chat_{int(time.time()*1000)}_{uuid.uuid4().hex[:4]}"
                                        live_chat_buffer.append(item)
                                    if len(live_chat_buffer) > 40: del live_chat_buffer[:-40]
                            except Exception:
                                pass
                except (WebSocketDisconnect, asyncio.CancelledError):
                    pass

            async def receive_transcripts():
                nonlocal pending_buffer
                try:
                    async for raw in dg_ws:
                        try:
                            result = json.loads(raw)
                        except Exception:
                            continue

                        if result.get("type") != "Results":
                            if result.get("type") == "Error":
                                try: await websocket.send_json({"type": "error", "message": result.get("message", "Deepgram Error")})
                                except Exception: pass
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
                            ts = datetime.now().strftime("%H:%M:%S")
                            pending_buffer = f"{pending_buffer} {transcript}".strip() if pending_buffer else transcript.strip()
                            completed, pending_buffer = extract_sentences_and_remainder(pending_buffer)

                            for s in completed:
                                s_id = f"{int(time.time()*1000)}_{uuid.uuid4().hex[:4]}"
                                print(f">> [Sentence] ({ts}): {s}", flush=True)
                                try:
                                    await websocket.send_json({"type": "transcript", "id": s_id, "transcript": s, "is_final": True, "speech_final": speech_final, "time": ts})
                                except Exception:
                                    pass
                                sentence_buffer.append({"id": s_id, "text": s, "time": ts})

                            if len(sentence_buffer) >= 2:
                                buffer_event.set()

                            if pending_buffer:
                                try:
                                    await websocket.send_json({"type": "transcript", "transcript": pending_buffer, "is_final": False, "speech_final": False})
                                except Exception:
                                    pass
                        else:
                            display = f"{pending_buffer} {transcript}".strip() if pending_buffer else transcript.strip()
                            try:
                                await websocket.send_json({"type": "transcript", "transcript": display, "is_final": False, "speech_final": False})
                            except Exception:
                                pass
                except (asyncio.CancelledError, websockets.ConnectionClosed):
                    pass

            async def process_translation_buffer():
                try:
                    while True:
                        while len(sentence_buffer) < 2:
                            buffer_event.clear()
                            await buffer_event.wait()

                        while len(sentence_buffer) >= 2:
                            s1, s2 = sentence_buffer[0], sentence_buffer[1]
                            ctx = list(context_history[-10:])
                            chat = list(live_chat_buffer[-10:])

                            if not gemini_client:
                                del sentence_buffer[0]
                                context_history.append(s1["text"])
                                if len(context_history) > 50: del context_history[:-50]
                                continue

                            trans, consumed, rel_idx, rel_trans = await translate_japanese_stream(
                                s1["text"], s2["text"], ctx, title, channel, chat
                            )

                            matched = None
                            if rel_idx > 0 and rel_idx <= len(chat):
                                c = chat[rel_idx - 1]
                                matched = {
                                    "id": c.get("id"), "author": c.get("author", "Viewer"),
                                    "message": c.get("message", ""),
                                    "translation": rel_trans or c.get("message", ""),
                                    "time": c.get("time", ""), "index": rel_idx,
                                }

                            consumed = max(1, min(consumed, len(sentence_buffer)))
                            items = sentence_buffer[:consumed]
                            del sentence_buffer[:consumed]

                            for it in items:
                                context_history.append(it["text"])
                            if len(context_history) > 50: del context_history[:-50]

                            if trans:
                                original = " ".join([it["text"] for it in items])
                                ts = datetime.now().strftime("%H:%M:%S")
                                rel_info = f" | #{rel_idx} [{matched['author']}: {matched['message']}]" if matched else ""
                                print(f">> [Translation] ({ts}) [{consumed}s]{rel_info}: {original} → {trans}", flush=True)
                                try:
                                    await websocket.send_json({
                                        "type": "translation", "id": items[-1]["id"],
                                        "ids": [it["id"] for it in items],
                                        "original": original, "original_items": items,
                                        "translation": trans, "sentences": consumed,
                                        "relevant_comment_index": rel_idx, "relevant_comment": matched,
                                        "model": GEMINI_MODEL, "time": ts,
                                    })
                                except Exception:
                                    pass
                except (asyncio.CancelledError, WebSocketDisconnect):
                    pass

            async def keep_alive():
                try:
                    while True:
                        await asyncio.sleep(5)
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
            for t in pending: t.cancel()
            tasks[2].cancel()
            tasks[3].cancel()

    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as exc:
        print(f"[Session {sid}] Error: {exc}", flush=True)
        try: await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception: pass
    finally:
        print(f">> [Session {sid}] Disconnected\n", flush=True)


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True,
                reload_dirs=[str(Path(__file__).parent)], app_dir=str(Path(__file__).parent))
