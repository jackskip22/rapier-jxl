package app.rapier.jxlexample

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.View
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

/** Native controls; the asset WebView is never attached to a visible view. */
@Suppress("DEPRECATION")
class MainActivity : Activity() {
    private data class Input(val id: String, val mode: BridgeProtocol.Mode, val mime: String,
        val name: String, val bytes: ByteArray, val sha256: ByteArray)
    private data class Output(val file: File, val name: String, val description: String)

    private val io = Executors.newSingleThreadExecutor()
    private val protocol = BridgeProtocol()
    private var webView: WebView? = null
    private var port: WebMessagePortCompat? = null
    private var prepared: Input? = null
    private var output: Output? = null
    private var pendingSave: Output? = null
    private var savedUri: Uri? = null
    private var savedName = "image.jxl"
    private var picking: BridgeProtocol.Mode? = null
    private var busy = false
    private var disposed = false
    private var bridgeFailed = false
    private var generation = 0L
    private var activeName = "image.jxl"
    private var inputSize = 0
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var pickButton: Button
    private lateinit var jpegButton: Button
    private lateinit var videoButton: Button
    private lateinit var saveButton: Button
    private lateinit var shareButton: Button

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        createControls()
        restoreOutput(state)
        configureEncoder()
        if (state == null) receiveShared(intent)
    }

    private fun createControls() {
        val padding = (20 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
            setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(padding + insets.systemWindowInsetLeft,
                    padding + insets.systemWindowInsetTop, padding + insets.systemWindowInsetRight,
                    padding + insets.systemWindowInsetBottom)
                insets
            }
        }
        column.addView(TextView(this).apply { text = "rapier-jxl"; textSize = 24f })
        column.addView(TextView(this).apply { text = "Convert a photo or a video. Keep it on this device." })
        fun button(label: String, action: () -> Unit) = Button(this).also {
            it.text = label
            it.setOnClickListener { action() }
            column.addView(it)
        }
        pickButton = button("Choose photo") { choose(BridgeProtocol.Mode.ENCODE) }
        jpegButton = button("Restore a JPEG exactly") { choose(BridgeProtocol.Mode.JPEG) }
        videoButton = button("Choose video") { choose(BridgeProtocol.Mode.VIDEO) }
        saveButton = button("Save .jxl") { save() }
        shareButton = button("Share saved file") { share() }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).also {
            it.max = 1000
            column.addView(it)
        }
        status = TextView(this).apply {
            text = "Starting the encoder…"
            setTextIsSelectable(true)
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        column.addView(status)
        setContentView(ScrollView(this).apply { addView(column) })
        refreshControls()
    }

    private fun configureEncoder() {
        try {
            val required = arrayOf(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER,
                WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL, WebViewFeature.POST_WEB_MESSAGE,
                WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE,
                WebViewFeature.WEB_MESSAGE_PORT_SET_MESSAGE_CALLBACK,
                WebViewFeature.WEB_MESSAGE_CALLBACK_ON_MESSAGE, WebViewFeature.WEB_MESSAGE_PORT_CLOSE)
            if (required.any { !WebViewFeature.isFeatureSupported(it) }) {
                failBridge("JXL_WEBVIEW_BINARY_UNAVAILABLE", "This example needs WebView 116 or newer with binary web messages")
                return
            }
            val json = JSONObject(assets.open("headers.json").bufferedReader().use { it.readText() })
            val headers = json.keys().asSequence().associateWith { json.getString(it) }
            val loader = WebViewAssetLoader.Builder()
                .setHttpAllowed(false)
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
                .build()
            val encoder = WebView(this)
            webView = encoder
            encoder.settings.apply {
                javaScriptEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                blockNetworkLoads = true
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                cacheMode = WebSettings.LOAD_NO_CACHE
                safeBrowsingEnabled = false
                setGeolocationEnabled(false)
                mediaPlaybackRequiresUserGesture = false   // the page plays a video, muted and unseen, to read its frames
            }
            CookieManager.getInstance().apply {
                setAcceptCookie(false)
                setAcceptThirdPartyCookies(encoder, false)
            }
            encoder.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                    val uri = request.url
                    val local = uri.scheme == "https" && uri.host == HOST && uri.port == -1 &&
                        uri.userInfo == null && uri.path?.startsWith("/assets/") == true &&
                        request.method == "GET" && (!request.isForMainFrame || uri.toString() == PAGE)
                    val response = if (local) loader.shouldInterceptRequest(uri) else null
                    if (response == null) return WebResourceResponse("text/plain", "UTF-8", 403,
                        "Local asset only", headers, "JXL_ASSET_REFUSED".byteInputStream())
                    if (uri.path?.endsWith(".mjs") == true || uri.path?.endsWith(".js") == true) {
                        response.mimeType = "application/javascript"
                    }
                    response.responseHeaders = headers
                    return response
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

                override fun onPageFinished(view: WebView, url: String?) {
                    if (disposed || bridgeFailed || url != PAGE || port != null) return
                    try {
                        val pair = WebViewCompat.createWebMessageChannel(view)
                        port = pair[0]
                        pair[0].setWebMessageCallback(object : WebMessagePortCompat.WebMessageCallbackCompat() {
                            override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat?) {
                                if (disposed || this@MainActivity.port !== pair[0]) return
                                val frame = when (message?.type) {
                                    WebMessageCompat.TYPE_ARRAY_BUFFER -> BridgeProtocol.Frame.Binary(message.arrayBuffer)
                                    WebMessageCompat.TYPE_STRING -> decodeControl(message.data)
                                    else -> BridgeProtocol.Frame.Malformed("Missing message payload")
                                }
                                receive(protocol.receive(frame))
                            }
                        })
                        WebViewCompat.postWebMessage(view, WebMessageCompat("connect", arrayOf(pair[1])), Uri.parse(ORIGIN))
                    } catch (error: Exception) {
                        failBridge("JXL_BRIDGE_CONNECT", error.message ?: "Could not connect the encoder")
                    }
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    runOnUiThread { if (!disposed) failBridge("JXL_ASSET_LOAD", error.description.toString()) }
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                    runOnUiThread { if (!disposed) failBridge("JXL_ASSET_LOAD", "Could not load ${request.url.path}") }
                }

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    failBridge("JXL_WEBVIEW_RENDERER", "The encoder process stopped. Reopen the app to try again.")
                    webView = null
                    view.destroy()
                    return true
                }
            }
            encoder.loadUrl(PAGE)
        } catch (error: Exception) {
            failBridge("JXL_WEBVIEW_START", error.message ?: "Could not start the encoder")
        }
    }

    private fun decodeControl(text: String?): BridgeProtocol.Frame = try {
        val json = JSONObject(text ?: throw IllegalArgumentException("Missing message text"))
        fun string(key: String): String = json.get(key) as? String
            ?: throw IllegalArgumentException("Invalid $key")
        fun number(key: String): Double = (json.get(key) as? Number)?.toDouble()
            ?: throw IllegalArgumentException("Invalid $key")
        fun length(): Int {
            val value = number("byteLength")
            require(value.isFinite() && value > 0 && value <= Int.MAX_VALUE && value == value.toInt().toDouble()) {
                "Invalid byte length"
            }
            return value.toInt()
        }
        when (string("type")) {
            "ready" -> BridgeProtocol.Frame.Ready
            "progress" -> BridgeProtocol.Frame.Progress(string("id"), string("stage"), number("progress"))
            "result" -> BridgeProtocol.Frame.Result(string("id"), length())
            "restored" -> BridgeProtocol.Frame.Restored(string("id"), length())
            "error" -> BridgeProtocol.Frame.Error(if (json.isNull("id")) "" else string("id"),
                string("code"), string("message"))
            else -> BridgeProtocol.Frame.Malformed("Unknown message type")
        }
    } catch (error: Exception) {
        BridgeProtocol.Frame.Malformed(error.message ?: "Invalid message")
    }

    private fun receive(event: BridgeProtocol.Event) {
        when (event) {
            BridgeProtocol.Event.Ready -> {
                if (!busy && output == null) status.text = "Choose a photo or share one from another app."
                dispatchPrepared()
            }
            BridgeProtocol.Event.None -> Unit
            is BridgeProtocol.Event.Progress -> {
                status.text = event.stage
                progress.progress = (event.progress * 1000).toInt()
            }
            is BridgeProtocol.Event.Verify -> {
                status.text = "Comparing JPEG SHA-256…"
                val token = generation
                io.execute {
                    val digest = BridgeProtocol.sha256(event.restored)
                    runOnUiThread { if (current(token)) receive(protocol.verified(event.id, digest)) }
                }
            }
            is BridgeProtocol.Event.Complete -> {
                val token = generation
                val name = activeName
                val description = "$inputSize input bytes → ${event.jxl.size} JXL bytes" +
                    (event.restoredSha256?.let { "\nOriginal and restored JPEG SHA-256 match:\n$it" } ?: "")
                io.execute {
                    var file: File? = null
                    try {
                        file = File.createTempFile("jxl-result-", ".jxl", cacheDir)
                        FileOutputStream(file).use { it.write(event.jxl); it.fd.sync() }
                        val saved = Output(file, name, description)
                        runOnUiThread {
                            if (current(token)) {
                                val old = output
                                output = saved
                                savedUri = null
                                busy = false
                                progress.progress = 1000
                                status.text = description
                                refreshControls()
                                io.execute { old?.file?.delete() }
                            } else saved.file.delete()
                        }
                    } catch (error: Exception) {
                        file?.delete()
                        runOnUiThread { if (current(token)) failRequest("JXL_OUTPUT_CACHE", error.message ?: "Could not keep the result") }
                    }
                }
            }
            is BridgeProtocol.Event.Failed -> {
                if (event.fatal) failBridge(event.code, event.message) else failRequest(event.code, event.message)
            }
        }
        refreshControls()
    }

    private fun choose(mode: BridgeProtocol.Mode) {
        if (busy || !protocol.ready) return
        picking = mode
        busy = true
        refreshControls()
        try {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = when (mode) { BridgeProtocol.Mode.JPEG -> "image/jpeg"; BridgeProtocol.Mode.VIDEO -> "video/*"; else -> "image/*" }
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }, PICK)
        } catch (error: Exception) {
            picking = null
            failRequest("JXL_PICKER_UNAVAILABLE", error.message ?: "Could not open the photo picker")
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        receiveShared(intent)
    }

    private fun receiveShared(intent: Intent) {
        if (intent.action != Intent.ACTION_SEND) return
        if (busy) { showError("JXL_BUSY", "Finish the current action before sharing another image"); return }
        try {
            val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            val video = intent.type?.startsWith("video/") == true
            require(uri != null && (video || intent.type?.startsWith("image/") == true)) { "Share one image or video file" }
            readInput(uri, if (video) BridgeProtocol.Mode.VIDEO else BridgeProtocol.Mode.ENCODE)
        } catch (error: Exception) {
            failRequest("JXL_INPUT_URI", error.message ?: "Could not read the shared image")
        }
    }

    private fun readInput(uri: Uri, mode: BridgeProtocol.Mode) {
        if (bridgeFailed) { busy = false; refreshControls(); return }
        if (uri.scheme != "content") {
            failRequest("JXL_INPUT_URI", "Choose an image through the system picker")
            return
        }
        busy = true
        progress.progress = 0
        status.text = "Reading image…"
        val token = ++generation
        refreshControls()
        io.execute {
            try {
                val mime = contentResolver.getType(uri)
                    ?: throw IllegalArgumentException("The selected file has no image type")
                require(mime.startsWith(if (mode == BridgeProtocol.Mode.VIDEO) "video/" else "image/")) {
                    if (mode == BridgeProtocol.Mode.VIDEO) "The selected file is not a video" else "The selected file is not an image"
                }
                require(mode != BridgeProtocol.Mode.JPEG || mime == "image/jpeg") { "Choose a JPEG to restore exactly" }
                val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                    if (it.moveToFirst()) it.getString(0) else null
                } ?: "image"
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: throw IllegalArgumentException("Could not open the image")
                require(bytes.isNotEmpty()) { "The selected file is empty" }
                val input = Input(UUID.randomUUID().toString(), mode, mime, name, bytes, BridgeProtocol.sha256(bytes))
                runOnUiThread {
                    if (current(token)) {
                        prepared = input
                        dispatchPrepared()
                    }
                }
            } catch (error: Exception) {
                runOnUiThread { if (current(token)) failRequest("JXL_INPUT_READ", error.message ?: "Could not read the image") }
            }
        }
    }

    private fun dispatchPrepared() {
        val input = prepared ?: return
        if (!protocol.ready) return
        val channel = port ?: return
        prepared = null
        val filename = input.name.substringAfterLast('/').substringAfterLast('\\')
        activeName = filename.substringBeforeLast('.', filename).ifBlank { "image" } + ".jxl"
        inputSize = input.bytes.size
        try {
            protocol.begin(input.id, input.mode, input.sha256)
            channel.postMessage(WebMessageCompat(JSONObject().put("type", input.mode.wireName)
                .put("id", input.id).put("mime", input.mime).toString()))
            channel.postMessage(WebMessageCompat(input.bytes))
            status.text = "Encoding…"
        } catch (error: Exception) {
            failBridge("JXL_BRIDGE_SEND", error.message ?: "Could not send the image to the encoder")
        }
    }

    private fun save() {
        val result = output ?: return
        if (busy) return
        pendingSave = result
        busy = true
        refreshControls()
        try {
            startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "image/jxl"
                putExtra(Intent.EXTRA_TITLE, result.name)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }, SAVE)
        } catch (error: Exception) {
            pendingSave = null
            failRequest("JXL_PICKER_UNAVAILABLE", error.message ?: "Could not open the save picker")
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PICK) {
            val mode = picking
            picking = null
            if (resultCode != RESULT_OK) { canceled(); return }
            val uri = data?.data
            if (mode == null || uri == null) { failRequest("JXL_PICKER_RESULT", "The picker returned no image"); return }
            readInput(uri, mode)
        } else if (requestCode == SAVE) {
            val result = pendingSave
            pendingSave = null
            if (resultCode != RESULT_OK) { canceled(); return }
            val uri = data?.data
            if (result == null || uri?.scheme != "content") {
                failRequest("JXL_PICKER_RESULT", "The picker returned no save location"); return
            }
            val flags = data?.flags ?: 0
            if (flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION != 0) {
                try {
                    contentResolver.takePersistableUriPermission(uri, flags and
                        (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
                } catch (error: SecurityException) {
                    failRequest("JXL_OUTPUT_GRANT", error.message ?: "Could not retain access to the saved file")
                    return
                }
            }
            status.text = "Saving…"
            val token = ++generation
            io.execute {
                try {
                    contentResolver.openOutputStream(uri, "w")?.use { target ->
                        result.file.inputStream().use { source -> source.copyTo(target) }
                    } ?: throw IllegalArgumentException("Could not open the save location")
                    runOnUiThread {
                        if (current(token)) {
                            savedUri = uri
                            savedName = result.name
                            busy = false
                            status.text = "Saved ${result.name}\n${result.description}"
                            refreshControls()
                        }
                    }
                } catch (error: Exception) {
                    runOnUiThread { if (current(token)) failRequest("JXL_OUTPUT_WRITE", error.message ?: "Could not save the file") }
                }
            }
        }
    }

    private fun share() {
        val uri = savedUri ?: return
        if (busy) return
        try {
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                type = "image/jxl"
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri(savedName, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }, "Share JPEG XL"))
        } catch (error: Exception) {
            showError("JXL_SHARE_UNAVAILABLE", error.message ?: "Could not share the saved file")
        }
    }

    private fun canceled() {
        busy = false
        status.text = output?.description ?: "Canceled. Choose a photo to try again."
        refreshControls()
    }

    private fun failRequest(code: String, message: String) {
        generation++
        prepared = null
        busy = false
        showError(code, message)
        refreshControls()
    }

    private fun failBridge(code: String, message: String) {
        bridgeFailed = true
        protocol.reset()
        try { port?.close() } catch (_: Exception) { /* The renderer may already be gone. */ }
        port = null
        failRequest(code, message)
    }

    private fun showError(code: String, message: String) { status.text = "$code: $message" }
    private fun current(token: Long) = !disposed && token == generation
    private fun refreshControls() {
        pickButton.isEnabled = !busy && protocol.ready
        jpegButton.isEnabled = !busy && protocol.ready
        videoButton.isEnabled = !busy && protocol.ready
        saveButton.isEnabled = !busy && output != null
        shareButton.isEnabled = !busy && savedUri != null
    }

    override fun onSaveInstanceState(state: Bundle) {
        super.onSaveInstanceState(state)
        output?.let {
            state.putString("outputFile", it.file.name)
            state.putString("outputName", it.name)
            state.putString("outputDescription", it.description)
        }
        state.putString("savedUri", savedUri?.toString())
        state.putString("savedName", savedName)
        state.putString("picking", picking?.name)
        state.putBoolean("saving", pendingSave != null)
        state.putBoolean("busy", busy)
    }

    private fun restoreOutput(state: Bundle?) {
        if (state == null) return
        val filename = state.getString("outputFile")
        if (filename != null && filename == File(filename).name) {
            val file = File(cacheDir, filename)
            if (file.isFile) output = Output(file, state.getString("outputName") ?: "image.jxl",
                state.getString("outputDescription") ?: "JPEG XL ready to save")
        }
        savedUri = state.getString("savedUri")?.let(Uri::parse)?.takeIf { it.scheme == "content" }
        savedName = state.getString("savedName") ?: "image.jxl"
        picking = state.getString("picking")?.let { value -> BridgeProtocol.Mode.entries.firstOrNull { it.name == value } }
        pendingSave = if (state.getBoolean("saving")) output else null
        busy = picking != null || pendingSave != null
        status.text = if (state.getBoolean("busy") && !busy) {
            "JXL_INTERRUPTED: The last action was interrupted. Choose the image again."
        } else output?.description ?: "Starting the encoder…"
        refreshControls()
    }

    override fun onDestroy() {
        disposed = true
        generation++
        prepared = null
        protocol.reset()
        try { port?.close() } catch (_: Exception) { /* The renderer may already be gone. */ }
        port = null
        webView?.destroy()
        webView = null
        io.shutdownNow()
        super.onDestroy()
    }

    companion object {
        private const val HOST = "appassets.androidplatform.net"
        private const val ORIGIN = "https://$HOST"
        private const val PAGE = "$ORIGIN/assets/encoder.html"
        private const val PICK = 1
        private const val SAVE = 2
    }
}
