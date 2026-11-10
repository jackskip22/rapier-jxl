// The rapier-jxl self-test in Cloudflare's runtime (wrangler dev): open http://localhost:8787 for the results file.
import {encode} from 'rapier-jxl';
import {recompress, restore} from 'rapier-jxl/jpeg';
import {decode} from 'rapier-jxl/decode';
import {verify, configureDecoder} from 'rapier-jxl/verify';
import {selftest} from './selftest.mjs';
import manifest from '../pictures/manifest.json';
import screenshot from '../pictures/screenshot-mdn.png';
import photo from '../pictures/photo-kodim23.png';
import camera from '../pictures/camera-iphone16.jpg';

const pictures = {'screenshot-mdn.png': screenshot, 'photo-kodim23.png': photo, 'camera-iphone16.jpg': camera};

export default {
  async fetch(request) {
    if (new URL(request.url).pathname !== '/') return new Response('Not found', {status: 404});
    configureDecoder(decode, restore);
    const facts = {runtime: {name: 'workerd', userAgent: globalThis.navigator?.userAgent ?? null}, cpu: {cores: globalThis.navigator?.hardwareConcurrency ?? null}};
    const record = await selftest({modules: {encode, recompress, restore, decode, verify}, manifest, picture: file => pictures[file], facts});
    return new Response(JSON.stringify(record, null, 2) + '\n', {headers: {'content-type': 'application/json',
      'content-disposition': 'attachment; filename="rapier-jxl-selftest-workerd.json"'}});
  },
};
