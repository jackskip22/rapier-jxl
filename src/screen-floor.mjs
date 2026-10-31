// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
export async function captureAnswer({data, width, height, colorSpace}) {
  const {encodeCaptureBytes, compileCaptureKernels} = await import('./capture-codec.mjs');
  await compileCaptureKernels();
  return encodeCaptureBytes(data, width, height, {colorSpace});
}

export async function screenPhotoAnswer(request) {
  const {screenPhotoSteps, compileCaptureKernels} = await import('./screen-photo-mixed.mjs');
  await compileCaptureKernels();
  try { return complete(screenPhotoSteps(request)); }
  catch (error) { if (typeof error?.code !== 'string' || !error.code.startsWith('JXL_') || error.code === 'JXL_ABORTED') throw error; return null; }
}
