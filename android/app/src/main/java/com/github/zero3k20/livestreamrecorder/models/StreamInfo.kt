package com.github.zero3k20.livestreamrecorder.models

import java.util.UUID

data class StreamInfo(
    val id: String = UUID.randomUUID().toString(),
    val url: String,
    /** "hls", "flv", "mp4", "webm", "websocket", "webrtc", or "direct" */
    val type: String,
    val pageUrl: String = "",
    val pageTitle: String = "",
    val detectedAt: Long = System.currentTimeMillis()
)
