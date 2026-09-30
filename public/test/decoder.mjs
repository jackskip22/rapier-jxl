// SPDX-License-Identifier: MIT
// The decoder the tests check against, or none: jxl-oxide-wasm installed beside these tests, or Rapier's own vendored
// copy; a test that needs it says so instead of failing on a missing install. The PNG it renders is read back here.
import {inflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';

export function unpng(png) {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const width = view.getUint32(16), height = view.getUint32(20), colour = png[25];
	const channels = {0: 1, 2: 3, 4: 2, 6: 4}[colour], idat = [];
	for (let at = 8; at + 8 <= png.length;) { const length = view.getUint32(at), tag = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]); if (tag === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length)); at += 12 + length; }
	const raw = inflateSync(Buffer.concat(idat.map(Buffer.from))), stride = width * channels, out = new Uint8Array(height * stride);
	const paeth = (a, b, c) => { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)], line = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
		for (let i = 0; i < stride; i++) { const x = raw[line + i], a = i >= channels ? out[dst + i - channels] : 0, b = y ? out[up + i] : 0, c = y && i >= channels ? out[up + i - channels] : 0; out[dst + i] = (filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 255; }
	}
	return {width, height, channels, data: out};
}

export async function decoder() {
	let script, wasm;
	try { script = fileURLToPath(import.meta.resolve('jxl-oxide-wasm')); wasm = fileURLToPath(import.meta.resolve('jxl-oxide-wasm/module.wasm')); }
	catch {
		const vendored = new URL('../../../../tools/vendor/jxl-oxide/', import.meta.url);
		try { script = fileURLToPath(new URL('jxl_oxide_wasm.js', vendored)); wasm = fileURLToPath(new URL('jxl_oxide_wasm_bg.wasm', vendored)); await readFile(script); } catch { return null; }
	}
	// The bindings are loaded from their text so the WebAssembly is handed over as bytes, never fetched.
	const source = (await readFile(script, 'utf8')).replaceAll('import.meta.url', "'file:jxl'");
	const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
	await mod.default({module_or_path: await readFile(wasm)});
	const decode = bytes => { const image = new mod.JxlImage(); try { image.forceSrgb = true; image.feedBytes(bytes); image.tryInit(); return unpng(image.render(0).encodeToPng()); } finally { image.free(); } };
	decode.version = mod.version();
	return decode;
}
