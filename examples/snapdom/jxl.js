// JPEG XL for SnapDOM 3, with rapier-jxl. Copy this file into your app, then:
//   const result = await snapdom(element, { plugins: [jxl()] });
//   const blob = await result.toJxl();
// Exact pixels by default; toJxl({ quality: 0.9 }) writes a smaller photograph.
import { capture } from 'rapier-jxl/capture';
import { encode } from 'rapier-jxl/upload';

export function jxl() {
  return {
    name: 'jxl',
    defineExports: ({ exports }) => ({
      async jxl(context, options = {}) {
        const canvas = await exports.canvas(options);
        // SnapDOM puts a default quality in every export's options; only the one asked for counts.
        const quality = context.export?.requestedOptions?.quality;
        const bytes = quality === undefined || quality >= 1
          ? await capture(canvas)
          : await encode(canvas, { fidelity: { quality: Math.max(1, quality * 100) } });
        return new Blob([bytes], { type: 'image/jxl' });
      },
    }),
  };
}
