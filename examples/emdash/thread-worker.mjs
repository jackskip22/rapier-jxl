// SPDX-License-Identifier: MIT
// One image job in a worker thread (thread-driver.mjs): the ordinary operation, then verify against the same source.
import {parentPort, workerData} from 'node:worker_threads';
import {encode, fit} from 'rapier-jxl';
import {recompress, restore} from 'rapier-jxl/jpeg';
import {verify, configureDecoder} from 'rapier-jxl/verify';
import {decode} from 'rapier-jxl/decode';

const {name, input, options, bytes} = workerData;
try {
  configureDecoder(decode, restore);
  const operation = {encode, fit, recompress}[name];
  if (!operation) throw Object.assign(new Error('Unknown image operation.'), {code: 'JXL_OPTIONS'});
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const source = () => input.kind === 'pixels' ? {data: bytes.slice(), width: input.width, height: input.height, ...(input.colorSpace && {colorSpace: input.colorSpace})}
    : name === 'recompress' || !png ? bytes.slice() : new Blob([bytes], {type: 'image/png'});
  // Progress for the plug-in's row: the operation's own fractions, then verify's (about a sixth of the time).
  let last = -1;
  const report = (from, span) => fraction => {
    const value = Math.round(100 * (from + span * Math.max(0, Math.min(1, fraction)))) / 100;
    if (value > last) { last = value; parentPort.postMessage({progress: value}); }
  };
  const {bytes: file, ...result} = await operation(source(), {...options, onProgress: report(0, 0.85)});
  const verification = await verify(source(), {...result, bytes: file}, {onProgress: report(0.85, 0.15)});
  const out = new Uint8Array(file);
  parentPort.postMessage({bytes: out, record: {...result, source: verification.source, verification}}, [out.buffer]);
} catch (error) {
  parentPort.postMessage({error: {code: String(error?.code ?? 'JXL_INTERNAL'), message: String(error?.message ?? error),
    ...(error?.verification && {verification: error.verification})}});
}
