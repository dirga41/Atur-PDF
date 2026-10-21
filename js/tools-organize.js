/* Organize: merge, split, remove, extract, organize, scan */
'use strict';

const docCacheLib = () => {
  const m = new Map();
  return (item) => { if (!m.has(item.id)) m.set(item.id, openPdfLib(item)); return m.get(item.id); };
};

defineTool({
  id: 'merge', cat: 'organize', name: 'Gabungkan PDF', desc: 'Satukan beberapa PDF menjadi satu file dengan urutan pilihanmu.',
  multiple: true, minFiles: 2, actionLabel: 'Gabungkan PDF', keywords: 'merge combine satukan',
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Urutan'), h('p', { class: 'muted' }, 'File digabung dari atas ke bawah. Pakai tombol panah untuk mengubah urutan.'),
      checkbox('mg-bookmarks', 'Tambahkan nama file sebagai judul bagian (metadata)', false));
  },
  async run(ctx) {
    const out = await PDFLib.PDFDocument.create();
    let i = 0;
    for (const it of ctx.items) {
      ctx.progress.set(i / ctx.items.length, `Menggabungkan ${it.name}`);
      const src = await openPdfLib(it);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      i++;
    }
    out.setTitle(baseName(ctx.items[0].name) + ' (gabungan)');
    if (val('mg-bookmarks')) out.setSubject('Berisi: ' + ctx.items.map((x) => x.name).join(', '));
    ctx.progress.set(1, 'Menyimpan');
    const bytes = await savePdf(out);
    return [{ name: 'gabungan.pdf', bytes, info: `${out.getPageCount()} halaman` }];
  },
});

