import {recompress} from 'rapier-jxl/jpeg';
import {encode, fit} from 'rapier-jxl';
import {deliveryCopies} from './deliver.mjs';
import {browserTools} from './browser-tools.mjs';
import {digest} from './digest.mjs';
import {settings, imageJob} from './media-settings.mjs';

function copyOptions(site) {
  return {fidelity: site.maxKilobytes ? {quality: {min: 1, max: 100}}
    : site.exact || site.quality === 100 ? 'exact' : {quality: site.quality},
    ...(site.maxKilobytes && {maxBytes: site.maxKilobytes * 1024})};
}

async function browserVerified(file, result, progress) {
  const [{verify, configureDecoder}, {decode}, {restore}] = await Promise.all([
    import('rapier-jxl/verify'), import('rapier-jxl/decode'), import('rapier-jxl/jpeg')]);
  configureDecoder(decode, restore);
  const browserVerification = await verify(file, result, {onProgress: progress});
  if (browserVerification?.verified !== true)
    throw Object.assign(new Error('The browser verifier did not verify this delivery.'), {code: 'JXL_INPUT'});
  // Informational browser assurance is deliberately separate from the private server receipt.
  const {verification: ignored, ...candidate} = result;
  return {...candidate, browserVerification};
}

// Browser-only formats and responsive sizes use the same settings as the server. The main copy already belongs to
// its captured delivery revision; this path never re-encodes or republishes it.
export async function makeWidths(file, selected, main, progress = () => {}, {deliveryOnly = false} = {}) {
  const site = settings(selected), input = new Uint8Array(await file.arrayBuffer()), source = await digest(input);
  let copies = await deliveryCopies(file, main, site.widths, browserTools(site.effort),
    {...copyOptions(site), onProgress: progress});
  if (deliveryOnly) {
    copies = copies.filter(copy => site.widths.includes(copy.width) && copy.width < main.width);
    const checked = [];
    for (const copy of copies) checked.push(copy.fits ? await browserVerified(file, copy, () => {}) : copy);
    copies = checked;
  }
  progress(1);
  return {kind: main.kept === 'jpeg-bytes' ? 'jpeg' : main.kept === 'pixels' ? 'exact' : 'photo',
    result: null, source, copies, bytes: input.byteLength, over: false};
}

export async function make(file, selected, progress = () => {}, {deliveryOnly = false, archiveOriginals = true} = {}) {
  const jpeg = file.type === 'image/jpeg', site = settings(selected), {operation, options} = imageJob(site, jpeg);
  const input = new Uint8Array(await file.arrayBuffer()), source = await digest(input);
  // Exact JPEG recompression may also win as an ordinary delivery when physical originals are kept.
  const original = jpeg ? await recompress(input, {effort: site.effort}) : null;
  const archive = archiveOriginals && !deliveryOnly ? original : null;
  const made = operation === 'recompress' ? original : await ({encode, fit}[operation])(file, options);
  const limit = site.maxKilobytes ? site.maxKilobytes * 1024 : Infinity;
  const eligible = result => result?.fits === true && result.bytes instanceof Uint8Array && result.bytes.length <= limit;
  let result = eligible(original) && (!eligible(made) || original.bytes.length <= made.bytes.length) ? original : made;
  const over = !eligible(result);
  const kind = result?.kept === 'jpeg-bytes' ? 'jpeg' : result?.kept === 'pixels' ? 'exact' : 'photo';
  const archiveIsDelivery = archive !== null && result === archive;
  progress(0.5);
  if (over || !result?.fits) {
    progress(1);
    return {kind, over, original: archive, archiveIsDelivery: false, result, source, bytes: input.byteLength, copies: []};
  }
  if (deliveryOnly) {
    result = await browserVerified(file, result, value => progress(0.5 + value / 2));
    progress(1);
    return {kind, over: false, original: null, archiveIsDelivery: false, result, source, bytes: input.byteLength, copies: []};
  }
  if (jpeg && (over || result.bytes.byteLength >= input.byteLength)) {
    progress(1);
    return {kind, over, original: archive, archiveIsDelivery, result, source, bytes: input.byteLength, copies: []};
  }
  const copies = await deliveryCopies(file, result, site.widths, browserTools(site.effort),
    {...copyOptions(site), onProgress: f => progress(0.5 + f / 2)});
  return {kind, over: false, original: archive, archiveIsDelivery, result, source, bytes: input.byteLength, copies};
}

if (typeof self !== 'undefined') self.onmessage = async ({data: {file, settings, widthsOnly, main, deliveryOnly, archiveOriginals}}) => {
  try {
    const started = performance.now(), progress = value => self.postMessage({progress: value});
    const made = widthsOnly === true ? await makeWidths(file, settings, main, progress, {deliveryOnly: deliveryOnly === true})
      : await make(file, settings, progress, {deliveryOnly: deliveryOnly === true, archiveOriginals: archiveOriginals === true});
    const buffers = [made.original, made.result, ...made.copies].flatMap(result => result?.bytes ? [result.bytes.buffer] : []);
    self.postMessage({...made, ms: performance.now() - started}, [...new Set(buffers)]);
  } catch (error) {
    self.postMessage({error: {message: error.message, code: error.code}});
  }
};
