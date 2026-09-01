let audioContext;
let mediaStream;
let sourceNode;
let pitchNode;
let socket;

chrome.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'start-capture') {
        console.log('Got stream ID:', message.streamId);

        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: 'tab',
                        chromeMediaSourceId: message.streamId
                    }
                }
            });

            audioContext = new AudioContext();
            sourceNode = audioContext.createMediaStreamSource(mediaStream);

            pitchNode = audioContext.createGain();
            pitchNode.gain.value = 5.0;

            sourceNode.connect(pitchNode);
            pitchNode.connect(audioContext.destination);

            socket = new WebSocket('ws://127.0.0.1:8000/listen');

            socket.onopen = () => {
                console.log('Connected to server');
            };

            socket.onmessage = (event) => {
                console.log('Server says:', event.data);
            };

            socket.onerror = (err) => {
                console.error('Socket error:', err);
            };

            socket.onclose = () => {
                console.log('Server connection closed');
            };

            console.log('Audio graph running');
        } catch (e) {
            console.error('Error accessing media stream:', e);
        }
    }

    if (message.type === 'stop-capture') {
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
        }
        if (audioContext) {
            audioContext.close();
        }
        if (socket) {
            socket.close();
        }

        mediaStream = null;
        audioContext = null;

        console.log('Stop requested');
    }
});