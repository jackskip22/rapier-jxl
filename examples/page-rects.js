// A page element's text, edge and photo rectangles in canvas pixels, for rapier-jxl/capture-complete, after any library
// draws the element to a canvas: import { measure, pageRects } from 'rapier-jxl/page-rects';
//   capture(canvas, { fidelity: { quality: 92 }, ...pageRects(element, canvas) });

// The element now, in CSS pixels; measure early when the page may change before pageRects.
export function measure(element, { edges = false } = {}) {
  return { box: elementBox(element), text: textParts(element), photos: photoParts(element), ...(edges && { edges: edgeParts(element) }) };
}

// `area`: the part of the element the canvas shows, in CSS pixels from its border box's corner (default all of it).
export function pageRects(page, canvas, { area = {}, edges = false } = {}) {
  const shot = page.box ? page : measure(page, { edges }), box = shot.box;
  const left = box.left + (area.x ?? 0), top = box.top + (area.y ?? 0);
  const sx = canvas.width / (area.width ?? box.width), sy = canvas.height / (area.height ?? box.height);
  const place = (r, grow) => {
    const gx = Math.ceil(grow * sx), gy = Math.ceil(grow * sy);
    const x = Math.max(0, Math.floor((r.left - left) * sx) - gx), y = Math.max(0, Math.floor((r.top - top) * sy) - gy);
    const right = Math.min(canvas.width, Math.ceil((r.right - left) * sx) + gx), bottom = Math.min(canvas.height, Math.ceil((r.bottom - top) * sy) + gy);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  };
  const whole = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const photoRects = shot.photos.map(r => place(r, 0)).filter(Boolean);
  // place() already maps CSS boxes through the drawn scale and rounds outward to whole canvas
  // pixels (floor left/top, ceil right/bottom). Keep those exactRects below 1:1 so glyphs stay
  // lossless; photoRects stay so photographs still take the quality (a whole-canvas exact made the 1×
  // phone card larger than WebP).
  const exactRects = [];
  for (const { r, grow, solidText } of shot.text) { const b = place(r, grow); if (b) exactRects.push(solidText ? { ...b, solidText } : b); }
  // Edges asked of a measurement made without them: the page may have moved since.
  if (edges) exactRects.push(...(shot.edges ? shot.edges.map(r => place(r, r.soft ? 1 : 0)).filter(Boolean).map(b => ({ ...b, edge: true })) : [{ ...whole, edge: true }]));
  return { exactRects, photoRects };
}

function elementBox(element) {
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

const FIELD = /^(TEXTAREA|SELECT)$/, INPUT_TEXT = /^(text|search|email|url|tel|password|number|date|datetime-local|month|week|time|button|submit|reset|file)$/;
const REPLACED = /^(IMG|VIDEO|CANVAS|IFRAME|EMBED|OBJECT|AUDIO|PICTURE|SOURCE|INPUT|TEXTAREA|SELECT|BR|HR)$/;
// Elements a ::before/::after rule with content can reach, @import-ed sheets too; null (check all) when a sheet is unreadable.
function pseudoHosts() {
  const hosts = new Set();
  const scan = rules => { for (const rule of rules) {
    if (rule.cssRules) scan(rule.cssRules);
    if (rule.styleSheet) scan(rule.styleSheet.cssRules);
    if (!/::?(before|after)/.test(rule.selectorText ?? '') || !rule.style?.content) continue;
    try { for (const el of document.querySelectorAll(rule.selectorText.replace(/::?(before|after)/g, '') || '*')) hosts.add(el); } catch { hosts.add(null); }
  } };
  try { for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) scan(sheet.cssRules); } catch { return null; }
  return hosts.has(null) ? null : hosts;
}

