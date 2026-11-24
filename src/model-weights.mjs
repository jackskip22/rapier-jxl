// SPDX-License-Identifier: MIT
import {wasmBytes} from './wasm-text.mjs';
import {kernelInstance, arenaHolder, takeArena, growArena} from './kernel-runtime.mjs';
import {fault} from './fault.mjs';

export const QUALITY_LANDING_WEIGHTS = "\u0002O\u0012\u0012\u0002\u0000\u000e\u0005}+f1\u000eÿ}\u0019}à\u0083f2}\u0000\u0083}}}\u0001 \u0000}}i\u0099µðF}Ù\u0083}\u001fI\u0002\u000fù}\u0002z½\u0087DB}>\u0083}\u0016B\u000b\u0001\u0003Eå\u001d\u009dçÂ2`\u001eÊ}\r<\n\u0001\u0003Iä\u001f\u0098åÃ3\\\u0014É}\u0017?\u000b\u0000\u0003@è\u0019ªåÅ(U\u001bÉ}\f>\n\u0000\u0003Dé\u001e\u0099äÀ2X\u0014Ï}\u00128\u000b\u0000\u0003Bè\u0014¬èË*L\u0015Ò}\u00165\u0005\u0002\u0003-î\u0011¶ðÖ'B\u0011Ú}\u0017:\n\u0002\u0003,ð\u0010¹òÞ\u001d<\u0017Ú}\u001b1\u0007\u0002\u0002.ó\u0012½ðÙ\u001e5\u0016â}\u00117\u0004\u0003\u00031ì\u0016¾ì× =\u0013Ù}\u0010/\u0006\u0002\u0003.ò\u000fÀìÙ#7\u0012áC\u0013/\u0006ý\u0002+ð\tËðÝ\u001f,\u000fä}\u000f*\u0006\u0003\u0003,í\u000fÂöÕ#2\tç}\"?\u0002\bü}ýDìÒ)!}%\u0083}}}}}}}}onZaREL}\u0001\u0002\u0006\n\u0005\u0006\u0007\u0001þüþ\u0003ÿþþ\u0002×ï\u0092\u0002Mé\fðNð^ð»ðLñL÷]÷KõPô-úýú{úêè¦\u0006\u0013\u0002";

const isqrt = n => { let r = Math.sqrt(n) | 0; while ((r + 1) * (r + 1) <= n) r++; while (r * r > n) r--; return r; };
let decodedLanding = null, holder = null, cachedPacket = null;

export const qualityLandingPacket = () => decodedLanding ||= wasmBytes(QUALITY_LANDING_WEIGHTS);

export function intMlpCpu(packet, inputs, count = 1) {
  if (!(packet instanceof Uint8Array) || packet.length < 12 || packet[1] !== 0x4d)
    throw fault('JXL_INTERNAL', 'model-weights:packet');
  const D = packet[2], H1 = packet[3], H2 = packet[4], O = packet[5], last = H2 || H1;
  const weights = 8 + H1 * D + H2 * H1 + O * last, length = weights + (weights & 1) + 2 * (H1 + H2 + O);
  if (D < 1 || H1 < 1 || H1 > 64 || H2 > 64 || O < 1 || packet[6] < 1 || packet[7] < 1 || packet.length < length || count < 1 || inputs.length < count * D)
    throw fault('JXL_INTERNAL', 'model-weights:shape');
  const {memory, exports} = kernelInstance();
  holder ||= arenaHolder(() => { cachedPacket = null; });
  takeArena(holder);
  const pktPtr = 65536, scratchPtr = (pktPtr + packet.length + 15) & ~15;
  const inPtr = scratchPtr + 512, outPtr = inPtr + count * D * 4, end = outPtr + count * O * 4;
  if (memory.buffer.byteLength < end) growArena(end);
  if (cachedPacket !== packet) { new Uint8Array(memory.buffer).set(packet, pktPtr); cachedPacket = packet; }
  const i32 = new Int32Array(memory.buffer);
  i32.set(inputs.subarray(0, count * D), inPtr >> 2);
  exports.intMlp(pktPtr, inPtr, count, outPtr, scratchPtr);
  return i32.slice(outPtr >> 2, (outPtr >> 2) + count * O);
}

export function quantizeLandingFeatures(intent, wide, effort, facts) {
  const b = facts.blocks, c = (v, hi = 16384) => v < 0 ? 0 : v > hi ? hi : v | 0, r = Math.round;
  return Int32Array.of(
    c(r(intent * 16384)), c(r((intent - 0.5) * 32768)), c(r((intent - 0.75) * 65536)), c(r((intent - 0.88) * 131072), 15728),
    wide ? 8192 : 0, effort >= 3 ? 4096 : 0,
    c(isqrt(Math.max(0, r(facts.gradient * 1024))) * 64), c(isqrt(Math.max(0, r(facts.chroma * 512))) * 64),
    c(r(((b?.spread10 ?? 0) + 1) * 2048)), c(r(((b?.spread50 ?? 1.5) + 1) * 2048)), c(r(((b?.spread90 ?? 3) + 1) * 2048)),
    c(r(((b?.slope50 ?? 1.5) + 1) * 2048)), c(r(((b?.slope90 ?? 3) + 1) * 2048)),
    c(r(((b ? b.slope50 - b.spread50 : 0) + 0.5) * 8192)),
    c((4194304 / Math.max(256, facts.shorterSide | 0)) | 0),
    facts.chroma < 2 && (facts.paletteSlots ?? 0) > 64 ? 8192 : 0
  );
}

export function qualityLanding(intent, wide, effort, facts) {
  const out = intMlpCpu(qualityLandingPacket(), quantizeLandingFeatures(intent, wide, effort, facts), 1), s = out[1] / 128;
  return {quality: out[0] / 128, slope: s < 0.35 ? 0.35 : s > 3 ? 3 : s};
}
