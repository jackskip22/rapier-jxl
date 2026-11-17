// SPDX-License-Identifier: MIT
import {PASSED, tiledBytes, joinedBytes} from '../step-journal.mjs';
import {dimensions, fail} from './primitives.mjs';
import {sampleView} from './verify-samples.mjs';

export async function orientInSteps(picture,{journal,unit,tools}) {
  const {prepareKernels,ensureKernels,orientBlock,wasmRequired} = tools;
  const {orientation = 1,width,height,data,...description} = picture;
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) throw fail('JXL_INPUT',"orientation: integer 1-8");
  if (orientation === 1) return {data,width,height,...description};
  if (description.extraChannels !== undefined) throw fail('JXL_UNSUPPORTED',"extraChannels: supply oriented samples");
  if (!await prepareKernels() || !ensureKernels()) throw wasmRequired();
  const Type = data.constructor, size = Type.BYTES_PER_ELEMENT;
  const from = {subarray:(a,b) => { const row = data.subarray(a / size,b / size); return new Uint8Array(row.buffer,row.byteOffset,row.byteLength); }};
  const source = new Proxy(new Uint8Array(0),{get:(_,key) => key === 'subarray' ? from.subarray : undefined});
  const transpose = orientation >= 5, outWidth = transpose ? height : width, outHeight = transpose ? width : height, bands = [];
  for (let y = 0; y < outHeight; y += 256) {
    const band = [];
    for (let x = 0; x < outWidth; x += 256) {
      const w = Math.min(256,outWidth - x), h = Math.min(256,outHeight - y);
      const {value} = await unit('verify-orient-block',() => {
        const sx = transpose ? orientation >= 7 ? width - y - h : y : orientation === 2 || orientation === 3 ? width - x - w : x;
        const sy = transpose ? orientation === 6 || orientation === 7 ? height - x - w : x : orientation === 3 || orientation === 4 ? height - y - h : y;
        const pixels = new Uint8Array(w * h * 4 * size);
        orientBlock(source,pixels,width,w,sx,sy,transpose ? h : w,transpose ? w : h,0,0,4 * size,orientation);
        return pixels;
      },{cold:true,alone:true});
      band.push(value);
    }
    bands.push(band);
  }
  return {...description,width:outWidth,height:outHeight,data:sampleView(tiledBytes(bands,outWidth * size,outHeight,256,256 * size,journal.touched),Type)};
}

export async function resizeInSteps(picture,width,height,options,{journal,unit,tools}) {
  const {prepareKernels,ensureKernels,sampleBands,wasmRequired,sampleResizeConfig,sampleResizeStep} = tools;
  dimensions(width,height,options.maxPixels);
  if (width === picture.width && height === picture.height) return picture;
  if (!await prepareKernels() || !ensureKernels()) throw wasmRequired();
  const Type = picture.data.constructor, size = Type.BYTES_PER_ELEMENT;
  const {value:settings} = await unit('verify-resize-config',() => sampleResizeConfig({...picture,data:new Type(0)},options));
  const {config,table,levels} = settings, rowLimit = Math.max(1,Math.min(64,Math.floor(262144 / Math.max(width,picture.width))));
  const bands = sampleBands(picture.width,picture.height,width,height,config,table,levels,size);
  const advance = state => {
    const pixels = new Type(Math.min(rowLimit,bands.outRows) * width * 4);
    const {state:next,written} = sampleResizeStep(bands,picture.data,picture.height,height,state,pixels,0,Math.min(rowLimit,bands.outRows));
    return {bytes:new Uint8Array(pixels.buffer,0,written * width * 4 * size),state:next};
  };
  let state = {y:0,row:null,sum:null};
  const pieces = [];
  do {
    let next;
    const {value:bytes} = await unit('verify-resize-rows',() => (next = advance(state)).bytes,{cold:true,alone:true});
    pieces.push(bytes);
    const {value} = await unit('verify-resize-state',() => (next ??= advance(state)).state,{carry:true,tail:true});
    if (value !== PASSED) state = value;
  } while (state.y < height);
  return {...picture,width,height,data:sampleView(joinedBytes(pieces,journal.touched),Type)};
}
