const button = document.getElementById('toggle-btn');

button.addEventListener('click', async (event) => {
    event.preventDefault();

    if (button.dataset.state === 'off') {
        try {
            const mediaStreamId = await chrome.tabCapture.getMediaStreamId();

            const existingContexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT']
            });

            if (existingContexts.length === 0) {
                await chrome.offscreen.createDocument({
                    url: 'offscreen.html',
                    reasons: ['USER_MEDIA'],
                    justification: 'Capture and process tab audio'
                });
            }

            chrome.runtime.sendMessage({
                type: 'start-capture',
                streamId: mediaStreamId
            });

            button.classList.remove('bg-green');
            button.classList.add('bg-red');
            button.dataset.state = 'on';
            button.textContent = 'Stop';
        } catch (e) {
            console.error('Error starting capture:', e);
        }
    } else {
        chrome.runtime.sendMessage({
            type: 'stop-capture'
        });

        button.classList.remove('bg-red');
        button.classList.add('bg-green');
        button.dataset.state = 'off';
        button.textContent = 'Start';
    }
});