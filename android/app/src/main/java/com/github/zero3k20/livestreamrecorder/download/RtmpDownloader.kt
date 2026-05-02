package com.github.zero3k20.livestreamrecorder.download

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * Downloads a live stream directly from an rtmp:// or rtmps:// URL by
 * implementing the RTMP protocol (Adobe specification) over a TCP socket
 * and writing the received audio and video data as an FLV file.
 *
 * Protocol sequence:
 *   1. TCP connect to host:1935 (rtmps → SSL on port 443)
 *   2. RTMP handshake  (C0+C1 → S0+S1+S2 → C2)
 *   3. AMF0 "connect" command
 *   4. AMF0 "createStream" command
 *   5. AMF0 "play" command with the stream name
 *   6. Read RTMP chunks → reassemble messages → write FLV tags to disk
 */
class RtmpDownloader {

    // ── Protocol constants ────────────────────────────────────────────────────

    private companion object {
        const val RTMP_VERSION: Byte = 3
        const val DEFAULT_IN_CHUNK_SIZE  = 128
        const val DEFAULT_OUT_CHUNK_SIZE = 4096

        // RTMP message type IDs
        const val MSG_SET_CHUNK_SIZE  = 1
        const val MSG_WINDOW_ACK_SIZE = 5
        const val MSG_SET_PEER_BW     = 6
        const val MSG_AUDIO           = 8
        const val MSG_VIDEO           = 9
        const val MSG_DATA_AMF0       = 18
        const val MSG_CMD_AMF0        = 20

        // AMF0 type markers
        const val AMF0_NUMBER:  Byte = 0x00
        const val AMF0_BOOLEAN: Byte = 0x01
        const val AMF0_STRING:  Byte = 0x02
        const val AMF0_OBJECT:  Byte = 0x03
        const val AMF0_NULL:    Byte = 0x05
        const val AMF0_END_OBJ: Byte = 0x09
    }

    // ── Chunk-stream state ────────────────────────────────────────────────────

    private data class ChunkState(
        var timestamp:   Long = 0,
        var msgLength:   Int  = 0,
        var msgTypeId:   Int  = 0,
        var msgStreamId: Int  = 0,
    )

    private data class MsgBuffer(
        val data:     ByteArrayOutputStream = ByteArrayOutputStream(),
        var remaining: Int = 0,
    )

    private val chunkStates = mutableMapOf<Int, ChunkState>()
    private val msgBuffers  = mutableMapOf<Int, MsgBuffer>()
    private var inChunkSize = DEFAULT_IN_CHUNK_SIZE

    private fun chunkState(csid: Int) = chunkStates.getOrPut(csid) { ChunkState() }

    // ── Download entry point ──────────────────────────────────────────────────

