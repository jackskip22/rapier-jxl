// SPDX-License-Identifier: MIT
const CDN = 'https://cdn.jsdelivr.net/npm/jpegxl@8.5.0/dist';
const config = window.rapierJxlAdmin || {};

function restBaseUrl() {
  if (config.restUrl) return config.restUrl.replace(/\/$/, '');
  const root = window.wpApiSettings?.root;
  return root ? root.replace(/\/$/, '') + '/rapier-jxl/v1' : '';
}

function currentNonce() {
  return window.wpApiSettings?.nonce || config.nonce || '';
}

const WORKER_SOURCE = `
import {encode, configureDecoder as configureEncodeDecoder} from '${CDN}/index.mjs';
import {recompress, restore} from '${CDN}/jpeg.mjs';
import {decode} from '${CDN}/decode.mjs';
import {verify, configureDecoder as configureVerifyDecoder} from '${CDN}/verify.mjs';

configureEncodeDecoder(decode, restore, recompress);
configureVerifyDecoder(decode, restore, recompress);

function ownBytes(view) {
  if (!(view instanceof Uint8Array)) return new Uint8Array(view);
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view;
  return view.slice();
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function pixelsToRaster(data, width, height, mime, quality) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
  const blob = await canvas.convertToBlob({type: mime, ...(quality ? {quality} : {})});
  const out = new Uint8Array(await blob.arrayBuffer());
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(new Blob([out], {type: mime}));
    const valid = bmp.width === width && bmp.height === height;
    bmp.close();
    if (!valid) {
      throw new Error('Fallback raster dimensions did not match decoded image');
    }
  }
  return out;
}

function tagCodecError(error) {
  const tagged = error instanceof Error ? error : new Error(String(error));
  tagged.isCodecError = true;
  return tagged;
}

async function encodeItem({url, mime, expectedSha256, makeFallback}) {
  const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('Source fetch failed: ' + response.status);
  const raw = new Uint8Array(await response.arrayBuffer());
  const sourceSha = await sha256Hex(raw);
  if (expectedSha256 && sourceSha !== expectedSha256) {
    throw tagCodecError(new Error('Source hash mismatch before encoding'));
  }

  try {
    if (mime === 'image/jpeg') {
      const packed = await recompress(raw);
      if (!packed.meetsTarget || !packed.bytes?.byteLength) {
        throw new Error(packed.reason?.message || 'JPEG recompression missed target');
      }
      const restored = await restore(packed.bytes);
      const restoredSha256 = await sha256Hex(restored.bytes);
      if (restoredSha256 !== sourceSha || restored.bytes.byteLength !== raw.byteLength) {
        throw new Error('Restored JPEG did not match the server JPEG');
      }
      const check = await verify(raw, packed);
      if (!check || check.verified !== true) {
        throw new Error('JPEG XL reconstruction verification failed');
      }
      return {
        jxlBytes: ownBytes(packed.bytes),
        kept: 'jpeg-bytes',
        hasAlpha: false,
        verified: true,
        restoredSha256,
        fallbackBytes: null,
        fallbackMime: '',
      };
    }

    const blob = new Blob([raw], {type: mime});
    const encoded = await encode(blob);
    if (!encoded.meetsTarget || !encoded.bytes?.byteLength) {
      throw new Error(encoded.reason?.message || 'Image encoding missed target');
    }
    const decoded = await decode(encoded.bytes, {format: 'uint8', colorSpace: 'srgb'});

    let hasAlpha = false;
    for (let i = 3; i < decoded.data.length; i += 4) {
      if (decoded.data[i] < 255) {
        hasAlpha = true;
        break;
      }
    }

    const checkTarget = encoded.kept === 'pixels' ? {...encoded, fidelity: 'exact'} : encoded;
    const check = await verify(blob, checkTarget);
    if (!check || check.verified !== true) {
      throw new Error('Decoded JPEG XL verification failed');
    }

    let fallbackBytes = null;
    let fallbackMime = '';
    if (makeFallback) {
      const usePng = Boolean(hasAlpha || encoded.kept === 'pixels');
      fallbackMime = usePng ? 'image/png' : 'image/jpeg';
      fallbackBytes = await pixelsToRaster(
        decoded.data,
        decoded.width,
        decoded.height,
        fallbackMime,
        usePng ? undefined : 0.88
      );
    }

    return {
      jxlBytes: ownBytes(encoded.bytes),
      kept: encoded.kept === 'pixels' ? 'pixels' : 'lossy',
      hasAlpha,
      verified: true,
      restoredSha256: '',
      fallbackBytes: fallbackBytes ? ownBytes(fallbackBytes) : null,
      fallbackMime,
    };
  } catch (error) {
    throw tagCodecError(error);
  }
}

async function restoreItem({jxlUrl, kept, hasAlpha, expectedSha256}) {
  const response = await fetch(jxlUrl, {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('JPEG XL fetch failed: ' + response.status);
  const jxlBytes = new Uint8Array(await response.arrayBuffer());

  if (kept === 'jpeg-bytes') {
    const restored = await restore(jxlBytes);
    const sha256 = await sha256Hex(restored.bytes);
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error('Restored JPEG hash mismatch');
    }
    return {bytes: ownBytes(restored.bytes), mime: 'image/jpeg', ext: 'jpg', sha256};
  }

  const decoded = await decode(jxlBytes, {format: 'uint8', colorSpace: 'srgb'});
  const usePng = Boolean(hasAlpha || kept === 'pixels');
  const mime = usePng ? 'image/png' : 'image/jpeg';
  const ext = usePng ? 'png' : 'jpg';
  const bytes = await pixelsToRaster(
    decoded.data,
    decoded.width,
    decoded.height,
    mime,
    usePng ? undefined : 0.92
  );
  return {bytes: ownBytes(bytes), mime, ext, sha256: ''};
}

self.onmessage = async ({data}) => {
  const {jobId, command, payload} = data;
  try {
    const result = command === 'encode' ? await encodeItem(payload) : await restoreItem(payload);
    const buffers = new Set();
    if (result.jxlBytes?.buffer) buffers.add(result.jxlBytes.buffer);
    if (result.fallbackBytes?.buffer) buffers.add(result.fallbackBytes.buffer);
    if (result.bytes?.buffer) buffers.add(result.bytes.buffer);
    self.postMessage({jobId, ok: true, result}, [...buffers]);
  } catch (error) {
    self.postMessage({
      jobId,
      ok: false,
      error: error?.message || String(error),
      isCodecError: Boolean(error?.isCodecError),
    });
  }
};
`;

