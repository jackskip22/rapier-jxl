// SPDX-License-Identifier: MIT
// Optional libjxl CLI oracle. NPY retains source colour values and associated alpha as little-endian float32.
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const execute = promisify(execFile), MAX_BYTES = 16777216;

async function boundedRead(path, maximum) {
  if ((await stat(path)).size > maximum) throw new Error('djxl output exceeds its admitted size');
  return readFile(path);
}

function numpy(bytes, width, height) {
  if (bytes.length < 10 || !bytes.subarray(0, 8).equals(Buffer.from([147, 78, 85, 77, 80, 89, 1, 0])))
    throw new Error('djxl did not return NPY version 1');
  const start = 10 + bytes.readUInt16LE(8), header = bytes.subarray(10, start).toString('ascii');
  const shape = header.match(/'shape'\s*:\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (!/'descr'\s*:\s*'<f4'/.test(header) || !/'fortran_order'\s*:\s*False/.test(header) || !shape)
    throw new Error('djxl NPY must contain interleaved little-endian float32 samples');
  const [frames, h, w, channels] = shape.slice(1).map(Number);
  if (frames !== 1 || w !== width || h !== height || channels < 1 || channels > 4 ||
      bytes.length - start !== width * height * channels * 4)
    throw new Error('djxl returned different dimensions or incomplete samples');
  const data = new Float32Array(Uint8Array.from(bytes.subarray(start)).buffer);
  return {data, width: w, height: h, channels};
}

function colorInformation(icc) {
  if (icc.length < 132 || icc.readUInt32BE(0) !== icc.length) throw new Error('djxl returned an incomplete ICC profile');
  const count = icc.readUInt32BE(128);
  if (count > (icc.length - 132) / 12) throw new Error('djxl ICC tag table exceeds the profile');
  for (let i = 0; i < count; i++) {
    const at = 132 + 12 * i, offset = icc.readUInt32BE(at + 4), length = icc.readUInt32BE(at + 8);
    if (offset > icc.length || length > icc.length - offset) throw new Error('djxl ICC tag exceeds the profile');
    if (icc.toString('ascii', at, at + 4) !== 'cicp') continue;
    if (length !== 12 || icc.toString('ascii', offset, offset + 4) !== 'cicp') throw new Error('djxl ICC cICP tag is invalid');
    return {primaries: icc[offset + 8], transferFunction: icc[offset + 9], matrixCoefficients: icc[offset + 10], fullRange: icc[offset + 11]};
  }
  return null;
}

export async function djxlDecoder({executable = process.env.JXL_DJXL, timeout = 30000} = {}) {
  if (!executable) return null;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('djxl timeout must be a positive integer');
  const options = {encoding: 'utf8', timeout, maxBuffer: 8192, killSignal: 'SIGKILL'};
  const identity = await execute(executable, ['--version'], options), description = (identity.stdout + identity.stderr).trim();
  const version = description.match(/^djxl v(\d+\.\d+\.\d+)\b/)?.[1];
  if (version !== '0.12.0') throw new Error('djxl oracle requires libjxl 0.12.0: ' + description);
  const temporary = await mkdtemp(join(tmpdir(), 'jxl-djxl-'));
  const input = join(temporary, 'input.jxl'), output = join(temporary, 'output.npy');
  const metadataPath = join(temporary, 'metadata.json'), iccPath = join(temporary, 'original.icc');
  let chain = Promise.resolve(), closing, decodes = 0;
  return {
    version, description, executable,
    get decodes() { return decodes; },
    decode(bytes, width, height) {
      if (closing) return Promise.reject(new Error('djxl oracle is closing'));
      const run = async () => {
        if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES ||
            !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
            width > 16384 || height > 16384 || width * height > 24000000)
          throw new Error('djxl input exceeds the admitted image bounds');
        await writeFile(input, bytes);
        await execute(executable, [input, output, '--output_format=npy', '--bits_per_sample=0', '--num_threads=0',
          '--metadata_out=' + metadataPath, '--orig_icc_out=' + iccPath, '--quiet'], options);
        const [pixels, metadataBytes, icc] = await Promise.all([
          boundedRead(output, width * height * 16 + 10 + 65535), boundedRead(metadataPath, MAX_BYTES), boundedRead(iccPath, MAX_BYTES),
        ]);
        // --bits_per_sample=0 preserves the coded depths in metadata. Integer samples remain normalized floats:
        // Math.round(value * (2 ** bitDepth - 1)) recovers their code values. The CLI does not expose alpha association.
        const answer = {...numpy(pixels, width, height), metadata: JSON.parse(metadataBytes.toString()), icc, cicp: colorInformation(icc)};
        decodes++;
        return answer;
      };
      const result = chain.then(run); chain = result.catch(() => {}); return result;
    },
    close() { return closing ||= chain.then(() => rm(temporary, {recursive: true, force: true})); },
  };
}
