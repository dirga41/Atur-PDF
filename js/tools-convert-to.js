/* Convert to PDF: JPG, Word, PowerPoint, Excel, HTML */
'use strict';

function pageSetupControls(prefix, { size = 'a4', orient = 'portrait', margin = 'normal', fit = false } = {}) {
  return h('div', { class: 'stack' },
    field('Ukuran kertas', select(prefix + '-size', [['a4', 'A4'], ['letter', 'Letter'], ['legal', 'Legal'], ['a3', 'A3'], ...(fit ? [['fit', 'Sesuai gambar']] : [])], size)),
    field('Orientasi', segmented(prefix + '-orient', [['portrait', 'Potret'], ['landscape', 'Lanskap'], ...(fit ? [['auto', 'Otomatis']] : [])], orient)),
    field('Margin', segmented(prefix + '-margin', [['none', 'Tanpa'], ['small', 'Kecil'], ['normal', 'Normal']], margin)));
}
function readPageSetup(prefix) {
  const size = val(prefix + '-size'), orient = val(prefix + '-orient');
  let [w, hh] = PAGE_SIZES[size] || PAGE_SIZES.a4;
  if (orient === 'landscape') [w, hh] = [hh, w];
  const margin = { none: 0, small: 20, normal: 40 }[val(prefix + '-margin')] ?? 40;
  return { size, orient, w, h: hh, margin };
}

defineTool({
  id: 'jpg2pdf', cat: 'to', name: 'JPG ke PDF', desc: 'Ubah gambar JPG, PNG, WebP, atau GIF menjadi PDF dengan orientasi dan margin pilihanmu.',
  accept: 'image/*', multiple: true, actionLabel: 'Buat PDF', keywords: 'image gambar foto png jpg',
  pickLabel: 'Pilih gambar', dropHint: 'atau tarik gambar ke sini',
  filter: (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name),
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Tata letak'), pageSetupControls('jp', { fit: true, orient: 'auto', margin: 'none' }),
      checkbox('jp-merge', 'Gabungkan semua gambar ke satu PDF', true));
  },
  async run(ctx) {
    const s = readPageSetup('jp');
    const merge = val('jp-merge');
    const outs = [];
    let doc = merge ? await PDFLib.PDFDocument.create() : null;
    for (let i = 0; i < ctx.items.length; i++) {
      ctx.progress.set(i / ctx.items.length, `Gambar ${i + 1}`);
      const it = ctx.items[i];
      const d = doc || await PDFLib.PDFDocument.create();
      const im = await imageForPdf(it.file);
      const emb = im.kind === 'png' ? await d.embedPng(im.bytes) : await d.embedJpg(im.bytes);
      addImagePage(d, emb, im.w, im.h, s.size, s.margin, s.orient);
      if (!merge) outs.push({ name: baseName(it.name) + '.pdf', bytes: await savePdf(d) });
    }
    if (merge) outs.push({ name: ctx.items.length === 1 ? baseName(ctx.items[0].name) + '.pdf' : 'gambar.pdf', bytes: await savePdf(doc), info: `${ctx.items.length} halaman` });
    return { outputs: outs, zipName: 'gambar_pdf' };
  },
});

defineTool({
  id: 'word2pdf', cat: 'to', name: 'Word ke PDF', desc: 'Ubah dokumen DOCX menjadi PDF dengan teks yang tetap bisa dipilih.',
  accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.doc', multiple: true, actionLabel: 'Ubah ke PDF', keywords: 'word docx doc dokumen',
  filter: (f) => /\.docx?$/i.test(f.name),
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Halaman'), h('p', { class: 'muted' }, 'Ukuran kertas dan margin mengikuti pengaturan di dokumen Word.'),
      h('p', { class: 'hint' }, 'Format .doc lama belum didukung. Buka di Word lalu simpan sebagai .docx.'));
  },
  async run(ctx) {
    const outs = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const it = ctx.items[i];
      if (/\.doc$/i.test(it.name)) throw new Error(`${it.name} memakai format .doc lama. Simpan ulang sebagai .docx lalu coba lagi.`);
      ctx.progress.set(i / ctx.items.length, `Membaca ${it.name}`);
      const { html, page } = await docxToHtml(it.bytes);
      const margin = Math.min(page.ml, page.mr, page.mt, page.mb);
      const doc = await htmlToPdf(html, { pageW: page.w, pageH: page.h, margin, onStep: (f, t) => ctx.progress.set((i + f) / ctx.items.length, `${it.name}: ${t}`) });
      doc.setTitle(baseName(it.name));
      outs.push({ name: baseName(it.name) + '.pdf', bytes: await savePdf(doc), info: `${doc.getPageCount()} halaman` });
    }
    return { outputs: outs, zipName: 'word_pdf' };
  },
});

