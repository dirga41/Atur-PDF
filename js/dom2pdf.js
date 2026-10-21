/* dom2pdf: lays out HTML with the browser, then redraws it as vector PDF with pdf-lib.
   Used by Word, Excel, PowerPoint and HTML to PDF. */
'use strict';

const FONT_DESC = { Helvetica: 0.212, TimesRoman: 0.216, Courier: 0.3 };
const SANS = "Arial, 'Liberation Sans', Helvetica, sans-serif";
const SERIF = "'Times New Roman', 'Liberation Serif', Times, serif";
const MONO = "'Courier New', 'Liberation Mono', Courier, monospace";

function familyOf(cssFamily) {
  const first = (cssFamily || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  if (/mono|courier|consolas|menlo|lucida console/.test(first)) return 'Courier';
  if (/sans/.test(first)) return 'Helvetica';
  if (/^serif$|times|georgia|cambria|garamond|book|palatino|minion|liberation serif/.test(first)) return 'TimesRoman';
  return 'Helvetica';
}
function fontKey(fam, bold, italic) {
  const S = PDFLib.StandardFonts;
  if (fam === 'Courier') return bold && italic ? S.CourierBoldOblique : bold ? S.CourierBold : italic ? S.CourierOblique : S.Courier;
  if (fam === 'TimesRoman') return bold && italic ? S.TimesRomanBoldItalic : bold ? S.TimesRomanBold : italic ? S.TimesRomanItalic : S.TimesRoman;
  return bold && italic ? S.HelveticaBoldOblique : bold ? S.HelveticaBold : italic ? S.HelveticaOblique : S.Helvetica;
}
function parseColor(s) {
  if (!s) return null;
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  const a = p.length > 3 ? p[3] : 1;
  if (a <= 0.01) return null;
  return { c: PDFLib.rgb(p[0] / 255, p[1] / 255, p[2] / 255), a };
}

/* Create an offscreen, script-free iframe and load html into it. */
async function layoutFrame(html, widthPx) {
  const fr = document.createElement('iframe');
  fr.setAttribute('sandbox', 'allow-same-origin');
  fr.setAttribute('aria-hidden', 'true');
  fr.tabIndex = -1;
  Object.assign(fr.style, { position: 'fixed', left: '-30000px', top: '0', width: widthPx + 'px', height: '1200px', border: '0', background: '#fff' });
  document.body.append(fr);
  await new Promise((res) => { fr.onload = res; fr.srcdoc = html; setTimeout(res, 4000); });
  const doc = fr.contentDocument;
  try { await doc.fonts.ready; } catch {}
  await Promise.all(Array.from(doc.images).map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; setTimeout(r, 4000); }))));
  fr.style.height = Math.max(200, doc.documentElement.scrollHeight) + 'px';
  await sleep(30);
  return fr;
}

