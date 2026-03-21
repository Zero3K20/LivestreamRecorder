package com.github.zero3k20.livestreamrecorder

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import androidx.core.app.NotificationCompat
import com.github.zero3k20.livestreamrecorder.network.PacketParser
import com.github.zero3k20.livestreamrecorder.network.TcpProxyHandler
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

/**
 * A [VpnService] that routes all TCP/UDP traffic on the device through a local
 * TUN interface in order to inspect it for live-stream URLs.
 *
 * For each TCP connection:
 *   - A [TcpProxyHandler] manages a [TcpConnection] per 4-tuple.
 *   - The first HTTP request is scanned for stream URLs (HLS, FLV, MP4 …).
 *   - TLS connections are inspected for the SNI hostname from the ClientHello.
 *   - All traffic is forwarded transparently via protect()-ed sockets so that
 *     apps continue to work normally.
 *
 * UDP packets (most importantly DNS queries) are forwarded via protected
 * [DatagramSocket]s so that name resolution continues to work.
 *
 * When a stream URL (or SNI hostname) is detected a local broadcast is sent to
 * [MainActivity] which adds it to the detected-streams list.
 */
class StreamCaptureVpnService : VpnService() {

    companion object {
        const val ACTION_START = "com.github.zero3k20.livestreamrecorder.START_VPN"
        const val ACTION_STOP  = "com.github.zero3k20.livestreamrecorder.STOP_VPN"

        /** Broadcast sent when a stream URL or SNI hostname is detected. */
        const val ACTION_STREAM_DETECTED = "com.github.zero3k20.livestreamrecorder.STREAM_DETECTED"
        const val EXTRA_STREAM_URL       = "url"
        const val EXTRA_STREAM_TYPE      = "type"

        /** Broadcast sent when the VPN starts or stops. */
        const val ACTION_VPN_STATE    = "com.github.zero3k20.livestreamrecorder.VPN_STATE"
        const val EXTRA_VPN_RUNNING   = "running"

        private const val CHANNEL_ID = "lsr_vpn_channel"
        private const val NOTIF_ID   = 1
    }

    private val scope      = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val writeMutex = Mutex()

