/**
 * Project KOTOBA - YouTube In-Page Floating Overlay & Live Chat Scraper
 *
 * Responsibilities:
 * - Injects a draggable, floating dual-feed translation HUD inside YouTube watch pages.
 * - Extracts live YouTube video metadata, streamer identity, and Lore/Office info.
 * - Captures live chat events from top frame and embedded live chat iframes.
 * - Handles interactive bidirectional hover sentence highlighting across feeds.
 * - Manages persistent per-video transcript & translation history.
 */

(function () {
    const isTopFrame = window.top === window.self;
    const isChatFrame = window.location.pathname.startsWith('/live_chat') ||
                        window.location.pathname.startsWith('/live_chat_replay') ||
                        window.location.href.includes('live_chat');

    // If running inside YouTube Live Chat iframe, initialize chat scraper and exit
    if (!isTopFrame) {
        if (isChatFrame) initIframeLiveChatScraper();
        return;
    }

    // Guard against multiple top-frame script initializations
    if (window.__kotobaInitialized) return;
    window.__kotobaInitialized = true;

    // =========================================================================
    // Component State & DOM References
    // =========================================================================

    let shadowRoot = null;
    let triggerBtn = null;
    let overlayPanel = null;
    let toastEl = null;
    let statusBadge = null;
    let channelNameEl = null;
    let videoTitleEl = null;
    let toggleBtn = null;
    let toggleBtnLabel = null;
    let toggleBtnIcon = null;
    let langSelect = null;
    let clearBtn = null;
    let copyTranscriptsBtn = null;
    let copyTranslationBtn = null;
    let closeBtn = null;
    let transcriptsFeed = null;
    let translationFeed = null;
    let transcriptsScroll = null;
    let translationScroll = null;
    let transcriptsEmpty = null;
    let translationEmpty = null;
    let transcriptsBadge = null;
    let translationBadge = null;
    let translationToggle = null;
    let liveBubble = null;
    let liveText = null;
    let bubbleQueue = null;
    let relevantChatSlot = null;
    let relevantChatAuthor = null;
    let relevantChatMsg = null;
    let relevantChatTime = null;
    let relevantChatTooltip = null;
    let vtuberModal = null;
    let cardAvatarWrap = null;
    let cardAvatarImg = null;
    let cardNameEl = null;
    let cardOfficeEl = null;
    let cardFactsList = null;
    let cardCloseBtn = null;
    let cardDescWrap = null;
    let cardDescText = null;
    let cardSeeMoreBtn = null;
    let channelHoverCard = null;
    let channelHoverAvatar = null;
    let summaryBtn = null;
    let summaryContentEl = null;

    let currentSummary = "";
    let lastVtuberProfile = null;
    let isOverlayOpen = false;
    let isCapturing = false;
    let isBusy = false;
    let isTabAuthorized = false;
    let currentVideoId = null;
    let saveStateTimeout = null;
    let activeRelevantComment = null;
    let consecutiveNegativeCount = 0;
    let liveChatMessages = [];
    let transcriptItems = [];
    let translationItems = [];
    let metaObserver = null;

    // =========================================================================
    // Formatting & Utility Helpers
    // =========================================================================

    function isWatchPage() {
        const p = window.location.pathname;
        const s = window.location.search;
        return p === '/watch' || p.startsWith('/live') || p.startsWith('/shorts') || s.includes('v=');
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#039;');
    }

    function extractChannelAvatar() {
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
        return chrome.runtime.getURL('icons/256.png');
    }

    function cleanChannelName(raw) {
        if (!raw) return '';
        let s = raw.split(/[\r\n]+/).map(t => t.trim()).filter(Boolean)[0] || '';
        s = s.trim().replace(/\s*•\s*[\d.]+[KMB]?\s*subscribers.*$/i, '').trim();

        if (s.length >= 4 && s.length % 2 === 0 && s.slice(0, s.length / 2) === s.slice(s.length / 2)) {
            s = s.slice(0, s.length / 2).trim();
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

    function formatAuthorHandle(author) {
        if (!author) return '';
        const clean = author.trim().replace(/^@+/, '');
        return clean ? `@${clean}` : '';
    }

    function getVideoIdFromUrl(url) {
        if (!url) return null;
        try {
            const parsed = new URL(url);
            if (parsed.searchParams.has('v')) return parsed.searchParams.get('v');
            const parts = parsed.pathname.split('/').filter(Boolean);
            if (['live', 'shorts', 'embed', 'v'].includes(parts[0])) return parts[1] || null;
            if (parsed.hostname === 'youtu.be') return parts[0] || null;
            return null;
        } catch (e) {
            return null;
        }
    }

    let toastTimeout = null;
    function showToast(text) {
        if (!toastEl) return;
        toastEl.textContent = text;
        toastEl.classList.add('show');
        if (toastTimeout) clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            toastEl.classList.remove('show');
            toastTimeout = null;
        }, 2500);
    }

    // =========================================================================
    // YouTube DOM Metadata Extraction & VTuber Resolution
    // =========================================================================

    function extractYouTubeMetadata() {
        try {
            let title = '';
            const titleEl = document.querySelector(
                'h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string, ' +
                'ytd-video-primary-info-renderer #title h1, h1.ytd-video-primary-info-renderer, ' +
                'h1.title, #title h1, h1.ytd-watch-metadata'
            );
            if (titleEl && titleEl.textContent && titleEl.textContent.trim()) {
                title = titleEl.textContent.trim();
            } else {
                const mt = document.querySelector('meta[name="title"], meta[property="og:title"]');
                title = mt ? (mt.content || mt.getAttribute('content') || '') : document.title.replace(/\s*-\s*YouTube$/, '').trim();
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
                    channel = cleanChannelName(channelEl.textContent);
                }
                const h = channelEl.href || (channelEl.getAttribute && channelEl.getAttribute('href'));
                if (h && !h.startsWith('javascript:')) {
                    try { channelLink = new URL(h, window.location.origin).href; } catch (e) { channelLink = h; }
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
                    channel = cleanChannelName(mn.content || mn.getAttribute('content'));
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
                status: isLive ? 'LIVE' : 'PLAYBACK',
                title: title || document.title.replace(/\s*-\s*YouTube$/, '').trim() || 'YouTube Stream',
                channel: channel || 'YouTube Channel',
                channelLink: channelLink || '',
            };
        } catch (e) {
            return {
                status: 'PLAYBACK',
                title: document.title.replace(/\s*-\s*YouTube$/, '').trim() || 'YouTube Video',
                channel: 'YouTube Channel',
                channelLink: ''
            };
        }
    }

    let lastQueriedChannel = '';
    let resolvedVtuberName = '';
    let currentChannelLink = '';

    async function updateMetadataUI() {
        if (!statusBadge || !channelNameEl || !videoTitleEl) return;

        const vId = getVideoIdFromUrl(window.location.href);
        if (vId && vId !== currentVideoId) {
            currentVideoId = vId;
            lastQueriedChannel = '';
            resolvedVtuberName = '';
            currentChannelLink = '';
            lastVtuberProfile = null;
        }

        const meta = extractYouTubeMetadata();
        statusBadge.className = meta.status === 'LIVE' ? 'kotoba-badge-status live' : 'kotoba-badge-status playback';
        statusBadge.textContent = meta.status;
        videoTitleEl.textContent = meta.title || 'YouTube Stream';
        currentChannelLink = meta.channelLink || currentChannelLink || '';

        const queryKey = `${meta.channel}|${currentChannelLink}`;
        if (queryKey === lastQueriedChannel && resolvedVtuberName) {
            channelNameEl.textContent = resolvedVtuberName;
            return;
        }

        channelNameEl.textContent = resolvedVtuberName || meta.channel || 'YouTube Channel';

        if (meta.channel || currentChannelLink) {
            lastQueriedChannel = queryKey;
            try {
                const query = new URLSearchParams({ channel_name: meta.channel || '', channel_link: currentChannelLink });
                const res = await fetch(`http://127.0.0.1:8000/api/vtuber/lookup?${query.toString()}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data) {
                        lastVtuberProfile = data;
                        if (data.display_name) {
                            resolvedVtuberName = data.display_name;
                            channelNameEl.textContent = data.display_name;
                        }
                        if (data.channels?.[0]?.channel_link && !currentChannelLink) {
                            currentChannelLink = data.channels[0].channel_link;
                        }
                    }
                }
            } catch (e) {}
        }
    }

    async function openVtuberCard() {
        if (!vtuberModal) return;
        const avatarSrc = extractChannelAvatar();

        if (cardAvatarImg) cardAvatarImg.src = avatarSrc;
        if (cardAvatarWrap) {
            cardAvatarWrap.onclick = (e) => {
                e.stopPropagation();
                const link = extractYouTubeMetadata().channelLink || currentChannelLink;
                if (link) window.open(link, '_blank');
            };
        }

        let profile = lastVtuberProfile;
        if (!profile) {
            const meta = extractYouTubeMetadata();
            try {
                const query = new URLSearchParams({ channel_name: meta.channel || '', channel_link: currentChannelLink });
                const res = await fetch(`http://127.0.0.1:8000/api/vtuber/lookup?${query.toString()}`);
                if (res.ok) {
                    profile = await res.json();
                    lastVtuberProfile = profile;
                    if (profile?.channels?.[0]?.channel_link) currentChannelLink = profile.channels[0].channel_link;
                }
            } catch (e) {}
        }

        if (cardNameEl) cardNameEl.textContent = profile?.display_name || channelNameEl?.textContent || 'Channel Name';

        if (cardOfficeEl) {
            if (profile?.office_name) {
                cardOfficeEl.textContent = profile.office_name;
                cardOfficeEl.style.display = 'inline-flex';
            } else {
                cardOfficeEl.style.display = 'none';
            }
        }

        if (cardDescWrap && cardDescText) {
            const desc = (profile?.description || '').trim();
            if (desc) {
                cardDescText.textContent = desc;
                cardDescWrap.style.display = 'block';
                cardDescWrap.classList.remove('expanded');
                if (cardSeeMoreBtn) {
                    cardSeeMoreBtn.textContent = 'See more';
                    cardSeeMoreBtn.style.display = desc.length > 50 || desc.includes('\n') ? 'inline-block' : 'none';
                }
            } else {
                cardDescWrap.style.display = 'none';
            }
        }

        if (cardFactsList) {
            cardFactsList.innerHTML = '';
            if (profile?.facts?.length > 0) {
                profile.facts.forEach(fact => {
                    const li = document.createElement('li');
                    li.className = 'kotoba-card-fact-item';
                    li.textContent = fact;
                    cardFactsList.appendChild(li);
                });
            } else {
                const li = document.createElement('li');
                li.className = 'kotoba-card-empty-state';
                li.textContent = 'No extra facts found for this channel.';
                cardFactsList.appendChild(li);
            }
        }

        vtuberModal.classList.add('open');
    }

    function closeVtuberCard() {
        if (vtuberModal) vtuberModal.classList.remove('open');
    }

    function scheduleMetadataUpdates() {
        updateMetadataUI();
        setTimeout(updateMetadataUI, 300);
        setTimeout(updateMetadataUI, 800);
        setTimeout(updateMetadataUI, 1500);
        setTimeout(updateMetadataUI, 3000);
    }

    function observeYouTubeMetadata() {
        if (metaObserver) metaObserver.disconnect();
        metaObserver = new MutationObserver(() => updateMetadataUI());
        const target = document.querySelector('ytd-watch-metadata') || document.querySelector('#owner') || document.body;
        if (target) metaObserver.observe(target, { childList: true, subtree: true, characterData: true });
    }

    ['yt-navigate-finish', 'yt-page-data-updated', 'popstate'].forEach(evt => {
        window.addEventListener(evt, () => {
            lastQueriedChannel = '';
            resolvedVtuberName = '';
            currentChannelLink = '';
            lastVtuberProfile = null;
            scheduleMetadataUpdates();
        });
    });

    // =========================================================================
    // Shadow DOM Construction & UI Binding
    // =========================================================================

    function createKotobaOverlayDOM() {
        if (shadowRoot || !document.body) return;

        const root = document.createElement('div');
        root.id = 'kotoba-root';
        document.body.appendChild(root);
        shadowRoot = root.attachShadow({ mode: 'open' });

        const styleLink = document.createElement('link');
        styleLink.rel = 'stylesheet';
        styleLink.href = chrome.runtime.getURL('content.css');
        shadowRoot.appendChild(styleLink);

        const wrapper = document.createElement('div');
        wrapper.className = 'kotoba-wrapper';
        wrapper.innerHTML = `
            <button id="kotoba-trigger-btn" class="unauthorized" title="Press Alt+K (or click toolbar icon) to authorize &amp; open KOTOBA" style="background-image: url('${chrome.runtime.getURL('icons/256.png')}');"></button>
            <div id="kotoba-overlay-panel">
                <div class="kotoba-bubble-queue" id="kotoba-bubble-queue"></div>
                <div class="kotoba-toast" id="kotoba-toast">Notice</div>
                <div class="kotoba-header">
                    <div class="kotoba-header-left">
                        <img class="kotoba-logo-img" src="${chrome.runtime.getURL('icons/256.png')}" alt="KOTOBA">
                        <div class="kotoba-header-info">
                            <div class="kotoba-header-channel-row">
                                <span class="kotoba-channel-name kotoba-channel-clickable" id="kotoba-channel-name">Channel Name</span>
                            </div>
                            <div class="kotoba-header-bottom-row">
                                <span class="kotoba-badge-status playback" id="kotoba-badge-status">PLAYBACK</span>
                                <span class="kotoba-video-title" id="kotoba-video-title">Stream / Video Title</span>
                            </div>
                        </div>
                    </div>
                    <div class="kotoba-header-actions">
                        <button class="kotoba-icon-btn close" id="kotoba-close-btn" title="Close">✕</button>
                    </div>
                </div>
                <div class="kotoba-controls-bar">
                    <div class="kotoba-controls-left">
                        <button class="kotoba-btn kotoba-btn-primary" id="kotoba-toggle-btn">
                            <span id="kotoba-btn-icon">▶</span>
                            <span id="kotoba-btn-label">Start Capture</span>
                        </button>
                        <select class="kotoba-select" id="kotoba-lang-select" title="Speech Recognition Language">
                            <option value="ja" selected>Japanese (日本語)</option>
                            <option value="en">English</option>
                            <option value="zh">Chinese - Simplified (简体中文)</option>
                            <option value="zh-TW">Chinese - Traditional (繁體中文)</option>
                            <option value="zh-HK">Cantonese (廣東話)</option>
                            <option value="ko">Korean (한국어)</option>
                            <option value="es">Spanish (Español)</option>
                            <option value="fr">French (Français)</option>
                            <option value="de">German (Deutsch)</option>
                            <option value="it">Italian (Italiano)</option>
                            <option value="pt">Portuguese (Português)</option>
                            <option value="ru">Russian (Русский)</option>
                            <option value="hi">Hindi (हिन्दी)</option>
                            <option value="id">Indonesian (Bahasa)</option>
                            <option value="th">Thai (ไทย)</option>
                            <option value="vi">Vietnamese (Tiếng Việt)</option>
                            <option value="tl">Tagalog (Filipino)</option>
                            <option value="tr">Turkish (Türkçe)</option>
                            <option value="ar">Arabic (العربية)</option>
                            <option value="nl">Dutch (Nederlands)</option>
                            <option value="no">Norwegian (Norsk)</option>
                            <option value="pl">Polish (Polski)</option>
                            <option value="sv">Swedish (Svenska)</option>
                            <option value="uk">Ukrainian (Українська)</option>
                            <option value="multi">Multilingual (Auto)</option>
                        </select>
                    </div>
                    <div class="kotoba-controls-right">
                        <button class="kotoba-subtle-btn" id="kotoba-clear-btn" title="Clear Feed">Clear Feed</button>
                    </div>
                </div>
                <div class="kotoba-relevant-chat-slot" id="kotoba-relevant-chat-slot">
                    <div class="kotoba-relevant-chat-top">
                        <span class="kotoba-relevant-chat-badge"><span class="kotoba-relevant-chat-dot"></span><span>RELEVANT CHAT</span></span>
                        <span class="kotoba-relevant-chat-author" id="kotoba-relevant-chat-author"></span>
                        <span class="kotoba-relevant-chat-time" id="kotoba-relevant-chat-time"></span>
                    </div>
                    <div class="kotoba-relevant-chat-msg" id="kotoba-relevant-chat-msg"><span class="kotoba-relevant-chat-placeholder">No active chat topic</span></div>
                    <div class="kotoba-chat-tooltip" id="kotoba-chat-tooltip"></div>
                </div>
                <div class="kotoba-dual-pane">
                    <div class="kotoba-pane">
                        <div class="kotoba-pane-header">
                            <span>Live Transcription</span>
                            <div class="kotoba-pane-header-actions">
                                <span class="kotoba-pane-badge" id="kotoba-transcripts-badge">0 lines</span>
                                <button class="kotoba-pane-icon-btn" id="kotoba-copy-transcripts" title="Copy Transcripts">
                                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <rect x="8.5" y="8.5" width="12" height="12" rx="3"></rect>
                                        <path d="M4.5 15.5C3.94772 15.5 3.5 15.0523 3.5 14.5V5.5C3.5 4.39543 4.39543 3.5 5.5 3.5H14.5C15.0523 3.5 15.5 3.94772 15.5 4.5"></path>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div class="kotoba-feed-scroll" id="kotoba-transcripts-scroll">
                            <div class="kotoba-empty-state" id="kotoba-transcripts-empty">Ready. Press Start Capture to transcribe speech.</div>
                            <div class="kotoba-feed-list" id="kotoba-transcripts-feed"></div>
                            <div class="kotoba-interim-bubble" id="kotoba-live-bubble"><span>●</span><span id="kotoba-live-text"></span></div>
                        </div>
                    </div>
                    <div class="kotoba-pane">
                        <div class="kotoba-pane-header">
                            <div class="kotoba-pane-title-group">
                                <span>Live Translation</span>
                                <label class="kotoba-switch" title="Toggle Live Translation">
                                    <input type="checkbox" id="kotoba-translation-toggle">
                                    <span class="kotoba-slider"></span>
                                </label>
                            </div>
                            <div class="kotoba-pane-header-actions">
                                <span class="kotoba-pane-badge" id="kotoba-translation-badge">0 lines</span>
                                <button class="kotoba-pane-icon-btn" id="kotoba-copy-translation" title="Copy Translations">
                                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <rect x="8.5" y="8.5" width="12" height="12" rx="3"></rect>
                                        <path d="M4.5 15.5C3.94772 15.5 3.5 15.0523 3.5 14.5V5.5C3.5 4.39543 4.39543 3.5 5.5 3.5H14.5C15.0523 3.5 15.5 3.94772 15.5 4.5"></path>
                                    </svg>
                                </button>
                                <div class="kotoba-summary-btn-wrap">
                                    <button class="kotoba-pane-icon-btn" id="kotoba-summary-btn" title="Stream Context Summary">
                                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                            <polyline points="14 2 14 8 20 8"></polyline>
                                            <line x1="16" y1="13" x2="8" y2="13"></line>
                                            <line x1="16" y1="17" x2="8" y2="17"></line>
                                            <polyline points="10 9 9 9 8 9"></polyline>
                                        </svg>
                                    </button>
                                    <div class="kotoba-summary-popover" id="kotoba-summary-popover">
                                        <div class="kotoba-summary-popover-header">
                                            <span>Stream Context Summary</span>
                                        </div>
                                        <div class="kotoba-summary-popover-body" id="kotoba-summary-content">No summary available yet. Summary will generate as the stream progresses.</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="kotoba-feed-scroll" id="kotoba-translation-scroll">
                            <div class="kotoba-empty-state" id="kotoba-translation-empty">Translations are turned off</div>
                            <div class="kotoba-feed-list" id="kotoba-translation-feed"></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- VTuber Profile Modal Card -->
            <div class="kotoba-modal-backdrop" id="kotoba-vtuber-modal">
                <div class="kotoba-card">
                    <button class="kotoba-card-close" id="kotoba-card-close" title="Close">✕</button>
                    <div class="kotoba-card-header">
                        <div class="kotoba-card-avatar-wrap" id="kotoba-card-avatar-wrap" title="Visit Channel">
                            <img class="kotoba-card-avatar-img" id="kotoba-card-avatar-img" src="" alt="Avatar">
                            <div class="kotoba-card-avatar-overlay">
                                <svg class="kotoba-card-avatar-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.0002 5H8.2002C7.08009 5 6.51962 5 6.0918 5.21799C5.71547 5.40973 5.40973 5.71547 5.21799 6.0918C5 6.51962 5 7.08009 5 8.2002V15.8002C5 16.9203 5 17.4801 5.21799 17.9079C5.40973 18.2842 5.71547 18.5905 6.0918 18.7822C6.5192 19 7.07899 19 8.19691 19H15.8031C16.921 19 17.48 19 17.9074 18.7822C18.2837 18.5905 18.5905 18.2839 18.7822 17.9076C19 17.4802 19 16.921 19 15.8031V14M20 9V4M20 4H15M20 4L13 11" stroke="#facc15" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </div>
                        </div>
                        <div class="kotoba-card-info">
                            <div class="kotoba-card-title" id="kotoba-card-name">Channel Name</div>
                            <div class="kotoba-card-office" id="kotoba-card-office" style="display: none;"></div>
                            <div class="kotoba-card-desc-container" id="kotoba-card-desc-wrap" style="display: none;">
                                <div class="kotoba-card-desc-text" id="kotoba-card-desc-text"></div>
                                <button class="kotoba-card-see-more-btn" id="kotoba-card-see-more-btn">See more</button>
                            </div>
                        </div>
                    </div>
                    <div class="kotoba-card-body">
                        <div class="kotoba-card-section-title">Extra Facts</div>
                        <ul class="kotoba-card-facts-list" id="kotoba-card-facts">
                            <li class="kotoba-card-empty-state">No extra facts found for this channel.</li>
                        </ul>
                    </div>
                </div>
            </div>

            <!-- Channel Hover Follow Card -->
            <div class="kotoba-channel-hover-card" id="kotoba-channel-hover-card" style="display: none;">
                <img class="kotoba-channel-hover-avatar" id="kotoba-channel-hover-avatar" src="" alt="Avatar">
                <span class="kotoba-channel-hover-guide">Click to show channel's profile</span>
            </div>
        `;
        shadowRoot.appendChild(wrapper);

        // Bind element references
        triggerBtn = shadowRoot.getElementById('kotoba-trigger-btn');
        overlayPanel = shadowRoot.getElementById('kotoba-overlay-panel');
        toastEl = shadowRoot.getElementById('kotoba-toast');
        statusBadge = shadowRoot.getElementById('kotoba-badge-status');
        channelNameEl = shadowRoot.getElementById('kotoba-channel-name');
        videoTitleEl = shadowRoot.getElementById('kotoba-video-title');
        toggleBtn = shadowRoot.getElementById('kotoba-toggle-btn');
        toggleBtnLabel = shadowRoot.getElementById('kotoba-btn-label');
        toggleBtnIcon = shadowRoot.getElementById('kotoba-btn-icon');
        langSelect = shadowRoot.getElementById('kotoba-lang-select');

        if (langSelect) {
            const savedLang = localStorage.getItem('kotoba_selected_lang');
            if (savedLang) langSelect.value = savedLang;
            langSelect.addEventListener('change', () => {
                localStorage.setItem('kotoba_selected_lang', langSelect.value);
            });
        }

        clearBtn = shadowRoot.getElementById('kotoba-clear-btn');
        copyTranscriptsBtn = shadowRoot.getElementById('kotoba-copy-transcripts');
        copyTranslationBtn = shadowRoot.getElementById('kotoba-copy-translation');
        closeBtn = shadowRoot.getElementById('kotoba-close-btn');
        transcriptsFeed = shadowRoot.getElementById('kotoba-transcripts-feed');
        translationFeed = shadowRoot.getElementById('kotoba-translation-feed');
        transcriptsScroll = shadowRoot.getElementById('kotoba-transcripts-scroll');
        translationScroll = shadowRoot.getElementById('kotoba-translation-scroll');
        transcriptsEmpty = shadowRoot.getElementById('kotoba-transcripts-empty');
        translationEmpty = shadowRoot.getElementById('kotoba-translation-empty');
        translationBadge = shadowRoot.getElementById('kotoba-translation-badge');
        translationToggle = shadowRoot.getElementById('kotoba-translation-toggle');
        if (translationToggle) {
            translationToggle.checked = false;
            translationToggle.addEventListener('change', () => {
                if (translationEmpty && translationItems.length === 0) {
                    translationEmpty.textContent = translationToggle.checked ? 'Translations will appear here.' : 'Translations are turned off';
                }
            });
        }
        transcriptsBadge = shadowRoot.getElementById('kotoba-transcripts-badge');
        liveBubble = shadowRoot.getElementById('kotoba-live-bubble');
        liveText = shadowRoot.getElementById('kotoba-live-text');
        relevantChatSlot = shadowRoot.getElementById('kotoba-relevant-chat-slot');
        relevantChatAuthor = shadowRoot.getElementById('kotoba-relevant-chat-author');
        relevantChatMsg = shadowRoot.getElementById('kotoba-relevant-chat-msg');
        relevantChatTime = shadowRoot.getElementById('kotoba-relevant-chat-time');
        relevantChatTooltip = shadowRoot.getElementById('kotoba-chat-tooltip');
        bubbleQueue = shadowRoot.getElementById('kotoba-bubble-queue');

        // Bind VTuber modal references
        vtuberModal = shadowRoot.getElementById('kotoba-vtuber-modal');
        cardAvatarWrap = shadowRoot.getElementById('kotoba-card-avatar-wrap');
        cardAvatarImg = shadowRoot.getElementById('kotoba-card-avatar-img');
        cardNameEl = shadowRoot.getElementById('kotoba-card-name');
        cardOfficeEl = shadowRoot.getElementById('kotoba-card-office');
        cardDescWrap = shadowRoot.getElementById('kotoba-card-desc-wrap');
        cardDescText = shadowRoot.getElementById('kotoba-card-desc-text');
        cardSeeMoreBtn = shadowRoot.getElementById('kotoba-card-see-more-btn');
        channelHoverCard = shadowRoot.getElementById('kotoba-channel-hover-card');
        channelHoverAvatar = shadowRoot.getElementById('kotoba-channel-hover-avatar');
        summaryBtn = shadowRoot.getElementById('kotoba-summary-btn');
        summaryContentEl = shadowRoot.getElementById('kotoba-summary-content');
        cardFactsList = shadowRoot.getElementById('kotoba-card-facts');
        cardCloseBtn = shadowRoot.getElementById('kotoba-card-close');

        makeDraggable(shadowRoot.querySelector('.kotoba-header'), overlayPanel);
        attachEventListeners();
        observeYouTubeMetadata();
        scheduleMetadataUpdates();
        setInterval(updateMetadataUI, 3000);
    }

    // =========================================================================
    // Draggable Overlay & UI Interaction
    // =========================================================================

    function makeDraggable(handle, panel) {
        if (!handle || !panel) return;
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let initialLeft = 0;
        let initialTop = 0;

        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('button') || e.target.closest('.kotoba-icon-btn')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
            panel.style.left = `${initialLeft}px`;
            panel.style.top = `${initialTop}px`;
            document.body.style.userSelect = 'none';
            handle.style.cursor = 'grabbing';

            const onMouseMove = (ev) => {
                if (!isDragging) return;
                let newLeft = initialLeft + ev.clientX - startX;
                let newTop = initialTop + ev.clientY - startY;
                newLeft = Math.min(Math.max(0, newLeft), Math.max(0, window.innerWidth - panel.offsetWidth));
                newTop = Math.min(Math.max(0, newTop), Math.max(0, window.innerHeight - panel.offsetHeight));
                panel.style.left = `${newLeft}px`;
                panel.style.top = `${newTop}px`;
            };

            const onMouseUp = () => {
                isDragging = false;
                document.body.style.userSelect = '';
                handle.style.cursor = 'grab';
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
            };

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
    }

    function checkTabReadiness() {
        chrome.runtime.sendMessage({ action: 'checkTabReadiness' }, (res) => {
            setTabAuthorized(res && res.ready);
        });
    }

    function setTabAuthorized(authorized) {
        isTabAuthorized = authorized;
        if (triggerBtn) {
            if (authorized) {
                triggerBtn.classList.remove('unauthorized');
                triggerBtn.removeAttribute('disabled');
                triggerBtn.title = 'Open KOTOBA Live Translator';
            } else {
                triggerBtn.classList.add('unauthorized');
                triggerBtn.setAttribute('disabled', 'true');
                triggerBtn.title = 'Press Alt+K (or click toolbar icon) to authorize & open KOTOBA';
            }
        }
        if (!isCapturing && toggleBtn) {
            toggleBtn.className = 'kotoba-btn kotoba-btn-primary';
            toggleBtnIcon.textContent = '▶';
            toggleBtnLabel.textContent = 'Start Capture';
        }
    }

    function scrollToBottomFeeds() {
        requestAnimationFrame(() => {
            if (transcriptsScroll) transcriptsScroll.scrollTop = transcriptsScroll.scrollHeight;
            if (translationScroll) translationScroll.scrollTop = translationScroll.scrollHeight;
        });
        setTimeout(() => {
            if (transcriptsScroll) transcriptsScroll.scrollTop = transcriptsScroll.scrollHeight;
            if (translationScroll) translationScroll.scrollTop = translationScroll.scrollHeight;
        }, 50);
        setTimeout(() => {
            if (transcriptsScroll) transcriptsScroll.scrollTop = transcriptsScroll.scrollHeight;
            if (translationScroll) translationScroll.scrollTop = translationScroll.scrollHeight;
        }, 200);
    }

    function toggleOverlay(open = null) {
        isOverlayOpen = open === null ? !isOverlayOpen : open;
        if (isOverlayOpen) {
            overlayPanel.style.display = 'flex';
            updateMetadataUI();
            checkTabReadiness();
            scrollToBottomFeeds();
        } else {
            overlayPanel.style.display = 'none';
        }
    }

    function attachEventListeners() {
        triggerBtn.addEventListener('click', () => {
            if (!isTabAuthorized) {
                showToast('Press Alt+K (or click toolbar icon) to authorize & open KOTOBA');
                return;
            }
            toggleOverlay();
        });

        closeBtn.addEventListener('click', () => toggleOverlay(false));
        toggleBtn.addEventListener('click', () => { isCapturing ? stopCapture() : startCapture(); });

        copyTranscriptsBtn.addEventListener('click', () => {
            if (transcriptItems.length === 0) {
                showToast('No transcripts to copy');
                return;
            }
            navigator.clipboard.writeText(transcriptItems.map(t => `[${t.time}] ${t.text}`).join('\n'))
                .then(() => showToast('Transcripts copied!'));
        });

        copyTranslationBtn.addEventListener('click', () => {
            if (translationItems.length === 0) {
                showToast('No translations to copy');
                return;
            }
            navigator.clipboard.writeText(translationItems.map(t => `[${t.time}] ${t.translation}\n  ↳ Original: ${t.original}`).join('\n\n'))
                .then(() => showToast('Translations copied!'));
        });

        clearBtn.addEventListener('click', () => {
            transcriptItems = [];
            translationItems = [];
            transcriptsFeed.innerHTML = '';
            translationFeed.innerHTML = '';
            transcriptsEmpty.style.display = 'block';
            if (translationEmpty) {
                translationEmpty.textContent = translationToggle && translationToggle.checked ? 'Translations will appear here.' : 'Translations are turned off';
                translationEmpty.style.display = 'block';
            }
            transcriptsBadge.textContent = '0 lines';
            translationBadge.textContent = '0 lines';
            liveBubble.style.display = 'none';
            activeRelevantComment = null;
            consecutiveNegativeCount = 0;
            renderRelevantComment(null);
            if (bubbleQueue) bubbleQueue.innerHTML = '';
            showToast('Feed cleared');
        });

        // VTuber Modal & Channel Hover Event Listeners
        if (channelNameEl) {
            channelNameEl.addEventListener('click', (e) => {
                e.stopPropagation();
                if (channelHoverCard) channelHoverCard.style.display = 'none';
                openVtuberCard();
            });

            channelNameEl.addEventListener('mouseenter', (e) => {
                if (!channelHoverCard) return;
                const avatar = extractChannelAvatar();
                if (channelHoverAvatar) channelHoverAvatar.src = avatar;
                channelHoverCard.style.display = 'flex';
                channelHoverCard.style.left = `${e.clientX + 12}px`;
                channelHoverCard.style.top = `${e.clientY + 12}px`;
            });

            channelNameEl.addEventListener('mousemove', (e) => {
                if (!channelHoverCard || channelHoverCard.style.display === 'none') return;
                channelHoverCard.style.left = `${e.clientX + 12}px`;
                channelHoverCard.style.top = `${e.clientY + 12}px`;
            });

            channelNameEl.addEventListener('mouseleave', () => {
                if (channelHoverCard) channelHoverCard.style.display = 'none';
            });
        }

        if (cardCloseBtn) {
            cardCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeVtuberCard();
            });
        }

        if (cardSeeMoreBtn) {
            cardSeeMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!cardDescWrap) return;
                const isExpanded = cardDescWrap.classList.toggle('expanded');
                cardSeeMoreBtn.textContent = isExpanded ? 'See less' : 'See more';
                if (!isExpanded && cardDescText) {
                    cardDescText.scrollTop = 0;
                }
            });
        }

        if (vtuberModal) {
            vtuberModal.addEventListener('click', (e) => {
                if (e.target === vtuberModal) closeVtuberCard();
            });
        }

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && vtuberModal && vtuberModal.classList.contains('open')) {
                closeVtuberCard();
            }
        });
    }

    // =========================================================================
    // Feed & Chat Queue Rendering
    // =========================================================================

    function addChatBubbleToQueue(chat) {
        if (!shadowRoot) createKotobaOverlayDOM();
        if (!bubbleQueue || !chat || !chat.message) return;

        const bubble = document.createElement('div');
        bubble.className = 'kotoba-chat-bubble';
        if (chat.id) bubble.dataset.id = chat.id;

        const author = document.createElement('span');
        author.className = 'kotoba-bubble-author';
        const rawAuthor = (chat.author || 'Viewer').trim().replace(/^@+/, '');
        author.textContent = rawAuthor ? `${rawAuthor}:` : 'Viewer:';

        const text = document.createElement('span');
        text.className = 'kotoba-bubble-text';
        text.textContent = chat.message;

        bubble.appendChild(author);
        bubble.appendChild(text);
        bubbleQueue.prepend(bubble);

        while (bubbleQueue.children.length > 5) {
            bubbleQueue.lastElementChild.remove();
        }

        setTimeout(() => {
            if (bubble.parentNode) {
                bubble.style.opacity = '0';
                bubble.style.transform = 'translateY(-4px)';
                setTimeout(() => { if (bubble.parentNode) bubble.remove(); }, 300);
            }
        }, 6500);
    }

    function renderRelevantComment(comment) {
        if (!relevantChatSlot) return;
        if (comment) {
            relevantChatSlot.classList.add('active');
            if (relevantChatAuthor) relevantChatAuthor.textContent = formatAuthorHandle(comment.author);
            if (relevantChatTime) relevantChatTime.textContent = comment.time || '';
            if (relevantChatMsg) relevantChatMsg.textContent = comment.translation || comment.message || '';
            if (relevantChatTooltip) {
                if (comment.message && comment.translation && comment.message !== comment.translation) {
                    relevantChatTooltip.textContent = `Original: ${comment.message}`;
                    relevantChatTooltip.classList.add('has-original');
                } else if (comment.message) {
                    relevantChatTooltip.textContent = `JA: ${comment.message}`;
                    relevantChatTooltip.classList.add('has-original');
                } else {
                    relevantChatTooltip.textContent = '';
                    relevantChatTooltip.classList.remove('has-original');
                }
            }
        } else {
            relevantChatSlot.classList.remove('active');
            if (relevantChatAuthor) relevantChatAuthor.textContent = '';
            if (relevantChatTime) relevantChatTime.textContent = '';
            if (relevantChatMsg) relevantChatMsg.innerHTML = '<span class="kotoba-relevant-chat-placeholder">No active chat topic</span>';
            if (relevantChatTooltip) {
                relevantChatTooltip.textContent = '';
                relevantChatTooltip.classList.remove('has-original');
            }
        }
    }

    function appendTranscriptLine(item) {
        if (!shadowRoot) createKotobaOverlayDOM();
        if (transcriptsEmpty) transcriptsEmpty.style.display = 'none';

        const line = document.createElement('div');
        line.className = 'kotoba-line kotoba-transcript-line';
        if (item.id) line.dataset.id = item.id;

        const mainRow = document.createElement('div');
        mainRow.className = 'kotoba-line-main';
        const textSpan = document.createElement('span');
        textSpan.className = 'kotoba-line-text';
        textSpan.textContent = item.text;
        const timeSpan = document.createElement('span');
        timeSpan.className = 'kotoba-line-time';
        timeSpan.textContent = item.time || new Date().toLocaleTimeString();

        mainRow.appendChild(textSpan);
        mainRow.appendChild(timeSpan);
        line.appendChild(mainRow);
        if (transcriptsFeed) transcriptsFeed.appendChild(line);
        if (transcriptsBadge) transcriptsBadge.textContent = `${transcriptItems.length} lines`;
        if (transcriptsScroll) transcriptsScroll.scrollTop = transcriptsScroll.scrollHeight;
    }

    function appendTranslationLine(item) {
        if (!shadowRoot) createKotobaOverlayDOM();
        if (translationEmpty) translationEmpty.style.display = 'none';

        const line = document.createElement('div');
        line.className = 'kotoba-line kotoba-translation-line';
        if (item.id) line.dataset.id = item.id;
        const targetIds = item.ids || (item.id ? [item.id] : []);
        if (targetIds.length > 0) line.dataset.targetIds = targetIds.join(',');

        const mainRow = document.createElement('div');
        mainRow.className = 'kotoba-line-main';
        const transText = document.createElement('span');
        transText.className = 'kotoba-line-text';
        transText.textContent = item.translation;
        const timeSpan = document.createElement('span');
        timeSpan.className = 'kotoba-line-time';
        timeSpan.textContent = item.time || new Date().toLocaleTimeString();

        mainRow.appendChild(transText);
        mainRow.appendChild(timeSpan);
        line.appendChild(mainRow);

        // Latest-active highlight
        if (shadowRoot) shadowRoot.querySelectorAll('.latest-active').forEach(el => el.classList.remove('latest-active'));
        line.classList.add('latest-active');
        targetIds.forEach(tId => {
            shadowRoot.querySelectorAll(`.kotoba-transcript-line[data-id="${tId}"]`).forEach(el => el.classList.add('latest-active'));
        });

        // Hover cross-highlight across dual split-feeds
        line.addEventListener('mouseenter', () => {
            line.classList.add('highlight-match');
            targetIds.forEach(tId => {
                shadowRoot.querySelectorAll(`.kotoba-transcript-line[data-id="${tId}"]`).forEach(el => {
                    el.classList.add('highlight-match');
                    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                });
            });
        });
        line.addEventListener('mouseleave', () => {
            line.classList.remove('highlight-match');
            targetIds.forEach(tId => {
                shadowRoot.querySelectorAll(`.kotoba-transcript-line[data-id="${tId}"]`).forEach(el => el.classList.remove('highlight-match'));
            });
        });

        if (translationFeed) translationFeed.appendChild(line);
        if (translationBadge) translationBadge.textContent = `${translationItems.length} lines`;
        if (translationScroll) translationScroll.scrollTop = translationScroll.scrollHeight;
    }

    // =========================================================================
    // Capture Control & Summary Updates
    // =========================================================================

    function setCaptureState(active) {
        isCapturing = active;
        if (translationToggle) {
            translationToggle.disabled = active;
        }
        if (active) {
            isTabAuthorized = true;
            toggleBtn.className = 'kotoba-btn kotoba-btn-danger';
            toggleBtnIcon.textContent = '■';
            toggleBtnLabel.textContent = 'Stop Capture';
            if (triggerBtn) triggerBtn.classList.add('recording');
        } else {
            if (triggerBtn) triggerBtn.classList.remove('recording');
            setTabAuthorized(isTabAuthorized);
        }
    }

    async function startCapture() {
        if (isBusy) return;
        isBusy = true;
        try {
            const meta = extractYouTubeMetadata();
            const selectedLang = langSelect ? langSelect.value : (localStorage.getItem('kotoba_selected_lang') || 'ja');
            const isTranslationEnabled = translationToggle ? translationToggle.checked : false;
            chrome.runtime.sendMessage({
                action: 'startTabCapture',
                lang: selectedLang,
                model: 'nova-3',
                title: meta.title,
                channel: resolvedVtuberName || meta.channel,
                channelLink: meta.channelLink || '',
                videoId: currentVideoId || getVideoIdFromUrl(window.location.href),
                translate: isTranslationEnabled
            }, (res) => {
                isBusy = false;
                if (!res || !res.success) {
                    showToast('Capture error: ' + (res?.error || 'Failed to start capture'));
                    setCaptureState(false);
                } else {
                    setCaptureState(true);
                    showToast('Live tab capture active');
                }
            });
        } catch (err) {
            isBusy = false;
            showToast('Capture error: ' + err.message);
            setCaptureState(false);
        }
    }

    function stopCapture() {
        isBusy = false;
        setCaptureState(false);
        if (liveBubble) liveBubble.style.display = 'none';
        chrome.runtime.sendMessage({ action: 'stopTabCapture' }, () => {});
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

    // =========================================================================
    // Video State Persistence & Restoration
    // =========================================================================

    function persistVideoStateDebounced() {
        if (!currentVideoId) return;
        clearTimeout(saveStateTimeout);
        saveStateTimeout = setTimeout(() => {
            if (!currentVideoId) return;
            chrome.storage.local.set({
                [`kotoba_state_${currentVideoId}`]: {
                    videoId: currentVideoId,
                    metadata: extractYouTubeMetadata(),
                    transcriptItems: transcriptItems.slice(-300),
                    translationItems: translationItems.slice(-300),
                    activeRelevantComment,
                    consecutiveNegativeCount,
                    summary: currentSummary,
                    updatedAt: Date.now()
                },
                kotoba_active_video_id: currentVideoId
            });
        }, 400);
    }

    function renderFullFeedFromState() {
        if (!shadowRoot) createKotobaOverlayDOM();
        if (transcriptsFeed) transcriptsFeed.innerHTML = '';
        if (translationFeed) translationFeed.innerHTML = '';

        if (transcriptItems.length > 0) {
            if (transcriptsEmpty) transcriptsEmpty.style.display = 'none';
            transcriptItems.forEach(item => appendTranscriptLine(item));
            if (transcriptsBadge) transcriptsBadge.textContent = `${transcriptItems.length} lines`;
            if (transcriptsScroll) transcriptsScroll.scrollTop = transcriptsScroll.scrollHeight;
        } else {
            if (transcriptsEmpty) transcriptsEmpty.style.display = 'block';
            if (transcriptsBadge) transcriptsBadge.textContent = '0 lines';
        }

        if (translationItems.length > 0) {
            if (translationEmpty) translationEmpty.style.display = 'none';
            translationItems.forEach(item => appendTranslationLine(item));
            if (translationBadge) translationBadge.textContent = `${translationItems.length} lines`;
            if (translationScroll) translationScroll.scrollTop = translationScroll.scrollHeight;
        } else {
            if (translationEmpty) {
                translationEmpty.textContent = translationToggle && translationToggle.checked ? 'Translations will appear here.' : 'Translations are turned off';
                translationEmpty.style.display = 'block';
            }
            if (translationBadge) translationBadge.textContent = '0 lines';
        }

        renderRelevantComment(activeRelevantComment);
        scrollToBottomFeeds();
    }

    function handleVideoChange(newVideoId) {
        if (!newVideoId) return;
        if (isCapturing) stopCapture();

        chrome.storage.local.get([`kotoba_state_${newVideoId}`], (result) => {
            const saved = result[`kotoba_state_${newVideoId}`];

            if (saved && Array.isArray(saved.transcriptItems) && saved.transcriptItems.length > 0) {
                transcriptItems = saved.transcriptItems || [];
                translationItems = saved.translationItems || [];
                activeRelevantComment = saved.activeRelevantComment || null;
                consecutiveNegativeCount = saved.consecutiveNegativeCount || 0;
                updateSummaryUI(saved.summary || '');
                renderFullFeedFromState();
            } else {
                transcriptItems = [];
                translationItems = [];
                activeRelevantComment = null;
                consecutiveNegativeCount = 0;
                liveChatMessages = [];
                updateSummaryUI('');
                if (transcriptsFeed) transcriptsFeed.innerHTML = '';
                if (translationFeed) translationFeed.innerHTML = '';
                if (transcriptsEmpty) transcriptsEmpty.style.display = 'block';
                if (translationEmpty) {
                    translationEmpty.textContent = translationToggle && translationToggle.checked ? 'Translations will appear here.' : 'Translations are turned off';
                    translationEmpty.style.display = 'block';
                }
                if (transcriptsBadge) transcriptsBadge.textContent = '0 lines';
                if (translationBadge) translationBadge.textContent = '0 lines';
                if (liveBubble) liveBubble.style.display = 'none';
                if (bubbleQueue) bubbleQueue.innerHTML = '';
                renderRelevantComment(null);
                persistVideoStateDebounced();
            }

            scheduleMetadataUpdates();
            chrome.storage.local.set({ kotoba_active_video_id: newVideoId });
        });
    }

    // =========================================================================
    // Navigation & Page URL Watchers
    // =========================================================================

    let lastUrl = window.location.href;

    function checkPageUrl() {
        const onWatch = isWatchPage();
        const vId = getVideoIdFromUrl(window.location.href);

        if (onWatch && vId) {
            if (!shadowRoot) createKotobaOverlayDOM();
            if (triggerBtn) triggerBtn.style.display = 'flex';

            if (vId !== currentVideoId) {
                stopCapture();
                currentVideoId = vId;
                handleVideoChange(vId);
            } else {
                scheduleMetadataUpdates();
                persistVideoStateDebounced();
            }
        } else {
            if (triggerBtn) triggerBtn.style.display = 'none';
            if (overlayPanel) {
                overlayPanel.style.display = 'none';
                isOverlayOpen = false;
            }
            if (isCapturing) stopCapture();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            checkPageUrl();
            observeYouTubeMetadata();
        });
    } else {
        checkPageUrl();
        observeYouTubeMetadata();
    }

    document.addEventListener('yt-navigate-start', () => stopCapture());
    document.addEventListener('yt-navigate-finish', () => {
        setTimeout(checkPageUrl, 80);
        scheduleMetadataUpdates();
        observeYouTubeMetadata();
    });
    window.addEventListener('popstate', () => {
        setTimeout(checkPageUrl, 80);
        scheduleMetadataUpdates();
        observeYouTubeMetadata();
    });
    window.addEventListener('beforeunload', () => stopCapture());
    window.addEventListener('pagehide', () => stopCapture());

    setInterval(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            checkPageUrl();
            observeYouTubeMetadata();
        }
    }, 250);

    // =========================================================================
    // Runtime Message Listener
    // =========================================================================

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'toggleOverlay') {
            if (isWatchPage()) {
                if (!shadowRoot) createKotobaOverlayDOM();
                if (message.authorized) setTabAuthorized(true);
                toggleOverlay();
                sendResponse({ status: 'ok' });
            } else {
                sendResponse({ status: 'not_watch_page' });
            }
            return;
        }

        if (message.type === 'transcript') {
            if (!shadowRoot) createKotobaOverlayDOM();
            if (message.is_final) {
                if (liveBubble) {
                    liveBubble.style.display = 'none';
                    if (liveText) liveText.textContent = '';
                }
                const item = {
                    id: message.id || `utt_${Date.now()}`,
                    text: message.transcript,
                    time: message.time || new Date().toLocaleTimeString()
                };
                transcriptItems.push(item);
                appendTranscriptLine(item);
                persistVideoStateDebounced();
            } else {
                if (transcriptsEmpty) transcriptsEmpty.style.display = 'none';
                if (liveBubble) {
                    liveBubble.style.display = 'flex';
                    if (liveText) liveText.textContent = message.transcript;
                    if (transcriptsScroll) transcriptsScroll.scrollTop = transcriptsScroll.scrollHeight;
                }
            }
        } else if (message.type === 'translation') {
            if (!shadowRoot) createKotobaOverlayDOM();
            const batchItem = {
                id: message.id || `trans_${Date.now()}`,
                ids: message.ids || (message.id ? [message.id] : []),
                original: message.original,
                translation: message.translation,
                sentences: message.sentences || 1,
                time: message.time || new Date().toLocaleTimeString()
            };
            translationItems.push(batchItem);
            appendTranslationLine(batchItem);
            if (message.summary) {
                updateSummaryUI(message.summary);
            }
            persistVideoStateDebounced();

            // Relevant comment attribution
            const relIdx = message.relevant_comment_index !== undefined ? message.relevant_comment_index : 0;
            if (relIdx <= 0) {
                consecutiveNegativeCount++;
                if (consecutiveNegativeCount > 5) {
                    activeRelevantComment = null;
                    renderRelevantComment(null);
                    persistVideoStateDebounced();
                }
            } else if (message.relevant_comment && message.relevant_comment.id) {
                consecutiveNegativeCount = 0;
                if (!activeRelevantComment || activeRelevantComment.id !== message.relevant_comment.id) {
                    activeRelevantComment = message.relevant_comment;
                    renderRelevantComment(message.relevant_comment);
                    persistVideoStateDebounced();
                }
            }
        } else if (message.type === 'live_chat_event') {
            if (message.batch && Array.isArray(message.batch)) {
                message.batch.forEach(item => {
                    liveChatMessages.push(item);
                    addChatBubbleToQueue(item);
                });
                if (liveChatMessages.length > 50) liveChatMessages = liveChatMessages.slice(-50);
            } else if (message.data) {
                liveChatMessages.push(message.data);
                addChatBubbleToQueue(message.data);
                if (liveChatMessages.length > 50) liveChatMessages.shift();
            }
        } else if (message.type === 'capture_status') {
            if (!shadowRoot) createKotobaOverlayDOM();
            setCaptureState(message.status === 'started');
        } else if (message.type === 'error') {
            showToast('Error: ' + message.message);
            setCaptureState(false);
        }
    });

    setupTopFrameChatObserver();
})();

