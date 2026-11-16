import 'dart:async';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' show sha256;
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:rapier_jxl/rapier_jxl.dart';

Future<Uint8List> fixture(String name) async => (await rootBundle.load('assets/fixtures/$name')).buffer.asUint8List();
// Every test has a three-minute limit, so a hang names the test; the setup has the same limit.
const limit = Duration(minutes: 3);
void stage(String name) => print('[stage] $name');
void check(String name, Future<void> Function() body) =>
    testWidgets(name, (_) => body().timeout(limit, onTimeout: () => throw TimeoutException('$name: no answer in 3 minutes')), timeout: Timeout(limit + const Duration(seconds: 20)));
// A bare codestream starts FF 0A; a JPEG's recompression is a container, which starts with its 12-byte signature box.
bool isJxl(Uint8List b) =>
    (b.length > 2 && b[0] == 0xFF && b[1] == 0x0A) ||
    (b.length > 12 && b[3] == 0x0C && b[4] == 0x4A && b[5] == 0x58 && b[6] == 0x4C && b[7] == 0x20);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  late JXLCodec codec;

  setUp(() async {
    codec = JXLCodec();
    stage('set up: warm up');
    await codec.warmUp().timeout(limit, onTimeout: () => throw TimeoutException('warm up: no answer in 3 minutes'));
    stage('set up: first encode');
    await codec.encode(await fixture('small.jpg'), quality: 60, effort: 1)
        .timeout(limit, onTimeout: () => throw TimeoutException('first encode: no answer in 3 minutes'));
  });
  tearDown(() => codec.dispose());

  check('a photo encodes', () async {
    final jxl = await codec.encode(await fixture('photo.jpg'));
    expect(isJxl(jxl), isTrue);
  });

  check('a JPEG restores to the same SHA-256', () async {
    final jpeg = await fixture('photo.jpg');
    final jxl = await codec.recompress(jpeg);
    expect(jxl.length, lessThan(jpeg.length));
    expect(sha256.convert(await codec.restore(jxl)), sha256.convert(jpeg));
  });

  check('a GIF animates', () async {
    expect(isJxl(await codec.animateGif(await fixture('two-frames.gif'))), isTrue);
  });

  check('a video animates, with progress, frames and its length', () async {
    final seen = <double>[];
    stage('video: animate');
    final jxl = await codec.animateVideo(await fixture('train.mp4'), type: 'video/mp4', effort: 1, onProgress: seen.add);
    stage('video: animated, ${seen.length} progress calls');
    expect(isJxl(jxl), isTrue);
    expect(seen, isNotEmpty);
    stage('video: reading it back');
    codec.serve('jpegxl/decode.mjs', await fixture('decode.mjs'));
    final read = await codec.callPage('''
      // The page's own address, not a relative one: this body runs where relative addresses have no base on Android.
      const {decode} = await import(new URL('./jpegxl/decode.mjs', document.baseURI).href);
      const image = await decode(new Uint8Array(await (await fetch(new URL('in/readback', document.baseURI))).arrayBuffer()));
      return [image.frames.length, image.frames.reduce((sum, frame) => sum + frame.durationSeconds, 0)];
    ''', input: jxl);
    stage('video: read back ${read[0]} frames, ${read[1]} s');
    expect(read[0], greaterThan(1));
    expect(read[1], closeTo(2.0, 0.1));
  });

  check('a bad input refuses with its code, and the next call recovers', () async {
    await expectLater(codec.recompress(Uint8List.fromList([0, 1, 2])),
        throwsA(isA<JXLException>().having((e) => e.code, 'code', startsWith('JXL_'))));
    expect(isJxl(await codec.recompress(await fixture('photo.jpg'))), isTrue);
  });

  check('cancel before the start, and during a call, then the next call runs', () async {
    final photo = await fixture('photo.jpg');
    final early = JXLCancel()..cancel();
    await expectLater(codec.encodeExact(photo, cancel: early), throwsA(isA<JXLCanceledException>()));
    final running = JXLCancel();
    codec.onStart = (_) { codec.onStart = null; running.cancel(); };
    await expectLater(codec.encodeExact(photo, cancel: running), throwsA(isA<JXLCanceledException>()));
    expect(isJxl(await codec.encode(await fixture('small.jpg'), quality: 60, effort: 1)), isTrue);
    expect(codec.heldBytes, 0);
  });
}
