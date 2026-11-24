// SPDX-License-Identifier: MIT
import {PASSED, joinedBytes, readAll, readEach} from '../step-journal.mjs';
import {verificationRows} from './verify-work.mjs';

const AGAIN = 12;
const planeBytes = planes => planes.map(p => new Uint8Array(p.buffer,p.byteOffset,p.byteLength));
const planeRows = (planes,w) => (y,h) => readEach(planes.map(plane => () => {
  plane.ahead?.(y * w * 4,(y + h) * w * 4);
  const bytes = plane.subarray(y * w * 4,(y + h) * w * 4);
  return new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength / 4);
}));

export async function scoreInSteps(reference,decoded,profile,sourceEncoding,context,arithmetic = 'binary64') {
  const name = arithmetic === 'libjxl' ? 'verify-score-libjxl-' : 'verify-score-';
  return (await context.unit(name + 'result',() => scoreReading(reference,decoded,profile,sourceEncoding,context,arithmetic,name))).value;
}
async function scoreReading(reference,decoded,profile,sourceEncoding,context,arithmetic,name) {
  const {unit,tools} = context;
  const width = reference.width, height = reference.height;
  let opaque = true;
  const alphaRows = verificationRows(width);
  for (let y = 0; y < height; y += alphaRows) {
    const rows = Math.min(alphaRows,height - y), before = opaque;
    const {value} = await unit(name + 'alpha',() => before && [reference,decoded].every(picture => {
      picture.data.ahead?.(y * width * 4,(y + rows) * width * 4);
      return tools.opaque(picture.data.subarray(y * width * 4,(y + rows) * width * 4));
    }),{carry:true});
    if (value !== PASSED) opaque = value;
  }
  if (opaque) return scoreOver(reference,decoded,profile,sourceEncoding,context,arithmetic,name,null);
  let worse = Infinity;
  for (const background of [255,0])
    worse = Math.min(worse,await scoreOver(reference,decoded,profile,sourceEncoding,context,arithmetic,name + 'over-' + background + '-',background));
  return worse;
}
async function scoreOver(reference,decoded,profile,sourceEncoding,{journal,unit,tools},arithmetic,name,background) {
  const libjxl = arithmetic === 'libjxl';
  const {scaleBand,bandState,downsample,referenceArena,useReferenceArena,releaseReferenceArena,GAUSS32,scaleNorm,scoreNorms,s2Pad,compileKernels,metricSamples,composedOver} = tools;
  await compileKernels();
  const width = reference.width, height = reference.height;
  const pair = (y,h) => {
    if (!h) return [{rgba:new Uint8Array(0)},{rgba:new Uint8Array(0)}];
    const from = Math.min(y,height - 1), rows = Math.min(h,height - from);
    for (const picture of [reference,decoded]) picture.data.ahead?.(from * width * 4,(from + rows) * width * 4);
    const pictures = readEach([reference,decoded].map(picture => () => ({...picture,width,height:rows,
      data:picture.data.subarray(from * width * 4,(from + rows) * width * 4)})));
    return metricSamples(...(background === null ? pictures : pictures.map(picture => composedOver(picture,background))),profile,sourceEncoding).map(input => {
      return width < 8 || height < 8 ? s2Pad(input,width,rows) : input;
    });
  };
  let read = pair;
  let w = Math.max(8,width), h = Math.max(8,height);
  const norms = [], arena = referenceArena([]);
  try {
    for (let scale = 0; scale < 6; scale++) {
      const rowLimit = verificationRows(w,4);
      let state = null;
      for (let first = -4; first < h; first += rowLimit) {
        const end = Math.min(h,first + rowLimit), inputY = Math.min(h,Math.ceil((first + 4) / 4) * 4);
        const inputEnd = Math.min(h,Math.ceil((end + 4) / 4) * 4);
        const {value} = await unit(name + 'row-' + scale,() => {
          if (state) readAll([state.states,state.sums]);
          const from = state ? Math.max(0,inputY - AGAIN) : inputY, [before,after] = read(from,inputEnd - from);
          const close = useReferenceArena(arena);
          try {
            const next = scaleBand(before,after,w,h,GAUSS32,first,end,state,state ? from : null,libjxl);
            return end === h ? {sums:next.sums} : bandState(next,w);
          } finally { close(); }
        },{carry:true});
        if (value !== PASSED) state = value;
      }
      const per = {ssim:new Float64Array(6),edge:new Float64Array(12)};
      for (let c = 0; c < 3; c++) scaleNorm(per,c,state.sums.subarray(c * 6,c * 6 + 6),w * h);
      norms.push(per);
      if (scale === 5 || w < 8 || h < 8) break;
      const before = [[],[],[]], after = [[],[],[]];
      for (let y = 0; y < h; y += rowLimit) {
        const rows = Math.min(rowLimit,h - y);
        const {value} = await unit(name + 'pyramid-' + scale,() => {
          const [left,right] = read(y,rows);
          const close = useReferenceArena(arena);
          try { return [planeBytes(downsample(left,w,rows,null,libjxl).planes),planeBytes(downsample(right,w,rows,null,libjxl).planes)]; }
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
