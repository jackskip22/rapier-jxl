import {MEASURED_EFFORT} from '../effort-level.mjs';
import {screenPhotoRegions} from '../screen-photo-regions.mjs';
import {smallExactBeside, exactCandidate} from './exact-cap.mjs';
import {resultOperation, resultReference, resultFacts} from './result-operation.mjs';
import {FIT_BYTES, namedPicture, DEVICE_RAN, RESULT_REFERENCE} from './result-reference.mjs';
import {seedLexer} from '../visual-lexer-plan.mjs';
import {withRenderingIntent} from './header-intent.mjs';
import {PREVIEW, previewCall} from './preview.mjs';
import {effortJob} from '../effort-job.mjs';
import {EXACT_LADDER as DEEP} from '../exact-ladder.mjs';
import {photoAnsSteps} from '../photo-v6-blocks.mjs';
import {searchV6} from '../photo-v6-search.mjs';
import {encodePhotoSteps, admitFeatures} from '../photo-advanced.mjs';
import {inspectICC} from '../icc-profile.mjs';
import {measuredFeatures} from './feature-photo.mjs';
import {upsampledSamples} from './upsampling.mjs';
import {scoreTarget} from './score-target.mjs';
import {measuredFileSearch, withAnnounced} from './measured-search.mjs';
import {wholeRebuildMeasure} from '../photo-whole-rebuild.mjs';
import {memoryPlan} from '../memory-plan.mjs';
import {explicitShownMargin} from '../photo-whole-policy.mjs';
import {readPNG16} from '../source.mjs';
import {orientSamples} from '../sample-transforms.mjs';
import {compileCaptureKernels, captureExact} from '../capture-codec.mjs';
import {coreSteps} from './instant.mjs';
import {check, fail, declared, callers, progressOf, dimensions, preparedAlone, isBlob, abortable} from './primitives.mjs';
import {drain, driveSteps, encodeOptions, callOptions} from './common.mjs';
import {publicVocabulary} from './encode-options.mjs';
import {parallelJob} from '../parallel-drive.mjs';
import {scoreBandBytes} from '../photo-band-score.mjs';
import {scoreBandGeometry} from '../band-geometry.mjs';
import {DRIVE} from './drive.mjs';
import {takeFirstRegion, orderRegion, admitRegion} from './first-region.mjs';
import {image, pixels} from './input.mjs';
import {inspectPhone} from './phone-container.mjs';
import {own, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {withArenaLease} from '../call-scope.mjs';
import {jpegPixels} from './jpeg-pixels.mjs';
import {encodeBands, WHOLE} from './bands.mjs';
import {needsBands} from './band-size.mjs';
import {recodeBand} from './band-recode.mjs';
import {ordinaryStillReader, predictedFacts} from './ordinary-still-policy.mjs';
import {lowPhotoSteps, lowPhotoRoute} from './low-photo.mjs';
import {textFloorEligible, textFloorSteps} from '../text-floor.mjs';
import {lowIntentFacts, settledFacts, lowIntentEligible, LOW_INTENT_CALIBRATION} from './low-intent-quality.mjs';
import {settleScans} from './settle-scans.mjs';
import {stillPhotoTargetSteps, LOW_MEASURED_PIXELS} from './still-photo-target.mjs';
const SMALL_LADDER = 512 * 512;
import {planGate} from '../photo-whole-search.mjs';
import {declineSampledSeed} from '../photo-seed-sample.mjs';
import {HDR} from '../photo-hdr.mjs';
import {isRowSource, admitRows, readBand} from './rows.mjs';
import {isTexture, readTexture} from './texture.mjs';
import {isPlainRecord} from './records.mjs';
import {isDecoded, fromDecoded} from './describe.mjs';
import {acceleration, describedRoute, deviceAgain} from './acceleration.mjs';
import {requireWebGPU, EXACT_GPU_EFFORT} from './webgpu.mjs';
import {JOURNAL, JOURNAL_FILE, journaled} from '../step-journal.mjs';
import {journalPNG} from './journal-png.mjs';
import {JPEG_SOURCE, jpegSource, chooseJpeg} from './jpeg-choice.mjs';
import {verbSteps, STEPS} from './verb-steps.mjs';
import {pagePicture, pageFile, exactCodec, unletteredFile, letteredSteps, letteredFound, lettersRead, cutoutPage} from './page-route.mjs';
import {landedLettered} from './lettered-landed.mjs';
import {screenLike} from '../screen.mjs';
import {runCaptureComplete} from './capture-complete-run.mjs';
import {configuredDecoder, DECODER_SNAPSHOT} from '../shown-picture.mjs';
import {remember} from '../call-memo.mjs';
import {withProgressive} from '../coefficient-ans.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
export {supported} from './capture-support.mjs';

const FEATURED = 'orientation, extraChannels, features: 8-bit lossy only';
const EXTRA_EXACT = "exact extraChannels: use format({kind: 'channels'}) from jpegxl/format";
const EFFORT_TEN_HELPERS = 65536;
const deviceSetting = (codec, webgpu) => codec.quality < 100 || codec.effort === EXACT_GPU_EFFORT ? webgpu : false;

let prepared;
export const prepare = preparedAlone(() => prepared ||= (async () => {
  await acceleration(false, 0, 0);
  await compileCaptureKernels();
})().catch(error => { prepared = undefined; throw declared(error); }));

export function stillEncoder(ten = false) {
  const run = (input, options, helpers, region) => encodeHere(input, options, helpers, region, ten);
  const encodeBytes = (input, options) => regioned(run, input, options).catch(error => { throw declared(error); });
  encodeBytes[DRIVE] = (input, options, helpers) => regioned(run, input, options, helpers).catch(error => { throw declared(error); });
  const encode = resultOperation(encodeBytes, {preview: previewCall, device: true});
  const admit = ({maxBytes, outputs, ...rest}) => { encodeOptions(publicVocabulary(rest), ten, true); };
  if (!(typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true)) Object.defineProperty(encode, STEPS, {value: verbSteps(ten ? 'encode:rapier-jxl/max' : 'encode:rapier-jxl', encode, {taken: ['fidelity', 'effort', 'progressive', 'jpeg', 'readAs', 'maxPixels', 'firstRegion', 'webgpu'], admit, rows: true, files: true})});
  return encode;
}
export const encode = /* @__PURE__ */ stillEncoder();
async function encodeHere(input, given = {}, helpers = null, region, ten = false, acquired) {
  const journal = (typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true) ? undefined : given?.[JOURNAL], fit = given?.[FIT_BYTES];
  const original = given?.[JPEG_SOURCE];
  const options = journal === undefined && fit === undefined && original === undefined ? given : (({[JOURNAL]: _journal, [FIT_BYTES]: _fit, [JPEG_SOURCE]: _jpeg, ...rest}) => rest)(given);
  const {codec: {target, ...codec}, hooks: {webgpu, maxPixels}} = callOptions(encodeOptions(options, ten, true));
  const seeded = codec.effort >= 4 && codec.effort <= 6 && fit === undefined
    && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)
    && !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true);
  const lexer = seeded ? seedLexer() : null;
  const reader = ordinaryStillReader({signal: options.signal, maxPixels});
  const source = jpegSource(input, original);
  const owned = acquired ?? (source ? {features: own(options.features, maxPixels, Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16))} : undefined);
  if (source && webgpu === 'required') await abortable(requireWebGPU('required', codec.quality < 100 || target !== undefined, codec.quality < 100 || target !== undefined ? codec.effort : 0), options.signal);
  const carried = {};
  const run = async (settings = options, jpeg) => withRenderingIntent(await encodeOwned(input, settings, helpers,
    {codec, target, webgpu, maxPixels, journal, fit, lexer, carried,
      jpeg: original?.preserve === false || settings.readAs !== undefined ? undefined : jpeg, owned}, reader, region), carried.intent, journal?.join);
  const ladder = codec.effort > MEASURED_EFFORT && codec.effort <= 9 && codec.quality < 100 && target === undefined && journal === undefined
    && fit === undefined && !region && !source && !original && input?.data && input.width * input.height < SMALL_LADDER
    && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true);
  const again = ladder ? {options: {...given, fidelity: own(given.fidelity, maxPixels)}} : undefined;
  const sevenFacts = ladder ? {} : null, forward = options[RESULT_REFERENCE];
  const ran = ladder ? {...options, [RESULT_REFERENCE]: (r, p, f) => { if (f) Object.assign(sevenFacts, f); return forward?.(r, p, f); }} : options;
  try {
    const bytes = ladder ? await (async () => {
      const mine = await encodeOwned(input, ran, helpers, {codec, target, webgpu, maxPixels, journal, fit, lexer, carried, owned, again}, reader, region);
      const look = sevenFacts.kept === 'lossy' ? sevenFacts.measurements?.find(m => m.metric === 'ssimulacra2' && Number.isFinite(m.floor)) : null;
      if (!look) return withRenderingIntent(mine, carried.intent, journal?.join);
      const six = {};
      const sixBytes = await encodeHere(again.input, {...again.options, features: again.features, effort: MEASURED_EFFORT, webgpu: false, [RESULT_REFERENCE]: (r, p, f) => { if (f) Object.assign(six, f); }}, helpers, region, ten, again);
      const sixLook = six.kept === 'lossy' ? six.measurements?.find(m => m.metric === 'ssimulacra2' && Number.isFinite(m.score)) : null;
      if (!sixLook || sixBytes.length >= mine.length || sixLook.score < look.floor) return withRenderingIntent(mine, carried.intent, journal?.join);
      resultFacts(options, {...sevenFacts, measurements: sevenFacts.measurements.map(m => m === look ? {...m, score: sixLook.score} : m)});
      return sixBytes;
    })() : await (source ? chooseJpeg(source, codec, options,
      {signal: options.signal, maxPixels, journal, preserve: !region && !codec.progressive && original?.preserve !== false,
        readsSource: original?.bytes === undefined}, run) : run());
    return bytes;
  }
  finally { reader.destroy(); }
}