let workerPromise = null;
let nextJobId = 1;
let pageUnloading = false;
let pluploadTimer = null;
let pollTimer = null;
const pendingJobs = new Map();
const codecFailures = new Map();

function markUnloading() {
  pageUnloading = true;
  if (pluploadTimer) {
    clearInterval(pluploadTimer);
    pluploadTimer = null;
  }
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

window.addEventListener('beforeunload', markUnloading);
window.addEventListener('pagehide', markUnloading);

function getWorker() {
  if (!workerPromise) {
    workerPromise = Promise.resolve().then(() => {
      const blobUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], {type: 'text/javascript'}));
      const worker = new Worker(blobUrl, {type: 'module'});
      worker.addEventListener('message', ({data}) => {
        const entry = pendingJobs.get(data.jobId);
        if (!entry) return;
        pendingJobs.delete(data.jobId);
        if (data.ok) {
          entry.resolve(data.result);
        } else {
          const err = new Error(data.error);
          err.isCodecError = Boolean(data.isCodecError);
          entry.reject(err);
        }
      });
      worker.addEventListener('error', event => {
        workerPromise = null;
        for (const [, entry] of pendingJobs) {
          entry.reject(new Error(event.message || 'JPEG XL worker failed'));
        }
        pendingJobs.clear();
      });
      return worker;
    });
  }
  return workerPromise;
}

async function callWorker(command, payload) {
  const worker = await getWorker();
  const jobId = nextJobId++;
  return new Promise((resolve, reject) => {
    pendingJobs.set(jobId, {resolve, reject});
    worker.postMessage({jobId, command, payload});
  });
}

const nativeFetch = window.fetch.bind(window);

async function apiGet(path) {
  const base = restBaseUrl();
  const nonce = currentNonce();
  const response = await nativeFetch(base + path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {'X-WP-Nonce': nonce},
  });
  if (!response.ok) throw new Error('Request failed: ' + response.status);
  return response.json();
}

async function apiPostForm(fields, fileBytes, fileName, fileMime) {
  const base = restBaseUrl();
  const nonce = currentNonce();
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  if (fileBytes) {
    form.append('file', new Blob([fileBytes], {type: fileMime || 'application/octet-stream'}), fileName);
  }
  const response = await nativeFetch(base + '/file', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'X-WP-Nonce': nonce},
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || ('Upload failed: ' + response.status));
  return body;
}

