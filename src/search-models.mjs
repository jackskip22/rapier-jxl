// SPDX-License-Identifier: MIT
import {wasmBytes} from './wasm-text.mjs';
import {kernelInstance, arenaHolder, takeArena, growArena} from './kernel-runtime.mjs';
import {intMlpCpu} from './model-weights.mjs';

export const E9_GROUP_WEIGHTS = "Í\u0000]AMOCKéÉÎÏJª\u0017¢7Ï)KV1hºzVMh²Â3©¿ýf 33r3Mhç\\É3Ô¾§Ï[\u0018=3b?uYÖDÉ0ÀO ÉB@/dJ\t³WÇNÏ3Ò¦ÎèòÞÞªÔ±ü\"N3Ï\u0012JW1i¿\u0018gK\u0014½gÞMÈ2È­0i\u0011^D\\qK\fÏõ\u0005m«ÉËÏÄ°µ{º7Î6¿F0ªÔÏËÇ´½$¾1Ï;MB3VÊóÝ¬¨ªj¤¼â2#¥\u0001­ÄÌËÏ±´\r½1Ì4·B0rM¹`Iÿ\u0003:\u001c\u001f9æÏÎß Æw322M0M0M0M0M0M0M0M0M0M0M0M0\u0006L Lz";

export const E10_FOREST_WEIGHTS = "Í\u0000]]MGCKÀ2J=0ÂT\u000eç²\u001aïÏ­1oEWÏv\u0000y~t³ÌÌ33)fc\\ËDvÑ`M:\u0002æ¸\u0011dÏ\u0007 9R3Ë\u0016\fÚº¥5Ä>ÉÖºQ7S\u0018\u0003BÆº\n?tòÑiÌW)tÎ3çÁOÈ353Î;îøÊûfr¿¿O2Æz½þVÈÁH:,\u00183Çêv;Ï¶©H5C`Ug0Ï\u0003G<GQs\u0000QFh¡ªJÏ>9.P\u0001Ulwª-\u0005|1É©m;(\u000f²bCcÚõóÉ0ñ¬ÊâÉ.NüðÌ¬ö\u0001ß:ävHUÅ[ô\f1üË\u0019\\RLú4 I=Ù1\u0017\"7êÂxWè\u0005ûEG÷©4ÏïÞ312nÎÌ*6È¬3ìÏÁBc^1Ì\t®2þ}¹5^<02Ï0ÎE¦3|A¥\u001c\u0014[}¡O`AÏÌÎ.52¤\"Ï8<\\ÏÇ3kòhô63\u0005â\u0011®Ë*áã6ï¤2\u0005WPIJ¨D·°¼j¡¢õòÖ«ºAPpÐ°m2rÈ1$ùj¤²¨d¿~´f·\u000fV­® H1M0M0M0M0M0M0M0M0M0M0M0M0M0M0M0M0MsM\u0016M²fMeMóMfMhMxMæ¥ê&";

export const LOSSY_E9_WEIGHTS = "Í\u0000]AMNCKÎ3ó9`;~3Ø6?Ìb5\t5|2%\u00063f3Ï;ÆÏ»^3È¿\u001dúÏÿÏ2Ý\u00043«YÏ6)Ó43~3\u001b3Î>­Ïµ\u00103\"3§W03\u001e3Ï4Ïu13Ï\u0012ÜëÇRÏ3Ê3È6ê3\u0005%7X3Ï<¾Ïo63Ï<¿á¼Ï1Æ¼3¦kÿ\fÏ-ÇÎÉÃ¿Ï%ÊÖ3°îÅÈ3ï\f #3Ã3\u0006Ìm5Ïç¯¢íÌõÌ3ÿ\u000b3·\u0004Î1Ï!\u000exáÐl;Â´3³vÈÌÏ2ÏÏ3Ï32Ï33Ò0Ì6\u0001EcC\u0018ðÅkL³¸¶^MY_L·F­M0M0M0M0M0M0M0M0M0M0M0M0JNÄ²r²Ï\u0002h";

let decodedE9 = null, decodedE10 = null, decodedLossy9 = null, statsHolder = null;

export const e9GroupPacket = () => decodedE9 ||= wasmBytes(E9_GROUP_WEIGHTS);
export const e10ForestPacket = () => decodedE10 ||= wasmBytes(E10_FOREST_WEIGHTS);
export const lossyE9Packet = () => decodedLossy9 ||= wasmBytes(LOSSY_E9_WEIGHTS);

