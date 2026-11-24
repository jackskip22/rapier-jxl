// SPDX-License-Identifier: MIT
import {fail, check} from './primitives.mjs';
import {measure} from './ownership.mjs';
import {videoFrame} from './video.mjs';
import {WINDOW_BYTES} from './frame-source.mjs';

const STEP = 1 / 60;
const waitFor = (video, signal, ready) => new Promise((resolve, reject) => {
  let cleanup, settled = false, position = video.currentTime;
  const end = () => { settled = true; clearTimeout(timer); video.removeEventListener('timeupdate', advanced); video.removeEventListener('error', broken); signal?.removeEventListener('abort', stop); if (typeof cleanup === 'function') cleanup(); };
  const broken = () => { end(); reject(fail('JXL_INPUT', `video play: ${video.error?.message || 'decode failed'}`)); };
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

export async function readVideo(source, signal, read, maxPixels) {
  const reader = await videoFrames(source, signal, read, maxPixels), frames = [];
  for (let frame; (frame = await reader.next()); ) frames.push({data: frame.data, duration: frame.duration});
  return {width: reader.width, height: reader.height, loops: 0, frames};
}

export async function videoFrames(source, signal, read, maxPixels = Infinity, reserve) {
  if (typeof document === 'undefined') throw fail('JXL_PLATFORM', "video: browser page or decoded frames {width, height, frames}");
  const offered = [], halt = new AbortController();
  let taken = null, waiting = null, ended = false, failure = null, sized, resumePlay = null, given = 0, video;
  const wake = () => { const run = waiting; waiting = null; run?.(); };
  const stopped = () => halt.signal.aborted ? halt.signal.reason : null;
  const caller = signal;
  if (caller) { if (caller.aborted) halt.abort(caller.reason); else caller.addEventListener('abort', () => halt.abort(caller.reason), {once: true}); }
  const size = new Promise((resolve, reject) => { sized = {resolve, reject}; });
  size.catch(() => {});
  const offer = async frame => {
    offered.push(frame); given++; wake();
    if (offered.length < 2) return;
    const resume = resumePlay && !video.paused && !video.ended;
    if (resume) video.pause();
    while (offered.length > 1) {
      check(halt.signal);
      await new Promise(resolve => { taken = resolve; halt.signal.addEventListener('abort', resolve, {once: true}); });
    }
    check(halt.signal);
    if (resume) resumePlay();
  };
  const reading = (async () => { try { await readFrames(); } catch (error) { failure = stopped() ?? error; sized.reject(failure); } finally { ended = true; wake(); } })();
  const next = async () => {
    for (;;) {
      if (offered.length) { const frame = offered.shift(); const resume = taken; taken = null; resume?.(); return frame; }
      if (failure) throw failure;
      if (ended) return null;
      await new Promise(resolve => { waiting = resolve; });
    }
  };
  const stop = () => { if (!halt.signal.aborted) halt.abort(fail('JXL_INPUT', 'video read stopped')); taken?.(); return reading; };
  const {width, height} = await size;
  return {width, height, next, stop};

  async function readFrames() {
    signal = halt.signal;
    video = document.createElement('video');
    const blob = !(source instanceof HTMLVideoElement);
    if (!blob && source.srcObject) throw fail('JXL_INPUT', "live video: record Blob");
    const address = blob ? URL.createObjectURL(source) : source.currentSrc || source.src;
    let attached = false;
    const attach = () => {
      if (attached) return;
      video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      video.setAttribute('aria-hidden', 'true');
      (document.body || document.documentElement).append(video); attached = true;
    };
    if (!address) throw fail('JXL_INPUT', "video src: required");
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
      if (!Number.isFinite(length)) throw fail('JXL_INPUT', "video duration: finished file or decoded frames");
      if (!video.videoWidth || !video.videoHeight) throw fail('JXL_INPUT', "video frames: missing");
      let width, height, context;
      let kept = null, last = null;
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
            if (width * height > maxPixels) throw fail('JXL_DIMENSIONS', `video ${width}x${height} px: exceeds maxPixels; resize or raise maxPixels`);
            room();
            context = new OffscreenCanvas(width, height).getContext('2d', {willReadFrequently: true});
            context.globalCompositeOperation = 'copy';
            sized.resolve({width, height});
          } else if (fw !== width || fh !== height) throw fail('JXL_INPUT', `Video changes size mid-clip (${width} x ${height} to ${fw} x ${fh}); pass a single-size clip or its decoded frames.`);
          room();
          context.clearRect(0, 0, width, height);
          context.drawImage(frame ?? video, 0, 0, width, height);
          const data = context.getImageData(0, 0, width, height).data, took = (performance.now() - start) / 1000;
          cost = cost ? cost * 0.8 + took * 0.2 : took;
          return {time, data};
        } catch (cause) {
          if (cause?.code === 'JXL_INPUT' || cause?.code === 'JXL_DIMENSIONS' || cause?.code === 'JXL_MEMORY') throw cause;
          throw Object.assign(cause instanceof RangeError ? fail('JXL_MEMORY', `video frame ${given + 1}: smaller clip`)
            : fail('JXL_INPUT', `video read: ${cause?.message || cause}, CORS`), {cause});
        } finally { frame?.close(); }
      };
      let latest = -1;
      const budget = reserve ? Infinity : WINDOW_BYTES;
      const fields = measure({data: null, duration: 0}, Infinity), frameBytes = () => width * height * 4 + fields;
      let pending = 0, pendingFrames = 0;
      const room = () => {
        const held = (kept ? 1 : 0) + offered.length + pendingFrames, need = (held + 1) * frameBytes();
        if (need > budget) throw fail('JXL_MEMORY', `video ${width}x${height}: memory ${held} frames, smaller clip`);
        reserve?.(need, width, height);
      };
      const push = async ({time, data}) => {
        if (time >= length) return;
        latest = time;
        const words = new Uint32Array(data.buffer);
        if (!last || words.some((word, i) => word !== last[i])) {
          if (kept) await offer({data: kept.data, duration: (time - kept.time) * 1000, read: Math.min(1, time / length)});
          kept = {data, time}; last = words; room();
        }
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
          shown.cost = frameBytes(); found.push(shown); pending += shown.cost; pendingFrames++; room();
        }
        for (const shown of found.reverse()) { pending -= shown.cost; pendingFrames--; await push(shown); }
      };
      const sample = async () => {
        if (!Number.isFinite(length)) throw fail('JXL_INPUT', "video duration: visible page or decoded frames");
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
              shown.cost = frameBytes(); pending += shown.cost; pendingFrames++; room();
              await between(at, shown.time);
              pending -= shown.cost; pendingFrames--;
            }
            shortest = Math.min(shortest, shown.time - latest);
          }
          await push(shown); at = shown.time;
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
          await push(first); at = first.time;
          let donePlay, stop;
          const stopped = new Promise((resolve, reject) => { donePlay = () => resolve(null); stop = reject; });
          stopped.catch(() => {});
          const play = () => video.ended ? donePlay() : video.play().catch(error => video.ended && error?.name === 'AbortError' ? donePlay()
            : stop(fail('JXL_INPUT', `video play: ${error?.message || error}`)));
          let end = ended(), next = presented();
          resumePlay = play;
          play();
          for (let meta; (meta = await waitFor(video, signal, (done, refuse) => Promise.race([next, end, stopped]).then(done, refuse))); ) {
            next = presented();
            const {presentedFrames} = meta, shown = grab(meta.mediaTime), {time} = shown;
            if (!frameClock) {
              video.pause(); resumePlay = null; pending = pendingFrames = 0;
              if (!given) { kept = null; last = null; latest = -1; }
              await sample(); break;
            }
            if (time <= at) { seen = presentedFrames; continue; }
            if (seen < 0 || presentedFrames > seen + 1 || time - at > shortest * 1.5 + 1e-4) {
              video.pause();
              shown.cost = frameBytes(); pending += shown.cost; pendingFrames++; room();
              await between(at, time);
              next = presented();
              await seek(time);
              pending -= shown.cost; pendingFrames--;
              if (!video.ended) play();
            }
            shortest = Math.min(shortest, time - latest);
            await push(shown); at = time;
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
      resumePlay = null;
      if (!kept) throw fail('JXL_INPUT', "video frames: missing");
      await offer({data: kept.data, duration: (length - kept.time) * 1000, read: 1}); kept = last = null;
    } finally {
      video.removeAttribute('src'); video.load();
      if (blob) URL.revokeObjectURL(address);
      if (attached) video.remove();
    }
  }
}
