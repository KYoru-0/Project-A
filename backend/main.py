import os
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from dotenv import load_dotenv
from deepgram import AsyncDeepgramClient
from deepgram.core.events import EventType

load_dotenv()

app = FastAPI()
client = AsyncDeepgramClient(api_key=os.getenv("DEEPGRAM_API_KEY"))


@app.websocket("/listen")
async def listen(websocket: WebSocket):
    await websocket.accept()
    print("Extension connected")

    async with client.listen.v2.connect(
        model="nova-3",
        encoding="linear16",
        sample_rate=16000,
        channels=1,
        punctuate=True,
        interim_results=True,
        endpointing=300,
    ) as connection:

        async def on_message(message):
            if message.type != "Results":
                return
            transcript = message.channel.alternatives[0].transcript
            if not transcript:
                return
            print("Transcript:", transcript)
            if message.speech_final:
                print("Sentence complete:", transcript)
                # Gemini call goes here later

        connection.on(EventType.MESSAGE, on_message)

        listen_task = asyncio.create_task(connection.start_listening())

        try:
            while True:
                data = await websocket.receive_bytes()
                await connection.send_media(data)
        except WebSocketDisconnect:
            print("Extension disconnected")
        finally:
            listen_task.cancel()
