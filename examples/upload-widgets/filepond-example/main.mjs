// FilePond uploading photographs as JPEG XL (../filepond.mjs, the plug-in `npx jpegxl add filepond` copies).
// ?jxl=off turns the plug-in off: every file then goes up as it was picked.
import * as FilePond from 'filepond';
import jxl from '../filepond.mjs';

FilePond.registerPlugin(jxl);
window.pond = FilePond.create(document.querySelector('input[type=file]'), {
  server: '/upload',
  allowMultiple: true,
  allowImageJxl: new URLSearchParams(location.search).get('jxl') !== 'off',
  imageJxlQuality: 70,
  imageJxlRetainExif: new URLSearchParams(location.search).get('exif') === 'on',
});
