// content_hooks.js — MAIN world content script
// Hooks XMLHttpRequest, fetch, WebSocket, and HTMLMediaElement.srcObject to
// detect live-stream URLs, then posts them to the ISOLATED world via
// window.postMessage so they can be forwarded to the background service worker.
(function () {
    'use strict';

    // ─── Constants ────────────────────────────────────────────────────────────

    const STREAM_MIME_RE = /video\/x-flv|video\/mp2t|application\/(x-mpegurl|vnd\.apple\.mpegurl)/i;
    const WS_STREAM_RE   = /\.(flv|ts|m4s|mp4|aac)(\?|$)/i;
    const STREAM_RE      = /\.(m3u8|flv|mpd|ts)(\?|$)/i;
    const M3U8_URL_RE    = /\.m3u8(\?|#|$)/i;
    const TS_URL_RE      = /\.ts(\?|#|$)/i;

    /** Consecutive binary frames required before classifying a WebSocket as a media stream. */
    const WS_BINARY_DETECT_COUNT  = 2;
    /** Give up watching a WebSocket for binary frames after this many total messages. */
    const WS_BINARY_GIVE_UP_COUNT = 50;

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function resolveURL(base, url) {
        try { return new URL(url, base).href; } catch { return url; }
    }

    function isStreamURL(url) {
        return typeof url === 'string' && STREAM_RE.test(url);
    }

    function isWSStreamURL(url) {
        return typeof url === 'string' &&
               /^wss?:\/\//i.test(url) &&
               (WS_STREAM_RE.test(url) || /\/(live|stream|push|play|video)\//i.test(url));
    }

    /**
     * True once a .m3u8 playlist URL has been detected on this page.
     * Used to suppress individual .ts segment URLs that an HLS player fetches
     * after the playlist — we only need the playlist URL, not every segment.
     */
    let m3u8Detected = false;

    /**
     * Send a detected stream URL to the ISOLATED world content script.
     * Using window.postMessage is the only way for MAIN-world scripts to reach
     * the extension's ISOLATED world without DOM mutation hacks.
     */
    function send(url, mimeType) {
        if (!url || typeof url !== 'string') return;
        // Once a .m3u8 playlist has been seen, suppress individual .ts segments.
        if (m3u8Detected && TS_URL_RE.test(url)) return;
        if (M3U8_URL_RE.test(url)) m3u8Detected = true;
        window.postMessage({ __lsr: true, type: 'stream', url, mimeType: mimeType || null }, '*');
    }

    // ─── Hook XMLHttpRequest ──────────────────────────────────────────────────

    const _xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        try {
            const full = resolveURL(location.href, String(url));
            this._lsrUrl = full;
            if (isStreamURL(full)) send(full);
        } catch { /* ignore */ }
        return _xhrOpen.call(this, method, url, ...rest);
    };

    const _xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
        const lsrUrl = this._lsrUrl;
        if (lsrUrl) {
            const handler = function () {
                if (this.readyState === /* HEADERS_RECEIVED */ 2) {
                    this.removeEventListener('readystatechange', handler);
                    try {
                        const ct = this.getResponseHeader('Content-Type') || '';
                        if (STREAM_MIME_RE.test(ct)) send(lsrUrl, ct);
                    } catch { /* cross-origin */ }
                }
            };
            this.addEventListener('readystatechange', handler);
        }
        return _xhrSend.apply(this, args);
    };

    // ─── Hook fetch ───────────────────────────────────────────────────────────

    const _fetch = window.fetch;
    if (typeof _fetch === 'function') {
        window.fetch = function (input, ...rest) {
            let full = '';
            try {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                full = resolveURL(location.href, url);
            } catch { /* ignore */ }

            if (full) {
                const urlMatched = isStreamURL(full);
                if (urlMatched) send(full);
                const promise = _fetch.call(this, input, ...rest);
                if (!urlMatched) {
                    promise.then((response) => {
                        try {
                            const ct = response.headers.get('content-type') || '';
                            if (STREAM_MIME_RE.test(ct)) send(full, ct);
                        } catch { /* ignore */ }
                    }).catch(() => {});
                }
                return promise;
            }
            return _fetch.call(this, input, ...rest);
        };
    }

    // ─── Hook WebSocket ───────────────────────────────────────────────────────

    const _OrigWS = window.WebSocket;
    if (typeof _OrigWS === 'function') {
        window.WebSocket = function (url, protocols) {
            const strUrl = String(url || '');
            const ws = protocols !== undefined
                ? new _OrigWS(url, protocols)
                : new _OrigWS(url);
            try {
                if (isWSStreamURL(strUrl)) {
                    send(strUrl);
                } else {
                    // Watch for binary frames; require WS_BINARY_DETECT_COUNT before
                    // classifying as a media stream to avoid false-positives.
                    let binaryCount = 0, totalCount = 0;
                    const detector = (e) => {
                        totalCount++;
                        if (e.data instanceof ArrayBuffer || e.data instanceof Blob) {
                            if (++binaryCount >= WS_BINARY_DETECT_COUNT) {
                                ws.removeEventListener('message', detector);
                                send(strUrl);
                                return;
                            }
                        }
                        if (totalCount >= WS_BINARY_GIVE_UP_COUNT) {
                            ws.removeEventListener('message', detector);
                        }
                    };
                    ws.addEventListener('message', detector);
                }
            } catch { /* ignore */ }
            return ws;
        };
        window.WebSocket.prototype = _OrigWS.prototype;
        window.WebSocket.CONNECTING = _OrigWS.CONNECTING;
        window.WebSocket.OPEN       = _OrigWS.OPEN;
        window.WebSocket.CLOSING    = _OrigWS.CLOSING;
        window.WebSocket.CLOSED     = _OrigWS.CLOSED;
    }

    // ─── Hook HTMLMediaElement.srcObject (WebRTC) ─────────────────────────────

    const _ME = window.HTMLMediaElement;
    if (_ME && _ME.prototype) {
        const desc = Object.getOwnPropertyDescriptor(_ME.prototype, 'srcObject');
        if (desc && desc.set) {
            const _origSet = desc.set;
            Object.defineProperty(_ME.prototype, 'srcObject', {
                get: desc.get,
                set(val) {
                    try {
                        if (val instanceof window.MediaStream && val.getVideoTracks().length > 0) {
                            // Synthetic URL identifies the WebRTC stream; not a real network address.
                            send('webrtc://' + location.hostname + '/' + val.id);
                        }
                    } catch { /* ignore */ }
                    return _origSet.call(this, val);
                },
                configurable: true,
            });
        }
    }

    // ─── Scan existing <video>/<source> elements ──────────────────────────────

    function scanDOM() {
        document.querySelectorAll('video[src], source[src]').forEach((el) => {
            try {
                const src  = el.src || el.getAttribute('src') || '';
                const type = el.type || el.getAttribute('type') || '';
                const full = resolveURL(location.href, src);
                if (isStreamURL(full) || STREAM_MIME_RE.test(type)) send(full, type || undefined);
            } catch { /* ignore */ }
        });
    }

    if (document.readyState !== 'loading') {
        scanDOM();
    } else {
        document.addEventListener('DOMContentLoaded', scanDOM, { once: true });
    }

    // Watch for dynamically added elements after DOMContentLoaded.
    document.addEventListener('DOMContentLoaded', () => {
        const mo = new MutationObserver(scanDOM);
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }, { once: true });

})();
