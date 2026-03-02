// background.js — Livestream Recorder service worker
// Handles state (chrome.storage.local), cross-origin fetch, and downloads.
// Downloads are written directly to the user's chosen directory when the handle
// is available and permitted; otherwise buffered to OPFS as a fallback.
'use strict';

// ─── Storage keys ────────────────────────────────────────────────────────────

const S_STREAMS = 'lsr_streams';   // string[]
const S_MIMES   = 'lsr_mimes';     // { [url]: mimeType }
const S_DLS     = 'lsr_downloads'; // DownloadRecord[]
const S_NEXT_ID = 'lsr_nextId';    // number

/** Consecutive playlist fetch failures allowed before aborting a HLS download. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Fixed-size chunk for Range-request HTTP downloads (4 MB). */
const DIRECT_CHUNK_BYTES = 4 * 1024 * 1024;

// ─── Runtime state (reset when service worker restarts) ───────────────────────

/** Monotonically increasing download ID; re-synced from storage on each startDL. */
let nextId = 1;

/**
 * Currently running download operations.
 * @type {Map<number, { stopSignal: { stopped: boolean } }>}
 */
const activeOps = new Map();

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    } catch { base = 'stream'; }
    // Extract 'YYYY-MM-DDTHH-MM-SS' (19 characters) from the ISO timestamp for use in filenames.
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    return sanitizeFilename(`${base}_${ts}.${ext}`);
}

function parseM3U8(text, baseURL) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
        const streams = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bw = lines[i].match(/BANDWIDTH=(\d+)/);
                const uri = (lines[i + 1] && !lines[i + 1].startsWith('#'))
                    ? resolveURL(baseURL, lines[i + 1]) : null;
                if (uri) streams.push({ bandwidth: bw ? parseInt(bw[1], 10) : 0, uri });
            }
        }
        streams.sort((a, b) => b.bandwidth - a.bandwidth);
        return { type: 'master', streams };
    }

    const segments = [];
    let targetDuration = 5, isEndList = false, mediaSeq = 0, segDur = null;
    for (const line of lines) {
        if (line.startsWith('#EXT-X-TARGETDURATION:'))  targetDuration = parseInt(line.split(':')[1], 10) || 5;
        else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSeq = parseInt(line.split(':')[1], 10) || 0;
        else if (line === '#EXT-X-ENDLIST')              isEndList = true;
        else if (line.startsWith('#EXTINF:'))            segDur = parseFloat(line.split(':')[1]) || targetDuration;
        else if (!line.startsWith('#')) {
            segments.push({ uri: resolveURL(baseURL, line), sequence: mediaSeq + segments.length });
            segDur = null;
        }
    }
    return { type: 'media', segments, targetDuration, isEndList };
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function getDownloads() {
    const d = await chrome.storage.local.get(S_DLS);
    return d[S_DLS] || [];
}

async function setDownloads(arr) {
    await chrome.storage.local.set({ [S_DLS]: arr, [S_NEXT_ID]: nextId });
}

/** Atomically update a single download record by id. */
async function patchDownload(id, patch) {
    const arr = await getDownloads();
    const i = arr.findIndex((d) => d.id === id);
    if (i !== -1) Object.assign(arr[i], patch);
    await setDownloads(arr);
}

// ─── OPFS helpers ─────────────────────────────────────────────────────────────
// Used as a fallback when no directory handle is available or its permission
// has not been granted.

async function opfsGetWritable(filename, keepExisting = false, seekOffset = 0) {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(filename, { create: true });
    const w = await fh.createWritable({ keepExistingData: keepExisting });
    if (seekOffset > 0) await w.seek(seekOffset);
    return w;
}

async function opfsDelete(filename) {
    try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(filename);
    } catch { /* already gone */ }
}

// ─── IDB helpers for directory handle ────────────────────────────────────────
// The popup stores the user-selected FileSystemDirectoryHandle in IndexedDB.
// The service worker shares the same extension origin so it can read that handle
// and write downloads directly to the user's directory when permission is granted.

const IDB_NAME    = 'lsr-popup-db';
const IDB_VERSION = 1;
const IDB_STORE   = 'handles';

