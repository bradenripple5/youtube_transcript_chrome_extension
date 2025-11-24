// MV3 service worker: shared helpers for downloads, ChatGPT integration and context menu.
const CHATGPT_URL = 'https://chat.openai.com/';
const MENU_ID = 'ytTranscriptSendToChatGPT';
const PROMPT_PREFIX = 'please summarize:\n';

function sanitizeForFilenamePreserveSpaces(s) {
  // Replace only illegal characters on Windows: \ / : * ? " < > | with '-'
  return s.replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 180);
}

// 🔴 REMOVED the old onInstalled that created "yt-chatgpt" here

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function downloadTranscriptFile({ text, tabInfo, includeTimestamps }) {
  const rawTitle = tabInfo?.title || 'untitled';
  const rawUrl = tabInfo?.url || '';

  const titleForName = sanitizeForFilenamePreserveSpaces(rawTitle);
  const urlForName = sanitizeForFilenamePreserveSpaces(rawUrl);

  const tsLabel = includeTimestamps ? 'with timestamps' : 'no timestamps';
  const fileName =
    `youtube transcript (${tsLabel}) - ${titleForName}` +
    (urlForName ? ` - ${urlForName}.txt` : `.txt`);

  const headerLines = [
    `Title: ${rawTitle}`,
    `URL: ${rawUrl}`,
    `Timestamps: ${includeTimestamps ? 'on' : 'off'}`,
    ''
  ];
  const finalText = headerLines.join('\n') + text + (text.endsWith('\n') ? '' : '\n');

  const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(finalText);
  await chrome.downloads.download({
    url: dataUrl,
    filename: fileName,
    conflictAction: 'overwrite',
    saveAs: false
  });
  return { ok: true, filename: fileName };
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function requestTranscriptFromTab(tabId, includeTimestamps) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'YT_GET_TRANSCRIPT_WITH_OPEN',
      includeTimestamps
    });
    return resp?.transcript || null;
  } catch {
    await ensureContentScript(tabId);
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'YT_GET_TRANSCRIPT_WITH_OPEN',
      includeTimestamps
    });
    return resp?.transcript || null;
  }
}

async function copyTextViaTab(tabId, text) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: async (payload) => {
        try {
          await navigator.clipboard.writeText(payload);
          return true;
        } catch {
          const area = document.createElement('textarea');
          area.value = payload;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.focus();
          area.select();
          document.execCommand('copy');
          area.remove();
          return true;
        }
      },
      args: [text]
    });
  } catch {
    // Clipboard copy best-effort; ignore failures so flow can continue.
  }
}

async function showInlineMessage(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg) => {
        const existing = document.getElementById('yt-transcript-helper-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'yt-transcript-helper-toast';
        toast.textContent = msg;
        toast.style.position = 'fixed';
        toast.style.bottom = '16px';
        toast.style.right = '16px';
        toast.style.zIndex = '999999';
        toast.style.padding = '10px 14px';
        toast.style.background = 'rgba(0,0,0,0.85)';
        toast.style.color = '#fff';
        toast.style.fontSize = '14px';
        toast.style.borderRadius = '8px';
        toast.style.boxShadow = '0 2px 10px rgba(0,0,0,0.4)';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4500);
      },
      args: [message]
    });
  } catch {
    // non-fatal
  }
}

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) throw new Error('Tab closed');
      if (tab.status === 'complete') return;
    } catch (err) {
      if (err && /No tab/.test(err.message || '')) throw err;
    }
    await sleep(500);
  }
  throw new Error('Timed out waiting for ChatGPT to load');
}

async function tryFillChatGPT(tabId, transcript) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (text) => {
        const candidates = [
          'textarea#prompt-textarea',
          'textarea[data-id="root"]',
          'form textarea',
          '[contenteditable="true"][data-id="root"]'
        ];
        let inserted = false;
        for (const selector of candidates) {
          const el = document.querySelector(selector);
          if (!el) continue;
          if ('value' in el) {
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            el.innerText = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          el.focus();
          if (el.setSelectionRange) {
            el.setSelectionRange(el.value.length, el.value.length);
          }
          inserted = true;
          break;
        }
        if (!inserted) {
          return { ok: false };
        }
        const sendBtn =
          document.querySelector('button[aria-label*="Send"]') ||
          document.querySelector('button[data-testid="send-button"]') ||
          document.querySelector('button[type="submit"]');
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        }
        return { ok: true };
      },
      args: [transcript]
    });
    if (result?.result?.ok) return true;
    await sleep(400);
  }
  return false;
}

