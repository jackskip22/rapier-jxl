// SPDX-License-Identifier: MIT
// Build-time only: regenerates kernels-bytes.mjs from the kernels-*.wat sources. Needs wabt@1.0.39
// (npm install --no-save wabt@1.0.39, or set WABT_MODULE to its index.js). Run with node; --check compares without writing.
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
// Beside the module directory in the workstation, beside the build script and the source directory in the package.
const here = new URL('./', import.meta.url), flat = existsSync(new URL('jxl/kernels-scalar.wat', here));
const directory = flat ? new URL('jxl/', here) : here;
const specifier = process.env.WABT_MODULE ? pathToFileURL(resolve(process.env.WABT_MODULE)).href : 'wabt';
let factory;
try { ({default: factory} = await import(specifier)); }
catch (cause) { throw new Error('The kernel build needs build-time wabt@1.0.39. Set WABT_MODULE to its index.js when installed outside this tree.', {cause}); }
const wabt = await factory();
let text = '// Generated from kernels-*.wat. MIT. Do not edit.\n';
for (const [name, symbol] of [['scalar','SCALAR'], ['simd','SIMD'], ['probe','SIMD_PROBE']]) {
  const source = new URL(`kernels-${name}.wat`, directory);
  const wat = wabt.parseWat(fileURLToPath(source), await readFile(source, 'utf8'), {simd: true});
  try {
    wat.resolveNames(); wat.validate({simd: true});
    const {buffer} = wat.toBinary({log: false, canonicalize_lebs: true, write_debug_names: false});
    if (!WebAssembly.validate(buffer)) throw new Error(`Invalid ${name} module`);
    text += `export const ${symbol} = ${JSON.stringify(Buffer.from(buffer).toString('base64'))};\n`;
    console.log(`${name}: ${buffer.length} WebAssembly bytes`);
  } finally { wat.destroy(); }
}
const target = new URL(flat ? 'jxl/kernels-bytes.mjs' : '../src/kernels-bytes.mjs', here);
if (process.argv.includes('--check')) {
  if (text !== await readFile(target, 'utf8')) throw new Error('kernels-bytes.mjs differs from the WAT build');
} else await writeFile(target, text);
