// A page element's text, edge and photo rectangles in canvas pixels, for rapier-jxl/capture-complete, after any library
// draws the element to a canvas: import { measure, pageRects } from 'rapier-jxl/page-rects';
//   capture(canvas, { fidelity: { quality: 92 }, ...pageRects(element, canvas) });

// The element now, in CSS pixels; measure early when the page may change before pageRects. `keep`: the nodes a
// library drew (a Set, such as the sources of SnapDOM's nodeMap); every other element and its subtree adds nothing.
export function measure(element, { edges = false, keep } = {}) {
  const clip = clipper(element, keep);
  return { box: elementBox(element), text: textParts(element, clip), photos: photoParts(element, clip), textComplete: true, ...(edges && { edges: edgeParts(element, clip) }) };
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
  // Preserve the DOM measurement's complete coverage, including an empty text set. Hand-built measurements have no marker.
  return { exactRects, photoRects, ...(shot.textComplete === true && { textComplete: true }) };
}

function elementBox(element) {
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

const FIELD = /^(TEXTAREA|SELECT|METER|PROGRESS)$/, INPUT_TEXT = /^(text|search|email|url|tel|password|number|date|datetime-local|month|week|time|button|submit|reset|file|checkbox|radio|range|color)$/;
const REPLACED = /^(IMG|VIDEO|CANVAS|IFRAME|EMBED|OBJECT|AUDIO|PICTURE|SOURCE|INPUT|TEXTAREA|SELECT|BR|HR)$/;
// Elements a ::before/::after rule with content can reach, @import-ed sheets too; null (check all) when a sheet is unreadable.
// hosts.letters: whether any rule styles ::first-letter.
function pseudoHosts() {
  const hosts = new Set();
  const scan = rules => { for (const rule of rules) {
    if (rule.cssRules) scan(rule.cssRules);
    if (rule.styleSheet) scan(rule.styleSheet.cssRules);
    if (/::?first-letter/.test(rule.selectorText ?? '')) hosts.letters = true;
    if (!/::?(before|after)/.test(rule.selectorText ?? '') || !rule.style?.content) continue;
    try { for (const el of document.querySelectorAll(rule.selectorText.replace(/::?(before|after)/g, '') || '*')) hosts.add(el); } catch { hosts.add(null); }
  } };
  try { for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) scan(sheet.cssRules); } catch { return null; }
  return hosts.has(null) ? null : hosts;
}

// What overflow boxes leave of a part: clip.of(el) clips el's own box, clip.in(el) what el lays out in normal flow.
// An overflow box clips only what its containing blocks pass through: an absolute child escapes a static one, a
// fixed child every box but one that makes it a containing block. Clipping stops at the root.
// What makes an element the containing block of a fixed descendant (and of an absolute one, as does any position).
const fixedBlock = s => s.transform !== 'none' || s.perspective !== 'none' || (s.filter ?? 'none') !== 'none' ||
  (s.backdropFilter ?? 'none') !== 'none' || /paint|layout|strict|content/.test(s.contain ?? '') || /transform|perspective|filter/.test(s.willChange ?? '');
const holds = (s, mode) => mode === 'static' || (mode === 'absolute' ? s.position !== 'static' || fixedBlock(s) : fixedBlock(s));
const parentOf = el => el.parentElement ?? el.getRootNode?.().host ?? null;

