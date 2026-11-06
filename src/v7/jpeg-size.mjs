// SPDX-License-Identifier: MIT
import {JxlBits, readSize} from '../jpeg-coefficients.mjs';
import {boxes, SIGNATURE, CODESTREAM, PARTIAL} from '../container.mjs';

export function pictureSize(bytes) {
  try {
    let stream = bytes[0] === 255 && bytes[1] === 10 ? bytes : null;
    if (!stream && SIGNATURE.every((byte, i) => bytes[i] === byte)) for (const box of boxes(bytes)) {
      if (box.type === CODESTREAM) { stream = bytes.subarray(box.body, box.end); break; }
      if (box.type === PARTIAL && box.end - box.body >= 4 && !(bytes[box.body] & 127) && !bytes[box.body + 1] && !bytes[box.body + 2] && !bytes[box.body + 3]) { stream = bytes.subarray(box.body + 4, box.end); break; }
    }
    return stream && readSize(new JxlBits(stream));
  } catch { return null; }
}
