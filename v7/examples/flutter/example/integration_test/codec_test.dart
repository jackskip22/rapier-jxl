import 'dart:typed_data';

import 'package:crypto/crypto.dart' show sha256;
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:rapier_jxl/rapier_jxl.dart';

Future<Uint8List> fixture(String name) async => (await rootBundle.load('assets/fixtures/$name')).buffer.asUint8List();
bool isJxl(Uint8List b) => b.length > 2 && b[0] == 0xFF && b[1] == 0x0A;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  late JXLCodec codec;

  setUp(() async {
    codec = JXLCodec();
    await codec.warmUp();
    await codec.encode(await fixture('small.jpg'), quality: 60, effort: 1);
  });
  tearDown(() => codec.dispose());

  testWidgets('a photo encodes', (_) async {
    final jxl = await codec.encode(await fixture('photo.jpg'));
    expect(isJxl(jxl), isTrue);
  });

  testWidgets('a JPEG restores to the same SHA-256', (_) async {
    final jpeg = await fixture('photo.jpg');
    final jxl = await codec.recompress(jpeg);
    expect(jxl.length, lessThan(jpeg.length));
    expect(sha256.convert(await codec.restore(jxl)), sha256.convert(jpeg));
  });

  testWidgets('a GIF animates', (_) async {
    expect(isJxl(await codec.animateGif(await fixture('two-frames.gif'))), isTrue);
  });

  testWidgets('a video animates, with progress, frames and its length', (_) async {
    final seen = <double>[];
    final jxl = await codec.animateVideo(await fixture('train.mp4'), type: 'video/mp4', effort: 1, onProgress: seen.add);
    expect(isJxl(jxl), isTrue);
    expect(seen, isNotEmpty);
    codec.serve('jpegxl/decode.mjs', await fixture('decode.mjs'));
    final read = await codec.callPage('''
      const {decode} = await import('./jpegxl/decode.mjs');
      const image = await decode(new Uint8Array(await (await fetch('in/readback')).arrayBuffer()));
      return [image.frames.length, image.frames.reduce((sum, frame) => sum + frame.durationSeconds, 0)];
    ''', input: jxl);
    expect(read[0], greaterThan(1));
    expect(read[1], closeTo(2.0, 0.1));
  });

  testWidgets('a bad input refuses with its code, and the next call recovers', (_) async {
    await expectLater(codec.recompress(Uint8List.fromList([0, 1, 2])),
        throwsA(isA<JXLException>().having((e) => e.code, 'code', startsWith('JXL_'))));
    expect(isJxl(await codec.recompress(await fixture('photo.jpg'))), isTrue);
  });

  testWidgets('cancel before the start, and during a call, then the next call runs', (_) async {
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
