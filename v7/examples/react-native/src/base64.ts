// React Native's WebView carries strings only, so bytes cross as base64. Hermes has no Buffer: these two loops are the codec.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUE = new Uint8Array(128).fill(255);
for (let i = 0; i < 64; i++) VALUE[ALPHABET.charCodeAt(i)] = i;

export function encodeBase64(bytes: Uint8Array, start = 0, end = bytes.length): string {
  const parts: string[] = [];
  let line = '';
  for (let i = start; i < end; i += 3) {
    const a = bytes[i], b = i + 1 < end ? bytes[i + 1] : 0, c = i + 2 < end ? bytes[i + 2] : 0;
    line += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | (b >> 4)] +
      (i + 1 < end ? ALPHABET[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < end ? ALPHABET[c & 63] : '=');
    if (line.length >= 8192) { parts.push(line); line = ''; }
  }
  parts.push(line);
  return parts.join('');
}

/** Writes the bytes of `text` into `into` at `at` and returns how many it wrote. */
export function decodeBase64(text: string, into: Uint8Array, at: number): number {
  let out = at, bits = 0, held = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 61) break;
    const value = code < 128 ? VALUE[code] : 255;
    if (value === 255) throw new RangeError('Not base64.');
    held = (held << 6) | value; bits += 6;
    if (bits >= 8) { bits -= 8; into[out++] = (held >> bits) & 255; held &= (1 << bits) - 1; }
  }
  return out - at;
}