async function getOrCreateChatGPTTab() {
  try {
    const existing = await chrome.tabs.query({ url: 'https://chat.openai.com/*' });
    if (existing && existing.length) {
      const first = existing.find(tab => tab && tab.id !== undefined) || existing[0];
      if (first.id !== undefined) {
        await chrome.tabs.update(first.id, { active: true, highlighted: true });
        return first;
      }
    }
  } catch {
    // Ignore query failures and fall back to creation.
  }

  return await new Promise((resolve, reject) => {
    chrome.tabs.create({ url: CHATGPT_URL, active: true }, (tab) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || 'Unable to open ChatGPT tab.'));
        return;
      }
      resolve(tab);
    });
  });
}

async function openChatGPTAndPaste(transcript) {
  if (!transcript) return { ok: false, error: 'Transcript text is empty.' };
  let chatTab;
  try {
    chatTab = await getOrCreateChatGPTTab();
  } catch (err) {
    return { ok: false, error: err?.message || 'Unable to open ChatGPT tab.' };
  }

  if (!chatTab || chatTab.id === undefined) {
    return { ok: false, error: 'ChatGPT tab handle missing.' };
  }

  try {
    await waitForTabComplete(chatTab.id, 45000);
  } catch {
    // Continue even if loading takes too long; we'll still attempt injection.
  }
  const inserted = await tryFillChatGPT(chatTab.id, transcript);
  if (!inserted) {
    return { ok: false, error: 'Could not insert transcript into ChatGPT. Please paste manually.' };
  }
  return { ok: true, tabId: chatTab.id };
}

async function handleContextMenuRequest(tab) {
  if (!tab?.id) return;
  const tabId = tab.id;
  try {
    const { includeTimestamps = false, saveToDownloads = false } = await chrome.storage.sync.get({
      includeTimestamps: false,
      saveToDownloads: false
    });
    const transcript = await requestTranscriptFromTab(tabId, !!includeTimestamps);
    if (!transcript) {
      await showInlineMessage(tabId, 'Transcript not available for this video.');
      return;
    }

    const promptText = `${PROMPT_PREFIX}${transcript}`;

    await copyTextViaTab(tabId, promptText);

    if (saveToDownloads) {
      try {
        await downloadTranscriptFile({
          text: transcript,
          tabInfo: { title: tab.title || '', url: tab.url || '' },
          includeTimestamps: !!includeTimestamps
        });
      } catch (err) {
        await showInlineMessage(tabId, `Transcript copied, but saving failed: ${err?.message || err}`);
      }
    }

    const openRes = await openChatGPTAndPaste(promptText);
    if (!openRes.ok) {
      await showInlineMessage(tabId, openRes.error || 'Transcript copied, but ChatGPT did not open.');
    }
  } catch (err) {
    await showInlineMessage(tabId, `Transcript helper error: ${err?.message || err}`);
  }
}

function registerContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Send transcript to ChatGPT',
      // 👇 Shows on page, selection, and browser's video menu
      contexts: ['page', 'selection', 'video'],
      // 👇 Only on YouTube and youtu.be
      documentUrlPatterns: [
        '*://youtube.com/*',
        '*://*.youtube.com/*',
        '*://youtu.be/*'
      ]
    }, () => void chrome.runtime.lastError);
  });
}

// Register at startup and when the extension is installed/updated
registerContextMenu();
chrome.runtime.onInstalled.addListener(registerContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab) {
    handleContextMenuRequest(tab);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'downloadTranscript') {
      const includeTimestamps = !!msg.includeTimestamps;
      const text = msg.payload?.text || '';
      const tabInfo = msg.payload?.tabInfo || {};
      const resp = await downloadTranscriptFile({ text, tabInfo, includeTimestamps });
      sendResponse(resp);
      return;
    }
    if (msg?.type === 'openChatGPTWithTranscript') {
      const resp = await openChatGPTAndPaste(msg.transcript || '');
      sendResponse(resp);
      return;
    }
  })().catch(err => {
    sendResponse({ ok: false, error: String(err) });
  });
  return true;
});
