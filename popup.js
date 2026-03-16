const timestampsCheckbox = document.getElementById('timestampsCheckbox');
const saveCheckbox = document.getElementById('saveCheckbox');
const grabBtn = document.getElementById('grabBtn');
const chatgptBtn = document.getElementById('chatgptBtn');
const statusEl = document.getElementById('status');
const PROMPT_PREFIX = 'please summarize:\n';

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

async function requestPageText(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'YT_GET_PAGE_TEXT'
    });
    return resp;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, {
      type: 'YT_GET_PAGE_TEXT'
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

async function sendTranscriptToChatGPT({ transcript, promptText }) {
  const resp = await chrome.runtime.sendMessage({
    type: 'openChatGPTWithTranscript',
    transcript,
    promptText
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

    let sourceText = resp.transcript || '';
    let usedPageFallback = false;
    if (!sourceText) {
      setStatus('Transcript unavailable. Falling back to full page text...');
      const pageResp = await requestPageText(tab.id);
      if (pageResp?.error) throw new Error(pageResp.error);
      sourceText = pageResp?.pageText || '';
      usedPageFallback = true;
    }
    if (!sourceText) throw new Error('Could not find transcript or page text on this video.');

    const promptText = `${PROMPT_PREFIX}${sourceText}`;
    await navigator.clipboard.writeText(promptText);
    const saveResult = await saveTranscriptIfNeeded(saveToDownloads, includeTimestamps, sourceText, tab);

    if (sendToChatGPT) {
      setStatus(usedPageFallback ? 'Using full page text. Opening ChatGPT...' : 'Copied. Opening ChatGPT...');
      const chatRes = await sendTranscriptToChatGPT({
        transcript: sourceText,
        promptText
      });
      if (!chatRes?.ok) {
        setStatus((usedPageFallback ? 'Used full page text. ' : 'Copied. ') + 'ChatGPT did not open: ' + (chatRes?.error || 'Unknown error.'));
        return;
      }
      setStatus(
        saveResult.saved
          ? (usedPageFallback ? 'Used full page text, saved, and sent to ChatGPT.' : 'Copied, saved, and sent to ChatGPT.')
          : (usedPageFallback ? 'Used full page text and sent to ChatGPT.' : 'Copied and sent to ChatGPT.')
      );
      return;
    }

    if (saveResult.saved) {
      setStatus(
        saveResult.ok
          ? (usedPageFallback ? 'Used full page text and saved.' : 'Copied and saved.')
          : ((usedPageFallback ? 'Used full page text, but failed to save file.' : 'Copied, but failed to save file.') + (saveResult.error ? (' ' + saveResult.error) : ''))
      );
    } else {
      setStatus(usedPageFallback ? 'Used full page text and copied to clipboard.' : 'Copied to clipboard.');
    }
  } catch (e) {
    setStatus('Error: ' + (e?.message || e));
  }
}

grabBtn.addEventListener('click', () => handleTranscriptRequest({ sendToChatGPT: false }));
chatgptBtn.addEventListener('click', () => handleTranscriptRequest({ sendToChatGPT: true }));
