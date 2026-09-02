// Project KOTOBA - Output Page (Popup/Tab UI)

// --- Elements ---

const toggleBtn = document.getElementById('toggle-btn');
const btnIcon = document.getElementById('btn-icon');
const btnLabel = document.getElementById('btn-label');
const forceCloseBtn = document.getElementById('force-close-btn');
const clearBtn = document.getElementById('clear-btn');
const copyTranscriptsBtn = document.getElementById('copy-transcripts-btn');
const copyTranslationBtn = document.getElementById('copy-translation-btn');

const ytInfoPlaceholder = document.getElementById('yt-info-placeholder');
const ytInfoContent = document.getElementById('yt-info-content');
const ytBadgeStatus = document.getElementById('yt-badge-status');
const ytChannelName = document.getElementById('yt-channel-name');
const ytVideoTitle = document.getElementById('yt-video-title');

const transcriptsList = document.getElementById('transcript-list');
const translationList = document.getElementById('translation-list');
const transcriptsScroll = document.getElementById('transcripts-scroll');
const translationScroll = document.getElementById('translation-scroll');
const transcriptsEmptyState = document.getElementById('transcripts-empty-state');
const translationEmptyState = document.getElementById('translation-empty-state');
const transcriptsCountBadge = document.getElementById('transcripts-count-badge');
const translationCountBadge = document.getElementById('translation-count-badge');

const liveBubble = document.getElementById('live-bubble');
const liveText = document.getElementById('live-text');
const statusPill = document.getElementById('status-pill');
const statusText = document.getElementById('status-text');
const charCount = document.getElementById('char-count');
const toast = document.getElementById('toast');
const footerServer = document.querySelector('.footer-server');

// --- State ---

let currentTargetTabId = null;
let transcriptItems = [];
let translationItems = [];
let errorItems = [];
let isBusy = false;
let isCapturing = false;

// --- Helpers ---

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

function scrollTranscriptsToBottom() {
    if (transcriptsScroll) transcriptsScroll.scrollTop = transcriptsScroll.scrollHeight;
}

function scrollTranslationToBottom() {
    if (translationScroll) translationScroll.scrollTop = translationScroll.scrollHeight;
}

function updateStats() {
    if (transcriptsCountBadge) transcriptsCountBadge.textContent = `${transcriptItems.length} lines`;
    if (translationCountBadge) translationCountBadge.textContent = `${translationItems.length} lines`;
    if (charCount) charCount.textContent = `${transcriptItems.length} transcripts | ${translationItems.length} translations`;
}

function cleanChannelName(raw) {
    if (!raw) return '';
    let s = raw.split(/[\r\n]+/).map(t => t.trim()).filter(Boolean)[0] || '';
    s = s.trim();
    s = s.replace(/\s*•\s*[\d.]+[KMB]?\s*subscribers.*$/i, '').trim();
    if (s.length >= 4 && s.length % 2 === 0) {
        const half = s.length / 2;
        if (s.slice(0, half) === s.slice(half)) {
            s = s.slice(0, half).trim();
        }
    }
    const words = s.split(/\s+/);
    if (words.length >= 2 && words.length % 2 === 0) {
        const halfWords = words.length / 2;
        const firstHalf = words.slice(0, halfWords).join(' ');
        const secondHalf = words.slice(halfWords).join(' ');
        if (firstHalf === secondHalf) {
            s = firstHalf;
        }
    }
    return s;
}