/* Collect drawable items from a laid-out document. Coordinates are CSS px relative to the body origin. */
async function collectItems(doc) {
  const win = doc.defaultView;
  const origin = doc.body.getBoundingClientRect();
  const ox = origin.left, oy = origin.top + win.scrollY;
  const items = [];
  const range = doc.createRange();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = doc.body;
  const liCounters = new WeakMap();
  while (node) {
    if (node.nodeType === 1) {
      const el = node;
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none') { node = nextSkipping(walker, el); continue; }
      if (cs.visibility !== 'hidden') {
        const r = el.getBoundingClientRect();
        const box = { x: r.left - ox, y: r.top - oy + win.scrollY, w: r.width, h: r.height };
        if (box.w > 0 && box.h > 0) {
          const bg = parseColor(cs.backgroundColor);
          const op = parseFloat(cs.opacity);
          if (bg && el !== doc.body && el !== doc.documentElement) items.push({ k: 'rect', ...box, fill: bg, radius: parseFloat(cs.borderTopLeftRadius) || 0, op });
          for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
            const bw = parseFloat(cs[`border${side}Width`]);
            const st = cs[`border${side}Style`];
            if (bw > 0 && st !== 'none' && st !== 'hidden') {
              const col = parseColor(cs[`border${side}Color`]);
              if (col) items.push({ k: 'border', side, ...box, bw, col, dashed: st === 'dashed' || st === 'dotted' });
            }
          }
          if (el.tagName === 'IMG' && el.complete && el.naturalWidth) items.push({ k: 'img', ...contentBox(box, cs), el, op });
          else if (el.tagName === 'CANVAS') items.push({ k: 'img', ...contentBox(box, cs), el, op });
          else if (el.tagName.toLowerCase() === 'svg') { items.push({ k: 'svg', ...box, el }); node = nextSkipping(walker, el); continue; }
          if (el.tagName === 'LI' && cs.listStyleType !== 'none' && cs.display === 'list-item') {
            const parent = el.parentElement;
            let idx = liCounters.get(el);
            if (idx == null && parent) { let n = parent.tagName === 'OL' ? (parseInt(parent.getAttribute('start') || '1', 10) || 1) : 1; for (const c of parent.children) { if (c.tagName === 'LI') liCounters.set(c, n++); } idx = liCounters.get(el); }
            const type = cs.listStyleType;
            const marker = /decimal/.test(type) ? `${idx}.` : /lower-alpha|lower-latin/.test(type) ? `${String.fromCharCode(96 + ((idx - 1) % 26) + 1)}.` : /upper-alpha|upper-latin/.test(type) ? `${String.fromCharCode(64 + ((idx - 1) % 26) + 1)}.` : /roman/.test(type) ? `${toRoman(idx, /lower/.test(type))}.` : type === 'circle' ? '◦' : type === 'square' ? '▪' : '•';
            const first = firstTextRect(el, range);
            const fs = parseFloat(cs.fontSize);
            if (first) items.push({ k: 'text', t: marker, x: box.x - fs * 1.1 - (marker.length - 1) * fs * 0.45, y: first.top - oy + win.scrollY, h: first.height, w: 0, size: fs, fam: familyOf(cs.fontFamily), bold: false, italic: false, col: parseColor(cs.color), noSqueeze: true });
          }
        }
      }
    } else if (node.nodeType === 3) {
      const tn = node;
      const pe = tn.parentElement;
      const cs = pe ? win.getComputedStyle(pe) : null;
      if (cs && cs.visibility !== 'hidden' && /\S/.test(tn.data)) {
        const col = parseColor(cs.color);
        const size = parseFloat(cs.fontSize);
        const fam = familyOf(cs.fontFamily);
        const bold = parseInt(cs.fontWeight, 10) >= 600 || cs.fontWeight === 'bold';
        const italic = cs.fontStyle === 'italic' || cs.fontStyle === 'oblique';
        const deco = cs.textDecorationLine || cs.textDecoration || '';
        const tt = cs.textTransform;
        const re = /\S+/g; let m;
        while ((m = re.exec(tn.data))) {
          range.setStart(tn, m.index); range.setEnd(tn, m.index + m[0].length);
          const rects = range.getClientRects();
          if (!rects.length) continue;
          let t = m[0];
          if (tt === 'uppercase') t = t.toUpperCase(); else if (tt === 'lowercase') t = t.toLowerCase(); else if (tt === 'capitalize') t = t.charAt(0).toUpperCase() + t.slice(1);
          if (rects.length === 1) {
            const r = rects[0];
            items.push({ k: 'text', t, x: r.left - ox, y: r.top - oy + win.scrollY, w: r.width, h: r.height, size, fam, bold, italic, col, under: /underline/.test(deco), strike: /line-through/.test(deco) });
          } else {
            /* word wrapped across lines (e.g. hyphenation): place characters individually */
            for (let ci = 0; ci < m[0].length; ci++) {
              range.setStart(tn, m.index + ci); range.setEnd(tn, m.index + ci + 1);
              const rr = range.getBoundingClientRect();
              if (rr.width || rr.height) items.push({ k: 'text', t: t[ci], x: rr.left - ox, y: rr.top - oy + win.scrollY, w: rr.width, h: rr.height, size, fam, bold, italic, col, under: /underline/.test(deco) });
            }
          }
        }
      }
    }
    node = walker.nextNode();
  }
  return items;

  function contentBox(b, cs) {
    const pl = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), pt = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    const pr = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth), pb = parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
    return { x: b.x + pl, y: b.y + pt, w: Math.max(1, b.w - pl - pr), h: Math.max(1, b.h - pt - pb) };
  }
  function nextSkipping(w, el) {
    let n = el;
    while (n && !n.nextSibling) { n = n.parentNode; if (!n || n === doc.body) return null; }
    if (!n) return null;
    w.currentNode = n.nextSibling;
    return n.nextSibling;
  }
  function firstTextRect(el, rg) {
    const tw = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = tw.nextNode())) { const i = t.data.search(/\S/); if (i >= 0) { rg.setStart(t, i); rg.setEnd(t, i + 1); const r = rg.getClientRects()[0]; if (r) return r; } }
    return null;
  }
}
function toRoman(n, lower) {
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = ''; for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return lower ? s.toLowerCase() : s;
}

