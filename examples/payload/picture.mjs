// SPDX-License-Identifier: MIT
// Next.js and React <Picture> helper for Payload CMS uploads. Renders a <picture> with a <source type="image/jxl">
// for each imageSizes rendition and the full-size image, with the original as the <img> fallback so no CDN can mix them up.
import {createElement} from 'react';

const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function escapeAttr(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function pictureProps(input, options = {}) {
  const item = plain(input) ? input : null;
  if (!item) return null;

  const {
    size,
    sizes,
    mediaQueries,
    alt,
    className,
    pictureClassName,
    loading,
    decoding,
    fetchPriority,
    style,
  } = options;

  const resolvedAlt = alt ?? (typeof item.alt === 'string' ? item.alt : '');
  const sources = [];

  if (typeof size === 'string' && size) {
    const fallbackSize = plain(item.sizes?.[size]) ? item.sizes[size] : null;
    const jxlSize = plain(item.jxl?.sizes?.[size]) ? item.jxl.sizes[size] : (!fallbackSize && plain(item.jxl) ? item.jxl : null);
    if (jxlSize?.url) {
      sources.push({
        key: size,
        type: 'image/jxl',
        srcSet: jxlSize.url,
        ...(Number.isFinite(jxlSize.width) ? {width: jxlSize.width} : {}),
        ...(Number.isFinite(jxlSize.height) ? {height: jxlSize.height} : {}),
      });
    }
    const imgSrc = fallbackSize?.url || item.url;
    if (!imgSrc) return null;
    const width = fallbackSize?.width ?? item.width;
    const height = fallbackSize?.height ?? item.height;
    return {
      picture: {...(pictureClassName ? {className: pictureClassName} : {})},
      sources,
      img: {
        src: imgSrc,
        alt: resolvedAlt,
        ...(Number.isFinite(width) ? {width} : {}),
        ...(Number.isFinite(height) ? {height} : {}),
        ...(className ? {className} : {}),
        ...(loading ? {loading} : {}),
        ...(decoding ? {decoding} : {}),
        ...(fetchPriority ? {fetchPriority} : {}),
        ...(style ? {style} : {}),
      },
    };
  }

  if (plain(item.jxl?.sizes)) {
    const entries = Object.entries(item.jxl.sizes)
      .map(([name, s]) => {
        const w = Number.isFinite(s?.width) ? s.width : item.sizes?.[name]?.width;
        const h = Number.isFinite(s?.height) ? s.height : item.sizes?.[name]?.height;
        return [name, s, w, h];
      })
      .filter(([, s]) => plain(s) && typeof s.url === 'string' && s.url)
      .sort(([, , aw], [, , bw]) => (aw ?? Infinity) - (bw ?? Infinity));
    for (const [name, s, w, h] of entries) {
      const customMedia = plain(mediaQueries) && typeof mediaQueries[name] === 'string' ? mediaQueries[name] : undefined;
      const media = customMedia ?? (Number.isFinite(w) ? `(max-width: ${w}px)` : undefined);
      sources.push({
        key: name,
        type: 'image/jxl',
        srcSet: s.url,
        ...(media ? {media} : {}),
        ...(Number.isFinite(w) ? {width: w} : {}),
        ...(Number.isFinite(h) ? {height: h} : {}),
      });
    }
  }

  if (typeof item.jxl?.url === 'string' && item.jxl.url) {
    const w = item.jxl.width ?? item.width;
    const h = item.jxl.height ?? item.height;
    sources.push({
      key: 'original',
      type: 'image/jxl',
      srcSet: item.jxl.url,
      ...(Number.isFinite(w) ? {width: w} : {}),
      ...(Number.isFinite(h) ? {height: h} : {}),
    });
  }

  const fallbackUrl = (typeof item.url === 'string' && item.url)
    ? item.url
    : (typeof item.jxl?.url === 'string' && /\.jxl(?=\?|$)/i.test(item.jxl.url)
      ? item.jxl.url.replace(/\.jxl(?=\?|$)/i, '')
      : '');
  if (!fallbackUrl) return null;

  let fallbackSrcSet;
  if (sizes && plain(item.sizes)) {
    const candidates = Object.entries(item.sizes)
      .map(([k, s]) => {
        if (!plain(s) || !Number.isFinite(s.width)) return null;
        const u = (typeof s.url === 'string' && s.url)
          ? s.url
          : (typeof item.jxl?.sizes?.[k]?.url === 'string' && /\.jxl(?=\?|$)/i.test(item.jxl.sizes[k].url)
            ? item.jxl.sizes[k].url.replace(/\.jxl(?=\?|$)/i, '')
            : '');
        return u ? {url: u, width: s.width} : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.width - b.width)
      .map(s => `${s.url} ${s.width}w`);
    if (Number.isFinite(item.width)) candidates.push(`${fallbackUrl} ${item.width}w`);
    if (candidates.length > 0) fallbackSrcSet = [...new Set(candidates)].join(', ');
  }

  return {
    picture: {...(pictureClassName ? {className: pictureClassName} : {})},
    sources,
    img: {
      src: fallbackUrl,
      ...(fallbackSrcSet ? {srcSet: fallbackSrcSet} : {}),
      ...(sizes ? {sizes} : {}),
      alt: resolvedAlt,
      ...(Number.isFinite(item.width) ? {width: item.width} : {}),
      ...(Number.isFinite(item.height) ? {height: item.height} : {}),
      ...(className ? {className} : {}),
      ...(loading ? {loading} : {}),
      ...(decoding ? {decoding} : {}),
      ...(fetchPriority ? {fetchPriority} : {}),
      ...(style ? {style} : {}),
    },
  };
}

export function pictureHtml(input, options = {}) {
  const built = pictureProps(input, options);
  if (!built) return '';
  const picAttrs = built.picture.className ? ` class="${escapeAttr(built.picture.className)}"` : '';
  const sourceTags = built.sources.map(source => {
    const attrs = [`type="${escapeAttr(source.type)}"`, `srcset="${escapeAttr(source.srcSet)}"`];
    if (source.media) attrs.push(`media="${escapeAttr(source.media)}"`);
    if (source.width !== undefined) attrs.push(`width="${escapeAttr(source.width)}"`);
    if (source.height !== undefined) attrs.push(`height="${escapeAttr(source.height)}"`);
    return `<source ${attrs.join(' ')}>`;
  }).join('');
  const imgAttrs = [`src="${escapeAttr(built.img.src)}"`];
  if (built.img.srcSet) imgAttrs.push(`srcset="${escapeAttr(built.img.srcSet)}"`);
  if (built.img.sizes) imgAttrs.push(`sizes="${escapeAttr(built.img.sizes)}"`);
  imgAttrs.push(`alt="${escapeAttr(built.img.alt)}"`);
  if (built.img.width !== undefined) imgAttrs.push(`width="${escapeAttr(built.img.width)}"`);
  if (built.img.height !== undefined) imgAttrs.push(`height="${escapeAttr(built.img.height)}"`);
  if (built.img.className) imgAttrs.push(`class="${escapeAttr(built.img.className)}"`);
  if (built.img.loading) imgAttrs.push(`loading="${escapeAttr(built.img.loading)}"`);
  if (built.img.decoding) imgAttrs.push(`decoding="${escapeAttr(built.img.decoding)}"`);
  if (built.img.fetchPriority) imgAttrs.push(`fetchpriority="${escapeAttr(built.img.fetchPriority)}"`);
  return `<picture${picAttrs}>${sourceTags}<img ${imgAttrs.join(' ')}></picture>`;
}

export function Picture(props = {}) {
  const {
    doc,
    media,
    size,
    sizes,
    mediaQueries,
    alt,
    className,
    pictureClassName,
    loading,
    decoding,
    fetchPriority,
    style,
    imgProps,
    ...rest
  } = props;
  const built = pictureProps(doc ?? media, {
    size,
    sizes,
    mediaQueries,
    alt,
    className,
    pictureClassName,
    loading,
    decoding,
    fetchPriority,
    style,
  });
  if (!built) return null;
  return createElement(
    'picture',
    built.picture,
    ...built.sources.map(({key, ...sourceProps}) => createElement('source', {key, ...sourceProps})),
    createElement('img', {...built.img, ...rest, ...(plain(imgProps) ? imgProps : {})}),
  );
}

export default Picture;
