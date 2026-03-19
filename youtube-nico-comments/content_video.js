// YouTube Nico Nico Comments
// Live streams  → hidden iframe + MutationObserver (content_chat.js / background.js relay)
// Past streams  → fetch chat replay data directly via API, display by video time
// Regular vids  → nothing (no chat data available)

let overlayContainer = null;
const seenMessageIds = new Set();

// ──────────────────────────────────────
//  Overlay
// ──────────────────────────────────────

function getOverlayContainer() {
  if (overlayContainer && document.body.contains(overlayContainer)) {
    return overlayContainer;
  }
  const videoPlayer = document.querySelector('.html5-video-player');
  if (!videoPlayer) return null;

  overlayContainer = document.createElement('div');
  overlayContainer.id = 'nico-nico-overlay';
  videoPlayer.appendChild(overlayContainer);
  return overlayContainer;
}

function showComment(text, overrideColor, isMember) {
  const container = getOverlayContainer();
  if (!container) return;

  const span = document.createElement('span');
  span.className = 'nico-comment';

  if (overrideColor) {
    span.style.color = overrideColor;
  } else if (isMember) {
    span.classList.add('member-comment');
  }

  span.textContent = text;

  const h = container.clientHeight;
  const fontSize = Math.max(16, h * 0.05);
  const factor = Math.min(1, 50 / Math.max(text.length, 1));
  span.style.fontSize = `${fontSize * factor}px`;
  span.style.top = `${2 + Math.random() * 83}%`;

  const dur = 5 + Math.random() * 2;
  span.style.animationDuration = `${dur}s`;

  container.appendChild(span);
  setTimeout(() => { if (span.parentNode) span.remove(); }, dur * 1000 + 100);
}

// ──────────────────────────────────────
//  Live-stream detection
// ──────────────────────────────────────

function isLiveStream() {
  return !!document.querySelector('.ytp-live');
}

// ──────────────────────────────────────
//  LIVE PATH — hidden iframe
// ──────────────────────────────────────

let hiddenChatIframe = null;

function injectLiveChatIframe(videoId) {
  removeLiveChatIframe();
  seenMessageIds.clear();

  hiddenChatIframe = document.createElement('iframe');
  hiddenChatIframe.src = `https://www.youtube.com/live_chat?v=${videoId}&is_popout=1`;
  hiddenChatIframe.style.display = 'none';
  document.body.appendChild(hiddenChatIframe);
}

function removeLiveChatIframe() {
  if (hiddenChatIframe) {
    hiddenChatIframe.remove();
    hiddenChatIframe = null;
  }
}

// Messages arrive via: content_chat.js → background.js → here
chrome.runtime.onMessage.addListener((request) => {
  if (request.type === 'NEW_CHAT_MESSAGE') {
    if (request.id) {
      if (seenMessageIds.has(request.id)) return;
      seenMessageIds.add(request.id);
      if (seenMessageIds.size > 5000) seenMessageIds.clear();
    }
    showComment(request.message, request.overrideColor, request.isMember);
  }
});

// ──────────────────────────────────────
//  VOD PATH — direct API fetch
// ──────────────────────────────────────

let replayMessages = [];     // { text, offsetMs, id, isMember, overrideColor }
let replayDisplayIndex = 0;
let replayInterval = null;
let replayNextCont = null;
let replayLoading = false;
let replayDone = false;

/**
 * Safely extract a JSON object from raw HTML given a leading marker string.
 * Uses brace-counting so nested objects / strings don't break the parse.
 */
function extractJSON(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = idx + marker.length;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.substring(start, i + 1)); }
          catch { return null; }
        }
      }
    }
  }
  return null;
}

/**
 * Parse a batch of replay actions from the API response (or initial page data).
 * Returns { messages[], continuation } where continuation is the next-page token.
 */
