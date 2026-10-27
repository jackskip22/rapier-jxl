// SPDX-License-Identifier: MIT
/** Shared transport for capture and photo. The page client serializes images. */
export function installEncoderWorker(encode, scope = globalThis) {
  let busy = false;
  scope.addEventListener('message', async ({data: request}) => {
    const release = () => { if (typeof ImageBitmap === 'function' && request?.source instanceof ImageBitmap) request.source.close(); };
    if (!request || !Number.isSafeInteger(request.id)) { release(); return; }
    const sendError = error => scope.postMessage({id: request.id, ok: false, error: {
      name: typeof error?.name === 'string' ? error.name : 'Error',
      code: typeof error?.code === 'string' ? error.code : 'JXL_ENCODE',
      message: error?.message === undefined ? String(error) : String(error.message)
    }});
    if (busy) { release(); sendError(Object.assign(new Error('The encoder worker is busy.'), {code: 'JXL_BUSY'})); return; }
    if (request.operation !== 'image') { release(); sendError(Object.assign(new Error('This worker encodes still images.'), {code: 'JXL_OPERATION'})); return; }
    busy = true;
    try {
      let last = -1, at = 0;
      const onProgress = request.progress ? value => {
        const now = performance.now();
        if (!Number.isFinite(value) || value < 0 || value <= last || value > 1 || value < 1 && now - at < 50) return;
        last = value; at = now; scope.postMessage({id: request.id, progress: value});
      } : undefined;
      const bytes = await encode(request.source, {...request.options, onProgress});
      scope.postMessage({id: request.id, ok: true, bytes}, [bytes.buffer]);
    } catch (error) { sendError(error); }
    finally {
      release();
      busy = false;
    }
  });
  scope.postMessage({protocol: 'rapier-jxl', version: 1});
}
