/* Optimize: compress, repair, OCR */
'use strict';

const COMPRESS_LEVELS = {
  extreme: { max: 1100, q: 0.45, rasterDpi: 72, label: 'Ekstrem' },
  recommended: { max: 1700, q: 0.62, rasterDpi: 110, label: 'Disarankan' },
  low: { max: 2600, q: 0.78, rasterDpi: 150, label: 'Ringan' },
};

defineTool({
  id: 'compress', cat: 'optimize', name: 'Kompres PDF', desc: 'Perkecil ukuran file dengan mengompres ulang gambar di dalamnya.',
  multiple: true, actionLabel: 'Kompres PDF', keywords: 'compress kecilkan ukuran',
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Tingkat kompresi'),
      segmented('cp-level', [['extreme', 'Ekstrem', 'paling kecil, kualitas gambar turun'], ['recommended', 'Disarankan', 'seimbang'], ['low', 'Ringan', 'kualitas tinggi']], 'recommended'),
      checkbox('cp-gray', 'Ubah gambar menjadi hitam-putih (abu-abu)', false),
      checkbox('cp-raster', 'Ubah setiap halaman menjadi gambar (paling kecil untuk hasil pindaian; teks tidak bisa diedit)', false),
      h('p', { class: 'hint' }, 'Teks dan grafik vektor tidak disentuh, kecuali opsi di atas dicentang.'));
  },
  async run(ctx) {
    const L = COMPRESS_LEVELS[val('cp-level')];
    const gray = val('cp-gray'), raster = val('cp-raster');
    const outs = [];
    for (let f = 0; f < ctx.items.length; f++) {
      const it = ctx.items[f];
      const step = (x, t) => ctx.progress.set((f + x) / ctx.items.length, `${it.name}: ${t}`);
      let bytes;
      if (raster) bytes = await rasterizePdf(it, { dpi: L.rasterDpi, q: L.q, gray, keepText: true, step });
      else {
        const doc = await openPdfLib(it);
        const n = await recompressImages(doc, { maxDim: L.max, q: L.q, gray, step });
        step(0.95, 'Menyimpan');
        doc.setProducer('Atur PDF');
        bytes = await savePdf(doc);
      }
      if (bytes.length >= it.size) bytes = it.bytes;
      const saved = 1 - bytes.length / it.size;
      outs.push({ name: baseName(it.name) + '_kompres.pdf', bytes, info: saved > 0.005 ? `hemat ${Math.round(saved * 100)}% dari ${fmtBytes(it.size)}` : `tidak bisa diperkecil lagi (${fmtBytes(it.size)})` });
    }
    const allSame = outs.every((o, i) => o.bytes === ctx.items[i].bytes);
    return { outputs: outs, zipName: 'pdf_terkompres', note: allSame ? (raster ? 'Versi gambar ternyata lebih besar dari file asli, jadi file asli dipertahankan.' : 'File ini sudah optimal: tidak ada gambar yang bisa diperkecil. Untuk hasil pindaian, coba centang opsi “Ubah setiap halaman menjadi gambar”.') : null };
  },
});