function showBadge(text) {
  if (typeof document === 'undefined') return;
  let badge = document.getElementById('rapier-jxl-admin-badge');
  if (!text) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'rapier-jxl-admin-badge';
    badge.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#1d2327;color:#fff;padding:8px 12px;border-radius:4px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.22)';
    document.body.appendChild(badge);
  }
  badge.textContent = text;
}

function uploadsInFlight() {
  if (typeof window === 'undefined') return false;
  const watchActive = Number(window.__rapierJxlUploadWatch?.active || 0);
  const pluploadActive = window.uploader && Number(window.uploader.state) === 2 ? 1 : 0;
  return watchActive + pluploadActive > 0;
}

const activeAttachments = new Set();
let draining = false;
let drainAgain = false;

function scheduleDrain(delayMs = 250) {
  if (pageUnloading || typeof window === 'undefined') return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    drainPending();
  }, delayMs);
  pollTimer?.unref?.();
}

async function convertAttachment(attachment, defaultMode) {
  if (attachment.preparing || !Array.isArray(attachment.items) || !attachment.items.length) {
    return;
  }
  if (activeAttachments.has(attachment.id)) return;
  activeAttachments.add(attachment.id);
  try {
    const effectiveMode = attachment.mode || defaultMode;
    let fallbackBytes = null;
    let fallbackMime = '';
    const needBrowserFallback = effectiveMode === 'space_saver' && attachment.originalMime !== 'image/jpeg';

    for (const item of attachment.items) {
      if (pageUnloading) return;
      const makeFallback = needBrowserFallback && item.key === attachment.fallbackKey;
      if (item.verified && !makeFallback) {
        continue;
      }
      showBadge(`Converting ${attachment.title || ('#' + attachment.id)} (${item.key}) to JPEG XL...`);
      const encoded = await callWorker('encode', {
        url: item.url,
        mime: item.mime,
        expectedSha256: item.sha256,
        makeFallback,
      });
      if (makeFallback && encoded.fallbackBytes) {
        fallbackBytes = encoded.fallbackBytes;
        fallbackMime = encoded.fallbackMime;
      }
      await apiPostForm(
        {
          action: 'save_jxl',
          id: attachment.id,
          key: item.key,
          filename: item.jxlFile,
          kept: encoded.kept,
          has_alpha: encoded.hasAlpha ? '1' : '0',
          verified: encoded.verified ? '1' : '0',
          restored_sha256: encoded.restoredSha256 || '',
        },
        encoded.jxlBytes,
        item.jxlFile,
        'image/jxl'
      );
    }

    const fbExt = fallbackMime === 'image/png' ? 'png' : 'jpg';
    const finalized = await apiPostForm(
      {action: 'finalize', id: attachment.id},
      fallbackBytes,
      fallbackBytes ? `fallback.${fbExt}` : undefined,
      fallbackMime || undefined
    );
    codecFailures.delete(attachment.id);
    window.dispatchEvent(new CustomEvent('rapier-jxl:converted', {
      detail: {id: attachment.id, mode: finalized?.mode || effectiveMode},
    }));
  } catch (error) {
    if (pageUnloading) return;
    console.warn('JPEG XL conversion paused or skipped, keeping original image:', error);
    if (error?.isCodecError) {
      const tries = (codecFailures.get(attachment.id) || 0) + 1;
      codecFailures.set(attachment.id, tries);
      if (tries >= 2) {
        await apiPostForm({action: 'abort_pending', id: attachment.id}).catch(() => {});
      } else {
        scheduleDrain(500);
      }
    } else {
      scheduleDrain(600);
    }
  } finally {
    activeAttachments.delete(attachment.id);
  }
}

export async function drainPending() {
  if (pageUnloading || typeof window === 'undefined' || !restBaseUrl() || !currentNonce()) return;
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  let keepPolling = false;
  try {
    do {
      drainAgain = false;
      const state = await apiGet('/queue');
      config.removedCount = state.removedCount || 0;
      const pendingList = state.pending || [];
      let sawPreparing = false;
      for (const att of pendingList) {
        if (pageUnloading) break;
        if (att.preparing) {
          sawPreparing = true;
          continue;
        }
        await convertAttachment(att, state.mode);
      }
      keepPolling = sawPreparing || uploadsInFlight();
    } while (drainAgain && !pageUnloading);
  } catch (error) {
    if (!pageUnloading) {
      console.warn('JPEG XL queue check failed:', error);
    }
  } finally {
    draining = false;
    if (!keepPolling) {
      showBadge('');
    }
    if (keepPolling && !pageUnloading) {
      scheduleDrain(400);
    }
  }
}

