// SPDX-License-Identifier: MIT
import {float16Bits, ceilLog2} from './bits.mjs';
import {writeHeaderFields, writeFrameHeaderEnd, GROUP_DIM} from './frame.mjs';
import {writeHistograms, buildCode, uintConfig, countToken, writeHybrid} from './prefix.mjs';
import {jpegError} from './jpeg-tables.mjs';
import {SCAN} from './dct8-contexts.mjs';

export function varDCTGeometry(jpeg, plan = {}) {
  const {width, height, components, xyb, strategyData, progression, authoredOrderPasses} = jpeg;
  const grey = components.length === 1;
  const directRGB = jpeg.cflBase !== undefined;
  const numPasses = progression?.count || 1;
  const epf = xyb ? jpeg.epf || 0 : 0;
  const quantScale = jpeg.quantScale || 1;
  let field = jpeg.quantFieldBase || 1, shift = 1;
  while (field / (8 * 255 * quantScale) < 1 / 16384) { field *= 2; shift *= 2; }
  const ycbcr = !xyb && (jpeg.ycbcr || grey);
  const map = grey ? [0, 0, 0] : ycbcr ? [1, 0, 2] : [0, 1, 2];
  const comps = map.map(i => components[i]);
  const hasOrders = Boolean(plan.orders && !authoredOrderPasses && map.some(i => plan.orders[i].some((k, r) => k !== r)));
  const orders = hasOrders ? map.map(i => plan.orders[i].map(k => SCAN[k])) : [SCAN, SCAN, SCAN];
  const log2 = v => v === 1 ? 0 : v === 2 ? 1 : -1;
  const minH = ycbcr ? 1 : Math.min(...comps.map(c => c.h)), minV = ycbcr ? 1 : Math.min(...comps.map(c => c.v));
  const rawH = comps.map(c => c.h % minH ? -1 : log2(c.h / minH)), rawV = comps.map(c => c.v % minV ? -1 : log2(c.v / minV));
  if (rawH.includes(-1) || rawV.includes(-1)) throw jpegError('sampling factors other than one or two');
  const maxhs = Math.max(...rawH), maxvs = Math.max(...rawV);
  const hshifts = rawH.map(value => maxhs - value), vshifts = rawV.map(value => maxvs - value);
  if (!ycbcr && (maxhs || maxvs)) throw jpegError('an RGB JPEG with subsampling');
  const xsizeBlocks = Math.ceil(width / (8 << maxhs)) << maxhs, ysizeBlocks = Math.ceil(height / (8 << maxvs)) << maxvs;
  const groupsX = Math.ceil(width / GROUP_DIM), groupsY = Math.ceil(height / GROUP_DIM), numGroups = groupsX * groupsY;
  const dcGroupsX = Math.ceil(xsizeBlocks / 256), dcGroupsY = Math.ceil(ysizeBlocks / 256), numDcGroups = dcGroupsX * dcGroupsY;
  const single = numGroups === 1 && numPasses === 1;
  if (strategyData && (maxhs || maxvs || plan.orders && !authoredOrderPasses)) throw jpegError('variable transforms with subsampling or DCT8-only learned orders');

  return {grey, directRGB, numPasses, epf, quantScale, field, shift, ycbcr, map, comps, hasOrders, orders,
    rawH, rawV, maxhs, maxvs, hshifts, vshifts, xsizeBlocks, ysizeBlocks, groupsX, groupsY, numGroups,
    dcGroupsX, dcGroupsY, numDcGroups, single};
}

export function varDCTLayout(jpeg, plan = {}, layout = varDCTGeometry(jpeg, plan)) {
  const {comps, ycbcr, directRGB} = layout, {xyb} = jpeg;
  const jpegReconstruction = jpeg.jpegReconstruction === true;
  const gcd1024 = q => { let d = 1024; while (q % d) d >>= 1; return d; };
  const dcScale = comps.map(c => ycbcr || xyb || directRGB || jpegReconstruction ? 1 : c.quant[0] / gcd1024(c.quant[0]));
  const dcLift = comps.map(c => ycbcr || xyb || directRGB ? 0 : jpegReconstruction ? Math.floor(1024 / c.quant[0]) : 1024 / gcd1024(c.quant[0]));
  layout.dcScale = dcScale; layout.dcLift = dcLift;
  return layout;
}