function inPageMetadataExtractor() {
    try {
        const href = window.location.href || '';
        const host = window.location.hostname || '';
        const isYT = host.includes('youtube.com');

        if (!isYT) {
            return { isYouTube: false, title: document.title || 'Webpage', channel: host.replace(/^www\./, '') || 'Web', status: 'PLAYBACK', url: href };
        }

        let title = '';
        const titleEl = document.querySelector(
            'h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string, ' +
            'ytd-video-primary-info-renderer #title h1, h1.ytd-video-primary-info-renderer, ' +
            'h1.title, #title h1, h1.ytd-watch-metadata'
        );
        if (titleEl && titleEl.textContent && titleEl.textContent.trim()) {
            title = titleEl.textContent.trim();
        } else {
            const metaTitle = document.querySelector('meta[name="title"], meta[property="og:title"]');
            if (metaTitle && (metaTitle.content || metaTitle.getAttribute('content'))) {
                title = metaTitle.content || metaTitle.getAttribute('content');
            } else {
                title = document.title.replace(/\s*-\s*YouTube$/, '').trim();
            }
        }

        let channel = '';
        const channelEl = document.querySelector(
            'ytd-video-owner-renderer ytd-channel-name yt-formatted-string#text a, ' +
            'ytd-video-owner-renderer ytd-channel-name yt-formatted-string a, ' +
            '#owner ytd-channel-name #text a, ' +
            '#owner #channel-name #text a, ' +
            'ytd-channel-name yt-formatted-string#text a, ' +
            '#owner #channel-name a, ' +
            'ytd-channel-name yt-formatted-string a, ' +
            '#upload-info #channel-name a, ' +
            '#owner-name a, ' +
            'ytd-video-owner-renderer #channel-name a, ' +
            '#text.ytd-channel-name a, ' +
            'ytd-channel-name a, ' +
            '#channel-name'
        );
        if (channelEl && channelEl.textContent && channelEl.textContent.trim()) {
            const raw = channelEl.textContent.trim();
            let s = raw.split(/[\r\n]+/).map(t => t.trim()).filter(Boolean)[0] || '';
            s = s.trim().replace(/\s*•\s*[\d.]+[KMB]?\s*subscribers.*$/i, '').trim();
            if (s.length >= 4 && s.length % 2 === 0 && s.slice(0, s.length / 2) === s.slice(s.length / 2)) {
                s = s.slice(0, s.length / 2).trim();
            }
            const words = s.split(/\s+/);
            if (words.length >= 2 && words.length % 2 === 0 && words.slice(0, words.length / 2).join(' ') === words.slice(words.length / 2).join(' ')) {
                s = words.slice(0, words.length / 2).join(' ');
            }
            channel = s;
        }
        if (!channel) {
            const metaAuthor = document.querySelector('link[itemprop="name"]');
            if (metaAuthor && metaAuthor.getAttribute('content')) {
                channel = metaAuthor.getAttribute('content').trim();
            } else {
                const metaName = document.querySelector('meta[name="author"], meta[property="og:video:actor"]');
                if (metaName && (metaName.content || metaName.getAttribute('content'))) {
                    channel = (metaName.content || metaName.getAttribute('content')).trim();
                }
            }
        }

        const infoEl = document.querySelector('ytd-watch-info-text, #info.ytd-watch-info-text, #info-text, ytd-watch-metadata #info, #info');
        const infoText = (infoEl ? infoEl.innerText : '') + ' ' + (document.querySelector('ytd-watch-metadata')?.innerText || '');
        const hasWatchingNow = /watching now|人が視聴中|Started streaming|配信中|ライブ配信中/i.test(infoText);
        const isLiveMeta = document.querySelector('meta[itemprop="isLiveBroadcast"]')?.getAttribute('content') === 'True' ||
                           document.querySelector('meta[itemprop="isLiveBroadcast"]')?.content === 'True';
        const hasEndDate = document.querySelector('meta[itemprop="endDate"]') !== null;
        const hasStreamedPast = /Streamed live|配信済み|Premiered/i.test(infoText);
        const isLive = hasWatchingNow || (isLiveMeta && !hasEndDate && !hasStreamedPast);

        return {
            isYouTube: true,
            status: isLive ? 'LIVE' : 'PLAYBACK',
            title: title || document.title.replace(/\s*-\s*YouTube$/, '').trim() || 'YouTube Stream',
            channel: channel || 'YouTube Channel',
            url: href
        };
    } catch (e) {
        return { isYouTube: true, status: 'PLAYBACK', title: document.title.replace(/\s*-\s*YouTube$/, '').trim() || 'YouTube Video', channel: 'YouTube Channel', url: window.location.href };
    }
}

