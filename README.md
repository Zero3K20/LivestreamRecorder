# LivestreamRecorder

A Tampermonkey userscript that records live streams (m3u8/HLS, flv, mp4, MPEG-DASH, etc.) **directly to disk** — no buffering in memory — and supports downloading multiple streams at the same time.

---

## Features

- **Direct-to-disk writing** using the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API). Each byte is written to the output file immediately and released from memory, so even hour-long streams will not crash your browser tab.
- **HLS / m3u8** – polls live playlists, downloads each MPEG-TS segment in order, handles master playlists (picks highest quality automatically).
- **Direct streams** (flv, mp4, ts, …) – downloaded in 4 MB Range-request chunks where the server supports it; falls back to a single GET for live-push streams.
- **Multiple concurrent downloads** – start as many recordings as you like; each runs independently.
- **User-selected save directory** – click *Select Directory…* once and all recordings land in that folder automatically.
- **Auto-detection** of stream URLs by hooking `XMLHttpRequest` and `fetch` and scanning `<video>`/`<source>` elements. Manual URL entry is also supported.
- **Draggable floating panel** with a minimise/close button and a Tampermonkey menu command to re-open it.
- Compatible with **Tampermonkey stable and beta** on Chrome 86+, Edge 86+, and other Chromium-based browsers.

---

## Browser requirements

| Requirement | Minimum version |
|---|---|
| Chrome / Edge (Chromium) | 86+ |
| Tampermonkey | 4.x stable or beta |

> **Firefox** does not currently support `window.showDirectoryPicker()` (File System Access API) and is therefore not supported. The script will show a clear error message if you try to use it on Firefox.

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Click the raw link below (or open `LivestreamRecorder.user.js` in this repo and click **Raw**):  
   `https://raw.githubusercontent.com/Zero3K20/LivestreamRecorder/main/LivestreamRecorder.user.js`
3. Tampermonkey will detect the `// ==UserScript==` header and offer to install the script. Click **Install**.

---

## Usage

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
| Other | extension taken from the URL, defaults to `.mp4` |

To remux a `.ts` file into MP4 without re-encoding:

```bash
ffmpeg -i recording.ts -c copy output.mp4
```

---

## Privacy & security

- All network requests go through `GM_xmlhttpRequest` with `@connect *`, which Tampermonkey uses to bypass CORS restrictions. No data is sent to any third-party server; requests go only to the stream's origin.
- The script never stores credentials or tokens persistently.