function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess  = () => resolve(req.result);
        req.onerror    = () => reject(req.error);
    });
}

async function idbLoadDirHandle() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get('directory');
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => reject(req.error);
    });
}

/**
 * Get a writable stream for `filename`.
 * Writes directly to the user's chosen directory if the handle is available and
 * permission is already 'granted'.  Falls back to OPFS otherwise.
 *
 * @param {string} filename
 * @returns {Promise<{ writable: FileSystemWritableFileStream, savedToDir: boolean }>}
 */
async function getWritable(filename) {
    try {
        const dirHandle = await idbLoadDirHandle();
        if (dirHandle) {
            const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
            if (perm === 'granted') {
                const fh = await dirHandle.getFileHandle(filename, { create: true });
                return { writable: await fh.createWritable(), savedToDir: true };
            }
        }
    } catch { /* fall through to OPFS */ }
    return { writable: await opfsGetWritable(filename), savedToDir: false };
}

// ─── HLS downloader ───────────────────────────────────────────────────────────

async function dlHLS(url, filename, id, stopSignal, writable) {
    let lastSeq = -1, targetDuration = 5, consecutiveErrors = 0, bytesWritten = 0;
    try {
        // Resolve master playlist → best-quality media playlist URL.
        let mediaURL = url;
        const r0 = await fetch(url);
        if (!r0.ok) throw new Error(`HTTP ${r0.status} fetching playlist`);
        const p0 = parseM3U8(await r0.text(), url);
        if (p0.type === 'master') {
            if (!p0.streams.length) throw new Error('No streams in master playlist');
            mediaURL = p0.streams[0].uri;
        }

        while (!stopSignal.stopped) {
            let playlist;
            try {
                const rp = await fetch(mediaURL);
                if (!rp.ok) throw new Error(`HTTP ${rp.status}`);
                playlist = parseM3U8(await rp.text(), mediaURL);
                targetDuration = playlist.targetDuration;
                consecutiveErrors = 0;
            } catch (e) {
                if (++consecutiveErrors > MAX_CONSECUTIVE_ERRORS) throw e;
                await sleep(targetDuration * 1000);
                continue;
            }

            for (const seg of playlist.segments) {
                if (stopSignal.stopped) break;
                if (seg.sequence <= lastSeq) continue;
                try {
                    const rs = await fetch(seg.uri);
                    if (!rs.ok) throw new Error(`HTTP ${rs.status}`);
                    const buf = await rs.arrayBuffer();
                    await writable.write(buf);
                    lastSeq = seg.sequence;
                    bytesWritten += buf.byteLength;
                    await patchDownload(id, { bytesWritten });
                } catch (e) {
                    console.warn('[LSR] Segment error:', seg.uri, e.message);
                }
            }

            if (playlist.isEndList) break;
            await sleep((targetDuration / 2) * 1000);
        }
    } finally {
        await writable.close();
    }
}

// ─── Direct HTTP downloader ───────────────────────────────────────────────────

