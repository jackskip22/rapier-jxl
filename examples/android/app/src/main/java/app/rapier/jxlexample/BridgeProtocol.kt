package app.rapier.jxlexample

import java.security.MessageDigest

/** Only a complete, correctly framed request can replace the caller's output. */
internal class BridgeProtocol {
    enum class Mode(val wireName: String) { ENCODE("encode"), JPEG("jpeg"), VIDEO("video") }

    sealed interface Frame {
        data object Ready : Frame
        data class Progress(val id: String, val stage: String, val progress: Double) : Frame
        data class Result(val id: String, val byteLength: Int) : Frame
        data class Restored(val id: String, val byteLength: Int) : Frame
        data class Error(val id: String, val code: String, val message: String) : Frame
        data class Binary(val bytes: ByteArray) : Frame
        data class Malformed(val message: String) : Frame
    }

    sealed interface Event {
        data object Ready : Event
        data object None : Event
        data class Progress(val stage: String, val progress: Double) : Event
        data class Verify(val id: String, val restored: ByteArray) : Event
        data class Complete(val id: String, val jxl: ByteArray, val restoredSha256: String?) : Event
        data class Failed(val code: String, val message: String, val fatal: Boolean) : Event
    }

    private enum class Phase { RESULT_HEADER, RESULT_BYTES, RESTORED_HEADER, RESTORED_BYTES, VERIFY }
    private data class Pending(
        val id: String,
        val mode: Mode,
        val originalSha256: ByteArray,
        var phase: Phase = Phase.RESULT_HEADER,
        var length: Int = 0,
        var jxl: ByteArray? = null,
    )

    var ready = false
        private set
    private var pending: Pending? = null

    fun begin(id: String, mode: Mode, originalSha256: ByteArray) {
        check(ready && pending == null) { "The encoder is not ready for a request" }
        require(id.isNotBlank() && originalSha256.size == 32)
        pending = Pending(id, mode, originalSha256.copyOf())
    }

    fun reset() {
        ready = false
        pending = null
    }

    fun receive(frame: Frame): Event {
        if (frame is Frame.Malformed) return broken(frame.message)
        if (frame == Frame.Ready) {
            if (ready || pending != null) return broken("Unexpected ready message")
            ready = true
            return Event.Ready
        }
        if (frame is Frame.Error && frame.id.isEmpty()) {
            reset()
            return Event.Failed(validCode(frame.code), frame.message.ifBlank { "Invalid error message" }, true)
        }
        val current = pending ?: return if (ready) {
            broken("Response arrived without an active request")
        } else Event.None

        val id = when (frame) {
            is Frame.Progress -> frame.id
            is Frame.Result -> frame.id
            is Frame.Restored -> frame.id
            is Frame.Error -> frame.id
            else -> current.id
        }
        if (id != current.id) return broken("Response belongs to another request")

        return when (frame) {
            is Frame.Progress -> {
                if (current.phase !in setOf(Phase.RESULT_HEADER, Phase.RESTORED_HEADER) ||
                    frame.stage.isBlank() || !frame.progress.isFinite() || frame.progress !in 0.0..1.0) {
                    broken("Invalid progress message")
                } else Event.Progress(frame.stage, frame.progress)
            }
            is Frame.Result -> header(current, frame.byteLength, Phase.RESULT_HEADER, Phase.RESULT_BYTES)
            is Frame.Restored -> {
                if (current.mode != Mode.JPEG) broken("Unexpected restored JPEG")
                else header(current, frame.byteLength, Phase.RESTORED_HEADER, Phase.RESTORED_BYTES)
            }
            is Frame.Binary -> {
                if (current.phase !in setOf(Phase.RESULT_BYTES, Phase.RESTORED_BYTES)) {
                    broken("Bytes arrived without their header")
                } else if (frame.bytes.size != current.length) {
                    broken("Result byte length does not match its header")
                } else if (current.phase == Phase.RESTORED_BYTES) {
                    current.phase = Phase.VERIFY
                    Event.Verify(current.id, frame.bytes)
                } else if (current.mode == Mode.JPEG) {
                    current.jxl = frame.bytes
                    current.phase = Phase.RESTORED_HEADER
                    Event.None
                } else {
                    pending = null
                    Event.Complete(current.id, frame.bytes, null)
                }
            }
            is Frame.Error -> {
                pending = null
                val code = validCode(frame.code)
                val fatal = code != frame.code || frame.message.isBlank() || code == "JXL_WORKER"
                if (fatal) ready = false
                Event.Failed(code, frame.message.ifBlank { "Invalid error message" }, fatal)
            }
            else -> broken("Unexpected message")
        }
    }

    /** The activity computes this digest off the UI thread. */
    fun verified(id: String, restoredSha256: ByteArray): Event {
        val current = pending ?: return Event.None
        if (current.id != id || current.phase != Phase.VERIFY) {
            return broken("Unexpected JPEG verification")
        }
        pending = null
        return if (MessageDigest.isEqual(current.originalSha256, restoredSha256)) {
            Event.Complete(current.id, checkNotNull(current.jxl), hex(restoredSha256))
        } else {
            Event.Failed("JXL_JPEG_RESTORE_MISMATCH", "Restored JPEG SHA-256 does not match the original", false)
        }
    }

    private fun header(current: Pending, length: Int, expected: Phase, next: Phase): Event {
        if (current.phase != expected || length <= 0) return broken("Invalid result header")
        current.phase = next
        current.length = length
        return Event.None
    }

    private fun broken(message: String): Event.Failed {
        reset()
        return Event.Failed("JXL_BRIDGE_PROTOCOL", message, true)
    }

    private fun validCode(code: String): String =
        if (code.matches(Regex("JXL_[A-Z0-9_]+"))) code else "JXL_BRIDGE_PROTOCOL"

    companion object {
        fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
        fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