async function updateSelectedTabInfo(tabId) {
    if (!tabId || isNaN(tabId)) {
        if (ytInfoPlaceholder) ytInfoPlaceholder.style.display = 'flex';
        if (ytInfoContent) ytInfoContent.style.display = 'none';
        return;
    }

    try {
        let meta = null;

        try {
            const results = await chrome.scripting.executeScript({ target: { tabId: Number(tabId) }, func: inPageMetadataExtractor });
            if (results && results[0] && results[0].result) meta = results[0].result;
        } catch (e) {}

        if (!meta) {
            try {
                const tab = await chrome.tabs.get(Number(tabId));
                if (tab) {
                    const isYT = tab.url ? tab.url.includes('youtube.com') : (tab.title ? tab.title.includes('YouTube') : false);
                    meta = {
                        isYouTube: isYT, status: 'PLAYBACK',
                        title: (tab.title || '').replace(/\s*-\s*YouTube$/, '').trim() || 'Media Playback',
                        channel: isYT ? 'YouTube' : (tab.url ? new URL(tab.url).hostname.replace(/^www\./, '') : 'Webpage')
                    };
                }
            } catch (e) {}
        }

        if (!meta) {
            if (ytInfoPlaceholder) ytInfoPlaceholder.style.display = 'flex';
            if (ytInfoContent) ytInfoContent.style.display = 'none';
            return;
        }

        if (ytInfoPlaceholder) ytInfoPlaceholder.style.display = 'none';
        if (ytInfoContent) ytInfoContent.style.display = 'flex';

        if (meta.status === 'LIVE') {
            ytBadgeStatus.className = 'yt-badge-status live';
            ytBadgeStatus.textContent = 'LIVE';
        } else {
            ytBadgeStatus.className = 'yt-badge-status playback';
            ytBadgeStatus.textContent = 'PLAYBACK';
        }
        ytChannelName.textContent = meta.channel || 'Media Channel';
        ytVideoTitle.textContent = meta.title || 'Media Stream';
    } catch (err) {
        if (ytInfoPlaceholder) ytInfoPlaceholder.style.display = 'flex';
        if (ytInfoContent) ytInfoContent.style.display = 'none';
    }
}

async function resolveInitialTargetTab() {
    const urlParams = new URLSearchParams(window.location.search);
    const tabIdParam = urlParams.get('tabId');

    if (tabIdParam && !isNaN(parseInt(tabIdParam))) {
        currentTargetTabId = parseInt(tabIdParam);
    } else {
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (activeTab && activeTab.id && !activeTab.url?.startsWith('chrome-extension://')) {
                currentTargetTabId = activeTab.id;
            } else {
                const tabs = await chrome.tabs.query({ active: true });
                const nonExt = tabs.find(t => t.url && !t.url.startsWith('chrome-extension://'));
                if (nonExt) currentTargetTabId = nonExt.id;
            }
        } catch (e) {}
    }

    if (currentTargetTabId) await updateSelectedTabInfo(currentTargetTabId);
}

// --- UI State ---

function updateCaptureUI(active) {
    if (active) {
        toggleBtn.dataset.state = 'on';
        toggleBtn.className = 'btn btn-danger';
        btnIcon.textContent = '■';
        btnLabel.textContent = 'Stop Capture';
    } else {
        toggleBtn.dataset.state = 'off';
        toggleBtn.className = 'btn btn-primary';
        btnIcon.textContent = '▶';
        btnLabel.textContent = 'Start Capture';
    }
}

function updateStatusUI(status) {
    statusPill.className = 'status-pill';
    if (status === 'connected') { statusPill.classList.add('active'); statusText.textContent = 'Live'; }
    else if (status === 'connecting') { statusPill.classList.add('connecting'); statusText.textContent = 'Connecting'; }
    else if (status === 'error') { statusPill.classList.add('error'); statusText.textContent = 'Error'; }
    else { statusText.textContent = 'Idle'; }
}

// --- Rendering ---

function appendLiveTranscriptCard(item, shouldScroll = true) {
    transcriptsEmptyState.style.display = 'none';
    const line = document.createElement('div');
    line.className = 'transcript-line';
    if (item.id) line.dataset.id = item.id;

    const textSpan = document.createElement('span');
    textSpan.className = 'line-text';
    textSpan.textContent = item.text;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'line-time';
    timeSpan.textContent = item.time || new Date().toLocaleTimeString();

    line.appendChild(textSpan);
    line.appendChild(timeSpan);
    transcriptsList.appendChild(line);
    if (shouldScroll) scrollTranscriptsToBottom();
}