export function writeVarDCTHeader(header, jpeg, layout, modular16bit, imageHeader = writeHeaderFields) {
  const {width, height, alpha, auxiliary, xyb, progression, noiseLut, splineBits, useDCFrame} = jpeg;
  const {grey, ycbcr, rawH, rawV, epf} = layout;
  const {isFirstFrame = true, isLastFrame = true, crop = null, saveAsReference = 0, imageWidth, imageHeight,
    alphaChannel = Boolean(alpha), mask = false, patches = null} = jpeg.placement ?? {};
  if (jpeg.frameHeader) jpeg.frameHeader(header);
  else {
  if (isFirstFrame) imageHeader(header, imageWidth ?? jpeg.canvasWidth ?? width, imageHeight ?? jpeg.canvasHeight ?? height, grey ? 1 : 3, alphaChannel, {xyb, orientation: jpeg.orientation, colorSpace: jpeg.colorSpace, modular16bit, ...jpeg.profile});
  header.write(1, 0); header.write(2, 0); header.write(1, 0);
  header.write(2, 2); header.write(8, 128 + (noiseLut ? 1 : 0) + (patches ? 2 : 0) + (splineBits ? 16 : 0) + (useDCFrame ? 32 : 0) - 17);
  if (!xyb) header.write(1, ycbcr ? 1 : 0);
  if (!useDCFrame) {
  if (ycbcr) for (let c = 0; c < 3; c++) header.write(2, rawH[c] === 0 && rawV[c] === 0 ? 0 : rawH[c] === 1 && rawV[c] === 1 ? 1 : rawH[c] === 1 ? 2 : 3);
  header.write(2, [1, 2, 4, 8].indexOf(jpeg.upsampling ?? 1));
  if (auxiliary) for (const factor of auxiliary.factors) header.write(2, [1, 2, 4, 8].indexOf(factor));
  else if (alphaChannel) header.write(2, [1, 2, 4, 8].indexOf(jpeg.upsampling ?? 1));
  }
  if (xyb) { header.write(3, 2); header.write(3, 2); }
  writeFrameHeaderEnd(header, auxiliary?.count ?? alphaChannel, epf, progression?.header, jpeg.epfIterations, xyb ? jpeg.gab : null,
    {crop, canvas: imageWidth && {width: imageWidth, height: imageHeight}, last: isLastFrame, reference: saveAsReference, mask});
  }
}

export function writeVarDCTDCFields(writer, jpeg, layout, contextHeader) {
  const {comps, dcScale, quantScale} = layout, {xyb} = jpeg;
  writer.write(1, 0);
  for (let c = 0; c < 3; c++) writer.write(16, float16Bits(comps[c].quant[0] / dcScale[c] / (255 * 8 * quantScale) * 128));
  writer.write(2, 3); writer.write(16, 65536 - 8193);
  writer.write(2, 1); writer.write(5, 0);
  writer.write(1, 0); writer.write(4, 0);
  writer.append(contextHeader);
  if (xyb) writer.write(1, 1);
  else { const base = float16Bits(jpeg.cflBase ?? 0); writer.write(1, 0); writer.write(2, 0); writer.write(16, base); writer.write(16, base); writer.write(8, 128); writer.write(8, 128); }
  writer.write(1, 0);
}

export function writeVarDCTOrders(writer, jpeg, layout, plan, pass) {
  const {authoredOrderPasses} = jpeg, {hasOrders, map} = layout;
  if (authoredOrderPasses) writer.append(authoredOrderPasses[pass].header);
  else if (hasOrders) {
    writer.writeU32([[0, 95], [0, 19], [0, 0], [13, 0]], 1);
    const values = [];
    for (const c of map) {
      const available = Array.from({length: 64}, (_, k) => k), lehmer = plan.orders[c].map(k => {
        const at = available.indexOf(k); available.splice(at, 1); return at;
      });
      let end = 64;
      while (end > 1 && !lehmer[end - 1]) end--;
      values.push(end - 1, ...lehmer.slice(1, end));
    }
    const config = uintConfig(0), freqs = new Uint32Array(64);
    for (const value of values) countToken(config, value, freqs);
    const code = buildCode(freqs);
    writeHistograms(writer, {contextMap: new Uint8Array(8), histograms: [{config, code}]});
    for (const value of values) writeHybrid(writer, code, config, value);
  } else writer.write(2, 2);
}


export function varDCTContextBuckets(image, layout, fast) {
  const lumaQuant = layout.comps[1].quant, quantSum = (lumaQuant[8] + lumaQuant[16] + lumaQuant[24] + lumaQuant[32] + lumaQuant[40]) / layout.quantScale;
  const blocksTotal = layout.xsizeBlocks * layout.ysizeBlocks;
  return fast || image.useDCFrame || blocksTotal < 256 ? 0 : Math.max(1, Math.min(7, ceilLog2(blocksTotal) - ceilLog2(quantSum) - (image.xyb ? 6 : 7)));
}
