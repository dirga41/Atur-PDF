/* Visual frame math + an object editor over a page stage (used by Edit, Sign, Redact, Forms, Crop) */
'use strict';

/* Visual coordinates: as the page is seen (crop box + /Rotate applied), origin bottom-left, in pt. */
function visualFrame(page) {
  const cb = page.getCropBox();
  const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  const W = cb.width, H = cb.height;
  const vw = rot % 180 ? H : W, vh = rot % 180 ? W : H;
  function toPdf(vx, vy) {
    let x, y;
    if (rot === 90) { x = W - vy; y = vx; }
    else if (rot === 180) { x = W - vx; y = H - vy; }
    else if (rot === 270) { x = vy; y = H - vx; }
    else { x = vx; y = vy; }
    return { x: x + cb.x, y: y + cb.y };
  }
  return { vw, vh, rot, toPdf, deg: PDFLib.degrees(rot) };
}
/* Draw helpers taking visual top-left based rects (y down, like the screen) */
function vDrawRect(page, F, r, opts) {
  const a = F.toPdf(r.x, F.vh - r.y - r.h);
  page.drawRectangle({ x: a.x, y: a.y, width: r.w, height: r.h, rotate: F.deg, ...opts });
}
function vDrawEllipse(page, F, r, opts) {
  const c = F.toPdf(r.x + r.w / 2, F.vh - r.y - r.h / 2);
  page.drawEllipse({ x: c.x, y: c.y, xScale: r.w / 2, yScale: r.h / 2, rotate: F.deg, ...opts });
}
function vDrawImage(page, F, r, img, opts = {}) {
  const a = F.toPdf(r.x, F.vh - r.y - r.h);
  page.drawImage(img, { x: a.x, y: a.y, width: r.w, height: r.h, rotate: F.deg, ...opts });
}
function vDrawText(page, F, text, x, yTop, { size, font, color, lineHeight = 1.2, opacity = 1 }) {
  const lines = String(text).split('\n');
  lines.forEach((ln, i) => {
    const t = winAnsi(ln);
    if (!t) return;
    const a = F.toPdf(x, F.vh - (yTop + size * 0.82 + i * size * lineHeight));
    page.drawText(t, { x: a.x, y: a.y, size, font, color, opacity, rotate: F.deg });
  });
}
function vDrawPath(page, F, pts, { color, width, opacity = 1 }) {
  if (pts.length < 2) return;
  const d = 'M ' + pts.map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' L ');
  const a = F.toPdf(0, F.vh);
  page.drawSvgPath(d, { x: a.x, y: a.y, rotate: F.deg, borderColor: color, borderWidth: width, borderOpacity: opacity, borderLineCap: PDFLib.LineCapStyle.Round });
}
function hexToRgb(hx) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hx || '#000000');
  return m ? PDFLib.rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : PDFLib.rgb(0, 0, 0);
}
const FONT_CHOICES = [['Helvetica', 'Helvetica (sans)'], ['TimesRoman', 'Times (serif)'], ['Courier', 'Courier (mono)']];
const CSS_FONT = { Helvetica: SANS, TimesRoman: SERIF, Courier: MONO };

/* ---------- Object editor ----------
   objects: [{id, page, kind, x, y, w, h (visual pt, y from top), ...props}] */