const BASE = 65536, DIRECT_LIMIT = 8 * 1024 * 1024;
export const isForcedFullSearch = () => (typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && globalThis.__RAPIER_JXL_FULL_SEARCH === true;
const forceFull = isForcedFullSearch;

export function decisionStatsCpu(rgba, stride, x0, y0, w, h, stepY = 1) {
  if (w < 2 || h < 2) return new Int32Array(16);
  const sy = stepY < 1 ? 1 : stepY | 0;
  const {memory, exports} = kernelInstance();
  statsHolder ||= arenaHolder(() => {});
  takeArena(statsHolder);

  if (x0 === 0 && y0 === 0 && stride === w && w * h * 4 <= DIRECT_LIMIT) {
    const bytes = w * h * 4, outPtr = (BASE + bytes + 15) & ~15, end = outPtr + 64;
    if (memory.buffer.byteLength < end) growArena(end);
    new Uint8Array(memory.buffer, BASE, bytes).set(rgba.subarray(0, bytes));
    exports.decisionStats(BASE, w, 0, 0, w, h, sy, outPtr);
    return new Int32Array(memory.buffer.slice(outPtr, outPtr + 64));
  }

  const rowBytes = w * 4;
  if (sy === 1) {
    const bytes = h * rowBytes, outPtr = (BASE + bytes + 15) & ~15, end = outPtr + 64;
    if (memory.buffer.byteLength < end) growArena(end);
    const dst = new Uint8Array(memory.buffer, BASE, bytes);
    for (let r = 0; r < h; r++) {
      const s = ((y0 + r) * stride + x0) * 4;
      dst.set(rgba.subarray(s, s + rowBytes), r * rowBytes);
    }
    exports.decisionStats(BASE, w, 0, 0, w, h, 1, outPtr);
    return new Int32Array(memory.buffer.slice(outPtr, outPtr + 64));
  }

  const pairs = Math.floor((h - 1 + sy - 1) / sy), packedH = pairs * 2;
  const bytes = packedH * rowBytes, outPtr = (BASE + bytes + 15) & ~15, end = outPtr + 64;
  if (memory.buffer.byteLength < end) growArena(end);
  const dst = new Uint8Array(memory.buffer, BASE, bytes);
  for (let k = 0, y = 1; y < h; k++, y += sy) {
    const sPrev = ((y0 + y - 1) * stride + x0) * 4;
    const sRow = ((y0 + y) * stride + x0) * 4;
    dst.set(rgba.subarray(sPrev, sPrev + rowBytes), (k * 2) * rowBytes);
    dst.set(rgba.subarray(sRow, sRow + rowBytes), (k * 2 + 1) * rowBytes);
  }
  exports.decisionStats(BASE, w, 0, 0, w, packedH, 2, outPtr);
  return new Int32Array(memory.buffer.slice(outPtr, outPtr + 64));
}

export function steerLosslessNineGroup(rgba, stride, x0, y0, w, h, r0, r1) {
  const area = w * h;
  if (forceFull() || area <= 65536) return {keepFixed: true, allLearned: true};
  const stepY = area > 300000 ? 2 : 1;
  const s = decisionStatsCpu(rgba, stride, x0, y0, w, h, stepY);
  if (s[0] >= 3072 || s[1] >= 14336 || s[14] < 64) return {keepFixed: true, allLearned: true};
  const input = Int32Array.of(
    s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7],
    s[8], s[9], s[10], s[11], s[13], s[14], s[15],
    r1 !== r0 ? 8192 : 0,
  );
  const out = intMlpCpu(e9GroupPacket(), input, 1);
  if (out[0] < 12) return {keepFixed: false, allLearned: true};
  if (r1 !== r0 && out[1] < 28) return {keepFixed: false, allLearned: false, keepR1: true};
  return {keepFixed: false, allLearned: false, keepR1: false};
}

function classifyChainFamily(chain, r0, r1) {
  if (chain.length === 1 && (chain[0] === r0 || (Math.abs(chain[0] - r0) === 1 && ((chain[0] / 7) | 0) === ((r0 / 7) | 0)))) return 0;
  if (chain.length === 2 && chain[0] === r0 && chain[1] === 21) return 1;
  if (chain[0] === (r0 + 21) % 42) return 2;
  if (chain.length === 3 && chain[0] === r0) return 3;
  if (chain[0] === r1 || (Math.abs(chain[0] - r1) === 1 && ((chain[0] / 7) | 0) === ((r1 / 7) | 0)) || chain[0] === (r1 + 21) % 42) return 4;
  return 5;
}