async function encodeOwned(input, options, helpers, {codec, target, webgpu, maxPixels, journal, fit, lexer, carried = {}, jpeg, owned, again}, reader, region) {
  const readAs = options.readAs;
  check(options.signal);
  if (isPlainRecord(input) && isDecoded(input)) input = fromDecoded(input);
  if (Array.isArray(input?.frames)) throw fail('JXL_UNSUPPORTED', 'animated input: use jpegxl/animation');
  if (isRowSource(input)) {
    if (readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs: not with row source');
    if (options.features !== undefined) throw fail('JXL_UNSUPPORTED', 'features: not with row source');
    const source = admitRows(input, maxPixels), report = options.onProgress;
    source.description = own(source.description, maxPixels);
    resultReference(options, source);
    const hooks = {signal: options.signal ?? new AbortController().signal, maxPixels, onProgress: progressOf(report, options.signal), journal,
      ...(options[PREVIEW] && {preview: options[PREVIEW]}), ran: options[DEVICE_RAN]};
    const run = fn => withArenaLease(options.signal, fn);
    if (webgpu === 'required') await abortable(requireWebGPU('required', codec.quality < 100, codec.effort), options.signal);
    let exact = true;
    const settle = async band => {
      const settled = reader.read(codec, band) ?? await reader.project(codec, band);
      exact &&= settled.quality === 100; return settled;
    };
    const recode = async function* (band, shared) {
      const settled = await settle(band); return yield* recodeBand(band, settled, shared, HDR, ...bandCoders(settled));
    };
    const read = (y, rows) => readBand(source, y, rows, hooks.signal);
    if (target !== undefined) return bandedScore({width: source.width, height: source.height, read}, settle, target, hooks, webgpu, options, run);
    const bytes = await encodeBands({width: source.width, height: source.height, read},
      async (band, bandHooks) => { const s = await settle(band); return encodePicture(band, s, bandHooks, helpers, deviceSetting(s, webgpu)); }, recode, drain, hooks, run);
    if (exact) resultFacts(options, {kept: 'pixels', measurements: []});
    return bytes;
  }
  const budget = Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);
  const features = owned ? owned.features : own(options.features, maxPixels, budget);
  if ((typeof __RAPIER_JXL_STILL__ !== 'undefined' && __RAPIER_JXL_STILL__ === true) && features !== undefined) throw fail('JXL_OPTIONS', 'unknown option: features');
  const settle = (picture, floorLater = false, at = codec) => {
    if (picture.extraChannels !== undefined && at.qualityIntent === undefined && at.quality === 100)
      throw fail('JXL_UNSUPPORTED', EXTRA_EXACT);
    return reader.read(at, picture, {jpeg, floorLater, exactAllowed: features === undefined && target === undefined &&
      picture.extraChannels === undefined}) ?? reader.project(at, picture, {jpeg, floorLater});
  };
  if (isTexture(input)) input = await abortable(readTexture(input, maxPixels), options.signal);
  let decoded = null;
  if (journal !== undefined && input?.[JOURNAL_FILE] !== undefined) {
    const file = input[JOURNAL_FILE];
    decoded = await withArenaLease(options.signal, () => journalPNG(file, readAs, maxPixels, journal));
    if (decoded) [decoded, carried.intent] = namedPicture(options, decoded, codec.quality < 100);
    input = decoded ?? new Blob([file.subarray(0, file.length)]);
  }
  const blob = isBlob(input);
  let read = owned?.input ?? (blob ? null : journal ? decoded ?? journalPixels(input, maxPixels) : pixels(input, {readAs}, maxPixels, true));
  const raw = again ? read : undefined;
  if (read && !decoded) [read, carried.intent] = namedPicture(options, read, codec.quality < 100);
  if (region && read) admitRegion(region, read);
  if (read?.icc !== undefined) inspectICC(read.icc, features?.level, read.colorSpace);
  if (features !== undefined && codec.quality === 100) throw fail('JXL_UNSUPPORTED', FEATURED);
  if (!(typeof __RAPIER_JXL_STILL__ !== 'undefined' && __RAPIER_JXL_STILL__ === true) && features !== undefined && read && codec.quality < 100) { const {data: _samples, ...description} = read; admitFeatures({...description, ...features}, read.width, read.height, codec.quality); }
  let captured = blob ? null : journal || owned?.input ? {input: read, ...own({codec, features, target}, maxPixels, budget)}
    : own({input: read, codec, features, target, ...(again && {raw})}, maxPixels, budget);
  if (again) { again.input = captured.raw; again.features = features; }
  if (captured) resultReference(options, captured.input);
  const report = options.onProgress, onProgress = progressOf(report, options.signal);
  const hooks = {signal: options.signal ?? new AbortController().signal, onProgress, maxPixels, journal,
    ...(options[PREVIEW] && {preview: options[PREVIEW]}), ran: options[DEVICE_RAN],
    ...(lexer && {lexer, onLexerEvaluated: id => resultFacts(options, {lexer: id})})};
  return withArenaLease(options.signal, async () => {
  if (webgpu === 'required') await abortable(requireWebGPU('required', codec.quality < 100 || target !== undefined, codec.effort), options.signal);
  if (captured && journal && lowIntentEligible(captured.input))
    settledFacts.set(captured.input.data, await journal.tools.settleFacts(journal, settleScans, captured.input.data, captured.input.width, captured.input.height));
  else if (captured && codec.qualityIntent !== undefined && features === undefined && target === undefined && lowIntentEligible(captured.input))
    settledFacts.set(captured.input.data, lowIntentFacts(captured.input));
  const asked = codec.qualityIntent !== undefined && codec.quality < 100 && codec.effort < MEASURED_EFFORT && features === undefined && target === undefined;
  const once = async (picture, run) => {
    const forget = journal ? null : remember(picture.data);
    try { return await run(); } finally { forget?.(); }
  };
  const pageAsked = codec.qualityIntent !== undefined && codec.quality < 100 && features === undefined && target === undefined;
  const unlettered = async (picture, bytes, paged = false, coded = null) => {
    const measuredPolicy = coded?.quality === 100 && codec.effort >= MEASURED_EFFORT &&
      Math.min(picture.width, picture.height) >= LOW_INTENT_CALIBRATION.smallestScored &&
      lowIntentFacts(picture, {wide: picture.colorSpace === 'display-p3'}).eligible;
    if (!(paged ? pageAsked : asked || pageAsked && measuredPolicy)) return bytes;
    const exact = bytes;
    const answer = await unletteredFile(picture, bytes, async () => {
      const settled = paged ? await settle(picture) : null;
      return settled?.quality < 100 ? settled : reader.read(codec, picture, {jpeg, exactAllowed: false}) ?? await reader.project(codec, picture, {jpeg});
    },
      async lossy => {
        if (measuredPolicy) lossy = {...lossy, lowIntent: codec.qualityIntent};
        if (coded && coded.quality < 100 && coded.effort === lossy.effort && coded.quality <= lossy.quality) return {bytes: exact};
        const {data: _data, width: _width, height: _height, ...description} = picture;
        let facts = predictedFacts({...description, ...lossy});
        const bytes = await encodePicture(picture, lossy, hooks, helpers, webgpu, codec.qualityIntent, selected => { facts = selected; });
        return {bytes, facts};
      });
    if (!answer) return bytes;
    resultFacts(options, answer.facts ?? {kept: 'lossy', measurements: []});
    return answer.bytes;
  };
  const page = async ({data, width, height, ...source}, settled) => settled.quality < 100 && codec.qualityIntent !== undefined &&
    features === undefined && target === undefined && width * height <= WHOLE &&
    await journaled(journal, 'page-route', () => pagePicture(data, width, height, {...source, ...settled})) &&
    (settled.effort <= 5 && cutoutPage(data, width, height) ? once({data}, async () => {
      const bytes = await encodePicture({data, width, height, ...source}, exactCodec({...settled, effort: 1}), hooks, helpers, false);
      resultFacts(options, {kept: 'pixels', measurements: []});
      return unlettered({data, width, height, ...source}, bytes, true);
    }) :
    once({data}, () => pageFile(runCaptureComplete, {data, width, height}, {qualityIntent: codec.qualityIntent, [DECODER_SNAPSHOT]: configuredDecoder()},
      (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) ? Math.min(settled.effort, 9) : settled.effort, hooks, facts => resultFacts(options, facts), webgpu,
      () => encodePicture({data, width, height, ...source}, exactCodec(settled), hooks, helpers, false))
      .then(bytes => unlettered({data, width, height, ...source}, bytes, true))));
  const screenFirst = picture => codec.effort >= MEASURED_EFFORT && codec.qualityIntent < 1 && screenLike(picture.data, picture.width, picture.height);
  const normalizeCaptured = async (state, activeCodec) => {
    if (!state || state.features !== undefined || state.target !== undefined) return;
    if (Array.isArray(state.input.extraChannels) && !state.input.extraChannels.length) {
      const {extraChannels: _extra, ...rest} = state.input;
      state.input = rest;
    }
    if (state.input.orientation === 1) {
      const {orientation: _ori, ...rest} = state.input;
      state.input = rest;
    }
    if (state.input.orientation !== undefined && state.input.extraChannels === undefined) {
      const {data: d, width: _w, height: _h, ...desc} = state.input;
      if (activeCodec.quality === 100 || activeCodec.effort >= MEASURED_EFFORT || !admitSampleFormat(d, {...desc, ...activeCodec}).native8) {
        const {orientation: _ori, ...shown} = await orientSamples(state.input, {signal: hooks.signal});
        state.input = shown;
      }
    }
  };
  await normalizeCaptured(captured, codec);
  if (again) {
    const {data, width, height, orientation} = captured.input;
    again.input = {...captured.raw, data, width, height, orientation};
  }
  const admitRequiredStill = async picture => {
    if (webgpu === 'required' && codec.quality < 100 && captured.features === undefined && captured.target === undefined) {
      const {data: d, width: w, height: h, ...desc} = picture;
      await acceleration('required', w, h, codec.effort, describedRoute(d, {...desc, ...codec}), undefined, hooks.signal);
    }
  };
  if (captured) {
    await admitRequiredStill(captured.input);
    const early = screenFirst(captured.input), paged = early && await page(captured.input, codec);
    if (paged) return paged;
    const settled = await journaled(journal, 'settle', async () => {
      const coded = await settle(captured.input, journal !== undefined), floor = reader.deferredFloor();
      return floor ? {coded, floor} : {coded};
    });
    captured.codec = settled.floor ? await journaled(journal, 'floor', () => reader.floor(codec, captured.input, settled.floor)) : settled.coded;
    const late = !early && await page(captured.input, captured.codec);
    if (late) return late;
  }
  if (blob) {
    let picture = await journaled(journal, 'decode', () => image(input, {readAs, exact: !(codec.quality < 100)}, {...hooks, phone: inspectPhone, jpegPixels, deep: async () => ({readSource: readPNG16, orient: orientSamples})}));
    [picture, carried.intent] = namedPicture(options, picture, codec.quality < 100);
    captured = own({input: picture, codec, features, target}, maxPixels, budget);
    resultReference(options, captured.input, input);
    await normalizeCaptured(captured, codec);
    if (!journal && codec.qualityIntent !== undefined && features === undefined && target === undefined && lowIntentEligible(captured.input))
      settledFacts.set(captured.input.data, lowIntentFacts(captured.input));
    await admitRequiredStill(captured.input);
    const early = screenFirst(captured.input), paged = early && await page(captured.input, codec);
    if (paged) return paged;
    captured.codec = await settle(captured.input);
    const late = !early && await page(captured.input, captured.codec);
    if (late) return late;
  }
  await normalizeCaptured(captured, captured.codec);
  const {data, width, height, ...source} = captured.input;
  check(hooks.signal);
  const settings = {...source, ...captured.codec};
  if (settings.quality === 100) resultFacts(options, {kept: 'pixels', measurements: []});
  else if (predictedFacts(settings)) resultFacts(options, predictedFacts(settings));
  const featured = captured.features !== undefined || source.orientation !== undefined || source.extraChannels !== undefined;
  if (captured.target !== undefined) {
    if (featured)
      throw fail('JXL_INPUT', 'measured fidelity: no orientation, extraChannels or features');
    if (width * height > WHOLE) return bandedScore({width, height, read: (y, rows) => ({...source, data: data.subarray(y * width * 4, (y + rows) * width * 4), width, height: rows})},
      () => captured.codec, captured.target, hooks, webgpu, options);
    if (!hooks.journal && width * height <= WHOLE &&
        pagePicture(data, width, height, {...source, ...settings, quality: 90}) && !screenPhotoRegions(data, width, height, true).length) {
      const bytes = await encodePicture({data, width, height, ...source}, exactCodec(settings), {signal: hooks.signal}, helpers, webgpu);
      resultFacts(options, {kept: 'pixels', measurements: []});
      return bytes;
    }
    const answer = await scoreTarget(data, width, height, source, settings, captured.target, hooks, webgpu);
    resultFacts(options, answer.facts);
    return answer.bytes;
  }
  if (featured) {
    if (settings.quality === 100 || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw fail('JXL_UNSUPPORTED', FEATURED);
    await acceleration(webgpu, 0, 0, settings.effort, 'codestream features');
    const coded = (typeof __RAPIER_JXL_STILL__ !== 'undefined' && __RAPIER_JXL_STILL__ === true) ? data : await upsampledSamples(captured.input, captured.features, hooks);
    const measured = (typeof __RAPIER_JXL_STILL__ !== 'undefined' && __RAPIER_JXL_STILL__ === true) ? null : await measuredFeatures(captured.input, captured.features, settings, codec.qualityIntent, hooks, coded);
    if (measured) { resultFacts(options, {kept: 'lossy', measurements: measured.measurements}); return measured.bytes; }
    const rawSteps = encodePhotoSteps(coded, width, height, {...settings, ...captured.features});
    const steps = settings.progressive && !captured.features?.progressive ? withProgressive(true, rawSteps, settings.effort) : rawSteps;
    return drain(steps, hooks);
  }
  if (needsBands(width, height, settings, data)) {
    const facts = new Map(), recoded = new Set(), at = band => band.data.byteOffset;
    const bytes = await encodeBands({width, height, read: (y, rows) => ({...source, data: data.subarray(y * width * 4, (y + rows) * width * 4), width, height: rows})},
      (band, bandHooks) => encodePicture(band, captured.codec, bandHooks, helpers, deviceSetting(captured.codec, webgpu), codec.qualityIntent, fact => facts.set(at(band), fact)),
      (band, target) => { recoded.add(at(band)); return recodeBand(band, captured.codec, target, HDR, ...bandCoders(captured.codec)); }, drain, hooks);
    if (facts.size) {
      const read = [...facts.values()].flatMap(fact => fact.measurements ?? []), floor = read.find(m => m.floor !== undefined)?.floor;
      const shown = [...facts].flatMap(([key, fact]) => !recoded.has(key) ? fact.measurements ?? []
        : settings.quality < 100 && floor !== undefined ? [{metric: 'ssimulacra2', domain: 'predicted', floor}] : []);
      resultFacts(options, {kept: [...facts].every(([key, fact]) => fact.kept === 'pixels' && (!recoded.has(key) || settings.quality >= 100)) ? 'pixels' : 'lossy',
        measurements: shown});
    }
    return bytes;
  }
  const small = codec.effort === MEASURED_EFFORT && width * height <= LOW_MEASURED_PIXELS;
  const seedShips = !(small && hooks.lexer);
  const routed = seedShips ? hooks : {...hooks, lexer: null, onLexerEvaluated: undefined};
  let sampledDecline = false;
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) &&
      !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) &&
      codec.effort === MEASURED_EFFORT && seedShips && hooks.lexer && journal === undefined && fit === undefined &&
      !featured && captured.target === undefined && settings.quality < 100 && codec.qualityIntent !== undefined &&
      (source.space ?? 'srgb') === 'srgb' && !source.transform && data instanceof Uint8Array && data.length === width * height * 4) {
    const {plan} = planGate(hooks.lexer, data, width, height, settings.quality, codec.qualityIntent, MEASURED_EFFORT);
    sampledDecline = declineSampledSeed(data, width, height, settings.quality, plan);
  }
  const lowFive = (codec.effort === MEASURED_EFFORT || codec.effort === MEASURED_EFFORT + 1) && fit === undefined && settings.quality < 100 && captured.target === undefined
    && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)
    ? async () => {
      const five = await settle(captured.input, false, {...codec, effort: MEASURED_EFFORT - 1});
      if (!five || !(five.quality < 100)) return null;
      let kept = null;
      const bytes = await encodePicture(captured.input, five, {...hooks, lexer: seedLexer(), onLexerEvaluated: undefined, lowLook: (file, look) => { kept = {file, look}; }}, helpers, false, codec.qualityIntent, () => {});
      return {bytes, look: kept && kept.file === bytes ? kept.look : null};
    } : null;
  return once(captured.input, () => codedPicture(captured, settings, sampledDecline ? {...hooks, lexer: null} : routed, fit, helpers, webgpu, codec, options, unlettered, lowFive));
  });
}

