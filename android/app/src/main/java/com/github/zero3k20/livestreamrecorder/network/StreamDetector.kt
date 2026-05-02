package com.github.zero3k20.livestreamrecorder.network

/** URL / MIME-type pattern matching to classify detected network streams. */
object StreamDetector {

    private val HLS_RE  = Regex("""\.m3u8?(\?|#|$)""",             RegexOption.IGNORE_CASE)
    private val FLV_RE  = Regex("""\.flv(\?|#|$)""",               RegexOption.IGNORE_CASE)
    private val MP4_RE  = Regex("""\.mp4(\?|#|$)""",               RegexOption.IGNORE_CASE)
    private val TS_RE   = Regex("""\.ts(\?|#|$)""",                RegexOption.IGNORE_CASE)
    private val MPD_RE  = Regex("""\.mpd(\?|#|$)""",               RegexOption.IGNORE_CASE)
    private val LIVE_RE = Regex("""/(live|hls|dash|stream|play)/""", RegexOption.IGNORE_CASE)
    private val RTMP_RE = Regex("""^rtmps?://""",                   RegexOption.IGNORE_CASE)

    /**
     * Returns the stream type string ("hls", "flv", "mp4", "ts", "dash",
     * "rtmp", "direct"), or null if the URL / MIME-type is not a recognised stream.
     */
    fun detectType(url: String, mimeType: String? = null): String? {
        if (mimeType != null) {
            return when {
                mimeType.contains("mpegurl", ignoreCase = true) -> "hls"
                mimeType.contains("x-flv",   ignoreCase = true) -> "flv"
                mimeType.contains("mp2t",    ignoreCase = true) -> "ts"
                else -> null
            }
        }
        val u = url.lowercase()
        return when {
            RTMP_RE.containsMatchIn(u) -> "rtmp"
            HLS_RE.containsMatchIn(u)  -> "hls"
            FLV_RE.containsMatchIn(u)  -> "flv"
            MP4_RE.containsMatchIn(u)  -> "mp4"
            TS_RE.containsMatchIn(u)   -> "ts"
            MPD_RE.containsMatchIn(u)  -> "dash"
            LIVE_RE.containsMatchIn(u) -> "direct"
            else                       -> null
        }
    }

    /**
     * Convert an RTMP/RTMPS URL to an HTTP-FLV URL suitable for download.
     *
     * CDNs (e.g. pull.cdnsi.com) serve the same stream over both RTMP and HTTP-FLV.
     * Mapping: rtmp://host/live/STREAM[?q] → http://host/live/STREAM.flv[?q]
     *          rtmps://host/live/STREAM[?q] → https://host/live/STREAM.flv[?q]
     *
     * @return HTTP-FLV URL, or null if [url] is not a valid RTMP URL.
     */
    fun rtmpToHttpFlv(url: String): String? {
        val lower = url.lowercase()
        val scheme = when {
            lower.startsWith("rtmps://") -> "https"
            lower.startsWith("rtmp://")  -> "http"
            else                          -> return null
        }
        // Strip rtmp(s):// prefix
        val rest = url.substringAfter("://")
        // Append .flv if not already present
        val withFlv = if (rest.contains(".flv", ignoreCase = true)) rest else {
            // Insert before query string if present
            val qIdx = rest.indexOf('?')
            if (qIdx >= 0) rest.substring(0, qIdx) + ".flv" + rest.substring(qIdx)
            else "$rest.flv"
        }
        return "$scheme://$withFlv"
    }
}
