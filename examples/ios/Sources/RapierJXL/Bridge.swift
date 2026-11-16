import Foundation
import WebKit

/// Serves the package's own files to the hidden page and carries image bytes both ways as HTTP bodies, never base64:
/// the worker fetches `/in/<id>` and POSTs each result to `/out/<id>/<kind>`. Nothing leaves the device.
@MainActor
final class Bridge: NSObject, WKURLSchemeHandler, WKScriptMessageHandler, WKNavigationDelegate {
    static let scheme = "rapier"
    static let origin = URL(string: "rapier://app")!

    var inputs: [String: Data] = [:]
    var outputs: [String: Data] = [:]
    var onMessage: (([String: Any]) -> Void)?
    var onNavigated: (() -> Void)?
    /// The page did not load, or its process stopped: it will never report ready or finish a call.
    var onFailed: ((JXLError) -> Void)?
    /// The first 64 requests the page made, with the time each was answered: where a slow first load went.
    var requests: [(at: Date, path: String, bytes: Int)] = []

    /// Files served beside the bundle's, by path. Tests add the package's decoder here; an app adds nothing.
    var served: [String: URL] = [:]

    private let web: URL
    private let headers: [String: String]

    init(web: URL) throws {
        self.web = web
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: web.appendingPathComponent("headers.json")))
        headers = (json as? [String: String]) ?? [:]
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let text = message.body as? String,
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return }
        onMessage?(object)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onNavigated?() }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        onFailed?(JXLError(code: "JXL_BRIDGE", message: "The page did not load: \(error.localizedDescription)"))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        onFailed?(JXLError(code: "JXL_BRIDGE", message: "The page did not load: \(error.localizedDescription)"))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        onFailed?(JXLError(code: "JXL_BRIDGE", message: "The page's process stopped; the next call starts a new page."))
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        let parts = url.path.split(separator: "/").map(String.init)
        if parts.count == 2, parts[0] == "in", task.request.httpMethod == "GET", let data = inputs[parts[1]] {
            return finish(task, url, 200, "application/octet-stream", data)
        }
        if parts.count == 3, parts[0] == "out", task.request.httpMethod == "POST" {
            guard let data = Self.body(of: task.request) else { return finish(task, url, 400, "text/plain", Data()) }
            outputs["\(parts[1])/\(parts[2])"] = data
            return finish(task, url, 204, "text/plain", Data())
        }
        let name = parts.isEmpty ? "encoder.html" : parts.joined(separator: "/")
        // A page that cannot be served fails its navigation, so the start is refused rather than left waiting.
        if name == "encoder.html", served[name] == nil, !FileManager.default.fileExists(atPath: web.appendingPathComponent(name).path) {
            return task.didFailWithError(URLError(.fileDoesNotExist))
        }
        guard task.request.httpMethod == "GET", !parts.contains(".."), !parts.contains("."), !name.contains("\\"), name != "headers.json",
              let data = try? Data(contentsOf: served[name] ?? web.appendingPathComponent(name)) else {
            return finish(task, url, 404, "text/plain", Data())
        }
        finish(task, url, 200, Self.mime(name), data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func finish(_ task: WKURLSchemeTask, _ url: URL, _ status: Int, _ type: String, _ data: Data) {
        if requests.count < 64 { requests.append((Date(), url.path, data.count)) }   // the first load only
        var fields = headers
        fields["Content-Type"] = type
        fields["Content-Length"] = String(data.count)
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields)!)
        task.didReceive(data)
        task.didFinish()
    }

    private static func mime(_ name: String) -> String {
        switch (name as NSString).pathExtension {
        case "html": return "text/html; charset=utf-8"
        case "mjs", "js": return "text/javascript; charset=utf-8"
        default: return "text/plain; charset=utf-8"
        }
    }

    /// WebKit gives a fetch body either as `httpBody` or as a stream.
    private static func body(of request: URLRequest) -> Data? {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1 << 16)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
