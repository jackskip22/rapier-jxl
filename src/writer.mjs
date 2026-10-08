// SPDX-License-Identifier: MIT
// Typed JPEG XL format primitives (ISO/IEC 18181-1). Public changes require a major package version.
// Readable modules only: minified builds rename internal object properties.
export {LIMITS, PHOTO_LIMITS, JPEG_LIMITS, BitWriter, packSigned, floorLog2, ceilLog2, float16Bits, complete, part} from './bits.mjs';
export {codeLengths, canonicalCodes, buildCode, writePrefixCode, uintConfig, writeUintConfig, hybridToken, countToken, writeHybrid, writeContextMap, writeHistograms} from './prefix.mjs';
export {GROUP_DIM, DC_GROUP_DIM, writeImageHeader, writeModularFrameHeader, writeFrameHeaderEnd, writeTOC, groupLayout, finishSections, assembleCodestream} from './frame.mjs';
export {PREDICTOR, LZ77, RESIDUAL_CONFIG, ALPHABET, leaf, split, channelTree, streamTree, writeTree, writeTransform, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';
export {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, WEIGHTED_CUTS, codeWeighted} from './weighted.mjs';
export {forwardSqueeze, defaultSqueezeParams} from './squeeze.mjs';
export {inspectPixels, encodeLossless, losslessSteps} from './lossless.mjs';
export {distanceFromQuality, quantiserFor, encodeLossy, lossySteps} from './lossy.mjs';
export {TokenCounts, buildTokenCoding} from './entropy.mjs';
export {encodeVarDCT, varDCTSteps, transcodeJPEG} from './vardct.mjs';
export {parseJPEG, profileSpace, ZIGZAG} from './jfif.mjs';
export {fault, admitOptions, admitSize, admitPixels, answer, guard, job} from './admit.mjs';