defineTool({
  id: 'ppt2pdf', cat: 'to', name: 'PowerPoint ke PDF', desc: 'Ubah presentasi PPTX menjadi PDF, satu slide per halaman.',
  accept: '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation,.ppt', multiple: true, actionLabel: 'Ubah ke PDF', keywords: 'powerpoint pptx ppt slide presentasi',
  filter: (f) => /\.pptx?$/i.test(f.name),
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Slide'), h('p', { class: 'muted' }, 'Teks, gambar, tabel, bentuk dasar, dan warna tema dibawa ke PDF. Animasi dan grafik bawaan PowerPoint tidak ikut.'),
      h('p', { class: 'hint' }, 'Format .ppt lama belum didukung. Simpan ulang sebagai .pptx.'));
  },
  async run(ctx) {
    const outs = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const it = ctx.items[i];
      if (/\.ppt$/i.test(it.name)) throw new Error(`${it.name} memakai format .ppt lama. Simpan ulang sebagai .pptx lalu coba lagi.`);
      ctx.progress.set(i / ctx.items.length, `Membaca ${it.name}`);
      const { html } = await pptxToHtml(it.bytes);
      const doc = await htmlToPdf(html, { mode: 'pages', pageSelector: '.slide', onStep: (f, t) => ctx.progress.set((i + f) / ctx.items.length, `${it.name}: ${t}`) });
      doc.setTitle(baseName(it.name));
      outs.push({ name: baseName(it.name) + '.pdf', bytes: await savePdf(doc), info: `${doc.getPageCount()} slide` });
    }
    return { outputs: outs, zipName: 'powerpoint_pdf' };
  },
});

defineTool({
  id: 'excel2pdf', cat: 'to', name: 'Excel ke PDF', desc: 'Ubah lembar kerja XLSX atau CSV menjadi tabel PDF yang rapi.',
  accept: '.xlsx,.xlsm,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,.xls', multiple: true, actionLabel: 'Ubah ke PDF', keywords: 'excel xlsx xls csv spreadsheet tabel',
  filter: (f) => /\.(xlsx|xlsm|csv|xls)$/i.test(f.name),
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Tata letak'), pageSetupControls('xl', { orient: 'landscape', margin: 'small' }),
      checkbox('xl-fit', 'Sesuaikan lebar tabel ke halaman', true),
      checkbox('xl-grid', 'Tampilkan garis sel', true),
      checkbox('xl-sheetbreak', 'Setiap lembar di halaman baru', true));
  },
  async run(ctx) {
    const s = readPageSetup('xl');
    const outs = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const it = ctx.items[i];
      ctx.progress.set(i / ctx.items.length, `Membaca ${it.name}`);
      let sheets;
      if (/\.csv$/i.test(it.name)) sheets = [csvToSheet(new TextDecoder().decode(it.bytes), baseName(it.name))];
      else if (/\.xls$/i.test(it.name)) {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
        const wb = XLSX.read(it.bytes, { type: 'array' });
        sheets = wb.SheetNames.map((n) => { const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }); return rowsToSheet(rows, n); });
      } else sheets = await xlsxSheets(it.bytes);
      const contentW = (s.w - s.margin * 2) / 0.75;
      let inner = '';
      sheets.forEach((sh, k) => {
        let scale = 1;
        if (val('xl-fit')) { let tw = 0; for (let c = 0; c <= sh.maxC; c++) tw += sh.cols[c] ? (sh.cols[c].hidden ? 0 : sh.cols[c].w) : 64; if (tw > contentW) scale = Math.max(0.25, contentW / tw); }
        if (k > 0 && val('xl-sheetbreak')) inner += '<div class="pb"></div>';
        inner += sheetToHtml(sh, { scale });
      });
      const doc = await htmlToPdf(xlsxHtmlDoc(inner, val('xl-grid')), { pageW: s.w, pageH: s.h, margin: s.margin, onStep: (f, t) => ctx.progress.set((i + f) / ctx.items.length, `${it.name}: ${t}`) });
      outs.push({ name: baseName(it.name) + '.pdf', bytes: await savePdf(doc), info: `${doc.getPageCount()} halaman` });
    }
    return { outputs: outs, zipName: 'excel_pdf' };
  },
});
function csvToSheet(text, name) {
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rowsToSheet(rows, name);
}
function rowsToSheet(rows, name) {
  const cells = {}; let maxR = -1, maxC = -1;
  rows.forEach((r, ri) => r.forEach((v, ci) => { if (v === '' || v == null) return; const num = /^-?[\d.,]+$/.test(String(v).trim()); cells[ri + ':' + ci] = { v: String(v), num, b: ri === 0 }; maxR = Math.max(maxR, ri); maxC = Math.max(maxC, ci); }));
  const cols = {};
  for (let c = 0; c <= maxC; c++) { let m = 4; for (let r = 0; r <= Math.min(maxR, 200); r++) { const x = cells[r + ':' + c]; if (x) m = Math.max(m, Math.min(60, x.v.length)); } cols[c] = { w: m * 7 + 10 }; }
  return { name, cells, maxR, maxC, cols, merges: [] };
}

