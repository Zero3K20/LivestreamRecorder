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
                return { writable: await fh.createWritable({ keepExistingData: true }), savedToDir: true };
            }
        }
    } catch { /* fall through to OPFS */ }
    return { writable: await opfsGetWritable(filename), savedToDir: false };
}

/**
 * Parse an rtmp[s]:// URL into its components.
 * Fragment identifiers are stripped since RTMP has no concept of fragments.
 * @param {string} url
 * @returns {{ scheme: string, host: string, port: number, app: string, streamName: string }|null}
 */
function parseRtmpUrl(url) {
    try {
        // Strip any fragment before parsing
        const clean = url.split('#')[0];
        const m = /^(rtmps?):\/\/([^/:]+)(?::(\d+))?\/(([^/?#]+)\/?([^?#]*)?)/.exec(clean);
        if (!m) return null;
        const scheme     = m[1].toLowerCase();
        const host       = m[2];
        const port       = m[3] ? parseInt(m[3], 10) : (scheme === 'rtmps' ? 443 : 1935);
        const app        = m[5] || 'live';
        const streamName = m[6] || '';
        return { scheme, host, port, app, streamName };
    } catch { return null; }
}

/** Fire-and-forget message to the background service worker. */
function notifyBg(msg) {
    chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});
}

// ─── RTMP / RTMPT downloader ──────────────────────────────────────────────────

/**
 * Download an RTMP live stream using RTMPT (RTMP Tunneled over HTTP).
 * RTMPT is the standard HTTP-compatible RTMP transport defined in the Adobe
 * RTMP spec: it wraps the identical RTMP binary protocol in HTTP POST requests.
 * This means the recorder uses real RTMP framing (not a URL-converted endpoint)
 * so that HTTPS 403 restrictions on the CDN are bypassed at the protocol level.
 *
 * RTMPT base URL mapping:
 *   rtmp://host:1935/app/stream → http://host:80/open/1 (RTMPT)
 *   rtmps://host:443/app/stream → https://host:443/open/1 (RTMPTS)
 *
 * @param {string}                          url        rtmp[s]:// URL
 * @param {number}                          id         download ID (for notifyBg)
 * @param {{ stopped: boolean }}            stopSignal
 * @param {FileSystemWritableFileStream}    writable
 */
async function dlRTMP(url, id, stopSignal, writable) {
    const parsed = parseRtmpUrl(url);
    if (!parsed) throw new Error('Invalid RTMP URL: ' + url);
    const { scheme, host, port, app, streamName } = parsed;

    // RTMPT uses HTTP/HTTPS on the standard web ports, not the RTMP port.
    // rtmps → https:443, rtmp → http:80
    const httpScheme = (scheme === 'rtmps') ? 'https' : 'http';
    const httpPort   = (scheme === 'rtmps') ? 443 : 80;
    const base       = `${httpScheme}://${host}:${httpPort}`;

    // ── Binary helpers ──────────────────────────────────────────────────────────
    const concat = (...arrs) => {
        const total = arrs.reduce((s, a) => s + a.length, 0);
        const out   = new Uint8Array(total);
        let   off   = 0;
        for (const a of arrs) { out.set(a, off); off += a.length; }
        return out;
    };
    const u8      = (n) => new Uint8Array([n & 0xFF]);
    const u16     = (n) => new Uint8Array([(n >> 8) & 0xFF, n & 0xFF]);
    const u24     = (n) => new Uint8Array([(n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]);
    const u32BE   = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, false); return b; };
    const u32LE   = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true);  return b; };
    const f64BE   = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, n, false); return b; };
    const rU16BE  = (b, o) => ((b[o] << 8) | b[o + 1]) >>> 0;
    const rU24BE  = (b, o) => ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0;
    const rU32BE  = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
    const rU32LE  = (b, o) => ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);

    // ── AMF0 encoder ────────────────────────────────────────────────────────────
    const amfStr  = (s) => { const e = new TextEncoder().encode(s); return concat(new Uint8Array([0x02]), u16(e.length), e); };
    const amfNum  = (n) => concat(new Uint8Array([0x00]), f64BE(n));
    const amfNull = ()  => new Uint8Array([0x05]);
    const amfBool = (b) => new Uint8Array([0x01, b ? 1 : 0]);
    const amfObj  = (props) => {
        const parts = [new Uint8Array([0x03])];
        for (const [k, v] of props) {
            const ke = new TextEncoder().encode(k);
            parts.push(u16(ke.length), ke);
            if (typeof v === 'string')  parts.push(amfStr(v));
            else if (typeof v === 'number')  parts.push(amfNum(v));
            else if (typeof v === 'boolean') parts.push(amfBool(v));
            else parts.push(amfNull());
        }
        parts.push(new Uint8Array([0x00, 0x00, 0x09])); // end-of-object
        return concat(...parts);
    };

    // ── RTMP chunk encoder ───────────────────────────────────────────────────────
    const CHUNK_OUT = 4096;
    function encodeChunk(csid, typeId, streamId, ts, payload) {
        const out = [];
        let off = 0;
        while (off < payload.length) {
            const first = off === 0;
            out.push(new Uint8Array([first ? (csid & 0x3F) : (0xC0 | (csid & 0x3F))]));
            if (first) {
                out.push(u24(Math.min(ts, 0xFFFFFE)), u24(payload.length), u8(typeId), u32LE(streamId));
            }
            const end = Math.min(off + CHUNK_OUT, payload.length);
            out.push(payload.slice(off, end));
            off = end;
        }
        return concat(...out);
    }

    const tcUrl = `rtmp://${host}:${port}/${app}`;
    const buildSetChunkSize  = ()     => encodeChunk(2, 1, 0, 0, u32BE(CHUNK_OUT & 0x7FFFFFFF));
    const buildConnect       = ()     => encodeChunk(3, 20, 0, 0, concat(amfStr('connect'), amfNum(1), amfObj([
        ['app', app], ['type', 'nonprivate'], ['flashVer', 'WIN 32,0,0,114'],
        ['swfUrl', ''], ['tcUrl', tcUrl], ['fpad', false],
        ['capabilities', 15], ['audioCodecs', 3575], ['videoCodecs', 252],
        ['videoFunction', 1], ['pageUrl', ''],
    ])));
    const buildCreateStream  = ()     => encodeChunk(3, 20, 0, 0, concat(amfStr('createStream'), amfNum(2), amfNull()));
    const buildPlay          = (msid) => encodeChunk(8, 20, msid, 0, concat(amfStr('play'), amfNum(0), amfNull(), amfStr(streamName)));

    // ── RTMPT transport ──────────────────────────────────────────────────────────
    const rtmptPost = async (path, body) => {
        const r = await fetch(base + path, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-fcs', 'User-Agent': 'Shockwave Flash' },
            body:    body && body.length ? body : null,
        });
        if (!r.ok) throw new Error(`RTMPT ${path}: HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
    };

    // ── RTMP chunk parser ────────────────────────────────────────────────────────
    const stateMap  = {}; // csid → { timestamp, msgLength, msgTypeId, msgStreamId }
    const bufMap    = {}; // csid → { data: Uint8Array[], remaining: number }
    let   inChunkSz = 128;

    function parseChunks(bytes, onMsg) {
        let pos = 0;
        while (pos < bytes.length) {
            const b0  = bytes[pos++];
            const fmt = (b0 >> 6) & 0x3;
            let csid  = b0 & 0x3F;
            if (csid === 0) { if (pos >= bytes.length) break; csid = bytes[pos++] + 64; }
            else if (csid === 1) { if (pos + 1 >= bytes.length) break; csid = bytes[pos + 1] * 256 + bytes[pos] + 64; pos += 2; }

            const st = stateMap[csid] || (stateMap[csid] = { timestamp: 0, msgLength: 0, msgTypeId: 0, msgStreamId: 0 });

            if (fmt === 0) {
                if (pos + 11 > bytes.length) break;
                let ts = rU24BE(bytes, pos); pos += 3;
                st.msgLength   = rU24BE(bytes, pos); pos += 3;
                st.msgTypeId   = bytes[pos++];
                st.msgStreamId = rU32LE(bytes, pos); pos += 4;
                if (ts === 0xFFFFFF) { if (pos + 4 > bytes.length) break; ts = rU32BE(bytes, pos); pos += 4; }
                st.timestamp = ts;
            } else if (fmt === 1) {
                if (pos + 7 > bytes.length) break;
                let d = rU24BE(bytes, pos); pos += 3;
                st.msgLength  = rU24BE(bytes, pos); pos += 3;
                st.msgTypeId  = bytes[pos++];
                if (d === 0xFFFFFF) { if (pos + 4 > bytes.length) break; d = rU32BE(bytes, pos); pos += 4; }
                st.timestamp += d;
            } else if (fmt === 2) {
                if (pos + 3 > bytes.length) break;
                let d = rU24BE(bytes, pos); pos += 3;
                if (d === 0xFFFFFF) { if (pos + 4 > bytes.length) break; d = rU32BE(bytes, pos); pos += 4; }
                st.timestamp += d;
            }

            const buf = bufMap[csid] || (bufMap[csid] = { data: [], remaining: st.msgLength });
            if (fmt === 0 || fmt === 1) { buf.data = []; buf.remaining = st.msgLength; }

            const toRead = Math.min(inChunkSz, buf.remaining);
            if (pos + toRead > bytes.length) break;
            buf.data.push(bytes.slice(pos, pos + toRead));
            buf.remaining -= toRead;
            pos += toRead;

            if (buf.remaining === 0 && buf.data.length > 0) {
                const payload = concat(...buf.data);
                buf.data = []; buf.remaining = 0;
                onMsg(st.msgTypeId, st.timestamp, payload);
            }
        }
    }

    // ── FLV helpers ──────────────────────────────────────────────────────────────
    const flvHeader = concat(new Uint8Array([0x46, 0x4C, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]), u32BE(0));
    const flvTag = (type, ts, data) => {
        const size = 11 + data.length;
        return concat(u8(type), u24(data.length), u24(ts & 0xFFFFFF), u8((ts >> 24) & 0xFF),
                      new Uint8Array([0, 0, 0]), data, u32BE(size));
    };

    // ── Session ──────────────────────────────────────────────────────────────────
    let bytesWritten = 0;

    // 1. Open session
    const sessionId = new TextDecoder().decode(await rtmptPost('/open/1', null)).trim();
    if (!sessionId) throw new Error('RTMPT: empty session ID');

    let seqNum = 0;
    let accumBuf = new Uint8Array(0);

    const absorb = (raw) => { if (raw.length > 1) accumBuf = concat(accumBuf, raw.slice(1)); };

    // 2. Send C0+C1
    const c1 = new Uint8Array(1536);
    new DataView(c1.buffer).setUint32(0, (Date.now() / 1000) | 0, false);
    crypto.getRandomValues(c1.subarray(8));
    absorb(await rtmptPost(`/send/${sessionId}/${++seqNum}`, concat(new Uint8Array([3]), c1)));

    // 3. Poll for S0+S1+S2
    while (accumBuf.length < 3073 && !stopSignal.stopped) {
        absorb(await rtmptPost(`/idle/${sessionId}/${++seqNum}`, new Uint8Array(0)));
    }
    if (stopSignal.stopped) { await writable.close(); return; }

    const s1  = accumBuf.slice(1, 1537);
    accumBuf  = accumBuf.slice(3073);

    // 4. C2 + SetChunkSize + connect
    absorb(await rtmptPost(`/send/${sessionId}/${++seqNum}`, concat(s1, buildSetChunkSize(), buildConnect())));

    // 5. FLV header
    await writable.write(flvHeader.buffer);
    bytesWritten += flvHeader.length;
    notifyBg({ type: 'patchDownload', id, patch: { bytesWritten } });

    let rtmpState = 'connecting';
    let msid      = 0;
    let pendingSend = null;

    const onMsg = async (typeId, ts, payload) => {
        if (typeId === 1 && payload.length >= 4) { inChunkSz = rU32BE(payload, 0) & 0x7FFFFFFF; return; }
        if (typeId === 20) { // AMF0 command
            if (payload[0] !== 0x02) return;
            const nameLen = rU16BE(payload, 1);
            const name    = new TextDecoder().decode(payload.slice(3, 3 + nameLen));
            if (name === '_result') {
                if (rtmpState === 'connecting') { rtmpState = 'creating'; pendingSend = buildCreateStream(); }
                else if (rtmpState === 'creating') {
                    let p = 3 + nameLen + 9; // skip name, txid number
                    while (p < payload.length && payload[p] === 0x05) p++;
                    if (payload[p] === 0x00 && p + 9 <= payload.length) {
                        msid = Math.round(new DataView(payload.buffer, payload.byteOffset + p + 1, 8).getFloat64(0, false));
                    }
                    rtmpState = 'playing'; pendingSend = buildPlay(msid);
                }
            } else if (name === 'onStatus' && rtmpState === 'playing') {
                rtmpState = 'streaming';
            }
            return;
        }
        if (rtmpState !== 'streaming') return;
        const tagType = typeId === 8 ? 0x08 : typeId === 9 ? 0x09 : typeId === 18 ? 0x12 : 0;
        if (!tagType) return;
        const tag = flvTag(tagType, ts, payload);
        await writable.write(tag.buffer);
        bytesWritten += tag.length;
        notifyBg({ type: 'patchDownload', id, patch: { bytesWritten } });
    };

    // 6. Main poll loop
    try {
        while (!stopSignal.stopped) {
            parseChunks(accumBuf, onMsg);
            accumBuf = new Uint8Array(0);

            const toSend = pendingSend || new Uint8Array(0);
            pendingSend  = null;
            absorb(toSend.length > 0
                ? await rtmptPost(`/send/${sessionId}/${++seqNum}`, toSend)
                : await rtmptPost(`/idle/${sessionId}/${++seqNum}`, new Uint8Array(0)));
        }
    } finally {
        await writable.close();
        // Best-effort close of RTMPT session
        rtmptPost(`/close/${sessionId}/${++seqNum}`, new Uint8Array(0)).catch(() => {});
    }
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

async function handleStartDownload({ id, url, filename, isHLS, isWS, isRTMP }) {
    const stopSignal = { stopped: false };
    activeOps.set(id, { stopSignal });
    let writable = null;
    try {
        let savedToDir = false;
        ({ writable, savedToDir } = await getWritable(filename));
        notifyBg({ type: 'patchDownload', id, patch: { savedToDir } });

        const w = writable;
        writable = null; // downloader owns the writable and closes it in its finally block

        if (isHLS)       await dlHLS(url, id, stopSignal, w);
        else if (isWS)   await dlWebSocket(url, id, stopSignal, w);
        else if (isRTMP) {
            // Download via RTMPT (RTMP Tunneled over HTTP), the standard browser-
            // compatible RTMP transport.  This uses the actual RTMP protocol framing
            // without any URL conversion, so HTTPS 403 restrictions are bypassed.
            await dlRTMP(url, id, stopSignal, w);
        }
        else             await dlDirect(url, id, stopSignal, w);

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
