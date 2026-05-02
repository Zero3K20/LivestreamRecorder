// background.js — Livestream Recorder service worker
// Manages state (chrome.storage.local) and routes messages.
// All download execution (fetch + FileSystem writes) runs in the offscreen
// document (offscreen.js) where FileSystemWritableFileStream works correctly.
'use strict';

// ─── Storage keys ─────────────────────────────────────────────────────────────

const S_STREAMS = 'lsr_streams';   // string[]
const S_MIMES   = 'lsr_mimes';     // { [url]: mimeType }
const S_DLS     = 'lsr_downloads'; // DownloadRecord[]
const S_NEXT_ID = 'lsr_nextId';    // number

/** Monotonically increasing download ID; re-synced from storage on each startDL. */
let nextId = 1;

// ─── Offscreen retry constants ────────────────────────────────────────────────

/** How many times to retry forwarding a message to the offscreen document. */
const MAX_OFFSCREEN_MESSAGE_RETRIES = 5;
/** Milliseconds to wait between retries when offscreen is not yet ready. */
const OFFSCREEN_MESSAGE_RETRY_DELAY_MS = 100;

// ─── Utilities ────────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 200);
}

function generateFilename(url, ext) {
    let base;
    try {
        const u = new URL(url);
        base = u.pathname.split('/').pop().replace(/\.[^.]+$/, '') || u.hostname;
    } catch { base = 'stream'; }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    return sanitizeFilename(`${base}_${ts}.${ext}`);
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
    const i   = arr.findIndex((d) => d.id === id);
    if (i !== -1) Object.assign(arr[i], patch);
    await setDownloads(arr);
}

// ─── OPFS cleanup ─────────────────────────────────────────────────────────────
// Used by the deleteOPFSFile message (manual cleanup from popup Save button)
// and by the autoSave handler after a successful chrome.downloads transfer.

async function opfsDelete(filename) {
    try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(filename);
    } catch { /* already gone */ }
}

// ─── Offscreen document management ───────────────────────────────────────────
// The offscreen document runs the download engine with full DOM API access,
// which is required for FileSystemWritableFileStream on user-picked directories.

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

async function ensureOffscreen() {
    // Avoid chrome.runtime.getContexts (Chrome 116+); use try/catch so this
    // works on Chrome 109+ where chrome.offscreen was first available.
    try {
        await chrome.offscreen.createDocument({
            url:           OFFSCREEN_URL,
            reasons:       [chrome.offscreen.Reason.DOM_SCRAPING],
            justification: 'Run download engine with FileSystem Access API',
        });
    } catch (e) {
        // Chrome throws when a document already exists — that's fine.
        // Match both current and any future variations of the error robustly.
        if (e instanceof Error && /single offscreen/i.test(e.message)) return;
        throw e;
    }
}

// ─── Download manager ─────────────────────────────────────────────────────────