function makeEditor(ctx, item, { tools, initialTool = 'select', toolbarExtra, onSelect }) {
  const ed = { objects: [], tool: initialTool, selected: null, props: { color: '#1a1a1a', size: 14, font: 'Helvetica', bold: false, stroke: 2, fill: '#ffe066' } };
  const st = pageStage(item, { onRender: () => drawObjects() });
  ed.stage = st;
  const bar = h('div', { class: 'edit-bar', role: 'toolbar', 'aria-label': 'Alat edit' });
  const drawBar = () => {
    bar.innerHTML = '';
    for (const [id, label] of tools) bar.append(h('button', { type: 'button', class: 'tool-btn', 'aria-pressed': String(ed.tool === id), onclick: () => { ed.tool = id; drawBar(); st.overlay.dataset.tool = id; } }, label));
    if (toolbarExtra) bar.append(toolbarExtra);
  };
  drawBar();
  st.overlay.dataset.tool = ed.tool;
  ctx.main.append(bar, st.el);
  const s = () => st.scale;

  ed.add = (o) => { o.id = o.id || uid(); o.page = o.page ?? st.index; ed.objects.push(o); drawObjects(); select(o); return o; };
  ed.remove = (o) => { ed.objects = ed.objects.filter((x) => x !== o); if (ed.selected === o) ed.selected = null; drawObjects(); };
  ed.redraw = () => drawObjects();
  function select(o) { ed.selected = o; for (const el of st.overlay.querySelectorAll('.place')) el.classList.toggle('selected', el.dataset.id === (o && o.id)); onSelect && onSelect(o); }
  ed.select = select;

  function drawObjects() {
    if (!st.viewport) return;
    st.overlay.querySelectorAll('.place, svg.pen-layer').forEach((e) => e.remove());
    const sc = s();
    const pens = ed.objects.filter((o) => o.page === st.index && o.kind === 'pen');
    if (pens.length) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'pen-layer');
      svg.setAttribute('viewBox', `0 0 ${st.viewport.width} ${st.viewport.height}`);
      for (const o of pens) {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        p.setAttribute('points', o.pts.map((q) => `${q[0] * sc},${q[1] * sc}`).join(' '));
        p.setAttribute('fill', 'none'); p.setAttribute('stroke', o.color); p.setAttribute('stroke-width', o.width * sc); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
        p.addEventListener('click', () => { if (ed.tool === 'select') { if (ed.selected === o) ed.remove(o); else select(o); } });
        svg.append(p);
      }
      st.overlay.append(svg);
    }
    for (const o of ed.objects) {
      if (o.page !== st.index || o.kind === 'pen') continue;
      let content;
      if (o.kind === 'text') {
        content = h('div', { class: 'ptext', contenteditable: 'true', spellcheck: 'false', 'data-ph': 'Ketik di sini', style: { fontSize: o.size * sc + 'px', fontFamily: CSS_FONT[o.font] || SANS, color: o.color, fontWeight: o.bold ? '700' : '400', fontStyle: o.italic ? 'italic' : 'normal', lineHeight: '1.2' } });
        content.innerText = o.text;
        content.addEventListener('input', () => { o.text = content.innerText.replace(/\n$/, ''); });
        content.addEventListener('focus', () => select(o));
      } else if (o.kind === 'image') content = h('img', { src: o.src, alt: '', draggable: 'false', class: 'pimg' });
      else content = h('div', { class: 'pshape ' + o.kind, style: { background: o.kind === 'highlight' ? hexA(o.fill, 0.4) : o.kind === 'whiteout' ? '#ffffff' : o.kind === 'redact' ? '#000' : o.kind === 'field' ? 'rgba(46,111,227,.12)' : o.fillOn ? o.fill : 'transparent', border: o.kind === 'rect' || o.kind === 'ellipse' ? `${Math.max(1, o.width * sc)}px solid ${o.color}` : '', borderRadius: o.kind === 'ellipse' ? '50%' : '' } }, o.kind === 'field' ? h('span', { class: 'field-tag' }, o.ftype === 'check' ? '☐ ' + o.name : o.name) : null);
      const el = placeBox(st.overlay, {
        x: o.x * sc, y: o.y * sc, w: o.w * sc, h: o.h * sc, content, cls: o.kind, keepRatio: o.kind === 'image', label: { text: 'Teks', image: 'Gambar', rect: 'Kotak', ellipse: 'Elips', highlight: 'Stabilo', whiteout: 'Penutup putih', redact: 'Area sensor', field: 'Kolom isian' }[o.kind],
        onChange: (r) => { o.x = r.x / sc; o.y = r.y / sc; o.w = r.w / sc; o.h = r.h / sc; },
        onDelete: () => { ed.objects = ed.objects.filter((x) => x !== o); if (ed.selected === o) select(null); },
      });
      el.dataset.id = o.id;
      el.addEventListener('pointerdown', () => select(o));
      if (ed.selected === o) el.classList.add('selected');
    }
  }
  function hexA(hx, a) { const c = hexToRgb(hx); return `rgba(${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)},${a})`; }

  /* Pointer handling for creation tools */
  let drag = null;
  st.overlay.addEventListener('pointerdown', (e) => {
    if (e.target !== st.overlay && !(e.target.closest && e.target.closest('svg.pen-layer') && ed.tool === 'pen')) { return; }
    const r = st.overlay.getBoundingClientRect();
    const x = (e.clientX - r.left) / s(), y = (e.clientY - r.top) / s();
    const t = ed.tool;
    if (t === 'select') { select(null); return; }
    if (t === 'text') {
      const o = ed.add({ kind: 'text', x, y: y - ed.props.size * 0.6, w: Math.max(60, ed.props.size * 8), h: ed.props.size * 1.5, text: '', size: ed.props.size, font: ed.props.font, color: ed.props.color, bold: ed.props.bold });
      setTimeout(() => { const el = st.overlay.querySelector(`[data-id="${o.id}"] .ptext`); if (el) { el.focus(); document.getSelection().selectAllChildren(el); } }, 20);
      ed.tool = 'select'; drawBar(); st.overlay.dataset.tool = 'select';
      return;
    }
    if (t === 'pen') {
      drag = { kind: 'pen', pts: [[x, y]], poly: null };
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'pen-layer live'); svg.setAttribute('viewBox', `0 0 ${st.viewport.width} ${st.viewport.height}`);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', ed.props.color); p.setAttribute('stroke-width', ed.props.stroke * s()); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
      svg.append(p); st.overlay.append(svg); drag.poly = p; drag.svg = svg;
      st.overlay.setPointerCapture(e.pointerId);
      return;
    }
    if (['rect', 'ellipse', 'highlight', 'whiteout', 'redact', 'field', 'check', 'crop'].includes(t)) {
      drag = { kind: t, x0: x, y0: y, box: h('div', { class: 'draw-rect ' + t, style: { left: x * s() + 'px', top: y * s() + 'px' } }) };
      st.overlay.append(drag.box);
      st.overlay.setPointerCapture(e.pointerId);
    }
  });
  st.overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = st.overlay.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left)) / s(), y = Math.max(0, Math.min(r.height, e.clientY - r.top)) / s();
    if (drag.kind === 'pen') { drag.pts.push([x, y]); drag.poly.setAttribute('points', drag.pts.map((q) => `${q[0] * s()},${q[1] * s()}`).join(' ')); return; }
    drag.x1 = x; drag.y1 = y;
    Object.assign(drag.box.style, { left: Math.min(x, drag.x0) * s() + 'px', top: Math.min(y, drag.y0) * s() + 'px', width: Math.abs(x - drag.x0) * s() + 'px', height: Math.abs(y - drag.y0) * s() + 'px' });
  });
  const finish = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'pen') { d.svg.remove(); if (d.pts.length > 1) ed.add({ kind: 'pen', pts: d.pts, color: ed.props.color, width: ed.props.stroke, x: 0, y: 0, w: 0, h: 0 }); return; }
    d.box.remove();
    if (d.x1 == null) return;
    const rr = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
    if (rr.w * s() < 5 || rr.h * s() < 5) return;
    if (d.kind === 'crop') { ed.onCrop && ed.onCrop(rr); return; }
    if (d.kind === 'field' || d.kind === 'check') { ed.onField && ed.onField(rr, d.kind); return; }
    ed.add({ kind: d.kind, ...rr, color: ed.props.color, width: ed.props.stroke, fill: ed.props.fill, fillOn: ed.props.fillOn });
  };
  st.overlay.addEventListener('pointerup', finish);
  st.overlay.addEventListener('pointercancel', finish);
  st.show(0);
  ed.addImage = async (file, page) => {
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    const maxW = (st.viewport.width / s()) * 0.4;
    const w = Math.min(maxW, img.naturalWidth * 0.75), hh = w * (img.naturalHeight / img.naturalWidth);
    return ed.add({ kind: 'image', src: url, blob: file, x: (st.viewport.width / s() - w) / 2, y: (st.viewport.height / s() - hh) / 2, w, h: hh, page });
  };
  return ed;
}