const BAND_MARGIN = [[50, 0.3], [70, 0.1], [80, 0.05], [90, 0]];
function bandTarget({ssimulacra2: score}) {
  const i = BAND_MARGIN.findIndex(([at]) => at >= score);
  const margin = i === 0 ? BAND_MARGIN[0][1] : i < 0 ? BAND_MARGIN[BAND_MARGIN.length - 1][1]
    : BAND_MARGIN[i - 1][1] + (BAND_MARGIN[i][1] - BAND_MARGIN[i - 1][1]) * (score - BAND_MARGIN[i - 1][0]) / (BAND_MARGIN[i][0] - BAND_MARGIN[i - 1][0]);
  return {ssimulacra2: Math.min(100, score + margin)};
}
async function bandedScore({width, height, read}, settings, target, hooks, webgpu, options, run) {
  const positions = new WeakMap(), facts = new Map(), aim = bandTarget(target);
  const source = {width, height, read: async (y, rows) => {
    const band = await read(y, rows); positions.set(band, y); return band;
  }};
  const replacementHooks = {...hooks, preview: undefined, onProgress: undefined};
  const code = (band, coded, shared, quality, bandHooks = replacementHooks) =>
    drain(recodeBand(band, {...coded, quality}, shared, HDR, ...bandCoders(coded)), bandHooks);
  const exactBand = async (band, shared, bandHooks = replacementHooks) => {
    const bytes = await code(band, await settings(band), {...shared, xyb: false, exact: true}, 100, bandHooks);
    facts.set(positions.get(band), {kept: 'pixels', measurements: []}); return bytes;
  };
  const restart = {}, needExact = shared => { exactShape = {...shared, xyb: false, exact: true}; throw restart; };
  let exactShape;
  const recode = async function* (band, shared) {
    if (shared.exact || aim.ssimulacra2 === 100 || facts.get(positions.get(band))?.kept === 'pixels') {
      if (shared.xyb) needExact(shared);
      return await exactBand(band, shared);
    }
    const {data, width: w, height: h} = band, coded = await settings(band);
    const samples = data.subarray(0, data.length);
    const plan = memoryPlan(w * h, {width: w, height: h, inputBytes: data.buffer.byteLength});
    let metric = wholeRebuildMeasure(samples, w, h, {space: 'srgb'}, hooks.signal, plan), failed = false;
    const close = () => { const held = metric; metric = null; held?.destroy(); };
    const exact = async onProgress => {
      close();
      if (shared.xyb) needExact(shared);
      return code(band, coded, {...shared, exact: true}, 100, {...replacementHooks, onProgress});
    };
    const probe = async (quality, onProgress) => {
      const seen = new WeakMap();
      const bytes = await withAnnounced(() => code(band, coded, shared, quality, {...replacementHooks, onProgress}),
        (file, picture) => { seen.set(file, picture); });
      const picture = seen.get(bytes);
      if (!picture) throw fail('JXL_INTERNAL', 'banded-score:result');
      let scores = metric.measure(picture, {ssimulacra2: true, butteraugli: false});
      if (typeof scores?.next === 'function') scores = await drain(scores, {signal: hooks.signal});
      return {quality, bytes, scores: {ssimulacra2: scores.ssimulacra2 - explicitShownMargin(scores.ssimulacra2, w, h)}};
    };
    try {
      const answer = await measuredFileSearch(aim, probe, null, {...replacementHooks, exact, width: w, height: h,
        domain: 'encoder-reconstruction'});
      facts.set(positions.get(band), {kept: answer.exact ? 'pixels' : 'lossy', measurements: answer.measurements});
      return answer.bytes;
    } catch (error) { failed = true; throw error; }
    finally { try { close(); } catch (error) { if (!failed) throw error; } }
  };
  let bytes;
  try {
    bytes = await encodeBands(source, async (band, bandHooks) => {
      const {data, width: w, height: h, ...description} = band, coded = await settings(band);
      const answer = await scoreTarget(data, w, h, description, {...description, ...coded}, aim, bandHooks, webgpu);
      facts.set(positions.get(band), answer.facts); return answer.bytes;
    }, recode, drain, hooks, run);
  } catch (error) {
    if (error !== restart) throw error;
    facts.clear();
    bytes = await encodeBands(source, (band, bandHooks) => exactBand(band, exactShape, bandHooks),
      async function* (band, shared) { return await exactBand(band, shared); }, drain, hooks, run);
  }
  const kept = [...facts.values()];
  resultFacts(options, {kept: kept.every(fact => fact.kept === 'pixels') ? 'pixels' : 'lossy', measurements: kept.flatMap(fact => fact.measurements)});
  return bytes;
}

