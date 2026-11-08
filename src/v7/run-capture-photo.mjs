// SPDX-License-Identifier: MIT
import {runCaptureUsing, finished} from './run-capture.mjs';
import {capturePhotoRunner} from './capture-photo-runner.mjs';
export {prepareCapturePhoto} from './capture-photo-runner.mjs';
import {CAPTURE_TOOLS_LEAN} from '../capture-codec.mjs';
import {qualityLooks} from '../photo-region-search.mjs';
import {regionPhotoFrameSteps} from '../photo-rgb.mjs';
import {fileStage} from '../capture-patched.mjs';
import {planeSearchSteps} from '../photo-plane-search.mjs';
import {planeMeasuredSteps} from '../photo-plane-measured.mjs';
import {blockSearchOptions} from '../photo-v6.mjs';
import {scoreSteps, AQ, CANDIDATES} from '../photo-search.mjs';
import {runPhotoLadder} from './capture-photo-ladder.mjs';
import {wholePhotoOutputSteps} from './whole-photo.mjs';
import {nativePhotoOutputMeasure} from './native-photo-output-measure.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';

const search = {blocks: planeSearchSteps, options: blockSearchOptions, measured: planeMeasuredSteps,
  score: scoreSteps, aq: AQ, candidates: CANDIDATES};
const floorFrame = options => !!options.floorImage;
const policy = {qualityLooks, regionPhotoFrameSteps: (rows, width, height, options) =>
  fileStage('photo-frame', () => regionPhotoFrameSteps(rows, width, height, {...options, photoSearch: search}), bytes => bytes,
    options.photoAdmission, floorFrame(options)), photoSearch: search};
const wholePhoto = (data, width, height, options) =>
  wholePhotoOutputSteps(data, width, height, {...options, maxPixels: width * height}, nativePhotoOutputMeasure);

export function captureRunner(tools = CAPTURE_TOOLS_LEAN, backend = {}) {
  const measuredBackend = {...backend, answerer(coding, pixels) {
    const provided = backend.answerer?.(coding, pixels);
    if ((coding.photoBlockEffort ?? coding.effort ?? 3) < 4) return provided;
    return Promise.resolve(provided).then(answer => {
      const pending = new Set();
      return Object.assign(value => {
        if (value.photoOutput !== true) return answer?.(value) ?? null;
        const promise = Promise.resolve(value.await);
        pending.add(promise);
        promise.then(() => pending.delete(promise), () => pending.delete(promise));
        return promise;
      }, {options: answer?.options, async retire() {
        let failed = false, failure;
        try { await answer?.retire?.(); } catch (error) { failed = true; failure = error; }
        await Promise.allSettled(pending);
        if (failed) throw failure;
      }});
    });
  }};
  return capturePhotoRunner(tools, measuredBackend, ({input, options, hooks, coding, photo, exact}) => {
    const asked = options.effort ?? 3;
    coding = {...coding, photoSearch: search, wholePhoto};
    if (asked < MEASURED_EFFORT)
      return runCaptureUsing(input, options, hooks, coding, photo);
    return runPhotoLadder({policy, input, options, hooks, coding, photo, exact,
      runCaptureUsing, finished});
  });
}
