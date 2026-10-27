import {encode} from 'rapier-jxl';
import {encode as capture, type CaptureOptions} from 'rapier-jxl/capture';
import {createEncoder, CONTRACT_VERSION, type ImageEncoder} from 'rapier-jxl/image';
import {encode as photo, encodePhoto, encodeToScore} from 'rapier-jxl/photo';
import {createEncoder as createFullEncoder} from 'rapier-jxl/full';
import {encode as core} from 'rapier-jxl/core';

const version: 1 = CONTRACT_VERSION;
const pixels = {width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255])};
const options: CaptureOptions = {maxError: 0, gpu: 'cpu', onProgress: n => n.toFixed(2)};
const bytes: Promise<Uint8Array<ArrayBuffer>> = encode(pixels, options);
capture(pixels, {signal: new AbortController().signal});
capture(new Blob(), {maxError: 1});
capture(new OffscreenCanvas(1, 1));
const encoder: ImageEncoder = createEncoder({worker: () => new Worker('/capture-worker.js'), maxQueue: 2});
encoder.encode(pixels).then(result => new Blob([result], {type: 'image/jxl'}));
encoder.close();
photo(pixels, {quality: 90, effort: 9, gpu: 'cpu'});
photo(pixels, {target: {ssimulacra2: 80}});
encodePhoto(pixels.data, 1, 1);
encodeToScore(pixels.data, 1, 1, {target: {ssimulacra2: 80}});
core(pixels.data, 1, 1, {quality: 100});
createFullEncoder().encode(pixels, {lossless: true});
// @ts-expect-error Capture quality is a bounded error, not a lossy quality slider.
capture(pixels, {quality: 90});
// @ts-expect-error No callback-only or missing worker setup.
createEncoder({});
// @ts-expect-error WebGPU has an explicit policy, not an untransferable device.
encoder.encode(pixels, {gpu: {}});
void bytes; void version;
