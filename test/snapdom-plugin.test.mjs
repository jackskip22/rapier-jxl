import test from 'node:test';
import assert from 'node:assert/strict';
import { jxlExport } from '../examples/snapdom/jxl-export.mjs';

function setup(encode = async () => Uint8Array.of(0xff, 0x0a, 1)) {
  const calls = [];
  const canvas = { width: 40, height: 20 };
  const encoder = { encode: async (source, options) => {
    calls.push({ source, options });
    return encode(source, options);
  } };
  const plugin = jxlExport({ encoder, maxError: 2 });
  const facade = { canvas: async options => {
    calls.push({ canvasOptions: options });
    return canvas;
  } };
  return { run: plugin.defineExports({ exports: facade }).jxl, canvas, calls, plugin };
}

test('snapdom adapter adds only the export hook and requires an encoder', () => {
  assert.throws(() => jxlExport(), /requires an encoder/);
  assert.deepEqual(Object.keys(setup().plugin), ['name', 'defineExports']);
});

test('uses the captured canvas facade and returns JXL Blob bytes', async () => {
  const { run, calls, canvas } = setup();
  const options = { scale: 2, width: 80, backgroundColor: 'transparent' };
  const blob = await run({}, options);
  assert.equal(calls[0].canvasOptions, options);
  assert.equal(calls[1].source, canvas);
  assert.equal(calls[1].options.maxError, 2);
  assert.equal(blob.type, 'image/jxl');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), Uint8Array.of(0xff, 0x0a, 1));
});

test('explicit zero overrides near-lossless default; cancellation and progress pass through', async () => {
  const { run, calls } = setup();
  const { signal } = new AbortController();
  const onProgress = () => {};
  await run({}, { maxError: 0, gpu: 'cpu', signal, onProgress });
  assert.deepEqual(calls[1].options, { maxError: 0, gpu: 'cpu', signal, onProgress });
});

test('an already-aborted export never renders or encodes', async () => {
  const { run, calls } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run({}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});

test('encoder failure propagates, and the next export can succeed', async () => {
  const failure = new Error('encode failed');
  let fail = true;
  const { run } = setup(async () => {
    if (fail) throw failure;
    return Uint8Array.of(0xff, 0x0a);
  });
  await assert.rejects(run({}, {}), error => error === failure);
  fail = false;
  assert.equal((await run({}, {})).type, 'image/jxl');
});

test('canvas failure propagates before the encoder is called', async () => {
  let encoded = false;
  const plugin = jxlExport({ encoder: { encode: async () => { encoded = true; } } });
  const failure = new Error('canvas tainted');
  const { jxl } = plugin.defineExports({ exports: { canvas: async () => { throw failure; } } });
  await assert.rejects(jxl({}, {}), error => error === failure);
  assert.equal(encoded, false);
});