function appendTranslationBatchCard(item, shouldScroll = true) {
    translationEmptyState.style.display = 'none';
    const line = document.createElement('div');
    line.className = 'translation-line';
    if (item.id) line.dataset.id = item.id;
    const targetIds = item.ids || (item.id ? [item.id] : []);
    if (targetIds.length > 0) line.dataset.targetIds = targetIds.join(',');

    const mainRow = document.createElement('div');
    mainRow.className = 'trans-main-row';

    const transText = document.createElement('span');
    transText.className = 'trans-text';
    transText.textContent = item.translation;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'line-time';
    timeSpan.textContent = item.time || new Date().toLocaleTimeString();

    mainRow.appendChild(transText);
    mainRow.appendChild(timeSpan);
    line.appendChild(mainRow);

    // Latest-active highlight
    document.querySelectorAll('.latest-active').forEach(el => el.classList.remove('latest-active'));
    line.classList.add('latest-active');
    targetIds.forEach(tId => {
        transcriptsList.querySelectorAll(`.transcript-line[data-id="${tId}"]`).forEach(el => el.classList.add('latest-active'));
    });

    // Hover cross-highlight
    line.addEventListener('mouseenter', () => {
        line.classList.add('highlight-match');
        targetIds.forEach(tId => {
            transcriptsList.querySelectorAll(`.transcript-line[data-id="${tId}"]`).forEach(el => {
                el.classList.add('highlight-match');
                el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        });
    });
    line.addEventListener('mouseleave', () => {
        line.classList.remove('highlight-match');
        targetIds.forEach(tId => {
            transcriptsList.querySelectorAll(`.transcript-line[data-id="${tId}"]`).forEach(el => el.classList.remove('highlight-match'));
        });
    });

    translationList.appendChild(line);
    if (shouldScroll) scrollTranslationToBottom();
}

function appendErrorCard(item, shouldScroll = true) {
    transcriptsEmptyState.style.display = 'none';
    const line = document.createElement('div');
    line.className = 'error-line';
    line.innerHTML = `<span class="error-line-badge">ERROR</span><span>${escapeHtml(item.text)}${item.tip ? ' (' + escapeHtml(item.tip) + ')' : ''}</span>`;
    transcriptsList.appendChild(line);
    if (shouldScroll) scrollTranscriptsToBottom();
}

async function reportError(errorMessage, tip = '') {
    const errorItem = { type: 'error', text: errorMessage, tip, time: new Date().toLocaleTimeString() };
    errorItems.push(errorItem);
    appendErrorCard(errorItem, true);
    updateStats();
    if (errorItems.length > 50) errorItems.shift();
    await chrome.storage.local.set({ errorItems });
}

function renderAllPanes() {
    transcriptsList.innerHTML = '';
    translationList.innerHTML = '';

    if (transcriptItems.length === 0 && errorItems.length === 0) {
        transcriptsEmptyState.style.display = 'flex';
    } else {
        transcriptsEmptyState.style.display = 'none';
        transcriptItems.forEach(item => appendLiveTranscriptCard(item, false));
        errorItems.forEach(item => appendErrorCard(item, false));
    }

    if (translationItems.length === 0) {
        translationEmptyState.style.display = 'flex';
    } else {
        translationEmptyState.style.display = 'none';
        translationItems.forEach(item => appendTranslationBatchCard(item, false));
    }

    updateStats();
    scrollTranscriptsToBottom();
    scrollTranslationToBottom();
    setTimeout(() => {
        scrollTranscriptsToBottom();
        scrollTranslationToBottom();
    }, 50);
    setTimeout(() => {
        scrollTranscriptsToBottom();
        scrollTranslationToBottom();
    }, 200);
}

// --- Capture Control ---

function stopDirectCapture() {
    isCapturing = false;
    isBusy = false;
    updateCaptureUI(false);
    updateStatusUI('idle');
    liveBubble.style.display = 'none';
    chrome.runtime.sendMessage({ action: 'stopTabCapture' }, () => {});
}

// --- Message Listener ---

chrome.runtime.onMessage.addListener(async (message) => {
    if (message.action === 'setTargetTab' && message.tabId) {
        if (!isCapturing) {
            currentTargetTabId = message.tabId;
            updateSelectedTabInfo(currentTargetTabId);
            showToast('Target tab updated');
        }
    }

    if (message.type === 'transcript') {
        if (message.is_final) {
            liveBubble.style.display = 'none';
            liveText.textContent = '';
            const item = { id: message.id || `utt_${Date.now()}`, text: message.transcript, time: message.time || new Date().toLocaleTimeString() };
            transcriptItems.push(item);
            appendLiveTranscriptCard(item, true);
            updateStats();
            if (transcriptItems.length > 250) transcriptItems.shift();
            await chrome.storage.local.set({ transcriptItems });
        } else {
            transcriptsEmptyState.style.display = 'none';
            liveBubble.style.display = 'flex';
            liveText.textContent = message.transcript;
            scrollTranscriptsToBottom();
        }
    } else if (message.type === 'translation') {
        const batchItem = {
            id: message.id || `trans_${Date.now()}`, ids: message.ids || [],
            original: message.original, translation: message.translation,
            time: message.time || new Date().toLocaleTimeString()
        };
        translationItems.push(batchItem);
        appendTranslationBatchCard(batchItem, true);
        updateStats();
        if (translationItems.length > 150) translationItems.shift();
        await chrome.storage.local.set({ translationItems });
    } else if (message.type === 'capture_status') {
        if (message.status === 'started') {
            isCapturing = true; isBusy = false;
            updateCaptureUI(true); updateStatusUI('connected');
        } else {
            isCapturing = false; isBusy = false;
            updateCaptureUI(false); updateStatusUI('idle');
        }
    } else if (message.type === 'error') {
        reportError(`Capture Error: ${message.message}`, 'Backend or recording issue.');
        updateStatusUI('error');
        isBusy = false;
    }
});

// --- Init ---

async function init() {
    try { window.focus(); } catch (e) {}

    fetch('http://127.0.0.1:8000/')
        .then(res => res.json())
        .then(() => {
            if (footerServer) { footerServer.textContent = '● Server Online'; footerServer.style.color = '#34d399'; }
        })
        .catch(() => {
            if (footerServer) { footerServer.textContent = '○ Server Offline'; footerServer.style.color = '#f87171'; }
        });

    try {
        const activeVideoRes = await chrome.storage.local.get(['kotoba_active_video_id']);
        const activeVid = activeVideoRes.kotoba_active_video_id;
        let savedState = null;

        if (activeVid) {
            const vidRes = await chrome.storage.local.get([`kotoba_state_${activeVid}`]);
            savedState = vidRes[`kotoba_state_${activeVid}`];
        }

        if (savedState && Array.isArray(savedState.transcriptItems)) {
            transcriptItems = savedState.transcriptItems || [];
            translationItems = savedState.translationItems || [];
            if (savedState.metadata) {
                if (savedState.metadata.channel && ytChannelName) ytChannelName.textContent = savedState.metadata.channel;
                if (savedState.metadata.title && ytVideoTitle) ytVideoTitle.textContent = savedState.metadata.title;
            }
        } else {
            const store = await chrome.storage.local.get({ transcriptItems: [], translationItems: [], errorItems: [] });
            transcriptItems = store.transcriptItems || [];
            translationItems = store.translationItems || [];
            errorItems = store.errorItems || [];
        }

        renderAllPanes();
        await resolveInitialTargetTab();
    } catch (e) {
        console.error('Init error:', e);
    }
}

// --- Event Handlers ---

toggleBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    if (isBusy) return;

    if (toggleBtn.dataset.state === 'off') {
        if (!currentTargetTabId) {
            reportError('No target tab selected.', 'Open your stream tab and click the extension icon on it.');
            showToast('No target tab');
            return;
        }
        isBusy = true;
        updateStatusUI('connecting');
        btnLabel.textContent = 'Connecting...';

        chrome.runtime.sendMessage({
            action: 'startTabCapture', tabId: currentTargetTabId, lang: 'ja', model: 'nova-3',
            title: ytVideoTitle ? ytVideoTitle.textContent.trim() : '',
            channel: ytChannelName ? ytChannelName.textContent.trim() : ''
        }, (res) => {
            isBusy = false;
            if (!res || !res.success) {
                reportError(`Tab Capture Error: ${res?.error || 'Failed to start'}`, 'Check tab selection.');
                showToast('Failed to start capture');
                updateCaptureUI(false); updateStatusUI('error');
            } else {
                isCapturing = true;
                updateCaptureUI(true); updateStatusUI('connected');
                showToast('Audio capture started');
            }
        });
    } else {
        stopDirectCapture();
        showToast('Capture stopped');
    }
});

forceCloseBtn.addEventListener('click', () => {
    stopDirectCapture();
    showToast('Stream closed & reset');
});

copyTranscriptsBtn.addEventListener('click', () => {
    if (transcriptItems.length === 0) { showToast('No transcripts to copy'); return; }
    navigator.clipboard.writeText(transcriptItems.map(t => `[${t.time}] ${t.text}`).join('\n'))
        .then(() => showToast('Copied transcripts to clipboard!')).catch(() => showToast('Copy failed'));
});

copyTranslationBtn.addEventListener('click', () => {
    if (translationItems.length === 0) { showToast('No translations to copy'); return; }
    navigator.clipboard.writeText(translationItems.map(t => `[${t.time}] ${t.translation}\n  ↳ Original: ${t.original}`).join('\n\n'))
        .then(() => showToast('Copied translations to clipboard!')).catch(() => showToast('Copy failed'));
});

clearBtn.addEventListener('click', async () => {
    transcriptItems = []; translationItems = []; errorItems = [];
    await chrome.storage.local.set({ transcriptItems: [], translationItems: [], errorItems: [] });
    liveBubble.style.display = 'none';
    renderAllPanes();
    showToast('Cleared all items');
});

init();