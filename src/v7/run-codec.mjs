import {bytes, check, dimensions, fail, object} from './primitives.mjs';

export async function runCodec(operation, input, options = {}, hooks = {}, drive) {
  object(options); check(hooks.signal);
  const capture = operation === 'capture';
  const encoder = operation === 'encode' && options.effort !== 1 && options.format === undefined && options.target === undefined ? import('../effort-job.mjs') : null;
  const instant = operation === 'encode' && options.effort === 1 && options.format === undefined && options.target === undefined &&
    options.losslessProfile === undefined && input?.losslessProfile === undefined ? import('./instant.mjs') : null;
  const kernels = operation === 'encode' && (options.acceleration === 'wasm' || options.acceleration === 'auto') ? import('../kernels.mjs') : null;
  encoder?.catch(() => {}); instant?.catch(() => {}); kernels?.catch(() => {});
  const [{drain, encodeOptions, targetSource}, {image, jpegDimensions}, {acceleration}] = operation === 'decode' || operation === 'restore' ? [{}, {}, {}]
    : await Promise.all([capture ? {} : import('./common.mjs'), import('./input.mjs'), import('./acceleration.mjs')]);
  check(hooks.signal);
  const finish = iterator => drain(iterator, hooks);
  if (operation === 'encode' || capture) {
    const normalized = capture ? null : encodeOptions(options);
    if (capture) {
      const allowed = new Set(['maxError','colorSpace','signal','onProgress','acceleration']);
      for (const key of Object.keys(options)) if (!allowed.has(key)) throw fail('JXL_OPTIONS', `Unknown capture option: ${key}.`);
    }
    const {data,width,height,...source} = await image(input, options, hooks);
    check(hooks.signal);
    const codec = {...source,...normalized};
    if (capture) {
      if (!['js','wasm','auto'].includes(options.acceleration ?? 'js')) throw fail('JXL_OPTIONS', 'Captures support js, wasm, or auto acceleration.');
      await acceleration(options.acceleration, 0, 0);
      const {encodeCaptureBytes} = await import('../capture-codec.mjs');
      check(hooks.signal);
      const result = encodeCaptureBytes(data, width, height, {...options, colorSpace: options.colorSpace ?? source.colorSpace, signal: hooks.signal});
      check(hooks.signal); hooks.onProgress?.(1); return result;
    }
    if (options.target !== undefined) {
      targetSource(data, source, codec);
      const {encodeToScoreSteps} = await import('./score-steps.mjs');
      await acceleration(options.acceleration, 0, 0);
      const result = await finish(encodeToScoreSteps(data, width, height, {target: options.target, effort: codec.effort}));
      return result.bytes;
    }
    if (options.format) {
      const {encodePhotoSteps} = await import('../photo-advanced.mjs');
      await acceleration(options.acceleration, 0, 0);
      return finish(encodePhotoSteps(data, width, height, {...codec,...options.format}));
    }
    const gpu = await acceleration(options.acceleration, width, height, codec.quality < 100 ? codec.effort : 0);
    if (codec.effort === 1 && codec.losslessProfile === undefined) {
      const {coreSteps} = await (instant ?? import('./instant.mjs'));
      return drain(coreSteps(data, width, height, codec, !!gpu), hooks, gpu);
    }
    const {effortJob} = await (encoder ?? import('../effort-job.mjs'));
    const search = codec.quality < 100 && codec.effort >= 8 ? (await import('./search.mjs')).searchV6 : undefined;
    check(hooks.signal);
    const steps = effortJob(data, width, height, codec, !!gpu, undefined, search);
    return drive ? drive(steps, hooks, gpu, width * height) : drain(steps, hooks, gpu);
  }
  if (operation === 'recompress') {
    const allowed = new Set(['effort','icc','iccCompression','signal','onProgress','acceleration']);
    for (const key of Object.keys(options)) if (!allowed.has(key)) throw fail('JXL_OPTIONS', `Unknown JPEG option: ${key}.`);
    if (!['js','wasm','auto'].includes(options.acceleration ?? 'js')) throw fail('JXL_OPTIONS', 'JPEG recompression supports js, wasm, or auto acceleration.');
    if (typeof Blob !== 'undefined' && input instanceof Blob) input = new Uint8Array(await input.arrayBuffer());
    bytes(input); jpegDimensions(input, hooks.maxPixels); check(hooks.signal);
    const {ansTranscodeSteps} = await import('../jpeg-ans-effort.mjs');
    await acceleration(options.acceleration ?? 'auto', 0, 0);
    return finish(ansTranscodeSteps(input, {...options, effort: options.effort ?? 7}));
  }
  if (operation === 'restore' || operation === 'decode') {
    if (operation === 'restore') for (const key of Object.keys(options)) if (key !== 'signal' && key !== 'onProgress') throw fail('JXL_OPTIONS', `Unknown restore option: ${key}.`);
    if (typeof Blob !== 'undefined' && input instanceof Blob) input = new Uint8Array(await input.arrayBuffer());
    bytes(input);
    let result;
    if (operation === 'restore') {
      const {restoreJPEG} = await import('../jpeg-reconstruction.mjs');
      check(hooks.signal);
      try { result = restoreJPEG(input); }
      catch (error) {
        if (error?.code !== 'JXL_DICTIONARY') throw error;
        const {brotliDictionary} = await import('../brotli-dictionary.mjs');
        check(hooks.signal); result = restoreJPEG(input, brotliDictionary);
      }
      if (!result) throw fail('JXL_RECONSTRUCTION', 'The file contains no JPEG reconstruction data.');
    } else {
      const [{decodeBands}, {decodeOptions}, {loadPart}] = await Promise.all([import('../decode-parallel.mjs'), import('../decode-image.mjs'), import('../decode-parts.mjs')]);
      check(hooks.signal);
      const limits = {...options, maxPixels: Math.min(options.maxPixels ?? Infinity, hooks.maxPixels ?? 40000000)};
      let dictionary;
      for (;;) try { result = decodeBands(input, decodeOptions(dictionary ? {...limits, dictionary} : limits)); break; }
      catch (error) {
        if (await loadPart(error)) { check(hooks.signal); continue; }
        if (error?.code !== 'JXL_DICTIONARY' || dictionary) throw error;
        ({brotliDictionary: dictionary} = await import('../brotli-dictionary.mjs'));
        check(hooks.signal);
      }
    }
    check(hooks.signal); hooks.onProgress?.(1); return result;
  }
  if (operation === 'animate') {
    if (options.target !== undefined || options.format !== undefined)
      throw fail('JXL_OPTIONS', 'Animation does not accept still-image target or format options.');
    const codec = encodeOptions(options);
    dimensions(input?.width, input?.height, hooks.maxPixels);
    await acceleration(options.acceleration, 0, 0);
    const {encodeAnimationJob} = await import('../animation-steps.mjs');
    if (codec.quality < 100 && codec.effort >= 8) (await import('../animation-frames.mjs')).useMeasuredSearch((await import('./search.mjs')).searchV6);
    return finish(encodeAnimationJob(input, codec));
  }
  if (operation === 'format') {
    const {author} = await import('./author.mjs');
    return author(input, options, hooks);
  }
  throw fail('JXL_OPERATION', `Unknown operation: ${operation}.`);
}
