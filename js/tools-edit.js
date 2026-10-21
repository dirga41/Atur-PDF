/* Edit: rotate, page numbers, watermark, crop, edit, forms */
'use strict';

defineTool({
  id: 'rotate', cat: 'edit', name: 'Putar PDF', desc: 'Putar semua halaman atau halaman tertentu saja.',
  actionLabel: 'Simpan putaran', keywords: 'rotate putar orientasi',
  async setup(ctx) {
    const pages = await pagesFromItem(ctx.items[0]);
    ctx.opts.pages = pages;
    const grid = pageGrid({ pages, mode: 'rotate' });
    ctx.main.append(h('p', { class: 'muted' }, 'Putar halaman satu per satu dengan tombol di bawah setiap halaman, atau semuanya sekaligus.'), grid.el);
    const all = (d) => { pages.forEach((p) => { p.rotate = ((p.rotate || 0) + d + 360) % 360; }); grid.redraw(); };
    ctx.side.append(h('h3', null, 'Semua halaman'),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => all(270) }, '⟲ Kiri 90°'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => all(90) }, '⟳ Kanan 90°'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => all(180) }, '180°'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { pages.forEach((p) => { p.rotate = 0; }); grid.redraw(); } }, 'Atur ulang')),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { pages.forEach((p, i) => { if (i % 2 === 0) p.rotate = ((p.rotate || 0) + 90) % 360; }); grid.redraw(); } }, 'Putar halaman ganjil'),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { pages.forEach((p, i) => { if (i % 2 === 1) p.rotate = ((p.rotate || 0) + 90) % 360; }); grid.redraw(); } }, 'Putar halaman genap')));
  },
  async run(ctx) {
    const it = ctx.items[0];
    const doc = await openPdfLib(it);
    ctx.opts.pages.forEach((p, i) => { if (p.rotate) { const pg = doc.getPage(i); pg.setRotation(PDFLib.degrees(((pg.getRotation().angle || 0) + p.rotate) % 360)); } });
    return [{ name: baseName(it.name) + '_diputar.pdf', bytes: await savePdf(doc) }];
  },
});

const POS9 = [['tl', '↖'], ['tc', '↑'], ['tr', '↗'], ['ml', '←'], ['mc', '•'], ['mr', '→'], ['bl', '↙'], ['bc', '↓'], ['br', '↘']];
function posPicker(id, value, only6) {
  const wrap = h('div', { class: 'pos9', role: 'radiogroup', id, 'aria-label': 'Posisi' });
  wrap.value = value;
  const draw = () => {
    wrap.innerHTML = '';
    for (const [k, l] of POS9) {
      if (only6 && k[0] === 'm') { wrap.append(h('span', { class: 'pos-gap' })); continue; }
      wrap.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(wrap.value === k), 'aria-label': { tl: 'Kiri atas', tc: 'Tengah atas', tr: 'Kanan atas', ml: 'Kiri tengah', mc: 'Tengah', mr: 'Kanan tengah', bl: 'Kiri bawah', bc: 'Tengah bawah', br: 'Kanan bawah' }[k], onclick: () => { wrap.value = k; draw(); } }, l));
    }
  };
  draw();
  return wrap;
}
function anchorXY(pos, F, w, hh, margin) {
  const x = pos[1] === 'l' ? margin : pos[1] === 'r' ? F.vw - margin - w : (F.vw - w) / 2;
  const y = pos[0] === 't' ? F.vh - margin - hh : pos[0] === 'b' ? margin : (F.vh - hh) / 2;
  return { x, y };
}

