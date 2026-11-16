package app.rapier.jxlexample

/** These checks need only Kotlin and the JDK; no Android classes or emulator. */
internal fun runBridgeProtocolChecks(): Int {
    val source = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0, 1, 0xff.toByte(), 0xd9.toByte())
    val jxl = byteArrayOf(0xff.toByte(), 0x0a, 1, 2, 3)
    val originalHash = BridgeProtocol.sha256(source)
    var checks = 0
    fun scenario(body: () -> Unit) { body(); checks++ }
    fun session(mode: BridgeProtocol.Mode = BridgeProtocol.Mode.ENCODE): BridgeProtocol {
        val protocol = BridgeProtocol()
        check(protocol.receive(BridgeProtocol.Frame.Ready) == BridgeProtocol.Event.Ready)
        protocol.begin("current", mode, originalHash)
        return protocol
    }
    fun failed(event: BridgeProtocol.Event, code: String = "JXL_BRIDGE_PROTOCOL") {
        check(event is BridgeProtocol.Event.Failed && event.code == code) { "Expected $code, received $event" }
    }
    fun sendJxl(protocol: BridgeProtocol): BridgeProtocol.Event {
        check(protocol.receive(BridgeProtocol.Frame.Result("current", jxl.size)) == BridgeProtocol.Event.None)
        return protocol.receive(BridgeProtocol.Frame.Binary(jxl))
    }
    fun sendRestored(protocol: BridgeProtocol, restored: ByteArray = source): BridgeProtocol.Event {
        check(protocol.receive(BridgeProtocol.Frame.Restored("current", restored.size)) == BridgeProtocol.Event.None)
        return protocol.receive(BridgeProtocol.Frame.Binary(restored))
    }

    scenario {
        val protocol = session()
        val result = sendJxl(protocol)
        check(result is BridgeProtocol.Event.Complete && result.jxl.contentEquals(jxl) && result.restoredSha256 == null)
        failed(protocol.receive(BridgeProtocol.Frame.Binary(byteArrayOf(9))))
    }
    scenario {
        val protocol = session(BridgeProtocol.Mode.VIDEO)
        check(protocol.receive(BridgeProtocol.Frame.Progress("current", "video", 0.5)) is BridgeProtocol.Event.Progress)
        val result = sendJxl(protocol)
        check(result is BridgeProtocol.Event.Complete && result.jxl.contentEquals(jxl) && result.restoredSha256 == null)
        failed(protocol.receive(BridgeProtocol.Frame.Restored("current", jxl.size)))
    }
    scenario {
        val protocol = session(BridgeProtocol.Mode.JPEG)
        check(sendJxl(protocol) == BridgeProtocol.Event.None)
        val verify = sendRestored(protocol)
        check(verify is BridgeProtocol.Event.Verify && verify.restored.contentEquals(source))
        val result = protocol.verified("current", BridgeProtocol.sha256(verify.restored))
        check(result is BridgeProtocol.Event.Complete && result.jxl.contentEquals(jxl))
        check(result.restoredSha256 == BridgeProtocol.hex(originalHash))
    }
    scenario {
        val protocol = session(BridgeProtocol.Mode.JPEG)
        sendJxl(protocol)
        val corrupted = source.copyOf().apply { this[2] = 7 }
        val verify = sendRestored(protocol, corrupted) as BridgeProtocol.Event.Verify
        failed(protocol.verified("current", BridgeProtocol.sha256(verify.restored)), "JXL_JPEG_RESTORE_MISMATCH")
    }
    scenario {
        val protocol = session()
        failed(protocol.receive(BridgeProtocol.Frame.Result("old", jxl.size)))
        check(protocol.receive(BridgeProtocol.Frame.Binary(jxl)) == BridgeProtocol.Event.None)
        check(!protocol.ready)
    }
    scenario {
        val protocol = session()
        failed(protocol.receive(BridgeProtocol.Frame.Binary(jxl)))
    }
    scenario {
        val protocol = session()
        protocol.receive(BridgeProtocol.Frame.Result("current", jxl.size))
        failed(protocol.receive(BridgeProtocol.Frame.Binary(jxl.copyOf(jxl.size - 1))))
    }
    scenario {
        val protocol = session()
        protocol.receive(BridgeProtocol.Frame.Result("current", jxl.size))
        failed(protocol.receive(BridgeProtocol.Frame.Result("current", jxl.size)))
    }
    scenario {
        val protocol = session()
        failed(protocol.receive(BridgeProtocol.Frame.Result("current", -1)))
    }
    scenario {
        val protocol = session()
        failed(protocol.receive(BridgeProtocol.Frame.Restored("current", source.size)))
    }
    scenario {
        val protocol = session(BridgeProtocol.Mode.JPEG)
        failed(protocol.receive(BridgeProtocol.Frame.Restored("current", source.size)))
    }
    scenario {
        val protocol = session()
        val event = protocol.receive(BridgeProtocol.Frame.Error("current", "JXL_INVALID_INPUT", "Invalid image"))
        failed(event, "JXL_INVALID_INPUT")
        check(event is BridgeProtocol.Event.Failed && !event.fatal && protocol.ready)
        protocol.begin("next", BridgeProtocol.Mode.ENCODE, originalHash)
    }
    scenario {
        val protocol = session()
        failed(protocol.receive(BridgeProtocol.Frame.Error("current", "ERROR", "Invalid error code")))
        check(!protocol.ready)
    }
    scenario {
        val protocol = session()
        val progress = protocol.receive(BridgeProtocol.Frame.Progress("current", "Encoding", .5))
        check(progress is BridgeProtocol.Event.Progress && progress.progress == .5)
        failed(protocol.receive(BridgeProtocol.Frame.Progress("current", "Encoding", Double.NaN)))
    }
    scenario {
        val protocol = session()
        protocol.receive(BridgeProtocol.Frame.Result("current", jxl.size))
        failed(protocol.receive(BridgeProtocol.Frame.Progress("current", "Encoding", .5)))
    }
    scenario {
        val protocol = session()
        failed(protocol.receive(BridgeProtocol.Frame.Malformed("Invalid JSON")))
        check(protocol.receive(BridgeProtocol.Frame.Binary(jxl)) == BridgeProtocol.Event.None)
    }
    scenario {
        val protocol = session(BridgeProtocol.Mode.JPEG)
        sendJxl(protocol)
        sendRestored(protocol)
        failed(protocol.verified("old", originalHash))
    }
    scenario {
        val protocol = BridgeProtocol()
        val result = protocol.receive(BridgeProtocol.Frame.Error("", "JXL_WORKER_START", "Could not load module"))
        check(result is BridgeProtocol.Event.Failed && result.fatal && !protocol.ready)
    }
    scenario {
        val protocol = session()
        failed(protocol.receive(BridgeProtocol.Frame.Ready))
        check(!protocol.ready)
    }
    scenario {
        val protocol = session()
        val result = protocol.receive(BridgeProtocol.Frame.Error("current", "JXL_WORKER", "Worker process stopped"))
        check(result is BridgeProtocol.Event.Failed && result.code == "JXL_WORKER" && result.fatal)
        check(!protocol.ready)
        check(protocol.receive(BridgeProtocol.Frame.Binary(jxl)) == BridgeProtocol.Event.None)
    }
    return checks
}

fun main() {
    println("PASS: ${runBridgeProtocolChecks()} Kotlin bridge and JPEG SHA-256 checks")
}
