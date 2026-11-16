import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:rapier_jxl/src/bridge.dart';

void main() {
  late Bridge bridge;
  final messages = <Map<String, dynamic>>[];
  final client = HttpClient();

  setUp(() async {
    messages.clear();
    bridge = Bridge(
      read: (path) async => path == 'encoder.html' || path == 'headers.json' ? Uint8List.fromList(utf8.encode('x')) : null,
      headers: {'Cross-Origin-Resource-Policy': 'same-origin'},
      onMessage: messages.add,
    );
    await bridge.start();
  });
  tearDown(() => bridge.stop());

  Future<HttpClientResponse> send(String method, Uri url, [List<int>? body]) async {
    final request = await client.openUrl(method, url);
    if (body != null) request.add(body);
    return request.close();
  }

  test('serves the page with its headers, never headers.json', () async {
    final page = await send('GET', bridge.origin);
    expect(page.statusCode, 200);
    expect(page.headers.value('cross-origin-resource-policy'), 'same-origin');
    await page.drain();
    final headers = await send('GET', bridge.origin.resolve('headers.json'));
    expect(headers.statusCode, 404);
    await headers.drain();
  });

  test('answers nothing outside the random path, or to another Host', () async {
    final wrong = await send('GET', Uri.parse('http://127.0.0.1:${bridge.origin.port}/encoder.html'));
    expect(wrong.statusCode, 404);
    await wrong.drain();
    final request = await client.getUrl(bridge.origin);
    request.headers.host = 'example.com';
    final other = await request.close();
    expect(other.statusCode, 404);
    await other.drain();
  });

  test('carries bytes in, bytes out and messages as bodies', () async {
    bridge.inputs['a'] = Uint8List.fromList([0, 255, 7]);
    final input = await send('GET', bridge.origin.resolve('in/a'));
    expect(await input.fold<List<int>>([], (all, chunk) => all..addAll(chunk)), [0, 255, 7]);
    final out = await send('POST', bridge.origin.resolve('out/a/result'), [1, 2, 3]);
    expect(out.statusCode, 204);
    await out.drain();
    expect(bridge.outputs['a/result'], [1, 2, 3]);
    final msg = await send('POST', bridge.origin.resolve('msg'), utf8.encode('{"type":"done","id":"a"}'));
    await msg.drain();
    expect(messages.single['type'], 'done');
  });
}
