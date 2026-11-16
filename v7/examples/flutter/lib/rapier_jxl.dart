/// JPEG XL for Flutter with no native code: a hidden web view runs rapier-jxl from the app's assets.
library rapier_jxl;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'src/bridge.dart';

/// A refusal carries the package's own `JXL_` code, for example `JXL_JPEG_UNSUPPORTED`.
class JXLException implements Exception {
  const JXLException(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => '$code: $message';
}

/// Thrown by a call whose [JXLCancel] was canceled.
class JXLCanceledException implements Exception {
  const JXLCanceledException();
  @override
  String toString() => 'JXL_CANCELED: The call was canceled.';
}

/// Pass to a call and call [cancel] to stop it. A canceled call throws [JXLCanceledException]; the next call runs normally.
class JXLCancel {
  final List<void Function()> _listeners = [];
  bool _canceled = false;
  bool get isCanceled => _canceled;
  void cancel() {
    if (_canceled) return;
    _canceled = true;
    for (final listener in List.of(_listeners)) { listener(); }
  }
}

/// Where the bundle's files come from. The default reads the package's assets.
typedef AssetReader = Future<Uint8List?> Function(String path);

class JXLCodec {
  JXLCodec({AssetReader? readAsset})
      : _read = readAsset ?? ((path) async {
          try {
            return (await rootBundle.load('packages/rapier_jxl/assets/web/$path')).buffer.asUint8List();
          } catch (_) {
            return null;
          }
        });

  final AssetReader _read;
  Bridge? _bridge;
  HeadlessInAppWebView? _web;
  Completer<void>? _ready;
  _Active? _active;
  Future<void> _tail = Future.value();

  /// Called with a job's id when its worker has the input and starts. Tests wait on it before canceling.
  void Function(String id)? onStart;

  /// Input and result bytes still held for jobs that are over; zero between calls.
  int get heldBytes => (_bridge?.inputs.values.fold<int>(0, (n, b) => n + b.length) ?? 0) +
      (_bridge?.outputs.values.fold<int>(0, (n, b) => n + b.length) ?? 0);

  /// Adds a file the page may fetch, by path under the bundle. Tests add the package's decoder.
  void serve(String path, Uint8List bytes) => _bridge!.served[path] = bytes;

  /// Loads the hidden page and its worker now, so the first call does not wait for them. Optional.
  Future<void> warmUp() => _turn(() => _start());

  /// Lossy, [quality] 1 to 100 (SSIMULACRA 2 score) and [effort] 1 to 3.
  Future<Uint8List> encode(Uint8List image, {double quality = 80, int effort = 3, JXLCancel? cancel}) =>
      _run('encode', image, _mime(image), quality: quality, effort: effort, cancel: cancel);

  /// Every sample kept: the same pixels come back from any decoder.
  Future<Uint8List> encodeExact(Uint8List image, {int effort = 3, JXLCancel? cancel}) =>
      _run('encodeExact', image, _mime(image), effort: effort, cancel: cancel);

  /// A JPEG's own bytes in a smaller file; [restore] returns them unchanged.
  Future<Uint8List> recompress(Uint8List jpeg, {int effort = 3, JXLCancel? cancel}) =>
      _run('recompress', jpeg, 'image/jpeg', effort: effort, cancel: cancel);

  /// The JPEG a recompressed file was made from, byte for byte.
  Future<Uint8List> restore(Uint8List jxl, {JXLCancel? cancel}) => _run('restore', jxl, 'image/jxl', cancel: cancel);

  /// A video as an animated JPEG XL: every frame the web view plays, each with its own time. [type] is its MIME type,
  /// for example `video/mp4`. [effort] 1 to 9; [onProgress] gets 0 to 1. A clip longer than the device's memory holds is
  /// refused with its `JXL_` code.
  Future<Uint8List> animateVideo(Uint8List video, {required String type, double quality = 80, int effort = 3,
          void Function(double)? onProgress, JXLCancel? cancel}) =>
      _run('animate', video, type, quality: quality, effort: effort, progress: onProgress, cancel: cancel);

  /// An animated GIF as an animated JPEG XL, with its timing and loops. [effort] 1 to 9.
  Future<Uint8List> animateGif(Uint8List gif, {double quality = 80, int effort = 3,
          void Function(double)? onProgress, JXLCancel? cancel}) =>
      _run('animate', gif, 'image/gif', quality: quality, effort: effort, progress: onProgress, cancel: cancel);

  /// Stops the page and its server. A later call builds new ones.
  Future<void> dispose() async {
    final web = _web, bridge = _bridge;
    _web = null;
    _bridge = null;
    await web?.dispose();
    await bridge?.stop();
  }