defineTool({
  id: 'split', cat: 'organize', name: 'Pisahkan PDF', desc: 'Pecah PDF menjadi beberapa file per rentang, per jumlah halaman, atau per ukuran.',
  actionLabel: 'Pisahkan PDF', keywords: 'split pisah pecah bagi',
  async setup(ctx) {
    fileList(ctx);
    const it = ctx.items[0];
    const d = await openPdfJs(it); const n = d.numPages; ctx.opts.n = n;
    const rangeBox = h('div', { class: 'stack' });
    const ranges = [{ a: 1, b: Math.min(n, Math.max(1, Math.ceil(n / 2))) }];
    if (n > 1) ranges.push({ a: Math.min(n, ranges[0].b + 1), b: n });
    ctx.opts.ranges = ranges;
    const drawRanges = () => {
      rangeBox.innerHTML = '';
      ranges.forEach((r, i) => {
        const a = h('input', { type: 'number', class: 'field sm', id: `sp-a-${i}`, min: 1, max: n, value: r.a, 'aria-label': `Rentang ${i + 1} dari halaman`, oninput: (e) => { r.a = +e.target.value; } });
        const b = h('input', { type: 'number', class: 'field sm', id: `sp-b-${i}`, min: 1, max: n, value: r.b, 'aria-label': `Rentang ${i + 1} sampai halaman`, oninput: (e) => { r.b = +e.target.value; } });
        rangeBox.append(h('div', { class: 'range-row' }, h('span', { class: 'muted' }, `Rentang ${i + 1}`), a, h('span', null, 's/d'), b,
          ranges.length > 1 ? h('button', { type: 'button', class: 'mini danger', 'aria-label': `Hapus rentang ${i + 1}`, onclick: () => { ranges.splice(i, 1); drawRanges(); } }, '✕') : null));
      });
      rangeBox.append(h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { const last = ranges[ranges.length - 1]; ranges.push({ a: Math.min(n, (last ? last.b : 0) + 1), b: n }); drawRanges(); } }, '+ Tambah rentang'));
    };
    drawRanges();
    const panels = {
      range: h('div', { class: 'stack' }, rangeBox, checkbox('sp-mergeall', 'Gabungkan semua rentang ke satu PDF', false)),
      fixed: field('Pisahkan setiap', numberInput('sp-every', 1, 1, n), `halaman. Dokumen ini punya ${n} halaman.`),
      all: h('div', { class: 'stack' }, field('Halaman yang diekstrak', textInput('sp-pages', '', `Kosongkan untuk semua (1-${n})`), 'Setiap halaman menjadi satu PDF.')),
      size: field('Ukuran maksimum per file (MB)', numberInput('sp-size', 1, 0.1, 500, 0.1), `Ukuran file sekarang ${fmtBytes(it.size)}.`),
    };
    const holder = h('div');
    const show = (m) => { holder.innerHTML = ''; holder.append(panels[m]); };
    ctx.side.append(h('h3', null, 'Cara memisahkan'),
      segmented('sp-mode', [['range', 'Rentang'], ['fixed', 'Tetap'], ['all', 'Per halaman'], ['size', 'Ukuran']], 'range', show), holder);
    show('range');
  },
  async run(ctx) {
    const it = ctx.items[0];
    const src = await openPdfLib(it);
    const n = src.getPageCount();
    const mode = val('sp-mode');
    const make = async (idx, name) => {
      const d = await PDFLib.PDFDocument.create();
      (await d.copyPages(src, idx)).forEach((p) => d.addPage(p));
      return { name, bytes: await savePdf(d), info: `${idx.length} hlm` };
    };
    const b = baseName(it.name);
    const outs = [];
    if (mode === 'range') {
      const groups = ctx.opts.ranges.map((r) => { const a = Math.max(1, Math.min(n, r.a || 1)), z = Math.max(1, Math.min(n, r.b || n)); const ix = []; for (let i = Math.min(a, z); i <= Math.max(a, z); i++) ix.push(i - 1); return ix; });
      if (val('sp-mergeall')) outs.push(await make(groups.flat(), `${b}_rentang.pdf`));
      else for (let g = 0; g < groups.length; g++) { ctx.progress.set(g / groups.length); const ix = groups[g]; outs.push(await make(ix, `${b}_${ix[0] + 1}-${ix[ix.length - 1] + 1}.pdf`)); }
    } else if (mode === 'fixed') {
      const k = Math.max(1, +val('sp-every') || 1);
      for (let s = 0; s < n; s += k) { ctx.progress.set(s / n); const ix = []; for (let i = s; i < Math.min(n, s + k); i++) ix.push(i); outs.push(await make(ix, `${b}_${s + 1}-${ix[ix.length - 1] + 1}.pdf`)); }
    } else if (mode === 'all') {
      const sel = val('sp-pages') ? parseRanges(val('sp-pages'), n) : [...Array(n).keys()];
      if (!sel.length) throw new Error('Tidak ada halaman yang dipilih.');
      for (let j = 0; j < sel.length; j++) { ctx.progress.set(j / sel.length, `Halaman ${sel[j] + 1}`); outs.push(await make([sel[j]], `${b}_hal-${sel[j] + 1}.pdf`)); }
    } else {
      const max = Math.max(0.05, +val('sp-size') || 1) * 1024 * 1024;
      let cur = [];
      for (let i = 0; i < n; i++) {
        ctx.progress.set(i / n, `Menghitung ukuran halaman ${i + 1}`);
        const trial = await make([...cur, i], 'x.pdf');
        if (trial.bytes.length > max && cur.length) { outs.push(await make(cur, `${b}_bagian-${outs.length + 1}.pdf`)); cur = [i]; }
        else cur.push(i);
      }
      if (cur.length) outs.push(await make(cur, `${b}_bagian-${outs.length + 1}.pdf`));
    }
    return { outputs: outs, zipName: b + '_terpisah' };
  },
});