// =============================================================================
// Live Chat DOM Scrapers (Iframe & Top Frame)
// =============================================================================

function parseSingleChatMessage(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    if (node.hasAttribute('data-kotoba-seen')) return null;

    const tag = (node.tagName || '').toLowerCase();
    const isMatch = tag.includes('chat-text-message') ||
                    tag.includes('chat-paid-message') ||
                    tag.includes('chat-membership') ||
                    tag.includes('chat-paid-sticker') ||
                    tag.includes('chat-ticker-paid-message');

    if (!isMatch && !node.querySelector('#message')) return null;

    const target = isMatch
        ? node
        : (node.closest('yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer') || node);
    target.setAttribute('data-kotoba-seen', 'true');

    const authorEl = target.querySelector('#author-name');
    const msgEl = target.querySelector('#message') || target.querySelector('#contents');
    const timeEl = target.querySelector('#timestamp');
    if (!msgEl) return null;

    let text = '';
    msgEl.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
            text += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            text += (child.tagName.toLowerCase() === 'img' && child.alt) ? child.alt : child.textContent;
        }
    });
    text = text.trim();
    if (!text) return null;

    const rawAuthor = authorEl ? authorEl.textContent.trim() : 'Viewer';
    const cleanAuthor = rawAuthor.replace(/^@+/, '').trim() || 'Viewer';

    return {
        id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        author: cleanAuthor,
        message: text,
        time: timeEl ? timeEl.textContent.trim() : new Date().toLocaleTimeString()
    };
}

