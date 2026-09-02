/**
 * Project KOTOBA - Output Window Controller
 *
 * Standalone popup and tab UI providing:
 * - Live audio capture controls and language selection.
 * - Dual split-feed streams: Live Japanese transcripts + English translation batches.
 * - Tab and YouTube stream metadata extraction.
 * - VTuber Knowledge Base integration with interactive profile modal.
 * - Bidirectional hover-linking between translation batches and Japanese source sentences.
 */

// =============================================================================
// DOM Elements & UI Bindings
// =============================================================================

const toggleBtn = document.getElementById('toggle-btn');
const btnIcon = document.getElementById('btn-icon');
const btnLabel = document.getElementById('btn-label');
const forceCloseBtn = document.getElementById('force-close-btn');
const clearBtn = document.getElementById('clear-btn');
const copyTranscriptsBtn = document.getElementById('copy-transcripts-btn');
const copyTranslationBtn = document.getElementById('copy-translation-btn');
const langSelect = document.getElementById('lang-select');

if (langSelect) {
    const savedLang = localStorage.getItem('kotoba_selected_lang');
    if (savedLang) langSelect.value = savedLang;
    langSelect.addEventListener('change', () => {
        localStorage.setItem('kotoba_selected_lang', langSelect.value);
    });
}

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
const translationToggle = document.getElementById('translation-toggle');
const translationEmptyTitle = document.getElementById('translation-empty-title');
const translationEmptyDesc = document.getElementById('translation-empty-desc');

if (translationToggle) {
    translationToggle.checked = false;
    translationToggle.addEventListener('change', () => {
        if (translationEmptyTitle) {
            translationEmptyTitle.textContent = translationToggle.checked ? 'Translations will appear here.' : 'Translations are turned off';
        }
        if (translationEmptyDesc) {
            translationEmptyDesc.textContent = translationToggle.checked ? 'Waiting for translated sentences...' : 'Turn on the switch to enable AI translation.';
        }
    });
}

const summaryBtn = document.getElementById('summary-btn');
const summaryContentEl = document.getElementById('summary-content');

const liveBubble = document.getElementById('live-bubble');
const liveText = document.getElementById('live-text');
const statusPill = document.getElementById('status-pill');
const statusText = document.getElementById('status-text');
const charCount = document.getElementById('char-count');
const toast = document.getElementById('toast');
const footerServer = document.querySelector('.footer-server');

// VTuber Modal Elements
const vtuberModal = document.getElementById('vtuber-modal');
const modalAvatarWrap = document.getElementById('modal-card-avatar-wrap');
const modalAvatarImg = document.getElementById('modal-card-avatar-img');
const modalNameEl = document.getElementById('modal-card-name');
const modalOfficeEl = document.getElementById('modal-card-office');
const modalFactsList = document.getElementById('modal-card-facts');

// Settings Modal Elements
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsCancelBtn = document.getElementById('settings-cancel-btn');
const settingsOkBtn = document.getElementById('settings-ok-btn');
const settingsResetBtn = document.getElementById('settings-reset-btn');
const settingChatContextInput = document.getElementById('setting-chat-context-count');
const settingSummaryWordsInput = document.getElementById('setting-summary-max-words');
const settingBufferMinCharsInput = document.getElementById('setting-buffer-min-chars');
const settingBufferFlushDelayInput = document.getElementById('setting-buffer-flush-delay');
const settingLookaheadTimeoutInput = document.getElementById('setting-lookahead-timeout');
const settingGeminiKeyInput = document.getElementById('setting-gemini-key');
const settingDeepgramKeyInput = document.getElementById('setting-deepgram-key');

const DEFAULT_PIPELINE_SETTINGS = {
    chat_context_count: 20,
    summary_max_words: 500,
    buffer_min_chars: 30,
    buffer_flush_delay: 3.0,
    lookahead_timeout: 3.0,
    gemini_api_key: '',
    deepgram_api_key: '',
};
let pipelineSettings = { ...DEFAULT_PIPELINE_SETTINGS };

