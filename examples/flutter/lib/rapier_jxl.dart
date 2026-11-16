/// JPEG XL for Flutter with no native code: a hidden web view runs rapier-jxl from the app's assets.
library rapier_jxl;

import 'dart:async';
import 'dart:convert';
import 'dart:io' show Directory, File, Platform;
import 'dart:math' show min;
import 'dart:typed_data';

import 'package:flutter/services.dart' show MethodChannel, PlatformException, rootBundle;
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

  /// Names each stage of starting the hidden page, so a hang names where it waited. Tests set it.
  static void Function(String stage)? trace;

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

  /// The JPEG a recompressed file was made from, exactly.
  Future<Uint8List> restore(Uint8List jxl, {JXLCancel? cancel}) => _run('restore', jxl, 'image/jxl', cancel: cancel);

  /// A video as an animated JPEG XL: every frame, each with its own time. On an iPhone the system reads the frames (a hidden
  /// web view does not play video) and sends them to the page in parts; elsewhere the web view plays the video. [type] is its
  /// MIME type, for example `video/mp4`. [effort] 1 to 9; [onProgress] gets 0 to 1. A clip longer than the device's memory
  /// holds is refused with its `JXL_` code.
  Future<Uint8List> animateVideo(Uint8List video, {required String type, double quality = 80, int effort = 3,
          void Function(double)? onProgress, JXLCancel? cancel}) =>
      Platform.isIOS
          ? _run('animate', Uint8List(0), 'video/frames', quality: quality, effort: effort, progress: onProgress, cancel: cancel,
              frames: (id, report) => _readFrames(id, video, type, report, cancel))
          : _run('animate', video, type, quality: quality, effort: effort, progress: onProgress, cancel: cancel);

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
          void Function(double)? progress, JXLCancel? cancel, Future<double> Function(String id, void Function(double)? report)? frames}) =>
      _turn(() async {
        if (cancel?.isCanceled ?? false) throw const JXLCanceledException();
        await _start();
        if (cancel?.isCanceled ?? false) throw const JXLCanceledException();
        final id = '${DateTime.now().microsecondsSinceEpoch}-${identityHashCode(input)}';
        final bridge = _bridge!;
        if (frames == null) bridge.inputs[id] = input;
        final done = Completer<void>();
        // A video read by the system is half the work: the frames, then the encode.
        _active = _Active(id, done, frames == null || progress == null ? progress : (fraction) => progress(0.5 + fraction / 2));
        void stop() => _web?.webViewController?.evaluateJavascript(source: 'rapier.cancel(${jsonEncode(id)})');
        try {
          // The frames reach the page in parts; a cancel acts between parts.
          final end = frames == null ? null : await frames(id, progress);
          if (cancel?.isCanceled ?? false) throw const JXLCanceledException();
          cancel?._listeners.add(stop);
          final job = jsonEncode({'op': op, 'id': id, 'mime': mime, 'quality': quality, 'effort': effort, if (end != null) 'end': end});
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

  static const _video = MethodChannel('app.rapier.jxl/video');
  static const _partBytes = 16 << 20;

  /// iPhone: the iOS plug-in reads the frames with AVFoundation, a part at a time, and each part goes to the page. Returns
  /// when the last frame ends, in seconds.
  Future<double> _readFrames(String id, Uint8List video, String type, void Function(double)? report, JXLCancel? cancel) async {
    final bridge = _bridge!, web = _web!.webViewController!;
    JXLException stopped() => const JXLException('JXL_BRIDGE', "The page's process stopped; the next call starts a new page.");
    final folder = await Directory.systemTemp.createTemp('rapier_jxl');
    var part = 0, frames = 0, held = 0;
    try {
      final file = File('${folder.path}/clip.${type == 'video/quicktime' ? 'mov' : type == 'video/x-m4v' ? 'm4v' : 'mp4'}');
      await file.writeAsBytes(video, flush: true);
      final clip = (await _video.invokeMapMethod<String, dynamic>('open', {'id': id, 'path': file.path}))!;
      final duration = (clip['duration'] as num).toDouble(), budget = (clip['memory'] as int) ~/ 8;
      while (true) {
        if (cancel?.isCanceled ?? false) throw const JXLCanceledException();
        final batch = await _video.invokeMapMethod<String, dynamic>('read', {'id': id, 'bytes': _partBytes});
        if (cancel?.isCanceled ?? false) throw const JXLCanceledException();
        if (!identical(_bridge, bridge)) throw stopped();
        if (batch == null) break;
        final data = batch['data'] as Uint8List, times = (batch['times'] as List).map((t) => (t as num).toDouble()).toList();
        final width = batch['width'] as int, height = batch['height'] as int;
        frames += times.length;
        held += data.length;
        // Held on the page until the encoder takes it: an eighth of the device's memory at most, as the browser path holds.
        if (held > budget) {
          throw JXLException('JXL_MEMORY', 'Video is too long for this device\'s memory at $width x $height ($frames frames read); shorten or shrink the clip.');
        }
        bridge.inputs['$id.$part'] = data;
        try {
          final result = await web.callAsyncJavaScript(functionBody: 'await rapier.frames(job); return true;',
              arguments: {'job': {'id': id, 'part': part, 'width': width, 'height': height, 'times': times}});
          if (result?.error != null) throw JXLException('JXL_BRIDGE', 'The page did not take the frames: ${result!.error}');
        } catch (error) {
          if (!identical(_bridge, bridge)) throw stopped();
          rethrow;
        } finally {
          bridge.inputs.remove('$id.$part');
        }
        part++;
        if (duration > 0 && duration.isFinite) report?.call(min(1.0, times.last / duration) / 2);
      }
      if (frames == 0) throw const JXLException('JXL_INPUT', 'Video has no frames.');
      return (await _video.invokeMethod<num>('end', {'id': id}))!.toDouble();
    } catch (error) {
      if (identical(_bridge, bridge)) web.evaluateJavascript(source: 'rapier.drop(${jsonEncode(id)})');
      if (error is PlatformException) throw JXLException(error.code, error.message ?? '');
      rethrow;
    } finally {
      try { await _video.invokeMethod('close', {'id': id}); } catch (_) {}
      try { await folder.delete(recursive: true); } catch (_) {}
    }
  }

  // The hidden page.

  Future<void> _start() async {
    if (_ready != null) return _ready!.future;
    final ready = _ready = Completer<void>();
    try {
      final headers = (jsonDecode(utf8.decode((await _read('headers.json'))!)) as Map).cast<String, String>();
      final bridge = _bridge = Bridge(read: _read, headers: headers, onMessage: _receive);
      await bridge.start();
      trace?.call('page: server on ${bridge.origin.port}');
      final web = _web = HeadlessInAppWebView(
        initialUrlRequest: URLRequest(url: WebUri.uri(bridge.origin)),
        onLoadStop: (_, __) => trace?.call('page: loaded'),
        onConsoleMessage: (_, message) => trace?.call('page console: ${message.message}'),
        onReceivedError: (_, request, error) {
          trace?.call('page: ${request.url} failed: ${error.description}');
          if (request.isForMainFrame == true) _teardown(JXLException('JXL_BRIDGE', 'The page did not load: ${error.description}'));
        },
        onWebContentProcessDidTerminate: (_) {
          trace?.call('page: its process stopped');
          _teardown(const JXLException('JXL_BRIDGE', "The page's process stopped; the next call starts a new page."));
        },
        // The page plays a video, muted and unseen, to read its frames; it reads no file: or content: URL.
        initialSettings: InAppWebViewSettings(
            mediaPlaybackRequiresUserGesture: false, allowsInlineMediaPlayback: true, isInspectable: false,
            allowFileAccess: false, allowContentAccess: false, allowFileAccessFromFileURLs: false, allowUniversalAccessFromFileURLs: false),
      );
      await web.run();
      trace?.call('page: running, waiting for ready');
    } catch (error) {
      _teardown(JXLException('JXL_BRIDGE', '$error'));
    }
    return ready.future;
  }

  void _receive(Map<String, dynamic> message) {
    final id = message['id'];
    switch (message['type']) {
      case 'ready':
        trace?.call('page: ready');
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