// Each part: its CSS rectangle, its reach past it and whether it is solidText (plain, one color, no emoji).
function textParts(root) {
  const parts = [], range = document.createRange(), hosts = pseudoHosts();
  // drop-shadow() reaches add up the ancestors; a filter blur is a standard deviation.
  const shadows = new Map(), filterReach = el => {
    if (!el) return 0;
    let r = shadows.get(el);
    if (r === undefined) {
      r = 0;
      for (const m of (getComputedStyle(el).filter ?? '').matchAll(/drop-shadow\((?:[^()]|\([^()]*\))*\)/g)) {
        const [x = 0, y = 0, blur = 0] = (m[0].replace(/rgba?\([^)]*\)|#\w+/gi, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat);
        r += Math.max(Math.abs(x), Math.abs(y)) + 3 * blur;
      }
      shadows.set(el, r += filterReach(el === root ? null : el.parentElement ?? el.getRootNode?.().host ?? null));
    }
    return r;
  };
  const reach = new Map(), grow = el => {
    let g = reach.get(el);
    if (g === undefined) {
      // 0.4 em: a library's layout can sit a few pixels from the live page's.
      const style = getComputedStyle(el), em = parseFloat(style.fontSize) || 0;
      const decorated = style.textDecorationLine !== 'none' ? (parseFloat(style.textUnderlineOffset) || 0) + (parseFloat(style.textDecorationThickness) || em / 10) + 1 : 0;
      g = Math.max(1, 0.4 * em, decorated) + (parseFloat(style.webkitTextStrokeWidth) || 0) / 2;
      if (style.textShadow !== 'none') for (const shadow of style.textShadow.split(/,(?![^(]*\))/)) {
        const [x = 0, y = 0, blur = 0] = (shadow.replace(/rgba?\([^)]*\)|#\w+|[a-z]+\([^)]*\)/gi, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat);
        g = Math.max(g, 1 + Math.max(Math.abs(x), Math.abs(y)) + 1.5 * blur);
      }
      reach.set(el, g += filterReach(el));
    }
    return g;
  };
  const plain = new Map(), solid = el => {
    let v = plain.get(el);
    if (v === undefined) {
      const style = getComputedStyle(el);
      plain.set(el, v = style.textShadow === 'none' && !filterReach(el) && !parseFloat(style.webkitTextStrokeWidth) && style.webkitTextFillColor === style.color
        && style.backgroundClip !== 'text' && style.webkitBackgroundClip !== 'text');
    }
    return v;
  };
  const add = (r, el, text) => parts.push({ r: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, grow: el ? grow(el) : 1,
    solidText: !!(text && el && solid(el) && !/\p{Extended_Pictographic}/u.test(text)) });
  // display: contents has no box (checkVisibility says no) yet paints its text.
  const seen = new Map(), shown = new Map(), drawn = el => {
    let v = seen.get(el);
    if (v === undefined) seen.set(el, v = getComputedStyle(el).display === 'contents' ? getComputedStyle(el).visibility === 'visible' && boxed(el)
      : !el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
    return v;
  }, boxed = el => {
    const up = el.parentElement ?? el.getRootNode().host;
    if (!up) return true;
    let v = shown.get(up);
    if (v === undefined) shown.set(up, v = getComputedStyle(up).display === 'contents' ? boxed(up) : !up.checkVisibility || up.checkVisibility({ opacityProperty: true }));
    return v;
  };
  // <q>'s quotes come from the browser's own sheet, which pseudoHosts cannot read.
  const text = (el, pseudo) => (!hosts || hosts.has(el) || el.tagName === 'Q' || el.getRootNode() !== document) && /"[^"]*[^"\s][^"]*"|counters?\(|attr\(|(open|close)-quote/.test(getComputedStyle(el, pseudo).content);
  const visit = el => {
    // SVG text, and icon-sized SVG in currentColor.
    if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
      if (!drawn(el) || /^(svg|g|defs)$/.test(el.tagName) || el.closest('defs, mask, clipPath, pattern, symbol')) return;
      const style = getComputedStyle(el), r = el.getBoundingClientRect();
      const inked = style.fill === style.color && style.fill !== 'none' || style.stroke === style.color && style.stroke !== 'none';
      if (/^(text|tspan|textPath)$/.test(el.tagName) || inked && r.width <= 64 && r.height <= 64) add(r, el);
      return;
    }
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
    if (!drawn(el)) { if (el.shadowRoot) walk(el.shadowRoot); return; }
    if (FIELD.test(el.tagName) || el.tagName === 'INPUT' && INPUT_TEXT.test(el.type)) add(el.getBoundingClientRect(), el);
    // A same-origin frame is drawn as a picture of its page: all of it stays exact.
    else if (el.tagName === 'IFRAME') { if (el.contentDocument) add(el.getBoundingClientRect(), null); }
    else if (!REPLACED.test(el.tagName)) {
      // Icon-sized paint in the text's color: a currentColor mask, or a ::before/::after bar, dot or icon.
      for (const p of [null, '::before', '::after']) {
        const cs = getComputedStyle(el, p);
        if (p && (cs.content === 'none' || cs.content === 'normal')) continue;
        const masked = (cs.maskImage ?? 'none') !== 'none' || (cs.webkitMaskImage ?? 'none') !== 'none';
        if (cs.backgroundColor !== cs.color || cs.color === 'rgba(0, 0, 0, 0)' || !(masked || p)) continue;
        const r = el.getBoundingClientRect(), pw = parseFloat(cs.width) || 0, ph = parseFloat(cs.height) || 0;
        if ((p ? pw * ph : r.width * r.height) <= 4096) add(p ? {left: r.left - pw, top: r.top - ph, right: r.right + pw, bottom: r.bottom + ph} : r, el);
      }
      // Generated text paints a line of its font past a shorter box (an icon font's <i> of line-height 0).
      const pseudo = ['::before', '::after'].filter(p => text(el, p));
      if (pseudo.length) {
        const r = el.getBoundingClientRect(), em = Math.max(...pseudo.map(p => parseFloat(getComputedStyle(el, p).fontSize) || 0));
        add(r.height < em ? { left: r.left - em / 2, right: r.right + em / 2, top: r.top - em, bottom: r.bottom + em } : r, el);
      }
      const style = /^(LI|SUMMARY)$/.test(el.tagName) && getComputedStyle(el);
      if (style && style.display === 'list-item' && (style.listStyleType !== 'none' || style.listStyleImage !== 'none')) {
        const box = el.getBoundingClientRect(), em = parseFloat(style.fontSize), line = parseFloat(style.lineHeight) || em * 1.5;
        add({left: box.left - 3 * em, top: box.top, right: box.left + 3 * em, bottom: box.top + line}, el);
      }
    }
    if (el.shadowRoot) walk(el.shadowRoot);
  };
  const walk = root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) { visit(node); continue; }
      if (!node.data.trim() || node.parentElement && !drawn(node.parentElement)) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) add(r, node.parentElement, node.data);
    }
  };
  visit(root); walk(root);
  return parts;
}

