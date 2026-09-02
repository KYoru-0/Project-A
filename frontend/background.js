/**
 * Project KOTOBA - Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 * - Coordinates tabCapture authorization and audio stream IDs.
 * - Spawns and manages the offscreen audio pipeline document.
 * - Relays transcripts, translations, and live chat events between content scripts,
 *   extension output windows, and the offscreen pipeline.
 * - Tracks tab navigation and lifecycle events to clean up active audio sessions.
 */

// =============================================================================
// State & Tracking
// =============================================================================

let activeCapturingTabId = null;
let activeCapturingVideoId = null;
const authorizedTabs = new Set();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Ensures an offscreen document is active for capturing tab media and Web Audio processing.
 */
async function ensureOffscreenDocument() {
    try {
        if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
            if (await chrome.offscreen.hasDocument()) return;
        }
    } catch (e) {}

    try {
        const existing = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [chrome.runtime.getURL('offscreen.html')]
        });
        if (existing && existing.length > 0) return;
    } catch (e) {}

    try {
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
            justification: 'Capture tab audio, pass-through to speakers, and stream to STT'
        });
    } catch (err) {
        if (!err.message?.includes('already exists') && !err.message?.includes('Only a single offscreen')) {
            console.warn('[KOTOBA BG] Offscreen creation notice:', err);
        }
    }
}

/**
 * Extracts YouTube video ID from a given URL string across various formats.
 */
function getVideoIdFromUrl(urlStr) {
    if (!urlStr) return null;
    try {
        const parsed = new URL(urlStr);
        if (parsed.searchParams.has('v')) return parsed.searchParams.get('v');
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (['live', 'shorts', 'embed', 'v'].includes(parts[0])) return parts[1] || null;
        if (parsed.hostname === 'youtu.be') return parts[0] || null;
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * Checks whether a URL corresponds to an active watch/stream page.
 */
function isWatchUrl(urlStr) {
    if (!urlStr) return false;
    try {
        const p = new URL(urlStr);
        return p.pathname === '/watch' ||
               p.pathname.startsWith('/live') ||
               p.pathname.startsWith('/shorts') ||
               p.searchParams.has('v');
    } catch (e) {
        return false;
    }
}

// =============================================================================
// Message Dispatcher & Routing
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 1. Forward transcripts/translations/status from offscreen to content script + extension pages
    if (message.type && ['transcript', 'translation', 'capture_status', 'error', 'status'].includes(message.type)) {
        if (message._relayed) return;
        const isFromOffscreen = sender.url && sender.url.includes('offscreen.html');
        const isFromExtPage = sender.url && sender.url.includes('chrome-extension://') && !sender.tab;

        if (isFromOffscreen || isFromExtPage) {
            const tabId = message.targetTabId || activeCapturingTabId;
            if (tabId) {
                chrome.tabs.sendMessage(tabId, message).catch(() => {});
            }
            chrome.runtime.sendMessage({ ...message, _relayed: true }).catch(() => {});
        }
        return;
    }

    // 2. Forward live chat from content script to offscreen + back to content tab
    if (message.action === 'liveChatCollected') {
        const tabId = sender.tab ? sender.tab.id : activeCapturingTabId;
        chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'chatMessage',
            data: message.data,
            batch: message.batch
        }).catch(() => {});

        if (tabId) {
            chrome.tabs.sendMessage(tabId, {
                type: 'live_chat_event',
                data: message.data,
                batch: message.batch
            }).catch(() => {});
        }
        return;
    }

    // 3. Start tab audio capture
    if (message.action === 'startTabCapture') {
        (async () => {
            try {
                const tabId = sender.tab ? sender.tab.id : message.tabId;
                if (!tabId) {
                    sendResponse({ success: false, error: 'No target tab found' });
                    return;
                }

                activeCapturingTabId = tabId;
                activeCapturingVideoId = message.videoId || getVideoIdFromUrl(sender.tab?.url || sender.url || '');
                await ensureOffscreenDocument();

                chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
                    if (chrome.runtime.lastError || !streamId) {
                        let err = chrome.runtime.lastError?.message || 'Failed to get tab media stream ID';
                        if (err.includes('Extension has not been invoked') || err.includes('activeTab')) {
                            err = 'Click the 💬 KOTOBA toolbar icon (or press Alt+K) once to authorize tab audio';
                        }
                        sendResponse({ success: false, error: err });
                        return;
                    }

                    chrome.runtime.sendMessage({
                        target: 'offscreen',
                        action: 'start',
                        data: {
                            streamId,
                            targetTabId: tabId,
                            lang: message.lang || 'ja',
                            model: message.model || 'nova-3',
                            title: message.title || '',
                            channel: message.channel || '',
                            channelLink: message.channelLink || ''
                        }
                    }, () => {
                        sendResponse({ success: true, streamId });
                    });
                });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // 4. Stop tab audio capture
    if (message.action === 'stopTabCapture') {
        activeCapturingTabId = null;
        activeCapturingVideoId = null;
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' }, () => {
            sendResponse({ success: true });
        });
        return true;
    }

    // 5. Check if tab is authorized for capture
    if (message.action === 'checkTabReadiness') {
        const tabId = sender.tab ? sender.tab.id : null;
        if (!tabId) {
            sendResponse({ ready: false, authorized: false });
            return true;
        }
        if (authorizedTabs.has(tabId)) {
            sendResponse({ ready: true, authorized: true });
            return true;
        }

        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
            if (chrome.runtime.lastError || !streamId) {
                sendResponse({ ready: false, authorized: false });
            } else {
                authorizedTabs.add(tabId);
                sendResponse({ ready: true, authorized: true, streamId });
            }
        });
        return true;
    }

    // 6. Get tab audio stream ID
    if (message.action === 'getTabAudioStreamId') {
        const tabId = sender.tab ? sender.tab.id : null;
        if (!tabId) {
            sendResponse({ success: false, error: 'No sender tab ID found' });
            return true;
        }

        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
            if (chrome.runtime.lastError) {
                let err = chrome.runtime.lastError.message;
                if (err.includes('Extension has not been invoked') || err.includes('activeTab')) {
                    err = 'Click the 💬 KOTOBA toolbar icon (or press Alt+K) once to authorize tab audio';
                }
                sendResponse({ success: false, error: err });
            } else {
                authorizedTabs.add(tabId);
                sendResponse({ success: true, streamId });
            }
        });
        return true;
    }
});

