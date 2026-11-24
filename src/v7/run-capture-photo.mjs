// SPDX-License-Identifier: MIT
import {DECODER_SNAPSHOT} from '../shown-picture.mjs';
import {runCaptureUsing, finished} from './run-capture.mjs';
import {capturePhotoRunner} from './capture-photo-runner.mjs';
export {prepareCapturePhoto} from './capture-photo-runner.mjs';
import {CAPTURE_TOOLS_LEAN} from '../capture-codec.mjs';
import {qualityLooks} from '../photo-region-search.mjs';
import {regionPhotoFrameSteps} from '../photo-rgb.mjs';
import {fileStage} from '../capture-patched.mjs';
import {SHARED_PHOTO_SEARCH as search} from '../photo-plane-measured.mjs';
import {runPhotoLadder} from './capture-photo-ladder.mjs';
import {wholePhotoOutputSteps} from './whole-photo.mjs';
import {rebuiltPhotoOutputMeasure} from './rebuilt-photo-output-measure.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {measuredLook} from '../photo-quality-table.mjs';


const floorFrame = options => !!options.floorImage;
const policy = {qualityLooks, regionPhotoFrameSteps: (rows, width, height, options) =>
  fileStage('photo-frame', () => regionPhotoFrameSteps(rows, width, height, {...options, photoSearch: search}), bytes => bytes,
    options.photoAdmission, floorFrame(options)), photoSearch: search};
const wholePhoto = (data, width, height, options) =>
  wholePhotoOutputSteps(data, width, height, {...options, maxPixels: width * height}, rebuiltPhotoOutputMeasure);

export function captureRunner(tools = CAPTURE_TOOLS_LEAN, backend = {}) {
  const measuredBackend = {...backend, answerer(coding, pixels, ran) {
    const provided = backend.answerer?.(coding, pixels, ran);
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
    const asked = options.effort ?? 3, hasSnap = !!(options.fidelity && DECODER_SNAPSHOT in options.fidelity);
    const ownWholePhoto = hasSnap ? (data, width, height, opts) => wholePhoto(data, width, height, {...opts, [DECODER_SNAPSHOT]: options.fidelity[DECODER_SNAPSHOT]}) : wholePhoto;
    const look = asked >= MEASURED_EFFORT && coding.readingIntent !== undefined ? measuredLook(coding.readingIntent) : undefined;
    coding = {...coding, photoSearch: search, wholePhoto: ownWholePhoto, ...(look !== undefined && {readingLook: look})};
    if (asked < MEASURED_EFFORT)
      return runCaptureUsing(input, options, hooks, coding, photo);
    return runPhotoLadder({policy, input, options, hooks, coding, photo, exact,
      runCaptureUsing, finished});
  });
}
