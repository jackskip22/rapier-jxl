// SPDX-License-Identifier: MIT
import {PASSED, joinedBytes, readAll, readEach} from '../step-journal.mjs';

const ROWS = 64;
const planeBytes = planes => planes.map(p => new Uint8Array(p.buffer,p.byteOffset,p.byteLength));
const planeRows = (planes,w) => (y,h) => readEach(planes.map(plane => () => {
  const bytes = plane.subarray(y * w * 4,(y + h) * w * 4);
  return new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength / 4);
}));

export async function scoreInSteps(reference,decoded,profile,sourceEncoding,{journal,unit,tools}) {
  const {scaleBand,downsample,referenceArena,useReferenceArena,releaseReferenceArena,GAUSS32,scaleNorm,scoreNorms,s2Pad,compileKernels,metricSamples} = tools;
  await compileKernels();
  const width = reference.width, height = reference.height;
  const pair = (y,h) => {
    if (!h) return [{rgba:new Uint8Array(0)},{rgba:new Uint8Array(0)}];
    const from = Math.min(y,height - 1), rows = Math.min(h,height - from);
    const pictures = readEach([reference,decoded].map(picture => () => ({...picture,width,height:rows,
      data:picture.data.subarray(from * width * 4,(from + rows) * width * 4)})));
    return metricSamples(...pictures,profile,sourceEncoding).map(input => {
      return width < 8 || height < 8 ? s2Pad(input,width,rows) : input;
    });
  };
  let read = pair;
  let w = Math.max(8,width), h = Math.max(8,height);
  const norms = [], arena = referenceArena([]);
  try {
    for (let scale = 0; scale < 6; scale++) {
      let state = null;
      for (let first = -4; first < h; first += ROWS) {
        const end = Math.min(h,first + ROWS), inputY = Math.min(h,Math.ceil((first + 4) / 4) * 4);
        const inputEnd = Math.min(h,Math.ceil((end + 4) / 4) * 4);
        const {value} = await unit('verify-score-row-' + scale,() => {
          if (state) readAll([state.scratch,state.sums]);
          const [before,after] = read(inputY,inputEnd - inputY);
          const close = useReferenceArena(arena);
          try {
            const next = scaleBand(before,after,w,h,GAUSS32,first,end,state);
            return end === h ? {sums:next.sums} : next;
          } finally { close(); }
        },{carry:true});
        if (value !== PASSED) state = value;
      }
      const per = {ssim:new Float64Array(6),edge:new Float64Array(12)};
      for (let c = 0; c < 3; c++) scaleNorm(per,c,state.sums.subarray(c * 6,c * 6 + 6),w * h);
      norms.push(per);
      if (scale === 5 || w < 8 || h < 8) break;
      const before = [[],[],[]], after = [[],[],[]];
      for (let y = 0; y < h; y += ROWS) {
        const rows = Math.min(ROWS,h - y);
        const {value} = await unit('verify-score-pyramid-' + scale,() => {
          const [left,right] = read(y,rows);
          const close = useReferenceArena(arena);
          try { return [planeBytes(downsample(left,w,rows).planes),planeBytes(downsample(right,w,rows).planes)]; }
          finally { close(); }
        },{cold:true,alone:true});
        for (let c = 0; c < 3; c++) { before[c].push(value[0][c]); after[c].push(value[1][c]); }
      }
      w = Math.ceil(w / 2); h = Math.ceil(h / 2);
      const a = planeRows(before.map(parts => joinedBytes(parts,journal.touched)),w);
      const b = planeRows(after.map(parts => joinedBytes(parts,journal.touched)),w);
      read = (y,h) => readEach([() => a(y,h),() => b(y,h)]);
    }
    return scoreNorms(norms).score;
  } finally { releaseReferenceArena(arena); }
}