function clipper(root, keep) {
  const up = el => el === root ? null : parentOf(el);
  // Left out: not kept, a light child no slot shows, or inside one.
  const dropped = new Map(), gone = el => {
    if (!el || el === root) return false;
    if (!dropped.has(el)) {
      const parent = el.parentElement;
      dropped.set(el, keep && !keep.has(el) || !!(parent?.shadowRoot && !el.assignedSlot) || gone(up(el)));
    }
    return dropped.get(el);
  };
  const meet = (a, b) => !a ? b : !b ? a : { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  const memo = { static: new Map(), absolute: new Map(), fixed: new Map() }, inner = new Map();
  // The clip on a child of el laid out as mode: from its containing block up.
  const child = (el, mode) => {
    if (!el) return null;
    const m = memo[mode];
    if (!m.has(el)) m.set(el, holds(getComputedStyle(el), mode) ? within(el) : child(up(el), mode));
    return m.get(el);
  };
  const within = el => {
    if (!inner.has(el)) {
      const s = getComputedStyle(el), paint = /paint|strict|content/.test(s.contain ?? ''), x = paint || (s.overflowX ?? 'visible') !== 'visible', y = paint || (s.overflowY ?? 'visible') !== 'visible';
      const b = (x || y) && contentBox(el, false);
      const own = b ? { left: x ? b.left : -Infinity, top: y ? b.top : -Infinity, right: x ? b.right : Infinity, bottom: y ? b.bottom : Infinity } : null;
      inner.set(el, meet(own, of(el)));
    }
    return inner.get(el);
  };
  const of = el => child(up(el), mode(getComputedStyle(el).position));
  const mode = p => p === 'absolute' ? 'absolute' : p === 'fixed' ? 'fixed' : 'static';
  // A part cut to its clip, or null when nothing of it shows.
  const cut = (r, c) => {
    if (!c) return r;
    const o = meet(r, c);
    return o.right > o.left && o.bottom > o.top ? { ...r, left: o.left, top: o.top, right: o.right, bottom: o.bottom } : null;
  };
  return { of, in: within, child, cut, gone };
}

// Each part: its CSS rectangle, its reach past it and whether it is solidText (plain, one color, no emoji).
function textParts(root, clip = clipper(root)) {
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
  // A ::first-letter in its own color, shadow or stroke, or larger than its line's font (size).
  const letters = new Map(), firstLetter = (el, style) => {
    if (hosts && !hosts.letters && el.getRootNode() === document) return null;
    if (!letters.has(el)) {
      const f = getComputedStyle(el, '::first-letter');
      let reach = 0;
      if (f.textShadow !== 'none') for (const shadow of f.textShadow.split(/,(?![^(]*\))/)) {
        const [x = 0, y = 0, blur = 0] = (shadow.replace(/rgba?\([^)]*\)|#\w+|[a-z]+\([^)]*\)/gi, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat);
        reach = Math.max(reach, 1 + Math.max(Math.abs(x), Math.abs(y)) + 1.5 * blur);
      }
      const styled = f.color !== style.color || f.textShadow !== style.textShadow || f.webkitTextStrokeWidth !== style.webkitTextStrokeWidth;
      const size = parseFloat(f.fontSize) || 0, em = parseFloat(style.fontSize) || 0;
      letters.set(el, styled || size > em ? { styled, size: size > em ? size : 0, reach: styled ? reach + (parseFloat(f.webkitTextStrokeWidth) || 0) / 2 : 0 } : null);
    }
    return letters.get(el);
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
      const first = firstLetter(el, style);
      if (first) g = Math.max(g, first.reach);
      reach.set(el, g += filterReach(el));
    }
    return g;
  };
  const plain = new Map(), solid = el => {
    let v = plain.get(el);
    if (v === undefined) {
      const style = getComputedStyle(el);
      plain.set(el, v = !firstLetter(el, style)?.styled && style.textShadow === 'none' && !filterReach(el) && !parseFloat(style.webkitTextStrokeWidth) && style.webkitTextFillColor === style.color
        && style.backgroundClip !== 'text' && style.webkitBackgroundClip !== 'text');
    }
    return v;
  };
  // c: what overflow boxes leave of it (by default, of el's own box).
  // A clipped part is cut with its reach, so a shadow or stroke entering the clip still counts.
  const add = (r, el, text, c = el && clip.of(el)) => {
    const g = el ? grow(el) : 1, solidText = !!(text && el && solid(el) && !/\p{Extended_Pictographic}/u.test(text));
    if (!c) { parts.push({ r: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, grow: g, solidText }); return; }
    const shown = clip.cut({ left: r.left - g, top: r.top - g, right: r.right + g, bottom: r.bottom + g }, c);
    if (shown) parts.push({ r: shown, grow: 0, solidText });
  };
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
  const text = (el, pseudo) => (!hosts || hosts.has(el) || el.tagName === 'Q' || el.shadowRoot || el.getRootNode() !== document) && /"[^"]*[^"\s][^"]*"|counters?\(|attr\(|(open|close)-quote/.test(getComputedStyle(el, pseudo).content);
  const visit = el => {
    // SVG text, and icon-sized SVG in currentColor.
    if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
      if (clip.gone(el) || !drawn(el) || /^(svg|g|defs)$/.test(el.tagName) || el.closest('defs, mask, clipPath, pattern, symbol')) return;
      const style = getComputedStyle(el), r = el.getBoundingClientRect();
      const inked = style.fill === style.color && style.fill !== 'none' || style.stroke === style.color && style.stroke !== 'none';
      if (/^(text|tspan|textPath)$/.test(el.tagName) || inked && r.width <= 64 && r.height <= 64) add(r, el);
      return;
    }
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
    if (clip.gone(el)) return;
    if (!drawn(el)) { if (el.shadowRoot) walk(el.shadowRoot); return; }
    // A larger first letter: WebKit's text rectangles can leave its glyph out, so its own box at the line's start.
    const letter = firstLetter(el, getComputedStyle(el));
    if (letter?.size) { const c = contentBox(el, true); add({ left: c.left, top: c.top, right: c.left + letter.size, bottom: c.top + letter.size * 1.3 }, el, '', clip.in(el)); }
    if (FIELD.test(el.tagName) || el.tagName === 'INPUT' && INPUT_TEXT.test(el.type) || el.tagName === 'AUDIO' && el.controls) add(el.getBoundingClientRect(), el);
    // A same-origin frame is drawn as a picture of its page: all of it stays exact.
    else if (el.tagName === 'IFRAME') { if (el.contentDocument) add(el.getBoundingClientRect(), null, '', clip.of(el)); }
    else if (!REPLACED.test(el.tagName)) {
      // Icon-sized paint in the text's color: a currentColor mask, or a ::before/::after bar, dot or icon.
      for (const p of [null, '::before', '::after']) {
        const cs = getComputedStyle(el, p);
        if (p && (cs.content === 'none' || cs.content === 'normal')) continue;
        const masked = (cs.maskImage ?? 'none') !== 'none' || (cs.webkitMaskImage ?? 'none') !== 'none';
        if (cs.backgroundColor !== cs.color || cs.color === 'rgba(0, 0, 0, 0)' || !(masked || p)) continue;
        const r = el.getBoundingClientRect(), pw = parseFloat(cs.width) || 0, ph = parseFloat(cs.height) || 0;
        if ((p ? pw * ph : r.width * r.height) <= 4096) add(p ? {left: r.left - pw, top: r.top - ph, right: r.right + pw, bottom: r.bottom + ph} : r, el, '', p ? clip.in(el) : clip.of(el));
      }
      // Generated text paints a line of its font past a shorter box (an icon font's <i> of line-height 0).
      const pseudo = ['::before', '::after'].filter(p => text(el, p));
      if (pseudo.length) {
        const r = el.getBoundingClientRect(), em = Math.max(...pseudo.map(p => parseFloat(getComputedStyle(el, p).fontSize) || 0));
        add(r.height < em ? { left: r.left - em / 2, right: r.right + em / 2, top: r.top - em, bottom: r.bottom + em } : r, el, '', clip.in(el));
        // A positioned one paints where its offsets put it, maybe outside the host.
        for (const p of pseudo) { const b = placed(el, p); if (b) add(b, el, '', clip.child(el, getComputedStyle(el, p).position)); }
      }
      const style = getComputedStyle(el);
      if (/list-item/.test(style.display) && (style.listStyleType !== 'none' || style.listStyleImage !== 'none' || !/^(normal|none)$/.test(getComputedStyle(el, '::marker').content))) {
        // The marker sits before the first line, on the inline-start side: right for right to left, above for vertical text.
        const box = el.getBoundingClientRect(), em = parseFloat(style.fontSize), line = parseFloat(style.lineHeight) || em * 1.5;
        const vertical = /^vertical|^sideways/.test(style.writingMode), rtl = style.direction === 'rtl';
        add(!vertical ? { left: rtl ? box.right - 3 * em : box.left - 3 * em, top: box.top, right: rtl ? box.right + 3 * em : box.left + 3 * em, bottom: box.top + line }
          : { left: /-rl$/.test(style.writingMode) ? box.right - line : box.left, right: /-rl$/.test(style.writingMode) ? box.right : box.left + line,
            top: (rtl ? box.bottom : box.top) - 3 * em, bottom: (rtl ? box.bottom : box.top) + 3 * em }, el);
      }
    }
    if (el.shadowRoot) walk(el.shadowRoot);
  };
  const walk = root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) { visit(node); continue; }
      if (!node.data.trim() || node.parentElement && (clip.gone(node.parentElement) || !drawn(node.parentElement))) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) add(r, node.parentElement, node.data, node.parentElement && clip.in(node.parentElement));
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