/* Choose page breaks so text lines and small images are never cut. */
function paginate(items, pageH, forced, totalH) {
  const boxes = items.filter((i) => i.k === 'text' || ((i.k === 'img' || i.k === 'svg') && i.h < pageH * 0.95)).map((i) => [i.y, i.y + i.h]).sort((a, b) => a[0] - b[0]);
  forced = (forced || []).filter((f) => f > 1).sort((a, b) => a - b);
  const breaks = [0];
  let S = 0, guard = 0;
  while (S + 0.5 < totalH && guard++ < 5000) {
    let y = S + pageH;
    const f = forced.find((v) => v > S + 1 && v <= y);
    if (f != null) y = f;
    else if (y < totalH) {
      for (let pass = 0; pass < 200; pass++) {
        let moved = false;
        for (const [t, b] of boxes) { if (t >= y) break; if (b > y + 0.5 && t < y - 0.5) { y = t; moved = true; } }
        if (!moved) break;
      }
      if (y <= S + pageH * 0.25) y = S + pageH;
    }
    breaks.push(Math.min(y, totalH));
    S = y;
  }
  return breaks;
}

/* Render html to PDF.
   page: {w,h} in pt, margin pt. mode 'flow' paginates; mode 'pages' uses elements matching pageSelector as pages. */
