import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:rapier_jxl/rapier_jxl.dart';

void main() => runApp(const ExampleApp());

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});
  @override
  Widget build(BuildContext context) => const MaterialApp(home: Home());
}

class Home extends StatefulWidget {
  const Home({super.key});
  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> {
  final codec = JXLCodec();
  String status = 'Ready';

  Future<void> run(String name, Future<String> Function(JXLCodec codec) body) async {
    setState(() => status = '$name…');
    try {
      final result = await body(codec);
      setState(() => status = result);
    } on JXLException catch (error) {
      setState(() => status = error.toString());
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('rapier-jxl')),
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            FilledButton(
              onPressed: () => run('Encoding', (c) async {
                final jpeg = await rootBundle.load('assets/fixtures/photo.jpg');
                final jxl = await c.encode(jpeg.buffer.asUint8List());
                return 'Photo: ${jpeg.lengthInBytes} B → ${jxl.length} B';
              }),
              child: const Text('Encode a photo'),
            ),
            FilledButton(
              onPressed: () => run('Recompressing', (c) async {
                final jpeg = (await rootBundle.load('assets/fixtures/photo.jpg')).buffer.asUint8List();
                final small = await c.recompress(jpeg);
                final same = await c.restore(small);
                return 'JPEG: ${jpeg.length} B → ${small.length} B, restored ${same.length == jpeg.length && _equal(same, jpeg) ? 'the same file' : 'a different file'}';
              }),
              child: const Text('Recompress a JPEG'),
            ),
            FilledButton(
              onPressed: () => run('Animating', (c) async {
                final video = (await rootBundle.load('assets/fixtures/train.mp4')).buffer.asUint8List();
                final jxl = await c.animateVideo(video, type: 'video/mp4');
                return 'Video: ${video.length} B → ${jxl.length} B';
              }),
              child: const Text('Video to animated JPEG XL'),
            ),
            const SizedBox(height: 16),
            Text(status, key: const Key('status')),
          ]),
        ),
      );
}

bool _equal(List<int> a, List<int> b) {
  for (var i = 0; i < a.length; i++) { if (a[i] != b[i]) return false; }
  return true;
}
