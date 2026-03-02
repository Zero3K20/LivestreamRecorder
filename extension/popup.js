// popup.js — Livestream Recorder extension popup
'use strict';

// ─── Storage keys (must match background.js) ─────────────────────────────────

const S_STREAMS  = 'lsr_streams';
const S_MIMES    = 'lsr_mimes';
const S_DLS      = 'lsr_downloads';
/** Persisted directory name string — reliable across popup open/close and browser restarts. */
const S_SAVE_DIR = 'lsr_save_dir';

/** Maximum URL characters shown in the detected-streams list. */
const MAX_URL_LEN = 55;

// ─── Directory handle ─────────────────────────────────────────────────────────
// The directory handle is stored in IndexedDB (extension origin) because
// FileSystemDirectoryHandle cannot be serialised into chrome.storage.
// The popup re-reads it each time it opens and requests permission if needed.

const IDB_NAME    = 'lsr-popup-db';
const IDB_VERSION = 1;
const IDB_STORE   = 'handles';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess  = () => resolve(req.result);
        req.onerror    = () => reject(req.error);
    });
}

async function loadDirHandle() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get('directory');
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => reject(req.error);
    });
}

async function saveDirHandleToIDB(handle) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(handle, 'directory');
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
    });
}

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {FileSystemDirectoryHandle|null} */
let saveDirHandleRef = null;

// ─── Utility ──────────────────────────────────────────────────────────────────

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;');
}

function formatBytes(bytes) {
    if (bytes < 1024)       return bytes + ' B';
    if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function send(msg) {
    return chrome.runtime.sendMessage(msg);
}

// ─── Save OPFS file to user directory ────────────────────────────────────────

/**
 * Read a completed download from OPFS and write it to the user's chosen
 * save directory (or prompt with showSaveFilePicker if none is selected).
 * Uses ReadableStream → FileSystemWritableFileStream so nothing large stays
 * in memory regardless of the file size.
 *
 * @param {string} filename
 */
async function saveFile(filename) {
    // Access OPFS — popup page and service worker share the same extension origin.
    let sourceHandle;
    try {
        const root = await navigator.storage.getDirectory();
        sourceHandle = await root.getFileHandle(filename, { create: false });
    } catch {
        alert('Could not find the file in temporary storage.\nThe download may have failed or already been saved.');
        return;
    }

    const file = await sourceHandle.getFile();

    // Stream the file to the destination without loading it into memory.
    const streamToWritable = async (writable) => {
        const reader = file.stream().getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await writable.write(value);
            }
            await writable.close();
        } catch (e) {
            await writable.abort(e);
            throw e;
        }
    };

    if (saveDirHandleRef) {
        // Write directly to the pre-selected directory.
        try {
            const perm = await saveDirHandleRef.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                const req = await saveDirHandleRef.requestPermission({ mode: 'readwrite' });
                if (req !== 'granted') throw new Error('Write permission denied for save directory.');
            }
            const outHandle = await saveDirHandleRef.getFileHandle(filename, { create: true });
            const writable  = await outHandle.createWritable();
            await streamToWritable(writable);
        } catch (e) {
            if (e.name !== 'AbortError') alert('Failed to save: ' + e.message);
            return;
        }
    } else {
        // No directory pre-selected — show native save dialog.
        try {
            const pickedHandle = await window.showSaveFilePicker({ suggestedName: filename });
            const writable     = await pickedHandle.createWritable();
            await streamToWritable(writable);
        } catch (e) {
            if (e.name !== 'AbortError') alert('Failed to save: ' + e.message);
            return;
        }
    }

    // Clean up the OPFS copy now that the file has been saved to disk.
    try { await send({ type: 'deleteOPFSFile', filename }); } catch { /* best-effort */ }

    // Remove the entry from the UI.
    renderDownloads();
}

// ─── Render ───────────────────────────────────────────────────────────────────

