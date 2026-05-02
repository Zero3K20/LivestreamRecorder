package com.github.zero3k20.livestreamrecorder.download

import android.content.Context
import com.github.zero3k20.livestreamrecorder.models.DownloadState
import com.github.zero3k20.livestreamrecorder.models.StreamInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/**
 * Coordinates all active downloads.  Each stream gets its own coroutine Job so
 * that cancelling one never affects others — matching the extension's
 * independent-download-per-stream design.
 */
class DownloadManager(context: Context) {

    interface Callback {
        fun onProgress(streamId: String, state: DownloadState.Downloading)
        fun onComplete(streamId: String, state: DownloadState.Completed)
        fun onError(streamId: String, error: String)
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val activeJobs = mutableMapOf<String, Job>()

    /** Output directory — falls back to app-private cache when external storage is unavailable. */
    private val outputDir: File = run {
        val ext = context.getExternalFilesDir(null)
        val dir = if (ext != null) {
            File(ext, "LivestreamRecorder")
        } else {
            File(context.filesDir, "LivestreamRecorder")
        }
        dir.mkdirs()
        dir
    }

    fun startDownload(stream: StreamInfo, callback: Callback) {
        val outputFile = File(outputDir, generateFileName(stream))

        val job = scope.launch {
            callback.onProgress(stream.id, DownloadState.Downloading())

            when (stream.type.lowercase()) {
                "hls" -> {
                    HlsDownloader().download(
                        playlistUrl = stream.url,
                        outputFile  = outputFile,
                        onProgress  = { bytes, segs, total ->
                            callback.onProgress(
                                stream.id,
                                DownloadState.Downloading(
                                    bytesDownloaded    = bytes,
                                    segmentsCompleted  = segs,
                                    totalSegments      = total
                                )
                            )
                        },
                        onError = { error -> callback.onError(stream.id, error) }
                    )
                }
                "rtmp" -> {
                    // Use the native RTMP TCP client so the stream is downloaded
                    // directly via the RTMP protocol without any URL conversion.
                    RtmpDownloader().download(
                        rtmpUrl     = stream.url,
                        outputFile  = outputFile,
                        onProgress  = { bytes ->
                            callback.onProgress(
                                stream.id,
                                DownloadState.Downloading(bytesDownloaded = bytes)
                            )
                        },
                        isCancelled = { !isActive },
                        onError     = { error -> callback.onError(stream.id, error) }
                    )
                }
                else -> {
                    DirectDownloader().download(
                        streamUrl  = stream.url,
                        outputFile = outputFile,
                        onProgress = { bytes, total ->
                            callback.onProgress(
                                stream.id,
                                DownloadState.Downloading(
                                    bytesDownloaded = bytes,
                                    totalBytes      = total
                                )
                            )
                        },
                        onError = { error -> callback.onError(stream.id, error) }
                    )
                }
            }

            if (isActive) {
                callback.onComplete(
                    stream.id,
                    DownloadState.Completed(
                        filePath   = outputFile.absolutePath,
                        totalBytes = outputFile.length()
                    )
                )
            }
        }

        activeJobs[stream.id] = job
    }

    fun cancelDownload(streamId: String) {
        activeJobs.remove(streamId)?.cancel()
    }

    fun cancelAll() {
        activeJobs.values.forEach { it.cancel() }
        activeJobs.clear()
    }

    fun destroy() {
        cancelAll()
    }

    private fun generateFileName(stream: StreamInfo): String {
        val timestamp = System.currentTimeMillis()
        val ext = when (stream.type.lowercase()) {
            "hls"       -> "ts"
            "flv", "rtmp" -> "flv"
            "mp4"       -> "mp4"
            "webm"      -> "webm"
            "websocket" -> "ts"
            else        -> "mp4"
        }
        return "stream_$timestamp.$ext"
    }
}