function contentBox(el, padding) {
  const r = el.getBoundingClientRect(), style = getComputedStyle(el);
  const inset = side => (parseFloat(style[`border${side}Width`]) || 0) + (padding ? parseFloat(style[`padding${side}`]) || 0 : 0);
  return { left: r.left + inset('Left'), top: r.top + inset('Top'), right: r.right - inset('Right'), bottom: r.bottom - inset('Bottom') };
}

// Strips along borders and outlines, never whole boxes; a transformed box or stroked SVG shape (soft) gives its whole box.
function edgeParts(root) {
  const parts = [], all = node => [...node.querySelectorAll('*')].flatMap(el => el.shadowRoot ? [el, ...all(el.shadowRoot)] : [el]);
  const turned = new Map(), transformed = el => {
    if (!el || el === root.parentElement) return false;
    let v = turned.get(el);
    if (v === undefined) turned.set(el, v = (getComputedStyle(el).transform ?? 'none') !== 'none' || transformed(el.parentElement ?? el.getRootNode?.().host ?? null));
    return v;
  };
  for (const el of [root, ...(root.shadowRoot ? all(root.shadowRoot) : []), ...all(root)]) {
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const s = getComputedStyle(el);
    if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
      const w = parseFloat(s.strokeWidth) || 0;
      if (/^(path|line|polyline|polygon|rect|circle|ellipse)$/.test(el.localName) && s.stroke && s.stroke !== 'none' && w > 0) {
        const r = el.getBoundingClientRect();
        if (r.width || r.height) parts.push({ left: r.left - w / 2, top: r.top - w / 2, right: r.right + w / 2, bottom: r.bottom + w / 2, soft: true });
      }
      continue;
    }
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (el.tagName === 'HR') { parts.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, soft: true }); continue; }
    const side = n => s[`border${n}Style`] !== 'none' && s[`border${n}Style`] !== 'hidden' && parseFloat(s[`border${n}Width`]) > 0 && !/rgba\([^)]*,\s*0\)|transparent/.test(s[`border${n}Color`] ?? '') ? parseFloat(s[`border${n}Width`]) : 0;
    const t = side('Top'), rt = side('Right'), b = side('Bottom'), l = side('Left');
    const ow = s.outlineStyle && s.outlineStyle !== 'none' ? parseFloat(s.outlineWidth) || 0 : 0, oo = ow ? (parseFloat(s.outlineOffset) || 0) + ow : 0;
    if (!(t || rt || b || l || ow)) continue;
    if (transformed(el)) { parts.push({ left: r.left - oo, top: r.top - oo, right: r.right + oo, bottom: r.bottom + oo, soft: true }); continue; }
    const strips = (L, T, Rr, B, wt, wr, wb, wl) => {
      if (wt) parts.push({ left: L, top: T, right: Rr, bottom: T + wt });
      if (wb) parts.push({ left: L, top: B - wb, right: Rr, bottom: B });
      if (wl) parts.push({ left: L, top: T, right: L + wl, bottom: B });
      if (wr) parts.push({ left: Rr - wr, top: T, right: Rr, bottom: B });
    };
    strips(r.left, r.top, r.right, r.bottom, t, rt, b, l);
    if (ow) strips(r.left - oo, r.top - oo, r.right + oo, r.bottom + oo, ow, ow, ow, ow);
    const radius = Math.max(...['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight'].map(c => parseFloat(s[`border${c}Radius`]) || 0));
    if (radius && (t || rt || b || l)) {
      const c = radius + Math.max(t, rt, b, l);
      for (const [x, y] of [[r.left, r.top], [r.right - c, r.top], [r.left, r.bottom - c], [r.right - c, r.bottom - c]]) parts.push({ left: x, top: y, right: x + c, bottom: y + c });
    }
  }
  return parts;
}

