const COLOR = ['whitePoint', 'primaries', 'transferFunction', 'gamma', 'renderingIntent', 'iccSpace', 'invertedCMYK'];
const copy = value => Array.isArray(value) ? value.map(copy) : value;
export function colorFields(encoding) {
  if (!encoding) return encoding;
  if (encoding.wantICC) {
    const out = {space: encoding.space, transferFunction: 'icc'};
    if (encoding.transferFunction === 'icc') for (const key of ['renderingIntent', 'iccSpace', 'invertedCMYK']) if (encoding[key] !== undefined && encoding[key] !== null) out[key] = encoding[key];
    return out;
  }
  const out = {space: encoding.space};
  for (const key of COLOR) if (encoding[key] !== undefined && encoding[key] !== null) out[key] = copy(encoding[key]);
  return out;
}
const pair = value => value ? {...value} : null;
export function headerFields(info) {
  return {width: info.width, height: info.height, orientation: info.orientation, intrinsicSize: pair(info.intrinsicSize),
    preview: pair(info.preview), animation: pair(info.animation), bitDepth: {...info.bitDepth},
    extraChannels: info.extraChannels.map(({type, bitDepth, dimShift, name, associated, spotColor, cfaChannel}) => ({type, bitDepth: {...bitDepth},
      dimShift, name, associated, ...(spotColor && {spotColor: [...spotColor]}), ...(cfaChannel !== undefined && {cfaChannel})})),
    colorEncoding: colorFields(info.colorEncoding), toneMapping: {...info.toneMapping}, reconstruction: info.reconstruction};
}
export function publicDecoded(result) {
  const parsed = result.metadata, info = {...parsed, reconstruction: (result.boxes ?? []).some(box => box.type === 'jbrd')};
  const frame = target => { target.colorEncoding = colorFields(target.colorEncoding); target.rgbaColorEncoding = colorFields(target.rgbaColorEncoding); };
  frame(result);
  for (const each of result.frames ?? []) if (each !== result) frame(each);
  if (result.preview) frame(result.preview);
  delete result.metadata;
  result.header = headerFields(info);
  if (parsed.icc) result.header.icc = parsed.icc;
  return result;
}
