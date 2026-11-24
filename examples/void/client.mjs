// SPDX-License-Identifier: MIT
// uploadImage(file): a JPEG is made JPEG XL here in the page, without loss (the server checks it restores this very
// JPEG), so less goes over the network and the Worker does less. A PNG, or a JPEG this page cannot encode, goes as it
// is and the Worker keeps it exact. Resolves {id, url, bytes, sourceBytes, ...}; url is the picture's address.
import {recompress} from 'jpegxl/jpeg';

const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');

export async function uploadImage(file, {signal, route = '/api/images'} = {}) {
  let body = file, headers = {'content-type': file.type};
  if (file.type === 'image/jpeg') {
    try {
      const [result, sha256] = await Promise.all([recompress(file, {effort: 3, signal}),
        file.arrayBuffer().then(bytes => crypto.subtle.digest('SHA-256', bytes)).then(hex)]);
      if (result.kept === 'jpeg-bytes') { body = new Blob([result.bytes], {type: 'image/jxl'}); headers = {'content-type': 'image/jxl', 'x-jxl-source-sha256': sha256}; }
    } catch (error) {
      if (signal?.aborted) throw error; // else the Worker encodes the JPEG
    }
  }
  const response = await fetch(route, {method: 'POST', headers, body, signal});
  const answer = await response.json();
  if (!response.ok) throw Object.assign(new Error(answer.error?.message ?? 'Upload failed.'), {code: answer.error?.code});
  return answer;
}
