// SPDX-License-Identifier: MIT
// Compile this consumer through the package exports, including each standalone entry.
import {encode, encodeSteps, type Bytes, type ColorSpace, type EncoderError, type Job} from 'rapier-jxl';
import {encode as core} from 'rapier-jxl/core';
import {encode as coreMin} from 'rapier-jxl/core/min';
import {encode as min} from 'rapier-jxl/min';
import {encode as effort, type EffortOptions} from 'rapier-jxl/effort';
import {encode as effortMin} from 'rapier-jxl/effort/min';
import {encode as wasm, configureKernels, type KernelMode, type KernelParts} from 'rapier-jxl/wasm';
import {encode as wasmMin} from 'rapier-jxl/wasm/min';
import {kernelMode} from 'rapier-jxl/kernels';
import {transcode, transcodeSteps, type Transcoded, type TranscodeJob} from 'rapier-jxl/jpeg';
import {transcode as jpegMin} from 'rapier-jxl/jpeg/min';
import {transcode as jpegANS} from 'rapier-jxl/jpeg-ans';
import {transcode as jpegANSMin} from 'rapier-jxl/jpeg-ans/min';
import {encodePhoto, encodePhotoSteps, type PhotoOptions} from 'rapier-jxl/photo';
import {encodePhoto as photoMin} from 'rapier-jxl/photo/min';
import {encodePhoto as photoANS} from 'rapier-jxl/photo-ans';
import {encodePhoto as photoANSMin} from 'rapier-jxl/photo-ans/min';
import * as writer from 'rapier-jxl/writer';
import {readSource, type SourceImage} from 'rapier-jxl/source';
import {withMetadata, type MetadataOptions} from 'rapier-jxl/metadata';
import {withMetadata as metadataMin} from 'rapier-jxl/metadata/min';
import {createEncoder, installWorker, type Request, type Response, type Options as RapierOptions} from 'rapier-jxl/rapier';
import {createEncoder as completeMin} from 'rapier-jxl/rapier/min';