/* Re-encode image XObjects as smaller JPEGs. Returns number of images replaced. */
async function recompressImages(doc, { maxDim, q, gray, step }) {
  const { PDFName, PDFRawStream, PDFNumber, PDFArray, PDFDict } = PDFLib;
  const ctx = doc.context;
  const objs = ctx.enumerateIndirectObjects();
  const imgs = objs.filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  let replaced = 0;
  for (let i = 0; i < imgs.length; i++) {
    const [ref, s] = imgs[i];
    step && step(0.9 * (i / Math.max(1, imgs.length)), `Gambar ${i + 1} dari ${imgs.length}`);
    try {
      const d = s.dict;
      if (d.get(PDFName.of('ImageMask'))) continue;
      if (d.get(PDFName.of('Decode'))) continue;
      const bpc = d.get(PDFName.of('BitsPerComponent'));
      const w = num(d.get(PDFName.of('Width'))), hh = num(d.get(PDFName.of('Height')));
      if (!w || !hh || w * hh < 40000) continue;
      const filt = filters(d.get(PDFName.of('Filter')), ctx);
      const nComp = colorComponents(d.get(PDFName.of('ColorSpace')), ctx);
      let source = null;
      if (filt.length === 1 && filt[0] === 'DCTDecode') {
        if (nComp !== 3 && nComp !== 1) continue;
        source = await createImageBitmap(new Blob([s.contents], { type: 'image/jpeg' }));
      } else if (filt.length === 1 && filt[0] === 'FlateDecode' && num(bpc) === 8 && (nComp === 3 || nComp === 1)) {
        let raw = await inflate(s.contents);
        const parms = ctx.lookup(d.get(PDFName.of('DecodeParms')));
        const pred = parms instanceof PDFDict ? num(parms.get(PDFName.of('Predictor'))) : 1;
        if (pred >= 10) raw = unpng(raw, w, nComp, hh);
        else if (pred > 1) continue;
        if (raw.length < w * hh * nComp) continue;
        const id = new ImageData(w, hh); const p = id.data;
        for (let k = 0, j = 0; k < w * hh; k++) {
          if (nComp === 3) { p[k * 4] = raw[j++]; p[k * 4 + 1] = raw[j++]; p[k * 4 + 2] = raw[j++]; }
          else { const v = raw[j++]; p[k * 4] = p[k * 4 + 1] = p[k * 4 + 2] = v; }
          p[k * 4 + 3] = 255;
        }
        source = await createImageBitmap(id);
      } else continue;
      let tw = w, th = hh;
      if (Math.max(w, hh) > maxDim) { const r = maxDim / Math.max(w, hh); tw = Math.max(1, Math.round(w * r)); th = Math.max(1, Math.round(hh * r)); }
      const c = document.createElement('canvas'); c.width = tw; c.height = th;
      const cx = c.getContext('2d');
      if (gray) cx.filter = 'grayscale(1)';
      cx.drawImage(source, 0, 0, tw, th);
      source.close && source.close();
      const jpg = await blobBytes(await canvasToBlob(c, 'image/jpeg', q));
      if (jpg.length >= s.contents.length * 0.92) continue;
      const nd = PDFDict.withContext(ctx);
      for (const [k, v] of d.entries()) nd.set(k, v);
      nd.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      nd.delete(PDFName.of('DecodeParms'));
      nd.set(PDFName.of('Width'), PDFNumber.of(tw));
      nd.set(PDFName.of('Height'), PDFNumber.of(th));
      nd.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      nd.set(PDFName.of('ColorSpace'), PDFName.of(nComp === 1 && !gray ? 'DeviceRGB' : 'DeviceRGB'));
      nd.set(PDFName.of('Length'), PDFNumber.of(jpg.length));
      ctx.assign(ref, PDFRawStream.of(nd, jpg));
      replaced++;
    } catch (e) { /* leave this image untouched */ }
  }
  return replaced;

  function num(v) { v = ctx.lookup(v); return v && typeof v.asNumber === 'function' ? v.asNumber() : 0; }
}
function filters(f, ctx) {
  f = ctx.lookup(f);
  if (!f) return [];
  if (f instanceof PDFLib.PDFName) return [f.decodeText ? f.decodeText() : f.asString().slice(1)];
  if (f instanceof PDFLib.PDFArray) return f.asArray().map((x) => { x = ctx.lookup(x); return x.decodeText ? x.decodeText() : x.asString().slice(1); });
  return ['?'];
}
function colorComponents(cs, ctx) {
  cs = ctx.lookup(cs);
  if (!cs) return 0;
  if (cs instanceof PDFLib.PDFName) { const n = cs.asString(); return n === '/DeviceRGB' ? 3 : n === '/DeviceGray' ? 1 : n === '/DeviceCMYK' ? 4 : 0; }
  if (cs instanceof PDFLib.PDFArray) {
    const kind = ctx.lookup(cs.get(0));
    if (kind && kind.asString && kind.asString() === '/ICCBased') {
      const st = ctx.lookup(cs.get(1));
      const n = st && st.dict ? ctx.lookup(st.dict.get(PDFLib.PDFName.of('N'))) : null;
      return n ? n.asNumber() : 0;
    }
    if (kind && kind.asString && kind.asString() === '/CalRGB') return 3;
    if (kind && kind.asString && kind.asString() === '/CalGray') return 1;
  }
  return 0;
}
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}
async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
}
function unpng(data, w, bpp, hh) {
  const row = w * bpp, out = new Uint8Array(row * hh);
  let p = 0;
  for (let y = 0; y < hh; y++) {
    const ft = data[p++];
    const o = y * row;
    for (let x = 0; x < row; x++) {
      const raw = data[p++] || 0;
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[o - row + x] : 0;
      const c = x >= bpp && y > 0 ? out[o - row + x - bpp] : 0;
      let v;
      switch (ft) {
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: v = raw;
      }
      out[o + x] = v & 255;
    }
  }
  return out;
}