function selectPagesTool({ id, name, desc, keywords, action, selectLabel, run }) {
  defineTool({
    id, cat: 'organize', name, desc, keywords, actionLabel: action,
    ready: (ctx) => ctx.opts.pages && ctx.opts.pages.some((p) => p.selected),
    async setup(ctx) {
      const pages = await pagesFromItem(ctx.items[0]);
      ctx.opts.pages = pages;
      const inp = textInput('sel-pages', '', 'Contoh: 1-3, 5');
      const counter = h('p', { class: 'muted', 'aria-live': 'polite' });
      const sync = () => { inp.value = rangesToString(pages.flatMap((p, i) => (p.selected ? [i] : []))); counter.textContent = `${pages.filter((p) => p.selected).length} dari ${pages.length} halaman dipilih`; ctx.refreshAction(); };
      const grid = pageGrid({ pages, mode: 'select', onChange: sync });
      inp.addEventListener('change', () => { try { const s = new Set(parseRanges(inp.value, pages.length)); pages.forEach((p, i) => { p.selected = s.has(i); }); grid.redraw(); sync(); } catch (e) { toast(e.message, 'error'); } });
      ctx.main.append(h('p', { class: 'muted' }, `${ctx.items[0].name} · klik halaman untuk memilih`), grid.el);
      ctx.side.append(h('h3', null, selectLabel), field('Halaman', inp), counter,
        h('div', { class: 'row wrap' },
          h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { pages.forEach((p) => { p.selected = true; }); grid.redraw(); sync(); } }, 'Pilih semua'),
          h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { pages.forEach((p, i) => { p.selected = i % 2 === 1; }); grid.redraw(); sync(); } }, 'Genap'),
          h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { pages.forEach((p, i) => { p.selected = i % 2 === 0; }); grid.redraw(); sync(); } }, 'Ganjil'),
          h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { pages.forEach((p) => { p.selected = false; }); grid.redraw(); sync(); } }, 'Kosongkan')));
      if (id === 'extract') ctx.side.append(checkbox('ex-separate', 'Simpan tiap halaman sebagai file terpisah', false));
      sync();
    },
    run,
  });
}

selectPagesTool({
  id: 'remove', name: 'Hapus Halaman', desc: 'Buang halaman yang tidak diperlukan dari PDF.', keywords: 'delete remove buang hapus',
  action: 'Hapus halaman', selectLabel: 'Halaman yang dihapus',
  async run(ctx) {
    const it = ctx.items[0];
    const del = ctx.opts.pages.flatMap((p, i) => (p.selected ? [i] : []));
    if (del.length >= ctx.opts.pages.length) throw new Error('Semua halaman terpilih. Sisakan minimal satu halaman.');
    const src = await openPdfLib(it);
    for (const i of [...del].sort((a, b) => b - a)) src.removePage(i);
    return [{ name: baseName(it.name) + '_dikurangi.pdf', bytes: await savePdf(src), info: `${src.getPageCount()} halaman tersisa` }];
  },
});

selectPagesTool({
  id: 'extract', name: 'Ekstrak Halaman', desc: 'Ambil halaman tertentu menjadi PDF baru.', keywords: 'extract ambil',
  action: 'Ekstrak halaman', selectLabel: 'Halaman yang diambil',
  async run(ctx) {
    const it = ctx.items[0];
    const sel = ctx.opts.pages.flatMap((p, i) => (p.selected ? [i] : []));
    const src = await openPdfLib(it);
    const b = baseName(it.name);
    if (val('ex-separate')) {
      const outs = [];
      for (const i of sel) { const d = await PDFLib.PDFDocument.create(); d.addPage((await d.copyPages(src, [i]))[0]); outs.push({ name: `${b}_hal-${i + 1}.pdf`, bytes: await savePdf(d) }); }
      return { outputs: outs, zipName: b + '_ekstrak' };
    }
    const d = await PDFLib.PDFDocument.create();
    (await d.copyPages(src, sel)).forEach((p) => d.addPage(p));
    return [{ name: `${b}_ekstrak.pdf`, bytes: await savePdf(d), info: `${sel.length} halaman` }];
  },
});