async function renderStreams() {
    const data    = await chrome.storage.local.get([S_STREAMS, S_MIMES]);
    const streams = data[S_STREAMS] || [];
    const el      = document.getElementById('detected-list');

    if (streams.length === 0) {
        el.innerHTML = '<div class="empty">Waiting for streams…</div>';
        return;
    }

    el.innerHTML = '';
    for (const url of streams) {
        const short = url.replace(/^https?:\/\//, '').substring(0, MAX_URL_LEN);
        const truncated = url.replace(/^https?:\/\//, '').length > MAX_URL_LEN;
        const item  = document.createElement('div');
        item.className = 'stream-item';
        item.innerHTML =
            `<span class="stream-url" title="${escapeHTML(url)}">${escapeHTML(short)}${truncated ? '…' : ''}</span>` +
            `<button class="record-btn" data-url="${escapeHTML(url)}">↓ Record</button>`;
        el.appendChild(item);
    }
}

async function renderDownloads() {
    const data      = await chrome.storage.local.get(S_DLS);
    const downloads = data[S_DLS] || [];
    const el        = document.getElementById('downloads-list');

    if (downloads.length === 0) {
        el.innerHTML = '<div class="empty">No downloads yet</div>';
        return;
    }

    el.innerHTML = '';
    for (const dl of downloads) {
        const statusKey = dl.status.startsWith('error') ? 'error' : dl.status;
        const isDone    = dl.status === 'completed';
        const isActive  = dl.status === 'downloading';
        const item      = document.createElement('div');
        item.className  = 'dl-item';
        item.innerHTML  =
            `<div class="dl-name" title="${escapeHTML(dl.filename)}">${escapeHTML(dl.filename)}</div>` +
            `<div class="dl-row">` +
            `  <span class="dl-size">${formatBytes(dl.bytesWritten)}</span>` +
            `  <span class="dl-status status-${escapeHTML(statusKey)}">${escapeHTML(dl.status)}</span>` +
            (isActive ? `<button class="stop-btn" data-id="${dl.id}">■ Stop</button>` : '') +
            (isDone && !dl.savedToDir ? `<button class="save-btn" data-filename="${escapeHTML(dl.filename)}">💾 Save</button>` : '') +
            `</div>`;
        el.appendChild(item);
    }
}

function render() {
    renderStreams();
    renderDownloads();
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

// Delegated click handler for dynamically rendered buttons.
document.getElementById('detected-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.record-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '…';
    const url = btn.dataset.url;
    try {
        // Ensure directory write permission is 'granted' before handing off to the
        // background service worker, which cannot call requestPermission itself.
        // This must run inside a click handler so the user-gesture requirement is met.
        // If the user denies permission (or requestPermission throws for any reason),
        // the download proceeds normally and falls back to OPFS.
        if (saveDirHandleRef) {
            try {
                const perm = await saveDirHandleRef.queryPermission({ mode: 'readwrite' });
                if (perm === 'prompt') {
                    await saveDirHandleRef.requestPermission({ mode: 'readwrite' });
                }
            } catch { /* permission denied or unavailable — background will fall back to OPFS */ }
        }
        await send({ type: 'startDownload', url });
        await renderDownloads();
    } catch (err) {
        alert('Could not start download: ' + err.message);
    }
    btn.disabled = false;
    btn.textContent = '↓ Record';
});

document.getElementById('downloads-list').addEventListener('click', async (e) => {
    const stopBtn = e.target.closest('.stop-btn');
    if (stopBtn) {
        await send({ type: 'stopDownload', id: Number(stopBtn.dataset.id) });
        await renderDownloads();
        return;
    }
    const saveBtn = e.target.closest('.save-btn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '…';
        try {
            await saveFile(saveBtn.dataset.filename);
        } finally {
            if (saveBtn.isConnected) {
                saveBtn.disabled = false;
                saveBtn.textContent = '💾 Save';
            }
        }
    }
});

document.getElementById('btn-add-url').addEventListener('click', () => {
    const input = document.getElementById('manual-url');
    const url   = input.value.trim();
    if (url) {
        send({ type: 'addStream', url }).then(renderStreams);
        input.value = '';
    }
});

document.getElementById('manual-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-add-url').click();
});

