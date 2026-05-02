package com.github.zero3k20.livestreamrecorder.network

/**
 * Low-level IPv4 / TCP / UDP packet parsing and building.
 * All multi-byte integers are big-endian (network byte order).
 *
 * This module is intentionally pure-Kotlin with no Android dependencies so
 * that it can be unit-tested on the JVM without an emulator.
 */
object PacketParser {

    // ── Protocol numbers ──────────────────────────────────────────────────────
    const val PROTO_TCP = 6
    const val PROTO_UDP = 17

    // ── TCP flag bits ─────────────────────────────────────────────────────────
    const val TCP_FIN = 0x01
    const val TCP_SYN = 0x02
    const val TCP_RST = 0x04
    const val TCP_PSH = 0x08
    const val TCP_ACK = 0x10

    // ── IPv4 accessors ────────────────────────────────────────────────────────

    /** IP version (should be 4 for IPv4). */
    fun ipVersion(p: ByteArray): Int = (p[0].toInt() ushr 4) and 0xF

    /** IPv4 header length in bytes (IHL field × 4). */
    fun ipIHL(p: ByteArray): Int = (p[0].toInt() and 0xF) * 4

    /** Protocol field (6 = TCP, 17 = UDP). */
    fun ipProto(p: ByteArray): Int = p[9].toInt() and 0xFF

    /** Copy of the 4-byte source IP address. */
    fun ipSrc(p: ByteArray): ByteArray = p.copyOfRange(12, 16)

    /** Copy of the 4-byte destination IP address. */
    fun ipDst(p: ByteArray): ByteArray = p.copyOfRange(16, 20)

    // ── TCP accessors (o = start byte of TCP header within the packet) ────────

    fun tcpSrc(p: ByteArray, o: Int): Int = (u8(p, o) shl 8) or u8(p, o + 1)
    fun tcpDst(p: ByteArray, o: Int): Int = (u8(p, o + 2) shl 8) or u8(p, o + 3)

    /** 32-bit sequence number as an unsigned Long. */
    fun tcpSeq(p: ByteArray, o: Int): Long =
        (u8(p, o + 4).toLong() shl 24) or
        (u8(p, o + 5).toLong() shl 16) or
        (u8(p, o + 6).toLong() shl 8)  or
        u8(p, o + 7).toLong()

    /** 32-bit acknowledgment number as an unsigned Long. */
    fun tcpAck(p: ByteArray, o: Int): Long =
        (u8(p, o + 8).toLong() shl 24) or
        (u8(p, o + 9).toLong() shl 16) or
        (u8(p, o + 10).toLong() shl 8) or
        u8(p, o + 11).toLong()

    /** TCP header length in bytes (data-offset field × 4). */
    fun tcpHdrLen(p: ByteArray, o: Int): Int = ((p[o + 12].toInt() ushr 4) and 0xF) * 4

    /** TCP flags byte. */
    fun tcpFlags(p: ByteArray, o: Int): Int = p[o + 13].toInt() and 0xFF

    /**
     * Returns a copy of the TCP payload (bytes after the TCP header),
     * or an empty array if the packet carries no payload.
     */
    fun tcpPayload(p: ByteArray, ipHdrLen: Int): ByteArray {
        val start = ipHdrLen + tcpHdrLen(p, ipHdrLen)
        return if (start < p.size) p.copyOfRange(start, p.size) else ByteArray(0)
    }

    // ── UDP accessors (o = start byte of UDP header within the packet) ────────

    fun udpSrc(p: ByteArray, o: Int): Int = (u8(p, o) shl 8) or u8(p, o + 1)
    fun udpDst(p: ByteArray, o: Int): Int = (u8(p, o + 2) shl 8) or u8(p, o + 3)

    /** Returns a copy of the UDP payload (after the 8-byte UDP header). */
    fun udpPayload(p: ByteArray, ipHdrLen: Int): ByteArray {
        val start = ipHdrLen + 8
        return if (start < p.size) p.copyOfRange(start, p.size) else ByteArray(0)
    }

    // ── Packet building ───────────────────────────────────────────────────────

    /**
     * Builds a minimal 20-byte-IP + 20-byte-TCP packet (no IP/TCP options).
     * IP and TCP checksums are computed and filled in.
     */
    fun buildTcpPacket(
        srcAddr: ByteArray,
        dstAddr: ByteArray,
        srcPort: Int,
        dstPort: Int,
        seq: Long,
        ack: Long,
        flags: Int,
        window: Int = 65535,
        payload: ByteArray = ByteArray(0)
    ): ByteArray {
        val totalLen = 40 + payload.size      // 20 (IP) + 20 (TCP) + data
        val buf = ByteArray(totalLen)

        // ── IPv4 header ────────────────────────────────────────────────────────
        buf[0] = 0x45.toByte()                // version=4, IHL=5 (20 bytes)
        buf[2] = (totalLen ushr 8).toByte()
        buf[3] = (totalLen and 0xFF).toByte()
        buf[6] = 0x40.toByte()                // Don't Fragment; fragment offset=0
        buf[8] = 64                           // TTL
        buf[9] = PROTO_TCP.toByte()
        srcAddr.copyInto(buf, 12)
        dstAddr.copyInto(buf, 16)
        fillIpChecksum(buf)

        // ── TCP header ─────────────────────────────────────────────────────────
        val t = 20
        buf[t]     = (srcPort ushr 8).toByte()
        buf[t + 1] = (srcPort and 0xFF).toByte()
        buf[t + 2] = (dstPort ushr 8).toByte()
        buf[t + 3] = (dstPort and 0xFF).toByte()
        putU32(buf, t + 4,  seq)
        putU32(buf, t + 8,  ack)
        buf[t + 12] = 0x50.toByte()           // data offset=5 (20 bytes)
        buf[t + 13] = (flags and 0xFF).toByte()
        buf[t + 14] = (window ushr 8).toByte()
        buf[t + 15] = (window and 0xFF).toByte()
        payload.copyInto(buf, 40)
        fillTcpChecksum(buf, srcAddr, dstAddr)

        return buf
    }