function parseReplayActions(data) {
  const messages = [];
  let continuation = null;

  const chat = data?.continuationContents?.liveChatContinuation
            || data?.contents?.liveChatRenderer;
  if (!chat) return { messages, continuation };

  // Next-page token
  for (const c of (chat.continuations || [])) {
    const tok = c?.liveChatReplayContinuationData?.continuation
             || c?.playerSeekContinuationData?.continuation;
    if (tok) { continuation = tok; break; }
  }

  // Messages
  for (const action of (chat.actions || [])) {
    const replay = action?.replayChatItemAction;
    if (!replay) continue;

    const offsetMs = parseInt(replay.videoOffsetTimeMsec, 10);
    if (isNaN(offsetMs)) continue;

    for (const sub of (replay.actions || [])) {
      const item = sub?.addChatItemAction?.item;
      if (!item) continue;

      const renderer = item.liveChatTextMessageRenderer
                    || item.liveChatPaidMessageRenderer;
      if (!renderer?.message?.runs) continue;

      const text = renderer.message.runs
        .map(r => r.text || r.emoji?.shortcuts?.[0] || r.emoji?.emojiId || '')
        .join('').trim();
      if (!text) continue;

      const id = renderer.id || '';
      const isMember = !!(renderer.authorBadges || []).find(b =>
        b?.liveChatAuthorBadgeRenderer?.customThumbnail);

      let overrideColor = null;
      if (item.liveChatPaidMessageRenderer) {
        const bgInt = item.liveChatPaidMessageRenderer.bodyBackgroundColor
                   || item.liveChatPaidMessageRenderer.headerBackgroundColor;
        if (bgInt) {
          const hex = (bgInt >>> 0).toString(16).padStart(8, '0');
          overrideColor = '#' + hex.slice(2); // drop alpha
        }
      }

      messages.push({ text, offsetMs, id, isMember, overrideColor });
    }
  }
  return { messages, continuation };
}

/** Fetch the next page of replay messages using a continuation token. */
async function fetchReplayPage(token) {
  try {
    const resp = await fetch(
      'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay?prettyPrint=false',
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: '2.20260101.00.00' } },
          continuation: token,
        }),
      }
    );
    if (!resp.ok) return { messages: [], continuation: null };
    return parseReplayActions(await resp.json());
  } catch (e) {
    console.error('[NicoComments] fetchReplayPage error:', e);
    return { messages: [], continuation: null };
  }
}

/** Load the initial batch of replay messages for a video. */
async function loadReplayMessages(videoId) {
  replayMessages = [];
  replayDisplayIndex = 0;
  replayNextCont = null;
  replayDone = false;

  try {
    // 1. Fetch the watch page to get ytInitialData securely
    const html = await (await fetch(
      `https://www.youtube.com/watch?v=${videoId}`,
      { credentials: 'same-origin' }
    )).text();

    const data = extractJSON(html, 'var ytInitialData = ');
    if (!data) {
      console.log('[NicoComments] No ytInitialData found');
      return;
    }

    // 2. Find the live chat replay continuation token
    let token = null;
    
    const convBar = data?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
    if (convBar?.continuations?.[0]) {
      const c = convBar.continuations[0];
      token = c?.reloadContinuationData?.continuation || c?.liveChatReplayContinuationData?.continuation;
    }

    if (!token && data.engagementPanels) {
      for (const panel of data.engagementPanels) {
        const cr = panel?.engagementPanelSectionListRenderer?.content?.liveChatRenderer;
        if (cr && cr.continuations?.[0]) {
          const c = cr.continuations[0];
          token = c?.reloadContinuationData?.continuation || c?.liveChatReplayContinuationData?.continuation;
          if (token) break;
        }
      }
    }

    if (!token) {
      console.log('[NicoComments] No replay data for this video (probably not a past stream)');
      return;
    }

    // 3. Fetch first page of replay actions
    const first = await fetchReplayPage(token);
    replayMessages = first.messages;
    replayNextCont = first.continuation;

    // 4. Pre-fetch a few more pages so we have a comfortable buffer
    for (let i = 0; i < 5 && replayNextCont; i++) {
      const page = await fetchReplayPage(replayNextCont);
      replayMessages.push(...page.messages);
      replayNextCont = page.continuation;
      if (!page.continuation) { replayDone = true; break; }
    }

    // 5. Sort by time offset and start display
    replayMessages.sort((a, b) => a.offsetMs - b.offsetMs);
    console.log(`[NicoComments] Loaded ${replayMessages.length} replay messages`);

    startReplayDisplay();
  } catch (e) {
    console.error('[NicoComments] loadReplayMessages error:', e);
  }
}

