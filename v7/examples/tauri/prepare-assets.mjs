import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepare} from '../desktop/prepare.mjs';

const app = dirname(fileURLToPath(import.meta.url));
try { console.log(JSON.stringify(await prepare({app, web: join(app, 'web')}), null, 2)); }
catch (error) { console.error(`${error.code || 'JXL_PACKAGE'}: ${error.message}\nSet JXL_PACKAGE to a built package, or run npm install --no-save jpegxl in this example.`); process.exitCode = 1; }
