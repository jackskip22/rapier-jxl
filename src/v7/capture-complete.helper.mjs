// SPDX-License-Identifier: MIT
import {captureGroupBytes, compileCaptureKernels} from '../capture-codec.mjs';
import {regionFrameBytes} from '../capture-photo.mjs';
import {photoKernels} from '../capture-kernels.mjs';
import '../kernels.mjs';
import {CAPTURE_TOOLS_COMPLETE} from '../capture-ans.mjs';
import {configureModules} from '../wasm-modules.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';

const nodePort = () => { try { return globalThis.process?.getBuiltinModule?.('node:worker_threads')?.parentPort; } catch { return undefined; } };
const port = nodePort() ?? globalThis;
const post = (message, transfer = []) => port.postMessage(message, transfer);
let ready = null;
const serve = data => {
  if (data?.groupsInit) {
    ready = (async () => {
      if (data.wasmModules) configureModules(data.wasmModules);
      if (!await compileCaptureKernels()) throw new Error('The capture kernels did not compile in this helper.');
    })();
    ready.then(() => post({ready: true, module: 'rapier-jxl/capture-complete', protocol: WORKER_PROTOCOL}), () => post({ready: true, refused: true}));
    return;
  }
  const region = data?.region;
  if (region && ready) {
    ready.then(async () => {
      let bytes;
      try {
        const kernels = photoKernels();
        if (!await kernels.prepare() || kernels.ready() !== 'simd') throw new Error('The photo kernels did not compile in this helper.');
        bytes = regionFrameBytes(region);
      }
      catch (error) { post({ticket: region.ticket, error: String(error?.message ?? error)}); return; }
      post({ticket: region.ticket, bytes}, [bytes.buffer]);
    }, () => {});
    return;
  }
  const request = data?.groups;
  if (!request || !ready) return;
  ready.then(() => {
    const {ticket, pixels, width, height, level, shape} = request;
    let bytes;
    try { bytes = captureGroupBytes(pixels, width, {x: 0, y: 0, width, height}, level, shape, CAPTURE_TOOLS_COMPLETE); }
    catch (error) { post({ticket, error: String(error?.message ?? error)}); return; }
    post({ticket, bytes}, [bytes.buffer]);
  }, () => {});
};
if (port.on) port.on('message', serve); else port.onmessage = event => serve(event.data);
