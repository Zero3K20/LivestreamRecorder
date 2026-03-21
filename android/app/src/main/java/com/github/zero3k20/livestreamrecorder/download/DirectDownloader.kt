package com.github.zero3k20.livestreamrecorder.download

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Downloads a direct stream (FLV, MP4, raw TS, etc.) via a single progressive
 * HTTP GET, writing each chunk to disk immediately — no in-memory buffering —
 * which mirrors the extension's OPFS streaming approach.
 */
class DirectDownloader {

    suspend fun download(
        streamUrl: String,
        outputFile: File,
        onProgress: (bytesDownloaded: Long, totalBytes: Long) -> Unit,
        onError: (String) -> Unit
    ) = withContext(Dispatchers.IO) {
        try {
            outputFile.parentFile?.mkdirs()

            val conn = URL(streamUrl).openConnection() as HttpURLConnection
            conn.connectTimeout = 30_000
            conn.readTimeout    = 60_000
            conn.setRequestProperty("User-Agent", USER_AGENT)

            val responseCode = conn.responseCode
            if (responseCode !in 200..299) {
                onError("HTTP $responseCode")
                return@withContext
            }

            val totalBytes = conn.contentLengthLong // -1 for live-push streams

            FileOutputStream(outputFile).use { fileOut ->
                conn.inputStream.use { input ->
                    val buffer = ByteArray(8 * 1024)
                    var bytesDownloaded = 0L
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        if (!isActive) break
                        fileOut.write(buffer, 0, read)
                        bytesDownloaded += read
                        onProgress(bytesDownloaded, totalBytes)
                    }
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            onError(e.message ?: "Download failed")
        }
    }

    companion object {
        private val USER_AGENT get() = DownloadConstants.USER_AGENT
    }
}
