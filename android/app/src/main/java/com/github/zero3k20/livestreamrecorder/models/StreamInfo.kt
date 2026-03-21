package com.github.zero3k20.livestreamrecorder.models

import java.util.UUID

data class StreamInfo(
    val id: String = UUID.randomUUID().toString(),
    val url: String,
    /** "hls", "flv", "mp4", "ts", "dash", "websocket", "direct", or "sni" */
    val type: String,
    val detectedAt: Long = System.currentTimeMillis()
)
