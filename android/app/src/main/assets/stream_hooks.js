// stream_hooks.js — injected into every WebView page at document-start.
// Ports the same XHR / fetch / WebSocket / srcObject hooks used by the
// Chrome extension's content_hooks.js so that stream URLs are forwarded to
// the native Android layer via the LSRBridge JavascriptInterface.
(function () {
    'use strict';

    if (window.__LSR_INJECTED__) return;
    window.__LSR_INJECTED__ = true;

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
        try { return new URL(url, base).href; } catch (e) { return url; }
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
     * Suppresses individual .ts segment URLs the HLS player fetches after
     * the playlist — we only need the playlist URL, not every segment.
     */
    var m3u8Detected = false;

    /**
     * Forward a detected stream URL to the native Android code via LSRBridge.
     * Derives the MIME type string used as the stream "type" label.
     */
    function send(url, mimeType) {
        if (!url || typeof url !== 'string') return;
        // Suppress individual .ts segments once we have the .m3u8 playlist.
        if (m3u8Detected && TS_URL_RE.test(url)) return;
        if (M3U8_URL_RE.test(url)) m3u8Detected = true;

        var type = 'direct';
        if (M3U8_URL_RE.test(url) || /mpegurl/i.test(mimeType || '')) {
            type = 'hls';
        } else if (/\.flv(\?|$)/i.test(url) || /x-flv/i.test(mimeType || '')) {
            type = 'flv';
        } else if (/\.mp4(\?|$)/i.test(url)) {
            type = 'mp4';
        } else if (/\.webm(\?|$)/i.test(url)) {
            type = 'webm';
        } else if (/^wss?:\/\//i.test(url)) {
            type = 'websocket';
        } else if (/^webrtc:\/\//i.test(url)) {
            type = 'webrtc';
        }

        try {
            if (window.LSRBridge) {
                window.LSRBridge.onStreamDetected(url, type);
            }
        } catch (e) { /* ignore */ }
    }

    // ─── Hook XMLHttpRequest ──────────────────────────────────────────────────

    var _xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        try {
            var full = resolveURL(location.href, String(url));
            this._lsrUrl = full;
            if (isStreamURL(full)) send(full);
        } catch (e) { /* ignore */ }
        return _xhrOpen.apply(this, arguments);
    };

    var _xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
        var lsrUrl = this._lsrUrl;
        if (lsrUrl) {
            var self = this;
            var handler = function () {
                if (self.readyState === 2 /* HEADERS_RECEIVED */) {
                    self.removeEventListener('readystatechange', handler);
                    try {
                        var ct = self.getResponseHeader('Content-Type') || '';
                        if (STREAM_MIME_RE.test(ct)) send(lsrUrl, ct);
                    } catch (e) { /* cross-origin */ }
                }
            };
            this.addEventListener('readystatechange', handler);
        }
        return _xhrSend.apply(this, arguments);
    };

    // ─── Hook fetch ───────────────────────────────────────────────────────────

    var _fetch = window.fetch;
    if (typeof _fetch === 'function') {
        window.fetch = function (input) {
            var full = '';
            try {
                var rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
                full = resolveURL(location.href, rawUrl);
            } catch (e) { /* ignore */ }

            if (full) {
                var urlMatched = isStreamURL(full);
                if (urlMatched) send(full);
                var promise = _fetch.apply(this, arguments);
                if (!urlMatched) {
                    promise.then(function (response) {
                        try {
                            var ct = response.headers.get('content-type') || '';
                            if (STREAM_MIME_RE.test(ct)) send(full, ct);
                        } catch (e) { /* ignore */ }
                    }).catch(function () {});
                }
                return promise;
            }
            return _fetch.apply(this, arguments);
        };
    }

    // ─── Hook WebSocket ───────────────────────────────────────────────────────

    var _OrigWS = window.WebSocket;
    if (typeof _OrigWS === 'function') {
        window.WebSocket = function (url, protocols) {
            var strUrl = String(url || '');
            var ws = protocols !== undefined
                ? new _OrigWS(url, protocols)
                : new _OrigWS(url);
            try {
                if (isWSStreamURL(strUrl)) {
                    send(strUrl);
                } else {
                    var binaryCount = 0, totalCount = 0;
                    var detector = function (e) {
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
            } catch (e) { /* ignore */ }
            return ws;
        };
        window.WebSocket.prototype  = _OrigWS.prototype;
        window.WebSocket.CONNECTING = _OrigWS.CONNECTING;
        window.WebSocket.OPEN       = _OrigWS.OPEN;
        window.WebSocket.CLOSING    = _OrigWS.CLOSING;
        window.WebSocket.CLOSED     = _OrigWS.CLOSED;
    }

    // ─── Hook HTMLMediaElement.srcObject (WebRTC) ─────────────────────────────

    var _ME = window.HTMLMediaElement;
    if (_ME && _ME.prototype) {
        var desc = Object.getOwnPropertyDescriptor(_ME.prototype, 'srcObject');
        if (desc && desc.set) {
            var _origSrcObjectSet = desc.set;
            Object.defineProperty(_ME.prototype, 'srcObject', {
                get: desc.get,
                set: function (val) {
                    try {
                        if (val instanceof window.MediaStream && val.getVideoTracks().length > 0) {
                            send('webrtc://' + location.hostname + '/' + val.id);
                        }
                    } catch (e) { /* ignore */ }
                    return _origSrcObjectSet.call(this, val);
                },
                configurable: true,
            });
        }
    }

    // ─── Scan existing <video>/<source> elements ──────────────────────────────

    function scanDOM() {
        document.querySelectorAll('video[src], source[src]').forEach(function (el) {
            try {
                var src  = el.src || el.getAttribute('src') || '';
                var type = el.type || el.getAttribute('type') || '';
                var full = resolveURL(location.href, src);
                if (isStreamURL(full) || STREAM_MIME_RE.test(type)) send(full, type || undefined);
            } catch (e) { /* ignore */ }
        });
    }

    if (document.readyState !== 'loading') {
        scanDOM();
    } else {
        document.addEventListener('DOMContentLoaded', scanDOM, { once: true });
    }

    // Watch for dynamically added elements after DOMContentLoaded.
    document.addEventListener('DOMContentLoaded', function () {
        var mo = new MutationObserver(scanDOM);
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }, { once: true });

})();
