package com.github.zero3k20.livestreamrecorder.network

import android.net.VpnService
import java.util.concurrent.ConcurrentHashMap

/**
 * Demultiplexes raw TCP packets arriving on the TUN interface to their
 * corresponding [TcpConnection] instance, keyed by the 4-tuple
 * (srcIP, srcPort, dstIP, dstPort).
 */
class TcpProxyHandler(
    private val vpnService: VpnService,
    private val tunWrite: suspend (ByteArray) -> Unit,
    private val onStreamDetected: (url: String, type: String) -> Unit
) {
    private val connections = ConcurrentHashMap<String, TcpConnection>()

    fun handlePacket(packet: ByteArray) {
        val ipHdrLen = PacketParser.ipIHL(packet)
        if (packet.size < ipHdrLen + 20) return

        val tcpOff  = ipHdrLen
        val srcAddr = PacketParser.ipSrc(packet)
        val dstAddr = PacketParser.ipDst(packet)
        val srcPort = PacketParser.tcpSrc(packet, tcpOff)
        val dstPort = PacketParser.tcpDst(packet, tcpOff)
        val flags   = PacketParser.tcpFlags(packet, tcpOff)
        val key     = connKey(srcAddr, srcPort, dstAddr, dstPort)

        if (flags and PacketParser.TCP_SYN != 0 && flags and PacketParser.TCP_ACK == 0) {
            // New connection — create a TcpConnection and store it.
            val conn = TcpConnection(
                clientAddr       = srcAddr,
                clientPort       = srcPort,
                serverAddr       = dstAddr,
                serverPort       = dstPort,
                clientISN        = PacketParser.tcpSeq(packet, tcpOff),
                vpnService       = vpnService,
                tunWrite         = tunWrite,
                onStreamDetected = onStreamDetected,
                onClosed         = { connections.remove(key) }
            )
            connections[key] = conn
            conn.enqueuePacket(packet)
        } else {
            connections[key]?.enqueuePacket(packet)
            // Packets for unknown connections are silently dropped; the originator
            // will retransmit or time out, which is acceptable behaviour.
        }
    }

    fun closeAll() {
        connections.values.forEach { it.close() }
        connections.clear()
    }

    private fun connKey(
        a: ByteArray, ap: Int,
        b: ByteArray, bp: Int
    ): String {
        val fmt = { ip: ByteArray -> ip.joinToString(".") { (it.toInt() and 0xFF).toString() } }
        return "${fmt(a)}:$ap>${fmt(b)}:$bp"
    }
}
