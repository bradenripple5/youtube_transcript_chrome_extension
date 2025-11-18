const timestampsCheckbox = document.getElementById('timestampsCheckbox');
const saveCheckbox = document.getElementById('saveCheckbox');
const grabBtn = document.getElementById('grabBtn');
const chatgptBtn = document.getElementById('chatgptBtn');
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

async function ensureActiveYouTubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const isYouTube = /^https?:\/\/(www\.)?youtube\.com\//i.test(url) ||
    /^https?:\/\/youtube\.com\//i.test(url) ||
    /^https?:\/\/m\.youtube\.com\//i.test(url) ||
    /^https?:\/\/youtu\.be\//i.test(url);
  if (!tab || !isYouTube) {
    throw new Error('Open a YouTube video tab on youtube.com and try again.');
  }
  return tab;
}

async function requestTranscript(tabId, includeTimestamps) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'YT_GET_TRANSCRIPT_WITH_OPEN',
      includeTimestamps
    });
    return resp;
  } catch (err) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, {
      type: 'YT_GET_TRANSCRIPT_WITH_OPEN',
      includeTimestamps
    });
  }
}

async function saveTranscriptIfNeeded(saveToDownloads, includeTimestamps, transcript, tab) {
  if (!saveToDownloads) return { saved: false, ok: true };
  const dl = await chrome.runtime.sendMessage({
    type: 'downloadTranscript',
    payload: { text: transcript, tabInfo: { title: tab.title || '', url: tab.url || '' } },
    includeTimestamps
  });
  return { saved: true, ok: !!(dl && dl.ok), error: dl?.error };
}

async function sendTranscriptToChatGPT(transcript) {
  const resp = await chrome.runtime.sendMessage({
    type: 'openChatGPTWithTranscript',
    transcript
  });
  return resp;
}

async function handleTranscriptRequest({ sendToChatGPT }) {
  setStatus('Getting transcript...');
  try {
    const includeTimestamps = !!timestampsCheckbox.checked;
    const saveToDownloads = !!saveCheckbox.checked;
    const tab = await ensureActiveYouTubeTab();

    const resp = await requestTranscript(tab.id, includeTimestamps);
    if (!resp) throw new Error('No response from content script.');
    if (resp.error) throw new Error(resp.error);
    if (!resp.transcript) throw new Error('Could not find a transcript on this video.');

    await navigator.clipboard.writeText(resp.transcript);
    const saveResult = await saveTranscriptIfNeeded(saveToDownloads, includeTimestamps, resp.transcript, tab);

    if (sendToChatGPT) {
      setStatus('Copied. Opening ChatGPT...');
      const chatRes = await sendTranscriptToChatGPT(resp.transcript);
      if (!chatRes?.ok) {
        setStatus('Copied. ChatGPT did not open: ' + (chatRes?.error || 'Unknown error.'));
        return;
      }
      setStatus(saveResult.saved ? 'Copied, saved, and sent to ChatGPT.' : 'Copied and sent to ChatGPT.');
      return;
    }

    if (saveResult.saved) {
      setStatus(saveResult.ok ? 'Copied and saved.' : 'Copied, but failed to save file.' + (saveResult.error ? (' ' + saveResult.error) : ''));
    } else {
      setStatus('Copied to clipboard.');
    }
  } catch (e) {
    setStatus('Error: ' + (e?.message || e));
  }
}

grabBtn.addEventListener('click', () => handleTranscriptRequest({ sendToChatGPT: false }));
chatgptBtn.addEventListener('click', () => handleTranscriptRequest({ sendToChatGPT: true }));
