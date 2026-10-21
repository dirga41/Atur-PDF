/* Atur PDF core: DOM helpers, PDF engines, rendering, file I/O, shared widgets */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' KB';
  return (n / 1024 / 1024).toFixed(2).replace('.', ',') + ' MB';
}
function baseName(name) { return name.replace(/\.[^.]+$/, ''); }
function extOf(name) { const m = /\.([^.]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeXml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }

/* Parse "1-3, 5, 8-" into zero-based indices, bounded by total. */
function parseRanges(str, total) {
  const out = [];
  const s = String(str || '').replace(/\s+/g, '');
  if (!s) return out;
  for (const part of s.split(',')) {
    if (!part) continue;
    let m;
    if ((m = /^(\d+)-(\d*)$/.exec(part))) {
      const a = +m[1], b = m[2] === '' ? total : +m[2];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= total) out.push(i - 1);
    } else if ((m = /^(\d+)$/.exec(part))) {
      const a = +m[1]; if (a >= 1 && a <= total) out.push(a - 1);
    } else throw new Error(`Rentang halaman "${part}" tidak dikenali. Contoh yang benar: 1-3, 5, 8-`);
  }
  return out;
}
function rangesToString(idx) {
  const s = [...new Set(idx)].sort((a, b) => a - b).map((i) => i + 1);
  const parts = []; let i = 0;
  while (i < s.length) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; parts.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`); i = j + 1; }
  return parts.join(', ');
}

/* WinAnsi-safe text for pdf-lib standard fonts. */
const WIN_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function winAnsi(s) {
  let o = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c === 9) o += '    ';
    else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_EXTRA.includes(ch)) o += ch;
    else if (c === 0x2010 || c === 0x2011 || c === 0x2212) o += '-';
    else if (c === 0x2032) o += "'";
    else if (c === 0x2033) o += '"';
    else if (c < 32) continue;
    else {
      const n = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      o += /^[\x20-\x7e]+$/.test(n) ? n : '?';
    }
  }
  return o;
}

/* ---------- Engines ---------- */
const LIB = new URL('lib/', document.baseURI).href;
let _pdfjsP = null;
function pdfjs() {
  if (!_pdfjsP) {
    _pdfjsP = import(LIB + 'pdfjs/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = LIB + 'pdfjs/pdf.worker.min.mjs';
      return m;
    });
  }
  return _pdfjsP;
}
const PDFJS_OPTS = () => ({
  standardFontDataUrl: LIB + 'pdfjs/standard_fonts/',
  wasmUrl: LIB + 'pdfjs/wasm/',
  isEvalSupported: false,
  useSystemFonts: true,
});

/* Remember passwords per file id during the session. */
const passwordCache = new Map();

const _jsDocs = new Map();
function openPdfJs(item, opts = {}) {
  if (!_jsDocs.has(item.id)) {
    const p = openPdfJsRaw(item, opts);
    _jsDocs.set(item.id, p);
    p.catch(() => _jsDocs.delete(item.id));
  }
  return _jsDocs.get(item.id);
}
async function openPdfJsRaw(item, opts = {}) {
  const lib = await pdfjs();
  let password = passwordCache.get(item.id);
  for (let attempt = 0; attempt < 6; attempt++) {
    const task = lib.getDocument({ data: item.bytes.slice(), password, ...PDFJS_OPTS() });
    try {
      const doc = await task.promise;
      if (password != null) passwordCache.set(item.id, password);
      return doc;
    } catch (e) {
      if (e && e.name === 'PasswordException') {
        if (opts.noPrompt) throw new Error(`${item.name} dilindungi kata sandi.`);
        password = await askPassword(item.name, attempt > 0);
        if (password == null) throw new Error(`Kata sandi untuk ${item.name} tidak dimasukkan.`);
        continue;
      }
      throw new Error(`${item.name} tidak bisa dibaca sebagai PDF (${e && e.message ? e.message : e}). Coba alat Perbaiki PDF.`);
    }
  }
  throw new Error('Terlalu banyak percobaan kata sandi.');
}

/* Re-write a PDF through pdf.js: removes encryption and rebuilds the file structure. */
let _blankBytes = null;
async function rebuildViaPdfJs(item, opts) {
  const doc = await openPdfJs(item, opts);
  if (!_blankBytes) { const b = await PDFLib.PDFDocument.create(); b.addPage([10, 10]); _blankBytes = await b.save(); }
  const n = doc.numPages;
  const res = await doc.extractPages([{ document: null }, { document: _blankBytes.slice() }]);
  if (!res) throw new Error('Gagal menyusun ulang dokumen.');
  const p = await PDFLib.PDFDocument.load(res, { updateMetadata: false });
  if (p.getPageCount() > n) p.removePage(p.getPageCount() - 1);
  return p;
}

/* Load an editable pdf-lib document; transparently unlocks encrypted files. */
async function openPdfLib(item, opts = {}) {
  try {
    const d = await PDFLib.PDFDocument.load(item.bytes, { updateMetadata: false });
    return d;
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/encrypted/i.test(msg) || opts.allowRebuild !== false) {
      try { return await rebuildViaPdfJs(item, opts); }
      catch (e2) { throw e2; }
    }
    throw e;
  }
}

async function savePdf(doc, opts = {}) {
  return await doc.save({ useObjectStreams: opts.objectStreams !== false, updateMetadata: false });
}

/* ---------- Rendering ---------- */
async function renderPage(page, { scale, width, maxDim, background = '#ffffff', canvas } = {}) {
  const base = page.getViewport({ scale: 1 });
  let s = scale || 1;
  if (width) s = width / base.width;
  if (maxDim) s = Math.min(s, maxDim / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale: s });
  const c = canvas || document.createElement('canvas');
  c.width = Math.max(1, Math.floor(vp.width));
  c.height = Math.max(1, Math.floor(vp.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
  c._viewport = vp;
  return c;
}
function canvasToBlob(c, type = 'image/jpeg', q = 0.9) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Gagal membuat gambar.'))), type, q));
}
async function blobBytes(b) { return new Uint8Array(await b.arrayBuffer()); }
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Gambar tidak bisa dibuka.')); i.src = src; });
}
async function fileToImage(blob) {
  const url = URL.createObjectURL(blob);
  try { return await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}
/* Image (any browser-readable format) -> {bytes, kind, w, h} ready for pdf-lib embedding. */
async function imageForPdf(blob, { maxDim = 0, quality = 0.92, forceJpeg = false } = {}) {
  const t = (blob.type || '').toLowerCase();
  if (!maxDim && !forceJpeg && (t === 'image/jpeg' || t === 'image/png')) {
    const img = await fileToImage(blob);
    return { bytes: await blobBytes(blob), kind: t === 'image/png' ? 'png' : 'jpg', w: img.naturalWidth, h: img.naturalHeight };
  }
  const img = await fileToImage(blob);
  let w = img.naturalWidth, hgt = img.naturalHeight;
  if (maxDim && Math.max(w, hgt) > maxDim) { const r = maxDim / Math.max(w, hgt); w = Math.round(w * r); hgt = Math.round(hgt * r); }
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt); ctx.drawImage(img, 0, 0, w, hgt);
  const b = await canvasToBlob(c, 'image/jpeg', quality);
  return { bytes: await blobBytes(b), kind: 'jpg', w, h: hgt };
}

/* Text lines from a pdf.js page: groups items by baseline. */
async function pageLines(page) {
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  const items = [];
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    if (!it.str && !it.hasEOL) continue;
    const [a, b, , d, e, f] = it.transform;
    const size = Math.hypot(c0(a), c0(b)) || Math.abs(d) || 10;
    const [x, y] = vp.convertToViewportPoint(e, f);
    const style = tc.styles[it.fontName] || {};
    const base = { y, size, font: it.fontName, family: style.fontFamily || '', bold: /bold|black|heavy|semibold/i.test(it.fontName + ' ' + (style.fontFamily || '')) };
    const w = it.width * (vp.scale || 1);
    if (/\S\s{2,}\S/.test(it.str) && it.str.length > 0) {
      /* split column-aligned text that arrives as one string with runs of spaces */
      const per = w / it.str.length;
      const re = /\S+(?: \S+)*/g; let m;
      while ((m = re.exec(it.str))) items.push({ ...base, str: m[0], x: x + per * m.index, w: per * m[0].length });
    } else items.push({ ...base, str: it.str, x, w });
  }
  items.sort((p, q) => (Math.abs(p.y - q.y) < Math.max(2, Math.min(p.size, q.size) * 0.4) ? p.x - q.x : p.y - q.y));
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) < Math.max(2, Math.min(last.size, it.size) * 0.45)) {
      last.items.push(it);
      last.size = Math.max(last.size, it.size);
    } else lines.push({ y: it.y, size: it.size, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((p, q) => p.x - q.x);
    let s = ''; let end = null;
    for (const it of l.items) {
      if (end != null && it.x - end > it.size * 0.25 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' ';
      s += it.str; end = it.x + it.w;
    }
    l.text = s.replace(/\s+/g, ' ').trim();
    l.x = l.items[0].x;
    l.x2 = end;
    l.bold = l.items.every((i) => i.bold || !i.str.trim());
  }
  return { lines: lines.filter((l) => l.text), width: vp.width, height: vp.height };
  function c0(v) { return v || 0; }
}
async function docText(doc, onPage) {
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const r = await pageLines(p);
    pages.push(r);
    onPage && onPage(i, doc.numPages);
  }
  return pages;
}

/* ---------- File items ---------- */
async function toItem(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { id: uid(), file, name: file.name || 'dokumen.pdf', size: bytes.length, bytes, type: file.type || '' };
}
function outputToItem(o) {
  const bytes = o.bytes || o.data;
  const f = new File([bytes], o.name, { type: o.mime || mimeFor(o.name) });
  return { id: uid(), file: f, name: o.name, size: bytes.length, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), type: f.type };
}
function mimeFor(name) {
  return ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', zip: 'application/zip', txt: 'text/plain', md: 'text/markdown', html: 'text/html', csv: 'text/csv', json: 'application/json',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })[extOf(name)] || 'application/octet-stream';
}
async function zipOutputs(outputs, name) {
  const z = new JSZip();
  const used = new Set();
  for (const o of outputs) {
    let n = o.name, k = 1;
    while (used.has(n)) n = baseName(o.name) + ` (${++k}).` + extOf(o.name);
    used.add(n);
    z.file(n, o.bytes);
  }
  const bytes = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { name, bytes };
}

/* ---------- Downloads ---------- */
let _downloadsP = null;
function downloadsCap() {
  if (!_downloadsP) {
    _downloadsP = (async () => {
      try { return window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch { return null; }
    })();
  }
  return _downloadsP;
}
async function saveFile(o) {
  const d = await downloadsCap();
  if (d) {
    try {
      await d.save({ filename: o.name, data: new Blob([o.bytes]) });
      toast(`${o.name} tersimpan.`);
    } catch (e) {
      const code = e && e.code;
      if (code === 'declined') toast('Penyimpanan dibatalkan.');
      else if (code === 'rate_limited') toast('Masih ada jendela simpan yang terbuka. Selesaikan dulu, lalu coba lagi.');
      else if (code === 'rejected_extension' || code === 'extension_not_enabled') toast(`Format .${extOf(o.name)} tidak bisa disimpan di tampilan ini.`, 'error');
      else if (code === 'too_large') toast('File terlalu besar untuk disimpan di tampilan ini.', 'error');
      else toast('Peramban menolak unduhan. Coba izinkan unduhan untuk situs ini.', 'error');
    }
    return;
  }
  try {
    const url = URL.createObjectURL(new Blob([o.bytes], { type: mimeFor(o.name) }));
    const a = h('a', { href: url, download: o.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {
    toast('Unduhan tidak tersedia di tampilan ini.', 'error');
  }
}

/* ---------- Toast & modal ---------- */
function toast(msg, kind = 'info') {
  const box = $('#toasts');
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 3200);
}

function modal({ title, body, actions }) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h3', null, title), body,
      h('div', { class: 'modal-actions' }, actions.map((a) => h('button', { class: 'btn ' + (a.primary ? 'primary' : 'ghost'), type: 'button', onclick: () => close(a.value ? a.value() : a.result) }, a.label))));
    back.append(box); document.body.append(back);
    document.addEventListener('keydown', onKey);
    const f = box.querySelector('input,textarea,select,button.primary'); f && setTimeout(() => f.focus(), 30);
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { const p = box.querySelector('button.primary'); p && p.click(); } });
  });
}
function askPassword(name, retry) {
  const inp = h('input', { type: 'password', id: 'pw-' + uid(), class: 'field', autocomplete: 'off', placeholder: 'Kata sandi' });
  return modal({
    title: retry ? 'Kata sandi salah' : 'File ini terkunci',
    body: h('div', { class: 'stack' }, h('p', null, retry ? `Kata sandi untuk ${name} tidak cocok. Coba lagi.` : `${name} butuh kata sandi untuk dibuka.`), inp),
    actions: [{ label: 'Batal', result: null }, { label: 'Buka', primary: true, value: () => inp.value }],
  });
}
function confirmBox(title, text, okLabel = 'Lanjutkan') {
  return modal({ title, body: h('p', null, text), actions: [{ label: 'Batal', result: false }, { label: okLabel, primary: true, result: true }] });
}

/* ---------- Progress ---------- */
function progressUI() {
  const bar = h('div', { class: 'progress-fill' });
  const label = h('div', { class: 'progress-label' }, 'Menyiapkan…');
  const el = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, label, h('div', { class: 'progress-track' }, bar));
  return {
    el,
    set(frac, text) {
      if (frac != null) { const p = Math.max(0, Math.min(1, frac)) * 100; bar.style.width = p + '%'; el.setAttribute('aria-valuenow', Math.round(p)); }
      if (text) label.textContent = text;
    },
  };
}

/* ---------- Thumbnails grid (shared by many tools) ---------- */
/* pages: [{key, src:{item, index}, rotate, selected, blank}] */
function pageGrid({ pages, mode = 'select', onChange, labels }) {
  const grid = h('div', { class: 'pgrid' + (mode === 'organize' ? ' organize' : ''), role: 'list' });
  const docCache = new Map();
  async function docFor(item) {
    if (!docCache.has(item.id)) docCache.set(item.id, openPdfJs(item));
    return docCache.get(item.id);
  }
  const thumbCache = new Map();
  async function thumb(p) {
    const k = p.src ? p.src.item.id + ':' + p.src.index : 'blank';
    if (!thumbCache.has(k)) {
      thumbCache.set(k, (async () => {
        if (!p.src) { const c = document.createElement('canvas'); c.width = 120; c.height = 170; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 120, 170); return c.toDataURL(); }
        const d = await docFor(p.src.item);
        const pg = await d.getPage(p.src.index + 1);
        const c = await renderPage(pg, { maxDim: 260 });
        return c.toDataURL('image/jpeg', 0.8);
      })());
    }
    return thumbCache.get(k);
  }
  let dragKey = null;
  function draw() {
    grid.innerHTML = '';
    pages.forEach((p, i) => {
      const img = h('img', { alt: `Halaman ${i + 1}`, draggable: 'false' });
      thumb(p).then((u) => { img.src = u; }).catch(() => {});
      const box = h('div', { class: 'pthumb-img', style: { transform: `rotate(${p.rotate || 0}deg)` } }, img);
      const tools = [];
      if (mode === 'organize' || mode === 'rotate') {
        tools.push(h('button', { type: 'button', class: 'mini', title: 'Putar ke kiri', 'aria-label': `Putar halaman ${i + 1} ke kiri`, onclick: (e) => { e.stopPropagation(); p.rotate = ((p.rotate || 0) + 270) % 360; draw(); onChange && onChange(); } }, '⟲'));
        tools.push(h('button', { type: 'button', class: 'mini', title: 'Putar ke kanan', 'aria-label': `Putar halaman ${i + 1} ke kanan`, onclick: (e) => { e.stopPropagation(); p.rotate = ((p.rotate || 0) + 90) % 360; draw(); onChange && onChange(); } }, '⟳'));
      }
      if (mode === 'organize') {
        tools.push(h('button', { type: 'button', class: 'mini danger', title: 'Hapus halaman', 'aria-label': `Hapus halaman ${i + 1}`, onclick: (e) => { e.stopPropagation(); pages.splice(i, 1); draw(); onChange && onChange(); } }, '✕'));
      }
      const card = h('div', {
        class: 'pthumb' + (p.selected ? ' sel' : ''), role: 'listitem', tabindex: mode === 'select' ? '0' : null,
        draggable: mode === 'organize' ? 'true' : null, 'aria-pressed': mode === 'select' ? String(!!p.selected) : null,
        onclick: () => { if (mode === 'select') { p.selected = !p.selected; draw(); onChange && onChange(); } },
        onkeydown: (e) => { if (mode === 'select' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); p.selected = !p.selected; draw(); onChange && onChange(); const n = grid.children[i]; n && n.focus(); } },
        ondragstart: (e) => { dragKey = p.key; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', p.key); } catch {} },
        ondragover: (e) => { if (dragKey) { e.preventDefault(); card.classList.add('over'); } },
        ondragleave: () => card.classList.remove('over'),
        ondrop: (e) => {
          e.preventDefault(); card.classList.remove('over');
          const from = pages.findIndex((x) => x.key === dragKey); dragKey = null;
          if (from < 0 || from === i) return;
          const [m] = pages.splice(from, 1); pages.splice(i, 0, m); draw(); onChange && onChange();
        },
      }, box,
      h('div', { class: 'pthumb-meta' }, h('span', { class: 'num' }, labels ? labels(p, i) : String(i + 1)), tools.length ? h('span', { class: 'pthumb-tools' }, tools) : null));
      if (mode === 'organize') {
        card.append(h('div', { class: 'reorder' },
          h('button', { type: 'button', class: 'mini', 'aria-label': `Pindahkan halaman ${i + 1} ke kiri`, disabled: i === 0, onclick: (e) => { e.stopPropagation(); const [m] = pages.splice(i, 1); pages.splice(i - 1, 0, m); draw(); onChange && onChange(); } }, '←'),
          h('button', { type: 'button', class: 'mini', 'aria-label': `Pindahkan halaman ${i + 1} ke kanan`, disabled: i === pages.length - 1, onclick: (e) => { e.stopPropagation(); const [m] = pages.splice(i, 1); pages.splice(i + 1, 0, m); draw(); onChange && onChange(); } }, '→')));
      }
      grid.append(card);
    });
  }
  draw();
  return { el: grid, redraw: draw, pages };
}

async function pagesFromItem(item) {
  const d = await openPdfJs(item);
  const n = d.numPages;
  return Array.from({ length: n }, (_, i) => ({ key: uid(), src: { item, index: i }, rotate: 0, selected: false }));
}

/* ---------- Page stage: one page at a time with an overlay for placing things ---------- */
function pageStage(item, { onRender } = {}) {
  const canvas = h('canvas', { class: 'stage-canvas' });
  const overlay = h('div', { class: 'stage-overlay' });
  const frame = h('div', { class: 'stage-frame' }, canvas, overlay);
  const label = h('span', { class: 'stage-label' }, '');
  const prev = h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': 'Halaman sebelumnya' }, '← Sebelumnya');
  const next = h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': 'Halaman berikutnya' }, 'Berikutnya →');
  const nav = h('div', { class: 'stage-nav' }, prev, label, next);
  const wrap = h('div', { class: 'stage' }, nav, h('div', { class: 'stage-scroll' }, frame));
  const st = { el: wrap, overlay, canvas, frame, index: 0, count: 0, doc: null, page: null, viewport: null, scale: 1 };
  let renderTok = 0;
  async function show(i) {
    if (!st.doc) st.doc = await openPdfJs(item);
    st.count = st.doc.numPages;
    st.index = Math.max(0, Math.min(st.count - 1, i));
    const tok = ++renderTok;
    const page = await st.doc.getPage(st.index + 1);
    const avail = Math.min(900, Math.max(260, wrap.clientWidth - 4 || 600));
    const base = page.getViewport({ scale: 1 });
    const scale = avail / base.width;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale });
    const hi = page.getViewport({ scale: scale * dpr });
    canvas.width = Math.floor(hi.width); canvas.height = Math.floor(hi.height);
    canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
    frame.style.width = vp.width + 'px'; frame.style.height = vp.height + 'px';
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: hi, canvas }).promise;
    if (tok !== renderTok) return;
    st.page = page; st.viewport = vp; st.scale = scale;
    label.textContent = `Halaman ${st.index + 1} dari ${st.count}`;
    prev.disabled = st.index === 0; next.disabled = st.index === st.count - 1;
    onRender && onRender(st);
  }
  prev.onclick = () => show(st.index - 1);
  next.onclick = () => show(st.index + 1);
  st.show = show;
  /* overlay px -> PDF user space point */
  st.toPdf = (x, y, vp = st.viewport) => vp.convertToPdfPoint(x, y);
  st.rectToPdf = (r, vp = st.viewport) => {
    const [x1, y1] = vp.convertToPdfPoint(r.x, r.y);
    const [x2, y2] = vp.convertToPdfPoint(r.x + r.w, r.y + r.h);
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  };
  return st;
}

/* Rectangle drawing on an overlay. cb(rect in overlay px) */
function enableRectDraw(overlay, cb, cls = 'draw-rect') {
  let start = null, box = null;
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target !== overlay) return;
    const r = overlay.getBoundingClientRect();
    start = { x: e.clientX - r.left, y: e.clientY - r.top };
    box = h('div', { class: cls, style: { left: start.x + 'px', top: start.y + 'px', width: '0px', height: '0px' } });
    overlay.append(box); overlay.setPointerCapture(e.pointerId);
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!start) return;
    const r = overlay.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left)), y = Math.max(0, Math.min(r.height, e.clientY - r.top));
    Object.assign(box.style, { left: Math.min(x, start.x) + 'px', top: Math.min(y, start.y) + 'px', width: Math.abs(x - start.x) + 'px', height: Math.abs(y - start.y) + 'px' });
  });
  const end = () => {
    if (!start) return;
    const rect = { x: parseFloat(box.style.left), y: parseFloat(box.style.top), w: parseFloat(box.style.width), h: parseFloat(box.style.height) };
    box.remove(); start = null;
    if (rect.w > 4 && rect.h > 4) cb(rect);
  };
  overlay.addEventListener('pointerup', end);
  overlay.addEventListener('pointercancel', end);
}

/* Draggable/resizable overlay object (positions stored in overlay px for the page view) */
function placeBox(overlay, { x, y, w, h: hh, content, cls = '', onChange, onDelete, keepRatio = false, label }) {
  const el = h('div', { class: 'place ' + cls, tabindex: '0', 'aria-label': label || 'Objek', style: { left: x + 'px', top: y + 'px', width: w + 'px', height: hh + 'px' } });
  const del = h('button', { type: 'button', class: 'place-del', 'aria-label': 'Hapus objek', onclick: (e) => { e.stopPropagation(); el.remove(); onDelete && onDelete(); } }, '✕');
  const handle = h('span', { class: 'place-handle', 'aria-hidden': 'true' });
  const grip = h('span', { class: 'place-grip', 'aria-hidden': 'true', title: 'Seret untuk memindahkan' });
  el.append(content, grip, del, handle);
  overlay.append(el);
  let mode = null, sx = 0, sy = 0, ox = 0, oy = 0, ow = 0, oh = 0;
  const state = () => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  el.addEventListener('pointerdown', (e) => {
    if (e.target === del) return;
    if (e.target.isContentEditable && e.target !== el) return;
    mode = e.target === handle ? 'resize' : 'move';
    sx = e.clientX; sy = e.clientY; ox = el.offsetLeft; oy = el.offsetTop; ow = el.offsetWidth; oh = el.offsetHeight;
    el.setPointerCapture(e.pointerId); e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    const W = overlay.clientWidth, H = overlay.clientHeight;
    if (mode === 'move') {
      el.style.left = Math.max(-ow / 2, Math.min(W - ow / 2, ox + dx)) + 'px';
      el.style.top = Math.max(-oh / 2, Math.min(H - oh / 2, oy + dy)) + 'px';
    } else {
      let nw = Math.max(16, ow + dx), nh = Math.max(12, oh + dy);
      if (keepRatio) nh = nw * (oh / ow);
      el.style.width = nw + 'px'; el.style.height = nh + 'px';
    }
  });
  const up = () => { if (mode) { mode = null; onChange && onChange(state()); } };
  el.addEventListener('pointerup', up);
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (k) { e.preventDefault(); el.style.left = el.offsetLeft + k[0] + 'px'; el.style.top = el.offsetTop + k[1] + 'px'; onChange && onChange(state()); }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (e.target === el) { e.preventDefault(); el.remove(); onDelete && onDelete(); } }
  });
  el.state = state;
  return el;
}

/* ---------- Claude (AI) access ---------- */
let _sampleP = null;
function sampleCap() {
  if (!_sampleP) {
    _sampleP = (async () => {
      try { return window.claude && window.claude.use ? await window.claude.use('sample') : null; } catch { return null; }
    })();
  }
  return _sampleP;
}
function aiErrorText(e) {
  const c = e && e.code;
  if (c === 'not_granted') return 'Izin memakai Claude belum diberikan untuk halaman ini.';
  if (c === 'rate_limited') return 'Terlalu banyak permintaan ke Claude. Tunggu sebentar, lalu coba lagi.';
  if (c === 'images_unavailable') return 'Tampilan ini tidak bisa mengirim gambar ke Claude.';
  return 'Claude tidak bisa memproses permintaan ini' + (e && e.message ? `: ${e.message}` : '.');
}

/* ---------- Lazy script loader (cdnjs) ---------- */
const _scripts = new Map();
function loadScript(src) {
  if (!_scripts.has(src)) {
    _scripts.set(src, new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { _scripts.delete(src); rej(new Error('Pustaka tambahan gagal dimuat. Periksa koneksi internet.')); };
      document.head.append(s);
    }));
  }
  return _scripts.get(src);
}

/* ---------- XML helpers for OOXML parsing ---------- */
function parseXml(str) { return new DOMParser().parseFromString(str, 'application/xml'); }
function kids(el, local) { return el ? Array.from(el.children).filter((c) => c.localName === local) : []; }
function kid(el, local) { return el ? Array.from(el.children).find((c) => c.localName === local) || null : null; }
function desc(el, local) { return el ? Array.from(el.getElementsByTagNameNS('*', local)) : []; }
function attr(el, name) {
  if (!el) return null;
  if (el.hasAttribute(name)) return el.getAttribute(name);
  for (const a of el.attributes) if (a.localName === name.split(':').pop()) return a.value;
  return null;
}
function resolvePath(base, rel) {
  if (rel.startsWith('/')) return rel.slice(1);
  const parts = base.split('/'); parts.pop();
  for (const p of rel.split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); }
  return parts.join('/');
}
async function readRels(zip, partPath) {
  const dir = partPath.split('/'); const file = dir.pop();
  const relPath = (dir.length ? dir.join('/') + '/' : '') + '_rels/' + file + '.rels';
  const f = zip.file(relPath); const map = {};
  if (!f) return map;
  const x = parseXml(await f.async('string'));
  for (const r of desc(x, 'Relationship')) {
    const t = r.getAttribute('Target');
    map[r.getAttribute('Id')] = { target: r.getAttribute('TargetMode') === 'External' ? t : resolvePath(partPath, t), type: r.getAttribute('Type'), external: r.getAttribute('TargetMode') === 'External' };
  }
  return map;
}
