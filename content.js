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

  async function getTranscriptFromCaptionsAPI(includeTimestamps) {
    try {
      const pr = window.ytInitialPlayerResponse ||
        (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args && JSON.parse(window.ytplayer.config.args.player_response));
      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      const baseUrl = tracks && tracks[0]?.baseUrl;
      if (!baseUrl) return null;
      const vttUrl = baseUrl.includes('fmt=') ? baseUrl : `${baseUrl}&fmt=vtt`;
      const res = await fetch(vttUrl, { credentials: 'omit' });
      if (!res.ok) return null;
      const vtt = await res.text();
      return parseVtt(vtt, includeTimestamps);
    } catch { return null; }
  }

  function scrapeTranscriptFromDOM(includeTimestamps) {
    const segs = document.querySelectorAll('ytd-transcript-segment-renderer');
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

  async function ensureTranscriptPanelOpen() {
    // Already have segments? Then we’re good.
    if (document.querySelector('ytd-transcript-segment-renderer')) return true;

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
        if (document.querySelector('ytd-transcript-segment-renderer')) return true;
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
            if (document.querySelector('ytd-transcript-segment-renderer')) return true;
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
        }
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  });
})();
