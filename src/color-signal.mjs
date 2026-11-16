// SPDX-License-Identifier: MIT
export const signalSpace = ({colorSpace, transferFunction, intensityTarget, alphaPremultiplied}) =>
  [colorSpace, transferFunction, intensityTarget, alphaPremultiplied ? 'p' : ''].join(';');
export const signalFields = text => {
  const [colorSpace, transferFunction, intensityTarget, premultiplied] = text.split(';');
  return {colorSpace, transferFunction, intensityTarget: +intensityTarget, alphaPremultiplied: premultiplied === 'p'};
};
export const exactSignal = samples => samples.bitDepth === 8 && !samples.exponentBits && samples.sampleFormat === 'uint' && !samples.iccSpace &&
  samples.colorData === undefined && samples.colorChannels === undefined;
export const isSignal = text => typeof text === 'string' && /^(srgb|display-p3|rec2020);(srgb|linear|pq|hlg);[0-9.e+-]+;p?$/.test(text) && Number.isFinite(+text.split(';')[2]);