defineTool({
  id: 'html2pdf', cat: 'to', name: 'HTML ke PDF', desc: 'Ubah kode atau file HTML menjadi PDF siap cetak.', noFiles: true,
  actionLabel: 'Ubah ke PDF', keywords: 'html web halaman',
  setup(ctx) {
    const ta = h('textarea', { id: 'hp-code', class: 'field code', rows: '16', spellcheck: 'false', 'aria-label': 'Kode HTML' });
    ta.value = `<h1>Undangan Rapat Koordinasi</h1>\n<p>Kepada seluruh anggota tim, rapat koordinasi bulanan akan diadakan pada:</p>\n<table border="1" cellpadding="6" style="border-collapse:collapse">\n  <tr><th>Hari</th><td>Senin, 26 Oktober 2026</td></tr>\n  <tr><th>Waktu</th><td>09.00 WIB</td></tr>\n  <tr><th>Tempat</th><td>Ruang Rapat Lt. 3</td></tr>\n</table>\n<ul><li>Evaluasi kuartal III</li><li>Rencana kuartal IV</li></ul>`;
    const file = h('input', { type: 'file', accept: '.html,.htm,text/html', hidden: true, id: 'hp-file', onchange: async () => { const f = file.files[0]; if (f) { ta.value = await f.text(); ctx.opts.fileName = f.name; toast(`${f.name} dimuat.`); } } });
    const url = textInput('hp-url', '', 'https://contoh.com');
    ctx.main.append(
      h('div', { class: 'row wrap' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => file.click() }, 'Muat file .html'), file),
      field('Kode HTML', ta),
      h('details', { class: 'fold' }, h('summary', null, 'Punya alamat web (URL)?'),
        h('p', { class: 'muted' }, 'Halaman ini tidak bisa mengambil situs lain secara langsung karena alasan keamanan peramban. Buka situsnya, simpan halaman (Ctrl+S, “Halaman web, hanya HTML”), lalu muat filenya di sini.'), url,
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { const u = url.value.trim(); if (/^https?:\/\//.test(u)) { const a = h('a', { href: u, target: '_blank', rel: 'noopener' }); document.body.append(a); a.click(); a.remove(); } else toast('Masukkan URL yang diawali https://', 'error'); } }, 'Buka situs di tab baru')));
    ctx.side.append(h('h3', null, 'Halaman'), pageSetupControls('hp'),
      h('p', { class: 'hint' }, 'Skrip dalam HTML tidak dijalankan. Gambar dari situs lain tidak dimuat; pakai gambar data: atau tempel gambar sebagai base64.'));
  },
  async run(ctx) {
    const s = readPageSetup('hp');
    let code = val('hp-code');
    if (!code.trim()) throw new Error('Kode HTML masih kosong.');
    if (!/<html[\s>]/i.test(code)) code = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:${SANS};font-size:12pt;line-height:1.45;color:#111}</style></head><body>${code}</body></html>`;
    const doc = await htmlToPdf(code, { pageW: s.w, pageH: s.h, margin: s.margin, onStep: (f, t) => ctx.progress.set(f, t) });
    return [{ name: (ctx.opts.fileName ? baseName(ctx.opts.fileName) : 'halaman') + '.pdf', bytes: await savePdf(doc), info: `${doc.getPageCount()} halaman` }];
  },
});
