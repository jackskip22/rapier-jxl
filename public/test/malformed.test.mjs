// SPDX-License-Identifier: MIT
// What the module refuses, and what it keeps exact, on inputs that are not the happy path: a header naming a picture
// past the limits costs no allocation; a JPEG cut short, with a scan out of order or a colour profile that is neither
// sRGB nor Display P3 by what it does, is refused with JXL_JPEG, never answered with invented pixels; an RGB JPEG's flat field comes back at its own
// level for every DC step; the options are read before any work. Run: node --test "public/test/*.test.mjs".
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {encode, LIMITS} from '../../index.mjs';
import {encode as encodeEffort} from '../../effort.mjs';
import {transcode} from '../../jpeg.mjs';
import {writeJPEG} from './jpeg-writer.mjs';
import {iccProfile, displayProfile, descriptionTag, withProfile} from './icc.mjs';
import {decoder} from './decoder.mjs';
import {BitWriter} from '../../bits.mjs';
import {assembleCodestream} from '../../frame.mjs';

const decode = await decoder();
const needs = decode ? undefined : 'jxl-oxide-wasm is not installed (npm install)';
let seed = 11; const random = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

// A component of a test JPEG: its quantisation table (a flat step) and coefficients, textured or flat.
function component(h, v, width, height, hmax, vmax, step, dc) {
	const blocksW = Math.ceil(Math.ceil(width * h / hmax) / 8), blocksH = Math.ceil(Math.ceil(height * v / vmax) / 8);
	const stride = Math.ceil(width / (8 * hmax)) * h, rows = Math.ceil(height / (8 * vmax)) * v;
	const coeffs = new Int16Array(stride * rows * 64), quant = new Int32Array(64).fill(step);
	for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
		const at = (by * stride + bx) * 64;
		if (dc !== undefined) { coeffs[at] = dc; continue; }
		coeffs[at] = Math.round(200 * Math.sin(bx / 3) * Math.cos(by / 5));
		for (let k = 1; k < 64; k++) if (random() < 0.5 / (1 + k / 6)) coeffs[at + k] = Math.round((random() - 0.5) * 80 / (1 + k / 4)) || 1;
	}
	return {h, v, quant, blocksW, blocksH, stride, rows, coeffs};
}
const colour = (width, height, {progressive = false, restartInterval = 0, sampling = [[2, 2], [1, 1], [1, 1]]} = {}) =>
	writeJPEG({width, height, components: sampling.map(([h, v], i) => component(h, v, width, height, 2, 2, i ? 12 : 8)), progressive, restartInterval});
// Component ids R, G, B and no JFIF marker: an RGB JPEG, as libjxl reads one.
function rgbJPEG(width, height, step, dc) {
	const jpeg = Uint8Array.from(writeJPEG({width, height, components: [0, 1, 2].map(() => component(1, 1, width, height, 1, 1, step, dc)), jfif: false}));
	const ids = [0x52, 0x47, 0x42];
	for (let at = 2; at + 1 < jpeg.length;) {
		if (jpeg[at] !== 0xFF) throw new Error('marker expected');
		const marker = jpeg[at + 1], length = (jpeg[at + 2] << 8) | jpeg[at + 3];
		if (marker === 0xC0) for (let i = 0; i < 3; i++) jpeg[at + 4 + 6 + i * 3] = ids[i];
		if (marker === 0xDA) { const n = jpeg[at + 4]; for (let i = 0; i < n; i++) jpeg[at + 5 + i * 2] = ids[jpeg[at + 5 + i * 2] - 1]; break; }
		at += 2 + length;
	}
	return jpeg;
}
const sosDataStart = jpeg => { for (let at = 2; at + 3 < jpeg.length; at += 2 + ((jpeg[at + 2] << 8) | jpeg[at + 3])) if (jpeg[at + 1] === 0xDA) return at + 2 + ((jpeg[at + 2] << 8) | jpeg[at + 3]); throw new Error('no scan'); };

