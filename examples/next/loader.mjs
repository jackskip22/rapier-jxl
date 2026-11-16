// SPDX-License-Identifier: MIT
// A next/image loader for a static export (output: 'export'), where no server picks a file by `Accept`: it names the
// JPEG XL file rapier-jxl-next.mjs wrote for each width. Use it as the <source type="image/jxl"> of a <picture> whose
// <img> keeps the original, so a browser without JPEG XL shows the original:
//   const {props: {srcSet}} = getImageProps({...common, loader: jxlLoader});
//   const {props} = getImageProps({...common, unoptimized: true});
//   <picture><source type="image/jxl" srcSet={srcSet} sizes={common.sizes} /><img {...props} /></picture>
export default function jxlLoader({src, width}) {
  const clean = String(src ?? '').split(/[?#]/)[0];
  if (!/^\/(?!\/)[^\\]*\.(?:jpe?g|png)$/i.test(clean) || clean.split('/').some(s => s === '.' || s === '..') || !Number.isInteger(width) || width < 1)
    return src;
  return `/_jxl/w${width}${clean}.jxl`;
}