export function steerForestGroup(rgba, w, h, cands, ranked) {
  if (forceFull()) {
    return {
      fullSearch: true,
      primaryChains: cands,
      expandChains: [],
      wpPresets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      fastWp: false,
      spanMode: 'all14',
    };
  }
  const r0 = ranked?.[0] ?? cands[0]?.[0] ?? 6, r1 = ranked?.[1] ?? r0;
  const s = decisionStatsCpu(rgba, w, 0, 0, w, h, w * h > 300000 ? 2 : 1);
  if (s[0] >= 3072 || s[1] >= 14336 || s[14] < 64 || cands.length <= 4) {
    return {
      fullSearch: true,
      primaryChains: cands,
      expandChains: [],
      wpPresets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      fastWp: false,
      spanMode: 'all14',
    };
  }
  const input = Int32Array.of(
    s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7],
    s[8], s[9], s[10], s[11], s[12], s[13],
    (r0 % 7) * 2048, (r1 % 7) * 2048,
  );
  const out = intMlpCpu(e10ForestPacket(), input, 1);

  const famOrder = [0, 1, 2, 3, 4, 5].sort((a, b) => out[b] - out[a] || a - b);
  const byFam = [[], [], [], [], [], []];
  for (let i = 0; i < cands.length; i++) byFam[classifyChainFamily(cands[i], r0, r1)].push(i);

  const orderedIdx = [0], seen = new Set([0]);
  for (let i = 1; i < cands.length; i++) {
    if (cands[i].length === 1 && cands[i][0] === 6) { orderedIdx.push(i); seen.add(i); break; }
  }
  for (const f of famOrder) {
    for (const idx of byFam[f]) {
      if (!seen.has(idx)) { orderedIdx.push(idx); seen.add(idx); break; }
    }
  }
  for (const f of famOrder) {
    for (const idx of byFam[f]) if (!seen.has(idx)) { orderedIdx.push(idx); seen.add(idx); }
  }
  const orderedChains = orderedIdx.map(i => cands[i]);

  const wpRank = [[8, out[6]], [9, out[7]], [2, out[8]]].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const wpPresets = [0, wpRank[0][0], wpRank[1][0], 3, 6];
  const spanMode = out[9] >= 120 ? 'all14' : 'mid10';

  return {
    fullSearch: false,
    primaryChains: orderedChains.slice(0, 4),
    expandChains: orderedChains.slice(4, 7),
    wpPresets,
    fastWp: true,
    spanMode,
  };
}

export function steerLossyNine(rgba, width, height, readingIntent, e8VarShare, e8Bytes) {
  if (forceFull()) return null;
  const stepY = Math.max(1, Math.floor(height / 256));
  const s = decisionStatsCpu(rgba, width, 0, 0, width, height, stepY);
  const area = Math.max(1, width * height);
  const bppQ11 = Math.min(32767, Math.floor((e8Bytes * 8 * 2048) / area));
  const input = Int32Array.of(
    s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7],
    s[8], s[9], s[10], s[14],
    Math.round(readingIntent * 16384),
    Math.max(0, Math.round((readingIntent - 0.85) * 65536)),
    Math.round(e8VarShare * 16384),
    bppQ11,
  );
  const out = intMlpCpu(lossyE9Packet(), input, 1);
  const flatLike = s[0] >= 3072 || s[1] >= 14336;
  const wantR67 = flatLike || out[0] >= -8;
  return {
    tryBlock16: wantR67 && (flatLike || out[1] <= 24),
    tryBlock: wantR67 && (flatLike || out[1] >= -24),
    rung9Candidates: flatLike || out[2] >= 16
      ? ['gaborish', 'blocks', 'field', 'closed', 'plain']
      : out[2] >= -16 ? ['gaborish', 'field', 'plain'] : null,
    testAltEpf: flatLike || s[2] >= 512 || s[4] >= 1024,
  };
}

export function steerTenSmallPhoto(rgba, w, h, allRcts, cands, ranked) {
  const plan = steerForestGroup(rgba, w, h, cands, ranked);
  if (plan.fullSearch || allRcts.length <= 2) return null;
  const chosen = [allRcts[0]], chained0 = 42 * 22 + allRcts[0];
  if (allRcts.includes(chained0)) chosen.push(chained0);
  for (const ch of [...plan.primaryChains, ...plan.expandChains]) {
    const code = ch.length === 2 && ch[1] === 21 ? 42 * 22 + ch[0] : ch.length === 1 ? ch[0] : -1;
    if (code >= 0 && allRcts.includes(code) && !chosen.includes(code)) {
      chosen.push(code);
      if (chosen.length >= 3) break;
    }
  }
  for (const code of allRcts) {
    if (chosen.length >= 3) break;
    if (!chosen.includes(code)) chosen.push(code);
  }
  return {rcts: chosen, wpPresets: plan.wpPresets};
}