/** Fetch more messages when the buffer is running low. */
async function prefetchIfNeeded(currentTimeMs) {
  if (replayDone || replayLoading || !replayNextCont) return;
  const last = replayMessages[replayMessages.length - 1];
  if (!last || (last.offsetMs - currentTimeMs) < 30000) {
    replayLoading = true;
    try {
      for (let i = 0; i < 3 && replayNextCont; i++) {
        const page = await fetchReplayPage(replayNextCont);
        replayMessages.push(...page.messages);
        replayNextCont = page.continuation;
        if (!page.continuation) { replayDone = true; break; }
      }
      replayMessages.sort((a, b) => a.offsetMs - b.offsetMs);
    } catch (e) {
      console.error('[NicoComments] prefetch error:', e);
    }
    replayLoading = false;
  }
}

/** Binary search for the first message at or after targetMs. */
function bisect(arr, targetMs) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].offsetMs < targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function startReplayDisplay() {
  stopReplayDisplay();

  let lastCheckedTime = -1;

  replayInterval = setInterval(() => {
    const video = document.querySelector('.html5-main-video');
    if (!video || video.paused) return;

    const now = video.currentTime * 1000;

    // Detect seeks: if playback jumped by more than 3 s, re-sync the index
    if (lastCheckedTime >= 0 && Math.abs(now - lastCheckedTime) > 3000) {
      replayDisplayIndex = bisect(replayMessages, now);
    }
    lastCheckedTime = now;

    // Show every message whose offset is ≤ current time
    while (replayDisplayIndex < replayMessages.length) {
      const msg = replayMessages[replayDisplayIndex];
      if (msg.offsetMs > now) break;

      // Only display if it's within 2 s of "now" (skip stale ones after seek)
      if (now - msg.offsetMs < 2000) {
        showComment(msg.text, msg.overrideColor, msg.isMember);
      }
      replayDisplayIndex++;
    }

    prefetchIfNeeded(now);
  }, 250);
}

function stopReplayDisplay() {
  if (replayInterval) {
    clearInterval(replayInterval);
    replayInterval = null;
  }
}

// ──────────────────────────────────────
//  Router — detect video changes
// ──────────────────────────────────────

let currentVideoId = null;

function checkVideo() {
  if (window.location.pathname !== '/watch') {
    cleanup();
    return;
  }

  const vid = new URLSearchParams(window.location.search).get('v');
  if (!vid || vid === currentVideoId) return;

  currentVideoId = vid;
  cleanup();

  // Wait for the player UI to settle (the LIVE badge needs time to render)
  setTimeout(() => {
    if (isLiveStream()) {
      injectLiveChatIframe(vid);
    } else {
      loadReplayMessages(vid);
    }
  }, 1500);
}

function cleanup() {
  removeLiveChatIframe();
  stopReplayDisplay();
  seenMessageIds.clear();
  replayMessages = [];
  replayDisplayIndex = 0;
}

// YouTube SPA navigation + polling fallback
document.addEventListener('yt-navigate-finish', () => {
  currentVideoId = null; // force re-check on SPA nav
  setTimeout(checkVideo, 1000);
});
setInterval(checkVideo, 3000);
checkVideo();