async function loadPipelineSettings() {
    try {
        const data = await chrome.storage.local.get('kotoba_settings');
        if (data && data.kotoba_settings) {
            pipelineSettings = { ...DEFAULT_PIPELINE_SETTINGS, ...data.kotoba_settings };
        }
    } catch (e) {}
}
loadPipelineSettings();
const modalCloseBtn = document.getElementById('modal-card-close');
const modalDescWrap = document.getElementById('modal-card-desc-wrap');
const modalDescText = document.getElementById('modal-card-desc-text');
const modalSeeMoreBtn = document.getElementById('modal-card-see-more-btn');

// =============================================================================
// Application State
// =============================================================================

let currentTargetTabId = null;
let lastTargetTabMeta = null;
let lastVtuberProfile = null;
let currentSummary = '';
let transcriptItems = [];
let translationItems = [];
let errorItems = [];
let isBusy = false;
let isCapturing = false;

// =============================================================================
// Helper Functions & Utilities
// =============================================================================

/**
 * Escapes HTML characters for safe template string insertion.
 */
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

let toastTimeout = null;

/**
 * Displays a temporary bottom notification toast.
 */
function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
        toastTimeout = null;
    }, 3000);
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

function updateSummaryUI(summaryText) {
    currentSummary = (summaryText || '').trim();
    if (summaryContentEl) {
        if (currentSummary) {
            summaryContentEl.textContent = currentSummary;
        } else {
            summaryContentEl.textContent = 'No summary available yet. Summary will generate as the stream progresses.';
        }
    }
}

/**
 * Cleans repetitive patterns and metadata from scraped channel names.
 */
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

// =============================================================================
// Tab & YouTube Metadata Extractors (Injected via Scripting API)
// =============================================================================