// An absolute or fixed ::before/::after's box from its offsets, at the drawn scale of its containing block (a
// transform scales the offsets with it); null when it is in flow.
function placed(el, pseudo) {
  const s = getComputedStyle(el, pseudo);
  if (s.position !== 'absolute' && s.position !== 'fixed') return null;
  let block = el;
  while (block && !holds(getComputedStyle(block), s.position)) block = parentOf(block);
  // No block on the page: a fixed one sits in the viewport; an absolute one in the first page box.
  if (!block && s.position !== 'fixed') return null;
  let c = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, kx = 1, ky = 1;
  if (block) {
    const r = block.getBoundingClientRect(), bs = getComputedStyle(block), w = block.offsetWidth, h = block.offsetHeight;
    kx = w ? r.width / w : 1; ky = h ? r.height / h : 1;
    const b = side => parseFloat(bs[`border${side}Width`]) || 0;
    c = { left: r.left + b('Left') * kx, top: r.top + b('Top') * ky, right: r.right - b('Right') * kx, bottom: r.bottom - b('Bottom') * ky };
  }
  const px = v => parseFloat(v), w = (px(s.width) || 0) * kx, h = (px(s.height) || 0) * ky;
  const em = parseFloat(s.fontSize) || 0, line = parseFloat(s.lineHeight) || em * 1.5;
  const left = !isNaN(px(s.left)) ? c.left + px(s.left) * kx : !isNaN(px(s.right)) ? c.right - px(s.right) * kx - w : NaN;
  const top = !isNaN(px(s.top)) ? c.top + px(s.top) * ky : !isNaN(px(s.bottom)) ? c.bottom - px(s.bottom) * ky - h : NaN;
  if (isNaN(left) || isNaN(top)) return null;
  // Its text can run past a box sized smaller than a line.
  return { left, top, right: left + Math.max(w, em * kx), bottom: top + Math.max(h, line * ky) };
}