// Images, videos, canvases and CSS backgrounds: inside border (and padding for replaced elements), clipped by overflow.
function photoParts(root) {
  const clips = new Map(), clipOf = el => {
    if (clips.has(el)) return clips.get(el);
    const up = el === root ? null : el.parentElement ?? el.getRootNode?.().host ?? null;
    let c = up ? clipOf(up) : null;
    if (up) {
      const s = getComputedStyle(up);
      if ((s.overflowX ?? 'visible') !== 'visible' || (s.overflowY ?? 'visible') !== 'visible') {
        const b = contentBox(up, false);
        c = c ? { left: Math.max(c.left, b.left), top: Math.max(c.top, b.top), right: Math.min(c.right, b.right), bottom: Math.min(c.bottom, b.bottom) } : b;
      }
    }
    clips.set(el, c);
    return c;
  };
  const parts = [], all = node => [...node.querySelectorAll('*')].flatMap(el => el.shadowRoot ? [el, ...all(el.shadowRoot)] : [el]);
  for (const el of [root, ...(root.shadowRoot ? all(root.shadowRoot) : []), ...all(root)]) {
    if (!/^(IMG|VIDEO|CANVAS)$/.test(el.tagName) && !getComputedStyle(el).backgroundImage.includes('url(')) continue;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const b = contentBox(el, /^(IMG|VIDEO|CANVAS)$/.test(el.tagName)), c = clipOf(el);
    const r = c ? { left: Math.max(b.left, c.left), top: Math.max(b.top, c.top), right: Math.min(b.right, c.right), bottom: Math.min(b.bottom, c.bottom) } : b;
    if (r.right > r.left && r.bottom > r.top) parts.push(r);
  }
  return parts;
}
