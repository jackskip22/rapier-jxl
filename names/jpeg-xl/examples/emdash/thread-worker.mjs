// SPDX-License-Identifier: MIT
// One image job in a worker thread: an ordinary operation and its verification, or a stored candidate's verification.
import {parentPort, workerData} from 'node:worker_threads';
import {encode, fit} from 'jpeg-xl';
import {recompress, restore} from 'jpeg-xl/jpeg';
import {verify, configureDecoder} from 'jpeg-xl/verify';
import {decode} from 'jpeg-xl/decode';
import {header} from 'jpeg-xl/metadata';

const {name, input, options, bytes, candidate} = workerData;
try {
  configureDecoder(decode, restore);
  const operation = {encode, fit, recompress}[name];
  if (!operation && name !== 'verify') throw Object.assign(new Error('Unknown image operation.'), {code: 'JXL_OPTIONS'});
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const source = () => input.kind === 'pixels' ? {data: bytes.slice(), width: input.width, height: input.height, ...(input.colorSpace && {colorSpace: input.colorSpace})}
    : name === 'recompress' || name === 'verify' || !png ? bytes.slice() : new Blob([bytes], {type: 'image/png'});
  // Progress for the plug-in's row: the operation's own fractions, then verify's (about a sixth of the time).
  let last = -1;
  const report = (from, span) => fraction => {
    const value = Math.round(100 * (from + span * Math.max(0, Math.min(1, fraction)))) / 100;
    if (value > last) { last = value; parentPort.postMessage({progress: value}); }
  };
  if (name === 'verify') {
    // Node's measured photo-verification admission does not cover animated sources or outputs.
    // Classify the authenticated source bytes; the public readers still own every size and format check.
    const photo = bytes[0] === 255 && bytes[1] === 216 ||
      [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
    if (!photo) throw Object.assign(new Error('Thread verification requires a JPEG or PNG original.'), {code: 'JXL_UNSUPPORTED'});
    if (options.result.format !== 'jxl' || header(candidate).animation)
      throw Object.assign(new Error('Thread verification requires a still JPEG XL candidate.'), {code: 'JXL_UNSUPPORTED'});
    const receipt = await verify(source(), {...options.result, bytes: candidate},
      {maxPixels: options.maxPixels, onProgress: report(0, 1)});
    parentPort.postMessage({receipt});
  } else {
    const {bytes: file, ...result} = await operation(source(), {...options, onProgress: report(0, 0.85)});
    const verification = await verify(source(), {...result, bytes: file}, {onProgress: report(0.85, 0.15)});
    const out = new Uint8Array(file);
    parentPort.postMessage({bytes: out, record: {...result, source: verification.source, verification}}, [out.buffer]);
  }
} catch (error) {
  parentPort.postMessage({error: {code: String(error?.code ?? 'JXL_INTERNAL'), message: String(error?.message ?? error),
    ...(error?.verification && {verification: error.verification})}});
}