export async function restoreAttachmentById(id, onStep, switchToKeep = false) {
  const data = await apiGet('/queue?id=' + encodeURIComponent(id));
  const att = data?.attachment;
  if (!att || !att.removed) return false;
  for (let i = 0; i < att.items.length; i++) {
    const item = att.items[i];
    onStep?.(i, att.items.length, item.key);
    const exactJpeg = item.kept === 'jpeg-bytes';
    const rebuilt = await callWorker('restore', {
      jxlUrl: item.jxlUrl,
      kept: item.kept,
      hasAlpha: item.hasAlpha,
      expectedSha256: exactJpeg ? item.sha256 : '',
    });
    await apiPostForm(
      {action: 'restore_item', id: att.id, key: item.key},
      rebuilt.bytes,
      `restored.${rebuilt.ext}`,
      rebuilt.mime
    );
  }
  await apiPostForm({
    action: 'finish_restore',
    id: att.id,
    ...(switchToKeep ? {switch_to_keep: '1'} : {}),
  });
  return true;
}

window.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input?.url || '');
  const method = String(init?.method || input?.method || 'GET').toUpperCase();

  const editMatch = method === 'POST' && /\/wp\/v2\/media\/(\d+)\/(?:edit|post-process)\b/.exec(url);
  if (editMatch && !url.includes('rapier-jxl/v1') && url.includes('/edit')) {
    showBadge('Restoring image file for editing...');
    await restoreAttachmentById(Number(editMatch[1])).catch(() => {});
    showBadge('');
  }

  const isUploadFetch = method === 'POST' && !url.includes('rapier-jxl/v1') &&
    (/\/wp\/v2\/media(?:\b|\/)/.test(url) || url.includes('async-upload.php') || url.includes('admin-ajax.php'));
  if (isUploadFetch) {
    scheduleDrain(300);
  }
  try {
    return await nativeFetch(input, init);
  } finally {
    if (isUploadFetch) {
      scheduleDrain(150);
    }
  }
};

const prevXhrOpen = XMLHttpRequest.prototype.open;
const prevXhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this._rapierJxlMethod = String(method || 'GET').toUpperCase();
  this._rapierJxlUrl = String(url || '');
  return prevXhrOpen.call(this, method, url, ...rest);
};
XMLHttpRequest.prototype.send = function (body) {
  const url = this._rapierJxlUrl || this._rjUrl || '';
  const method = this._rapierJxlMethod || this._rjMethod || 'GET';
  const bodyText = typeof body === 'string' ? body : '';
  if (method === 'POST' && url.includes('admin-ajax.php') &&
      (bodyText.includes('action=image-editor') || bodyText.includes('regenerate'))) {
    const postMatch = /(?:^|&)(?:postid|id)=(\d+)/.exec(bodyText);
    if (postMatch && !this._rapierJxlRestored) {
      this._rapierJxlRestored = true;
      showBadge('Restoring image file on disk...');
      restoreAttachmentById(Number(postMatch[1]))
        .catch(() => {})
        .finally(() => {
          showBadge('');
          this.addEventListener('loadend', () => scheduleDrain(200), {once: true});
          prevXhrSend.call(this, body);
        });
      return;
    }
  }
  if (method === 'POST' && !url.includes('rapier-jxl/v1') &&
      (url.includes('async-upload.php') || url.includes('admin-ajax.php') || /\/wp\/v2\/media(?:\b|\/)/.test(url))) {
    scheduleDrain(300);
    this.addEventListener('loadend', () => scheduleDrain(150), {once: true});
  }
  return prevXhrSend.call(this, body);
};

function bindUploadHooks() {
  if (window.__rapierJxlUploadWatch) {
    window.__rapierJxlUploadWatch.onActivity = () => scheduleDrain(150);
    if (window.__rapierJxlUploadWatch.dirty || window.__rapierJxlUploadWatch.active > 0) {
      scheduleDrain(100);
    }
  }
  const hookPlupload = up => {
    if (!up || up._rapierJxlBound || typeof up.bind !== 'function') return;
    up._rapierJxlBound = true;
    up.bind('FilesAdded', () => scheduleDrain(250));
    up.bind('FileUploaded', () => scheduleDrain(100));
    up.bind('UploadComplete', () => scheduleDrain(100));
  };
  hookPlupload(window.uploader);
  let tries = 0;
  pluploadTimer = setInterval(() => {
    if (pageUnloading || typeof window === 'undefined') {
      clearInterval(pluploadTimer);
      pluploadTimer = null;
      return;
    }
    hookPlupload(window.uploader);
    if (++tries >= 20 || window.uploader?._rapierJxlBound) {
      clearInterval(pluploadTimer);
      pluploadTimer = null;
    }
  }, 250);
  pluploadTimer?.unref?.();
  if (window.jQuery && typeof window.jQuery(document)?.ajaxComplete === 'function') {
    window.jQuery(document).ajaxComplete((_event, _xhr, settings) => {
      const u = String(settings?.url || '');
      if (!u.includes('rapier-jxl/v1')) scheduleDrain(150);
    });
  }
}