defineTool({
  id: 'organize', cat: 'organize', name: 'Susun Halaman', desc: 'Urutkan ulang, putar, hapus, atau sisipkan halaman dan PDF lain.',
  multiple: true, actionLabel: 'Simpan susunan', keywords: 'organize reorder susun urut',
  ready: (ctx) => ctx.opts.pages && ctx.opts.pages.length > 0,
  async setup(ctx) {
    const pages = [];
    for (const it of ctx.items) pages.push(...(await pagesFromItem(it)));
    ctx.opts.pages = pages;
    const multi = ctx.items.length > 1;
    const letters = new Map(ctx.items.map((it, i) => [it.id, String.fromCharCode(65 + i)]));
    const grid = pageGrid({ pages, mode: 'organize', onChange: () => ctx.refreshAction(), labels: (p, i) => (p.src ? (multi ? `${letters.get(p.src.item.id)}${p.src.index + 1}` : `${p.src.index + 1}`) : 'Kosong') + ` → ${i + 1}` });
    const more = h('input', { type: 'file', accept: '.pdf,application/pdf', multiple: true, hidden: true, id: 'org-more', onchange: async () => {
      for (const f of more.files) { const it = await toItem(f); ctx.items.push(it); letters.set(it.id, String.fromCharCode(64 + ctx.items.length)); pages.push(...(await pagesFromItem(it))); }
      more.value = ''; grid.redraw(); ctx.refreshAction();
    } });
    ctx.main.append(h('p', { class: 'muted' }, 'Seret halaman untuk mengubah urutan, atau pakai tombol panah. Label menunjukkan halaman asal → posisi baru.'), grid.el);
    ctx.side.append(h('h3', null, 'Susunan halaman'),
      h('div', { class: 'stack' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => more.click() }, '+ Sisipkan PDF lain'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { pages.push({ key: uid(), src: null, rotate: 0 }); grid.redraw(); ctx.refreshAction(); } }, '+ Tambah halaman kosong'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { pages.reverse(); grid.redraw(); } }, 'Balik urutan'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { pages.sort((a, b) => (a.src ? ctx.items.indexOf(a.src.item) * 1e5 + a.src.index : 1e9) - (b.src ? ctx.items.indexOf(b.src.item) * 1e5 + b.src.index : 1e9)); pages.forEach((p) => { p.rotate = 0; }); grid.redraw(); } }, 'Kembalikan urutan awal'),
        more),
      h('p', { class: 'hint' }, `${pages.length} halaman dari ${ctx.items.length} file.`));
  },
  async run(ctx) {
    const get = docCacheLib();
    const out = await PDFLib.PDFDocument.create();
    let lastSize = [595.28, 841.89];
    const pages = ctx.opts.pages;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      ctx.progress.set(i / pages.length, `Halaman ${i + 1}`);
      let np;
      if (!p.src) np = out.addPage(lastSize);
      else {
        const src = await get(p.src.item);
        [np] = await out.copyPages(src, [p.src.index]);
        out.addPage(np);
        const s = np.getSize(); lastSize = [s.width, s.height];
      }
      if (p.rotate) np.setRotation(PDFLib.degrees(((np.getRotation().angle || 0) + p.rotate) % 360));
    }
    return [{ name: baseName(ctx.items[0].name) + '_tersusun.pdf', bytes: await savePdf(out), info: `${pages.length} halaman` }];
  },
});

