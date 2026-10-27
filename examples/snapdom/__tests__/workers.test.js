import { describe, it, expect, afterEach } from 'vitest';
import { createEncoder } from '../../../dist/image.min.mjs';
import { encode as encodeCapture } from '../../../dist/capture.min.mjs';
import { encode as encodePhoto } from '../../../dist/photo.min.mjs';
import { reconstructJPEG } from '../../../dist/jpeg.min.mjs';

const clients=[];
function client(kind) {
  const encoder=createEncoder({worker:()=>new Worker(`/dist/${kind}-worker.js`,{type:'module'})});
  clients.push(encoder); return encoder;
}
function image(alpha=false) {
  const width=32,height=24,data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<data.length;i+=4){
    data[i]=(i*17)%256; data[i+1]=(i*13+31)%256; data[i+2]=(i*29+101)%256;
    data[i+3]=alpha?(i/4*37)%256:255;
  }
  return new ImageData(data,width,height);
}
function canvasOf(input) {
  const canvas=new OffscreenCanvas(input.width,input.height);
  canvas.getContext('2d',{willReadFrequently:true}).putImageData(input,0,0); return canvas;
}
afterEach(()=>{for(const encoder of clients.splice(0))encoder.close();});

describe('actual bundled workers through the public client',()=>{
  it('capture worker matches direct bytes and preserves borrowed RGBA',async()=>{
    const input=image(true),before=input.data.slice(),encoder=client('capture');
    const bytes=await encoder.encode(input,{gpu:'cpu'});
    expect(bytes).toEqual(await encodeCapture(input,{gpu:'cpu'}));
    expect(input.data).toEqual(before);
    expect(input.data.byteLength).toBe(before.byteLength);
  });

  it('capture canvas handoff matches its readable RGBA, including partial alpha',async()=>{
    const canvas=canvasOf(image(true)),rgba=canvas.getContext('2d').getImageData(0,0,32,24),encoder=client('capture');
    const bytes=await encoder.encode(canvas,{gpu:'cpu'});
    expect(bytes).toEqual(await encoder.encode(rgba,{gpu:'cpu'}));
    expect([canvas.width,canvas.height]).toEqual([32,24]);
  });

  it('photo worker matches the direct quality-90 encoder',async()=>{
    const input=image(),options={quality:90,effort:1,gpu:'cpu'},encoder=client('photo');
    const bytes=await encoder.encode(input,options);
    expect(bytes).toEqual(await encodePhoto(input,options));
    expect([...bytes.subarray(0,2)]).toEqual([0xff,0x0a]);
  });

  it('full worker encodes exact images and carries a JPEG with exact reconstruction',async()=>{
    const input=image(),encoder=client('full');
    const exact=await encoder.encode(input,{quality:100,effort:1,gpu:'cpu'});
    expect([...exact.subarray(0,2)]).toEqual([0xff,0x0a]);
    const jpeg=await canvasOf(input).convertToBlob({type:'image/jpeg',quality:0.9});
    const original=new Uint8Array(await jpeg.arrayBuffer());
    const carried=await encoder.encode(jpeg,{effort:1,gpu:'cpu'});
    expect([...carried.subarray(0,12)]).toEqual([0,0,0,12,74,88,76,32,13,10,135,10]);
    expect(reconstructJPEG(carried)).toEqual(original);
  });
});