let restoringAll = false;

function setupSettingsPage() {
  const box = document.getElementById('rapier-jxl-restore-box');
  const btn = document.getElementById('rapier-jxl-restore-btn');
  const status = document.getElementById('rapier-jxl-restore-status');
  const bar = document.getElementById('rapier-jxl-restore-progress');
  if (!box || !btn) return;

  const radios = document.querySelectorAll('input[name="rapier_jxl_mode"]');
  const syncVisibility = () => {
    const count = Number(box.dataset.removedCount || 0);
    box.style.display = count > 0 || restoringAll ? '' : 'none';
  };
  radios.forEach(radio => radio.addEventListener('change', syncVisibility));
  syncVisibility();

  const runRestore = async () => {
    if (restoringAll) return;
    restoringAll = true;
    try {
      sessionStorage.setItem('rapier_jxl_restore_requested', '1');
    } catch {}
    const keepRadio = document.querySelector('input[name="rapier_jxl_mode"][value="keep"]');
    if (keepRadio) keepRadio.checked = true;
    box.style.display = '';
    btn.disabled = true;
    bar.style.display = 'block';
    bar.value = 0;
    try {
      const queue = await apiGet('/queue');
      const list = queue.removed || [];
      if (!list.length) {
        try {
          sessionStorage.removeItem('rapier_jxl_restore_requested');
        } catch {}
        status.textContent = 'All originals are already restored on disk.';
        bar.style.display = 'none';
        box.dataset.removedCount = '0';
        config.removedCount = 0;
        restoringAll = false;
        return;
      }
      for (let idx = 0; idx < list.length; idx++) {
        if (pageUnloading) return;
        const att = list[idx];
        status.textContent = `Restoring ${idx + 1} of ${list.length}: ${att.title || ('#' + att.id)}...`;
        const isLast = idx === list.length - 1;
        await restoreAttachmentById(att.id, (step, total) => {
          const pct = Math.round(((idx + (step / Math.max(1, total))) / list.length) * 100);
          bar.value = pct;
        }, isLast);
        bar.value = Math.round(((idx + 1) / list.length) * 100);
      }
      try {
        sessionStorage.removeItem('rapier_jxl_restore_requested');
      } catch {}
      box.dataset.removedCount = '0';
      config.removedCount = 0;
      restoringAll = false;
      status.textContent = `Restored ${list.length === 1 ? '1 image' : list.length + ' images'}.`;
    } catch (error) {
      restoringAll = false;
      if (pageUnloading) return;
      try {
        sessionStorage.removeItem('rapier_jxl_restore_requested');
      } catch {}
      status.textContent = 'Restore stopped: ' + (error?.message || String(error));
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', runRestore);

  let autoRequested = false;
  try {
    autoRequested = sessionStorage.getItem('rapier_jxl_restore_requested') === '1';
  } catch {}
  if (autoRequested) {
    runRestore();
  }
}

function setupDeactivateWarning() {
  if (!config.pluginBasename) return;
  const row = document.querySelector(`tr[data-plugin="${CSS.escape(config.pluginBasename)}"]`);
  const link = row?.querySelector('.deactivate a');
  if (!link) return;
  link.addEventListener('click', event => {
    if ((config.removedCount || 0) <= 0) return;
    event.preventDefault();
    const message =
      `${config.removedCount} image(s) are stored as JPEG XL only in Space saver mode.\n\n` +
      `Open Settings, Media and click "Restore originals" first, or press OK to open Settings, Media now.`;
    if (window.confirm(message)) {
      window.location.href = config.mediaSettingsUrl;
    }
  });
}

window.rapierJxl = {drainPending, restoreAttachmentById, notifyUploadActivity: () => scheduleDrain(150)};

function initAdmin() {
  bindUploadHooks();
  setupSettingsPage();
  setupDeactivateWarning();
  drainPending();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdmin);
} else {
  initAdmin();
}
