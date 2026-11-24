// SPDX-License-Identifier: MIT
// GET /api/images/<id>: JPEG XL where the browser accepts it, else the exact original (see _jxl.mjs).
import {defineHandler} from 'void';
import {image} from './_jxl.mjs';

export const GET = defineHandler(c => image(c.req.raw, c.req.param('id')));