async function htmlToPdf(html, { pageW = 595.28, pageH = 841.89, margin = 40, mode = 'flow', pageSelector, onStep, outDoc } = {}) {
  const k = 0.75; /* pt per CSS px */
  const contentWpx = mode === 'flow' ? (pageW - margin * 2) / k : 2000;
  const fr = await layoutFrame(html, contentWpx);
  try {
    const doc = fr.contentDocument;
    const items = await collectItems(doc);
    const out = outDoc || await PDFLib.PDFDocument.create();
    const fonts = new Map();
    const font = async (fam, b, i) => { const key = fontKey(fam, b, i); if (!fonts.has(key)) fonts.set(key, await out.embedFont(key)); return fonts.get(key); };
    const imgCache = new Map();
    let pages;
    if (mode === 'pages') {
      const els = Array.from(doc.querySelectorAll(pageSelector));
      const origin = doc.body.getBoundingClientRect();
      pages = els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height, wPt: +el.dataset.wpt || r.width * k, hPt: +el.dataset.hpt || r.height * k }; });
    } else {
      const bodyTop = doc.body.getBoundingClientRect().top;
      const totalH = Math.max(1, ...items.map((i) => i.y + (i.h || 0)), Array.from(doc.body.children).reduce((m, c) => Math.max(m, c.getBoundingClientRect().bottom - bodyTop), 0));
      const pageHpx = (pageH - margin * 2) / k;
      const forced = Array.from(doc.querySelectorAll('.pb, [style*="page-break-before"], [style*="break-before"]')).map((e) => e.getBoundingClientRect().top - doc.body.getBoundingClientRect().top);
      const br = paginate(items, pageHpx, forced, totalH);
      pages = [];
      for (let i = 0; i < br.length - 1; i++) if (br[i + 1] - br[i] > 0.5 || i === 0) pages.push({ x: 0, y: br[i], w: contentWpx, h: br[i + 1] - br[i], wPt: pageW, hPt: pageH, margin });
      if (!pages.length) pages.push({ x: 0, y: 0, w: contentWpx, h: pageHpx, wPt: pageW, hPt: pageH, margin });
    }
    for (let pi = 0; pi < pages.length; pi++) {
      const P = pages[pi];
      onStep && onStep(pi / pages.length, `Halaman ${pi + 1} dari ${pages.length}`);
      const pg = out.addPage([P.wPt, P.hPt]);
      const m = P.margin || 0;
      const kk = mode === 'pages' ? P.wPt / P.w : k;
      const X = (x) => m + (x - P.x) * kk;
      const Y = (y) => P.hPt - m - (y - P.y) * kk;
      const visH = mode === 'pages' ? P.h : P.h;
      pg.pushOperators(PDFLib.pushGraphicsState(), PDFLib.rectangle(m, P.hPt - m - visH * kk, P.w * kk, visH * kk), PDFLib.clip(), PDFLib.endPath());
      for (const it of items) {
        const top = it.y, bot = it.y + (it.h || 0);
        if (it.k === 'text') { const cy = top + it.h / 2; if (cy < P.y || cy >= P.y + P.h) continue; if (mode === 'pages' && (it.x + it.w / 2 < P.x || it.x > P.x + P.w)) continue; }
        else { if (bot <= P.y || top >= P.y + P.h) continue; if (mode === 'pages' && (it.x + it.w <= P.x || it.x >= P.x + P.w)) continue; }
        if (it.k === 'rect') {
          pg.drawRectangle({ x: X(it.x), y: Y(it.y + it.h), width: it.w * kk, height: it.h * kk, color: it.fill.c, opacity: it.fill.a * (isNaN(it.op) ? 1 : it.op) });
        } else if (it.k === 'border') {
          const bw = it.bw * kk;
          const opt = { thickness: bw, color: it.col.c, opacity: it.col.a, dashArray: it.dashed ? [bw * 2, bw * 2] : undefined };
          const x1 = X(it.x), x2 = X(it.x + it.w), y1 = Y(it.y), y2 = Y(it.y + it.h);
          if (it.side === 'Top') pg.drawLine({ start: { x: x1, y: y1 - bw / 2 }, end: { x: x2, y: y1 - bw / 2 }, ...opt });
          if (it.side === 'Bottom') pg.drawLine({ start: { x: x1, y: y2 + bw / 2 }, end: { x: x2, y: y2 + bw / 2 }, ...opt });
          if (it.side === 'Left') pg.drawLine({ start: { x: x1 + bw / 2, y: y1 }, end: { x: x1 + bw / 2, y: y2 }, ...opt });
          if (it.side === 'Right') pg.drawLine({ start: { x: x2 - bw / 2, y: y1 }, end: { x: x2 - bw / 2, y: y2 }, ...opt });
        } else if (it.k === 'img' || it.k === 'svg') {
          let emb = imgCache.get(it.el);
          if (emb === undefined) { emb = await embedElementImage(out, it); imgCache.set(it.el, emb); }
          if (emb) pg.drawImage(emb, { x: X(it.x), y: Y(it.y + it.h), width: it.w * kk, height: it.h * kk, opacity: isNaN(it.op) ? 1 : it.op });
        } else if (it.k === 'text') {
          const t = winAnsi(it.t); if (!t) continue;
          const f = await font(it.fam, it.bold, it.italic);
          const size = it.size * kk;
          const base = Y(it.y + it.h) + size * (FONT_DESC[it.fam] || 0.21) + (it.h * kk - size * 1.15) / 2 * 0;
          const natural = f.widthOfTextAtSize(t, size);
          const target = it.w * kk;
          const col = it.col || { c: PDFLib.rgb(0, 0, 0), a: 1 };
          const sq = !it.noSqueeze && natural > 0 && target > 0 ? Math.max(50, Math.min(200, (target / natural) * 100)) : 100;
          if (Math.abs(sq - 100) > 1) pg.pushOperators(PDFLib.pushGraphicsState(), PDFLib.setCharacterSqueeze(sq));
          pg.drawText(t, { x: X(it.x), y: base, size, font: f, color: col.c, opacity: col.a });
          if (Math.abs(sq - 100) > 1) pg.pushOperators(PDFLib.popGraphicsState());
          if (it.under) pg.drawLine({ start: { x: X(it.x), y: base - size * 0.12 }, end: { x: X(it.x) + target, y: base - size * 0.12 }, thickness: Math.max(0.5, size / 16), color: col.c });
          if (it.strike) pg.drawLine({ start: { x: X(it.x), y: base + size * 0.3 }, end: { x: X(it.x) + target, y: base + size * 0.3 }, thickness: Math.max(0.5, size / 16), color: col.c });
        }
      }
      pg.pushOperators(PDFLib.popGraphicsState());
    }
    return out;
  } finally {
    fr.remove();
  }
}

async function embedElementImage(out, it) {
  try {
    let src = it.el;
    if (it.k === 'svg') {
      const xml = new XMLSerializer().serializeToString(it.el);
      src = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml));
    }
    const scale = 2;
    const w = Math.max(1, Math.min(3000, Math.round(it.w * scale))), hh = Math.max(1, Math.min(3000, Math.round(it.h * scale)));
    const nw = src.naturalWidth || src.width, nh = src.naturalHeight || src.height;
    const c = document.createElement('canvas');
    c.width = Math.min(w, nw || w); c.height = Math.min(hh, nh || hh);
    if (nw && nh && (nw < w || nh < hh)) { c.width = nw; c.height = nh; }
    const x = c.getContext('2d');
    x.drawImage(src, 0, 0, c.width, c.height);
    let alpha = false;
    try { const d = x.getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 16) if (d[i] < 250) { alpha = true; break; } } catch { return null; }
    if (alpha) return await out.embedPng(await blobBytes(await canvasToBlob(c, 'image/png')));
    return await out.embedJpg(await blobBytes(await canvasToBlob(c, 'image/jpeg', 0.9)));
  } catch { return null; }
}
