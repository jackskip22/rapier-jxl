// SPDX-License-Identifier: MIT
import {admitSampleDomain} from './sample-domain.mjs';
import {prepareICC, iccSpace} from './icc-write.mjs';

export function admitSampleFormat(data, options = {}) {
  const samples = admitSampleDomain(data, options);
  if (options.icc !== undefined) {
    const profile = prepareICC(options.icc, {level: options.level, compression: options.iccCompression});
    Object.assign(samples, profile);
    if (samples.bitDepth === 8 && !samples.exponentBits && !samples.alphaPremultiplied &&
        samples.intensityTarget === 255 && profile.level === 5 && options.level !== 10)
      samples.iccSpace = iccSpace(options.icc, {level: 5, compression: options.iccCompression}, profile);
  }
  return samples;
}
