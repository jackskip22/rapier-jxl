import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

/// Serves the package's own files to the hidden page and carries bytes both ways as HTTP bodies, never base64: the page
/// fetches `in/<id>` and POSTs each result to `out/<id>/<kind>` and each message to `msg`. It listens on the loopback
/// address only, under a random path no other app can guess, and answers only requests whose Host is that address.
class Bridge {
  Bridge({required this.read, required this.headers, required this.onMessage});

  /// A file of the web bundle by relative path, or null.
  final Future<Uint8List?> Function(String path) read;
  final Map<String, String> headers;
  final void Function(Map<String, dynamic> message) onMessage;

  final Map<String, Uint8List> inputs = {};
  final Map<String, Uint8List> outputs = {};

  /// Files served beside the bundle's, by path. Tests add the package's decoder here; an app adds nothing.
  final Map<String, Uint8List> served = {};

  final String _token = _randomToken();
  late final HttpServer _server;

  Uri get origin => Uri(scheme: 'http', host: '127.0.0.1', port: _server.port, path: '/$_token/');

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server.listen(_handle);
  }

  Future<void> stop() => _server.close(force: true);

  Future<void> _handle(HttpRequest request) async {
    try {
      final parts = request.uri.pathSegments.where((s) => s.isNotEmpty).toList();
      final host = request.headers.host;
      if (host != '127.0.0.1' || request.headers.port != _server.port || parts.isEmpty || parts.first != _token || parts.any((s) => s == '..' || s == '.' || s.contains('\\'))) {
        return await _finish(request, 404, 'text/plain', Uint8List(0));
      }
      final rest = parts.sublist(1);
      if (request.method == 'GET' && rest.length == 2 && rest[0] == 'in') {
        final data = inputs[rest[1]];
        if (data == null) return await _finish(request, 404, 'text/plain', Uint8List(0));
        return await _finish(request, 200, 'application/octet-stream', data);
      }
      if (request.method == 'POST' && rest.length == 3 && rest[0] == 'out') {
        outputs['${rest[1]}/${rest[2]}'] = await _body(request);
        return await _finish(request, 204, 'text/plain', Uint8List(0));
      }
      if (request.method == 'POST' && rest.length == 1 && rest[0] == 'msg') {
        final message = jsonDecode(utf8.decode(await _body(request)));
        if (message is Map<String, dynamic>) onMessage(message);
        return await _finish(request, 204, 'text/plain', Uint8List(0));
      }
      final name = rest.isEmpty ? 'encoder.html' : rest.join('/');
      final data = request.method == 'GET' && name != 'headers.json' ? (served[name] ?? await read(name)) : null;
      if (data == null) return await _finish(request, 404, 'text/plain', Uint8List(0));
      await _finish(request, 200, _mime(name), data);
    } catch (_) {
      try { await _finish(request, 400, 'text/plain', Uint8List(0)); } catch (_) {}
    }
  }

  Future<Uint8List> _body(HttpRequest request) async {
    final builder = BytesBuilder(copy: false);
    await for (final chunk in request) { builder.add(chunk); }
    return builder.takeBytes();
  }

  Future<void> _finish(HttpRequest request, int status, String type, Uint8List data) async {
    final response = request.response..statusCode = status;
    headers.forEach(response.headers.set);
    response.headers.set('Content-Type', type);
    response.contentLength = data.length;
    response.add(data);
    await response.close();
  }

  static String _mime(String name) {
    final dot = name.lastIndexOf('.');
    switch (dot < 0 ? '' : name.substring(dot + 1)) {
      case 'html': return 'text/html; charset=utf-8';
      case 'mjs':
      case 'js': return 'text/javascript; charset=utf-8';
      default: return 'text/plain; charset=utf-8';
    }
  }

  static String _randomToken() {
    final random = Random.secure();
    return List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  }
}