test('a header past the limits is refused before any plane is allocated', () => {
	const Original = globalThis.Int16Array, asked = [];
	globalThis.Int16Array = new Proxy(Original, {construct(target, args) { asked.push(args[0]); if (args[0] > 1_000_000) throw new RangeError('the test refuses an oversized allocation'); return Reflect.construct(target, args); }});
	try {
		assert.throws(() => transcode(Uint8Array.from([255, 216, 255, 192, 0, 11, 8, 255, 255, 255, 255, 1, 1, 17, 0, 255, 217])), {code: 'JXL_DIMENSIONS'});
		const wide = LIMITS.edge + 1;
		assert.throws(() => transcode(Uint8Array.from([255, 216, 255, 192, 0, 11, 8, 0, 8, wide >> 8, wide & 255, 1, 1, 17, 0, 255, 217])), {code: 'JXL_DIMENSIONS'});
		// The carrier's own limit, 64 million pixels: 8,000 x 8,001 is past it.
		assert.throws(() => transcode(Uint8Array.from([255, 216, 255, 192, 0, 11, 8, 8001 >> 8, 8001 & 255, 8000 >> 8, 8000 & 255, 1, 1, 17, 0, 255, 217])), {code: 'JXL_DIMENSIONS'});
	} finally { globalThis.Int16Array = Original; }
	assert.deepEqual(asked, [], 'a coefficient plane was allocated for a picture the module refuses');
});

test('a phone\'s 24 megapixel JPEG, 5,712 x 4,284, is carried whole', () => {
	const jpeg = writeJPEG({width: 5712, height: 4284, components: [component(1, 1, 5712, 4284, 1, 1, 8, 0)]});
	const carried = transcode(jpeg);
	assert.deepEqual([carried.width, carried.height], [5712, 4284]);
});

test('a JPEG cut short, or with bytes out of place, is refused rather than answered with invented pixels', () => {
	for (const progressive of [false, true]) {
		const jpeg = colour(48, 40, {progressive}), start = sosDataStart(jpeg);
		for (const cut of [start, start + 1, start + 9, Math.floor(jpeg.length * 0.5), Math.floor(jpeg.length * 0.9)])
			assert.throws(() => transcode(jpeg.subarray(0, cut)), {code: 'JXL_JPEG'}, `a ${progressive ? 'progressive' : 'baseline'} JPEG cut at ${cut} of ${jpeg.length} was carried`);
		// A missing end-of-image marker alone is tolerated: every scan is whole.
		assert.equal(transcode(jpeg.subarray(0, jpeg.length - 2)).bytes.length, transcode(jpeg).bytes.length);
	}
	const jpeg = colour(48, 40, {restartInterval: 2}), markers = [];
	for (let at = sosDataStart(jpeg); at + 1 < jpeg.length; at++) if (jpeg[at] === 0xFF && jpeg[at + 1] >= 0xD0 && jpeg[at + 1] <= 0xD7) markers.push(at + 1);
	assert.ok(markers.length >= 2);
	const swapped = Uint8Array.from(jpeg); [swapped[markers[0]], swapped[markers[1]]] = [swapped[markers[1]], swapped[markers[0]]];
	assert.throws(() => transcode(swapped), {code: 'JXL_JPEG'}, 'restart markers out of order were carried');
	// The scan header of a three-component scan: FF DA, its length (2 + 1 + 6 + 3 = 12), then the component count.
	const empty = Uint8Array.from(colour(16, 16)); empty[sosDataStart(empty) - 10] = 0;
	assert.throws(() => transcode(empty), {code: 'JXL_JPEG'}, 'a scan of no components was not a coded refusal');
	const garbage = Uint8Array.from([...jpeg.subarray(0, jpeg.length - 2), 1, 2, 3, 0xFF, 0xD9]);
	assert.throws(() => transcode(garbage), {code: 'JXL_JPEG'}, 'bytes left over after the scan were carried');
});

