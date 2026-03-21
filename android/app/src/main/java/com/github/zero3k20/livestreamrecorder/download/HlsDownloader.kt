package com.github.zero3k20.livestreamrecorder.download

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Downloads an HLS/m3u8 stream by polling the playlist and appending each
 * MPEG-TS segment to the output file — mirroring what background.js does via
 * the fetch + OPFS approach in the Chrome extension.
 */
class HlsDownloader {

    suspend fun download(
        playlistUrl: String,
        outputFile: File,
        onProgress: (bytesWritten: Long, segmentsCompleted: Int, totalSegments: Int) -> Unit,
        onError: (String) -> Unit
    ) = withContext(Dispatchers.IO) {
        try {
            outputFile.parentFile?.mkdirs()

            var totalBytes = 0L
            var segmentsCompleted = 0
            var isLive = true
            val seenSegments = linkedSetOf<String>()

            FileOutputStream(outputFile, false).use { out ->
                while (isActive && isLive) {
                    val playlist = fetchText(playlistUrl)
                    if (playlist == null) {
                        onError("Failed to fetch playlist")
                        return@withContext
                    }

                    isLive = !playlist.contains("#EXT-X-ENDLIST")

                    val allSegments = parseSegments(playlist, playlistUrl)
                    val newSegments = allSegments.filter { it !in seenSegments }

                    if (newSegments.isEmpty()) {
                        if (isLive) {
                            // HLS live stream — poll again after target duration
                            val targetDuration = parseTargetDuration(playlist)
                            delay(targetDuration * 1000L)
                        }
                        continue
                    }

                    val knownTotal = seenSegments.size + allSegments.size

                    for (segUrl in newSegments) {
                        if (!isActive) break
                        val bytes = fetchBytes(segUrl)
                        if (bytes != null) {
                            out.write(bytes)
                            totalBytes += bytes.size
                            seenSegments.add(segUrl)
                            segmentsCompleted++
                            onProgress(totalBytes, segmentsCompleted, knownTotal)
                        } else {
                            // Mark as seen so we don't retry indefinitely; the
                            // resulting file will have a gap — matching the
                            // extension's "skip and continue" behaviour for
                            // transient segment failures.
                            seenSegments.add(segUrl)
                        }
                    }

                    if (isLive && isActive) {
                        val targetDuration = parseTargetDuration(playlist)
                        delay(targetDuration * 1000L)
                    }
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            onError(e.message ?: "Unknown HLS download error")
        }
    }

    private fun fetchText(url: String): String? {
        return try {
            val conn = openConnection(url)
            if (conn.responseCode == HttpURLConnection.HTTP_OK) {
                conn.inputStream.bufferedReader().use { it.readText() }
            } else null
        } catch (e: Exception) {
            null
        }
    }

    private fun fetchBytes(url: String): ByteArray? {
        return try {
            val conn = openConnection(url)
            if (conn.responseCode == HttpURLConnection.HTTP_OK) {
                conn.inputStream.use { it.readBytes() }
            } else null
        } catch (e: Exception) {
            null
        }
    }

    private fun openConnection(url: String): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout    = 30_000
        conn.setRequestProperty("User-Agent", USER_AGENT)
        return conn
    }

    /**
     * Parse segment URLs from a media playlist.
     * Handles absolute URLs, protocol-relative ("//…"), root-relative ("/…"),
     * and relative paths — same logic as the extension's offscreen downloader.
     */
    private fun parseSegments(playlist: String, baseUrl: String): List<String> {
        val segments = mutableListOf<String>()
        val base = baseUrl.substringBeforeLast('/')
        val urlObj = try { URL(baseUrl) } catch (e: Exception) { null }

        for (line in playlist.lineSequence()) {
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith('#')) continue

            val segUrl = when {
                trimmed.startsWith("http://") || trimmed.startsWith("https://") -> trimmed
                trimmed.startsWith("//") -> "https:$trimmed"
                trimmed.startsWith("/") ->
                    if (urlObj != null) "${urlObj.protocol}://${urlObj.host}$trimmed"
                    else "$base$trimmed"
                else -> "$base/$trimmed"
            }
            segments.add(segUrl)
        }
        return segments
    }

    /** Returns the #EXT-X-TARGETDURATION value in seconds, defaulting to 2. */
    private fun parseTargetDuration(playlist: String): Long {
        for (line in playlist.lineSequence()) {
            if (line.startsWith("#EXT-X-TARGETDURATION:")) {
                return line.removePrefix("#EXT-X-TARGETDURATION:").trim().toLongOrNull() ?: 2L
            }
        }
        return 2L
    }

    companion object {
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36"
    }
}