    /**
     * Builds a minimal 20-byte-IP + 8-byte-UDP packet.
     * IP checksum is computed; UDP checksum is left as 0 (optional for IPv4).
     */
    fun buildUdpPacket(
        srcAddr: ByteArray,
        dstAddr: ByteArray,
        srcPort: Int,
        dstPort: Int,
        payload: ByteArray
    ): ByteArray {
        val udpLen   = 8 + payload.size
        val totalLen = 20 + udpLen
        val buf = ByteArray(totalLen)

        buf[0] = 0x45.toByte()
        buf[2] = (totalLen ushr 8).toByte()
        buf[3] = (totalLen and 0xFF).toByte()
        buf[6] = 0x40.toByte()
        buf[8] = 64
        buf[9] = PROTO_UDP.toByte()
        srcAddr.copyInto(buf, 12)
        dstAddr.copyInto(buf, 16)
        fillIpChecksum(buf)

        val u = 20
        buf[u]     = (srcPort ushr 8).toByte()
        buf[u + 1] = (srcPort and 0xFF).toByte()
        buf[u + 2] = (dstPort ushr 8).toByte()
        buf[u + 3] = (dstPort and 0xFF).toByte()
        buf[u + 4] = (udpLen ushr 8).toByte()
        buf[u + 5] = (udpLen and 0xFF).toByte()
        // bytes [u+6..u+7] = 0 — UDP checksum optional for IPv4
        payload.copyInto(buf, 28)

        return buf
    }

    // ── HTTP / TLS / RTMP stream detection ───────────────────────────────────────

    /**
     * Returns (url, type) if [data] looks like the start of an HTTP request
     * for a known stream URL (HLS/FLV/MP4 etc.), or null otherwise.
     */
    fun extractHttpStream(data: ByteArray): Pair<String, String>? {
        if (data.size < 10) return null
        val text = try { String(data, Charsets.ISO_8859_1) } catch (_: Exception) { return null }
        if (!text.startsWith("GET ") && !text.startsWith("POST ")) return null
        val lineEnd = text.indexOf("\r\n").takeIf { it > 0 } ?: return null
        val parts   = text.substring(0, lineEnd).split(" ")
        if (parts.size < 2) return null
        val path    = parts[1]
        val host    = Regex("""(?i)\r\nHost:\s*([^\r\n]+)""").find(text)
                          ?.groupValues?.get(1)?.trim() ?: return null
        val url     = "http://$host$path"
        val type    = StreamDetector.detectType(url) ?: return null
        return url to type
    }

    /**
     * Returns the SNI hostname from a TLS ClientHello record, or null if the
     * data does not contain one or cannot be parsed.
     */
    fun extractTlsSni(data: ByteArray): String? {
        // TLS record layer: content_type(1)=0x16, version(2), length(2)
        if (data.size < 5 || data[0] != 0x16.toByte()) return null
        // Handshake: msg_type(1)=0x01 (ClientHello), length(3)
        if (data.size < 6 || data[5] != 0x01.toByte()) return null
        // ClientHello body starts at byte 9
        var pos = 9
        pos += 2 + 32                                      // legacy_version + random
        if (pos >= data.size) return null
        val sidLen = u8(data, pos); pos += 1 + sidLen      // session_id_len + session_id
        if (pos + 2 > data.size) return null
        val csLen = (u8(data, pos) shl 8) or u8(data, pos + 1); pos += 2 + csLen // cipher_suites
        if (pos >= data.size) return null
        val cmLen = u8(data, pos); pos += 1 + cmLen        // compression_methods
        if (pos + 2 > data.size) return null
        val extTotal = (u8(data, pos) shl 8) or u8(data, pos + 1); pos += 2
        val extEnd = pos + extTotal
        while (pos + 4 <= extEnd && pos + 4 <= data.size) {
            val extType = (u8(data, pos) shl 8) or u8(data, pos + 1)
            val extLen  = (u8(data, pos + 2) shl 8) or u8(data, pos + 3)
            pos += 4
            if (extType == 0x0000 /* server_name */ && pos + 5 <= data.size) {
                // ServerNameList: list_len(2) + entry_type(1)=0 + name_len(2) + name
                val nameLen   = (u8(data, pos + 3) shl 8) or u8(data, pos + 4)
                val nameStart = pos + 5
                if (nameStart + nameLen <= data.size) {
                    return String(data, nameStart, nameLen, Charsets.US_ASCII)
                }
                return null
            }
            pos += extLen
        }
        return null
    }