/* Apply editor objects to a pdf-lib document */
async function applyObjects(doc, objects) {
  const fonts = new Map();
  const font = async (fam, b, i) => { const k = fontKey(fam, b, i); if (!fonts.has(k)) fonts.set(k, await doc.embedFont(k)); return fonts.get(k); };
  const imgs = new Map();
  for (const o of objects) {
    const page = doc.getPage(o.page);
    const F = visualFrame(page);
    if (o.kind === 'text') {
      if (!o.text.trim()) continue;
      vDrawText(page, F, o.text, o.x + 2, o.y + 1, { size: o.size, font: await font(o.font, o.bold, o.italic), color: hexToRgb(o.color) });
    } else if (o.kind === 'image') {
      let emb = imgs.get(o.src);
      if (!emb) { const im = await imageForPdf(o.blob); emb = im.kind === 'png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes); imgs.set(o.src, emb); }
      vDrawImage(page, F, o, emb);
    } else if (o.kind === 'rect') vDrawRect(page, F, o, { borderColor: hexToRgb(o.color), borderWidth: o.width, color: o.fillOn ? hexToRgb(o.fill) : undefined });
    else if (o.kind === 'ellipse') vDrawEllipse(page, F, o, { borderColor: hexToRgb(o.color), borderWidth: o.width, color: o.fillOn ? hexToRgb(o.fill) : undefined });
    else if (o.kind === 'highlight') vDrawRect(page, F, o, { color: hexToRgb(o.fill), opacity: 0.4, blendMode: PDFLib.BlendMode.Multiply });
    else if (o.kind === 'whiteout') vDrawRect(page, F, o, { color: PDFLib.rgb(1, 1, 1) });
    else if (o.kind === 'pen') vDrawPath(page, F, o.pts, { color: hexToRgb(o.color), width: o.width });
  }
}

function propControls(ed, { text = true, stroke = true, fill = true } = {}) {
  const color = h('input', { type: 'color', id: 'ed-color', value: ed.props.color, class: 'swatch', oninput: (e) => { ed.props.color = e.target.value; const o = ed.selected; if (o && 'color' in o) { o.color = e.target.value; ed.redraw(); } } });
  const size = numberInput('ed-size', ed.props.size, 4, 144);
  size.addEventListener('input', () => { ed.props.size = +size.value || 12; const o = ed.selected; if (o && o.kind === 'text') { o.size = ed.props.size; ed.redraw(); } });
  const font = select('ed-font', FONT_CHOICES, ed.props.font);
  font.addEventListener('change', () => { ed.props.font = font.value; const o = ed.selected; if (o && o.kind === 'text') { o.font = font.value; ed.redraw(); } });
  const bold = h('input', { type: 'checkbox', id: 'ed-bold', onchange: (e) => { ed.props.bold = e.target.checked; const o = ed.selected; if (o && o.kind === 'text') { o.bold = e.target.checked; ed.redraw(); } } });
  const sw = numberInput('ed-stroke', ed.props.stroke, 0.5, 30, 0.5);
  sw.addEventListener('input', () => { ed.props.stroke = +sw.value || 1; const o = ed.selected; if (o && 'width' in o && o.kind !== 'image') { o.width = ed.props.stroke; ed.redraw(); } });
  const fillC = h('input', { type: 'color', id: 'ed-fill', value: ed.props.fill, class: 'swatch', oninput: (e) => { ed.props.fill = e.target.value; const o = ed.selected; if (o && 'fill' in o) { o.fill = e.target.value; ed.redraw(); } } });
  const fillOn = h('input', { type: 'checkbox', id: 'ed-fillon', onchange: (e) => { ed.props.fillOn = e.target.checked; const o = ed.selected; if (o && (o.kind === 'rect' || o.kind === 'ellipse')) { o.fillOn = e.target.checked; ed.redraw(); } } });
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('label', { for: 'ed-color', class: 'lbl' }, 'Warna'), color),
    text ? field('Huruf', font) : null,
    text ? h('div', { class: 'row' }, field('Ukuran (pt)', size), h('label', { class: 'check', for: 'ed-bold' }, bold, h('span', null, 'Tebal'))) : null,
    stroke ? field('Tebal garis (pt)', sw) : null,
    fill ? h('div', { class: 'row' }, h('label', { for: 'ed-fill', class: 'lbl' }, 'Isi / stabilo'), fillC, h('label', { class: 'check', for: 'ed-fillon' }, fillOn, h('span', null, 'Isi kotak'))) : null);
}
