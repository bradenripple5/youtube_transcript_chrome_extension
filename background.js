// MV3 service worker: human-readable filename with spaces + URL included (sanitized).
// Header block remains at top of file.
function sanitizeForFilenamePreserveSpaces(s) {
  // Replace only illegal characters on Windows: \ / : * ? " < > | with '-'
  return s.replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 180);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'downloadTranscript') {
        const includeTimestamps = !!msg.includeTimestamps;
        const text = (msg.payload?.text || '');
        const tabInfo = msg.payload?.tabInfo || {};
        const rawTitle = tabInfo.title || 'untitled';
        const rawUrl = tabInfo.url || '';

        const titleForName = sanitizeForFilenamePreserveSpaces(rawTitle);
        const urlForName = sanitizeForFilenamePreserveSpaces(rawUrl);

        const tsLabel = includeTimestamps ? 'with timestamps' : 'no timestamps';
        // Example:
        // youtube transcript (with timestamps) - Video Title - https---www.youtube.com-watch?v=dQw4w9WgXcQ.txt
        const fileName = `youtube transcript (${tsLabel}) - ${titleForName}` + (urlForName ? ` - ${urlForName}.txt` : `.txt`);

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
          conflictAction: "overwrite",
          saveAs: false
        });
        sendResponse({ ok: true, filename: fileName });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});
