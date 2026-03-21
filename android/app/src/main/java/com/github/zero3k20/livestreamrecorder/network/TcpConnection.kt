package com.github.zero3k20.livestreamrecorder.network

import android.net.VpnService
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Handles a single TCP connection through the VPN proxy.
 *
 * Lifecycle:
 *   SYN received      → send SYN-ACK; begin connecting a [protect]ed socket to
 *                        the real destination in parallel.
 *   ACK received      → ESTABLISHED; flush any buffered client data.
 *   DATA received     → inspect the first chunk for HTTP stream URLs or TLS SNI;
 *                        relay every chunk to the real socket.
 *   FIN / RST         → close both sides.
 *   Real socket close → send FIN to client.
 *
 * Sequence numbers are unsigned 32-bit integers stored as [Long] to avoid
 * Kotlin's signed-byte arithmetic pitfalls.
 */
class TcpConnection(
    /** App-side IP address (packet source). */
    private val clientAddr: ByteArray,
    private val clientPort: Int,
    /** Real destination IP address. */
    private val serverAddr: ByteArray,
    private val serverPort: Int,
    /** Client's Initial Sequence Number from the SYN packet. */
    clientISN: Long,
    private val vpnService: VpnService,
    /** Coroutine-safe write function back to the TUN interface. */
    private val tunWrite: suspend (ByteArray) -> Unit,
    private val onStreamDetected: (url: String, type: String) -> Unit,
    /** Called when this connection has fully closed so the tracker can remove it. */
    private val onClosed: () -> Unit
) {
    private enum class State { SYN_RCVD, CONNECTING, ESTABLISHED, FIN_WAIT, CLOSED }

    // 32-bit sequence numbers; masking to 0xFFFF_FFFFL keeps them unsigned.
    private val ourISN: Long       = (System.nanoTime() ushr 8) and 0xFFFF_FFFFL
    private var nextClientSeq: Long = (clientISN + 1) and 0xFFFF_FFFFL
    private var nextOurSeq:    Long = (ourISN + 1)    and 0xFFFF_FFFFL

    @Volatile private var state = State.SYN_RCVD

    private val scope           = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val incomingChannel = Channel<ByteArray>(Channel.UNLIMITED)

    /** Payload bytes received before the real socket is ready — flushed on ESTABLISHED. */
    private val pendingToServer = ArrayDeque<ByteArray>()

    private var realSocket: Socket?       = null
    private var realIn:     InputStream?  = null
    private var realOut:    OutputStream? = null

    @Volatile private var firstDataInspected = false

    init {
        scope.launch {
            // Acknowledge the SYN immediately (our sequence number is ourISN here,
            // i.e. one before nextOurSeq — we haven't "consumed" ourISN yet).
            sendControl(PacketParser.TCP_SYN or PacketParser.TCP_ACK, ourISN)
            // Connect to real destination concurrently while we wait for ACK.
            launch { connectToRealDest() }
            processClientPackets()
        }
    }

    /** Feeds a raw packet from the TUN read-loop into this connection. */
    fun enqueuePacket(packet: ByteArray) {
        incomingChannel.trySend(packet)
    }

    // ── Client-packet processing ──────────────────────────────────────────────

    private suspend fun processClientPackets() {
        for (pkt in incomingChannel) {
            if (state == State.CLOSED) break
            val ipHdrLen = PacketParser.ipIHL(pkt)
            val tcpOff   = ipHdrLen
            val flags    = PacketParser.tcpFlags(pkt, tcpOff)
            val seqNum   = PacketParser.tcpSeq(pkt, tcpOff)
            val payload  = PacketParser.tcpPayload(pkt, ipHdrLen)
            when {
                flags and PacketParser.TCP_RST != 0 -> {
                    close(); return
                }
                // Duplicate SYN (e.g. retransmit before our SYN-ACK arrived)
                flags and PacketParser.TCP_SYN != 0 && flags and PacketParser.TCP_ACK == 0 -> {
                    sendControl(PacketParser.TCP_SYN or PacketParser.TCP_ACK, ourISN)
                }
                flags and PacketParser.TCP_ACK != 0 -> {
                    if (state == State.SYN_RCVD) state = State.CONNECTING
                    if (payload.isNotEmpty()) handleClientData(payload, seqNum)
                    if (flags and PacketParser.TCP_FIN != 0) { handleClientFin(); return }
                }
                flags and PacketParser.TCP_FIN != 0 -> { handleClientFin(); return }
            }
        }
    }

    private suspend fun handleClientData(payload: ByteArray, seqNum: Long) {
        // Simplified: accept only in-order segments; ignore out-of-order / retransmits.
        // Still send an ACK so the sender knows what we expect next and does not stall.
        if (seqNum != nextClientSeq) {
            sendControl(PacketParser.TCP_ACK, nextOurSeq)
            return
        }
        nextClientSeq = (nextClientSeq + payload.size) and 0xFFFF_FFFFL

        // Inspect the very first data chunk for stream-URL signals.
        if (!firstDataInspected) {
            firstDataInspected = true
            PacketParser.extractHttpStream(payload)?.let { (url, type) ->
                onStreamDetected(url, type)
            }
            if (serverPort == 443) {
                PacketParser.extractTlsSni(payload)?.let { sni ->
                    onStreamDetected("https://$sni/", "sni")
                }
            }
        }

        // ACK the data.
        sendControl(PacketParser.TCP_ACK, nextOurSeq)

        if (state != State.ESTABLISHED) {
            pendingToServer.addLast(payload)
            return
        }
        forwardToServer(payload)
    }

    private suspend fun handleClientFin() {
        state = State.FIN_WAIT
        nextClientSeq = (nextClientSeq + 1) and 0xFFFF_FFFFL
        sendControl(PacketParser.TCP_ACK,                    nextOurSeq)
        sendControl(PacketParser.TCP_FIN or PacketParser.TCP_ACK, nextOurSeq)
        nextOurSeq = (nextOurSeq + 1) and 0xFFFF_FFFFL
        close()
    }

    // ── Real-socket connection & relay ────────────────────────────────────────

    private suspend fun connectToRealDest() {
        try {
            val sock = Socket()
            vpnService.protect(sock)
            withContext(Dispatchers.IO) {
                sock.connect(
                    InetSocketAddress(InetAddress.getByAddress(serverAddr), serverPort),
                    10_000
                )
            }
            sock.soTimeout = 0
            realSocket = sock
            realIn     = sock.getInputStream()
            realOut    = sock.getOutputStream()
            state      = State.ESTABLISHED

            // Flush any data that arrived before we finished connecting.
            for (buffered in pendingToServer) forwardToServer(buffered)
            pendingToServer.clear()

            // Start server→client relay.
            scope.launch { relayServerToClient() }
        } catch (_: Exception) {
            sendControl(PacketParser.TCP_RST, nextOurSeq)
            close()
        }
    }

    private suspend fun forwardToServer(data: ByteArray) {
        try {
            withContext(Dispatchers.IO) {
                realOut?.write(data)
                realOut?.flush()
            }
        } catch (_: IOException) {
            close()
        }
    }

    private suspend fun relayServerToClient() {
        val buf = ByteArray(4_096)
        try {
            while (coroutineContext.isActive && state == State.ESTABLISHED) {
                val n = withContext(Dispatchers.IO) { realIn?.read(buf) ?: -1 }
                if (n < 0) break
                val chunk = buf.copyOf(n)
                val pkt = PacketParser.buildTcpPacket(
                    srcAddr = serverAddr, dstAddr = clientAddr,
                    srcPort = serverPort, dstPort = clientPort,
                    seq     = nextOurSeq,
                    ack     = nextClientSeq,
                    flags   = PacketParser.TCP_ACK or PacketParser.TCP_PSH,
                    payload = chunk
                )
                tunWrite(pkt)
                nextOurSeq = (nextOurSeq + n) and 0xFFFF_FFFFL
            }
        } catch (_: Exception) { /* socket closed */ }

        if (state == State.ESTABLISHED) {
            sendControl(PacketParser.TCP_FIN or PacketParser.TCP_ACK, nextOurSeq)
            nextOurSeq = (nextOurSeq + 1) and 0xFFFF_FFFFL
        }
        close()
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Send a control packet (no payload) in the server→client direction. */
    private suspend fun sendControl(flags: Int, seq: Long) {
        val pkt = PacketParser.buildTcpPacket(
            srcAddr = serverAddr, dstAddr = clientAddr,
            srcPort = serverPort, dstPort = clientPort,
            seq     = seq,
            ack     = nextClientSeq,
            flags   = flags
        )
        tunWrite(pkt)
    }

    fun close() {
        if (state == State.CLOSED) return
        state = State.CLOSED
        scope.cancel()
        runCatching { realSocket?.close() }
        incomingChannel.close()
        onClosed()
    }
}
