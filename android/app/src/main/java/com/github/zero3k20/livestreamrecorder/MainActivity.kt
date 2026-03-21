package com.github.zero3k20.livestreamrecorder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.EditText
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import com.github.zero3k20.livestreamrecorder.databinding.ActivityMainBinding

/**
 * Main screen: lets the user start/stop the VPN-based stream monitor and shows
 * every stream URL detected across all apps on the device.
 *
 * How it works:
 *   1. User taps "Start Monitoring".
 *   2. Android shows the standard VPN-permission dialog.
 *   3. On approval, [StreamCaptureVpnService] is started as a foreground service.
 *   4. The service intercepts all TCP/UDP traffic via a local TUN interface:
 *        - HTTP  → full stream URL extracted from GET request + Host header
 *        - HTTPS → SNI hostname extracted from TLS ClientHello
 *        - All traffic is forwarded transparently so every app keeps working.
 *   5. Detected URLs are broadcast to this Activity and added to the list.
 *   6. The user taps "↓ Record" to start a local download.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val viewModel: StreamViewModel by viewModels()
    private lateinit var streamAdapter: StreamAdapter

    // ── VPN permission ────────────────────────────────────────────────────────

    private val vpnPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            startVpnService()
        } else {
            Toast.makeText(this, R.string.vpn_permission_denied, Toast.LENGTH_LONG).show()
        }
    }

    // ── Broadcast receiver ────────────────────────────────────────────────────

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                StreamCaptureVpnService.ACTION_STREAM_DETECTED -> {
                    val url  = intent.getStringExtra(StreamCaptureVpnService.EXTRA_STREAM_URL)  ?: return
                    val type = intent.getStringExtra(StreamCaptureVpnService.EXTRA_STREAM_TYPE) ?: "direct"
                    viewModel.addStream(url, type)
                }
                StreamCaptureVpnService.ACTION_VPN_STATE -> {
                    val running = intent.getBooleanExtra(StreamCaptureVpnService.EXTRA_VPN_RUNNING, false)
                    viewModel.setVpnRunning(running)
                }
            }
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupRecyclerView()
        setupButtons()
        observeViewModel()
        registerBroadcastReceiver()
        registerBackHandler()
    }

    override fun onDestroy() {
        unregisterReceiver(receiver)
        super.onDestroy()
    }

    // ── UI setup ──────────────────────────────────────────────────────────────

    private fun setupRecyclerView() {
        streamAdapter = StreamAdapter(
            onRecord = { stream -> viewModel.startDownload(stream) },
            onStop   = { stream -> viewModel.stopDownload(stream.id) }
        )
        binding.recyclerStreams.apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter       = streamAdapter
        }
    }

    private fun setupButtons() {
        binding.btnToggleVpn.setOnClickListener {
            if (viewModel.vpnRunning.value == true) stopVpnService()
            else requestVpnPermission()
        }
        binding.btnClearStreams.setOnClickListener { viewModel.clearDetectedStreams() }
        binding.btnAddManual.setOnClickListener    { showManualUrlDialog() }
    }

    private fun observeViewModel() {
        viewModel.vpnRunning.observe(this) { running ->
            binding.btnToggleVpn.text = getString(
                if (running) R.string.stop_monitoring else R.string.start_monitoring
            )
            binding.tvVpnStatus.text = getString(
                if (running) R.string.vpn_status_active else R.string.vpn_status_idle
            )
            binding.tvVpnStatus.setTextColor(
                getColor(if (running) R.color.status_success else R.color.status_neutral)
            )
            binding.statusIndicator.setBackgroundColor(
                getColor(if (running) R.color.status_success else R.color.status_neutral)
            )
        }

        viewModel.detectedStreams.observe(this) { streams ->
            streamAdapter.updateStreams(streams)
            binding.tvNoStreams.visibility =
                if (streams.isEmpty()) View.VISIBLE else View.GONE
        }

        viewModel.downloadStates.observe(this) { states ->
            streamAdapter.updateDownloadStates(states)
        }
    }

    // ── VPN control ───────────────────────────────────────────────────────────

    private fun requestVpnPermission() {
        val intent = VpnService.prepare(this)
        if (intent == null) startVpnService()        // already granted
        else vpnPermissionLauncher.launch(intent)
    }

    private fun startVpnService() {
        ContextCompat.startForegroundService(
            this,
            Intent(this, StreamCaptureVpnService::class.java).apply {
                action = StreamCaptureVpnService.ACTION_START
            }
        )
    }

    private fun stopVpnService() {
        startService(
            Intent(this, StreamCaptureVpnService::class.java).apply {
                action = StreamCaptureVpnService.ACTION_STOP
            }
        )
    }

    // ── Manual URL dialog ─────────────────────────────────────────────────────

    private fun showManualUrlDialog() {
        val input = EditText(this).apply {
            hint      = "https://example.com/stream.m3u8"
            setSingleLine()
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.add_stream_url)
            .setView(input)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val url = input.text.toString().trim()
                if (url.isNotEmpty()) {
                    val type = when {
                        url.contains(".m3u8") -> "hls"
                        url.contains(".flv")  -> "flv"
                        url.contains(".mp4")  -> "mp4"
                        url.startsWith("ws")  -> "websocket"
                        else                  -> "direct"
                    }
                    viewModel.addStream(url, type)
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // ── Broadcast receiver ────────────────────────────────────────────────────

    private fun registerBroadcastReceiver() {
        val filter = IntentFilter().apply {
            addAction(StreamCaptureVpnService.ACTION_STREAM_DETECTED)
            addAction(StreamCaptureVpnService.ACTION_VPN_STATE)
        }
        // Broadcasts are only delivered within this package (explicit package set
        // in the sendBroadcast calls in StreamCaptureVpnService), so NOT_EXPORTED.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(receiver, filter)
        }
    }

    // ── Back press ────────────────────────────────────────────────────────────

    private fun registerBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        })
    }
}
