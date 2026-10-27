import { describe, it, expect } from 'vitest';
import { optionalDevice, quantizeCaptureGPU } from '../../../src/capture-gpu.mjs';
import { quantizeCapture } from '../../../src/capture-codec.mjs';

describe('optional WebGPU capture quantization', () => {
  it('returns CPU fallback without allocating beyond the device budget', async () => {
    const result = await quantizeCaptureGPU(new Uint8Array(16), 1, { limits:{maxStorageBufferBindingSize:8,maxBufferSize:8} });
    expect(result).toBe(null);
  });

  it('runs WGSL and matches CPU samples, alpha and hidden RGB', async test => {
    const device = await optionalDevice();
    if (!device) { test.skip('No WebGPU adapter; run with WEBGPU_SOFTWARE=1 for SwiftShader correctness'); return; }
    // Offset view catches accidental use of the whole backing ArrayBuffer.
    const buffer = new Uint8Array(4099), data=buffer.subarray(3);
    for(let i=0;i<data.length;i++) data[i]=(i*53+17)%256;
    for(let i=0;i<data.length;i+=16) data[i+3]=0;
    const original=data.slice();
    for(const maxError of [1,2,8]) {
      const actual=await quantizeCaptureGPU(data,maxError,device);
      expect(actual).toBeInstanceOf(Uint8Array);
      expect(actual).toEqual(quantizeCapture(data,maxError));
      for(let i=0;i<data.length;i++) {
        if((i&3)===3 || data[(i&~3)+3]===0) expect(actual[i]).toBe(data[i]);
        else expect(Math.abs(actual[i]-data[i])).toBeLessThanOrEqual(maxError);
      }
    }
    expect(data).toEqual(original);
  });
});