const pixels = new Uint8ClampedArray([12, 34, 56, 78]);
const completeOptions: RapierOptions = {lossless: true, effort: 9, colorSpace: 'display-p3', photo: false};
for (const encoder of [createEncoder(), completeMin()]) {
  encoder.encode({data: pixels, width: 1, height: 1}, completeOptions).then(bytes => new Blob([bytes]));
  encoder.transcode({bytes: new Uint8Array()}).then(result => new Blob([result.bytes]));
}
const request: Request = {id: 'picture', operation: 'encode', data: pixels, width: 1, height: 1, options: completeOptions};
function receive(reply: Response) { return reply.ok ? new Blob([reply.bytes]) : reply.error.code; }
const bootstrap: typeof installWorker = installWorker;
const space: ColorSpace = 'display-p3';
const encoded: Bytes = encode(pixels, 1, 1, {quality: 100, colorSpace: space});
new Blob([encoded], {type: 'image/jxl'});
const metadata: MetadataOptions = {xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'};
new Blob([withMetadata(encoded, metadata), metadataMin(encoded, metadata)], {type: 'image/jxl'});
const owned: ArrayBuffer = encoded.buffer;
const stepped: Job = encodeSteps(pixels, 1, 1);
for (const fraction of stepped) {
  const progress: number = fraction;
  stepped.hurry = progress > 0.5;
}
if (stepped.bytes) new Blob([stepped.bytes]);
for (const entry of [core, min, coreMin]) new Blob([entry(pixels, 1, 1)]);
const effortOptions: EffortOptions = {effort: 6, treeLearning: 'sampled', quality: 100};
for (const entry of [effort, effortMin, wasm, wasmMin]) new Blob([entry(pixels, 1, 1, effortOptions)]);
const parts: KernelParts = {channel: true, weighted: true};
const selected: KernelMode = configureKernels('auto', parts);
const active: KernelMode = kernelMode();
const wide = new Uint16Array([1, 1023, 2, 1023]);
for (const entry of [encode, coreMin, effort, wasm]) new Blob([entry(wide, 1, 1, {bitDepth: 10, colorSpace: 'rec2020', transferFunction: 'pq', intensityTarget: 10000})]);
new Blob([encode(new Float32Array([0.5, -0.125, 7, 1]), 1, 1, {transferFunction: 'linear', alphaPremultiplied: true})]);
new Blob([encode(new Uint16Array([0x3c00, 0x4000, 0x3800, 0x3c00]), 1, 1, {sampleFormat: 'float16'})]);
async function sourceFile(bytes: Uint8Array) {
  const source: SourceImage = await readSource(bytes);
  const {data, width, height, ...options} = source;
  return new Blob([encode(data, width, height, options)], {type: 'image/jxl'});
}

const jpeg = new Uint8Array();
for (const entry of [transcode, jpegMin, jpegANS, jpegANSMin]) {
  const carried: Transcoded = entry(jpeg, {effort: 4});
  new Blob([carried.bytes]);
  const orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = carried.orientation;
}
const carryJob: TranscodeJob = transcodeSteps(jpeg);
const pendingWidth: number | undefined = carryJob.width;
const pendingOrientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | undefined = carryJob.orientation;
const photoOptions: PhotoOptions = {quality: 90, effort: 4, colorSpace: space};
for (const entry of [encodePhoto, photoMin, photoANS, photoANSMin]) new Blob([entry(pixels, 1, 1, photoOptions)]);
const photoJob: Job = encodePhotoSteps(pixels, 1, 1, photoOptions);
// An option the runtime treats as absent may be undefined, and a cancelled job returns no bytes.
declare const maybeQuality: number | undefined;
new Blob([effort(pixels, 1, 1, {quality: maybeQuality, effort: maybeQuality, treeLearning: undefined})]);
new Blob([encodePhoto(pixels, 1, 1, {effort: maybeQuality})]);
new Blob([transcode(jpeg, {effort: maybeQuality}).bytes]);
configureKernels('auto', {channel: undefined, weighted: true});
const cancelled = photoJob.return();
if (cancelled.done) { const nothing: Bytes | undefined = cancelled.value; }

// @ts-expect-error The core does not read an effort option.
encode(pixels, 1, 1, {effort: 6});
// @ts-expect-error The photographic search does not read treeLearning.
encodePhoto(pixels, 1, 1, {treeLearning: 'sampled'});
// @ts-expect-error JPEG input is byte-oriented, not canvas RGBA.
transcode(pixels);
// @ts-expect-error The high-level job yields progress, not encoded chunks.
const chunk: Uint8Array = stepped.next().value;

const bit = new writer.BitWriter(256);
bit.write(1, 1);
bit.writeU32([[0, 0], [0, 1], [4, 2], [8, 18]], 2);
bit.zeroPadToByte();
bit.append(new writer.BitWriter());
bit.grow(16);
new Blob([bit.finish()]);
const lengths: Uint8Array = writer.codeLengths(new Uint32Array([1, 2]), 15);
const canonical: Uint16Array = writer.canonicalCodes(lengths);
const code = writer.buildCode(new Uint32Array([1, 2]));
writer.writePrefixCode(bit, code);
const config = writer.uintConfig(4, 1, 1);
writer.writeUintConfig(bit, config);
const slots = [0, 0, 0];
writer.hybridToken(config, 7, slots);
const counts = new Uint32Array(writer.ALPHABET);
writer.countToken(config, 7, counts);
writer.writeHybrid(bit, code, config, 1);
writer.writeContextMap(bit, [0, 1]);
writer.writeHistograms(bit, {contextMap: [0], histograms: [{config, code}], lz77: writer.LZ77});
writer.writeImageHeader(bit, 1, 1, 3, true, {colorSpace: space, orientation: 1});
writer.writeImageHeader(bit, 1, 1, 3, true, {bitDepth: 32, exponentBits: 8, transferFunction: 'linear', alphaPremultiplied: true});
writer.writeModularFrameHeader(bit, {alpha: true});
writer.writeFrameHeaderEnd(bit, true);
writer.writeTOC(bit, [10]);
const layout = writer.groupLayout(1, 1, writer.GROUP_DIM);
const dc: number = writer.DC_GROUP_DIM;
const sections: Bytes[] = writer.finishSections([bit, null]);
new Blob([writer.assembleCodestream(bit, sections)]);

const leaf = writer.leaf(writer.PREDICTOR.gradient);
leaf.config = writer.RESIDUAL_CONFIG;
const tree = writer.split(0, 0, leaf, writer.channelTree([writer.leaf(writer.PREDICTOR.zero)]));
const ordered = writer.writeTree(bit, writer.streamTree([{streamId: 0, tree}]));
writer.writeTransform(bit, {type: 'palette', beginC: 0, numC: 4, nbColors: 2});
writer.writeModularHeader(bit, {transforms: [{type: 'rct', beginC: 0}]});
writer.writeChannelHistograms(bit, ordered, [counts]);
const plane = new Int16Array([1]);
writer.codeChannel(null, counts, plane, 1, 1, leaf, true);
writer.codeChannel(bit, code, plane, 1, 1, leaf);
writer.codeWeighted(null, [counts], plane, 1, 1);
writer.codeWeighted(bit, [code], plane, 1, 1, 0, new Int32Array(34));
const weightedPredictor: 6 = writer.WEIGHTED_PREDICTOR;
const weightedProperty: 15 = writer.WEIGHTED_PROPERTY;
const cuts: number[] = writer.WEIGHTED_CUTS;
const channels = [{data: plane, w: 1, h: 1, hshift: 0, vshift: 0, component: 0}];
const squeezed = writer.forwardSqueeze(channels, writer.defaultSqueezeParams(channels));
const level: number = squeezed[0].level;
const shape = writer.inspectPixels(pixels, 1, 1);
new Blob([writer.encodeLossless(pixels, 1, 1, {shape, colorSpace: space})]);
new Blob([writer.encodeLossless(wide, 1, 1, {bitDepth: 10, shape: writer.inspectPixels(wide, 1, 1, {bitDepth: 10})})]);
new Blob([writer.complete(writer.losslessSteps(pixels, 1, 1))]);
new Blob([writer.encodeLossy(pixels, 1, 1, {quality: 90})]);
new Blob([writer.complete(writer.lossySteps(pixels, 1, 1))]);
const distance: number = writer.distanceFromQuality(90);
const quantiser: number = writer.quantiserFor(0, 1, 1, distance);
const tokenCounts = new writer.TokenCounts(2);
tokenCounts.add(0, 2);
tokenCounts.tokens([0], config);
tokenCounts.cost([0], config);
const coding = writer.buildTokenCoding(tokenCounts);
coding.write(bit, 0, 2);
const parsed = writer.parseJPEG(jpeg);
new Blob([writer.encodeVarDCT(parsed)]);
new Blob([writer.complete(writer.varDCTSteps(parsed))]);
new Blob([writer.transcodeJPEG(jpeg)]);
const profileSpace: ColorSpace | null = writer.profileSpace(jpeg);
const zigzag: number[] = writer.ZIGZAG;
const error: EncoderError = writer.fault('JXL_INPUT', 'Invalid pixels.');
const options = writer.admitOptions({quality: 90, colorSpace: space});
writer.admitSize(1, 1, writer.PHOTO_LIMITS);
writer.admitPixels(pixels, 1, 1, writer.JPEG_LIMITS);
new Blob([writer.answer(encoded)]);
const guarded: Bytes = writer.guard(() => encoded);
const job: Job = writer.job(writer.losslessSteps(pixels, 1, 1));
const partly = writer.part(writer.lossySteps(pixels, 1, 1), 0, 2);
const signed: number = writer.packSigned(-1);
const floor: number = writer.floorLog2(8);
const ceil: number = writer.ceilLog2(9);
const half: number = writer.float16Bits(1);
const limit: number = writer.LIMITS.bytes;

// @ts-expect-error Counting requires a histogram, not a prefix code.
writer.codeChannel(null, code, plane, 1, 1, leaf);
// @ts-expect-error The stable vocabulary has no generic JXL_ERROR code.
writer.fault('JXL_ERROR', 'Invalid pixels.');
