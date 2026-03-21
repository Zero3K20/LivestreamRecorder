# LivestreamRecorder

Record live streams (m3u8/HLS, flv, mp4, WebSocket, WebRTC) **directly to disk** — no buffering in memory — and support downloading multiple streams at the same time.

Available as two forms:
- **Chrome Extension** (recommended) — downloads continue in the background even after you navigate away from the stream page, and all state persists reliably across tab refreshes.
- **Tampermonkey Userscript** — works in any Chromium-based browser without installing a separate extension; restores active downloads on page refresh.

---

## Chrome Extension (Recommended)

### Why the extension?

| Feature | Userscript | Extension |
|---|---|---|
| Continues downloading after leaving the stream page | ❌ | ✅ |
| State persists across page refreshes | ✅ (IDB + GM_setValue) | ✅ (chrome.storage.local) |
| Detected streams survive navigation to different pages | ❌ | ✅ |
| No separate userscript manager needed | ❌ | ✅ |
| Shows downloads from all tabs in one place | ❌ | ✅ |

The extension's background **service worker** handles all HLS/HTTP/WebSocket downloads using `fetch()` and writes to the browser's **Origin Private File System (OPFS)**. Because the service worker is not tied to any particular tab or page, recording continues uninterrupted when you navigate or close the stream tab. When you want the finished file, open the popup and click **💾 Save** to write it to disk.

### How downloads work

1. The extension's content script detects stream URLs on every page you visit.
2. Click the extension icon → **↓ Record** to start a download. The background service worker fetches and writes data to OPFS immediately.
3. You can close or navigate away from the page — the download keeps running in the background.
4. When the download is complete (or you click **■ Stop**), open the popup and click **💾 Save** to export the file to your chosen directory or via the browser's Save dialog.

### Installation

1. Download or clone this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `extension/` folder from this repository.
5. The 🎥 Livestream Recorder icon will appear in your toolbar.

### Usage

1. Navigate to any page that plays a live stream.
2. Click the **🎥** extension icon to open the popup.
3. *(Optional)* Click **📂 Select Directory…** to choose where finished recordings are saved. If you skip this, a Save dialog appears each time you click **💾 Save**.
4. Stream URLs detected on the current page appear under **Detected Streams**. Click **↓ Record** to start.
5. You can also paste a URL into the box and click **Add** to record any stream manually.
6. Each recording appears under **Downloads** with live progress. Click **■ Stop** to end a recording early.
7. When a recording shows **completed**, click **💾 Save** to write the file to disk. The temporary OPFS copy is deleted automatically after saving.

> **Note on WebRTC streams** (`webrtc://…` entries): these are live camera/microphone feeds captured via the browser's MediaRecorder API. Because WebRTC transport is tied to the tab, these recordings cannot continue in the background — they stop when you leave the page.

---

## Tampermonkey Userscript

### Features

- **Direct-to-disk writing** using the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API). Each byte is written to the output file immediately and released from memory, so even hour-long streams will not crash your browser tab.
- **HLS / m3u8** – polls live playlists, downloads each MPEG-TS segment in order, handles master playlists (picks highest quality automatically).
- **Direct streams** (flv, mp4, ts, …) – downloaded in 4 MB Range-request chunks where the server supports it; falls back to a single GET for live-push streams.
- **WebSocket binary streams** – auto-detected and recorded directly to disk.
- **WebRTC streams** – captured via MediaRecorder and saved as `.webm`.
- **Multiple concurrent downloads** – start as many recordings as you like; each runs independently.
- **Resumes after page refresh** – active downloads are restored automatically when you reload the page.
- **Leave-page warning** – a "Leave site?" dialog appears when navigating away during an active HLS/HTTP download so you don't lose progress.
- **User-selected save directory** – click *Select Directory…* once and all recordings land in that folder automatically.
- **Auto-detection** of stream URLs by hooking `XMLHttpRequest`, `fetch`, and `WebSocket`, and scanning `<video>`/`<source>` elements. Manual URL entry is also supported.
- **Draggable floating panel** with a minimise/close button and a Tampermonkey menu command to re-open it.