async function startDL(url, mimeType) {
    // Re-sync nextId in case the service worker was restarted since the last download.
    const stored = await chrome.storage.local.get(S_NEXT_ID);
    nextId = Math.max(nextId, stored[S_NEXT_ID] || 1);

    const id    = nextId++;
    const isWS  = /^wss?:\/\//i.test(url);
    const isRTMP = /^rtmps?:\/\//i.test(url);
    const isHLS = !isWS && !isRTMP && (
        /\.m3u8(\?|$)/i.test(url) ||
        /[?&].*m3u8/i.test(url)   ||
        /application\/(x-mpegurl|vnd\.apple\.mpegurl)/i.test(mimeType || '')
    );

    // RTMP streams produce FLV output (RTMPT wraps the RTMP protocol in HTTP POST requests).
    let ext = isHLS ? 'ts' : isRTMP ? 'flv' : isWS ? 'bin' : 'mp4';
    if (isWS) {
        try {
            const raw = new URL(url).pathname.split('.').pop().split('?')[0].toLowerCase();
            if (/^[a-z0-9]{2,5}$/.test(raw)) ext = raw;
        } catch { /* use 'bin' */ }
    } else if (!isHLS && !isRTMP) {
        if (/video\/x-flv/i.test(mimeType || '')) {
            ext = 'flv';
        } else {
            try {
                const raw = new URL(url).pathname.split('.').pop().split('?')[0].toLowerCase();
                if (/^[a-z0-9]{2,5}$/.test(raw)) ext = raw;
            } catch { /* use 'mp4' */ }
        }
    }

    const filename = generateFilename(url, ext);
    const dl       = { id, url, filename, isHLS, isWS, isRTMP, status: 'downloading', bytesWritten: 0 };
    const list     = await getDownloads();
    list.push(dl);
    await setDownloads(list);

    // Ensure the offscreen document exists, then delegate the actual download to it.
    // The offscreen doc sends patchDownload / autoSave messages back as it progresses.
    await ensureOffscreen();
    // Retry forwarding: createDocument resolves when the document exists, but
    // offscreen.js may not have registered its onMessage listener yet.
    // Retry a few times with a short delay to bridge that gap.
    let forwarded = false;
    for (let attempt = 0; attempt < MAX_OFFSCREEN_MESSAGE_RETRIES && !forwarded; attempt++) {
        try {
            await chrome.runtime.sendMessage({ target: 'offscreen', type: 'startDownload', id, url, filename, isHLS, isWS, isRTMP });
            forwarded = true;
        } catch {
            await new Promise((r) => setTimeout(r, OFFSCREEN_MESSAGE_RETRY_DELAY_MS));
        }
    }
    if (!forwarded) {
        console.error('[LSR] Could not forward startDownload to offscreen after retries');
        patchDownload(id, { status: 'error: offscreen unavailable' });
    }

    return { id, filename };
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {

    // ── Messages originating from the offscreen document ──────────────────────

    if (msg.target === 'background') {

        // Progress / status updates from offscreen.
        if (msg.type === 'patchDownload') {
            patchDownload(msg.id, msg.patch)
                .then(() => respond({ ok: true }))
                .catch(() => respond({ ok: false }));
            return true;
        }

        // Offscreen finished an OPFS-backed download; push it to the Downloads folder.
        if (msg.type === 'autoSave') {
            (async () => {
                try {
                    const root  = await navigator.storage.getDirectory();
                    const fh    = await root.getFileHandle(msg.filename);
                    const file  = await fh.getFile();
                    const dlUrl = URL.createObjectURL(file);
                    const dlId  = await new Promise((resolve, reject) => {
                        chrome.downloads.download(
                            { url: dlUrl, filename: msg.filename, conflictAction: 'uniquify' },
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
                    // Revoke the blob URL and clean up OPFS only after the transfer completes.
                    const onDlChanged = (delta) => {
                        if (delta.id !== dlId || !delta.state) return;
                        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
                            URL.revokeObjectURL(dlUrl);
                            chrome.downloads.onChanged.removeListener(onDlChanged);
                            if (delta.state.current === 'complete') opfsDelete(msg.filename).catch(() => {});
                        }
                    };
                    chrome.downloads.onChanged.addListener(onDlChanged);
                    await patchDownload(msg.id, { autoSaved: true });
                } catch (e) {
                    console.warn('[LSR] Auto-save to Downloads folder failed:', e);
                }
                respond({ ok: true });
            })();
            return true;
        }

        return false;
    }

    // ── Messages originating from the popup ───────────────────────────────────

    // Content script detected a stream URL.
    if (msg.type === 'addStream') {
        (async () => {
            const data    = await chrome.storage.local.get([S_STREAMS, S_MIMES]);
            const streams = data[S_STREAMS] || [];
            const mimes   = data[S_MIMES]   || {};
            if (!streams.includes(msg.url)) {
                const hasM3U8     = streams.some((u) => /\.m3u8(\?|$)/i.test(u));
                const isTSSegment = /\.ts(\?|#|$)/i.test(msg.url);
                if (hasM3U8 && isTSSegment) { respond({ ok: true }); return; }
                streams.push(msg.url);
                if (msg.mimeType) mimes[msg.url] = msg.mimeType;
                await chrome.storage.local.set({ [S_STREAMS]: streams, [S_MIMES]: mimes });
            }
            respond({ ok: true });
        })();
        return true;
    }

    // Popup requests a download to start.
    if (msg.type === 'startDownload') {
        (async () => {
            const data   = await chrome.storage.local.get(S_MIMES);
            const mimes  = data[S_MIMES] || {};
            const result = await startDL(msg.url, mimes[msg.url]);
            respond({ ok: true, ...result });
        })().catch((e) => respond({ ok: false, error: e.message }));
        return true;
    }

    // Popup requests a download to stop.
    if (msg.type === 'stopDownload') {
        // Patch status immediately so the popup reflects the stop right away.
        patchDownload(msg.id, { status: 'stopped' }).then(() => respond({ ok: true }));
        // Forward to the offscreen doc so its stop signal is set.
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'stopDownload', id: msg.id }).catch(() => {});
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

    // Popup requests deletion of an OPFS file after manually saving to disk.
    if (msg.type === 'deleteOPFSFile') {
        opfsDelete(msg.filename).then(() => respond({ ok: true }));
        return true;
    }
});

// Restore nextId when the service worker starts (after being terminated by Chrome).
chrome.storage.local.get(S_NEXT_ID, (data) => {
    if (data[S_NEXT_ID]) nextId = data[S_NEXT_ID];
});
