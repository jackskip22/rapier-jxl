// The proof the CI reads from the screen: every call on the device, then a refusal, a cancel and a call after it.
// A build with EXPO_PUBLIC_RAPIER_SELFTEST=1 runs it at start; the app shows "SELFTEST PASS" or "SELFTEST FAIL".
import {Asset} from 'expo-asset';
import {JXLError, type JXLCodec} from './index.ts';

const fixture = async (module: number) => {
  const asset = Asset.fromModule(module);
  await asset.downloadAsync();
  return new Uint8Array(await (await fetch(asset.localUri ?? asset.uri)).arrayBuffer());
};
const isJxl = (b: Uint8Array) => (b[0] === 0xff && b[1] === 0x0a) || (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 12);
const check = (condition: unknown, what: string) => { if (!condition) throw new Error(what); };

export async function selfTest(codec: JXLCodec, log: (line: string) => void) {
  const photo = await fixture(require('../assets/fixtures/photo.jpg'));
  const gif = await fixture(require('../assets/fixtures/two-frames.gif'));
  const video = await fixture(require('../assets/fixtures/train.mp4'));

  const jxl = await codec.encode(photo);
  check(isJxl(jxl) && jxl.length < photo.length, 'encode'); log(`photo ${photo.length} to ${jxl.length} bytes`);
  check(isJxl(await codec.encodeExact(photo)), 'encodeExact');
  const small = await codec.recompress(photo);
  const back = await codec.restore(small);
  check(small.length < photo.length && back.length === photo.length && back.every((b, i) => b === photo[i]), 'restore');
  log(`JPEG ${photo.length} to ${small.length}, restored the same bytes`);
  check(isJxl(await codec.animate(gif)), 'gif');
  const seen: number[] = [];
  const clip = await codec.animate(video, {effort: 1, onProgress: f => seen.push(f)});
  check(isJxl(clip) && seen.length > 0, 'video'); log(`video ${video.length} to ${clip.length} bytes`);

  try { await codec.recompress(new Uint8Array([0, 1, 2])); check(false, 'a bad JPEG was accepted'); }
  catch (error) { check(error instanceof JXLError && /^JXL_[A-Z0-9_]+$/.test(error.code), 'bad input'); }
  const stop = new AbortController();
  const canceled = codec.animate(video, {effort: 3, signal: stop.signal, onProgress: () => stop.abort()});
  try { await canceled; check(false, 'a canceled call finished'); }
  catch (error) { check(error instanceof JXLError && error.code === 'JXL_CANCELED', 'cancel'); }
  check(isJxl(await codec.encode(photo, {quality: 60, effort: 1})), 'call after cancel');
}