/* Render each page to an image PDF; optionally keep an invisible text layer so it stays searchable. */
async function rasterizePdf(item, { dpi = 110, q = 0.7, gray = false, keepText = true, step, pageFilter, transform } = {}) {
  const src = await openPdfJs(item);
  const out = await PDFLib.PDFDocument.create();
  const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 1; i <= src.numPages; i++) {
    step && step((i - 1) / src.numPages, `Halaman ${i} dari ${src.numPages}`);
    const page = await src.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const c = await renderPage(page, { scale: dpi / 72 });
    if (transform) await transform(c, i - 1, page);
    if (gray) { const x = c.getContext('2d'); x.filter = 'grayscale(1)'; x.drawImage(c, 0, 0); }
    const jpg = await out.embedJpg(await blobBytes(await canvasToBlob(c, 'image/jpeg', q)));
    const p = out.addPage([vp1.width, vp1.height]);
    p.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    if (keepText && !(pageFilter && !pageFilter(i - 1))) await addInvisibleText(p, page, font);
  }
  return await savePdf(out);
}
async function addInvisibleText(pdfPage, jsPage, font) {
  const { lines, height } = await pageLines(jsPage);
  for (const l of lines) {
    const t = winAnsi(l.text); if (!t.trim()) continue;
    const size = Math.max(4, l.size);
    let wTarget = (l.x2 || l.x) - l.x;
    const w = font.widthOfTextAtSize(t, size);
    const hs = wTarget > 4 && w > 0 ? Math.max(20, Math.min(400, (wTarget / w) * 100)) : 100;
    pdfPage.pushOperators(PDFLib.pushGraphicsState(), PDFLib.setCharacterSqueeze(hs));
    pdfPage.drawText(t, { x: l.x, y: height - l.y, size, font, opacity: 0 });
    pdfPage.pushOperators(PDFLib.popGraphicsState());
  }
}

defineTool({
  id: 'repair', cat: 'optimize', name: 'Perbaiki PDF', desc: 'Pulihkan PDF yang rusak atau gagal dibuka dengan menyusun ulang strukturnya.',
  actionLabel: 'Perbaiki PDF', keywords: 'repair rusak corrupt pulihkan',
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Cara kerja'), h('p', { class: 'muted' }, 'Tabel referensi, objek, dan halaman dibaca ulang dalam mode pemulihan, lalu ditulis sebagai file PDF baru yang bersih.'));
  },
  async run(ctx) {
    const it = ctx.items[0];
    const notes = [];
    let doc = null;
    ctx.progress.set(0.2, 'Membaca struktur');
    try { doc = await rebuildViaPdfJs(it); notes.push('Struktur PDF berhasil disusun ulang.'); }
    catch (e) {
      notes.push('Penyusunan ulang penuh gagal; mencoba menyalin halaman yang bisa dibaca.');
      try { doc = await PDFLib.PDFDocument.load(it.bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false }); }
      catch (e2) { throw new Error('File ini terlalu rusak untuk dipulihkan: halaman tidak bisa dibaca sama sekali.'); }
    }
    ctx.progress.set(0.8, 'Menyimpan');
    const bytes = await savePdf(doc);
    return { outputs: [{ name: baseName(it.name) + '_diperbaiki.pdf', bytes, info: `${doc.getPageCount()} halaman` }], note: notes.join(' ') };
  },
});