### Browser requirements

| Requirement | Minimum version |
|---|---|
| Chrome / Edge (Chromium) | 86+ |
| Tampermonkey | 4.x stable or beta |

> **Firefox** does not currently support `window.showDirectoryPicker()` (File System Access API) and is therefore not supported.

### Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Click the raw link below (or open `LivestreamRecorder.user.js` in this repo and click **Raw**):  
   `https://raw.githubusercontent.com/Zero3K20/LivestreamRecorder/main/LivestreamRecorder.user.js`
3. Tampermonkey will detect the `// ==UserScript==` header and offer to install the script. Click **Install**.

### Usage

1. Navigate to any page that plays a live stream (e.g. a video player page).
2. The **Livestream Recorder** panel will appear in the top-right corner of the page.  
   If it was closed, click the Tampermonkey icon → **Open Livestream Recorder**.
3. Click **📂 Select Directory…** and choose the folder where recordings should be saved. You only need to do this once per session (or per site after the browser re-requests permission).
4. Any stream URL detected on the page will appear under **Detected Streams**. Click **↓ Record** next to the one you want.
5. You can also paste a URL directly into the *"Or paste a stream URL…"* box and click **Add**.
6. Each active download is shown under **Active Downloads** with the file name, bytes written so far, and a **■ Stop** button.
7. When a recording finishes (stream ends or you click Stop), the file is already fully written and closed in your chosen directory.

---

## Output format

| Stream type | Output file extension |
|---|---|
| HLS / m3u8 | `.ts` (MPEG-TS container, play with VLC or remux with FFmpeg) |
| FLV | `.flv` |
| MP4 | `.mp4` |
| WebRTC | `.webm` |
| Other | extension taken from the URL, defaults to `.mp4` |

To remux a `.ts` file into MP4 without re-encoding:

```bash
ffmpeg -i recording.ts -c copy output.mp4
```

---

## Android App

An Android application that provides the same stream-detection and recording capabilities as the userscript, packaged as a native app with a built-in WebView browser.

### How it works

1. The app opens a WebView browser. You navigate to any page that plays a live stream.
2. On every page load, `stream_hooks.js` is injected into the WebView — using the same XHR / `fetch` / `WebSocket` / `srcObject` hooks as the Chrome extension's content script.
3. When a stream URL is detected, it is forwarded to the native Android layer via a `JavascriptInterface` bridge and added to the **Detected Streams** panel.
4. Tap **↓ Record** to start downloading. HLS streams are recorded by polling the `.m3u8` playlist and concatenating MPEG-TS segments; all other streams are downloaded progressively. Files are written directly to disk — no in-memory buffering.
5. Tap **■ Stop** to end a recording at any time.

### Features

- Built-in browser with address bar and back/forward/refresh navigation
- Automatic stream detection: HLS/m3u8, FLV, MP4, MPEG-TS, WebSocket binary streams, WebRTC
- Manual URL entry (`+ URL` button in the stream panel)
- Real-time download progress (bytes written, segment count for HLS)
- Recordings saved to `Android/data/com.github.zero3k20.livestreamrecorder/files/LivestreamRecorder/`
- Min Android version: **8.0 (API 26)**

### Building

1. Install [Android Studio](https://developer.android.com/studio) (Hedgehog or later recommended).
2. Open the `android/` folder as a project in Android Studio.
3. Let Gradle sync complete (it will download the Gradle wrapper automatically).
4. Connect a device or start an emulator, then click **▶ Run**.

Or from the command line (after Android Studio has set up the Gradle wrapper):

```bash
cd android
./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Privacy & security

- The extension uses `host_permissions: <all_urls>` so its service worker can fetch streams from any origin without CORS restrictions. No data is sent to any third-party server; all requests go directly to the stream's origin.
- The userscript uses `GM_xmlhttpRequest` with `@connect *` for the same purpose.
- Neither the extension nor the userscript stores credentials or tokens persistently.
