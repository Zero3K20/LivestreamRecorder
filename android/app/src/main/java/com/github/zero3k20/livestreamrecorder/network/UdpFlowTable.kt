package com.github.zero3k20.livestreamrecorder.network

import android.net.VpnService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap

/**
 * Maintains per-flow state for UDP traffic through the VPN TUN interface.
 *
 * Unlike a one-shot "send one datagram, receive one response" approach, this
 * table keeps a [protect]ed [DatagramSocket] open for each (src, dst) 4-tuple
 * for the lifetime of the UDP "session".  This allows protocols that exchange
 * multiple datagrams — most notably QUIC / HTTP/3 on UDP/443 — to work
 * correctly through the VPN instead of failing after the first response packet.
 *
 * Each flow is reaped automatically after [IDLE_TIMEOUT_MS] of inactivity.
 */
class UdpFlowTable(
    private val vpnService: VpnService,
    private val tunWrite: suspend (ByteArray) -> Unit,
    private val scope: CoroutineScope
) {
    companion object {
        private const val IDLE_TIMEOUT_MS  = 60_000L
        private const val REAP_INTERVAL_MS = 30_000L
        /** Max UDP payload: 64 KiB – 28 bytes (IP + UDP headers). */
        private const val MAX_UDP_PAYLOAD  = 65_507
    }

    private val flows = ConcurrentHashMap<String, UdpFlow>()

    init {
        // Periodic reaper: remove flows that have been idle too long.
        scope.launch {
            while (isActive) {
                delay(REAP_INTERVAL_MS)
                val cutoff = System.currentTimeMillis() - IDLE_TIMEOUT_MS
                val iter = flows.entries.iterator()
                while (iter.hasNext()) {
                    val entry = iter.next()
                    if (entry.value.lastActivityMs < cutoff) {
                        entry.value.close()
                        iter.remove()
                    }
                }
            }
        }
    }

    /** Dispatch a UDP packet arriving from the TUN to the correct [UdpFlow]. */
    fun handlePacket(packet: ByteArray) {
        try {
            val ipHdrLen = PacketParser.ipIHL(packet)
            val srcAddr  = PacketParser.ipSrc(packet)
            val dstAddr  = PacketParser.ipDst(packet)
            val srcPort  = PacketParser.udpSrc(packet, ipHdrLen)
            val dstPort  = PacketParser.udpDst(packet, ipHdrLen)
            val payload  = PacketParser.udpPayload(packet, ipHdrLen)
            if (payload.isEmpty()) return

            val key  = flowKey(srcAddr, srcPort, dstAddr, dstPort)
            val flow = flows.computeIfAbsent(key) {
                val f = UdpFlow(
                    vpnService = vpnService,
                    tunWrite   = tunWrite,
                    srcAddr    = srcAddr.copyOf(),
                    srcPort    = srcPort,
                    dstAddr    = dstAddr.copyOf(),
                    dstPort    = dstPort
                ) { flows.remove(key) }
                scope.launch { f.receiveLoop() }
                f
            }
            flow.send(payload)
        } catch (_: Exception) { /* malformed packet or socket error — drop */ }
    }

    /** Close all open flows; called when the VPN is torn down. */
    fun closeAll() {
        flows.values.forEach { it.close() }
        flows.clear()
    }

    private fun flowKey(
        srcAddr: ByteArray, srcPort: Int,
        dstAddr: ByteArray, dstPort: Int
    ): String {
        val fmt = { ip: ByteArray -> ip.joinToString(".") { (it.toInt() and 0xFF).toString() } }
        return "${fmt(srcAddr)}:$srcPort->${fmt(dstAddr)}:$dstPort"
    }

    // ── Per-flow state ────────────────────────────────────────────────────────

    /**
     * A single bidirectional UDP session identified by a 4-tuple.
     *
     * Outbound datagrams are forwarded immediately via [send]; inbound
     * datagrams are continuously received by [receiveLoop] and written back
     * to the TUN so that every response reaches the originating app.
     */
    class UdpFlow(
        private val vpnService: VpnService,
        private val tunWrite: suspend (ByteArray) -> Unit,
        private val srcAddr: ByteArray,
        private val srcPort: Int,
        private val dstAddr: ByteArray,
        private val dstPort: Int,
        private val onClosed: () -> Unit
    ) {
        @Volatile var lastActivityMs: Long = System.currentTimeMillis()
            private set

        private val dst = InetAddress.getByAddress(dstAddr)
        private val socket = DatagramSocket().also {
            vpnService.protect(it)
            // soTimeout slightly exceeds the idle timeout so the receive loop
            // exits cleanly when no response has arrived for a full minute.
            it.soTimeout = (IDLE_TIMEOUT_MS + 5_000).toInt()
        }

        /** Forward an outbound datagram (app → real server). */
        fun send(payload: ByteArray) {
            lastActivityMs = System.currentTimeMillis()
            try {
                socket.send(DatagramPacket(payload, payload.size, dst, dstPort))
            } catch (_: Exception) { close() }
        }

        /**
         * Blocking receive loop (runs on IO dispatcher inside [UdpFlowTable.scope]).
         * Every inbound datagram from the real server is written back to the TUN
         * so that the originating app receives all the packets it expects.
         */
        suspend fun receiveLoop() = withContext(Dispatchers.IO) {
            val buf = ByteArray(MAX_UDP_PAYLOAD)
            try {
                while (true) {
                    val resp = DatagramPacket(buf, buf.size)
                    socket.receive(resp)
                    lastActivityMs = System.currentTimeMillis()
                    val pkt = PacketParser.buildUdpPacket(
                        srcAddr = dstAddr, dstAddr = srcAddr,
                        srcPort = dstPort, dstPort = srcPort,
                        payload = resp.data.copyOf(resp.length)
                    )
                    tunWrite(pkt)
                }
            } catch (_: SocketTimeoutException) { /* idle timeout — normal exit */ }
            catch (e: CancellationException)    { throw e }
            catch (_: Exception)                { /* socket closed or network error */ }
            finally { close() }
        }

        fun close() {
            runCatching { socket.close() }
            onClosed()
        }
    }
}