document.getElementById('btn-clear-streams').addEventListener('click', async () => {
    await send({ type: 'clearStreams' });
    renderStreams();
});

document.getElementById('btn-clear-downloads').addEventListener('click', async () => {
    await send({ type: 'clearDownloads' });
    renderDownloads();
});

document.getElementById('btn-select-dir').addEventListener('click', () => {
    // showDirectoryPicker() causes Chrome to destroy the popup before the
    // native dialog opens, so the promise never resolves in this context and
    // nothing can be saved.  Instead we open a dedicated small window that
    // persists through the native dialog and writes the result to
    // chrome.storage.local (and IDB) before closing itself.
    chrome.windows.create({
        url:     chrome.runtime.getURL('select-dir.html'),
        type:    'popup',
        width:   420,
        height:  160,
        focused: true,
    });
});

// ─── Real-time updates via storage change listener ────────────────────────────
// The background service worker updates chrome.storage.local as downloads
// progress.  The storage change event fires in all extension pages (including
// the popup) so the UI stays fresh without polling.

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (S_DLS      in changes) renderDownloads();
    if (S_STREAMS  in changes) renderStreams();
    if (S_SAVE_DIR in changes) {
        const name = changes[S_SAVE_DIR].newValue;
        document.getElementById('dir-name').textContent = name || 'No directory selected — files saved via Save dialog';
        // Reload the live handle from IDB so saveFile() writes to the newly chosen directory.
        if (name) {
            loadDirHandle().then((h) => { if (h) saveDirHandleRef = h; }).catch((err) => {
                console.warn('[LSR] Could not reload directory handle from IDB:', err);
            });
        } else {
            saveDirHandleRef = null;
        }
    }
});

// ─── Initialise ───────────────────────────────────────────────────────────────

(async () => {
    const label = document.getElementById('dir-name');

    // ── Step 1: show the persisted directory name from chrome.storage.local ───
    // This is always reliable — it persists across popup open/close and browser
    // restarts, unlike FileSystemDirectoryHandle objects stored in IDB.
    const stored = await chrome.storage.local.get(S_SAVE_DIR);
    const savedName = stored[S_SAVE_DIR] || null;

    if (savedName) {
        // Tentatively show the name; we'll refine it once we know whether the
        // live handle is still valid (step 2 below).
        label.textContent = savedName + ' (re-authorizing…)';
    }

    // ── Step 2: try to load the live handle from IDB ──────────────────────────
    // If this succeeds AND permission is still granted, we can do direct writes
    // to the directory without re-prompting.  If it fails for any reason we
    // fall back to showSaveFilePicker — but we still show the saved name so the
    // user knows which directory they chose.
    try {
        const handle = await loadDirHandle();
        if (handle) {
            const perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm === 'granted' || perm === 'prompt') {
                saveDirHandleRef = handle;
                // Update the chrome.storage.local name in case the folder was
                // renamed since the last session (IDB handle stays in sync).
                if (handle.name !== savedName) {
                    await chrome.storage.local.set({ [S_SAVE_DIR]: handle.name });
                }
                label.textContent = perm === 'granted'
                    ? handle.name
                    : handle.name + ' (click Select Directory to re-authorise)';
            } else {
                // Permission explicitly denied — tell the user clearly.
                label.textContent = (savedName || 'Directory') + ' (permission denied — click Select to re-choose)';
            }
        } else if (savedName) {
            // Handle not in IDB (e.g., first open after browser restart) but we
            // know the name.  Prompt the user to re-select so we can get a fresh
            // handle with valid permission.
            label.textContent = savedName + ' (click Select Directory to re-authorise)';
        }
    } catch (err) {
        // IDB read or permission check failed.  The name from chrome.storage.local
        // is still shown; the user can re-select to get a fresh handle.
        console.warn('[LSR] Could not load directory handle from IDB:', err);
        if (savedName) {
            label.textContent = savedName + ' (click Select Directory to re-authorise)';
        }
    }

    render();
})();