function inPageMetadataExtractor() {
    try {
        const href = window.location.href || '';
        const host = window.location.hostname || '';
        const isYT = host.includes('youtube.com');

        if (!isYT) {
            return {
                isYouTube: false,
                title: document.title || 'Webpage',
                channel: host.replace(/^www\./, '') || 'Web',
                status: 'PLAYBACK',
                url: href
            };
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
        let channelLink = '';
        const channelEl = document.querySelector(
            'ytd-video-owner-renderer ytd-channel-name yt-formatted-string#text a, ' +
            'ytd-video-owner-renderer ytd-channel-name a, ' +
            '#owner ytd-channel-name #text a, ' +
            '#owner #channel-name a, ' +
            '#upload-info #channel-name a, ' +
            'ytd-channel-name a'
        );
        if (channelEl) {
            if (channelEl.textContent && channelEl.textContent.trim()) {
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
            const h = channelEl.href || (channelEl.getAttribute && channelEl.getAttribute('href'));
            if (h && !h.startsWith('javascript:')) {
                try { channelLink = new URL(h, window.location.origin).href; } catch (e) {}
            }
        }

        if (!channelLink) {
            const linkEl = document.querySelector(
                'ytd-video-owner-renderer a#avatar, ' +
                '#owner a#avatar, ' +
                '#owner a[href*="/@"], ' +
                '#owner a[href*="/channel/"], ' +
                'ytd-video-owner-renderer a[href*="/@"], ' +
                'ytd-video-owner-renderer a[href*="/channel/"]'
            );
            if (linkEl) {
                const h = linkEl.href || (linkEl.getAttribute && linkEl.getAttribute('href'));
                if (h && !h.startsWith('javascript:')) {
                    try { channelLink = new URL(h, window.location.origin).href; } catch (e) { channelLink = h; }
                }
            }
        }

        if (!channel) {
            const mn = document.querySelector('meta[name="author"], meta[property="og:video:actor"]');
            if (mn && (mn.content || mn.getAttribute('content'))) {
                channel = (mn.content || mn.getAttribute('content')).trim();
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
            channelLink: channelLink || '',
            url: href
        };
    } catch (e) {
        return {
            isYouTube: true,
            status: 'PLAYBACK',
            title: document.title.replace(/\s*-\s*YouTube$/, '').trim() || 'YouTube Video',
            channel: 'YouTube Channel',
            channelLink: '',
            url: window.location.href
        };
    }
}

function inPageAvatarExtractor() {
    const selectors = [
        '#owner #avatar img',
        'ytd-video-owner-renderer #avatar img',
        '#owner yt-img-shadow img',
        'ytd-channel-name img',
        '#avatar img',
        '#owner img',
        'img.yt-core-image[src*="yt3.ggpht.com"]'
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.src && !el.src.includes('data:image/svg')) {
            return el.src;
        }
    }
    return '';
}

// =============================================================================
// Stream Metadata & VTuber Profile Resolution
// =============================================================================

async function updateSelectedTabInfo(tabId) {
    if (!tabId || isNaN(tabId)) {
        if (ytInfoPlaceholder) ytInfoPlaceholder.style.display = 'flex';
        if (ytInfoContent) ytInfoContent.style.display = 'none';
        return;
    }

    try {
        let meta = null;

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: Number(tabId) },
                func: inPageMetadataExtractor
            });
            if (results && results[0] && results[0].result) meta = results[0].result;
        } catch (e) {}

        if (!meta) {
            try {
                const tab = await chrome.tabs.get(Number(tabId));
                if (tab) {
                    const isYT = tab.url ? tab.url.includes('youtube.com') : (tab.title ? tab.title.includes('YouTube') : false);
                    meta = {
                        isYouTube: isYT,
                        status: 'PLAYBACK',
                        title: (tab.title || '').replace(/\s*-\s*YouTube$/, '').trim() || 'Media Playback',
                        channel: isYT ? 'YouTube' : (tab.url ? new URL(tab.url).hostname.replace(/^www\./, '') : 'Webpage'),
                        channelLink: ''
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

        lastTargetTabMeta = meta;

        let displayChannel = meta.channel || 'Media Channel';
        if (meta.channel || meta.channelLink) {
            try {
                const query = new URLSearchParams({ channel_name: meta.channel || '', channel_link: meta.channelLink || '' });
                const res = await fetch(`http://127.0.0.1:8000/api/vtuber/lookup?${query.toString()}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data) {
                        lastVtuberProfile = data;
                        if (data.display_name) displayChannel = data.display_name;
                        if (!meta.channelLink && data.channels?.[0]?.channel_link) {
                            lastTargetTabMeta.channelLink = data.channels[0].channel_link;
                        }
                    }
                }
            } catch (e) {}
        }

        ytChannelName.textContent = displayChannel;
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

// =============================================================================
// VTuber Profile Modal Dialog
// =============================================================================

async function openVtuberModal() {
    if (!vtuberModal) return;

    if (currentTargetTabId) await updateSelectedTabInfo(currentTargetTabId);

    let avatarSrc = 'icons/256.png';
    if (currentTargetTabId) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: Number(currentTargetTabId) },
                func: inPageAvatarExtractor
            });
            if (results && results[0] && results[0].result) avatarSrc = results[0].result;
        } catch (e) {}
    }

    if (modalAvatarImg) modalAvatarImg.src = avatarSrc;
    if (modalAvatarWrap) {
        modalAvatarWrap.onclick = (e) => {
            e.stopPropagation();
            const targetUrl = lastTargetTabMeta?.channelLink;
            if (targetUrl) window.open(targetUrl, '_blank');
        };
    }

    let profile = lastVtuberProfile;
    if (!profile && lastTargetTabMeta) {
        try {
            const query = new URLSearchParams({
                channel_name: lastTargetTabMeta.channel || '',
                channel_link: lastTargetTabMeta.channelLink || ''
            });
            const res = await fetch(`http://127.0.0.1:8000/api/vtuber/lookup?${query.toString()}`);
            if (res.ok) {
                profile = await res.json();
                lastVtuberProfile = profile;
            }
        } catch (e) {}
    }

    if (modalNameEl) {
        modalNameEl.textContent = profile?.display_name || lastTargetTabMeta?.channel || 'Channel Name';
    }

    if (modalOfficeEl) {
        if (profile && profile.office_name) {
            modalOfficeEl.textContent = profile.office_name;
            modalOfficeEl.style.display = 'inline-flex';
        } else {
            modalOfficeEl.style.display = 'none';
        }
    }

    if (modalFactsList) {
        modalFactsList.innerHTML = '';
        if (profile && profile.facts && profile.facts.length > 0) {
            profile.facts.forEach(fact => {
                const li = document.createElement('li');
                li.className = 'modal-card-fact-item';
                li.textContent = fact;
                modalFactsList.appendChild(li);
            });
        } else {
            const li = document.createElement('li');
            li.className = 'modal-card-empty-state';
            li.textContent = 'No extra database facts found for this channel.';
            modalFactsList.appendChild(li);
        }
    }

    if (modalDescWrap && modalDescText) {
        const desc = (profile?.description || '').trim();
        if (desc) {
            modalDescText.textContent = desc;
            modalDescWrap.style.display = 'block';
            modalDescWrap.classList.remove('expanded');
            if (modalSeeMoreBtn) {
                modalSeeMoreBtn.textContent = 'See more';
                modalSeeMoreBtn.style.display = desc.length > 50 || desc.includes('\n') ? 'inline-block' : 'none';
            }
        } else {
            modalDescWrap.style.display = 'none';
        }
    }

    vtuberModal.classList.add('open');
}

function closeVtuberModal() {
    if (vtuberModal) vtuberModal.classList.remove('open');
}

function populateSettingsInputs() {
    if (settingChatContextInput) settingChatContextInput.value = pipelineSettings.chat_context_count;
    if (settingSummaryWordsInput) settingSummaryWordsInput.value = pipelineSettings.summary_max_words;
    if (settingBufferMinCharsInput) settingBufferMinCharsInput.value = pipelineSettings.buffer_min_chars;
    if (settingBufferFlushDelayInput) settingBufferFlushDelayInput.value = pipelineSettings.buffer_flush_delay;
    if (settingLookaheadTimeoutInput) settingLookaheadTimeoutInput.value = pipelineSettings.lookahead_timeout;
    if (settingGeminiKeyInput) settingGeminiKeyInput.value = pipelineSettings.gemini_api_key || '';
    if (settingDeepgramKeyInput) settingDeepgramKeyInput.value = pipelineSettings.deepgram_api_key || '';
}

function openSettingsModal() {
    if (isCapturing) return;
    populateSettingsInputs();
    if (settingsModal) settingsModal.classList.add('open');
}

function closeSettingsModal() {
    if (settingsModal) settingsModal.classList.remove('open');
}

async function savePipelineSettings() {
    const chatCtx = parseInt(settingChatContextInput?.value, 10);
    const summaryWords = parseInt(settingSummaryWordsInput?.value, 10);
    const bufMinChars = parseInt(settingBufferMinCharsInput?.value, 10);
    const bufFlushDelay = parseFloat(settingBufferFlushDelayInput?.value);
    const lookaheadTimeout = parseFloat(settingLookaheadTimeoutInput?.value);

    pipelineSettings = {
        chat_context_count: isNaN(chatCtx) ? DEFAULT_PIPELINE_SETTINGS.chat_context_count : Math.max(1, Math.min(50, chatCtx)),
        summary_max_words: isNaN(summaryWords) ? DEFAULT_PIPELINE_SETTINGS.summary_max_words : Math.max(50, Math.min(2000, summaryWords)),
        buffer_min_chars: isNaN(bufMinChars) ? DEFAULT_PIPELINE_SETTINGS.buffer_min_chars : Math.max(5, Math.min(200, bufMinChars)),
        buffer_flush_delay: isNaN(bufFlushDelay) ? DEFAULT_PIPELINE_SETTINGS.buffer_flush_delay : Math.max(0.5, Math.min(30.0, bufFlushDelay)),
        lookahead_timeout: isNaN(lookaheadTimeout) ? DEFAULT_PIPELINE_SETTINGS.lookahead_timeout : Math.max(0.0, Math.min(30.0, lookaheadTimeout)),
        gemini_api_key: settingGeminiKeyInput ? settingGeminiKeyInput.value.trim() : (pipelineSettings.gemini_api_key || ''),
        deepgram_api_key: settingDeepgramKeyInput ? settingDeepgramKeyInput.value.trim() : (pipelineSettings.deepgram_api_key || ''),
    };

    try {
        await chrome.storage.local.set({ kotoba_settings: pipelineSettings });
        showToast('Settings saved');
    } catch (e) {
        showToast('Error saving settings');
    }
    closeSettingsModal();
}

// =============================================================================
// UI State & Capture Status Controls
// =============================================================================

function updateCaptureUI(active) {
    if (translationToggle) translationToggle.disabled = active;
    if (settingsBtn) {
        settingsBtn.disabled = active;
        if (active) {
            settingsBtn.classList.add('disabled');
            closeSettingsModal();
        } else {
            settingsBtn.classList.remove('disabled');
        }
    }
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
    if (status === 'connected') {
        statusPill.classList.add('active');
        statusText.textContent = 'Live';
    } else if (status === 'connecting') {
        statusPill.classList.add('connecting');
        statusText.textContent = 'Connecting';
    } else if (status === 'error') {
        statusPill.classList.add('error');
        statusText.textContent = 'Error';
    } else {
        statusText.textContent = 'Idle';
    }
}

function stopDirectCapture() {
    isCapturing = false;
    isBusy = false;
    updateCaptureUI(false);
    updateStatusUI('idle');
    if (liveBubble) liveBubble.style.display = 'none';
    chrome.runtime.sendMessage({ action: 'stopTabCapture' }, () => {});
}

// =============================================================================
// Feed Rendering & Bidirectional Sentence Cross-Highlighting
// =============================================================================

function appendLiveTranscriptCard(item, shouldScroll = true) {
    if (transcriptsEmptyState) transcriptsEmptyState.style.display = 'none';
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
    if (translationEmptyState) translationEmptyState.style.display = 'none';
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
    if (transcriptsEmptyState) transcriptsEmptyState.style.display = 'none';
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
        if (transcriptsEmptyState) transcriptsEmptyState.style.display = 'flex';
    } else {
        if (transcriptsEmptyState) transcriptsEmptyState.style.display = 'none';
        transcriptItems.forEach(item => appendLiveTranscriptCard(item, false));
        errorItems.forEach(item => appendErrorCard(item, false));
    }

    if (translationItems.length === 0) {
        if (translationEmptyState) {
            translationEmptyState.style.display = 'flex';
            if (translationEmptyTitle) {
                translationEmptyTitle.textContent = translationToggle && translationToggle.checked ? 'Translations will appear here.' : 'Translations are turned off';
            }
            if (translationEmptyDesc) {
                translationEmptyDesc.textContent = translationToggle && translationToggle.checked ? 'Waiting for translated sentences...' : 'Turn on the switch to enable AI translation.';
            }
        }
    } else {
        if (translationEmptyState) translationEmptyState.style.display = 'none';
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

// =============================================================================
// Extension Message Dispatcher
// =============================================================================

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
            if (liveBubble) liveBubble.style.display = 'none';
            if (liveText) liveText.textContent = '';
            const item = { id: message.id || `utt_${Date.now()}`, text: message.transcript, time: message.time || new Date().toLocaleTimeString() };
            transcriptItems.push(item);
            appendLiveTranscriptCard(item, true);
            updateStats();
            if (transcriptItems.length > 250) transcriptItems.shift();
            await chrome.storage.local.set({ transcriptItems });
        } else {
            if (transcriptsEmptyState) transcriptsEmptyState.style.display = 'none';
            if (liveBubble) {
                liveBubble.style.display = 'flex';
                if (liveText) liveText.textContent = message.transcript;
                scrollTranscriptsToBottom();
            }
        }
    } else if (message.type === 'translating') {
        if (message.id) {
            document.querySelectorAll('.transcript-line.is-target').forEach(el => el.classList.remove('is-target'));
            const targetEl = document.querySelector(`.transcript-line[data-id="${message.id}"]`);
            if (targetEl) targetEl.classList.add('is-target');
        }
    } else if (message.type === 'translation') {
        document.querySelectorAll('.transcript-line.is-target').forEach(el => el.classList.remove('is-target'));
        const batchItem = {
            id: message.id || `trans_${Date.now()}`,
            ids: message.ids || [],
            original: message.original,
            translation: message.translation,
            time: message.time || new Date().toLocaleTimeString()
        };
        translationItems.push(batchItem);
        appendTranslationBatchCard(batchItem, true);
        if (message.summary) {
            updateSummaryUI(message.summary);
            await chrome.storage.local.set({ kotoba_summary: message.summary });
        }
        updateStats();
        if (translationItems.length > 150) translationItems.shift();
        await chrome.storage.local.set({ translationItems });
    } else if (message.type === 'capture_status') {
        if (message.status === 'started') {
            isCapturing = true;
            isBusy = false;
            updateCaptureUI(true);
            updateStatusUI('connected');
        } else {
            isCapturing = false;
            isBusy = false;
            updateCaptureUI(false);
            updateStatusUI('idle');
        }
    } else if (message.type === 'error') {
        reportError(`Capture Error: ${message.message}`, 'Backend or recording issue.');
        updateStatusUI('error');
        isBusy = false;
    }
});

// =============================================================================
// Event Handlers & Initialization
// =============================================================================

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

        const selectedLang = langSelect ? langSelect.value : (localStorage.getItem('kotoba_selected_lang') || 'ja');
        const isTranslationEnabled = translationToggle ? translationToggle.checked : false;
        chrome.runtime.sendMessage({
            action: 'startTabCapture',
            tabId: currentTargetTabId,
            lang: selectedLang,
            model: 'nova-3',
            title: ytVideoTitle ? ytVideoTitle.textContent.trim() : '',
            channel: ytChannelName ? ytChannelName.textContent.trim() : '',
            translate: isTranslationEnabled,
            chat_context_count: pipelineSettings.chat_context_count,
            summary_max_words: pipelineSettings.summary_max_words,
            buffer_min_chars: pipelineSettings.buffer_min_chars,
            buffer_flush_delay: pipelineSettings.buffer_flush_delay,
            lookahead_timeout: pipelineSettings.lookahead_timeout,
            gemini_api_key: pipelineSettings.gemini_api_key || '',
            deepgram_api_key: pipelineSettings.deepgram_api_key || '',
        }, (res) => {
            isBusy = false;
            if (!res || !res.success) {
                reportError(`Tab Capture Error: ${res?.error || 'Failed to start'}`, 'Check tab selection.');
                showToast('Failed to start capture');
                updateCaptureUI(false);
                updateStatusUI('error');
            } else {
                isCapturing = true;
                updateCaptureUI(true);
                updateStatusUI('connected');
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
    if (transcriptItems.length === 0) {
        showToast('No transcripts to copy');
        return;
    }
    navigator.clipboard.writeText(transcriptItems.map(t => `[${t.time}] ${t.text}`).join('\n'))
        .then(() => showToast('Copied transcripts to clipboard!'))
        .catch(() => showToast('Copy failed'));
});

copyTranslationBtn.addEventListener('click', () => {
    if (translationItems.length === 0) {
        showToast('No translations to copy');
        return;
    }
    navigator.clipboard.writeText(translationItems.map(t => `[${t.time}] ${t.translation}\n  ↳ Original: ${t.original}`).join('\n\n'))
        .then(() => showToast('Copied translations to clipboard!'))
        .catch(() => showToast('Copy failed'));
});

clearBtn.addEventListener('click', async () => {
    transcriptItems = [];
    translationItems = [];
    errorItems = [];
    await chrome.storage.local.set({ transcriptItems: [], translationItems: [], errorItems: [] });
    if (liveBubble) liveBubble.style.display = 'none';
    renderAllPanes();
    showToast('Cleared all items');
});

// Summary Popover Hold & Toggle Event Listeners
const summaryWrap = document.getElementById('summary-wrap');
const summaryPopover = document.getElementById('summary-popover');
if (summaryBtn && summaryWrap) {
    summaryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = summaryWrap.classList.toggle('open');
        summaryBtn.classList.toggle('active', isOpen);
    });
}