    /**
     * @param rtmpUrl    Full rtmp:// or rtmps:// URL, e.g. `rtmp://host/live/STREAM_ID`
     * @param outputFile Destination .flv file
     * @param onProgress Called with total bytes written so far
     * @param isCancelled Returns true when the download should stop
     * @param onError    Called with an error description on failure
     */
    suspend fun download(
        rtmpUrl:     String,
        outputFile:  File,
        onProgress:  (Long) -> Unit,
        isCancelled: () -> Boolean,
        onError:     (String) -> Unit,
    ) = withContext(Dispatchers.IO) {
        try {
            val parsed = parseRtmpUrl(rtmpUrl) ?: run {
                onError("Invalid RTMP URL: $rtmpUrl"); return@withContext
            }
            val (scheme, host, port, app, streamName) = parsed

            val sock = if (scheme == "rtmps") {
                // Create an SSL socket with proper hostname verification and SNI.
                val sslSock = SSLSocketFactory.getDefault()
                    .createSocket(host, port) as SSLSocket
                sslSock.useClientMode = true
                // Enable SNI so the server sends the correct certificate.
                val sslParams = SSLParameters()
                sslParams.serverNames = listOf(SNIHostName(host))
                sslParams.endpointIdentificationAlgorithm = "HTTPS"
                sslSock.sslParameters = sslParams
                sslSock.startHandshake()
                sslSock
            } else {
                Socket().apply { connect(InetSocketAddress(host, port), 10_000) }
            }

            sock.use { socket ->
                socket.soTimeout = 30_000
                val inp = BufferedInputStream(socket.getInputStream(), 65_536)
                val out = socket.getOutputStream()

                // 1. Handshake
                handshake(inp, out)

                // 2. Send Set Chunk Size + connect
                sendSetChunkSize(out, DEFAULT_OUT_CHUNK_SIZE)
                sendConnect(out, host, port, app)

                // 3. Read messages, progress through the state machine
                var state = "connecting" // → "creating" → "playing" → "streaming"
                var msgStreamId = 0
                var pendingSend: ByteArray? = null

                FileOutputStream(outputFile).use { fos ->
                    writeFLVHeader(fos)
                    var bytesOut = (9L + 4L) // FLV header + pre-tag-size-0

                    while (!isCancelled() && isActive) {
                        // Flush any queued outgoing message first
                        pendingSend?.let { out.write(it); out.flush() }
                        pendingSend = null

                        val msg = readMessage(inp) ?: break

                        when (msg.typeId) {
                            MSG_SET_CHUNK_SIZE -> {
                                if (msg.payload.size >= 4) {
                                    inChunkSize = readInt32BE(msg.payload, 0) and 0x7FFFFFFF
                                }
                            }
                            MSG_WINDOW_ACK_SIZE, MSG_SET_PEER_BW -> { /* accept */ }

                            MSG_CMD_AMF0 -> {
                                val nameAndEnd = parseAmf0StringAt(msg.payload, 0)
                                when {
                                    nameAndEnd?.first == "_result" && state == "connecting" -> {
                                        state = "creating"
                                        pendingSend = buildCreateStream()
                                    }
                                    nameAndEnd?.first == "_result" && state == "creating" -> {
                                        // Extract stream ID from AMF0 number after null
                                        val sidEnd = nameAndEnd.second
                                        val sid = parseAmf0NumberAfterNull(msg.payload, sidEnd)
                                        msgStreamId = sid?.first?.toInt() ?: 1
                                        state = "playing"
                                        pendingSend = buildPlay(streamName, msgStreamId)
                                    }
                                    nameAndEnd?.first == "onStatus" && state == "playing" -> {
                                        state = "streaming"
                                    }
                                }
                            }

                            MSG_DATA_AMF0 -> {
                                if (state == "streaming") {
                                    bytesOut += writeFLVTag(fos, 0x12, msg.timestamp, msg.payload)
                                    onProgress(bytesOut)
                                }
                            }
                            MSG_AUDIO -> {
                                if (state == "streaming") {
                                    bytesOut += writeFLVTag(fos, 0x08, msg.timestamp, msg.payload)
                                    onProgress(bytesOut)
                                }
                            }
                            MSG_VIDEO -> {
                                if (state == "streaming") {
                                    bytesOut += writeFLVTag(fos, 0x09, msg.timestamp, msg.payload)
                                    onProgress(bytesOut)
                                }
                            }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            onError(e.message ?: "RTMP download error")
        }
    }

    // ── Handshake ─────────────────────────────────────────────────────────────

    private fun handshake(inp: InputStream, out: OutputStream) {
        // C0 + C1: version byte + 1536-byte random block
        val c1 = ByteArray(1536)
        val ts = (System.currentTimeMillis() / 1000).toInt()
        c1[0] = (ts ushr 24).toByte()
        c1[1] = (ts ushr 16).toByte()
        c1[2] = (ts ushr  8).toByte()
        c1[3] = ts.toByte()
        // bytes 4-7 = zero; bytes 8-1535 = random
        SecureRandom().nextBytes(c1.copyOfRange(8, 1536).also { rnd ->
            System.arraycopy(rnd, 0, c1, 8, rnd.size)
        })
        out.write(RTMP_VERSION.toInt())
        out.write(c1)
        out.flush()

        // S0 + S1 + S2: 1 + 1536 + 1536 = 3073 bytes
        val s0s1s2 = ByteArray(3073)
        readFully(inp, s0s1s2)

        // C2 = echo of S1 (bytes 1..1536)
        val c2 = s0s1s2.copyOfRange(1, 1537)
        out.write(c2)
        out.flush()
    }

    // ── Message reading ───────────────────────────────────────────────────────

    private data class RtmpMsg(
        val typeId:    Int,
        val timestamp: Long,
        val streamId:  Int,
        val payload:   ByteArray,
    )

    /** Read and fully reassemble the next RTMP message from [inp]. */
    private fun readMessage(inp: InputStream): RtmpMsg? {
        // We keep reading chunks until a complete message is assembled.
        while (true) {
            val b0 = inp.read()
            if (b0 < 0) return null

            val fmt  = (b0 ushr 6) and 0x3
            val csid = when (val raw = b0 and 0x3F) {
                0    -> inp.read() + 64
                1    -> { val lo = inp.read(); val hi = inp.read(); hi * 256 + lo + 64 }
                else -> raw
            }
            if (csid < 0) return null

            val st = chunkState(csid)

            // Parse message header based on chunk format
            when (fmt) {
                0 -> {
                    var ts = read3BytesBE(inp)
                    st.msgLength   = read3BytesBE(inp)
                    st.msgTypeId   = inp.read()
                    st.msgStreamId = readInt32LEFromStream(inp)
                    if (ts == 0xFFFFFF) ts = readInt32BEFromStream(inp)
                    st.timestamp   = ts.toLong()
                }
                1 -> {
                    var delta = read3BytesBE(inp)
                    st.msgLength  = read3BytesBE(inp)
                    st.msgTypeId  = inp.read()
                    if (delta == 0xFFFFFF) delta = readInt32BEFromStream(inp)
                    st.timestamp += delta.toLong()
                }
                2 -> {
                    var delta = read3BytesBE(inp)
                    if (delta == 0xFFFFFF) delta = readInt32BEFromStream(inp)
                    st.timestamp += delta.toLong()
                }
                // fmt 3: continuation — no header bytes
            }

            val buf = msgBuffers.getOrPut(csid) { MsgBuffer(remaining = st.msgLength) }
            if (fmt == 0 || fmt == 1) {
                buf.data.reset()
                buf.remaining = st.msgLength
            }

            val toRead = minOf(inChunkSize, buf.remaining)
            if (toRead > 0) {
                val chunk = ByteArray(toRead)
                readFully(inp, chunk)
                buf.data.write(chunk)
                buf.remaining -= toRead
            }

            if (buf.remaining == 0 && buf.data.size() > 0) {
                val payload = buf.data.toByteArray()
                buf.data.reset()
                return RtmpMsg(st.msgTypeId, st.timestamp, st.msgStreamId, payload)
            }
            // else: message not yet complete — continue the loop to read the next chunk
        }
    }

    // ── RTMP message builders ─────────────────────────────────────────────────

    private fun sendSetChunkSize(out: OutputStream, size: Int) {
        val payload = byteArrayOf(
            ((size ushr 24) and 0x7F).toByte(),
            ((size ushr 16) and 0xFF).toByte(),
            ((size ushr  8) and 0xFF).toByte(),
            (size           and 0xFF).toByte(),
        )
        writeChunks(out, csid = 2, typeId = MSG_SET_CHUNK_SIZE, streamId = 0, timestamp = 0, payload)
    }

    private fun sendConnect(out: OutputStream, host: String, port: Int, app: String) {
        val tcUrl = "rtmp://$host:$port/$app"
        val buf = ByteArrayOutputStream()
        amf0WriteString(buf, "connect")
        amf0WriteNumber(buf, 1.0)
        amf0WriteObject(buf, linkedMapOf(
            "app"            to app,
            "type"           to "nonprivate",
            "flashVer"       to "WIN 32,0,0,114",
            "swfUrl"         to "",
            "tcUrl"          to tcUrl,
            "fpad"           to false,
            "capabilities"   to 15.0,
            "audioCodecs"    to 3575.0,
            "videoCodecs"    to 252.0,
            "videoFunction"  to 1.0,
            "pageUrl"        to "",
        ))
        writeChunks(out, csid = 3, typeId = MSG_CMD_AMF0, streamId = 0, timestamp = 0, buf.toByteArray())
    }

    private fun buildCreateStream(): ByteArray {
        val buf = ByteArrayOutputStream()
        amf0WriteString(buf, "createStream")
        amf0WriteNumber(buf, 2.0)
        buf.write(AMF0_NULL.toInt())
        val pkt = ByteArrayOutputStream()
        writeChunksTo(pkt, csid = 3, typeId = MSG_CMD_AMF0, streamId = 0, timestamp = 0, buf.toByteArray())
        return pkt.toByteArray()
    }

    private fun buildPlay(streamName: String, msgStreamId: Int): ByteArray {
        val buf = ByteArrayOutputStream()
        amf0WriteString(buf, "play")
        amf0WriteNumber(buf, 0.0)
        buf.write(AMF0_NULL.toInt())
        amf0WriteString(buf, streamName)
        val pkt = ByteArrayOutputStream()
        writeChunksTo(pkt, csid = 8, typeId = MSG_CMD_AMF0, streamId = msgStreamId, timestamp = 0, buf.toByteArray())
        return pkt.toByteArray()
    }

    // ── Chunk encoding helpers ────────────────────────────────────────────────

    private fun writeChunks(out: OutputStream, csid: Int, typeId: Int, streamId: Int, timestamp: Long, payload: ByteArray) {
        val buf = ByteArrayOutputStream()
        writeChunksTo(buf, csid, typeId, streamId, timestamp, payload)
        out.write(buf.toByteArray())
        out.flush()
    }

    private fun writeChunksTo(out: ByteArrayOutputStream, csid: Int, typeId: Int, streamId: Int, timestamp: Long, payload: ByteArray) {
        var offset = 0
        val chunkSize = DEFAULT_OUT_CHUNK_SIZE
        while (offset < payload.size) {
            val first = offset == 0
            // Basic header: fmt=0 first, fmt=3 continuation
            out.write(if (first) (csid and 0x3F) else (0xC0 or (csid and 0x3F)))
            if (first) {
                val ts = minOf(timestamp, 0xFFFFFEL)
                out.write(((ts ushr 16) and 0xFF).toInt())
                out.write(((ts ushr  8) and 0xFF).toInt())
                out.write((ts          and 0xFF).toInt())
                out.write((payload.size ushr 16) and 0xFF)
                out.write((payload.size ushr  8) and 0xFF)
                out.write( payload.size          and 0xFF)
                out.write(typeId and 0xFF)
                // Stream ID in little-endian
                out.write((streamId        ) and 0xFF)
                out.write((streamId ushr  8) and 0xFF)
                out.write((streamId ushr 16) and 0xFF)
                out.write((streamId ushr 24) and 0xFF)
            }
            val end = minOf(offset + chunkSize, payload.size)
            out.write(payload, offset, end - offset)
            offset = end
        }
    }

    // ── FLV output ────────────────────────────────────────────────────────────

    private fun writeFLVHeader(fos: FileOutputStream) {
        fos.write(byteArrayOf(
            'F'.code.toByte(), 'L'.code.toByte(), 'V'.code.toByte(),
            0x01,                                    // version
            0x05,                                    // flags: audio + video
            0x00, 0x00, 0x00, 0x09,                  // header size = 9
        ))
        fos.write(byteArrayOf(0x00, 0x00, 0x00, 0x00)) // previous tag size 0
    }

    /** Write one FLV tag and return the total bytes written. */
    private fun writeFLVTag(fos: FileOutputStream, tagType: Int, ts: Long, data: ByteArray): Long {
        val dataSize = data.size
        val ts24     = (ts and 0xFFFFFFL).toInt()
        val tsExt    = ((ts ushr 24) and 0xFFL).toInt()
        fos.write(tagType and 0xFF)
        fos.write((dataSize ushr 16) and 0xFF)
        fos.write((dataSize ushr  8) and 0xFF)
        fos.write( dataSize          and 0xFF)
        fos.write((ts24 ushr 16) and 0xFF)
        fos.write((ts24 ushr  8) and 0xFF)
        fos.write( ts24          and 0xFF)
        fos.write(tsExt)
        fos.write(0); fos.write(0); fos.write(0) // stream ID = 0
        fos.write(data)
        val prevSize = 11 + dataSize
        fos.write((prevSize ushr 24) and 0xFF)
        fos.write((prevSize ushr 16) and 0xFF)
        fos.write((prevSize ushr  8) and 0xFF)
        fos.write( prevSize          and 0xFF)
        return (prevSize + 4).toLong()
    }

    // ── AMF0 encoding ─────────────────────────────────────────────────────────

    private fun amf0WriteString(out: OutputStream, s: String) {
        val bytes = s.toByteArray(Charsets.UTF_8)
        out.write(AMF0_STRING.toInt())
        out.write((bytes.size ushr 8) and 0xFF)
        out.write( bytes.size         and 0xFF)
        out.write(bytes)
    }

    private fun amf0WriteNumber(out: OutputStream, n: Double) {
        out.write(AMF0_NUMBER.toInt())
        val bits = java.lang.Double.doubleToLongBits(n)
        for (i in 7 downTo 0) out.write(((bits ushr (i * 8)) and 0xFF).toInt())
    }

    private fun amf0WriteObject(out: OutputStream, props: Map<String, Any?>) {
        out.write(AMF0_OBJECT.toInt())
        for ((key, value) in props) {
            val keyBytes = key.toByteArray(Charsets.UTF_8)
            out.write((keyBytes.size ushr 8) and 0xFF)
            out.write( keyBytes.size         and 0xFF)
            out.write(keyBytes)
            when (value) {
                is String  -> amf0WriteString(out, value)
                is Double  -> amf0WriteNumber(out, value)
                is Boolean -> { out.write(AMF0_BOOLEAN.toInt()); out.write(if (value) 1 else 0) }
                else       -> out.write(AMF0_NULL.toInt())
            }
        }
        out.write(0x00); out.write(0x00); out.write(AMF0_END_OBJ.toInt())
    }

    // ── AMF0 decoding (minimal — just what we need) ───────────────────────────

    /**
     * Parse an AMF0 string starting at [offset] in [buf].
     * Returns (value, endOffset) or null.
     */
    private fun parseAmf0StringAt(buf: ByteArray, offset: Int): Pair<String, Int>? {
        if (offset >= buf.size || buf[offset] != AMF0_STRING) return null
        if (offset + 3 > buf.size) return null
        val len = ((buf[offset + 1].toInt() and 0xFF) shl 8) or (buf[offset + 2].toInt() and 0xFF)
        val end = offset + 3 + len
        if (end > buf.size) return null
        return String(buf, offset + 3, len, Charsets.UTF_8) to end
    }

    /**
     * Skip any leading AMF0_NULL bytes at [offset], then parse an AMF0 number.
     * Returns (value, endOffset) or null.
     */
    private fun parseAmf0NumberAfterNull(buf: ByteArray, offset: Int): Pair<Double, Int>? {
        var pos = offset
        while (pos < buf.size && buf[pos] == AMF0_NULL) pos++
        if (pos >= buf.size || buf[pos] != AMF0_NUMBER) return null
        if (pos + 9 > buf.size) return null
        var bits = 0L
        for (i in 1..8) bits = (bits shl 8) or (buf[pos + i].toLong() and 0xFF)
        return java.lang.Double.longBitsToDouble(bits) to (pos + 9)
    }

    // ── Binary helpers ────────────────────────────────────────────────────────

    private fun readFully(inp: InputStream, buf: ByteArray) {
        var read = 0
        while (read < buf.size) {
            val n = inp.read(buf, read, buf.size - read)
            if (n < 0) throw EOFException("RTMP: premature EOF")
            read += n
        }
    }

    private fun read3BytesBE(inp: InputStream): Int {
        val b = ByteArray(3); readFully(inp, b)
        return ((b[0].toInt() and 0xFF) shl 16) or
               ((b[1].toInt() and 0xFF) shl  8) or
                (b[2].toInt() and 0xFF)
    }

    private fun readInt32BEFromStream(inp: InputStream): Int {
        val b = ByteArray(4); readFully(inp, b)
        return ((b[0].toInt() and 0xFF) shl 24) or
               ((b[1].toInt() and 0xFF) shl 16) or
               ((b[2].toInt() and 0xFF) shl  8) or
                (b[3].toInt() and 0xFF)
    }

    private fun readInt32LEFromStream(inp: InputStream): Int {
        val b = ByteArray(4); readFully(inp, b)
        return  (b[0].toInt() and 0xFF)          or
               ((b[1].toInt() and 0xFF) shl  8)  or
               ((b[2].toInt() and 0xFF) shl 16)  or
               ((b[3].toInt() and 0xFF) shl 24)
    }

    private fun readInt32BE(buf: ByteArray, offset: Int): Int =
        ((buf[offset    ].toInt() and 0xFF) shl 24) or
        ((buf[offset + 1].toInt() and 0xFF) shl 16) or
        ((buf[offset + 2].toInt() and 0xFF) shl  8) or
         (buf[offset + 3].toInt() and 0xFF)

    // ── URL parsing ───────────────────────────────────────────────────────────

    private data class RtmpParsed(
        val scheme:     String,
        val host:       String,
        val port:       Int,
        val app:        String,
        val streamName: String,
    )

    private fun parseRtmpUrl(url: String): RtmpParsed? {
        // rtmp[s]://host[:port]/app/streamName[?query]
        val lower = url.lowercase()
        val (scheme, rest) = when {
            lower.startsWith("rtmps://") -> "rtmps" to url.substring(8)
            lower.startsWith("rtmp://")  -> "rtmp"  to url.substring(7)
            else                          -> return null
        }
        val defaultPort = if (scheme == "rtmps") 443 else 1935
        val hostEnd = rest.indexOf('/')
        if (hostEnd < 0) return null
        val hostPort = rest.substring(0, hostEnd)
        val (host, port) = if (':' in hostPort) {
            val parts = hostPort.split(':', limit = 2)
            parts[0] to (parts[1].toIntOrNull() ?: defaultPort)
        } else {
            hostPort to defaultPort
        }
        val pathAndQuery = rest.substring(hostEnd + 1).trimStart('/')
        val pathOnly     = pathAndQuery.substringBefore('?')
        val slashIdx     = pathOnly.indexOf('/')
        val app          = if (slashIdx < 0) pathOnly else pathOnly.substring(0, slashIdx)
        val streamName   = if (slashIdx < 0) "" else pathOnly.substring(slashIdx + 1).substringBefore('?')
        return RtmpParsed(scheme, host, port, app, streamName)
    }
}