test('a colour profile is read by what it does: sRGB changes nothing, Display P3 is declared, any other is refused', () => {
	const jpeg = colour(24, 16), plain = transcode(jpeg).bytes;
	for (const profile of [displayProfile(), displayProfile({curve: 'table', description: 'sRGB IEC61966-2.1'})]) assert.deepEqual(transcode(withProfile(jpeg, profile)).bytes, plain);
	const p3 = transcode(withProfile(jpeg, displayProfile({colorants: 'display-p3', description: 'Display P3'}))).bytes;
	assert.notDeepEqual(p3, plain, 'Display P3 is declared in the header');
	if (decode) assert.deepEqual(decode(p3).data, decode(plain).data, 'and no sample changes');
	for (const profile of [displayProfile({colorants: 'adobe-rgb', description: 'sRGB IEC61966-2.1'}), displayProfile({curve: 'gamma', description: 'Display P3'}),
		displayProfile({extra: [['A2B0', [...'mft2'].map(c => c.charCodeAt(0)).concat(new Array(12).fill(0))]]}), iccProfile('RGB ', [['desc', descriptionTag('sRGB IEC61966-2.1')]])])
		assert.throws(() => transcode(withProfile(jpeg, profile)), {code: 'JXL_JPEG'});
	// A monotonic table agrees at the old sampled knots but changes the transfer between them.
	assert.throws(() => transcode(new Uint8Array(readFileSync(new URL('seeds/profile-table-plateau.jpg', import.meta.url)))), {code: 'JXL_JPEG'});
	const grey = writeJPEG({width: 24, height: 16, components: [component(1, 1, 24, 16, 1, 1, 8)]});
	assert.deepEqual(transcode(withProfile(grey, displayProfile({grey: true}))).bytes, transcode(grey).bytes, 'grey on the sRGB curve');
	assert.throws(() => transcode(withProfile(grey, displayProfile({grey: true, curve: 'gamma'}))), {code: 'JXL_JPEG'});
});

test('an RGB JPEG\'s flat field comes back at its own level for every DC step', {skip: needs}, () => {
	for (const [step, dc] of [[40, 14], [25, 8], [3, 24], [1, 400], [16, -20], [40, 0]]) {
		const level = 128 + dc * step / 8;
		const image = decode(transcode(rgbJPEG(16, 16, step, dc)).bytes);
		assert.equal(image.width, 16);
		for (let i = 0; i < 16 * 16; i++) for (let c = 0; c < 3; c++) assert.equal(image.data[i * image.channels + c], level, `step ${step}, DC ${dc}: pixel ${i} channel ${c}`);
	}
});

test('the options are read before any work', () => {
	const pixel = Uint8Array.from([1, 2, 3, 255]);
	for (const quality of [0, 101, Infinity, NaN, '100', null]) assert.throws(() => encode(pixel, 1, 1, {quality}), {code: 'JXL_INPUT'}, `quality ${String(quality)}`);
	assert.throws(() => encode(pixel, 1, 1, null), {code: 'JXL_INPUT'});
	assert.throws(() => encode(pixel, 1, 1, 'lossless'), {code: 'JXL_INPUT'});
	for (const colorSpace of ['rec2100-pq', 'Display P3', 'p3', null, 3]) assert.throws(() => encode(pixel, 1, 1, {colorSpace}), {code: 'JXL_INPUT'}, 'colour space ' + String(colorSpace));
	for (const effort of [0, 10, 2.5, '3', null, NaN]) assert.throws(() => encodeEffort(pixel, 1, 1, {effort}), {code: 'JXL_INPUT'}, 'effort ' + String(effort));
	assert.ok(encode(pixel, 1, 1, {quality: 100}).length > 0);
	assert.ok(encode(pixel, 1, 1, {}).length > 0);
	assert.ok(Object.isFrozen(LIMITS));
	// The core's own limit, 24 million pixels: one row more is refused by size, the limit itself only by its bytes.
	assert.throws(() => encode(pixel, 6000, 4001), {code: 'JXL_DIMENSIONS'});
	assert.throws(() => encode(pixel, 6000, 4000), {code: 'JXL_INPUT'});
});

test('sections that exceed the stream limit are refused before the aggregate allocation', () => {
	const section = new Uint8Array(LIMITS.bytes / 2), header = new BitWriter(256), Original = globalThis.Uint8Array;
	globalThis.Uint8Array = new Proxy(Original, {construct(target, args) {
		if (args[0] > LIMITS.bytes) throw new RangeError('the test refuses an oversized aggregate allocation');
		return Reflect.construct(target, args);
	}});
	try { assert.throws(() => assembleCodestream(header, [section, section]), {code: 'JXL_SIZE'}); }
	finally { globalThis.Uint8Array = Original; }
});
