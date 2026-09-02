// Project KOTOBA - YouTube In-Page Floating Overlay

(function () {
    const isTopFrame = window.top === window.self;
    const isChatFrame = window.location.pathname.startsWith('/live_chat') ||
                        window.location.pathname.startsWith('/live_chat_replay') ||
                        window.location.href.includes('live_chat');

    if (!isTopFrame) {
        if (isChatFrame) initIframeLiveChatScraper();
        return;
    }

    if (window.__kotobaInitialized) return;
    window.__kotobaInitialized = true;

    // ==================== State ====================

    let shadowRoot = null;
    let triggerBtn = null, triggerLabel = null, overlayPanel = null, triggerPulse = null, toastEl = null;
    let statusBadge = null, channelNameEl = null, videoTitleEl = null;
    let toggleBtn = null, toggleBtnLabel = null, toggleBtnIcon = null;
    let clearBtn = null, copyTranscriptsBtn = null, copyTranslationBtn = null, closeBtn = null;
    let transcriptsFeed = null, translationFeed = null;
    let transcriptsScroll = null, translationScroll = null;
    let transcriptsEmpty = null, translationEmpty = null;
    let transcriptsBadge = null, translationBadge = null;
    let liveBubble = null, liveText = null, bubbleQueue = null;
    let relevantChatSlot = null, relevantChatAuthor = null, relevantChatMsg = null;
    let relevantChatTime = null, relevantChatTooltip = null;

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

    // ==================== Utilities ====================

    function isWatchPage() {
        const p = window.location.pathname, s = window.location.search;
        return p === '/watch' || p.startsWith('/live') || p.startsWith('/shorts') || s.includes('v=');
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
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
        } catch (e) { return null; }
    }

    function showToast(text) {
        if (!toastEl) return;
        toastEl.textContent = text;
        toastEl.classList.add('show');
        setTimeout(() => toastEl.classList.remove('show'), 2500);
    }

    // ==================== Metadata ====================

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
                channel = cleanChannelName(channelEl.textContent);
            }
            if (!channel) {
                const ma = document.querySelector('link[itemprop="name"]');
                if (ma && ma.getAttribute('content')) { channel = cleanChannelName(ma.getAttribute('content')); }
                else {
                    const mn = document.querySelector('meta[name="author"], meta[property="og:video:actor"]');
                    if (mn) channel = cleanChannelName(mn.content || mn.getAttribute('content') || '');
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
            };
        } catch (e) {
            return { status: 'PLAYBACK', title: document.title.replace(/\s*-\s*YouTube$/, '').trim() || 'YouTube Video', channel: 'YouTube Channel' };
        }
    }

    function updateMetadataUI() {
        if (!statusBadge || !channelNameEl || !videoTitleEl) return;
        const meta = extractYouTubeMetadata();
        statusBadge.className = meta.status === 'LIVE' ? 'kotoba-badge-status live' : 'kotoba-badge-status playback';
        statusBadge.textContent = meta.status;
        channelNameEl.textContent = meta.channel || 'YouTube Channel';
        videoTitleEl.textContent = meta.title || 'YouTube Stream';
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

    // ==================== DOM Construction ====================

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
            <button id="kotoba-trigger-btn" class="unauthorized" title="Press Alt+K to authorize &amp; open KOTOBA">
                <span class="kotoba-btn-pulse" id="kotoba-trigger-pulse"></span>
                <span id="kotoba-trigger-label">Press Alt+K to open KOTOBA</span>
            </button>
            <div id="kotoba-overlay-panel">
                <div class="kotoba-bubble-queue" id="kotoba-bubble-queue"></div>
                <div class="kotoba-toast" id="kotoba-toast">Notice</div>
                <div class="kotoba-header">
                    <div class="kotoba-header-left">
                        <div class="kotoba-logo-title">KOTOBA</div>
                        <div class="kotoba-header-info">
                            <div class="kotoba-header-top-row">
                                <span class="kotoba-badge-status playback" id="kotoba-badge-status">PLAYBACK</span>
                                <span class="kotoba-channel-name" id="kotoba-channel-name">Channel Name</span>
                            </div>
                            <div class="kotoba-video-title" id="kotoba-video-title">Stream / Video Title</div>
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
                    </div>
                    <div class="kotoba-controls-right">
                        <button class="kotoba-subtle-btn" id="kotoba-copy-transcripts" title="Copy Japanese Transcripts">Copy JA</button>
                        <button class="kotoba-subtle-btn" id="kotoba-copy-translation" title="Copy English Translations">Copy EN</button>
                        <button class="kotoba-subtle-btn" id="kotoba-clear-btn" title="Clear Feed">Clear</button>
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
                        <div class="kotoba-pane-header"><span>Live Transcription (JA)</span><span class="kotoba-pane-badge" id="kotoba-transcripts-badge">0 lines</span></div>
                        <div class="kotoba-feed-scroll" id="kotoba-transcripts-scroll">
                            <div class="kotoba-empty-state" id="kotoba-transcripts-empty">Ready. Press Start Capture to transcribe speech.</div>
                            <div class="kotoba-feed-list" id="kotoba-transcripts-feed"></div>
                            <div class="kotoba-interim-bubble" id="kotoba-live-bubble"><span>●</span><span id="kotoba-live-text"></span></div>
                        </div>
                    </div>
                    <div class="kotoba-pane">
                        <div class="kotoba-pane-header"><span>Live Translation (EN)</span><span class="kotoba-pane-badge" id="kotoba-translation-badge">0 lines</span></div>
                        <div class="kotoba-feed-scroll" id="kotoba-translation-scroll">
                            <div class="kotoba-empty-state" id="kotoba-translation-empty">Translations (2-sentence batches) will appear here.</div>
                            <div class="kotoba-feed-list" id="kotoba-translation-feed"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        shadowRoot.appendChild(wrapper);

        // Bind elements
        triggerBtn = shadowRoot.getElementById('kotoba-trigger-btn');
        triggerLabel = shadowRoot.getElementById('kotoba-trigger-label');
        overlayPanel = shadowRoot.getElementById('kotoba-overlay-panel');
        triggerPulse = shadowRoot.getElementById('kotoba-trigger-pulse');
        toastEl = shadowRoot.getElementById('kotoba-toast');
        statusBadge = shadowRoot.getElementById('kotoba-badge-status');
        channelNameEl = shadowRoot.getElementById('kotoba-channel-name');
        videoTitleEl = shadowRoot.getElementById('kotoba-video-title');
        toggleBtn = shadowRoot.getElementById('kotoba-toggle-btn');
        toggleBtnLabel = shadowRoot.getElementById('kotoba-btn-label');
        toggleBtnIcon = shadowRoot.getElementById('kotoba-btn-icon');
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
        transcriptsBadge = shadowRoot.getElementById('kotoba-transcripts-badge');
        translationBadge = shadowRoot.getElementById('kotoba-translation-badge');
        liveBubble = shadowRoot.getElementById('kotoba-live-bubble');
        liveText = shadowRoot.getElementById('kotoba-live-text');
        relevantChatSlot = shadowRoot.getElementById('kotoba-relevant-chat-slot');
        relevantChatAuthor = shadowRoot.getElementById('kotoba-relevant-chat-author');
        relevantChatMsg = shadowRoot.getElementById('kotoba-relevant-chat-msg');
        relevantChatTime = shadowRoot.getElementById('kotoba-relevant-chat-time');
        relevantChatTooltip = shadowRoot.getElementById('kotoba-chat-tooltip');
        bubbleQueue = shadowRoot.getElementById('kotoba-bubble-queue');

        makeDraggable(shadowRoot.querySelector('.kotoba-header'), overlayPanel);
        attachEventListeners();
    }

    // ==================== UI Interaction ====================

    function makeDraggable(handle, panel) {
        if (!handle || !panel) return;
        let isDragging = false, startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('button') || e.target.closest('.kotoba-icon-btn')) return;
            isDragging = true;
            startX = e.clientX; startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            initialLeft = rect.left; initialTop = rect.top;
            panel.style.bottom = 'auto'; panel.style.right = 'auto';
            panel.style.left = `${initialLeft}px`; panel.style.top = `${initialTop}px`;
            document.body.style.userSelect = 'none'; handle.style.cursor = 'grabbing';

            const onMouseMove = (ev) => {
                if (!isDragging) return;
                let newLeft = initialLeft + ev.clientX - startX;
                let newTop = initialTop + ev.clientY - startY;
                newLeft = Math.min(Math.max(0, newLeft), Math.max(0, window.innerWidth - panel.offsetWidth));
                newTop = Math.min(Math.max(0, newTop), Math.max(0, window.innerHeight - panel.offsetHeight));
                panel.style.left = `${newLeft}px`; panel.style.top = `${newTop}px`;
            };
            const onMouseUp = () => {
                isDragging = false; document.body.style.userSelect = ''; handle.style.cursor = 'grab';
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
                if (triggerLabel) triggerLabel.textContent = 'KOTOBA';
                triggerBtn.title = 'Open KOTOBA Live Translator';
            } else {
                triggerBtn.classList.add('unauthorized');
                if (triggerLabel) triggerLabel.textContent = 'Press Alt+K to open KOTOBA';
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
            if (!isTabAuthorized) { showToast('Press Alt+K (or click toolbar icon) to authorize & open KOTOBA'); return; }
            toggleOverlay();
        });
        closeBtn.addEventListener('click', () => toggleOverlay(false));
        toggleBtn.addEventListener('click', () => { isCapturing ? stopCapture() : startCapture(); });

        copyTranscriptsBtn.addEventListener('click', () => {
            if (transcriptItems.length === 0) { showToast('No transcripts to copy'); return; }
            navigator.clipboard.writeText(transcriptItems.map(t => `[${t.time}] ${t.text}`).join('\n')).then(() => showToast('Transcripts copied!'));
        });
        copyTranslationBtn.addEventListener('click', () => {
            if (translationItems.length === 0) { showToast('No translations to copy'); return; }
            navigator.clipboard.writeText(translationItems.map(t => `[${t.time}] ${t.translation}\n  ↳ Original: ${t.original}`).join('\n\n')).then(() => showToast('Translations copied!'));
        });
        clearBtn.addEventListener('click', () => {
            transcriptItems = []; translationItems = [];
            transcriptsFeed.innerHTML = ''; translationFeed.innerHTML = '';
            transcriptsEmpty.style.display = 'block'; translationEmpty.style.display = 'block';
            transcriptsBadge.textContent = '0 lines'; translationBadge.textContent = '0 lines';
            liveBubble.style.display = 'none';
            activeRelevantComment = null; consecutiveNegativeCount = 0;
            renderRelevantComment(null);
            if (bubbleQueue) bubbleQueue.innerHTML = '';
            showToast('Feed cleared');
        });
    }

    // ==================== Feed Rendering ====================

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

        while (bubbleQueue.children.length > 5) bubbleQueue.lastElementChild.remove();

        setTimeout(() => {
            if (bubble.parentNode) {
                bubble.style.opacity = '0'; bubble.style.transform = 'translateY(-4px)';
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
            if (relevantChatTooltip) { relevantChatTooltip.textContent = ''; relevantChatTooltip.classList.remove('has-original'); }
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

        // Hover cross-highlight (yellow text only, preserves border & weight)
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

    // ==================== Capture Control ====================

    function setCaptureState(active) {
        isCapturing = active;
        if (active) {
            isTabAuthorized = true;
            toggleBtn.className = 'kotoba-btn kotoba-btn-danger';
            toggleBtnIcon.textContent = '■';
            toggleBtnLabel.textContent = 'Stop Capture';
            triggerPulse.classList.add('recording');
        } else {
            triggerPulse.classList.remove('recording');
            setTabAuthorized(isTabAuthorized);
        }
    }

    async function startCapture() {
        if (isBusy) return;
        isBusy = true;
        try {
            const meta = extractYouTubeMetadata();
            chrome.runtime.sendMessage({
                action: 'startTabCapture', lang: 'ja', model: 'nova-3',
                title: meta.title, channel: meta.channel,
                videoId: currentVideoId || getVideoIdFromUrl(window.location.href)
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

    // ==================== State Persistence ====================

    function persistVideoStateDebounced() {
        if (!currentVideoId) return;
        clearTimeout(saveStateTimeout);
        saveStateTimeout = setTimeout(() => {
            if (!currentVideoId) return;
            chrome.storage.local.set({
                [`kotoba_state_${currentVideoId}`]: {
                    videoId: currentVideoId, metadata: extractYouTubeMetadata(),
                    transcriptItems: transcriptItems.slice(-300), translationItems: translationItems.slice(-300),
                    activeRelevantComment, consecutiveNegativeCount, updatedAt: Date.now()
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
            if (translationEmpty) translationEmpty.style.display = 'block';
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
                renderFullFeedFromState();
            } else {
                transcriptItems = []; translationItems = [];
                activeRelevantComment = null; consecutiveNegativeCount = 0; liveChatMessages = [];
                if (transcriptsFeed) transcriptsFeed.innerHTML = '';
                if (translationFeed) translationFeed.innerHTML = '';
                if (transcriptsEmpty) transcriptsEmpty.style.display = 'block';
                if (translationEmpty) translationEmpty.style.display = 'block';
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

    // ==================== Navigation Watchers ====================

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
            if (overlayPanel) { overlayPanel.style.display = 'none'; isOverlayOpen = false; }
            if (isCapturing) stopCapture();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { checkPageUrl(); observeYouTubeMetadata(); });
    } else {
        checkPageUrl();
        observeYouTubeMetadata();
    }

    document.addEventListener('yt-navigate-start', () => stopCapture());
    document.addEventListener('yt-navigate-finish', () => { setTimeout(checkPageUrl, 80); scheduleMetadataUpdates(); observeYouTubeMetadata(); });
    window.addEventListener('popstate', () => { setTimeout(checkPageUrl, 80); scheduleMetadataUpdates(); observeYouTubeMetadata(); });
    window.addEventListener('beforeunload', () => stopCapture());
    window.addEventListener('pagehide', () => stopCapture());

    setInterval(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            checkPageUrl();
            observeYouTubeMetadata();
        }
    }, 250);

    // ==================== Message Listener ====================

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
                if (liveBubble) { liveBubble.style.display = 'none'; if (liveText) liveText.textContent = ''; }
                const item = { id: message.id || `utt_${Date.now()}`, text: message.transcript, time: message.time || new Date().toLocaleTimeString() };
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
                original: message.original, translation: message.translation,
                sentences: message.sentences || 1,
                time: message.time || new Date().toLocaleTimeString()
            };
            translationItems.push(batchItem);
            appendTranslationLine(batchItem);
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
                message.batch.forEach(item => { liveChatMessages.push(item); addChatBubbleToQueue(item); });
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

// ==================== Live Chat Scraper ====================

function parseSingleChatMessage(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    if (node.hasAttribute('data-kotoba-seen')) return null;

    const tag = (node.tagName || '').toLowerCase();
    const isMatch = tag.includes('chat-text-message') || tag.includes('chat-paid-message') ||
                    tag.includes('chat-membership') || tag.includes('chat-paid-sticker') ||
                    tag.includes('chat-ticker-paid-message');

    if (!isMatch && !node.querySelector('#message')) return null;

    const target = isMatch ? node : (node.closest('yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer') || node);
    target.setAttribute('data-kotoba-seen', 'true');

    const authorEl = target.querySelector('#author-name');
    const msgEl = target.querySelector('#message') || target.querySelector('#contents');
    const timeEl = target.querySelector('#timestamp');
    if (!msgEl) return null;

    let text = '';
    msgEl.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
        else if (child.nodeType === Node.ELEMENT_NODE) text += (child.tagName.toLowerCase() === 'img' && child.alt) ? child.alt : child.textContent;
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
    nodes.forEach(node => { const item = parseSingleChatMessage(node); if (item) collected.push(item); });

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
