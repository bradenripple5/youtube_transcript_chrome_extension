// ======================================================
// Human-like click dispatcher to bypass YouTube protections
// ======================================================
function humanClick(target) {
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  for (const type of events) {
    const evt = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
    });
    target.dispatchEvent(evt);
  }
}


// Content script with auto-open + DOM/API scraping. Listener registered on load.
(function bootstrap() {
  if (window.__YT_TRANSCRIPT_HELPER_BOOTSTRAPPED__) return;
  window.__YT_TRANSCRIPT_HELPER_BOOTSTRAPPED__ = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function hhmmssToSeconds(hhmmss) {
    const parts = hhmmss.trim().split(':').map(Number);
    if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
    if (parts.length === 2) return parts[0]*60 + parts[1];
    return Number(parts[0]) || 0;
  }

  function formatTimestamp(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return [h,m,s].map(n=>String(n).padStart(2,'0')).join(':');
    return [m,s].map(n=>String(n).padStart(2,'0')).join(':');
  }

  function parseVtt(vtt, includeTimestamps) {
    const lines = vtt.split(/\r?\n/);
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line || /^WEBVTT/i.test(line) || /^Kind:/i.test(line) || /^Language:/i.test(line) || /^NOTE/i.test(line)) { i++; continue; }
      if (/^\d+$/.test(line)) { i++; continue; }
      if (line.includes('-->')) {
        const startRaw = line.split('-->')[0].trim().split('.')[0];
        const startSeconds = hhmmssToSeconds(startRaw);
        const ts = formatTimestamp(startSeconds);
        i++;
        const textParts = [];
        while (i < lines.length && lines[i].trim() !== '') {
          const t = lines[i].replace(/<\/.+?>|<.+?>/g, '').trim();
          if (t) textParts.push(t);
          i++;
        }
        const text = textParts.join(' ').trim();
        if (text) {
          if (includeTimestamps) { out.push(`[${ts}]`); out.push(text); }
          else { out.push(text); }
        }
      } else {
        i++;
      }
    }
    const dedup = [];
    for (const ln of out) if (!dedup.length || dedup[dedup.length - 1] !== ln) dedup.push(ln);
    return dedup.join('\n');
  }

  function getPlayerResponseCandidates() {
    const candidates = [];

    const pushCandidate = (value) => {
      if (value && typeof value === 'object') candidates.push(value);
    };

    pushCandidate(window.ytInitialPlayerResponse);

    try {
      const moviePlayer = document.getElementById('movie_player');
      if (moviePlayer?.getPlayerResponse) {
        pushCandidate(moviePlayer.getPlayerResponse());
      }
    } catch {}

    try {
      const ytdPlayer = document.querySelector('ytd-player');
      if (ytdPlayer?.player_?.getPlayerResponse) {
        pushCandidate(ytdPlayer.player_.getPlayerResponse());
      }
    } catch {}

    try {
      const watchFlexy = document.querySelector('ytd-watch-flexy');
      pushCandidate(watchFlexy?.playerData?.response);
    } catch {}

    try {
      const ytPlayerResponse = window.ytplayer?.config?.args?.player_response;
      if (typeof ytPlayerResponse === 'string') {
        pushCandidate(JSON.parse(ytPlayerResponse));
      }
    } catch {}

    return candidates;
  }

  function getCaptionTrackCandidates() {
    for (const pr of getPlayerResponseCandidates()) {
      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length) {
        return tracks;
      }
    }
    return [];
  }

  function isShortsPage() {
    return /\/shorts\//i.test(location.pathname || '');
  }

  async function getTranscriptFromCaptionsAPI(includeTimestamps) {
    try {
      const tracks = getCaptionTrackCandidates();
      for (const track of tracks) {
        const baseUrl = track?.baseUrl;
        if (!baseUrl) continue;
        const vttUrl = baseUrl.includes('fmt=') ? baseUrl : `${baseUrl}&fmt=vtt`;
        const res = await fetch(vttUrl, { credentials: 'same-origin' });
        if (!res.ok) continue;
        const vtt = await res.text();
        const parsed = parseVtt(vtt, includeTimestamps);
        if (parsed) return parsed;
      }
      return null;
    } catch { return null; }
  }

  function scrapeTranscriptFromDOM(includeTimestamps) {
    const segs = document.querySelectorAll(
      [
        'ytd-transcript-segment-renderer',
        'ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer',
        'ytd-transcript-search-panel-renderer ytd-transcript-segment-renderer',
        '[target-id="engagement-panel-searchable-transcript"] ytd-transcript-segment-renderer'
      ].join(', ')
    );
    if (segs && segs.length) {
      const out = [];
      segs.forEach(el => {
        const raw = el.innerText || el.textContent || '';
        const m = raw.match(/^(\d{1,2}:)?\d{1,2}:\d{2}/);
        const textOnly = raw.replace(/^(\d{1,2}:)?\d{1,2}:\d{2}\s*/,'').trim();
        if (textOnly) {
          if (includeTimestamps && m) {
            out.push(`[${m[0].length === 4 ? '00:' + m[0] : m[0]}]`);
            out.push(textOnly);
          } else {
            out.push(textOnly);
          }
        }
      });
      if (out.length) return out.join('\n');
    }

    const modernTranscriptContainers = document.querySelectorAll(
      [
        'ytd-item-section-renderer #contents',
        'ytd-engagement-panel-section-list-renderer #contents',
        '[target-id="engagement-panel-searchable-transcript"] #contents'
      ].join(', ')
    );
    if (modernTranscriptContainers && modernTranscriptContainers.length) {
      const out = [];
      const seen = new Set();

      const pushTranscriptBlock = (block) => {
        const normalized = block.trim().replace(/\s+/g, ' ');
        if (!normalized || seen.has(normalized)) return;

        const m = normalized.match(/(\d{1,2}:)?\d{1,2}:\d{2}/);
        if (!m) return;

        const timestamp = m[0];
        const textOnly = normalized.replace(/(\d{1,2}:)?\d{1,2}:\d{2}/, '').trim();
        if (!textOnly) return;

        // Skip chapter titles and other non-transcript panel items.
        if (/^chapter\s+\d+:/i.test(textOnly)) return;
        if (/^(chapters?|key moments?)$/i.test(textOnly)) return;

        seen.add(normalized);

        if (includeTimestamps) {
          out.push(`[${timestamp.length === 4 ? '00:' + timestamp : timestamp}]`);
          out.push(textOnly);
        } else {
          out.push(textOnly);
        }
      };

      modernTranscriptContainers.forEach(container => {
        const transcriptViewModels = container.querySelectorAll(
          [
            'transcript-segment-view-model',
            '.ytwTranscriptSegmentViewModelHost'
          ].join(', ')
        );

        transcriptViewModels.forEach(node => {
          const timestampNode = node.querySelector(
            '.ytwTranscriptSegmentViewModelTimestamp, [class*="TranscriptSegmentViewModelTimestamp"]'
          );
          const textNode = node.querySelector(
            '[role="text"], .yt-core-attributed-string'
          );

          const timestamp = (timestampNode?.innerText || timestampNode?.textContent || '').trim();
          const text = (textNode?.innerText || textNode?.textContent || '').trim().replace(/\s+/g, ' ');

          if (!timestamp || !text) return;
          pushTranscriptBlock(`${timestamp} ${text}`);
        });

        if (out.length) return;

        const transcriptRows = container.querySelectorAll(
          [
            'ytd-transcript-segment-renderer',
            '[role="button"]',
            '[role="listitem"]'
          ].join(', ')
        );

        transcriptRows.forEach(node => {
          if (node.closest('timeline-chapter-view-model')) return;
          if (node.matches('macro-markers-panel-item-view-model') && !node.querySelector('transcript-segment-view-model, .ytwTranscriptSegmentViewModelHost')) return;

          const raw = node.innerText || node.textContent || '';
          const cleaned = raw.trim().replace(/\n+/g, '\n');
          if (!cleaned) return;

          pushTranscriptBlock(cleaned);
        });
      });

      if (out.length) return out.join('\n');
    }

    const modernTextNodes = document.querySelectorAll(
      [
        '[target-id="engagement-panel-searchable-transcript"] [class*="segment-text"]',
        '[target-id="engagement-panel-searchable-transcript"] [class*="cue-group"]',
        'ytd-transcript-search-panel-renderer [class*="segment-text"]',
        'ytd-transcript-search-panel-renderer [class*="cue-group"]'
      ].join(', ')
    );
    if (modernTextNodes && modernTextNodes.length) {
      const out = [];
      modernTextNodes.forEach(el => {
        const raw = el.innerText || el.textContent || '';
        const cleaned = raw.trim().replace(/\n+/g, '\n');
        if (!cleaned) return;
        const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean);
        for (const line of lines) {
          const m = line.match(/^(\d{1,2}:)?\d{1,2}:\d{2}/);
          const textOnly = line.replace(/^(\d{1,2}:)?\d{1,2}:\d{2}\s*/, '').trim();
          if (!textOnly) continue;
          if (includeTimestamps && m) {
            out.push(`[${m[0].length === 4 ? '00:' + m[0] : m[0]}]`);
            out.push(textOnly);
          } else {
            out.push(textOnly);
          }
        }
      });
      if (out.length) return out.join('\n');
    }

    const legacy = document.querySelectorAll('ytd-transcript-segment-list-renderer .segment, yt-formatted-string.ytd-transcript-segment-renderer');
    if (legacy && legacy.length) {
      const out = [];
      legacy.forEach(el => {
        const raw = el.innerText || el.textContent || '';
        const m = raw.match(/^(\d{1,2}:)?\d{1,2}:\d{2}/);
        const textOnly = raw.replace(/^(\d{1,2}:)?\d{1,2}:\d{2}\s*/,'').trim();
        if (textOnly) {
          if (includeTimestamps && m) {
            out.push(`[${m[0].length === 4 ? '00:' + m[0] : m[0]}]`);
            out.push(textOnly);
          } else {
            out.push(textOnly);
          }
        }
      });
      if (out.length) return out.join('\n');
    }
    return null;
  }

  function hasTranscriptDomContent() {
    return !!document.querySelector(
      [
        'ytd-transcript-segment-renderer',
        'ytd-transcript-search-panel-renderer',
        '[target-id="engagement-panel-searchable-transcript"] [class*="segment-text"]',
        '[target-id="engagement-panel-searchable-transcript"] [class*="cue-group"]',
        'ytd-transcript-search-panel-renderer [class*="segment-text"]',
        'ytd-transcript-search-panel-renderer [class*="cue-group"]',
        'ytd-item-section-renderer [role="button"] yt-formatted-string',
        'ytd-item-section-renderer [role="button"] span'
      ].join(', ')
    );
  }

  function getFullPageText() {
    const root = document.body || document.documentElement;
    const raw = root?.innerText || root?.textContent || '';
    const lines = raw
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const deduped = [];
    for (const line of lines) {
      if (deduped[deduped.length - 1] !== line) deduped.push(line);
    }

    const header = [
      `Page title: ${document.title || ''}`.trim(),
      `URL: ${location.href}`,
      ''
    ];

    return header.concat(deduped).join('\n').trim();
  }

  async function ensureTranscriptPanelOpen() {
    // Already have segments? Then we’re good.
    if (hasTranscriptDomContent()) return true;

    const panelSelector =
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';

    const existingPanel = document.querySelector(panelSelector);
    if (
      existingPanel &&
      (existingPanel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' ||
       existingPanel.hasAttribute('opened'))
    ) {
      return true;
    }

    // ---- 1) New layout: "Show transcript" button in description ----
    const showCandidates = Array.from(
      document.querySelectorAll(
        // Prefer the new transcript section in the description area:
        'ytd-video-description-transcript-section-renderer yt-button-shape,' +
        'ytd-video-description-transcript-section-renderer button,' +
        // Fallbacks:
        'yt-button-shape, ytd-button-renderer, button'
      )
    );

    const showEl = showCandidates.find(el =>
      /show transcript/i.test(
        (el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')
      )
    );

    if (showEl) {
      // Make sure we click the real <button>, not the inner yt-touch-feedback-shape
      const clickable =
        showEl.closest('button') ||
        showEl.querySelector('button') ||
        showEl;

      humanClick(clickable);

      for (let i = 0; i < 40; i++) {
        await sleep(200);
        if (hasTranscriptDomContent()) return true;
        const p = document.querySelector(panelSelector);
        if (
          p &&
          (p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' ||
           p.hasAttribute('opened'))
        ) {
          return true;
        }
      }
    }

    // ---- 2) Fallback: kebab (⋯) menu → “Show transcript” ----
    const kebab = document.querySelector(
      'ytd-watch-metadata ytd-menu-renderer button[aria-label*="More"],' +
      'ytd-watch-metadata ytd-menu-renderer yt-icon-button[aria-label*="More"],' +
      '#top-level-buttons-computed ytd-menu-renderer button'
    );

    if (kebab) {
      humanClick(kebab);

      // Wait for popup menu
      let popup = null;
      for (let i = 0; i < 25 && !popup; i++) {
        await sleep(120);
        popup = document.querySelector(
          'ytd-menu-popup-renderer tp-yt-paper-listbox, ytd-menu-popup-renderer'
        );
      }

      if (popup) {
        const items = Array.from(
          popup.querySelectorAll(
            'ytd-menu-service-item-renderer, tp-yt-paper-item, ytd-compact-link-renderer'
          )
        );
        const item = items.find(el =>
          /transcript/i.test(el.innerText || el.textContent || '')
        );

        if (item) {
          humanClick(item);

          for (let i = 0; i < 40; i++) {
            await sleep(200);
            if (hasTranscriptDomContent()) return true;
            const p = document.querySelector(panelSelector);
            if (
              p &&
              (p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' ||
               p.hasAttribute('opened'))
            ) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }


  async function getTranscriptTextWithOpen(includeTimestamps) {
    const apiText = await getTranscriptFromCaptionsAPI(includeTimestamps);
    if (apiText) return apiText;

    // Shorts generally do not expose the same transcript panel structure as watch pages.
    if (isShortsPage()) return null;

    await ensureTranscriptPanelOpen();
    for (let i=0;i<15;i++) {
      const domText = scrapeTranscriptFromDOM(includeTimestamps);
      if (domText) return domText;
      await sleep(200);
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg && msg.type === 'YT_GET_TRANSCRIPT_WITH_OPEN') {
          const t = await getTranscriptTextWithOpen(!!msg.includeTimestamps);
          sendResponse({ transcript: t });
          return;
        }
        if (msg && msg.type === 'YT_GET_PAGE_TEXT') {
          sendResponse({ pageText: getFullPageText() });
        }
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  });
})();