async function codedPicture(captured, settings, hooks, fit, helpers, webgpu, codec, options, unlettered, lowFive = null) {
  let sixFacts = null;
  const bytes = await encodePicture(captured.input, captured.codec, {...hooks, fit}, helpers, deviceSetting(captured.codec, webgpu), codec.qualityIntent,
    facts => { sixFacts = facts; resultFacts(options, facts); });
  const sixLook = sixFacts?.kept === 'lossy' ? sixFacts.measurements?.find(m => m.metric === 'ssimulacra2' && Number.isFinite(m.score)) : null;
  if (lowFive && sixFacts?.kept === 'lossy' && !captureExact(bytes)) {
    const five = await lowFive();
    if (five && five.bytes.length < bytes.length) {
      resultFacts(options, {...sixFacts, measurements: sixLook && five.look !== null ? sixFacts.measurements.map(m => m === sixLook ? {...m, score: five.look} : m) : []});
      return five.bytes;
    }
  }
  if (settings.quality < 100 && captureExact(bytes)) {
    resultFacts(options, {kept: 'pixels', measurements: []});
    if (settings.effort >= MEASURED_EFFORT) {
      const exact = await encodePicture(captured.input, exactCodec(captured.codec), hooks, helpers, false);
      if (exact.length < bytes.length) return unlettered(captured.input, exact);
    }
    return settings.lowIntent !== undefined ? bytes : unlettered(captured.input, bytes, false, captured.codec);
  }
  if (settings.quality === 100) return unlettered(captured.input, bytes, false, captured.codec);
  const exact = await smallExactBeside(bytes, captured.input, settings.effort, exactCandidate(captured.input, runCaptureComplete,
    effort => encodePicture(captured.input, exactCodec({...captured.codec, effort}), hooks, helpers, false), hooks));
  if (exact) { resultFacts(options, {kept: 'pixels', measurements: []}); return exact; }
  return bytes;
}