function scanAndSendChatBatch(root) {
    if (!root) return;
    const nodes = root.querySelectorAll(
        'yt-live-chat-text-message-renderer:not([data-kotoba-seen]), ' +
        'yt-live-chat-paid-message-renderer:not([data-kotoba-seen]), ' +
        'yt-live-chat-membership-item-renderer:not([data-kotoba-seen]), ' +
        'yt-live-chat-paid-sticker-renderer:not([data-kotoba-seen])'
    );
    if (nodes.length === 0) return;

    const collected = [];
    nodes.forEach(node => {
        const item = parseSingleChatMessage(node);
        if (item) collected.push(item);
    });

    if (collected.length > 0) {
        const msg = collected.length === 1
            ? { action: 'liveChatCollected', data: collected[0] }
            : { action: 'liveChatCollected', batch: collected };
        chrome.runtime.sendMessage(msg).catch(() => {});
    }
}

function initIframeLiveChatScraper() {
    const observer = new MutationObserver(() => scanAndSendChatBatch(document));
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    setInterval(() => scanAndSendChatBatch(document), 400);
    scanAndSendChatBatch(document);
}

function setupTopFrameChatObserver() {
    setInterval(() => {
        try {
            const iframe = document.querySelector('iframe#chatframe') ||
                           document.querySelector('ytd-live-chat-frame iframe') ||
                           document.querySelector('iframe[src*="live_chat"]');
            if (iframe && iframe.contentDocument) scanAndSendChatBatch(iframe.contentDocument);
        } catch (e) {}
    }, 400);
}
