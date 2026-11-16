// SPDX-License-Identifier: MIT
import {fail, check} from './primitives.mjs';
import {measure} from './ownership.mjs';
import {videoFrame} from './video.mjs';

const STEP = 1 / 60;
const waitFor = (video, signal, ready) => new Promise((resolve, reject) => {
  let cleanup, settled = false, position = video.currentTime;
  const end = () => { settled = true; clearTimeout(timer); video.removeEventListener('timeupdate', advanced); video.removeEventListener('error', broken); signal?.removeEventListener('abort', stop); if (typeof cleanup === 'function') cleanup(); };
  const broken = () => { end(); reject(fail('JXL_INPUT', `Video cannot be played: ${video.error?.message || 'the browser cannot decode it'}.`)); };
  const stop = () => { end(); try { check(signal); } catch (error) { reject(error); } };
  const stalled = () => { end(); reject(fail('JXL_INPUT', "Video did not become ready or advance for 10 seconds; try another browser or pass decoded frames.")); };
  let timer = setTimeout(stalled, 10000);
  const advanced = () => { if (video.currentTime !== position) { position = video.currentTime; clearTimeout(timer); timer = setTimeout(stalled, 10000); } };
  video.addEventListener('timeupdate', advanced);
  video.addEventListener('error', broken, {once: true});
  signal?.addEventListener('abort', stop, {once: true});
  try {
    check(signal);
    cleanup = ready(value => { end(); resolve(value); }, error => { end(); reject(error); });
    if (settled && typeof cleanup === 'function') cleanup();
  } catch (error) { end(); reject(error); }
});
const once = (video, type) => resolve => { video.addEventListener(type, resolve, {once: true}); return () => video.removeEventListener(type, resolve); };