    private var vpnIface: ParcelFileDescriptor? = null
    private var tunIn:    FileInputStream?      = null
    private var tunOut:   FileOutputStream?     = null
    private var tcpProxy: TcpProxyHandler?      = null

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopVpn()
            return START_NOT_STICKY
        }
        startVpn()
        return START_STICKY
    }

    override fun onRevoke() = stopVpn()

    override fun onDestroy() { stopVpn(); super.onDestroy() }

    // ── VPN start / stop ──────────────────────────────────────────────────────

    private fun startVpn() {
        // Coroutine-safe write back to the TUN interface; guarded by mutex so
        // that concurrent TcpConnection coroutines don't interleave their writes.
        val tunWrite: suspend (ByteArray) -> Unit = { data ->
            writeMutex.withLock { tunOut?.write(data) }
        }

        tcpProxy = TcpProxyHandler(
            vpnService       = this,
            tunWrite         = tunWrite,
            onStreamDetected = { url, type ->
                sendBroadcast(Intent(ACTION_STREAM_DETECTED).apply {
                    putExtra(EXTRA_STREAM_URL,  url)
                    putExtra(EXTRA_STREAM_TYPE, type)
                    `package` = packageName
                })
            }
        )

        val iface = Builder()
            .addAddress("10.0.0.2", 32)
            .addRoute("0.0.0.0", 0)           // capture all traffic
            .addDnsServer("8.8.8.8")
            .addDnsServer("8.8.4.4")
            .setSession(getString(R.string.app_name))
            .setBlocking(true)                // blocking read; runs on IO thread
            .establish()

        if (iface == null) { stopSelf(); return }

        vpnIface = iface
        tunIn    = FileInputStream(iface.fileDescriptor)
        tunOut   = FileOutputStream(iface.fileDescriptor)

        startForeground(NOTIF_ID, buildNotification())
        broadcastState(true)
        scope.launch(Dispatchers.IO) { packetLoop() }
    }

    private fun stopVpn() {
        scope.cancel()
        tcpProxy?.closeAll()
        runCatching { tunIn?.close() }
        runCatching { tunOut?.close() }
        runCatching { vpnIface?.close() }
        vpnIface = null
        broadcastState(false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ── Packet loop ───────────────────────────────────────────────────────────

    private suspend fun packetLoop() {
        val buf = ByteArray(32_767)
        try {
            while (coroutineContext.isActive) {
                val len = tunIn?.read(buf) ?: break
                if (len <= 0) continue
                val pkt = buf.copyOf(len)
                if (PacketParser.ipVersion(pkt) != 4) continue
                when (PacketParser.ipProto(pkt)) {
                    PacketParser.PROTO_TCP -> tcpProxy?.handlePacket(pkt)
                    PacketParser.PROTO_UDP -> scope.launch { forwardUdp(pkt) }
                }
            }
        } catch (_: Exception) { /* TUN fd closed on stopVpn() */ }
    }

    // ── UDP forwarding (DNS and other UDP traffic) ────────────────────────────

    /**
     * Forwards a single UDP datagram to its real destination via a protect()-ed
     * DatagramSocket, then writes the response back to the TUN interface.
     * DNS (port 53) is the most common case; QUIC/HTTP3 (port 443) is also
     * common but its responses are much larger and may be multi-packet; we
     * forward the first response datagram which is sufficient for DNS.
     */
    private suspend fun forwardUdp(pkt: ByteArray) = withContext(Dispatchers.IO) {
        try {
            val ipHdrLen = PacketParser.ipIHL(pkt)
            val srcAddr  = PacketParser.ipSrc(pkt)
            val dstAddr  = PacketParser.ipDst(pkt)
            val srcPort  = PacketParser.udpSrc(pkt, ipHdrLen)
            val dstPort  = PacketParser.udpDst(pkt, ipHdrLen)
            val payload  = PacketParser.udpPayload(pkt, ipHdrLen)

            val sock = DatagramSocket()
            protect(sock)
            val dst = InetAddress.getByAddress(dstAddr)
            sock.soTimeout = 5_000
            sock.send(DatagramPacket(payload, payload.size, dst, dstPort))

            val respBuf = ByteArray(4_096)
            val resp    = DatagramPacket(respBuf, respBuf.size)
            sock.receive(resp)
            sock.close()

            // Build a UDP response packet with src/dst swapped (server → client).
            val respPkt = PacketParser.buildUdpPacket(
                srcAddr = dstAddr, dstAddr = srcAddr,
                srcPort = dstPort, dstPort = srcPort,
                payload = resp.data.copyOf(resp.length)
            )
            writeMutex.withLock { tunOut?.write(respPkt) }
        } catch (_: Exception) { /* timeout or unreachable — client will retry */ }
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private fun buildNotification(): Notification {
        val stopPi = PendingIntent.getService(
            this, 0,
            Intent(this, StreamCaptureVpnService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val openPi = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.notif_vpn_monitoring))
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(openPi)
            .setOngoing(true)
            .addAction(
                android.R.drawable.ic_delete,
                getString(R.string.stop_monitoring),
                stopPi
            )
            .build()
    }

    private fun createNotificationChannel() {
        getSystemService(NotificationManager::class.java)
            ?.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.app_name),
                    NotificationManager.IMPORTANCE_LOW
                ).apply { description = getString(R.string.notif_channel_desc) }
            )
    }

    private fun broadcastState(running: Boolean) {
        sendBroadcast(Intent(ACTION_VPN_STATE).apply {
            putExtra(EXTRA_VPN_RUNNING, running)
            `package` = packageName
        })
    }
}