  /// Runs [body] as an async function on the page, and returns its value. Tests only.
  Future<dynamic> callPage(String body, {Uint8List? input}) => _turn(() async {
        await _start();
        if (input != null) _bridge!.inputs['readback'] = input;
        final result = await _web!.webViewController!.callAsyncJavaScript(functionBody: body);
        _bridge?.inputs.remove('readback');
        if (result?.error != null) throw JXLException('JXL_PAGE', result!.error!);
        return result?.value;
      });

  // One job at a time.

  Future<T> _turn<T>(Future<T> Function() body) {
    final done = Completer<T>();
    final previous = _tail;
    _tail = done.future.then((_) {}, onError: (_) {});
    previous.then((_) async {
      try { done.complete(await body()); } catch (error, stack) { done.completeError(error, stack); }
    });
    return done.future;
  }

  Future<Uint8List> _run(String op, Uint8List input, String mime, {double quality = 80, int effort = 3,
          void Function(double)? progress, JXLCancel? cancel}) =>
      _turn(() async {
        if (cancel?.isCanceled ?? false) throw const JXLCanceledException();
        await _start();
        if (cancel?.isCanceled ?? false) throw const JXLCanceledException();
        final id = '${DateTime.now().microsecondsSinceEpoch}-${identityHashCode(input)}';
        final bridge = _bridge!;
        bridge.inputs[id] = input;
        final done = Completer<void>();
        _active = _Active(id, done, progress);
        void stop() => _web?.webViewController?.evaluateJavascript(source: 'rapier.cancel(${jsonEncode(id)})');
        cancel?._listeners.add(stop);
        try {
          final job = jsonEncode({'op': op, 'id': id, 'mime': mime, 'quality': quality, 'effort': effort});
          await _web!.webViewController!.evaluateJavascript(source: 'rapier.run($job)');
          await done.future;
          final output = bridge.outputs['$id/result'];
          if (output == null) throw const JXLException('JXL_BRIDGE', 'The worker finished without a result.');
          return output;
        } on JXLException catch (error) {
          if (error.code == 'JXL_CANCELED') throw const JXLCanceledException();
          rethrow;
        } finally {
          cancel?._listeners.remove(stop);
          if (_active?.id == id) _active = null;
          bridge.inputs.remove(id);
          bridge.outputs.remove('$id/result');
        }
      });

  // The hidden page.

  Future<void> _start() async {
    if (_ready != null) return _ready!.future;
    final ready = _ready = Completer<void>();
    try {
      final headers = (jsonDecode(utf8.decode((await _read('headers.json'))!)) as Map).cast<String, String>();
      final bridge = _bridge = Bridge(read: _read, headers: headers, onMessage: _receive);
      await bridge.start();
      final web = _web = HeadlessInAppWebView(
        initialUrlRequest: URLRequest(url: WebUri.uri(bridge.origin)),
        // The page plays a video, muted and unseen, to read its frames.
        initialSettings: InAppWebViewSettings(
            mediaPlaybackRequiresUserGesture: false, allowsInlineMediaPlayback: true, isInspectable: false),
      );
      await web.run();
    } catch (error) {
      _teardown(JXLException('JXL_BRIDGE', '$error'));
    }
    return ready.future;
  }

  void _receive(Map<String, dynamic> message) {
    final id = message['id'];
    switch (message['type']) {
      case 'ready':
        _ready?.complete();
      case 'started':
        if (id is String) onStart?.call(id);
      case 'progress':
        if (id == _active?.id && message['fraction'] is num) _active?.progress?.call((message['fraction'] as num).toDouble());
      case 'done':
        if (id == _active?.id) { _active!.done.complete(); _active = null; }
      case 'error':
        final error = JXLException(message['code'] as String? ?? 'JXL_MESSAGE', message['message'] as String? ?? '');
        if (id is String && id == _active?.id) {
          _active!.done.completeError(error);
          _active = null;
        } else {
          _teardown(error);
        }
    }
  }

  /// The page or its worker stopped: refuse what waits, and build a new page for the next call.
  void _teardown(JXLException error) {
    final ready = _ready, active = _active;
    _ready = null;
    _active = null;
    unawaited(dispose());
    if (ready != null && !ready.isCompleted) ready.completeError(error);
    if (active != null && !active.done.isCompleted) active.done.completeError(error);
  }

  static String _mime(Uint8List data) {
    bool starts(List<int> head, [int at = 0]) {
      if (data.length < at + head.length) return false;
      for (var i = 0; i < head.length; i++) { if (data[at + i] != head[i]) return false; }
      return true;
    }
    return starts([0x89, 0x50, 0x4E, 0x47]) ? 'image/png'
        : starts([0xFF, 0xD8]) ? 'image/jpeg'
        : starts('GIF8'.codeUnits) ? 'image/gif'
        : starts('RIFF'.codeUnits) && starts('WEBP'.codeUnits, 8) ? 'image/webp'
        : 'application/octet-stream';
  }
}

class _Active {
  _Active(this.id, this.done, this.progress);
  final String id;
  final Completer<void> done;
  final void Function(double)? progress;
}