export async function readVideo(source, signal, read, maxPixels = Infinity, reserve) {
  if (typeof document === 'undefined') throw fail('JXL_PLATFORM', "Video is read by a page; call encode on the page, or pass decoded frames {width, height, frames}.");
  const video = document.createElement('video'), blob = !(source instanceof HTMLVideoElement);
  if (!blob && source.srcObject) throw fail('JXL_INPUT', "Live video has no end; record it to a Blob first.");
  const address = blob ? URL.createObjectURL(source) : source.currentSrc || source.src;
  let attached = false;
  const attach = () => {
    if (attached) return;
    video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    video.setAttribute('aria-hidden', 'true');
    (document.body || document.documentElement).append(video); attached = true;
  };
  if (!address) throw fail('JXL_INPUT', "Video has no source; set its src.");
  if (!blob && source.crossOrigin !== null) video.crossOrigin = source.crossOrigin;
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  try {
    if (typeof VideoFrame !== 'function') attach();
    video.src = address;
    await waitFor(video, signal, done => video.readyState >= 2 ? done() : once(video, 'loadeddata')(done));
    if (!Number.isFinite(video.duration)) {
      const known = new Promise(resolve => video.addEventListener('durationchange', resolve));
      video.currentTime = 1e101;
      await waitFor(video, signal, done => Promise.race([known, new Promise(resolve => setTimeout(resolve, 2000))]).then(done));
    }
    const length = video.duration;
    if (!Number.isFinite(length)) throw fail('JXL_INPUT', "Video has no known length; save it as a finished file, or pass its decoded frames.");
    if (!video.videoWidth || !video.videoHeight) throw fail('JXL_INPUT', "Video has no frames.");
    let width, height, context;
    const frames = [];
    let last = null;
    let cost = 0, frameClock = true, positionClock = false, frameEnd = 0, stamped, advancedAt = performance.now();
    const grab = time => {
      check(signal);
      const start = performance.now();
      let frame;
      try {
        if (typeof VideoFrame === 'function') {
          frame = new VideoFrame(video);
          if (positionClock) {
            if (frame.timestamp !== stamped) { stamped = frame.timestamp; advancedAt = start; }
            else if (start - advancedAt >= 10000)
              throw fail('JXL_INPUT', "Video decoding did not advance for 10 seconds; save a finished file or pass decoded frames.");
          }
          if (frame.duration === null && Math.abs(frame.timestamp / 1e6 - time) > 1e-6) frameClock = false;
          if (frameClock) time = frame.timestamp / 1e6;
          frameEnd = frameClock && frame.duration > 0 ? time + frame.duration / 1e6 : 0;
        }
        const fw = frame ? frame.visibleRect.width : video.videoWidth, fh = frame ? frame.visibleRect.height : video.videoHeight;
        if (!context) {
          width = fw; height = fh;
          if (width * height > maxPixels) throw fail('JXL_DIMENSIONS', `Video is ${width} x ${height}, over maxPixels; pass a smaller clip or raise maxPixels.`);
          room();
          context = new OffscreenCanvas(width, height).getContext('2d', {willReadFrequently: true});
          context.globalCompositeOperation = 'copy';
        } else if (fw !== width || fh !== height) throw fail('JXL_INPUT', `Video changes size mid-clip (${width} x ${height} to ${fw} x ${fh}); pass a single-size clip or its decoded frames.`);
        room();
        context.clearRect(0, 0, width, height);
        context.drawImage(frame ?? video, 0, 0, width, height);
        const data = context.getImageData(0, 0, width, height).data, took = (performance.now() - start) / 1000;
        cost = cost ? cost * 0.8 + took * 0.2 : took;
        return {time, data};
      } catch (cause) {
        if (cause?.code === 'JXL_INPUT' || cause?.code === 'JXL_DIMENSIONS' || cause?.code === 'JXL_MEMORY') throw cause;
        throw Object.assign(cause instanceof RangeError ? fail('JXL_MEMORY', `Not enough memory for frame ${frames.length + 1} of this video; pass a shorter or smaller clip.`)
          : fail('JXL_INPUT', `Video cannot be read: ${cause?.message || cause}; serve it with CORS.`), {cause});
      } finally { frame?.close(); }
    };
    let latest = -1;
    const budget = reserve ? Infinity : (navigator.deviceMemory > 0 ? navigator.deviceMemory : 4) * 2 ** 30 / 8;
    const empty = measure({}, Infinity), frameFields = measure({data: null, duration: 0}, Infinity);
    const header = measure({width: 1, height: 1, loops: 0, frames: []}, Infinity);
    const frameBytes = index => width * height * 4 + frameFields + measure({[index]: null}, Infinity) - empty;
    let held = 0, pending = 0, pendingFrames = 0;
    const room = () => {
      const need = header + held + pending + frameBytes(frames.length + pendingFrames);
      if (need > budget) throw fail('JXL_MEMORY', `Video is too long for this device's memory at ${width} x ${height} (${frames.length + pendingFrames} frames held); shorten or shrink the clip.`);
      reserve?.(need);
    };
    const push = ({time, data}) => {
      if (time >= length) return;
      latest = time;
      const words = new Uint32Array(data.buffer);
      if (!last || words.some((word, i) => word !== last[i])) { held += frameBytes(frames.length); frames.push({data, time}); last = words; room(); }
      if (Number.isFinite(length) && length > 0) read(Math.min(1, time / length));
    };
    let showing = 0;
    const presented = () => { attach(); return new Promise(resolve => video.requestVideoFrameCallback((now, meta) => { showing = meta.mediaTime; resolve(meta); })); };
    const ended = () => new Promise(resolve => video.addEventListener('ended', () => resolve(null), {once: true}));
    const seekTo = time => waitFor(video, signal, done => {
      let sought = false;
      const ready = () => { if (sought && !video.seeking && video.readyState >= 2) done(); };
      const seeked = () => { sought = true; ready(); };
      const cleanup = () => { video.removeEventListener('seeked', seeked); video.removeEventListener('loadeddata', ready); video.removeEventListener('canplay', ready); };
      video.addEventListener('seeked', seeked); video.addEventListener('loadeddata', ready); video.addEventListener('canplay', ready);
      try { video.currentTime = time; } catch (error) { cleanup(); throw error; }
      return cleanup;
    });
    const seek = async time => {
      await seekTo(time);
      if (typeof video.requestVideoFrameCallback === 'function' && document.visibilityState !== 'hidden')
        await waitFor(video, signal, done => Promise.race([presented(), new Promise(resolve => setTimeout(resolve, 150))]).then(done));
      for (let tries = 0, before = -1; ; tries++) {
        const shown = grab(typeof VideoFrame === 'function' ? showing : time);
        if (shown.time <= time + 1e-6 && shown.time === before || tries === 20) return shown;
        before = shown.time;
        await waitFor(video, signal, done => setTimeout(done, 30));
      }
    };
    const between = async (from, to) => {
      const found = [];
      for (let end = to, shown; (shown = await seek(Math.max(from, end - 1e-3))).time > from + 1e-6 && shown.time < end; end = shown.time) {
        shown.cost = frameBytes(frames.length + pendingFrames); found.push(shown); pending += shown.cost; pendingFrames++; room();
      }
      for (const shown of found.reverse()) { pending -= shown.cost; pendingFrames--; push(shown); }
    };
    const sample = async () => {
      if (!Number.isFinite(length)) throw fail('JXL_INPUT', "Video has no known length to step through; keep the page visible, or pass its decoded frames.");
      let at = -1, shortest = Infinity, checkedAgain = false;
      for (let index = 0; index * (STEP / 2) < length; index++) {
        const time = index * (STEP / 2);
        let shown;
        if (typeof VideoFrame === 'function') { await seekTo(time); shown = grab(time); }
        else shown = await seek(time);
        if (frameClock && frameEnd > time + STEP / 2) index = Math.max(index, Math.ceil(frameEnd / (STEP / 2)) - 1);
        if (shown.time < latest) continue;
        if (frameClock && typeof VideoFrame === 'function' && at >= 0 && shown.time > at) {
          if (!Number.isFinite(shortest) || shown.time - at > shortest * 1.5 + 1e-4) {
            shown.cost = frameBytes(frames.length + pendingFrames); pending += shown.cost; pendingFrames++; room();
            await between(at, shown.time);
            pending -= shown.cost; pendingFrames--;
          }
          shortest = Math.min(shortest, shown.time - latest);
        }
        push(shown); at = shown.time;
        if (!frameClock && !positionClock && !checkedAgain) { checkedAgain = true; await namesFrames(); frameClock = false; }
      }
      if (frameClock && typeof VideoFrame === 'function') await between(at, length + 1e-3);
    };
    const namesFrames = async () => {
      if (typeof VideoFrame !== 'function' || !Number.isFinite(length)) return frameClock = false;
      const stamps = [];
      for (const time of [Math.min(2e-4, length / 8), Math.min(4e-4, length / 4)]) {
        await seekTo(time);
        const frame = videoFrame(video);
        stamps.push(frame.timestamp); frame.close();
      }
      positionClock = stamps[0] !== stamps[1];
      return frameClock = !positionClock;
    };
    const native = await namesFrames();
    if (typeof video.requestVideoFrameCallback === 'function' && document.visibilityState !== 'hidden' && native) {
      const most = () => Math.min(1, shortest * 30, cost ? shortest / cost / 2 : 1);
      let at = -1, seen = -1, shortest = Infinity;
      const first = await seek(0);
      if (frameClock) await namesFrames();
      if (!frameClock) await sample();
      else {
        push(first); at = first.time;
        let donePlay, stop;
        const stopped = new Promise((resolve, reject) => { donePlay = () => resolve(null); stop = reject; });
        stopped.catch(() => {});
        const play = () => video.ended ? donePlay() : video.play().catch(error => video.ended && error?.name === 'AbortError' ? donePlay()
          : stop(fail('JXL_INPUT', `Video cannot be played: ${error?.message || error}.`)));
        let end = ended(), next = presented();
        play();
        for (let meta; (meta = await waitFor(video, signal, (done, refuse) => Promise.race([next, end, stopped]).then(done, refuse))); ) {
          next = presented();
          const {presentedFrames} = meta, shown = grab(meta.mediaTime), {time} = shown;
          if (!frameClock) {
            video.pause(); frames.length = 0; last = null; held = pending = pendingFrames = 0; latest = -1;
            await sample(); break;
          }
          if (time <= at) { seen = presentedFrames; continue; }
          if (seen < 0 || presentedFrames > seen + 1 || time - at > shortest * 1.5 + 1e-4) {
            video.pause();
            shown.cost = frameBytes(frames.length + pendingFrames); pending += shown.cost; pendingFrames++; room();
            await between(at, time);
            next = presented();
            await seek(time);
            pending -= shown.cost; pendingFrames--;
            if (!video.ended) play();
          }
          shortest = Math.min(shortest, time - latest);
          push(shown); at = time;
          seen = presentedFrames;
          if (video.playbackRate !== most()) {
            try { video.playbackRate = most(); }
            catch (error) { if (error?.name !== 'NotSupportedError') throw fail('JXL_INPUT', `Video playback rate cannot be set: ${error?.message || error}.`); }
          }
          if (video.ended) break;
        }
        if (frameClock && Number.isFinite(length)) await between(at, length + 1e-3);
      }
    } else await sample();
    if (!frames.length) throw fail('JXL_INPUT', "Video has no frames.");
    const end = length;
    return {width, height, loops: 0, frames: frames.map(({data}, i) => ({data, duration: ((frames[i + 1]?.time ?? end) - frames[i].time) * 1000}))};
  } finally {
    video.removeAttribute('src'); video.load();
    if (blob) URL.revokeObjectURL(address);
    if (attached) video.remove();
  }
}
