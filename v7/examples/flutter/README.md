# rapier-jxl in Flutter

A Dart package around the browser encoder in one hidden web view: no native JPEG XL codec to build or link. It encodes a photo,
recompresses a JPEG and restores the same SHA-256, turns a GIF or a video into an animated JPEG XL, cancels a call, and refuses
bad input with the package's `JXL_` code.

**Status: written, not yet run.** No Flutter SDK, Android emulator or iPhone simulator was available where this was written.
Nothing here has been compiled or tested; the checks below are what `ci/flutter.yml` runs.

## Use

Flutter 3.22 or newer, Android 8.0 (API 26) or newer, iOS 15.1 or newer, macOS 10.15 or newer.

```sh
npm install --no-save jpegxl
node prepare-assets.mjs          # copies the built modules into assets/web/jpegxl
```

Add this folder as a path dependency, then the three platform settings below.

```dart
import 'package:rapier_jxl/rapier_jxl.dart';

final codec = JXLCodec();
final jxl = await codec.encode(photoBytes, quality: 80, effort: 3);   // PNG, JPEG, GIF or WebP in, JPEG XL out
final exact = await codec.encodeExact(photoBytes);                    // every pixel kept
final small = await codec.recompress(jpegBytes);                      // a JPEG's own bytes, smaller
final same = await codec.restore(small);                              // the same JPEG, byte for byte
final clip = await codec.animateVideo(mp4Bytes, type: 'video/mp4');   // every frame, each with its time
final moving = await codec.animateGif(gifBytes);                      // a GIF, with its timing and loops

final cancel = JXLCancel();
final pending = codec.encodeExact(photoBytes, cancel: cancel);
cancel.cancel();                                                      // pending throws JXLCanceledException
```

`animateVideo` and `animateGif` report progress from 0 to 1 through `onProgress`. Each call runs one at a time. A canceled call
throws `JXLCanceledException`; the next call runs normally. A refusal throws `JXLException` with the package's `JXL_` code.
`warmUp()` loads the page early; `dispose()` stops it.

## Platform settings

The page and its bytes cross a server on `127.0.0.1`, so each app needs to allow that and nothing else. `ci/platform.sh`
applies all three to the example.

- Android: `android.permission.INTERNET` (the release manifest does not have it) and a network security config that allows
  cleartext to `127.0.0.1` only.
- iOS: `NSAppTransportSecurity` with `NSAllowsLocalNetworking`.
- macOS: the `network.server` and `network.client` sandbox entitlements.

## How bytes cross

The package serves its web files and carries bytes as HTTP bodies on a loopback server in Dart: the page fetches `in/<id>` and
POSTs each result to `out/<id>/result`. No base64. The server listens on `127.0.0.1` only, under a random 128-bit path, and
answers only requests whose Host is that address. Other apps on the phone can reach the port but not the path.

Cost: the INTERNET permission on Android (the other examples have none), and a copy of each input and result in Dart memory
while its call runs. Where a platform channel with binary messages exists, it would avoid both; `flutter_inappwebview` has none
that is the same on every platform.

## Why `flutter_inappwebview`

`webview_flutter` has no headless view: it needs a widget in the tree, and a page that plays a video must stay alive and unseen.
`flutter_inappwebview` has `HeadlessInAppWebView` on Android, iOS, macOS and Windows. Picked on that reading of its
documentation, not on a run.

## Windows and Linux

- Windows: `flutter_inappwebview` runs a headless WebView2 there, so the Dart code should work unchanged. It needs the WebView2
  runtime and the package's Windows setup, and was not tried.
- Linux: `flutter_inappwebview` has no Linux view. It needs another web view that can run offscreen (a WebKitGTK plugin) behind the
  same `Bridge`; nothing here does that.

## Files

- `lib/rapier_jxl.dart`: `JXLCodec`, `JXLCancel`, `JXLException`.
- `lib/src/bridge.dart`: the loopback server.
- `assets/web/`: the page (videos and GIFs), its worker (photos and JPEGs), and (after `prepare-assets.mjs`) the modules.
- `example/`: an app with three buttons on bundled files, and `integration_test/` for the real app.
- `test/`: `flutter test`, the server's rules.

## Check

`flutter test` checks the server. `flutter test integration_test` in `example/` runs the real app on a device: photo, exact JPEG
restore, GIF, video read back frame by frame, refusal, cancel before and during a call, and the next call. `ci/flutter.yml` runs it
on an Android emulator (Linux, KVM), an iPhone simulator and macOS.