    /**
     * Attempt to extract the `tcUrl` field from an RTMP C0+C1+C2 handshake or
     * connect command payload.
     *
     * RTMP handshake: C0 (1 byte version = 0x03) + C1 (1536 bytes random) = 1537 bytes
     * before any AMF0 data arrives.  Once the handshake completes, the client sends
     * a `connect` AMF0 command whose first property is `tcUrl` (the stream URL).
     *
     * Parsing full AMF0 is complex; instead we scan the raw bytes for the ASCII
     * string `"tcUrl"` followed by the AMF0 string type (0x02) and a 2-byte length,
     * then read the value.  This heuristic is robust against padding variations.
     *
     * Falls back to building a bare `rtmp://host/` URL from [serverAddr] when no
     * `tcUrl` is found (e.g. during the C0/C1 handshake phase).
     *
     * @param data       Raw TCP payload bytes.
     * @param serverAddr 4-byte destination IP address.
     * @return Extracted RTMP stream URL, or null if the data cannot be parsed.
     */
    fun extractRtmpUrl(data: ByteArray, serverAddr: ByteArray): String? {
        if (data.size < 2) return null
        val text = try { String(data, Charsets.ISO_8859_1) } catch (_: Exception) { return null }

        // Search for the "tcUrl" key in the AMF0 connect command.
        // AMF0 key format: 2-byte length (big-endian) + UTF-8 characters.
        // We search for the key name bytes directly for simplicity.
        val tcUrlKey = "tcUrl"
        var pos = text.indexOf(tcUrlKey)
        while (pos >= 0) {
            // After the key name comes: AMF0 type (1 byte), then for type=0x02 (String):
            //   2-byte length + string bytes.
            val valStart = pos + tcUrlKey.length
            if (valStart + 3 < data.size && data[valStart] == 0x02.toByte()) {
                val strLen = (u8(data, valStart + 1) shl 8) or u8(data, valStart + 2)
                val strStart = valStart + 3
                if (strLen > 0 && strStart + strLen <= data.size) {
                    val candidate = try {
                        String(data, strStart, strLen, Charsets.UTF_8)
                    } catch (_: Exception) { null }
                    if (candidate != null && candidate.startsWith("rtmp", ignoreCase = true)) {
                        return candidate
                    }
                }
            }
            pos = text.indexOf(tcUrlKey, pos + 1)
        }
        return null
    }

    // ── Checksum helpers ──────────────────────────────────────────────────────

    private fun fillIpChecksum(buf: ByteArray) {
        buf[10] = 0; buf[11] = 0
        val c = checksum(buf, 0, 20)
        buf[10] = (c ushr 8).toByte()
        buf[11] = (c and 0xFF).toByte()
    }

    private fun fillTcpChecksum(buf: ByteArray, srcAddr: ByteArray, dstAddr: ByteArray) {
        val tcpLen = buf.size - 20
        // Zero the TCP checksum field before computing
        buf[36] = 0; buf[37] = 0
        // Build the pseudo-header: src(4) + dst(4) + zero(1) + proto(1) + tcpLen(2) = 12 bytes
        val pseudo = ByteArray(12 + tcpLen)
        srcAddr.copyInto(pseudo, 0)
        dstAddr.copyInto(pseudo, 4)
        pseudo[9]  = PROTO_TCP.toByte()
        pseudo[10] = (tcpLen ushr 8).toByte()
        pseudo[11] = (tcpLen and 0xFF).toByte()
        buf.copyInto(pseudo, 12, 20)          // TCP header + data
        val c = checksum(pseudo)
        buf[36] = (c ushr 8).toByte()
        buf[37] = (c and 0xFF).toByte()
    }

    /** Internet checksum (RFC 1071): one's complement of the sum of 16-bit words. */
    fun checksum(data: ByteArray, offset: Int = 0, len: Int = data.size): Int {
        var sum = 0L
        var i   = offset
        val end = offset + len
        while (i < end - 1) {
            sum += (u8(data, i).toLong() shl 8) or u8(data, i + 1).toLong()
            i += 2
        }
        if (i < end) sum += u8(data, i).toLong() shl 8
        while (sum ushr 16 != 0L) sum = (sum and 0xFFFF) + (sum ushr 16)
        return (sum.inv() and 0xFFFF).toInt()
    }

    // ── Byte helpers ──────────────────────────────────────────────────────────

    private fun u8(p: ByteArray, i: Int): Int = p[i].toInt() and 0xFF

    private fun putU32(buf: ByteArray, offset: Int, v: Long) {
        buf[offset]     = (v ushr 24 and 0xFF).toByte()
        buf[offset + 1] = (v ushr 16 and 0xFF).toByte()
        buf[offset + 2] = (v ushr 8  and 0xFF).toByte()
        buf[offset + 3] = (v         and 0xFF).toByte()
    }
}
