// Project KOTOBA - Offscreen Audio Pipeline (Manifest V3)
// Captures tab audio via MediaStream, plays through <audio> for speaker pass-through,
// and streams 16kHz Linear16 PCM to the backend WebSocket via ScriptProcessor.

// --- State ---

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let muteGain = null;
let socket = null;
let currentTargetTabId = null;
let isRecording = false;
let speakerAudioEl = null;

// --- PCM Downsampler ---

function downsampleAndConvertToPCM(inputData, inputSampleRate, outputSampleRate = 16000) {
    if (!inputData || inputData.length === 0) return null;

    if (inputSampleRate === outputSampleRate) {
        const pcm = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            let s = Math.max(-1, Math.min(1, inputData[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm;
    }

    const ratio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(inputData.length / ratio);
    const result = new Int16Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
        const nextOffset = Math.round((offsetResult + 1) * ratio);
        let accum = 0, count = 0;
        for (let i = offsetBuffer; i < nextOffset && i < inputData.length; i++) {
            accum += inputData[i];
            count++;
        }
        const avg = count > 0 ? accum / count : 0;
        const clamped = Math.max(-1, Math.min(1, avg));
        result[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
        offsetResult++;
        offsetBuffer = nextOffset;
    }
    return result;
}

// --- Notify Extension Contexts ---

function notify(msg) {
    if (currentTargetTabId && typeof msg === 'object' && msg !== null && !msg.targetTabId) {
        msg.targetTabId = currentTargetTabId;
    }
    chrome.runtime.sendMessage(msg).catch(() => {});
}

// --- Recording ---

async function startRecording(data) {
    if (isRecording) stopRecording();
    isRecording = true;
    currentTargetTabId = data.targetTabId;

    try {
        // Obtain MediaStream from tabCapture
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: data.streamId } },
                video: false
            });
        } catch (e) {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: data.streamId } },
                video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: data.streamId } }
            });
            stream.getVideoTracks().forEach(t => t.stop());
        }

        mediaStream = stream;
        mediaStream.getVideoTracks().forEach(t => {
            try { t.stop(); } catch (e) {}
            try { mediaStream.removeTrack(t); } catch (e) {}
        });

        // Speaker pass-through via <audio> element (Web Audio destination is silent in offscreen docs)
        speakerAudioEl = document.getElementById('speaker-passthrough');
        if (!speakerAudioEl) {
            speakerAudioEl = document.createElement('audio');
            speakerAudioEl.autoplay = true;
            document.body.appendChild(speakerAudioEl);
        }
        speakerAudioEl.srcObject = mediaStream;
        speakerAudioEl.volume = 1.0;
        speakerAudioEl.muted = false;

        try {
            await speakerAudioEl.play();
        } catch (playErr) {
            setTimeout(async () => {
                try { await speakerAudioEl.play(); } catch (e) {}
            }, 200);
        }

        // Web Audio for PCM processing only (not speaker output)
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') await audioContext.resume();
        sourceNode = audioContext.createMediaStreamSource(mediaStream);

        // Connect to backend WebSocket
        const wsUrl = `ws://127.0.0.1:8000/listen?language=ja&model=nova-3&title=${encodeURIComponent(data.title || '')}&channel=${encodeURIComponent(data.channel || '')}`;
        socket = new WebSocket(wsUrl);
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
            notify({ type: 'capture_status', status: 'started' });

            try {
                processorNode = audioContext.createScriptProcessor(4096, 1, 1);
                processorNode.onaudioprocess = (event) => {
                    if (!isRecording || !socket || socket.readyState !== WebSocket.OPEN) return;
                    try {
                        const input = event.inputBuffer.getChannelData(0);
                        const pcm16 = downsampleAndConvertToPCM(input, audioContext.sampleRate, 16000);
                        if (pcm16 && pcm16.length > 0 && socket.readyState === WebSocket.OPEN) {
                            socket.send(pcm16.buffer);
                        }
                    } catch (e) {}
                };

                // source → processor → muted gain → destination
                // Muted gain ensures ScriptProcessor fires callbacks without doubling audio
                sourceNode.connect(processorNode);
                muteGain = audioContext.createGain();
                muteGain.gain.value = 0.0;
                processorNode.connect(muteGain);
                muteGain.connect(audioContext.destination);
            } catch (setupErr) {
                notify({ type: 'error', message: 'Audio processor error: ' + setupErr.message });
            }
        };

        socket.onmessage = (event) => {
            try { notify(JSON.parse(event.data)); } catch (e) {}
        };

        socket.onerror = () => {
            notify({ type: 'error', message: 'Backend WebSocket connection failed' });
            stopRecording();
        };

        socket.onclose = () => {
            notify({ type: 'capture_status', status: 'stopped' });
            stopRecording();
        };

    } catch (err) {
        notify({ type: 'error', message: err.message });
        stopRecording();
    }
}

function stopRecording() {
    isRecording = false;

    if (processorNode) {
        try { processorNode.disconnect(); processorNode.onaudioprocess = null; } catch (e) {}
        processorNode = null;
    }
    if (muteGain) {
        try { muteGain.disconnect(); } catch (e) {}
        muteGain = null;
    }
    if (sourceNode) {
        try { sourceNode.disconnect(); } catch (e) {}
        sourceNode = null;
    }
    if (audioContext) {
        try { audioContext.close(); } catch (e) {}
        audioContext = null;
    }
    if (speakerAudioEl) {
        try { speakerAudioEl.pause(); speakerAudioEl.srcObject = null; } catch (e) {}
        speakerAudioEl = null;
    }
    if (mediaStream) {
        try { mediaStream.getTracks().forEach(t => t.stop()); } catch (e) {}
        mediaStream = null;
    }
    if (socket) {
        try { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(); } catch (e) {}
        socket = null;
    }

    notify({ type: 'capture_status', status: 'stopped' });
}

// --- Message Listener ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return;

    if (message.action === 'start') {
        startRecording(message.data);
        sendResponse({ success: true });
    } else if (message.action === 'stop') {
        stopRecording();
        sendResponse({ success: true });
    } else if (message.action === 'chatMessage') {
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                if (message.batch && Array.isArray(message.batch)) {
                    socket.send(JSON.stringify({ type: 'chat_batch', messages: message.batch }));
                } else if (message.data) {
                    socket.send(JSON.stringify({ type: 'chat', data: message.data }));
                }
            } catch (e) {}
        }
    }
});
