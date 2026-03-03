// offscreen.js — Livestream Recorder download engine
// Runs in an offscreen document (window context), so FileSystemWritableFileStream
// works correctly on user-selected directories — unlike service workers.
'use strict';

/** Consecutive playlist fetch failures allowed before aborting an HLS download. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Fixed-size chunk for Range-request HTTP downloads (4 MB). */
const DIRECT_CHUNK_BYTES = 4 * 1024 * 1024;

/** @type {Map<number, { stopSignal: { stopped: boolean } }>} */
const activeOps = new Map();

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveURL(base, url) {
    try { return new URL(url, base).href; } catch { return url; }
}

function parseM3U8(text, baseURL) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
        const streams = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bw  = lines[i].match(/BANDWIDTH=(\d+)/);
                const uri = (lines[i + 1] && !lines[i + 1].startsWith('#'))
                    ? resolveURL(baseURL, lines[i + 1]) : null;
                if (uri) streams.push({ bandwidth: bw ? parseInt(bw[1], 10) : 0, uri });
            }
        }
        streams.sort((a, b) => b.bandwidth - a.bandwidth);
        return { type: 'master', streams };
    }

    const segments = [];
    let targetDuration = 5, isEndList = false, mediaSeq = 0;
    for (const line of lines) {
        if (line.startsWith('#EXT-X-TARGETDURATION:'))   targetDuration = parseInt(line.split(':')[1], 10) || 5;
        else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSeq = parseInt(line.split(':')[1], 10) || 0;
        else if (line === '#EXT-X-ENDLIST')              isEndList = true;
        else if (!line.startsWith('#')) {
            segments.push({ uri: resolveURL(baseURL, line), sequence: mediaSeq + segments.length });
        }
    }
    return { type: 'media', segments, targetDuration, isEndList };
}

// ─── IndexedDB (shared with popup.js / background.js) ────────────────────────

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

// ─── OPFS fallback ────────────────────────────────────────────────────────────

async function opfsGetWritable(filename) {
    const root = await navigator.storage.getDirectory();
    const fh   = await root.getFileHandle(filename, { create: true });
    return fh.createWritable();
}

// ─── Writable factory ─────────────────────────────────────────────────────────
// This function works correctly here (document context) unlike in service workers,
// where createWritable() on a user-picked handle throws SecurityError.

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

// ─── Background notification ──────────────────────────────────────────────────

/** Fire-and-forget message to the background service worker. */
function notifyBg(msg) {
    chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});
}

// ─── HLS downloader ───────────────────────────────────────────────────────────

async function dlHLS(url, id, stopSignal, writable) {
    let lastSeq = -1, targetDuration = 5, consecutiveErrors = 0, bytesWritten = 0;
    try {
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
                    notifyBg({ type: 'patchDownload', id, patch: { bytesWritten } });
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

async function dlDirect(url, id, stopSignal, writable) {
    let bytesWritten = 0;
    try {
        let totalSize = null, supportsRange = false;
        try {
            const head = await fetch(url, { method: 'HEAD' });
            const cl   = head.headers.get('content-length');
            if (cl) totalSize = parseInt(cl, 10);
            if (head.headers.get('accept-ranges') === 'bytes') supportsRange = true;
        } catch { /* HEAD not supported */ }

        if (supportsRange && totalSize !== null) {
            let offset = 0;
            while (offset < totalSize && !stopSignal.stopped) {
                const end = Math.min(offset + DIRECT_CHUNK_BYTES - 1, totalSize - 1);
                const r   = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` } });
                if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
                const buf = await r.arrayBuffer();
                await writable.write(buf);
                bytesWritten += buf.byteLength;
                offset       += buf.byteLength;
                notifyBg({ type: 'patchDownload', id, patch: { bytesWritten } });
            }
        } else {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const buf = await r.arrayBuffer();
            if (!stopSignal.stopped) {
                await writable.write(buf);
                bytesWritten = buf.byteLength;
                notifyBg({ type: 'patchDownload', id, patch: { bytesWritten } });
            }
        }
    } finally {
        await writable.close();
    }
}

// ─── WebSocket downloader ─────────────────────────────────────────────────────

async function dlWebSocket(url, id, stopSignal, writable) {
    let bytesWritten = 0;
    try {
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            ws.binaryType = 'arraybuffer';
            let stopCheckTimer = null;
            const cleanup = () => { if (stopCheckTimer !== null) { clearInterval(stopCheckTimer); stopCheckTimer = null; } };

            ws.onmessage = async (e) => {
                if (stopSignal.stopped) { ws.close(); return; }
                if (!(e.data instanceof ArrayBuffer) || e.data.byteLength === 0) return;
                try {
                    await writable.write(e.data);
                    bytesWritten += e.data.byteLength;
                    notifyBg({ type: 'patchDownload', id, patch: { bytesWritten } });
                } catch (err) { cleanup(); ws.close(); reject(err); }
            };
            ws.onerror = () => { cleanup(); reject(new Error('WebSocket connection failed')); };
            ws.onclose = (e) => {
                cleanup();
                (stopSignal.stopped || e.wasClean) ? resolve() : reject(new Error(`WebSocket closed (code ${e.code})`));
            };
            stopCheckTimer = setInterval(() => { if (stopSignal.stopped) ws.close(); }, 250);
        });
    } finally {
        await writable.close();
    }
}

// ─── Download entry point ─────────────────────────────────────────────────────

async function handleStartDownload({ id, url, filename, isHLS, isWS }) {
    const stopSignal = { stopped: false };
    activeOps.set(id, { stopSignal });
    let writable = null;
    try {
        let savedToDir = false;
        ({ writable, savedToDir } = await getWritable(filename));
        notifyBg({ type: 'patchDownload', id, patch: { savedToDir } });

        const w = writable;
        writable = null; // downloader owns the writable and closes it in its finally block

        if (isHLS)     await dlHLS(url, id, stopSignal, w);
        else if (isWS) await dlWebSocket(url, id, stopSignal, w);
        else           await dlDirect(url, id, stopSignal, w);

        notifyBg({ type: 'patchDownload', id, patch: { status: stopSignal.stopped ? 'stopped' : 'completed' } });

        // For OPFS-backed downloads, signal background to push to the Downloads folder.
        if (!savedToDir) {
            notifyBg({ type: 'autoSave', id, filename });
        }
    } catch (e) {
        console.error('[LSR] Download error:', e);
        notifyBg({ type: 'patchDownload', id, patch: { status: 'error: ' + e.message } });
    } finally {
        // Close only if the writable was never handed off to a downloader.
        if (writable) try { await writable.close(); } catch { /* best-effort */ }
        activeOps.delete(id);
    }
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.target !== 'offscreen') return false;

    if (msg.type === 'startDownload') {
        handleStartDownload(msg).catch((e) => {
            notifyBg({ type: 'patchDownload', id: msg.id, patch: { status: 'error: ' + e.message } });
        });
        respond({ ok: true });
        return false;
    }

    if (msg.type === 'stopDownload') {
        const op = activeOps.get(msg.id);
        if (op) op.stopSignal.stopped = true;
        respond({ ok: true });
        return false;
    }

    return false;
});
