// ==UserScript==
// @name         Livestream Recorder
// @namespace    https://github.com/Zero3K20/LivestreamRecorder
// @version      1.4.17
// @description  Record and download m3u8/flv/mp4/etc. live streams and WebSocket binary streams directly to disk without buffering in memory. Supports multiple concurrent downloads and a user-selected save directory.
// @author       Zero3K20
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ─── Constants ───────────────────────────────────────────────────────────────

    /** Maximum number of characters shown for a stream URL in the detected-streams list. */
    const MAX_DISPLAYED_URL_LENGTH = 55;

    /** Content-Type values that identify a live stream regardless of URL extension. */
    const STREAM_MIME_RE = /video\/x-flv|video\/mp2t|application\/(x-mpegurl|vnd\.apple\.mpegurl)/i;

    /** WebSocket URL patterns that indicate a binary media stream. */
    const WS_STREAM_RE = /\.(flv|ts|m4s|mp4|aac)(\?|&|$)/i;

    /** Number of binary WebSocket frames required to declare a stream (avoids one-shot control frames). */
    const WS_BINARY_DETECT_COUNT = 2;

    /** Stop watching a WebSocket for binary frames after this many total messages with no detection. */
    const WS_BINARY_GIVE_UP_COUNT = 50;

    /**
     * Maximum number of characters to scan in a fetch response body when looking for
     * embedded stream URLs (e.g. server-action JSON returning a live stream URL).
     * 500 000 chars (~500 KB) comfortably covers typical API/RSC payloads while
     * preventing excessive memory use on large page responses.
     */
    const MAX_RESPONSE_BODY_SCAN_CHARS = 500000;

    /**
     * Maximum number of characters to scan in a Worker postMessage payload.
     * Player init messages (e.g. mpegts.js) are always tiny; 200 000 chars is
     * generous while keeping overhead negligible for any unexpectedly large message.
     */
    const MAX_WORKER_MSG_SCAN_CHARS = 200000;

    // When @grant directives are present, some userscript managers (Violentmonkey,
    // Greasemonkey on Firefox) run the script in a sandboxed context where `window`
    // is a proxy wrapper.  Replacing window.fetch or window.WebSocket on that proxy
    // only affects the sandbox — the real page code still calls the originals.
    // `unsafeWindow` is the real page window and must be used for all API hooks.
    const _win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // ─── State ───────────────────────────────────────────────────────────────────

    /** @type {FileSystemDirectoryHandle|null} */
    let downloadDirHandle = null;

    /**
     * Map of active downloads.
     * id → { id, url, filename, status, bytesWritten, stopSignal }
     * @type {Map<number, object>}
     */
    const activeDownloads = new Map();

    /** Set of stream URLs discovered on the page. @type {Set<string>} */
    const detectedStreams = new Set();

    /**
     * Map of live WebRTC MediaStream objects keyed by their synthetic `webrtc://` URL.
     * Populated by the srcObject hook; used by downloadMediaRecorder.
     * @type {Map<string, MediaStream>}
     */
    const _webrtcStreams = new Map();

    /** MIME types associated with detected stream URLs. @type {Map<string, string>} */
    const streamMimeTypes = new Map();

    /**
     * Directory prefixes of detected .m3u8 playlists, used to suppress individual
     * .ts segment URLs from flooding the detected-streams list.
     * @type {Set<string>}
     */
    const detectedM3U8Prefixes = new Set();

    /**
     * Inner URLs that are already wrapped by a detected proxy URL
     * (e.g. the `url=` query parameter value of a detected `/api/stream?url=<inner>` URL).
     * Any URL in this set is suppressed from being added as a standalone detected stream
     * because the proxy URL supersedes it and is what the user should record.
     * @type {Set<string>}
     */
    const _proxiedInnerURLs = new Set();

    /**
     * Stable identifier for this tab session.  sessionStorage retains the value
     * across same-tab page refreshes but never shares it with other tabs, so
     * downloads started in this tab are only visible here.
     */
    const TAB_ID = (() => {
        let id = sessionStorage.getItem('__LSR_tabId__');
        if (!id) {
            id = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : Date.now().toString(36) + Math.random().toString(36).slice(2);
            sessionStorage.setItem('__LSR_tabId__', id);
        }
        return id;
    })();

    /** GM storage keys for detected streams scoped to this tab so stream lists don't leak across tabs. */
    const STREAMS_GM_KEY   = '__LSR_streams_'   + TAB_ID + '__';
    const MIMES_GM_KEY     = '__LSR_mimes_'     + TAB_ID + '__';
    const M3U8_PFX_GM_KEY  = '__LSR_m3u8pfx_'  + TAB_ID + '__';

    /** GM storage keys for downloads scoped to this tab so downloads don't leak across tabs. */
    const DOWNLOADS_GM_KEY  = '__LSR_downloads_' + TAB_ID + '__';
    const NEXT_ID_GM_KEY    = '__LSR_nextId_'    + TAB_ID + '__';

    /** Original WebSocket constructor saved before hooking, used by downloadWebSocket. */
    const _OrigWebSocket = (typeof _win.WebSocket !== 'undefined') ? _win.WebSocket : null;

    let nextId = 1;

    // ─── Utility helpers ─────────────────────────────────────────────────────────

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
        return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    function resolveURL(base, url) {
        try { return new URL(url, base).href; } catch { return url; }
    }

    function sanitizeFilename(name) {
        return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 200);
    }

    function generateFilename(url, ext) {
        let base;
        try {
            const u = new URL(url);
            base = u.pathname.split('/').pop().replace(/\.[^.]+$/, '') || u.hostname;
        } catch {
            base = 'stream';
        }
        const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        return sanitizeFilename(`${base}_${ts}.${ext}`);
    }

    /** Returns the directory prefix of a URL (origin + path up to the last slash). */
    function getURLDirectory(url) {
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/');
            parts.pop(); // remove filename
            return u.origin + parts.join('/') + '/';
        } catch { return null; }
    }

    function escapeHTML(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** Returns a debounced wrapper of `fn` that fires after `delay` ms of inactivity. */
    function _debounce(fn, delay) {
        let timer;
        return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
    }

    // ─── GM_xmlhttpRequest wrapper ────────────────────────────────────────────────

    /**
     * Fetch a URL via GM_xmlhttpRequest (bypasses CORS).
     * @param {string} url
     * @param {{ method?: string, responseType?: string, headers?: object, rangeStart?: number, rangeEnd?: number }} [opts]
     * @returns {Promise<{status: number, response: any, responseText: string}>}
     */
    function gmFetch(url, opts = {}) {
        const { method = 'GET', responseType = 'text', headers = {}, rangeStart, rangeEnd } = opts;
        const reqHeaders = Object.assign({}, headers);
        if (rangeStart !== undefined) {
            const end = rangeEnd !== undefined ? rangeEnd : '';
            reqHeaders['Range'] = `bytes=${rangeStart}-${end}`;
        }
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                responseType,
                headers: reqHeaders,
                onload(r) {
                    if (r.status >= 200 && r.status < 300) resolve(r);
                    else {
                        const err = new Error(`HTTP ${r.status} for ${url}`);
                        // Flag 403 responses so callers can apply the page-fetch
                        // fallback — GM_xmlhttpRequest lacks the browser's cookie/
                        // session context and auto-sent headers (Referer, Origin)
                        // that streaming proxy servers often require.
                        if (r.status === 403) err.isGmForbidden = true;
                        reject(err);
                    }
                },
                onerror(e) {
                    const err = new Error(`Network error: ${JSON.stringify(e)}`);
                    // Flag network-level failures (status 0) so callers can distinguish
                    // them from HTTP errors and apply fallback strategies.
                    err.isGmNetworkError = true;
                    reject(err);
                },
                ontimeout() { reject(new Error(`Timeout for ${url}`)); },
            });
        });
    }

    // ─── M3U8 parser ─────────────────────────────────────────────────────────────

    /**
     * Parse an HLS playlist text.
     * Returns either a master-playlist descriptor or a media-playlist descriptor.
     * @param {string} text
     * @param {string} baseURL
     */
    function parseM3U8(text, baseURL) {
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));

        if (isMaster) {
            const streams = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                    const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                    const resMatch = lines[i].match(/RESOLUTION=([^\s,]+)/);
                    const uri = lines[i + 1] && !lines[i + 1].startsWith('#')
                        ? resolveURL(baseURL, lines[i + 1])
                        : null;
                    if (uri) {
                        streams.push({
                            bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
                            resolution: resMatch ? resMatch[1] : null,
                            uri,
                        });
                    }
                }
            }
            streams.sort((a, b) => b.bandwidth - a.bandwidth);
            return { type: 'master', streams };
        }

        const segments = [];
        let targetDuration = 5;
        let isEndList = false;
        let mediaSequence = 0;
        let segDuration = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('#EXT-X-TARGETDURATION:')) {
                targetDuration = parseInt(line.split(':')[1], 10) || 5;
            } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                mediaSequence = parseInt(line.split(':')[1], 10) || 0;
            } else if (line === '#EXT-X-ENDLIST') {
                isEndList = true;
            } else if (line.startsWith('#EXTINF:')) {
                segDuration = parseFloat(line.split(':')[1]) || targetDuration;
            } else if (!line.startsWith('#')) {
                segments.push({
                    uri: resolveURL(baseURL, line),
                    duration: segDuration || targetDuration,
                    sequence: mediaSequence + segments.length,
                });
                segDuration = null;
            }
        }

        return { type: 'media', segments, targetDuration, isEndList };
    }

    // ─── HLS / m3u8 downloader ────────────────────────────────────────────────────

    /**
     * Download an HLS stream segment-by-segment, writing each segment directly to
     * the FileSystemWritableFileStream so nothing large stays in memory.
     *
     * @param {string} url - URL of the m3u8 playlist (master or media).
     * @param {FileSystemFileHandle} fileHandle
     * @param {function(number): void} onProgress - called with bytes written per chunk
     * @param {{ stopped: boolean }} stopSignal
     * @param {{ keepExisting?: boolean, seekOffset?: number }} [opts] - resume options
     */
    async function downloadHLS(url, fileHandle, onProgress, stopSignal, opts = {}) {
        const { keepExisting = false, seekOffset = 0 } = opts;
        const writable = await fileHandle.createWritable({ keepExistingData: keepExisting });
        if (seekOffset > 0) await writable.seek(seekOffset);
        // Track downloaded segment sequence numbers to avoid duplicates on live playlists.
        let lastDownloadedSequence = -1;
        let targetDuration = 5;
        let consecutiveErrors = 0;

        try {
            // Resolve master playlist to the best-quality media playlist URL.
            let mediaURL = url;
            const initial = await gmFetch(url);
            const initialParsed = parseM3U8(initial.responseText, url);
            if (initialParsed.type === 'master') {
                if (initialParsed.streams.length === 0) throw new Error('No streams found in master playlist');
                mediaURL = initialParsed.streams[0].uri; // highest bandwidth
            }

            while (!stopSignal.stopped) {
                let playlistText;
                try {
                    const r = await gmFetch(mediaURL);
                    playlistText = r.responseText;
                    consecutiveErrors = 0;
                } catch (e) {
                    consecutiveErrors++;
                    if (consecutiveErrors > 5) throw e;
                    await sleep(targetDuration * 1000);
                    continue;
                }

                const playlist = parseM3U8(playlistText, mediaURL);
                targetDuration = playlist.targetDuration;

                for (const seg of playlist.segments) {
                    if (stopSignal.stopped) break;
                    if (seg.sequence <= lastDownloadedSequence) continue;

                    try {
                        const segResp = await gmFetch(seg.uri, { responseType: 'arraybuffer' });
                        // Write directly to disk; the ArrayBuffer is released after this await.
                        await writable.write(segResp.response);
                        lastDownloadedSequence = seg.sequence;
                        onProgress(segResp.response.byteLength);
                    } catch (e) {
                        console.warn('[LivestreamRecorder] Skipping segment after error:', seg.uri, e.message);
                    }
                }

                if (playlist.isEndList) break;

                // Poll again after half the target-duration window.
                await sleep((targetDuration / 2) * 1000);
            }
        } finally {
            await writable.close();
        }
    }

    // ─── Direct stream downloader (flv / mp4 / etc.) ─────────────────────────────

    /**
     * Download a URL using the page's native `fetch` API (accessed via `_win.fetch`),
     * reading the response as a `ReadableStream` and writing each chunk to disk as it
     * arrives.
     *
     * This is used as a fallback when `GM_xmlhttpRequest` fails with a network error
     * (status 0).  The most common cause is that Tampermonkey internally rebuilds
     * URLs via `URLSearchParams`, which percent-encodes characters like `:` and `/`
     * in query-parameter values — turning `?url=http://…` into `?url=http%3A%2F%2F…`.
     * Proxy servers that do not URL-decode their parameters then receive an invalid
     * inner URL and close the connection before sending any HTTP response.  The
     * browser's native `fetch` uses the URL's `.href` representation (which preserves
     * those characters) so the server receives the URL exactly as intended.
     *
     * Because this runs in the page context it is subject to CORS, but streaming
     * proxy APIs that web players already access cross-origin typically allow it.
     *
     * @param {string} url
     * @param {FileSystemWritableFileStream} writable  - already open, caller closes it
     * @param {function(number): void} onProgress
     * @param {{ stopped: boolean }} stopSignal
     */
    async function _downloadViaPageFetch(url, writable, onProgress, stopSignal) {
        if (typeof _win.fetch !== 'function') throw new Error('Page fetch not available');
        const response = await _win.fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        if (!response.body) throw new Error('Response body not available');

        const reader = response.body.getReader();
        try {
            while (!stopSignal.stopped) {
                const { done, value } = await reader.read();
                if (done) break;
                await writable.write(value);
                onProgress(value.byteLength);
            }
        } finally {
            // cancel() tells the browser it can discard any buffered/upcoming data.
            // Errors here (e.g. stream already closed) are harmless — the file write
            // already completed (or was intentionally stopped), so we suppress them.
            reader.cancel().catch(() => {});
        }
    }

    /**
     * Download a direct stream URL in fixed-size chunks using HTTP Range requests,
     * writing each chunk to disk immediately to avoid buffering the whole file.
     * Falls back to a single-request download if the server does not support
     * Range requests (common for live flv push streams).
     *
     * @param {string} url
     * @param {FileSystemFileHandle} fileHandle
     * @param {function(number): void} onProgress
     * @param {{ stopped: boolean }} stopSignal
     * @param {{ startOffset?: number }} [opts] - resume options
     */
    async function downloadDirect(url, fileHandle, onProgress, stopSignal, opts = {}) {
        const { startOffset = 0 } = opts;
        const writable = await fileHandle.createWritable({ keepExistingData: startOffset > 0 });
        if (startOffset > 0) await writable.seek(startOffset);
        const CHUNK = 4 * 1024 * 1024; // 4 MB per Range request

        try {
            // Try a HEAD request to find out the content length and whether Range is supported.
            let totalSize = null;
            let supportsRange = false;
            try {
                const head = await gmFetch(url, { method: 'HEAD' });
                const cl = head.responseHeaders && head.responseHeaders.match(/content-length:\s*(\d+)/i);
                if (cl) totalSize = parseInt(cl[1], 10);
                const ar = head.responseHeaders && head.responseHeaders.match(/accept-ranges:\s*bytes/i);
                if (ar) supportsRange = true;
            } catch {
                // HEAD not supported or failed — fall through to single GET.
            }

            if (supportsRange && totalSize !== null) {
                // Chunked Range download — nothing large sits in memory at once.
                // On resume, startOffset lets us skip already-downloaded bytes.
                let offset = startOffset;
                while (offset < totalSize && !stopSignal.stopped) {
                    const end = Math.min(offset + CHUNK - 1, totalSize - 1);
                    const r = await gmFetch(url, { responseType: 'arraybuffer', rangeStart: offset, rangeEnd: end });
                    await writable.write(r.response);
                    onProgress(r.response.byteLength);
                    offset += r.response.byteLength;
                }
            } else {
                // Single GET (live push streams, servers without Range support).
                // Try GM_xmlhttpRequest first.  If it fails with a network error
                // (status 0) — which can happen when Tampermonkey re-encodes query
                // parameters via URLSearchParams, corrupting URLs like
                // `?url=http://…` into `?url=http%3A%2F%2F…` — fall back to the
                // page's native fetch, which preserves the URL as-is.
                try {
                    const r = await gmFetch(url, { responseType: 'arraybuffer' });
                    if (!stopSignal.stopped) {
                        await writable.write(r.response);
                        onProgress(r.response.byteLength);
                    }
                } catch (e) {
                    if (!e.isGmNetworkError && !e.isGmForbidden) throw e;
                    // GM_xmlhttpRequest network error or 403 — fall back to page fetch.
                    // 403 typically means the proxy requires cookies/session context or
                    // headers (Referer, Origin) that the browser sends automatically but
                    // GM_xmlhttpRequest omits.  The page's native fetch runs in the full
                    // browser context and includes those headers.
                    if (!stopSignal.stopped) {
                        await _downloadViaPageFetch(url, writable, onProgress, stopSignal);
                    }
                }
            }
        } finally {
            await writable.close();
        }
    }

    // ─── WebSocket stream downloader ──────────────────────────────────────────────

    /**
     * Record a WebSocket-based binary stream by opening a new connection and writing
     * all received binary frames to disk as they arrive.  Text frames are ignored.
     * Cannot be resumed after disconnection because the stream is live.
     *
     * @param {string} url - ws:// or wss:// URL
     * @param {FileSystemFileHandle} fileHandle
     * @param {function(number): void} onProgress
     * @param {{ stopped: boolean }} stopSignal
     */
    async function downloadWebSocket(url, fileHandle, onProgress, stopSignal) {
        if (!_OrigWebSocket) throw new Error('WebSocket is not available in this environment');
        const writable = await fileHandle.createWritable({ keepExistingData: false });
        try {
            await new Promise((resolve, reject) => {
                const ws = new _OrigWebSocket(url);
                ws.binaryType = 'arraybuffer';
                let stopCheckTimer = null;

                const cleanup = () => {
                    if (stopCheckTimer !== null) { clearInterval(stopCheckTimer); stopCheckTimer = null; }
                };

                ws.onmessage = async (e) => {
                    if (stopSignal.stopped) { ws.close(); return; }
                    if (!(e.data instanceof ArrayBuffer) || e.data.byteLength === 0) return;
                    try {
                        await writable.write(e.data);
                        onProgress(e.data.byteLength);
                    } catch (writeErr) {
                        cleanup();
                        ws.close();
                        reject(writeErr);
                    }
                };

                ws.onerror = () => { cleanup(); reject(new Error('WebSocket connection failed')); };
                ws.onclose = (e) => {
                    cleanup();
                    if (stopSignal.stopped || e.wasClean) resolve();
                    else reject(new Error(`WebSocket closed unexpectedly (code ${e.code})`));
                };

                // Poll the stop signal so the connection is closed promptly when
                // the user clicks Stop.
                stopCheckTimer = setInterval(() => {
                    if (stopSignal.stopped) ws.close();
                }, 250);
            });
        } finally {
            await writable.close();
        }
    }

    // ─── WebRTC stream recorder (MediaRecorder) ───────────────────────────────────

    /**
     * Record a live WebRTC MediaStream using the browser's MediaRecorder API.
     * Each data chunk is written directly to disk as it arrives.
     * Cannot be resumed after stopping because the stream is live.
     *
     * @param {string} url - synthetic webrtc:// URL used as the MediaStream key
     * @param {FileSystemFileHandle} fileHandle
     * @param {function(number): void} onProgress
     * @param {{ stopped: boolean }} stopSignal
     */
    async function downloadMediaRecorder(url, fileHandle, onProgress, stopSignal) {
        const stream = _webrtcStreams.get(url);
        if (!stream) throw new Error('WebRTC stream is no longer available (reload the page and try again)');
        const writable = await fileHandle.createWritable({ keepExistingData: false });
        try {
            await new Promise((resolve, reject) => {
                const mimeType = [
                    'video/webm;codecs=vp9,opus',
                    'video/webm;codecs=vp8,opus',
                    'video/webm',
                ].find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) || 'video/webm';

                let recorder;
                try {
                    recorder = new MediaRecorder(stream, { mimeType });
                } catch (e) {
                    reject(new Error('MediaRecorder creation failed: ' + e.message));
                    return;
                }

                let stopCheckTimer = null;

                const clearStopTimer = () => {
                    if (stopCheckTimer !== null) { clearInterval(stopCheckTimer); stopCheckTimer = null; }
                };

                recorder.ondataavailable = async (e) => {
                    if (!e.data || e.data.size === 0) return;
                    try {
                        const buf = await e.data.arrayBuffer();
                        await writable.write(buf);
                        onProgress(buf.byteLength);
                    } catch (writeErr) {
                        clearStopTimer();
                        if (recorder.state !== 'inactive') recorder.stop();
                        reject(writeErr);
                    }
                };

                recorder.onerror = (e) => {
                    clearStopTimer();
                    reject(e.error || new Error('MediaRecorder error'));
                };

                recorder.onstop = resolve;

                // 500 ms chunks give smooth progress updates without excessive overhead.
                recorder.start(500);

                stopCheckTimer = setInterval(() => {
                    if (stopSignal.stopped && recorder.state !== 'inactive') {
                        clearStopTimer();
                        recorder.stop();
                    }
                }, 250);
            });
        } finally {
            await writable.close();
        }
    }

    // ─── Start / stop downloads ───────────────────────────────────────────────────

    /** Creates the standard progress callback used by both startDownload and resumeDownload. */
    function _makeProgressCallback(dl) {
        return (bytes) => { dl.bytesWritten += bytes; updateUI(); _debouncedPersistDownloads(); };
    }

    async function startDownload(url) {
        if (!downloadDirHandle) {
            alert('[Livestream Recorder] Please select a download directory first.');
            return;
        }

        // Re-request write permission only when needed (e.g. new tab loaded a stored
        // handle whose permission state is 'prompt').  requestPermission is safe here
        // because startDownload is always triggered by a user gesture (button click).
        // We skip the round-trip when permission is already 'granted' so normal
        // same-tab downloads are unaffected.  If requestPermission throws for any
        // reason we warn and continue — the actual file write will surface a real
        // permission error if one exists, and the download entry will still be
        // recorded so it persists across refreshes.
        try {
            const currentPerm = await downloadDirHandle.queryPermission({ mode: 'readwrite' });
            if (currentPerm !== 'granted') {
                const newPerm = await downloadDirHandle.requestPermission({ mode: 'readwrite' });
                if (newPerm !== 'granted') {
                    alert('[Livestream Recorder] Write permission to the download directory was denied.');
                    return;
                }
            }
        } catch (e) {
            console.warn('[LivestreamRecorder] Permission check failed, attempting download anyway:', e);
        }

        const id = nextId++;
        const mime = streamMimeTypes.get(url) || '';
        const isWS     = /^wss?:\/\//i.test(url);
        const isWebRTC = url.startsWith('webrtc://');
        const isHLS    = !isWS && !isWebRTC && (/\.m3u8(\?|$)/i.test(url) || /[?&].*m3u8/i.test(url) ||
                          /application\/(x-mpegurl|vnd\.apple\.mpegurl)/i.test(mime));
        let ext = isHLS ? 'ts' : isWebRTC ? 'webm' : 'mp4';
        if (isWS) {
            try {
                const pathname = new URL(url).pathname;
                const raw = pathname.split('.').pop().split('?')[0].toLowerCase();
                ext = /^[a-z0-9]{2,5}$/.test(raw) ? raw : 'bin';
            } catch { ext = 'bin'; }
        } else if (!isHLS && !isWebRTC) {
            if (/video\/x-flv/i.test(mime)) {
                ext = 'flv';
            } else {
                try {
                    const pathname = new URL(url).pathname;
                    const raw = pathname.split('.').pop().split('?')[0].toLowerCase();
                    // Accept 2-5 character extensions (covers common formats like .ts, .mp4, .webm, .m4s).
                    ext = /^[a-z0-9]{2,5}$/.test(raw) ? raw : 'mp4';
                } catch { ext = 'mp4'; }
            }
        }

        const filename = generateFilename(url, ext);
        const stopSignal = { stopped: false };
        const dl = {
            id,
            url,
            filename,
            isHLS,
            isWS,
            isWebRTC,
            status: 'downloading',
            bytesWritten: 0,
            stopSignal,
            stop() {
                stopSignal.stopped = true;
                dl.status = 'stopped';
                updateUI();
                _persistDownloads();
            },
        };

        activeDownloads.set(id, dl);
        updateUI();
        _persistDownloads();

        try {
            const fileHandle = await downloadDirHandle.getFileHandle(filename, { create: true });
            const onProgress = _makeProgressCallback(dl);

            if (isHLS) {
                await downloadHLS(url, fileHandle, onProgress, stopSignal);
            } else if (isWS) {
                await downloadWebSocket(url, fileHandle, onProgress, stopSignal);
            } else if (isWebRTC) {
                await downloadMediaRecorder(url, fileHandle, onProgress, stopSignal);
            } else {
                await downloadDirect(url, fileHandle, onProgress, stopSignal);
            }

            if (!stopSignal.stopped) dl.status = 'completed';
        } catch (e) {
            console.error('[LivestreamRecorder] Download error:', e);
            dl.status = 'error: ' + e.message;
        }

        updateUI();
        _persistDownloads();
    }

    // ─── Stream detection ─────────────────────────────────────────────────────────

    const STREAM_RE = /\.(m3u8|flv|mpd|ts)(\?|&|$)/i;

    function isStreamURL(url) {
        if (typeof url !== 'string') return false;
        if (STREAM_RE.test(url)) return true;
        // Scan decoded query-parameter values for embedded stream filenames,
        // e.g. ?stream=roomid.flv&token=xxx  or  ?url=https%3A%2F%2Fcdn%2Fstream.flv
        // Only attempt URL parsing when a query string is actually present.
        if (url.indexOf('?') !== -1) {
            try {
                const params = new URL(url).searchParams;
                for (const v of params.values()) {
                    if (STREAM_RE.test(v)) return true;
                }
            } catch { /* ignore unparseable URLs */ }
        }
        return false;
    }

    /** Returns true for ws:// / wss:// URLs that look like binary media streams. */
    function isWebSocketStreamURL(url) {
        if (typeof url !== 'string' || !/^wss?:\/\//i.test(url)) return false;
        return WS_STREAM_RE.test(url) || /\/(live|stream|push|play|video)\//i.test(url);
    }

    /**
     * Add a stream URL to the detected list.
     * Suppresses individual .ts segments when the parent .m3u8 playlist has already
     * been detected (same directory prefix).
     * @param {string} url
     * @param {string} [mimeType]
     */
    function addDetectedStream(url, mimeType) {
        if (typeof url !== 'string' || !/^(https?|wss?|webrtc):/.test(url)) return;

        const isM3U8 = /\.m3u8(\?|$)/i.test(url);
        const isTS   = /\.ts(\?|$)/i.test(url);

        // Track m3u8 directory prefixes so we can suppress individual segments.
        if (isM3U8) {
            const dir = getURLDirectory(url);
            if (dir) detectedM3U8Prefixes.add(dir);
        }

        // Suppress .ts segments that belong to a known HLS playlist directory.
        if (isTS) {
            const dir = getURLDirectory(url);
            if (dir && detectedM3U8Prefixes.has(dir)) return;
        }

        // Suppress inner URLs that are already wrapped by a detected proxy URL.
        // Some sites (e.g. pc.mliveh5.com) expose a proxy endpoint of the form
        //   /api/stream?url=<inner-stream-url>
        // The response body scanner may detect the inner stream URL from an API
        // response before the proxy URL is detected via the worker postMessage hook.
        // Recording the inner URL directly would fail (403); only the proxy URL works.
        if (_proxiedInnerURLs.has(url)) return;

        if (!detectedStreams.has(url)) {
            // If this URL is a proxy wrapper with a `url=<inner>` parameter, record
            // the inner URL as superseded and remove it from the detected set if it
            // was added earlier (inner URL detected before proxy URL).
            try {
                const inner = new URL(url).searchParams.get('url');
                if (inner) {
                    _proxiedInnerURLs.add(inner);
                    if (detectedStreams.has(inner)) {
                        detectedStreams.delete(inner);
                        streamMimeTypes.delete(inner);
                    }
                }
            } catch { /* ignore malformed URLs */ }

            if (mimeType) streamMimeTypes.set(url, mimeType);
            detectedStreams.add(url);
            updateUI();
            _debouncedPersistStreams();
        }
    }

    /**
     * Scan a block of text (JSON body, RSC payload, Worker postMessage data, etc.)
     * for embedded stream URLs.  Finds raw http/https URLs containing stream file
     * extensions so we can detect streams that are delivered inside API responses
     * or forwarded to Web Worker threads rather than flowing through XHR/fetch
     * directly (e.g. mpegts.js with enableWorker:true).
     * @param {string} text
     */
    function scanTextForStreamURLs(text) {
        const re = /https?:\/\/[^\s"'<>\\{}[\]|^`\x00-\x1f]{5,}/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
            try {
                // Trim any trailing JSON/text punctuation that got included.
                const candidate = m[0].replace(/[)\]}>,"':;\\]+$/, '');
                if (candidate && isStreamURL(candidate)) addDetectedStream(candidate);
            } catch { /* ignore */ }
        }
    }

    // Hook XMLHttpRequest — URL-pattern check on open(); MIME-type check on send().
    const _xhrOpen = _win.XMLHttpRequest.prototype.open;
    _win.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        try {
            const full = resolveURL(location.href, String(url));
            this._lsrUrl = full;
            if (isStreamURL(full)) addDetectedStream(full);
        } catch { /* ignore */ }
        return _xhrOpen.call(this, method, url, ...rest);
    };

    const _xhrSend = _win.XMLHttpRequest.prototype.send;
    _win.XMLHttpRequest.prototype.send = function (...args) {
        const lsrUrl = this._lsrUrl;
        if (lsrUrl) {
            // Use a named handler so it can remove itself after firing once.
            const onStateChange = function () {
                if (this.readyState === /* HEADERS_RECEIVED */ 2) {
                    this.removeEventListener('readystatechange', onStateChange);
                    try {
                        const ct = this.getResponseHeader('Content-Type') || '';
                        if (STREAM_MIME_RE.test(ct)) addDetectedStream(lsrUrl, ct);
                    } catch { /* cross-origin XHR may throw */ }
                }
            };
            this.addEventListener('readystatechange', onStateChange);
        }
        return _xhrSend.apply(this, args);
    };

    // Hook fetch — URL-pattern check immediately; MIME-type check on response (only
    // when the URL didn't already match, to avoid overhead on every non-stream fetch).
    const _fetch = _win.fetch;
    _win.fetch = function (input, ...rest) {
        let full;
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            full = resolveURL(location.href, url);
        } catch { full = ''; }
        if (full) {
            const urlMatched = isStreamURL(full);
            if (urlMatched) addDetectedStream(full);
            const promise = _fetch.call(this, input, ...rest);
            if (!urlMatched) {
                // Inspect response MIME type for URLs that didn't match by extension.
                // Also scan text/JSON/RSC bodies for embedded stream URLs — this catches
                // cases where the stream URL is returned inside an API response (e.g. a
                // Next.js server-action that returns live stream data).
                promise.then((response) => {
                    try {
                        const ct = response.headers.get('content-type') || '';
                        if (STREAM_MIME_RE.test(ct)) {
                            addDetectedStream(full, ct);
                        } else if (/^(text\/|application\/(json|x-ndjson|x-component|x-www-form-urlencoded))/i.test(ct)) {
                            const clone = response.clone();
                            clone.text().then(text => {
                                if (text && text.length < MAX_RESPONSE_BODY_SCAN_CHARS) scanTextForStreamURLs(text);
                            }).catch(() => {});
                        }
                    } catch { /* ignore */ }
                }).catch(() => {});
            }
            return promise;
        }
        return _fetch.call(this, input, ...rest);
    };

    // Hook WebSocket — capture ws:// and wss:// stream connections.
    if (_OrigWebSocket) {
        _win.WebSocket = function (url, protocols) {
            const strUrl = String(url || '');
            const ws = protocols !== undefined
                ? new _OrigWebSocket(url, protocols)
                : new _OrigWebSocket(url);
            try {
                if (isWebSocketStreamURL(strUrl)) {
                    addDetectedStream(strUrl);
                } else {
                    // Watch for binary messages (ArrayBuffer or Blob of any size).
                    // Media streams always produce binary frames; chat/signalling
                    // WebSockets (e.g. Pusher) use only JSON text frames.
                    // Require WS_BINARY_DETECT_COUNT binary messages to avoid false-positives
                    // from one-shot binary control frames.  Give up after WS_BINARY_GIVE_UP_COUNT
                    // total messages to avoid leaking listeners on non-media sockets.
                    let binaryCount = 0;
                    let totalCount = 0;
                    const binaryDetector = function (e) {
                        totalCount++;
                        if (e.data instanceof ArrayBuffer || e.data instanceof Blob) {
                            if (++binaryCount >= WS_BINARY_DETECT_COUNT) {
                                ws.removeEventListener('message', binaryDetector);
                                addDetectedStream(strUrl);
                                return;
                            }
                        }
                        if (totalCount >= WS_BINARY_GIVE_UP_COUNT) {
                            // Too many messages without reaching the binary threshold.
                            ws.removeEventListener('message', binaryDetector);
                        }
                    };
                    ws.addEventListener('message', binaryDetector);
                }
            } catch { /* ignore hook errors */ }
            return ws;
        };
        _win.WebSocket.prototype = _OrigWebSocket.prototype;
        _win.WebSocket.CONNECTING = _OrigWebSocket.CONNECTING;
        _win.WebSocket.OPEN       = _OrigWebSocket.OPEN;
        _win.WebSocket.CLOSING    = _OrigWebSocket.CLOSING;
        _win.WebSocket.CLOSED     = _OrigWebSocket.CLOSED;
    }

    // Hook Worker.prototype.postMessage — detect stream URLs sent to Web Worker threads.
    // Some media players (e.g. mpegts.js with enableWorker:true) perform all HTTP
    // requests inside a dedicated worker, bypassing the main-thread XHR and fetch
    // hooks above.  When the main thread sends the player configuration to the worker
    // via postMessage the stream URL is visible here, so we scan the serialised data.
    const _OrigWorkerProto = _win.Worker && _win.Worker.prototype;
    if (_OrigWorkerProto && typeof _OrigWorkerProto.postMessage === 'function') {
        const _origWorkerPostMsg = _OrigWorkerProto.postMessage;
        _OrigWorkerProto.postMessage = function (data, ...rest) {
            try {
                if (data !== null && data !== undefined) {
                    const text = typeof data === 'string' ? data
                               : (typeof data === 'object' ? JSON.stringify(data) : null);
                    if (text && text.length < MAX_WORKER_MSG_SCAN_CHARS) scanTextForStreamURLs(text);
                }
            } catch { /* ignore hook errors */ }
            return _origWorkerPostMsg.apply(this, [data, ...rest]);
        };
    }

    // Hook HTMLMediaElement.srcObject — detect WebRTC streams (RTCPeerConnection).
    // WebRTC video is transported via SRTP/DTLS and never appears in the Network tab.
    // When page code does `videoEl.srcObject = mediaStream`, we capture the stream.
    const _MediaElement = _win.HTMLMediaElement;
    if (_MediaElement && _MediaElement.prototype) {
        const _srcObjDesc = Object.getOwnPropertyDescriptor(_MediaElement.prototype, 'srcObject');
        if (_srcObjDesc && _srcObjDesc.set) {
            const _origSrcObjectSet = _srcObjDesc.set;
            Object.defineProperty(_MediaElement.prototype, 'srcObject', {
                get: _srcObjDesc.get,
                set(val) {
                    try {
                        if (val instanceof _win.MediaStream && val.getVideoTracks().length > 0) {
                            const key = 'webrtc://' + _win.location.hostname + '/' + val.id;
                            if (!_webrtcStreams.has(key)) {
                                _webrtcStreams.set(key, val);
                                addDetectedStream(key);
                            }
                        }
                    } catch { /* ignore hook errors */ }
                    return _origSrcObjectSet.call(this, val);
                },
                configurable: true,
            });
        }
    }

    // Hook HTMLMediaElement.src setter — catches stream URLs assigned via `video.src = url`.
    // Complements the XHR/fetch hooks and the srcObject hook: `video.src` assignments use
    // the browser's built-in networking and never pass through XMLHttpRequest or fetch.
    if (_MediaElement && _MediaElement.prototype) {
        const _srcDesc = Object.getOwnPropertyDescriptor(_MediaElement.prototype, 'src');
        if (_srcDesc && _srcDesc.set) {
            const _origSrcSet = _srcDesc.set;
            Object.defineProperty(_MediaElement.prototype, 'src', {
                get: _srcDesc.get,
                set(val) {
                    try {
                        const full = resolveURL(location.href, String(val || ''));
                        if (isStreamURL(full)) addDetectedStream(full);
                    } catch { /* ignore hook errors */ }
                    return _origSrcSet.call(this, val);
                },
                configurable: true,
            });
        }
    }

    // Scan existing <video src> / <source src> elements, including their type attributes.
    function scanPageElements() {
        document.querySelectorAll('video[src], source[src]').forEach((el) => {
            try {
                const src  = el.src || el.getAttribute('src') || '';
                const type = el.type || el.getAttribute('type') || '';
                const full = resolveURL(location.href, src);
                if (isStreamURL(full) || STREAM_MIME_RE.test(type)) {
                    addDetectedStream(full, type || undefined);
                }
            } catch { /* ignore */ }
        });
    }

    // ─── Cross-tab directory sync (BroadcastChannel + IndexedDB) ─────────────────

    /**
     * BroadcastChannel used to propagate directory-handle changes to other tabs on
     * the same origin running this script.
     */
    const DIR_CHANNEL = new BroadcastChannel('lsr-dir-channel');

    // Shared promise for the one IDB connection used by this page.
    // All callers await the same Promise so their microtask continuations are
    // queued in FIFO order, which guarantees that IDB transactions are created
    // (and therefore committed) in exactly the order _idbPut/_idbGet were called.
    // Without this, each call opened a fresh indexedDB.open() request; if the
    // first request (e.g. from setInterval) resolved slower than a later one
    // (e.g. from clearDownloads), the later transaction would commit first,
    // and the stale snapshot from the setInterval would overwrite the cleared state.
    let _idbPromise = null;

    function _openIDB() {
        if (!_idbPromise) {
            _idbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open('LivestreamRecorder', 1);
                req.onupgradeneeded = () => req.result.createObjectStore('state');
                req.onsuccess = () => {
                    const db = req.result;
                    // If another tab opens a newer DB version, close gracefully and
                    // reset so the next call can re-connect cleanly.
                    db.onversionchange = () => { db.close(); _idbPromise = null; };
                    // Reset if the connection is closed unexpectedly.
                    db.onclose = () => { _idbPromise = null; };
                    resolve(db);
                };
                req.onerror = () => { _idbPromise = null; reject(req.error); };
            });
        }
        return _idbPromise;
    }

    /** Generic IDB put — stores `value` under `key` in the `state` object store. */
    async function _idbPut(key, value) {
        try {
            const db = await _openIDB();
            await new Promise((resolve, reject) => {
                const tx = db.transaction('state', 'readwrite');
                tx.oncomplete = resolve;
                tx.onerror  = () => reject(tx.error);
                tx.onabort  = () => reject(tx.error || new Error('IDB transaction aborted'));
                tx.objectStore('state').put(value, key);
            });
        } catch (e) {
            console.warn('[LivestreamRecorder] IDB put failed:', key, e);
        }
    }

    /** Generic IDB get — returns the value stored under `key`, or `null`. */
    async function _idbGet(key) {
        try {
            const db = await _openIDB();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction('state', 'readonly');
                const req = tx.objectStore('state').get(key);
                req.onsuccess = () => resolve(req.result ?? null);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            console.warn('[LivestreamRecorder] IDB get failed:', key, e);
            return null;
        }
    }

    async function _saveHandleToIDB(handle) { await _idbPut('dirHandle', handle); }

    async function _loadHandleFromIDB() { return _idbGet('dirHandle'); }

    /**
     * Apply a directory handle received from another tab or loaded from IDB.
     * Activates the handle when permission is already 'granted', or stores it
     * when permission is 'prompt' so that the directory name is shown and the
     * handle is ready for use the moment the user initiates an action (which
     * will trigger requestPermission at that point).
     * @param {FileSystemDirectoryHandle} handle
     */
    async function _applyDirectoryHandle(handle) {
        if (!handle) return;
        try {
            const perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm === 'granted' || perm === 'prompt') {
                downloadDirHandle = handle;
                if (elDirName) elDirName.textContent = handle.name;
            }
        } catch (e) {
            console.warn('[LivestreamRecorder] Directory handle permission check failed:', e);
        }
    }

    // ─── State persistence ────────────────────────────────────────────────────────

    /** Persist the detected-streams state to GM storage (works across all pages and userscript managers). */
    function _persistDetectedStreams() {
        try {
            GM_setValue(STREAMS_GM_KEY,  JSON.stringify([...detectedStreams]));
            GM_setValue(MIMES_GM_KEY,    JSON.stringify([...streamMimeTypes.entries()]));
            GM_setValue(M3U8_PFX_GM_KEY, JSON.stringify([...detectedM3U8Prefixes]));
        } catch (e) { console.warn('[LivestreamRecorder] GM_setValue streams failed:', e); }
    }

    /**
     * Synchronously commit the current download state to GM_setValue storage.
     * Safe to call from a `beforeunload` handler because GM_setValue is
     * synchronous in Tampermonkey/Violentmonkey and does not require an async
     * context.
     */
    function _persistDownloadsSync() {
        const snapshot = [...activeDownloads.values()].map((dl) => ({
            id:           dl.id,
            url:          dl.url,
            filename:     dl.filename,
            isHLS:        dl.isHLS,
            isWS:         dl.isWS,
            isWebRTC:     dl.isWebRTC,
            status:       dl.status,
            bytesWritten: dl.bytesWritten,
        }));
        try {
            GM_setValue(DOWNLOADS_GM_KEY, JSON.stringify(snapshot));
            GM_setValue(NEXT_ID_GM_KEY,   String(nextId));
        } catch (e) { console.warn('[LivestreamRecorder] GM_setValue flush failed:', e); }
    }

    /** Persist the download-history state to GM storage. */
    function _persistDownloads() {
        const snapshot = [...activeDownloads.values()].map((dl) => ({
            id:           dl.id,
            url:          dl.url,
            filename:     dl.filename,
            isHLS:        dl.isHLS,
            isWS:         dl.isWS,
            isWebRTC:     dl.isWebRTC,
            status:       dl.status,
            bytesWritten: dl.bytesWritten,
        }));
        try {
            GM_setValue(DOWNLOADS_GM_KEY, JSON.stringify(snapshot));
            GM_setValue(NEXT_ID_GM_KEY,   String(nextId));
        } catch (e) { console.warn('[LivestreamRecorder] GM_setValue downloads failed:', e); }
    }

    const _debouncedPersistStreams   = _debounce(_persistDetectedStreams, 500);
    const _debouncedPersistDownloads = _debounce(_persistDownloads, 500);

    /**
     * Restore persisted state on load.
     * Reads directly from GM_getValue, which is global across all pages and
     * all userscript managers — unlike IDB which can be per-page-origin.
     * Downloads that were `downloading` are marked for automatic resumption;
     * all other terminal statuses are shown as-is.
     */
    function _restoreState() {
        // Restore streams from GM storage.
        let streams = null, mimeEntries = null, m3u8Prefixes = null;
        try {
            const rawStreams = GM_getValue(STREAMS_GM_KEY, null);
            if (rawStreams) streams = JSON.parse(rawStreams);
            const rawMimes = GM_getValue(MIMES_GM_KEY, null);
            if (rawMimes) mimeEntries = JSON.parse(rawMimes);
            const rawPfx = GM_getValue(M3U8_PFX_GM_KEY, null);
            if (rawPfx) m3u8Prefixes = JSON.parse(rawPfx);
        } catch (e) { console.warn('[LivestreamRecorder] GM_getValue streams corrupt, starting fresh:', e); }

        // Restore downloads from GM storage.
        let downloads = null, savedNextId = null;
        try {
            const raw = GM_getValue(DOWNLOADS_GM_KEY, null);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    downloads = parsed;
                    const rawId = GM_getValue(NEXT_ID_GM_KEY, null);
                    if (rawId !== null) {
                        const parsedNextId = parseInt(rawId, 10);
                        if (!isNaN(parsedNextId)) savedNextId = parsedNextId;
                    }
                }
            }
        } catch (e) { console.warn('[LivestreamRecorder] GM_getValue downloads corrupt, starting fresh:', e); }

        if (Array.isArray(streams))      streams.forEach((url)      => detectedStreams.add(url));
        if (Array.isArray(mimeEntries))  mimeEntries.forEach(([url, mimeType]) => streamMimeTypes.set(url, mimeType));
        if (Array.isArray(m3u8Prefixes)) m3u8Prefixes.forEach((prefix) => detectedM3U8Prefixes.add(prefix));

        if (Array.isArray(downloads)) {
            downloads.forEach((saved) => {
                if (saved.status !== 'downloading') {
                    // Terminal entries (completed, stopped, error, interrupted) are
                    // session-only display state and are intentionally not restored
                    // across page refreshes, so that a user Clear action is never
                    // undone by a reload.
                    return;
                }
                // In-flight downloads will be auto-resumed after the directory handle is loaded.
                const stopSignal = { stopped: false };
                const dl = {
                    id:           saved.id,
                    url:          saved.url,
                    filename:     saved.filename,
                    isHLS:        saved.isHLS,
                    isWS:         saved.isWS,
                    isWebRTC:     saved.isWebRTC,
                    status:       'downloading',
                    bytesWritten: saved.bytesWritten,
                    stopSignal,
                    _isRestored:  true,
                    stop() {
                        stopSignal.stopped = true;
                        dl.status = 'stopped';
                        updateUI();
                        _persistDownloads();
                    },
                };
                activeDownloads.set(saved.id, dl);
            });
        }

        if (typeof savedNextId === 'number' && savedNextId > nextId) nextId = savedNextId;

        updateUI();
    }

    /**
     * Resume a single previously-active download after a page reload.
     * Reads the actual on-disk file size as the byte-accurate resume point so
     * any debounce lag in the last persisted `bytesWritten` value is corrected.
     * @param {object} dl - download record with `_isRestored` already deleted
     */
    async function resumeDownload(dl) {
        // No directory handle, or a live stream that cannot be seeked/resumed.
        if (!downloadDirHandle || dl.isWS || dl.isWebRTC) {
            dl.status = 'interrupted';
            updateUI();
            _persistDownloads();
            return;
        }
        try {
            const fileHandle = await downloadDirHandle.getFileHandle(dl.filename, { create: true });
            const existingFile = await fileHandle.getFile();
            const startOffset  = existingFile.size;
            // For live streams the FileSystem Access API swap file is discarded when the
            // tab closes, so existingFile.size is often 0 even though progress was made.
            // Always take the HIGHER of the persisted counter and the actual file size so
            // the display never goes backwards and is never "synced" across downloads.
            dl.bytesWritten = Math.max(dl.bytesWritten, startOffset);
            updateUI();

            const onProgress = _makeProgressCallback(dl);

            if (dl.isHLS) {
                await downloadHLS(dl.url, fileHandle, onProgress, dl.stopSignal,
                    { keepExisting: true, seekOffset: startOffset });
            } else {
                await downloadDirect(dl.url, fileHandle, onProgress, dl.stopSignal,
                    { startOffset });
            }

            if (!dl.stopSignal.stopped) dl.status = 'completed';
        } catch (e) {
            console.error('[LivestreamRecorder] Resume error:', e);
            dl.status = 'interrupted';
        }
        updateUI();
        _persistDownloads();
    }

    /**
     * After the directory handle has been applied, resume all downloads that were
     * active when the page was last unloaded.
     * Resumes concurrently (consistent with how startDownload works for multiple streams).
     * If no directory handle is available (permission lapsed), each resume call marks
     * its download as interrupted.
     */
    function _resumeRestoredDownloads() {
        const pending = [];
        for (const dl of activeDownloads.values()) {
            if (dl._isRestored) {
                delete dl._isRestored;
                pending.push(resumeDownload(dl));
            }
        }
        return Promise.all(pending);
    }

    // ─── UI ───────────────────────────────────────────────────────────────────────

    let panel = null;
    let elDetected = null;
    let elActive = null;
    let elDirName = null;
    let minimized = false;

    const CSS = `
#lsr-panel {
    position: fixed; top: 20px; right: 20px; z-index: 2147483647;
    background: #1a1a2e; color: #e0e0e0;
    border: 1px solid #444; border-radius: 8px; width: 330px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; box-shadow: 0 4px 20px rgba(0,0,0,.6); user-select: none;
}
#lsr-header {
    background: #16213e; padding: 8px 12px; border-radius: 8px 8px 0 0;
    cursor: move; display: flex; align-items: center; justify-content: space-between;
}
#lsr-header-title { font-weight: bold; font-size: 14px; }
#lsr-header-btns button {
    background: none; border: none; color: #aaa; cursor: pointer;
    font-size: 15px; padding: 0 5px; line-height: 1;
}
#lsr-header-btns button:hover { color: #fff; }
#lsr-body { padding: 10px; }
#lsr-body.lsr-hidden { display: none; }
.lsr-section { margin-bottom: 10px; }
.lsr-label {
    font-size: 11px; color: #7f8c8d; text-transform: uppercase;
    letter-spacing: .5px; margin-bottom: 4px;
}
.lsr-btn {
    background: #0f3460; color: #e0e0e0; border: 1px solid #1a5276;
    border-radius: 4px; padding: 5px 10px; cursor: pointer; font-size: 12px;
    width: 100%; text-align: left; box-sizing: border-box;
}
.lsr-btn:hover { background: #1a5276; }
.lsr-dir-name { font-size: 11px; color: #7f8c8d; margin-top: 4px; word-break: break-all; }
.lsr-stream-item {
    background: #0d1b2a; border: 1px solid #2c3e50; border-radius: 4px;
    padding: 5px 8px; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;
}
.lsr-stream-url {
    flex: 1; font-size: 11px; color: #aaa;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lsr-record-btn {
    background: #1e8449; border: none; color: #fff;
    padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; flex-shrink: 0;
}
.lsr-record-btn:hover { background: #27ae60; }
.lsr-active-item {
    background: #0d1b2a; border: 1px solid #2c3e50; border-radius: 4px;
    padding: 5px 8px; margin-bottom: 4px;
}
.lsr-active-name {
    font-size: 11px; font-weight: bold;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lsr-active-row {
    display: flex; justify-content: space-between; align-items: center; margin-top: 3px;
}
.lsr-active-size { font-size: 11px; color: #7f8c8d; }
.lsr-active-status { font-size: 11px; }
.lsr-status-downloading { color: #3498db; }
.lsr-status-completed  { color: #27ae60; }
.lsr-status-stopped    { color: #e67e22; }
.lsr-status-interrupted{ color: #e67e22; }
.lsr-status-error      { color: #e74c3c; }
.lsr-stop-btn {
    background: #922b21; border: none; color: #fff;
    padding: 2px 7px; border-radius: 3px; cursor: pointer; font-size: 11px;
}
.lsr-stop-btn:hover { background: #c0392b; }
.lsr-add-row { display: flex; gap: 4px; margin-top: 6px; }
.lsr-url-input {
    flex: 1; background: #0d1b2a; border: 1px solid #2c3e50; border-radius: 4px;
    color: #e0e0e0; padding: 4px 6px; font-size: 11px;
}
.lsr-add-btn {
    background: #1e8449; border: none; color: #fff;
    padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; flex-shrink: 0;
}
.lsr-add-btn:hover { background: #27ae60; }
.lsr-empty { font-size: 11px; color: #5d6d7e; font-style: italic; }
.lsr-clear-btn {
    background: none; border: none; color: #5d6d7e; cursor: pointer;
    font-size: 10px; text-decoration: underline; padding: 0; float: right;
}
.lsr-clear-btn:hover { color: #e74c3c; }
`;

    function injectCSS() {
        if (document.getElementById('lsr-style')) return;
        const s = document.createElement('style');
        s.id = 'lsr-style';
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    function createPanel() {
        injectCSS();

        panel = document.createElement('div');
        panel.id = 'lsr-panel';
        panel.innerHTML = `
<div id="lsr-header">
  <span id="lsr-header-title">🎥 Livestream Recorder</span>
  <div id="lsr-header-btns">
    <button id="lsr-btn-min" title="Minimize" aria-label="Minimize panel">−</button>
    <button id="lsr-btn-close" title="Close">×</button>
  </div>
</div>
<div id="lsr-body">
  <div class="lsr-section">
    <div class="lsr-label">Download Directory</div>
    <button class="lsr-btn" id="lsr-select-dir">📂 Select Directory…</button>
    <div class="lsr-dir-name" id="lsr-dir-name">No directory selected</div>
  </div>
  <div class="lsr-section">
    <div class="lsr-label">Detected Streams <button class="lsr-clear-btn" id="lsr-clear-streams">Clear</button></div>
    <div id="lsr-detected"></div>
    <div class="lsr-add-row">
      <input class="lsr-url-input" id="lsr-manual-url" type="text" placeholder="Or paste a stream URL…"/>
      <button class="lsr-add-btn" id="lsr-add-url">Add</button>
    </div>
  </div>
  <div class="lsr-section">
    <div class="lsr-label">Downloads <button class="lsr-clear-btn" id="lsr-clear-downloads">Clear</button></div>
    <div id="lsr-active"></div>
  </div>
</div>`;

        document.body.appendChild(panel);

        elDetected = panel.querySelector('#lsr-detected');
        elActive   = panel.querySelector('#lsr-active');
        elDirName  = panel.querySelector('#lsr-dir-name');

        panel.querySelector('#lsr-select-dir').addEventListener('click', selectDirectory);
        panel.querySelector('#lsr-btn-min').addEventListener('click', toggleMinimize);
        panel.querySelector('#lsr-btn-close').addEventListener('click', () => { panel.remove(); panel = null; });
        panel.querySelector('#lsr-add-url').addEventListener('click', addManualURL);
        panel.querySelector('#lsr-manual-url').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addManualURL();
        });
        panel.querySelector('#lsr-clear-streams').addEventListener('click', clearDetectedStreams);
        panel.querySelector('#lsr-clear-downloads').addEventListener('click', clearDownloads);

        makeDraggable(panel, panel.querySelector('#lsr-header'));
        updateUI();
    }

    function addManualURL() {
        const input = panel && panel.querySelector('#lsr-manual-url');
        if (!input) return;
        const url = input.value.trim();
        if (url) { addDetectedStream(url); input.value = ''; }
    }

    function clearDetectedStreams() {
        detectedStreams.clear();
        streamMimeTypes.clear();
        detectedM3U8Prefixes.clear();
        updateUI();
        _persistDetectedStreams();
    }

    function clearDownloads() {
        // Only remove downloads that are no longer active.
        for (const [id, dl] of activeDownloads) {
            if (dl.status !== 'downloading') activeDownloads.delete(id);
        }
        updateUI();
        _persistDownloads();
    }

    function toggleMinimize() {
        minimized = !minimized;
        if (!panel) return;
        panel.querySelector('#lsr-body').classList.toggle('lsr-hidden', minimized);
        const btn = panel.querySelector('#lsr-btn-min');
        btn.textContent  = minimized ? '+' : '−';
        btn.title        = minimized ? 'Expand' : 'Minimize';
        btn.setAttribute('aria-label', minimized ? 'Expand panel' : 'Minimize panel');
    }

    async function selectDirectory() {
        if (typeof window.showDirectoryPicker === 'function') {
            try {
                downloadDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                if (elDirName) elDirName.textContent = downloadDirHandle.name;
                await _saveHandleToIDB(downloadDirHandle);
                DIR_CHANNEL.postMessage({ type: 'dirChanged', handle: downloadDirHandle });
            } catch (e) {
                if (e.name !== 'AbortError') console.error('[LivestreamRecorder]', e);
            }
            return;
        }
        alert(
            '[Livestream Recorder] The File System Access API is not available in this browser.\n' +
            'Please use Chrome 86+, Edge 86+, or another Chromium-based browser.'
        );
    }

    function makeDraggable(el, handle) {
        let ox, oy, sx, sy;
        handle.addEventListener('mousedown', (e) => {
            const r = el.getBoundingClientRect();
            ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        });
        function onMove(e) {
            el.style.left  = (ox + e.clientX - sx) + 'px';
            el.style.top   = (oy + e.clientY - sy) + 'px';
            el.style.right = 'auto';
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
    }

    function updateUI() {
        if (!panel) return;

        // Detected streams list
        if (detectedStreams.size === 0) {
            elDetected.innerHTML = '<div class="lsr-empty">Waiting for streams…</div>';
        } else {
            elDetected.innerHTML = '';
            for (const url of detectedStreams) {
                const short = url.replace(/^https?:\/\//, '').substring(0, MAX_DISPLAYED_URL_LENGTH);
                const item = document.createElement('div');
                item.className = 'lsr-stream-item';
                item.innerHTML =
                    `<span class="lsr-stream-url" title="${escapeHTML(url)}">${escapeHTML(short)}</span>` +
                    `<button class="lsr-record-btn">↓ Record</button>`;
                item.querySelector('.lsr-record-btn').addEventListener('click', () => startDownload(url));
                elDetected.appendChild(item);
            }
        }

        // Active downloads list
        if (activeDownloads.size === 0) {
            elActive.innerHTML = '<div class="lsr-empty">No active downloads</div>';
        } else {
            elActive.innerHTML = '';
            for (const dl of activeDownloads.values()) {
                const statusKey = dl.status.startsWith('error') ? 'error' : dl.status;
                const item = document.createElement('div');
                item.className = 'lsr-active-item';
                item.innerHTML =
                    `<div class="lsr-active-name" title="${escapeHTML(dl.filename)}">${escapeHTML(dl.filename)}</div>` +
                    `<div class="lsr-active-row">` +
                    `  <span class="lsr-active-size">${formatBytes(dl.bytesWritten)}</span>` +
                    `  <span class="lsr-active-status lsr-status-${escapeHTML(statusKey)}">${escapeHTML(dl.status)}</span>` +
                    (dl.status === 'downloading' ? `<button class="lsr-stop-btn">■ Stop</button>` : '') +
                    `</div>`;
                if (dl.status === 'downloading') {
                    item.querySelector('.lsr-stop-btn').addEventListener('click', () => dl.stop());
                }
                elActive.appendChild(item);
            }
        }
    }

    // ─── Tampermonkey menu command ────────────────────────────────────────────────

    GM_registerMenuCommand('Open Livestream Recorder', () => {
        if (!panel || !document.body.contains(panel)) {
            createPanel();
        } else {
            panel.style.display = panel.style.display === 'none' ? '' : 'none';
        }
    });

    // ─── Initialise ───────────────────────────────────────────────────────────────

    function init() {
        createPanel();
        scanPageElements();

        // Watch for dynamically added <video>/<source> elements.
        const mo = new MutationObserver(scanPageElements);
        mo.observe(document.documentElement, { childList: true, subtree: true });

        // Sync directory handle from other tabs in real time.
        DIR_CHANNEL.onmessage = (e) => {
            if (e.data && e.data.type === 'dirChanged' && e.data.handle) {
                _applyDirectoryHandle(e.data.handle);
            }
            // When a newly opened tab asks for the current directory, respond with
            // ours so it can pick it up without relying solely on IDB.  If multiple
            // tabs respond, _applyDirectoryHandle is idempotent for the same handle
            // so duplicate dirChanged messages are harmless.
            if (e.data && e.data.type === 'dirRequest' && downloadDirHandle) {
                DIR_CHANNEL.postMessage({ type: 'dirChanged', handle: downloadDirHandle });
            }
        };

        // Warn before navigating away while resumable (HLS/HTTP) downloads are active,
        // and do a synchronous GM_setValue flush so the resume point is up-to-date.
        // WebSocket and WebRTC downloads cannot survive page navigation (the live source
        // is destroyed), so they do not block the unload or show a warning.
        window.addEventListener('beforeunload', (e) => {
            // Always flush the current (possibly cleared) download state so that a
            // user-initiated clear is never rolled back by the page reload.
            _persistDownloadsSync();
            if (activeDownloads.size === 0) return;
            const hasResumable = [...activeDownloads.values()].some(
                (dl) => dl.status === 'downloading' && !dl.isWS && !dl.isWebRTC,
            );
            if (hasResumable) {
                // Modern browsers ignore the return value text and show their own generic
                // "Leave site?" prompt, but setting returnValue is still required to
                // trigger the dialog across all supported browsers.
                e.preventDefault();
                e.returnValue = '';
            }
        });

        // Restore state from GM storage synchronously, then load the directory
        // handle from IDB and resume any downloads that were active on last unload.
        _restoreState();
        _loadHandleFromIDB().then(async (handle) => {
            await _applyDirectoryHandle(handle);

            // If IDB didn't provide a usable handle, ask any already-open tab to
            // share its current directory so the user doesn't have to re-select.
            // If no tab responds the user will be prompted when they start a download,
            // which is the correct fallback behavior.
            if (!downloadDirHandle) {
                DIR_CHANNEL.postMessage({ type: 'dirRequest' });
            }

            _resumeRestoredDownloads();

            // The debounced save is reset by each progress event and may never fire
            // during continuous live-stream downloading.  This interval guarantees
            // that bytesWritten for every active download is persisted at least once
            // every 5 seconds, so a tab refresh always restores a reasonably fresh
            // counter for each download.
            setInterval(_persistDownloads, 5000);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