// =============================================================================
// Tab Lifecycle & Navigation Events
// =============================================================================

chrome.action.onClicked.addListener(async (tab) => {
    if (tab && tab.id) {
        authorizedTabs.add(tab.id);
        try {
            await chrome.tabs.sendMessage(tab.id, { action: 'toggleOverlay', authorized: true });
        } catch (e) {}
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    authorizedTabs.delete(tabId);
    if (tabId === activeCapturingTabId) {
        activeCapturingTabId = null;
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' }).catch(() => {});
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId !== activeCapturingTabId) return;
    const url = changeInfo.url || tab.url;
    if (!url) return;

    const newVid = getVideoIdFromUrl(url);
    const isWatch = isWatchUrl(url);

    if (!isWatch || (newVid && activeCapturingVideoId && newVid !== activeCapturingVideoId)) {
        activeCapturingTabId = null;
        activeCapturingVideoId = null;
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' }).catch(() => {});
        chrome.tabs.sendMessage(tabId, { type: 'capture_status', status: 'stopped' }).catch(() => {});
    } else if (newVid && !activeCapturingVideoId) {
        activeCapturingVideoId = newVid;
    }
});

// =============================================================================
// Global Commands & Shortcuts
// =============================================================================

chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'toggle-kotoba') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            authorizedTabs.add(tab.id);
            try {
                await chrome.tabs.sendMessage(tab.id, { action: 'toggleOverlay', authorized: true });
            } catch (e) {}
        }
    }
});