defineTool({
  id: 'ocr', cat: 'optimize', name: 'OCR PDF', desc: 'Jadikan PDF hasil pindaian bisa dicari dan teksnya bisa disalin.', ai: true,
  actionLabel: 'Kenali teks', keywords: 'ocr scan teks kenali',
  async setup(ctx) {
    fileList(ctx);
    const s = await sampleCap();
    const lim = s ? await s.limits().catch(() => null) : null;
    ctx.opts.ai = s; ctx.opts.canImg = !!(lim && lim.images);
    ctx.side.append(h('h3', null, 'Pengenalan teks'),
      field('Bahasa dokumen', select('ocr-lang', [['auto', 'Deteksi otomatis'], ['Indonesian', 'Indonesia'], ['English', 'Inggris'], ['Javanese', 'Jawa'], ['Arabic', 'Arab'], ['Chinese', 'Mandarin'], ['Japanese', 'Jepang']], 'auto')),
      field('Halaman', textInput('ocr-pages', '', 'Kosongkan untuk semua')),
      h('p', { class: 'hint' }, 'Gambar setiap halaman dibaca oleh Claude. Hasilnya: PDF dengan lapisan teks tak terlihat, ditambah file .txt.'),
      !ctx.opts.canImg ? h('p', { class: 'warn' }, 'OCR belum aktif di situs ini. Pemilik situs perlu mengatur kunci API Claude di server.') : null);
  },
  ready: (ctx) => ctx.opts.canImg,
  async run(ctx) {
    const s = ctx.opts.ai;
    const it = ctx.items[0];
    const src = await openPdfJs(it);
    const n = src.numPages;
    const sel = val('ocr-pages') ? parseRanges(val('ocr-pages'), n) : [...Array(n).keys()];
    const lang = val('ocr-lang');
    const doc = await openPdfLib(it);
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    let fullText = '';
    for (let k = 0; k < sel.length; k++) {
      const i = sel[k];
      ctx.progress.set(k / sel.length, `Membaca halaman ${i + 1} (${k + 1}/${sel.length})`);
      const page = await src.getPage(i + 1);
      const c = await renderPage(page, { maxDim: 1600 });
      const blob = await canvasToBlob(c, 'image/jpeg', 0.85);
      let lines;
      try {
        const r = await s.json(
          `This image is page ${i + 1} of a scanned document${lang !== 'auto' ? ` written in ${lang}` : ''}. Transcribe every line of text exactly as printed, in reading order. ` +
          'Return JSON {"lines":[{"t":"text of the line","x":left,"y":top,"w":width,"h":height}]} where x,y,w,h are the line\'s bounding box as integers from 0 to 1000 relative to the image width and height. Do not translate or correct the text. If there is no text, return {"lines":[]}.',
          { images: [blob], modelTier: 'default' });
        lines = Array.isArray(r && r.lines) ? r.lines : [];
      } catch (e) {
        if (e && (e.code === 'not_granted' || e.code === 'rate_limited' || e.code === 'images_unavailable')) throw new Error(aiErrorText(e));
        const r = await s(`Transcribe all text on this scanned page exactly, in reading order, one line per line. Output only the text.`, { images: [blob], modelTier: 'default' }).catch((e2) => { throw new Error(aiErrorText(e2)); });
        lines = r.text.split('\n').map((t, j, arr) => ({ t, x: 60, y: 40 + (j * 920) / Math.max(1, arr.length), w: 880, h: 900 / Math.max(10, arr.length) }));
      }
      const p = doc.getPage(i);
      const { width: W, height: H } = p.getSize();
      const rot = (p.getRotation().angle || 0) % 360;
      fullText += `--- Halaman ${i + 1} ---\n` + lines.map((l) => l.t).join('\n') + '\n\n';
      for (const l of lines) {
        const t = winAnsi(String(l.t || '')); if (!t.trim()) continue;
        const bx = (+l.x || 0) / 1000, by = (+l.y || 0) / 1000, bw = Math.max(0.02, (+l.w || 500) / 1000), bh = Math.max(0.005, (+l.h || 15) / 1000);
        const pw = rot % 180 ? H : W, ph = rot % 180 ? W : H;
        const size = Math.max(3, Math.min(72, bh * ph * 0.85));
        const tw = font.widthOfTextAtSize(t, size);
        const squeeze = Math.max(10, Math.min(500, ((bw * pw) / Math.max(1, tw)) * 100));
        let x = bx * pw, y = ph - (by + bh) * ph + bh * ph * 0.18;
        if (rot === 90) [x, y] = [W - y, x]; else if (rot === 180) [x, y] = [W - x, H - y]; else if (rot === 270) [x, y] = [y, H - x];
        p.pushOperators(PDFLib.pushGraphicsState(), PDFLib.setCharacterSqueeze(squeeze));
        p.drawText(t, { x, y, size, font, opacity: 0, rotate: PDFLib.degrees(rot) });
        p.pushOperators(PDFLib.popGraphicsState());
      }
    }
    const b = baseName(it.name);
    return { outputs: [{ name: b + '_ocr.pdf', bytes: await savePdf(doc), info: 'bisa dicari' }, { name: b + '_ocr.txt', bytes: new TextEncoder().encode(fullText) }], zipName: b + '_ocr',
      preview: h('pre', { class: 'textprev' }, fullText.slice(0, 6000)) };
  },
});