if (summaryPopover) {
    summaryPopover.addEventListener('click', (e) => {
        e.stopPropagation();
    });
}

document.addEventListener('click', (e) => {
    if (summaryWrap && !summaryWrap.contains(e.target)) {
        summaryWrap.classList.remove('open');
        if (summaryBtn) summaryBtn.classList.remove('active');
    }
});

// VTuber Modal Trigger Event Listeners
if (ytChannelName) {
    ytChannelName.addEventListener('click', (e) => {
        e.stopPropagation();
        openVtuberModal();
    });
}
if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeVtuberModal();
    });
}
if (modalSeeMoreBtn) {
    modalSeeMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!modalDescWrap) return;
        const isExpanded = modalDescWrap.classList.toggle('expanded');
        modalSeeMoreBtn.textContent = isExpanded ? 'See less' : 'See more';
        if (!isExpanded && modalDescText) {
            modalDescText.scrollTop = 0;
        }
    });
}
if (vtuberModal) {
    vtuberModal.addEventListener('click', (e) => {
        if (e.target === vtuberModal) closeVtuberModal();
    });
}

// Settings Modal Listeners
if (settingsBtn) {
    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isCapturing) openSettingsModal();
    });
}
if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', () => closeSettingsModal());
if (settingsCancelBtn) settingsCancelBtn.addEventListener('click', () => closeSettingsModal());
if (settingsResetBtn) {
    settingsResetBtn.addEventListener('click', () => {
        if (settingChatContextInput) settingChatContextInput.value = DEFAULT_PIPELINE_SETTINGS.chat_context_count;
        if (settingSummaryWordsInput) settingSummaryWordsInput.value = DEFAULT_PIPELINE_SETTINGS.summary_max_words;
        if (settingBufferMinCharsInput) settingBufferMinCharsInput.value = DEFAULT_PIPELINE_SETTINGS.buffer_min_chars;
        if (settingBufferFlushDelayInput) settingBufferFlushDelayInput.value = DEFAULT_PIPELINE_SETTINGS.buffer_flush_delay;
        if (settingLookaheadTimeoutInput) settingLookaheadTimeoutInput.value = DEFAULT_PIPELINE_SETTINGS.lookahead_timeout;
        if (settingGeminiKeyInput) settingGeminiKeyInput.value = '';
        if (settingDeepgramKeyInput) settingDeepgramKeyInput.value = '';
    });
}
if (settingsOkBtn) settingsOkBtn.addEventListener('click', () => savePipelineSettings());
if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettingsModal();
    });

    const blockShortcuts = (e) => {
        if (e.key === 'Escape') return;
        e.stopPropagation();
    };
    settingsModal.addEventListener('keydown', blockShortcuts);
    settingsModal.addEventListener('keyup', blockShortcuts);
    settingsModal.addEventListener('keypress', blockShortcuts);
}

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (settingsModal && settingsModal.classList.contains('open')) {
            closeSettingsModal();
        } else if (vtuberModal && vtuberModal.classList.contains('open')) {
            closeVtuberModal();
        }
    }
});

/**
 * Initializes state from chrome.storage and verifies backend connectivity.
 */
async function init() {
    try { window.focus(); } catch (e) {}

    fetch('http://127.0.0.1:8000/')
        .then(res => res.json())
        .then(() => {
            if (footerServer) {
                footerServer.textContent = '● Server Online';
                footerServer.style.color = '#34d399';
            }
        })
        .catch(() => {
            if (footerServer) {
                footerServer.textContent = '○ Server Offline';
                footerServer.style.color = '#f87171';
            }
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

        if (chrome.tabs?.onUpdated) {
            chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
                if (tabId === currentTargetTabId && (changeInfo.url || changeInfo.title)) {
                    updateSelectedTabInfo(currentTargetTabId);
                }
            });
        }
    } catch (e) {
        console.error('Init error:', e);
    }
}

init();