(function bootstrapChatGPTHelper() {
  if (window.__YT_CHATGPT_HELPER_BOOTSTRAPPED__) return;
  window.__YT_CHATGPT_HELPER_BOOTSTRAPPED__ = true;

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getComposerCandidates() {
    return [
      document.querySelector('textarea#prompt-textarea'),
      document.querySelector('#prompt-textarea'),
      document.querySelector('textarea[data-id="root"]'),
      document.querySelector('form textarea'),
      document.querySelector('[contenteditable="true"][data-id="root"]'),
      document.querySelector('[contenteditable="true"][role="textbox"]'),
      document.querySelector('div[contenteditable="true"]')
    ].filter(Boolean);
  }

  function getSendButton() {
    return document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send"]') ||
      document.querySelector('button[type="submit"]');
  }

  function getFileInput() {
    return document.querySelector('input[type="file"]');
  }

  function getAttachButton() {
    return document.querySelector('button[aria-label*="Attach"]') ||
      document.querySelector('button[aria-label*="Upload"]') ||
      document.querySelector('button[data-testid*="attach"]') ||
      document.querySelector('button[data-testid*="upload"]') ||
      Array.from(document.querySelectorAll('button')).find(button => /attach|upload|paperclip/i.test(
        (button.getAttribute('aria-label') || '') + ' ' + (button.textContent || '')
      ));
  }

  function setNativeValue(element, value) {
    const proto = element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement?.prototype
      : window.HTMLInputElement?.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function insertIntoEditable(element, value) {
    element.focus();
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    try {
      document.execCommand('selectAll', false, null);
    } catch {}
    try {
      if (document.execCommand('insertText', false, value)) return;
    } catch {}
    element.textContent = value;
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: value
    }));
  }

  function fillComposer(text) {
    const composer = getComposerCandidates()[0];
    if (!composer) return { ok: false, reason: 'composer_not_found' };

    composer.focus();
    if ('value' in composer) {
      setNativeValue(composer, text);
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      if (composer.setSelectionRange) {
        composer.setSelectionRange(composer.value.length, composer.value.length);
      }
    } else {
      insertIntoEditable(composer, text);
    }

    return { ok: true };
  }

  async function submitComposer() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const sendButton = getSendButton();
      if (sendButton && !sendButton.disabled) {
        sendButton.click();
        return { ok: true, submitted: true };
      }
      await sleep(200);
    }

    const activeEl = document.activeElement;
    if (activeEl) {
      activeEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      }));
      activeEl.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      }));
      return { ok: true, submitted: true, fallback: 'enter_key' };
    }

    return { ok: false, reason: 'send_button_not_ready' };
  }

  async function waitForFileInput(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const input = getFileInput();
      if (input) return { ok: true, input };
      const attachButton = getAttachButton();
      if (attachButton) {
        attachButton.click();
      }
      await sleep(250);
    }
    return { ok: false, reason: 'file_input_not_found' };
  }

  async function attachTextFile(fileName, text) {
    const inputResult = await waitForFileInput();
    if (!inputResult.ok) return inputResult;

    const { input } = inputResult;
    const file = new File([text], fileName || 'youtube-transcript.txt', { type: 'text/plain' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    return { ok: true, attached: true, fileName: file.name };
  }

  async function waitForComposer(timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (getComposerCandidates().length) return { ok: true };
      await sleep(250);
    }
    return { ok: false, reason: 'composer_timeout' };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type === 'CHATGPT_PING') {
        sendResponse({
          ok: true,
          ready: getComposerCandidates().length > 0,
          hasSendButton: !!getSendButton()
        });
        return;
      }

      if (msg?.type === 'CHATGPT_FILL_AND_SUBMIT') {
        const waitResult = await waitForComposer(msg.timeoutMs || 45000);
        if (!waitResult.ok) {
          sendResponse(waitResult);
          return;
        }

        const fillResult = fillComposer(msg.text || '');
        if (!fillResult.ok) {
          sendResponse(fillResult);
          return;
        }

        const submitResult = await submitComposer();
        sendResponse(submitResult);
        return;
      }

      if (msg?.type === 'CHATGPT_ATTACH_AND_SUBMIT') {
        const waitResult = await waitForComposer(msg.timeoutMs || 45000);
        if (!waitResult.ok) {
          sendResponse(waitResult);
          return;
        }

        const attachResult = await attachTextFile(msg.fileName, msg.attachmentText || '');
        if (!attachResult.ok) {
          sendResponse(attachResult);
          return;
        }

        const fillResult = fillComposer(msg.promptText || 'Please summarize the attached transcript.');
        if (!fillResult.ok) {
          sendResponse(fillResult);
          return;
        }

        const submitResult = await submitComposer();
        sendResponse({
          ok: !!submitResult.ok,
          attached: true,
          fileName: attachResult.fileName,
          submitted: !!submitResult.submitted,
          fallback: submitResult.fallback,
          reason: submitResult.reason
        });
      }
    })().catch(err => {
      sendResponse({ ok: false, reason: String(err) });
    });
    return true;
  });
})();
