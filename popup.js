const timestampsCheckbox = document.getElementById('timestampsCheckbox');
const saveCheckbox = document.getElementById('saveCheckbox');
const grabBtn = document.getElementById('grabBtn');
const statusEl = document.getElementById('status');

function setStatus(msg) { statusEl.textContent = msg; }

// Initialize from storage so the UI remembers the last state
(async function init() {
  const { includeTimestamps = false, saveToDownloads = false } = await chrome.storage.sync.get({
    includeTimestamps: false,
    saveToDownloads: false
  });
  timestampsCheckbox.checked = !!includeTimestamps;
  saveCheckbox.checked = !!saveToDownloads;
})();

// Persist changes, but we'll read live DOM state on click
timestampsCheckbox.addEventListener('change', async () => {
  await chrome.storage.sync.set({ includeTimestamps: timestampsCheckbox.checked });
});
saveCheckbox.addEventListener('change', async () => {
  await chrome.storage.sync.set({ saveToDownloads: saveCheckbox.checked });
});

grabBtn.addEventListener('click', async () => {
  setStatus('Getting transcript...');
  try {
    // READ LIVE UI STATE to avoid races with storage writes
    const includeTimestamps = !!timestampsCheckbox.checked;
    const saveToDownloads = !!saveCheckbox.checked;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:\/\/(www\.)?youtube\.com|https?:\/\/youtube\.com/.test(tab.url || "")) {
      setStatus('Open a YouTube video tab on youtube.com and try again.');
      return;
    }

    // Ensure content script is present by trying to message it; if needed we can inject content.js here.
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tab.id, {
        type: 'YT_GET_TRANSCRIPT_WITH_OPEN',
        includeTimestamps
      });
    } catch (e) {
      // Try injecting and retry once
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        resp = await chrome.tabs.sendMessage(tab.id, {
          type: 'YT_GET_TRANSCRIPT_WITH_OPEN',
          includeTimestamps
        });
      } catch (e2) {
        setStatus('Error: ' + (e2?.message || String(e2)));
        return;
      }
    }

    if (!resp) { setStatus('No response from content script.'); return; }
    if (resp.error) { setStatus('Error: ' + resp.error); return; }

    const transcript = resp.transcript;
    if (!transcript) { setStatus('Could not find a transcript on this video.'); return; }

    await navigator.clipboard.writeText(transcript);

    if (saveToDownloads) {
      const dl = await chrome.runtime.sendMessage({
        type: 'downloadTranscript',
        payload: { text: transcript, tabInfo: { title: tab.title || '', url: tab.url || '' } },
        includeTimestamps
      });
      if (dl && dl.ok) setStatus('Copied and saved.');
      else setStatus('Copied, but failed to save file.' + (dl?.error ? (' ' + dl.error) : ''));
    } else {
      setStatus('Copied to clipboard.');
    }
  } catch (e) {
    setStatus('Error: ' + (e && e.message ? e.message : e));
  }
});
