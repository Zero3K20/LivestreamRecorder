// content_bridge.js — ISOLATED world content script
// Listens for stream-detection events posted by content_hooks.js (MAIN world)
// and forwards them to the background service worker via chrome.runtime.sendMessage.
(function () {
    'use strict';

    window.addEventListener('message', (e) => {
        // Only accept messages from this page's own MAIN world (not cross-origin frames).
        if (e.source !== window) return;
        if (!e.data || e.data.__lsr !== true || e.data.type !== 'stream') return;

        const { url, mimeType } = e.data;
        if (typeof url !== 'string' || !url) return;

        // Forward to background; ignore failures (e.g. extension reloading).
        chrome.runtime.sendMessage({ type: 'addStream', url, mimeType: mimeType || null })
            .catch(() => {});
    });

})();