function journalPixels({data, width, height, colorSpace, colorEncoding, icc}, maxPixels) {
  dimensions(width, height, maxPixels);
  return {data, width, height, ...(colorSpace && {colorSpace}), ...(colorEncoding && {colorEncoding}), ...(icc && {icc})};
}

const bandCoders = codec => [codec.effort >= 6 ? photoAnsSteps : undefined, codec.effort >= 8 ? searchV6 : undefined];

const encodePicture = (picture, codec, hooks, helpers, webgpu, intent, selected) =>
  deviceAgain(webgpu, gpu => encodeWith(picture, codec, hooks, helpers, gpu, intent, selected));
async function encodeWith({data, width, height, ...source}, codec, hooks, helpers, webgpu, intent, selected) {
  const settings = {...source, ...codec}, lossy = settings.quality < 100;
  check(hooks.signal);
  const target = stillPhotoTargetSteps(data, width, height, settings, {intent, signal: hooks.signal, selected, maxPixels: hooks.maxPixels, fit: hooks.fit,
    preview: hooks.preview, lexer: hooks.lexer, onLexerEvaluated: hooks.onLexerEvaluated, lowLook: hooks.lowLook, lowPlan: hooks.lowPlan,
    exact: (effort = 5, limit) => effortJob(data, width, height, {...settings, quality: 100, effort}, false,
      undefined, undefined, undefined, limit > 0 ? {...DEEP, limit} : DEEP, HDR)});
  const bandBytes = target ? scoreBandBytes(width, height) : undefined, geometry = target ? scoreBandGeometry(width, height) : undefined;
  const retiring = helpers?.stage?.(width * height, bandBytes, geometry);
  if (retiring) await retiring;
  const exactTen = !lossy && settings.effort === EXACT_GPU_EFFORT, eight = data instanceof Uint8Array || data instanceof Uint8ClampedArray;
  const cellsRoute = !!target && lossy && !hooks.fit && settings.effort >= 7 && (settings.colorSpace ?? 'srgb') === 'srgb' && width >= 8 && height >= 8;
  const gpu = await acceleration(webgpu, width, height, lossy || exactTen ? settings.effort : 0, exactTen && eight ? 'still' : describedRoute(data, settings), hooks.ran, hooks.signal, exactTen, cellsRoute);
  check(hooks.signal);
  const read = lossy && intent !== undefined && !hooks.fit;
  const measured = !!target && settings.effort >= MEASURED_EFFORT;
  const found = read && measured ? letteredFound({data, width, height, ...source}, settings) : null;
  const landed = found ? landedLettered({data, width, height}, found, settings, intent, hooks.signal) : null;
  const lettered = found ? (function* () {
    const own = yield* effortJob(data, width, height, {...settings, quality: 100, effort: 5}, false, undefined, undefined, undefined, DEEP, HDR);
    if (!landed || own.length <= landed.bytes.length) { selected?.({kept: 'pixels', measurements: []}); return own; }
    selected?.({kept: 'lossy', measurements: landed.measurements});
    return landed.bytes;
  })() : read && !measured && await lettersRead(hooks.journal, {data, width, height, ...source}, settings) ? letteredSteps({data, width, height, ...source}, settings, intent,
    () => settings.effort === 1 ? coreSteps(data, width, height, exactCodec(settings), HDR)
      : effortJob(data, width, height, exactCodec(settings), false, undefined, undefined, undefined, DEEP, HDR), selected) : null;
  const route = !lettered && !target ? await journaled(hooks.journal, 'low-route', () => lowPhotoRoute(data, width, height, settings, settledFacts.get(data))) : null;
  const floored = lossy && !target && await journaled(hooks.journal, 'text-floor', () => textFloorEligible(data, width, height, settings, settledFacts.get(data)));
  const low = lettered ? null : target ?? lowPhotoSteps(data, width, height, settings, route, null);
  const coded = lettered ?? low ?? (settings.effort === 1 ? coreSteps(data, width, height, settings, selected ? {...HDR, report: selected} : HDR)
    : effortJob(data, width, height, settings, !!gpu, undefined, lossy && settings.effort >= 8 ? searchV6 : undefined,
        lossy && settings.effort >= 6 ? photoAnsSteps : undefined, DEEP, selected ? {...HDR, report: selected} : HDR));
  const baseSteps = floored ? textFloorSteps(coded, data, width, height, settings.colorSpace) : coded;
  const steps = settings.progressive ? withProgressive(true, baseSteps, settings.effort) : baseSteps;
  return helpers && !lettered && (low || settings.effort !== 1) ? driveSteps(steps, hooks, gpu, width * height, helpers,
    low && !target ? null : parallelJob, target ? 'score-band' : null, bandBytes, geometry, !lossy && settings.effort === 10 ? EFFORT_TEN_HELPERS : undefined) : drain(steps, hooks, gpu);
}

async function regioned(run, input, options, helpers) {
  const {region, options: rest} = takeFirstRegion(options);
  return orderRegion(await run(input, rest, helpers, region), region);
}