async function dlDirect(url, filename, id, stopSignal, writable) {
    let bytesWritten = 0;
    try {
        let totalSize = null, supportsRange = false;
        try {
            const head = await fetch(url, { method: 'HEAD' });
            const cl = head.headers.get('content-length');
            if (cl) totalSize = parseInt(cl, 10);
            if (head.headers.get('accept-ranges') === 'bytes') supportsRange = true;
        } catch { /* HEAD not supported */ }

        if (supportsRange && totalSize !== null) {
            let offset = 0;
            while (offset < totalSize && !stopSignal.stopped) {
                const end = Math.min(offset + DIRECT_CHUNK_BYTES - 1, totalSize - 1);
                const r = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` } });
                if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
                const buf = await r.arrayBuffer();
                await writable.write(buf);
                bytesWritten += buf.byteLength;
                offset += buf.byteLength;
                await patchDownload(id, { bytesWritten });
            }
        } else {
            // Single GET for live-push streams that don't support Range.
            const r = await fetch(url);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const buf = await r.arrayBuffer();
            if (!stopSignal.stopped) {
                await writable.write(buf);
                bytesWritten = buf.byteLength;
                await patchDownload(id, { bytesWritten });
            }
        }
    } finally {
        await writable.close();
    }
}

// ─── WebSocket downloader ─────────────────────────────────────────────────────
// The background service worker can open WebSocket connections, so binary live
// streams continue even after the originating page is closed.

async function dlWebSocket(url, filename, id, stopSignal, writable) {
    let bytesWritten = 0;
    try {
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
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
                    bytesWritten += e.data.byteLength;
                    await patchDownload(id, { bytesWritten });
                } catch (writeErr) { cleanup(); ws.close(); reject(writeErr); }
            };

            ws.onerror  = () => { cleanup(); reject(new Error('WebSocket connection failed')); };
            ws.onclose  = (e) => {
                cleanup();
                (stopSignal.stopped || e.wasClean) ? resolve() : reject(new Error(`WebSocket closed (code ${e.code})`));
            };

            stopCheckTimer = setInterval(() => { if (stopSignal.stopped) ws.close(); }, 250);
        });
    } finally {
        await writable.close();
    }
}

// ─── Download manager ─────────────────────────────────────────────────────────

async function startDL(url, mimeType) {
    // Re-sync nextId in case the service worker was restarted since the last download.
    const stored = await chrome.storage.local.get(S_NEXT_ID);
    nextId = Math.max(nextId, stored[S_NEXT_ID] || 1);

    const id  = nextId++;
    const isWS  = /^wss?:\/\//i.test(url);
    const isHLS = !isWS && (
        /\.m3u8(\?|$)/i.test(url) ||
        /[?&].*m3u8/i.test(url) ||
        /application\/(x-mpegurl|vnd\.apple\.mpegurl)/i.test(mimeType || '')
    );

    let ext = isHLS ? 'ts' : isWS ? 'bin' : 'mp4';
    if (isWS) {
        try {
            const raw = new URL(url).pathname.split('.').pop().split('?')[0].toLowerCase();
            if (/^[a-z0-9]{2,5}$/.test(raw)) ext = raw;
        } catch { /* use 'bin' */ }
    } else if (!isHLS) {
        if (/video\/x-flv/i.test(mimeType || '')) {
            ext = 'flv';
        } else {
            try {
                const raw = new URL(url).pathname.split('.').pop().split('?')[0].toLowerCase();
                if (/^[a-z0-9]{2,5}$/.test(raw)) ext = raw;
            } catch { /* use 'mp4' */ }
        }
    }

    const filename   = generateFilename(url, ext);
    const stopSignal = { stopped: false };
    activeOps.set(id, { stopSignal });

    const dl = { id, url, filename, isHLS, isWS, status: 'downloading', bytesWritten: 0 };
    const list = await getDownloads();
    list.push(dl);
    await setDownloads(list);

    // Start the download asynchronously — it outlives the message handler.
    (async () => {
        let writable = null;
        try {
            let savedToDir = false;
            ({ writable, savedToDir } = await getWritable(filename));
            await patchDownload(id, { savedToDir });
            // Hand the writable to the downloader, which always closes it in its own
            // finally block.  Null-out our reference first so the outer finally below
            // does not attempt a second close (which would throw).
            const w = writable;
            writable = null;
            if (isHLS)     await dlHLS(url, filename, id, stopSignal, w);
            else if (isWS) await dlWebSocket(url, filename, id, stopSignal, w);
            else           await dlDirect(url, filename, id, stopSignal, w);
            await patchDownload(id, { status: stopSignal.stopped ? 'stopped' : 'completed' });
            // When the file was buffered in OPFS (no directory handle / permission),
            // automatically push it to the user's Downloads folder so it is immediately
            // visible without requiring a manual "💾 Save" click.
            if (!savedToDir) {
                try {
                    const root  = await navigator.storage.getDirectory();
                    const fh    = await root.getFileHandle(filename);
                    const file  = await fh.getFile();
                    const dlUrl = URL.createObjectURL(file);
                    const dlId  = await new Promise((resolve, reject) => {
                        chrome.downloads.download(
                            { url: dlUrl, filename, conflictAction: 'uniquify' },
                            (dlItemId) => {
                                if (chrome.runtime.lastError) {
                                    URL.revokeObjectURL(dlUrl);
                                    reject(new Error(chrome.runtime.lastError.message));
                                } else {
                                    resolve(dlItemId);
                                }
                            }
                        );
                    });
                    // Revoke the blob URL only after the download reaches a terminal
                    // state — Chrome may stream the file asynchronously after the
                    // download-created callback, so revoking early could truncate it.
                    const onDlChanged = (delta) => {
                        if (delta.id !== dlId || !delta.state) return;
                        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
                            URL.revokeObjectURL(dlUrl);
                            chrome.downloads.onChanged.removeListener(onDlChanged);
                        }
                    };
                    chrome.downloads.onChanged.addListener(onDlChanged);
                    await patchDownload(id, { autoSaved: true });
                } catch (e) {
                    console.warn('[LSR] Auto-save to Downloads folder failed:', e);
                }
            }
        } catch (e) {
            console.error('[LSR] Download error:', e);
            await patchDownload(id, { status: 'error: ' + e.message });
        } finally {
            // Close the writable only if it was never handed to a downloader
            // (e.g. getWritable succeeded but patchDownload threw before the hand-off).
            if (writable) try { await writable.close(); } catch { /* best-effort */ }
            activeOps.delete(id);
        }
    })();

    return { id, filename };
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {

    // Content script detected a stream URL.
    if (msg.type === 'addStream') {
        (async () => {
            const data = await chrome.storage.local.get([S_STREAMS, S_MIMES]);
            const streams = data[S_STREAMS] || [];
            const mimes   = data[S_MIMES]   || {};
            if (!streams.includes(msg.url)) {
                // Suppress .ts segment URLs once a .m3u8 playlist is already in the list.
                // HLS players fetch every segment individually; we only want the playlist.
                const hasM3U8    = streams.some((u) => /\.m3u8(\?|$)/i.test(u));
                const isTSSegment = /\.ts(\?|#|$)/i.test(msg.url);
                if (hasM3U8 && isTSSegment) { respond({ ok: true }); return; }

                streams.push(msg.url);
                if (msg.mimeType) mimes[msg.url] = msg.mimeType;
                await chrome.storage.local.set({ [S_STREAMS]: streams, [S_MIMES]: mimes });
            }
            respond({ ok: true });
        })();
        return true; // keep channel open for async respond
    }

    // Popup requests a download to start.
    if (msg.type === 'startDownload') {
        (async () => {
            const data  = await chrome.storage.local.get(S_MIMES);
            const mimes = data[S_MIMES] || {};
            const result = await startDL(msg.url, mimes[msg.url]);
            respond({ ok: true, ...result });
        })().catch((e) => respond({ ok: false, error: e.message }));
        return true;
    }

    // Popup requests a download to stop.
    if (msg.type === 'stopDownload') {
        const op = activeOps.get(msg.id);
        if (op) op.stopSignal.stopped = true;
        patchDownload(msg.id, { status: 'stopped' }).then(() => respond({ ok: true }));
        return true;
    }

    // Popup clears terminal download entries.
    if (msg.type === 'clearDownloads') {
        getDownloads().then((arr) => {
            const kept = arr.filter((d) => d.status === 'downloading');
            return setDownloads(kept);
        }).then(() => respond({ ok: true }));
        return true;
    }

    // Popup clears detected streams list.
    if (msg.type === 'clearStreams') {
        chrome.storage.local.set({ [S_STREAMS]: [], [S_MIMES]: {} }, () => respond({ ok: true }));
        return true;
    }

    // Popup requests deletion of an OPFS file after saving to disk.
    if (msg.type === 'deleteOPFSFile') {
        opfsDelete(msg.filename).then(() => respond({ ok: true }));
        return true;
    }
});

// Restore nextId when the service worker starts (after being terminated by Chrome).
chrome.storage.local.get(S_NEXT_ID, (data) => {
    if (data[S_NEXT_ID]) nextId = data[S_NEXT_ID];
});