defineTool({
  id: 'pagenumbers', cat: 'edit', name: 'Tambah Nomor Halaman', desc: 'Beri nomor halaman dengan posisi, format, dan gaya pilihanmu.',
  actionLabel: 'Tambahkan nomor', keywords: 'nomor halaman page number',
  async setup(ctx) {
    fileList(ctx);
    const d = await openPdfJs(ctx.items[0]); const n = d.numPages;
    ctx.side.append(h('h3', null, 'Penomoran'),
      field('Posisi', posPicker('pn-pos', 'bc', true)),
      field('Format', select('pn-fmt', [['{n}', '1'], ['Halaman {n}', 'Halaman 1'], ['{n} / {t}', '1 / 10'], ['Halaman {n} dari {t}', 'Halaman 1 dari 10'], ['- {n} -', '- 1 -']], '{n}')),
      field('Teks sendiri (opsional)', textInput('pn-custom', '', 'Pakai {n} untuk nomor dan {t} untuk total')),
      h('div', { class: 'row' }, field('Mulai dari nomor', numberInput('pn-start', 1, 0, 99999)), field('Ukuran huruf', numberInput('pn-size', 11, 5, 72))),
      field('Halaman yang diberi nomor', textInput('pn-pages', '', `Kosongkan untuk semua (1-${n})`)),
      h('div', { class: 'row' }, field('Huruf', select('pn-font', FONT_CHOICES, 'Helvetica')), h('div', { class: 'fieldrow' }, h('label', { for: 'pn-color' }, 'Warna'), h('input', { type: 'color', id: 'pn-color', value: '#222222', class: 'swatch' }))),
      field('Margin', segmented('pn-margin', [['18', 'Kecil'], ['30', 'Sedang'], ['48', 'Lebar']], '30')),
      checkbox('pn-mirror', 'Halaman berhadapan (posisi kiri/kanan bergantian)', false));
  },
  async run(ctx) {
    const it = ctx.items[0];
    const doc = await openPdfLib(it);
    const n = doc.getPageCount();
    const sel = val('pn-pages') ? parseRanges(val('pn-pages'), n) : [...Array(n).keys()];
    const fmt = val('pn-custom') || val('pn-fmt');
    const start = +val('pn-start') || 0;
    const size = +val('pn-size') || 11;
    const font = await doc.embedFont(fontKey(val('pn-font'), false, false));
    const color = hexToRgb(val('pn-color'));
    const margin = +val('pn-margin');
    let pos = val('pn-pos');
    const mirror = val('pn-mirror');
    sel.forEach((pi, k) => {
      const page = doc.getPage(pi);
      const F = visualFrame(page);
      const t = winAnsi(fmt.replace(/\{n\}/g, String(start + k)).replace(/\{t\}/g, String(sel.length + start - 1)));
      const w = font.widthOfTextAtSize(t, size);
      let p = pos;
      if (mirror && k % 2 === 1 && p[1] !== 'c') p = p[0] + (p[1] === 'l' ? 'r' : 'l');
      const a = anchorXY(p, F, w, size * 0.72, margin);
      const pt = F.toPdf(a.x, a.y);
      page.drawText(t, { x: pt.x, y: pt.y, size, font, color, rotate: F.deg });
    });
    return [{ name: baseName(it.name) + '_bernomor.pdf', bytes: await savePdf(doc), info: `${sel.length} halaman dinomori` }];
  },
});