defineTool({
  id: 'scan', cat: 'organize', name: 'Pindai ke PDF', desc: 'Ubah foto dokumen dari kamera ponsel menjadi PDF yang rapi.',
  accept: 'image/*', multiple: true, capture: true, actionLabel: 'Buat PDF', keywords: 'scan pindai kamera foto',
  pickLabel: 'Pilih foto', dropHint: 'atau tarik foto dokumen ke sini',
  filter: (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(f.name),
  setup(ctx) {
    fileList(ctx);
    const prev = h('canvas', { class: 'scan-prev', 'aria-label': 'Pratinjau hasil pindaian' });
    const update = async () => { const it = ctx.items[0]; if (!it) return; const img = await fileToImage(it.file); const c = scanFilter(img, val('sc-filter'), 700); prev.width = c.width; prev.height = c.height; prev.getContext('2d').drawImage(c, 0, 0); };
    ctx.side.append(h('h3', null, 'Hasil pindaian'),
      field('Mode warna', segmented('sc-filter', [['doc', 'Dokumen', 'hitam-putih tajam'], ['gray', 'Abu-abu'], ['color', 'Warna asli']], 'doc', update)),
      field('Ukuran halaman', select('sc-size', [['a4', 'A4'], ['letter', 'Letter'], ['fit', 'Sesuai foto']], 'a4')),
      checkbox('sc-margin', 'Beri margin putih', true),
      h('p', { class: 'muted' }, 'Pratinjau foto pertama:'), prev);
    update();
  },
  async run(ctx) {
    const out = await PDFLib.PDFDocument.create();
    const size = val('sc-size'); const mode = val('sc-filter'); const margin = val('sc-margin') ? 24 : 0;
    for (let i = 0; i < ctx.items.length; i++) {
      ctx.progress.set(i / ctx.items.length, `Foto ${i + 1}`);
      const img = await fileToImage(ctx.items[i].file);
      const c = scanFilter(img, mode, 2200);
      const jpg = await out.embedJpg(await blobBytes(await canvasToBlob(c, 'image/jpeg', mode === 'doc' ? 0.82 : 0.86)));
      addImagePage(out, jpg, c.width, c.height, size, margin);
    }
    return [{ name: 'pindaian.pdf', bytes: await savePdf(out), info: `${ctx.items.length} halaman` }];
  },
});

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792], a3: [841.89, 1190.55], legal: [612, 1008] };
function addImagePage(doc, emb, iw, ih, size, margin, orient = 'auto') {
  let pw, ph;
  if (size === 'fit') { const k = 72 / 96; pw = iw * k + margin * 2; ph = ih * k + margin * 2; }
  else {
    [pw, ph] = PAGE_SIZES[size] || PAGE_SIZES.a4;
    const land = orient === 'landscape' || (orient === 'auto' && iw > ih);
    if (land) [pw, ph] = [ph, pw];
  }
  const page = doc.addPage([pw, ph]);
  const aw = pw - margin * 2, ah = ph - margin * 2;
  const r = Math.min(aw / iw, ah / ih);
  const w = iw * r, hh = ih * r;
  page.drawImage(emb, { x: (pw - w) / 2, y: (ph - hh) / 2, width: w, height: hh });
  return page;
}

function scanFilter(img, mode, maxDim) {
  let w = img.naturalWidth || img.width, hh = img.naturalHeight || img.height;
  if (Math.max(w, hh) > maxDim) { const r = maxDim / Math.max(w, hh); w = Math.round(w * r); hh = Math.round(hh * r); }
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, hh);
  if (mode === 'color') return c;
  const d = x.getImageData(0, 0, w, hh); const p = d.data;
  const lum = new Float32Array(w * hh);
  for (let i = 0, j = 0; i < p.length; i += 4, j++) lum[j] = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
  if (mode === 'gray') {
    let lo = 255, hi = 0; for (const v of lum) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const s = 255 / Math.max(1, hi - lo);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) { const v = (lum[j] - lo) * s; p[i] = p[i + 1] = p[i + 2] = v; }
  } else {
    /* local-mean adaptive threshold via integral image: removes shadows, keeps ink */
    const ii = new Float64Array((w + 1) * (hh + 1));
    for (let y = 1; y <= hh; y++) { let row = 0; for (let xx = 1; xx <= w; xx++) { row += lum[(y - 1) * w + xx - 1]; ii[y * (w + 1) + xx] = ii[(y - 1) * (w + 1) + xx] + row; } }
    const R = Math.max(8, Math.round(Math.min(w, hh) / 24));
    for (let y = 0; y < hh; y++) for (let xx = 0; xx < w; xx++) {
      const x1 = Math.max(0, xx - R), y1 = Math.max(0, y - R), x2 = Math.min(w, xx + R + 1), y2 = Math.min(hh, y + R + 1);
      const sum = ii[y2 * (w + 1) + x2] - ii[y1 * (w + 1) + x2] - ii[y2 * (w + 1) + x1] + ii[y1 * (w + 1) + x1];
      const mean = sum / ((x2 - x1) * (y2 - y1));
      const v = lum[y * w + xx];
      const t = mean * 0.88;
      const o = v < t ? Math.max(0, (v / t) * 90 - 20) : 255;
      const k = (y * w + xx) * 4; p[k] = p[k + 1] = p[k + 2] = o;
    }
  }
  x.putImageData(d, 0, 0);
  return c;
}