// Strips along borders and outlines, never whole boxes; a transformed box or stroked SVG shape (soft) gives its whole box.
function edgeParts(root, clip = clipper(root)) {
  const found = [], all = node => [...node.querySelectorAll('*')].flatMap(el => el.shadowRoot ? [el, ...all(el.shadowRoot)] : [el]);
  const turned = new Map(), transformed = el => {
    if (!el || el === root.parentElement) return false;
    let v = turned.get(el);
    if (v === undefined) turned.set(el, v = (getComputedStyle(el).transform ?? 'none') !== 'none' || transformed(el.parentElement ?? el.getRootNode?.().host ?? null));
    return v;
  };
  for (const el of [root, ...(root.shadowRoot ? all(root.shadowRoot) : []), ...all(root)]) {
    if (clip.gone(el) || el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const s = getComputedStyle(el), c = clip.of(el), parts = { push: p => { const shown = clip.cut(p, c); if (shown) found.push(shown); } };
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
      const k = radius + Math.max(t, rt, b, l);
      for (const [x, y] of [[r.left, r.top], [r.right - k, r.top], [r.left, r.bottom - k], [r.right - k, r.bottom - k]]) parts.push({ left: x, top: y, right: x + k, bottom: y + k });
    }
  }
  return found;
}

// Images, SVG images, videos, canvases and CSS backgrounds: inside border (and padding for replaced elements), clipped
// by overflow. A background clipped to text paints only the text, which stays text.
function photoParts(root, clip = clipper(root)) {
  const parts = [], all = node => [...node.querySelectorAll('*')].flatMap(el => el.shadowRoot ? [el, ...all(el.shadowRoot)] : [el]);
  const pictured = el => /^(IMG|VIDEO|CANVAS)$/.test(el.tagName) || el.namespaceURI === 'http://www.w3.org/2000/svg' && el.localName === 'image';
  for (const el of [root, ...(root.shadowRoot ? all(root.shadowRoot) : []), ...all(root)]) {
    if (!pictured(el)) {
      const s = getComputedStyle(el);
      if (!s.backgroundImage.includes('url(') || s.backgroundClip === 'text' || s.webkitBackgroundClip === 'text') continue;
    }
    if (clip.gone(el) || el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = clip.cut(contentBox(el, pictured(el)), clip.of(el));
    if (r) parts.push(r);
  }
  return parts;
}
