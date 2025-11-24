# YouTube Video Summary Maker Using ChatGPT

This Chrome extension copies the YouTube transcript for the current video and (optionally) saves it with a readable filename that can include timestamps and the URL for easy reference.

## Site access screenshot

![Chrome extensions permissions screenshot](Screenshot%20from%202025-11-23%2016-07-02.png)

In `chrome://extensions`, open the details page for the extension and scroll to **Site access**. Each of the host permissions must be enabled—Chrome shows them as blue toggles in the screenshot above. Make sure the following entries are blue so the extension can run in the proper contexts:

- `https://*.youtube.com/*`
- `https://youtube.com/*`
- `https://youtu.be/*`
- `https://chat.openai.com/*`
- `https://chatgpt.com/*`

If any toggle is gray, click it once so it turns blue; otherwise the extension will be blocked from running on that site.
