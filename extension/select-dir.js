// select-dir.js — Directory picker helper page for Livestream Recorder
// Opened as a small window by the main popup so that the native
// showDirectoryPicker dialog does not destroy the calling context.
'use strict';

// ─── Storage keys (must match popup.js) ──────────────────────────────────────

const S_SAVE_DIR = 'lsr_save_dir';

// ─── IndexedDB helpers (same origin as popup.js — shared IDB) ────────────────

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

async function saveDirHandleToIDB(handle) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(handle, 'directory');
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
    });
}

// ─── Pick handler ─────────────────────────────────────────────────────────────

const btn = document.getElementById('btn-pick');
const msg = document.getElementById('msg');

btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '…';

    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });

        // Persist the directory name as a plain string — always reliable.
        await chrome.storage.local.set({ [S_SAVE_DIR]: handle.name });

        // Best-effort: cache the live handle in IDB for same-session direct writes.
        try {
            await saveDirHandleToIDB(handle);
        } catch (idbErr) {
            console.warn('[LSR] Could not cache directory handle in IDB:', idbErr);
        }

        msg.textContent = '✓ Saved: ' + handle.name;
        // Give the user a moment to see the confirmation, then close.
        setTimeout(() => window.close(), 800);
    } catch (e) {
        if (e.name === 'AbortError') {
            // User cancelled — just close.
            window.close();
        } else {
            msg.textContent = 'Error: ' + e.message;
            btn.disabled = false;
            btn.textContent = '📂 Choose Directory…';
        }
    }
});
