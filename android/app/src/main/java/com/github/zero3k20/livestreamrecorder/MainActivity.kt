package com.github.zero3k20.livestreamrecorder

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
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
import com.google.android.material.bottomsheet.BottomSheetBehavior

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val viewModel: StreamViewModel by viewModels()
    private lateinit var bottomSheetBehavior: BottomSheetBehavior<View>
    private lateinit var streamAdapter: StreamAdapter

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val allGranted = permissions.values.all { it }
        if (!allGranted) {
            Toast.makeText(this, getString(R.string.permission_required), Toast.LENGTH_LONG).show()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupWebView()
        setupNavBar()
        setupBottomSheet()
        observeViewModel()
        requestRequiredPermissions()
        registerBackHandler()

        // Default landing page — user can navigate anywhere from here
        binding.webView.loadUrl("https://www.youtube.com/live")
    }

    // ─── WebView setup ────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        binding.webView.settings.apply {
            javaScriptEnabled       = true
            domStorageEnabled       = true
            // Allow playing media without a user gesture so live streams start
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode    = true
            useWideViewPort         = true
            mixedContentMode        = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            // Identify as a real mobile Chrome so streaming sites serve proper URLs
            userAgentString =
                "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36"
        }

        // Register the bridge before any page loads
        binding.webView.addJavascriptInterface(LSRBridge(), "LSRBridge")

        binding.webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                binding.urlBar.setText(url)
                // Inject hooks as early as possible — equivalent to @run-at document-start
                injectStreamHooks(view)
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                // Re-inject after full page load to catch late-initialised players
                injectStreamHooks(view)
            }
        }

        binding.webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                binding.loadingBar.progress   = newProgress
                binding.loadingBar.visibility =
                    if (newProgress < 100) View.VISIBLE else View.GONE
            }

            override fun onReceivedTitle(view: WebView, title: String) {
                supportActionBar?.subtitle = title
            }
        }
    }

    private fun injectStreamHooks(webView: WebView) {
        try {
            val script = assets.open("stream_hooks.js").bufferedReader().use { it.readText() }
            webView.evaluateJavascript(script, null)
        } catch (e: Exception) {
            // Non-fatal — page will still load without stream detection
        }
    }

    // ─── Navigation bar ───────────────────────────────────────────────────────

    private fun setupNavBar() {
        binding.btnBack.setOnClickListener {
            if (binding.webView.canGoBack()) binding.webView.goBack()
        }
        binding.btnForward.setOnClickListener {
            if (binding.webView.canGoForward()) binding.webView.goForward()
        }
        binding.btnRefresh.setOnClickListener {
            binding.webView.reload()
        }
        binding.btnShowStreams.setOnClickListener {
            toggleBottomSheet()
        }

        binding.urlBar.setOnEditorActionListener { view, actionId, event ->
            val isGo = actionId == EditorInfo.IME_ACTION_GO ||
                (event?.keyCode == KeyEvent.KEYCODE_ENTER &&
                    event.action == KeyEvent.ACTION_DOWN)
            if (isGo) {
                navigateTo(view.text.toString().trim())
                true
            } else false
        }
    }

    private fun navigateTo(input: String) {
        val url = when {
            input.startsWith("http://") || input.startsWith("https://") -> input
            input.contains('.') && !input.contains(' ')                 -> "https://$input"
            else -> "https://www.google.com/search?q=${input.replace(' ', '+')}"
        }
        binding.webView.loadUrl(url)
    }

    // ─── Bottom sheet ─────────────────────────────────────────────────────────

    private fun setupBottomSheet() {
        @Suppress("UNCHECKED_CAST")
        bottomSheetBehavior = BottomSheetBehavior.from(binding.bottomSheet) as BottomSheetBehavior<View>
        bottomSheetBehavior.state      = BottomSheetBehavior.STATE_HIDDEN
        bottomSheetBehavior.isHideable = true

        streamAdapter = StreamAdapter(
            onRecord = { stream -> viewModel.startDownload(stream) },
            onStop   = { stream -> viewModel.stopDownload(stream.id) }
        )
        binding.recyclerStreams.apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter       = streamAdapter
        }

        binding.btnClearStreams.setOnClickListener { viewModel.clearDetectedStreams() }
        binding.btnAddManual.setOnClickListener    { showManualUrlDialog() }
    }

    private fun toggleBottomSheet() {
        bottomSheetBehavior.state =
            if (bottomSheetBehavior.state == BottomSheetBehavior.STATE_HIDDEN)
                BottomSheetBehavior.STATE_EXPANDED
            else
                BottomSheetBehavior.STATE_HIDDEN
    }

    // ─── ViewModel observation ────────────────────────────────────────────────

    private fun observeViewModel() {
        viewModel.detectedStreams.observe(this) { streams ->
            streamAdapter.updateStreams(streams)
            binding.tvNoStreams.visibility =
                if (streams.isEmpty()) View.VISIBLE else View.GONE
            // Show stream count on the toolbar button
            binding.btnShowStreams.text =
                if (streams.isEmpty()) "⏺" else "⏺ ${streams.size}"
        }

        viewModel.downloadStates.observe(this) { states ->
            streamAdapter.updateDownloadStates(states)
        }
    }

    // ─── Manual URL entry ─────────────────────────────────────────────────────

    private fun showManualUrlDialog() {
        val input = EditText(this).apply {
            hint    = "https://example.com/stream.m3u8"
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
                        url.contains(".webm") -> "webm"
                        url.startsWith("ws")  -> "websocket"
                        else                  -> "direct"
                    }
                    viewModel.addStream(url, type)
                    // Expand the bottom sheet so the user can see the new entry
                    bottomSheetBehavior.state = BottomSheetBehavior.STATE_EXPANDED
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // ─── Permissions ──────────────────────────────────────────────────────────

    private fun requestRequiredPermissions() {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (needed.isNotEmpty()) requestPermissionLauncher.launch(needed.toTypedArray())
    }

    // ─── Back-press handling ──────────────────────────────────────────────────

    private fun registerBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    bottomSheetBehavior.state != BottomSheetBehavior.STATE_HIDDEN ->
                        bottomSheetBehavior.state = BottomSheetBehavior.STATE_HIDDEN
                    binding.webView.canGoBack() -> binding.webView.goBack()
                    else -> {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })
    }

    override fun onDestroy() {
        super.onDestroy()
        binding.webView.destroy()
    }

    // ─── JavaScript bridge ────────────────────────────────────────────────────

    /**
     * Called from stream_hooks.js whenever a stream URL is detected.
     * JavascriptInterface callbacks run on a background thread, so WebView
     * properties are read on the main thread via runOnUiThread.
     */
    inner class LSRBridge {
        @JavascriptInterface
        fun onStreamDetected(url: String, type: String) {
            runOnUiThread {
                val pageUrl   = binding.webView.url   ?: ""
                val pageTitle = binding.webView.title ?: ""
                viewModel.addStream(url, type, pageUrl, pageTitle)
            }
        }
    }
}
