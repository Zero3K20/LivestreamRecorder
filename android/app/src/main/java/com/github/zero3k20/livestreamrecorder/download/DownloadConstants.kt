package com.github.zero3k20.livestreamrecorder.download

/** Shared constants for all downloader classes. */
internal object DownloadConstants {
    /**
     * Mobile Chrome User-Agent sent with every download request.
     * Kept in one place so it can be updated easily across all downloaders.
     */
    const val USER_AGENT =
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
}
