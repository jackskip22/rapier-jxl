import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { snapdom } from '../vendor/snapdom.mjs';
import { jxlExport } from '../jxl-export.mjs';

describe('jxlExport against SnapDOM 3.4.0', () => {
  let element;
  beforeEach(() => {
    element = document.createElement('div');
    element.style.cssText = 'width:48px;height:32px;background:#35805a;color:white;font:12px Arial';
    element.textContent = 'JXL';
    document.body.appendChild(element);
  });
  afterEach(() => element.remove());

  function encoder() {
    return { encode: vi.fn(async () => Uint8Array.of(0xff, 0x0a, 17)), close: vi.fn() };
  }

  it('adds result.toJxl(), returns a Blob, and runs export hooks once', async () => {
    const engine = encoder();
    const before = vi.fn(), after = vi.fn();
    const result = await snapdom(element, { plugins: [jxlExport({ encoder: engine }), { name:'observer', beforeExport:before, afterExport:after }], dpr:1 });
    const blob = await result.toJxl();
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/jxl');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(Uint8Array.of(0xff, 0x0a, 17));
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(after.mock.calls[0][1]).toMatchObject({ format:'jxl', result:blob });
    expect(engine.close).not.toHaveBeenCalled();
  });

  it('uses the captured image after the live DOM changes; no second capture', async () => {
    const engine = encoder(), beforeSnap = vi.fn();
    const result = await snapdom(element, { plugins: [jxlExport({ encoder:engine }), { name:'count', beforeSnap }], dpr:1 });
    const reference = await result.toCanvas();
    const expected = reference.getContext('2d').getImageData(0,0,48,32).data;
    element.style.background = '#f00'; element.textContent = 'new';
    await result.toJxl();
    const canvas = engine.encode.mock.calls[0][0];
    expect(canvas.getContext('2d').getImageData(0,0,48,32).data).toEqual(expected);
    expect(beforeSnap).toHaveBeenCalledTimes(1);
  });

  it('honours export size, scale, alpha, and beforeExport option changes', async () => {
    const engine = encoder();
    element.style.background = 'transparent';
    const steer = { name:'steer', beforeExport(_ctx,{format,options}) { if(format==='jxl') options.maxError=0; } };
    const result = await snapdom(element, { plugins: [jxlExport({encoder:engine,maxError:2}), steer], dpr:1 });
    await result.toJxl({scale:2});
    let [canvas, options] = engine.encode.mock.calls[0];
    expect([canvas.width,canvas.height]).toEqual([96,64]);
    expect(options.maxError).toBe(0);
    expect(canvas.getContext('2d').getImageData(95,63,1,1).data[3]).toBe(0);
    await result.toJxl({width:144});
    canvas = engine.encode.mock.calls[1][0];
    expect([canvas.width,canvas.height]).toEqual([144,96]);
  });

  it('propagates failure without poisoning later exports or closing the host worker', async () => {
    const engine = encoder(), failed = new Error('encoder unavailable');
    engine.encode.mockRejectedValueOnce(failed);
    const result = await snapdom(element, { plugins:[jxlExport({encoder:engine})], dpr:1 });
    await expect(result.toJxl()).rejects.toThrow('encoder unavailable');
    expect((await result.toJxl()).type).toBe('image/jxl');
    expect(engine.close).not.toHaveBeenCalled();
  });

  it('forwards explicit options and rejects a cancelled request before encoding', async () => {
    const engine = encoder(), controller = new AbortController(), onProgress = vi.fn();
    const result = await snapdom(element, { plugins:[jxlExport({encoder:engine,maxError:2})], dpr:1 });
    await result.toJxl({maxError:0,gpu:'cpu',onProgress,signal:controller.signal});
    expect(engine.encode.mock.calls[0][1]).toEqual({maxError:0,gpu:'cpu',onProgress,signal:controller.signal});
    controller.abort();
    await expect(result.toJxl({signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
    expect(engine.encode).toHaveBeenCalledTimes(1);
  });

  it('encodes a real JXL with the public capture API', async () => {
    const { encode } = await import('../../../src/capture.mjs');
    const result = await snapdom(element, { plugins:[jxlExport({encoder:{encode}})], dpr:1 });
    const blob = await result.toJxl({gpu:'cpu'});
    expect(blob.type).toBe('image/jxl');
    const header = new Uint8Array(await blob.arrayBuffer());
    expect([...header.subarray(0,2)]).toEqual([0xff,0x0a]);
  });

  it('round-trips lossless pixels through the browser JXL decoder', async test => {
    // Independent 1×1 RGB probe produced by cjxl -d 0 -e 1. Unsupported decoding
    // skips only this browser-specific assertion; encoding is tested above.
    const probe = Uint8Array.from(atob('/woAEBAJCAIBAIwCSxibnHGEAziAAzggSsA5BQEAIESACBABIkDk/5F7+h5aZ1dVVVUlSZIQUHd3d3d3////v1VvZmZmBv7fv+e/h8acc661z71JkiQEVFVVVVVV////z72vu7u7G/7fv+e/h8acc661z71JkiQEVFVVVVVV////z72vu7u7G/7fv+e/h8acc661z71JkiQEVFVVVVVV////z72vu7u7+wIhAIiIAQ=='), char => char.charCodeAt(0));
    try { (await createImageBitmap(new Blob([probe],{type:'image/jxl'}))).close(); }
    catch { test.skip('No native JPEG XL decoder in this browser'); return; }
    const { encode } = await import('../../../src/capture.mjs');
    const result = await snapdom(element, { plugins:[jxlExport({encoder:{encode}})], dpr:1 });
    const reference = await result.toCanvas();
    const original = reference.getContext('2d').getImageData(0,0,48,32).data;
    const blob = await result.toJxl({gpu:'cpu'});
    const bitmap = await createImageBitmap(blob);
    expect([bitmap.width,bitmap.height]).toEqual([48,32]);
    const restored = document.createElement('canvas'); restored.width=48; restored.height=32;
    const context = restored.getContext('2d'); context.drawImage(bitmap,0,0); bitmap.close();
    expect(context.getImageData(0,0,48,32).data).toEqual(original);
  });
});
