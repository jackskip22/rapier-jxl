// SPDX-License-Identifier: MIT
import {runCaptureUsing, prepareCapture, exactCoderWith} from './run-capture.mjs';
import {encodeCapturePhotoBytes, encodeCapturePhotoSteps, capturePhotoBand, capturePhotoBandSteps, capturePhotoRegions, capturePatchedLargeSteps} from '../capture-photo.mjs';
import {compileCaptureKernels, photoKernels} from '../capture-kernels.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {CAPTURE_TOOLS_LEAN} from '../capture-codec.mjs';
import {webpCoding} from './webp-quality.mjs';

async function ready() {
  const kernels = photoKernels(), [capture, photo] = await Promise.all([compileCaptureKernels(), kernels.prepare()]);
  if (!capture || !photo || kernels.ready() !== 'simd') throw wasmRequired();
}
const photoCoder = {ready, whole: encodeCapturePhotoBytes, band: capturePhotoBand, steps: encodeCapturePhotoSteps, bandSteps: capturePhotoBandSteps, regions: capturePhotoRegions, large: capturePatchedLargeSteps};
export const prepareCapturePhoto = () => Promise.all([prepareCapture(), ready()]).then(() => {});

const PHOTO_EFFORTS = 4;
let looking = null;
const effortLook = (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) ? () => looking ??= Promise.all([import('../capture-photo-look.mjs'), import('../ssimulacra2-kernel.mjs')]).then(async ([{lookQuality}, {prepareScorer}]) => {
  if (!await prepareScorer()) throw wasmRequired();
  return lookQuality;
}).catch(error => { looking = null; throw error; }) : null;
export function captureRunner(tools = CAPTURE_TOOLS_LEAN, {device = null, answerer = null} = {}) {
  const exact = {...exactCoderWith(tools), device, answerer}, photo = {...photoCoder, tools, device, answerer, effortCap: PHOTO_EFFORTS};
  return async (input, options, hooks) => {
    const fidelity = options.fidelity;
    if (fidelity?.quality === undefined && fidelity?.webp === undefined) return runCaptureUsing(input, options, hooks, {maxError: fidelity?.maxError ?? 0}, exact);
    if (fidelity.webp === undefined) return runCaptureUsing(input, options, hooks, {quality: fidelity.quality}, photo);
    const look = effortLook && (options.effort ?? 3) >= PHOTO_EFFORTS ? await effortLook() : null;
    return runCaptureUsing(input, options, hooks, {...webpCoding(fidelity.webp), ...(look && {look})}, photo);
  };
}
