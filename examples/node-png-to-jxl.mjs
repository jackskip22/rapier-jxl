// A PNG file to a JPEG XL file in Node. Usage: node node-png-to-jxl.mjs photo.png photo.jxl
import {readFile, writeFile} from 'node:fs/promises';
import {encode} from 'jpegxl/upload';

const [from = 'photo.png', to = 'photo.jxl'] = process.argv.slice(2);
// encode takes pixels or an image Blob, so wrap the file's bytes.
const result = await encode(new Blob([await readFile(from)]), {fidelity: {quality: 82}});
await writeFile(to, result.bytes);
console.log(`${from} -> ${to}: ${result.bytes.length} bytes, ${result.width}x${result.height}`);
