// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BitWriter} from '../src/bits.mjs';
import {writeImageHeader, writeModularFrameHeader, assembleCodestream} from '../src/frame.mjs';
import {ALPHABET, leaf, split, writeTree, writeChannelHistograms, writeModularHeader, codeChannel} from '../src/modular.mjs';
import {decoder} from './decoder.mjs';

const decode = await decoder(), skip = decode ? undefined : 'jxl-oxide-wasm is not installed';

test('context maps decode literal histogram IDs across the LZ77 boundary', {skip}, () => {
  for (const width of [223, 224, 255]) {
    const header = new BitWriter(), global = new BitWriter();
    const pixels = Uint8Array.from({length: width}, (_, x) => (x * 73 + 19) & 255);
    const leaves = Array.from({length: width}, (_, histogram) => ({...leaf(0), histogram}));
    const planes = Array.from(pixels, value => Int16Array.of(value));
    const frequencies = leaves.map((item, x) => {
      const counts = new Uint32Array(ALPHABET);
      codeChannel(null, counts, planes[x], 1, 1, item);
      return counts;
    });
    // One x-coordinate leaf per pixel makes every histogram ID, including the largest, decode image data.
    const tree = (lo, hi) => {
      if (lo === hi) return leaves[lo];
      const mid = (lo + hi) >>> 1;
      return split(3, mid, tree(mid + 1, hi), tree(lo, mid));
    };
    writeImageHeader(header, width, 1, 1, false);
    writeModularFrameHeader(header, {alpha: false});
    global.write(1, 1); global.write(1, 1);
    const ordered = writeTree(global, tree(0, width - 1));
    const histograms = writeChannelHistograms(global, ordered, frequencies, item => item.histogram);
    writeModularHeader(global);
    for (let x = 0; x < width; x++) codeChannel(global, histograms[x + 1].code, planes[x], 1, 1, leaves[x]);
    const image = decode(assembleCodestream(header, [global.finish()]));
    assert.equal(image.width, width); assert.equal(image.height, 1); assert.equal(image.channels, 1);
    assert.deepEqual(image.data, pixels, `literal histogram IDs through ${width}`);
  }
});
