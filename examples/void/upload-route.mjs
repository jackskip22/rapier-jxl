// SPDX-License-Identifier: MIT
// POST /api/images: stores a picture as JPEG XL (see _jxl.mjs).
import {defineHandler} from 'void';
import {upload} from './_jxl.mjs';

export const POST = defineHandler(c => upload(c.req.raw));