defineTool({
  id: 'watermark', cat: 'edit', name: 'Tambah Watermark', desc: 'Bubuhkan teks atau gambar di atas atau di bawah isi halaman.',
  actionLabel: 'Tambahkan watermark', keywords: 'watermark tanda air stempel',
  async setup(ctx) {
    fileList(ctx);
    const imgIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', id: 'wm-img', hidden: true, onchange: () => { const f = imgIn.files[0]; if (f) { ctx.opts.wmImage = f; imgName.textContent = f.name; } } });
    const imgName = h('span', { class: 'muted' }, 'Belum ada gambar');
    const textPanel = h('div', { class: 'stack' },
      field('Teks', textInput('wm-text', 'RAHASIA')),
      h('div', { class: 'row' }, field('Huruf', select('wm-font', FONT_CHOICES, 'Helvetica')), field('Ukuran', numberInput('wm-size', 56, 6, 300))),
      h('div', { class: 'row' }, h('div', { class: 'fieldrow' }, h('label', { for: 'wm-color' }, 'Warna'), h('input', { type: 'color', id: 'wm-color', value: '#c0392b', class: 'swatch' })), checkbox('wm-bold', 'Tebal', true)));
    const imgPanel = h('div', { class: 'stack' }, h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => imgIn.click() }, 'Pilih gambar'), imgName, imgIn),
      field('Lebar gambar (% halaman)', numberInput('wm-iw', 40, 2, 100)));
    const holder = h('div');
    const show = (m) => { holder.innerHTML = ''; holder.append(m === 'text' ? textPanel : imgPanel); };
    ctx.side.append(h('h3', null, 'Watermark'),
      segmented('wm-kind', [['text', 'Teks'], ['image', 'Gambar']], 'text', show), holder,
      field('Posisi', posPicker('wm-pos', 'mc')),
      checkbox('wm-tile', 'Ulangi berpola di seluruh halaman (mozaik)', false),
      field('Kemiringan', segmented('wm-rot', [['0', '0°'], ['45', '45°'], ['-45', '-45°'], ['90', '90°']], '45')),
      field('Transparansi', select('wm-op', [['0.15', '15% (samar)'], ['0.3', '30%'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100% (pekat)']], '0.3')),
      field('Lapisan', segmented('wm-layer', [['over', 'Di atas isi'], ['under', 'Di bawah isi']], 'over')),
      field('Halaman', textInput('wm-pages', '', 'Kosongkan untuk semua')));
    show('text');
  },
  async run(ctx) {
    const it = ctx.items[0];
    const doc = await openPdfLib(it);
    const n = doc.getPageCount();
    const sel = val('wm-pages') ? parseRanges(val('wm-pages'), n) : [...Array(n).keys()];
    const kind = val('wm-kind');
    const op = +val('wm-op'); const ang = +val('wm-rot'); const tile = val('wm-tile'); const under = val('wm-layer') === 'under'; const pos = val('wm-pos');
    let font, text, size, color, img;
    if (kind === 'text') {
      text = winAnsi(val('wm-text') || 'RAHASIA'); size = +val('wm-size') || 48; color = hexToRgb(val('wm-color'));
      font = await doc.embedFont(fontKey(val('wm-font'), val('wm-bold'), false));
    } else {
      if (!ctx.opts.wmImage) throw new Error('Pilih gambar untuk watermark terlebih dahulu.');
      const im = await imageForPdf(ctx.opts.wmImage);
      img = im.kind === 'png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    }
    for (const pi of sel) {
      const page = doc.getPage(pi);
      const F = visualFrame(page);
      let w, hh;
      if (kind === 'text') { w = font.widthOfTextAtSize(text, size); hh = size * 0.7; }
      else { w = F.vw * (+val('wm-iw') || 40) / 100; hh = w * img.height / img.width; }
      const rad = (ang * Math.PI) / 180;
      const place = (cx, cy) => {
        /* rotate around the item's centre in visual space */
        const ox = cx - (w / 2) * Math.cos(rad) + (hh / 2) * Math.sin(rad);
        const oy = cy - (w / 2) * Math.sin(rad) - (hh / 2) * Math.cos(rad);
        const p = F.toPdf(ox, oy);
        const rot = PDFLib.degrees(F.rot + ang);
        if (kind === 'text') page.drawText(text, { x: p.x, y: p.y, size, font, color, opacity: op, rotate: rot });
        else page.drawImage(img, { x: p.x, y: p.y, width: w, height: hh, opacity: op, rotate: rot });
      };
      if (tile) {
        const stepX = w * 1.3 + 40, stepY = Math.max(hh * 3, 90);
        for (let y = -F.vh; y < F.vh * 2; y += stepY) for (let x = -F.vw; x < F.vw * 2; x += stepX) {
          const cx = x + ((Math.round(y / stepY) % 2) * stepX) / 2, cy = y;
          if (cx > -w && cx < F.vw + w && cy > -w && cy < F.vh + w) place(cx, cy);
        }
      } else {
        const bw = Math.abs(w * Math.cos(rad)) + Math.abs(hh * Math.sin(rad)), bh = Math.abs(w * Math.sin(rad)) + Math.abs(hh * Math.cos(rad));
        const a = anchorXY(pos, F, bw, bh, 30);
        place(a.x + bw / 2, a.y + bh / 2);
      }
      if (under) {
        const contents = page.node.Contents();
        if (contents instanceof PDFLib.PDFArray && contents.size() > 1) {
          const last = contents.get(contents.size() - 1);
          contents.remove(contents.size() - 1);
          contents.insert(0, last);
        }
      }
    }
    return [{ name: baseName(it.name) + '_watermark.pdf', bytes: await savePdf(doc) }];
  },
});

defineTool({
  id: 'crop', cat: 'edit', name: 'Pangkas PDF', desc: 'Potong margin atau pilih area halaman yang ingin disimpan.',
  actionLabel: 'Pangkas PDF', keywords: 'crop pangkas potong margin',
  ready: (ctx) => !!ctx.opts.crop,
  async setup(ctx) {
    const ed = makeEditor(ctx, ctx.items[0], { tools: [['crop', 'Pilih area']], initialTool: 'crop' });
    const info = h('p', { class: 'muted', 'aria-live': 'polite' }, 'Seret di halaman untuk memilih area yang disimpan.');
    let boxEl = null;
    const showBox = () => {
      if (boxEl) boxEl.remove(); boxEl = null;
      const c = ctx.opts.crop; if (!c) return;
      const s = ed.stage.scale;
      boxEl = h('div', { class: 'crop-box', style: { left: c.x * s + 'px', top: c.y * s + 'px', width: c.w * s + 'px', height: c.h * s + 'px' } });
      ed.stage.overlay.append(boxEl);
    };
    ed.onCrop = (r) => { ctx.opts.crop = r; ctx.opts.cropPage = ed.stage.index; info.textContent = `Area ${Math.round(r.w)} × ${Math.round(r.h)} pt dipilih.`; showBox(); ctx.refreshAction(); };
    const origRender = ed.stage.show;
    ed.stage.show = async (i) => { await origRender(i); showBox(); };
    ctx.side.append(h('h3', null, 'Area pangkas'), info,
      h('button', { type: 'button', class: 'btn ghost', onclick: async () => {
        const st = ed.stage;
        const c = await renderPage(st.page, { scale: 1 });
        const b = contentBounds(c);
        if (!b) { toast('Halaman ini kosong.', 'error'); return; }
        const pad = 8;
        ed.onCrop({ x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), w: Math.min(c.width, b.w + pad * 2), h: Math.min(c.height, b.h + pad * 2) });
      } }, 'Deteksi margin otomatis'),
      field('Terapkan ke', segmented('cr-scope', [['all', 'Semua halaman'], ['this', 'Halaman ini saja']], 'all')));
  },
  async run(ctx) {
    const it = ctx.items[0];
    const doc = await openPdfLib(it);
    const c = ctx.opts.crop;
    const idx = val('cr-scope') === 'this' ? [ctx.opts.cropPage] : doc.getPageIndices();
    for (const i of idx) {
      const page = doc.getPage(i);
      const F = visualFrame(page);
      const a = F.toPdf(c.x, F.vh - c.y - c.h), b = F.toPdf(c.x + c.w, F.vh - c.y);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      page.setCropBox(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    return [{ name: baseName(it.name) + '_dipangkas.pdf', bytes: await savePdf(doc) }];
  },
});
function contentBounds(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const k = (y * c.width + x) * 4;
    if (d[k] < 245 || d[k + 1] < 245 || d[k + 2] < 245) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

defineTool({
  id: 'edit', cat: 'edit', name: 'Edit PDF', desc: 'Tambahkan teks, gambar, kotak, stabilo, atau coretan tangan ke PDF.',
  actionLabel: 'Simpan perubahan', keywords: 'edit tulis teks anotasi',
  async setup(ctx) {
    const imgIn = h('input', { type: 'file', accept: 'image/*', hidden: true, id: 'ed-imgin', onchange: async () => { const f = imgIn.files[0]; if (f) await ed.addImage(f); imgIn.value = ''; } });
    const ed = makeEditor(ctx, ctx.items[0], {
      tools: [['select', 'Pilih'], ['text', 'Teks'], ['rect', 'Kotak'], ['ellipse', 'Elips'], ['highlight', 'Stabilo'], ['whiteout', 'Tutup putih'], ['pen', 'Pena']],
      toolbarExtra: h('span', { class: 'row' }, h('button', { type: 'button', class: 'tool-btn', onclick: () => imgIn.click() }, 'Gambar…'), imgIn),
    });
    ctx.opts.ed = ed;
    ctx.side.append(h('h3', null, 'Gaya'), propControls(ed),
      h('p', { class: 'hint' }, 'Klik “Teks” lalu klik di halaman untuk menulis. Seret objek untuk memindahkan, tarik sudut kanan bawah untuk mengubah ukuran. Tekan Delete untuk menghapus objek terpilih.'),
      h('p', { class: 'hint' }, '“Tutup putih” menutupi teks lama secara visual. Untuk menghapus isi secara permanen, pakai alat Sensor PDF.'));
  },
  async run(ctx) {
    const ed = ctx.opts.ed;
    if (!ed.objects.length) throw new Error('Belum ada perubahan. Tambahkan teks, gambar, atau bentuk terlebih dahulu.');
    const it = ctx.items[0];
    const doc = await openPdfLib(it);
    await applyObjects(doc, ed.objects);
    return [{ name: baseName(it.name) + '_diedit.pdf', bytes: await savePdf(doc), info: `${ed.objects.length} objek ditambahkan` }];
  },
});

defineTool({
  id: 'forms', cat: 'edit', name: 'Formulir PDF', desc: 'Isi kolom formulir yang ada, atau buat kolom isian baru agar PDF bisa diisi.',
  actionLabel: 'Simpan formulir', keywords: 'form formulir isian fillable',
  async setup(ctx) {
    const it = ctx.items[0];
    const doc = await openPdfLib(it);
    let form; try { form = doc.getForm(); } catch { form = null; }
    const fields = form ? form.getFields() : [];
    ctx.opts.values = new Map();
    const ed = makeEditor(ctx, it, { tools: [['select', 'Pilih'], ['field', 'Tambah kolom teks'], ['check', 'Tambah kotak centang']] });
    ctx.opts.ed = ed;
    let counter = 1;
    ed.onField = (r, kind) => {
      if (kind === 'check') { r.w = r.h = Math.max(10, Math.min(r.w, r.h)); }
      ed.add({ kind: 'field', ftype: kind === 'check' ? 'check' : 'text', name: `${kind === 'check' ? 'centang' : 'kolom'}_${counter++}`, ...r });
    };
    const list = h('div', { class: 'stack' });
    if (!fields.length) list.append(h('p', { class: 'muted' }, 'PDF ini belum punya kolom isian. Pilih “Tambah kolom teks” lalu seret di halaman untuk membuatnya.'));
    for (const f of fields) {
      const name = f.getName();
      const id = 'ff-' + uid();
      let ctl;
      try {
        if (f instanceof PDFLib.PDFTextField) { ctl = f.isMultiline() ? h('textarea', { id, class: 'field', rows: '3' }) : h('input', { type: 'text', id, class: 'field' }); ctl.value = f.getText() || ''; ctl.addEventListener('input', () => ctx.opts.values.set(name, ctl.value)); }
        else if (f instanceof PDFLib.PDFCheckBox) { ctl = h('input', { type: 'checkbox', id, checked: f.isChecked() }); ctl.addEventListener('change', () => ctx.opts.values.set(name, ctl.checked)); }
        else if (f instanceof PDFLib.PDFDropdown || f instanceof PDFLib.PDFOptionList) { const sel = f.getSelected()[0]; ctl = select(id, [['', '—'], ...f.getOptions().map((o) => [o, o])], sel || ''); ctl.addEventListener('change', () => ctx.opts.values.set(name, ctl.value)); }
        else if (f instanceof PDFLib.PDFRadioGroup) { ctl = select(id, [['', '—'], ...f.getOptions().map((o) => [o, o])], f.getSelected() || ''); ctl.addEventListener('change', () => ctx.opts.values.set(name, ctl.value)); }
        else continue;
      } catch { continue; }
      list.append(ctl.type === 'checkbox' ? h('label', { class: 'check', for: id }, ctl, h('span', null, name)) : field(name, ctl));
    }
    ctx.side.append(h('h3', null, `Kolom yang ada (${fields.length})`), list,
      checkbox('fm-flatten', 'Ratakan formulir (isian jadi teks permanen, tidak bisa diubah lagi)', false),
      h('p', { class: 'hint' }, 'Kolom baru yang kamu tambahkan di halaman akan bisa diisi di pembaca PDF mana pun.'));
  },
  async run(ctx) {
    const it = ctx.items[0];
    const doc = await openPdfLib(it);
    const form = doc.getForm();
    for (const [name, v] of ctx.opts.values) {
      const f = form.getField(name);
      if (f instanceof PDFLib.PDFTextField) f.setText(String(v));
      else if (f instanceof PDFLib.PDFCheckBox) v ? f.check() : f.uncheck();
      else if (f instanceof PDFLib.PDFDropdown || f instanceof PDFLib.PDFOptionList) { if (v) f.select(v); else f.clear(); }
      else if (f instanceof PDFLib.PDFRadioGroup) { if (v) f.select(v); else f.clear(); }
    }
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    let added = 0;
    for (const o of ctx.opts.ed.objects) {
      if (o.kind !== 'field') continue;
      const page = doc.getPage(o.page);
      const F = visualFrame(page);
      const a = F.toPdf(o.x, F.vh - o.y - o.h);
      let name = o.name, k = 2; while (safeHas(form, name)) name = `${o.name}_${k++}`;
      const opt = { x: a.x, y: a.y, width: o.w, height: o.h, rotate: F.deg, borderColor: PDFLib.rgb(0.55, 0.6, 0.7), borderWidth: 0.75, backgroundColor: PDFLib.rgb(0.95, 0.97, 1) };
      if (o.ftype === 'check') form.createCheckBox(name).addToPage(page, opt);
      else { const tf = form.createTextField(name); if (o.h > 34) tf.enableMultiline(); tf.addToPage(page, { ...opt, font }); }
      added++;
    }
    try { form.updateFieldAppearances(font); } catch {}
    if (val('fm-flatten')) form.flatten();
    return [{ name: baseName(it.name) + '_formulir.pdf', bytes: await savePdf(doc), info: added ? `${added} kolom baru` : 'isian tersimpan' }];
  },
});
function safeHas(form, name) { try { form.getField(name); return true; } catch { return false; } }
