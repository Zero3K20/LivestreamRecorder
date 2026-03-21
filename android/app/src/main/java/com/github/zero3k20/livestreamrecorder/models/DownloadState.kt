package com.github.zero3k20.livestreamrecorder.models

sealed class DownloadState {
    object Idle : DownloadState()

    data class Downloading(
        val bytesDownloaded: Long = 0L,
        val totalBytes: Long = -1L,
        val segmentsCompleted: Int = 0,
        val totalSegments: Int = 0
    ) : DownloadState()

    data class Completed(
        val filePath: String,
        val totalBytes: Long
    ) : DownloadState()

    data class Failed(val error: String) : DownloadState()
}
