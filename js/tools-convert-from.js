/* Convert from PDF: JPG, Word, PowerPoint, Excel, PDF/A */
'use strict';

defineTool({
  id: 'pdf2jpg', cat: 'from', name: 'PDF ke JPG', desc: 'Simpan setiap halaman sebagai gambar, atau ambil semua gambar yang ada di dalam PDF.',
  actionLabel: 'Ubah ke gambar', keywords: 'jpg png gambar image foto',
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Mode'),
      segmented('pj-mode', [['pages', 'Halaman ke gambar', 'setiap halaman jadi satu gambar'], ['extract', 'Ekstrak gambar', 'ambil gambar yang tertanam']], 'pages'),
      field('Format', segmented('pj-fmt', [['jpg', 'JPG'], ['png', 'PNG']], 'jpg')),
      field('Kualitas', select('pj-q', [['96', 'Normal (96 dpi)'], ['150', 'Tinggi (150 dpi)'], ['220', 'Sangat tinggi (220 dpi)'], ['300', 'Cetak (300 dpi)']], '150')),
      field('Halaman', textInput('pj-pages', '', 'Kosongkan untuk semua')));
  },
  async run(ctx) {
    const it = ctx.items[0];
    const d = await openPdfJs(it);
    const n = d.numPages;
    const sel = val('pj-pages') ? parseRanges(val('pj-pages'), n) : [...Array(n).keys()];
    const png = val('pj-fmt') === 'png';
    const b = baseName(it.name);
    const outs = [];
    if (val('pj-mode') === 'pages') {
      const dpi = +val('pj-q');
      for (let k = 0; k < sel.length; k++) {
        ctx.progress.set(k / sel.length, `Halaman ${sel[k] + 1}`);
        const c = await renderPage(await d.getPage(sel[k] + 1), { scale: dpi / 72 });
        outs.push({ name: `${b}_hal-${sel[k] + 1}.${png ? 'png' : 'jpg'}`, bytes: await blobBytes(await canvasToBlob(c, png ? 'image/png' : 'image/jpeg', 0.92)), info: `${c.width}×${c.height}px` });
      }
    } else {
      const lib = await pdfjs();
      const seen = new Set();
      for (let k = 0; k < sel.length; k++) {
        ctx.progress.set(k / sel.length, `Mencari gambar di halaman ${sel[k] + 1}`);
        const page = await d.getPage(sel[k] + 1);
        const ops = await page.getOperatorList();
        for (let j = 0; j < ops.fnArray.length; j++) {
          const fn = ops.fnArray[j];
          if (fn !== lib.OPS.paintImageXObject && fn !== lib.OPS.paintInlineImageXObject && fn !== lib.OPS.paintImageXObjectRepeat) continue;
          const arg = ops.argsArray[j][0];
          let obj = typeof arg === 'string' ? await getObj(page, arg) : arg;
          if (!obj || (typeof arg === 'string' && seen.has(arg))) continue;
          if (typeof arg === 'string') seen.add(arg);
          const c = imageObjToCanvas(obj);
          if (!c || c.width < 16 || c.height < 16) continue;
          outs.push({ name: `${b}_gambar-${outs.length + 1}.${png ? 'png' : 'jpg'}`, bytes: await blobBytes(await canvasToBlob(c, png ? 'image/png' : 'image/jpeg', 0.92)), info: `hlm ${sel[k] + 1} · ${c.width}×${c.height}px` });
        }
      }
      if (!outs.length) return { outputs: [], note: 'Tidak ada gambar yang tertanam di halaman terpilih. Pakai mode “Halaman ke gambar” untuk menyimpan tampilan halaman.' };
    }
    return { outputs: outs, zipName: b + '_gambar' };
  },
});
function getObj(page, id) {
  const store = id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((res) => {
    let done = false;
    try { store.get(id, (o) => { done = true; res(o); }); } catch { res(null); }
    setTimeout(() => { if (!done) res(null); }, 3000);
  });
}
function imageObjToCanvas(o) {
  const c = document.createElement('canvas');
  if (o.bitmap) { c.width = o.bitmap.width; c.height = o.bitmap.height; c.getContext('2d').drawImage(o.bitmap, 0, 0); return c; }
  if (!o.data || !o.width) return null;
  c.width = o.width; c.height = o.height;
  const x = c.getContext('2d'); const id = x.createImageData(o.width, o.height); const p = id.data; const s = o.data;
  if (o.kind === 3) p.set(s.subarray(0, p.length));
  else if (o.kind === 2) for (let i = 0, j = 0; i < p.length; i += 4) { p[i] = s[j++]; p[i + 1] = s[j++]; p[i + 2] = s[j++]; p[i + 3] = 255; }
  else if (o.kind === 1) { const rowBytes = (o.width + 7) >> 3; for (let y = 0; y < o.height; y++) for (let xx = 0; xx < o.width; xx++) { const bit = (s[y * rowBytes + (xx >> 3)] >> (7 - (xx & 7))) & 1; const v = bit ? 255 : 0; const k = (y * o.width + xx) * 4; p[k] = p[k + 1] = p[k + 2] = v; p[k + 3] = 255; } }
  else return null;
  x.putImageData(id, 0, 0);
  return c;
}

/* Group text lines into paragraphs with basic style info. */
function paragraphsFromLines(lines, pageW) {
  if (!lines.length) return [];
  const sizes = lines.flatMap((l) => Array(Math.max(1, Math.min(50, l.text.length))).fill(Math.round(l.size)));
  sizes.sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 11;
  const maxRight = Math.max(...lines.map((l) => l.x2 || 0));
  const minLeft = Math.min(...lines.map((l) => l.x));
  const textW = Math.max(50, maxRight - minLeft);
  const paras = [];
  let cur = null, prev = null;
  for (const l of lines) {
    const centered = Math.abs((l.x + (l.x2 || l.x)) / 2 - pageW / 2) < pageW * 0.04 && (l.x2 - l.x) < textW * 0.8 && l.x > minLeft + 20;
    const startNew = !cur || !prev ||
      l.y - prev.y > Math.max(prev.size, l.size) * 1.75 ||
      Math.abs(l.size - prev.size) > 1.2 ||
      (prev.x2 || 0) < minLeft + textW * 0.62 ||
      l.bold !== prev.bold && l.size > body * 1.15 ||
      Math.abs(l.x - prev.x) > l.size * 2.5 && !centered ||
      /^([•●▪◦\-–*]|\d+[.)]|[a-z][.)])\s/.test(l.text);
    if (startNew) {
      cur = { text: l.text, size: l.size, bold: l.bold, heading: l.size >= body * 1.3 || (l.bold && l.size >= body * 1.12), align: centered ? 'center' : 'left', indent: Math.max(0, l.x - minLeft), spaceBefore: prev ? Math.max(0, l.y - prev.y - prev.size * 1.2) : 0, x1: l.x, x2: l.x2 || l.x, top: l.y - l.size, bot: l.y + l.size * 0.28, nlines: 1, body, lines: [l] };
      paras.push(cur);
    } else {
      cur.x1 = Math.min(cur.x1, l.x); cur.x2 = Math.max(cur.x2, l.x2 || l.x); cur.bot = l.y + l.size * 0.28; cur.nlines++; cur.lines.push(l);
      cur.text = /[-‐]$/.test(cur.text) && /^[a-z]/.test(l.text) ? cur.text.slice(0, -1) + l.text : cur.text + ' ' + l.text;
      if (!centered && cur.align === 'center') cur.align = 'left';
    }
    prev = l;
  }
  return paras;
}

defineTool({
  id: 'pdf2word', cat: 'from', name: 'PDF ke Word', desc: 'Ubah PDF menjadi dokumen DOCX yang bisa diedit.',
  actionLabel: 'Ubah ke Word', keywords: 'word docx dokumen edit',
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Mode konversi'),
      segmented('pw-mode', [['text', 'Teks bisa diedit', 'paragraf, judul, ukuran huruf'], ['image', 'Tata letak persis', 'setiap halaman sebagai gambar']], 'text'),
      checkbox('pw-scan', 'Halaman tanpa teks (hasil pindaian) disisipkan sebagai gambar', true),
      h('p', { class: 'hint' }, 'Untuk PDF hasil pindaian, jalankan OCR PDF dulu agar teksnya bisa diedit.'));
  },
  async run(ctx) {
    await loadScript(LIB + 'docx.iife.js');
    const D = window.docx;
    const it = ctx.items[0];
    const src = await openPdfJs(it);
    const mode = val('pw-mode');
    const sections = [];
    let first = null;
    const children = [];
    for (let i = 1; i <= src.numPages; i++) {
      ctx.progress.set((i - 1) / src.numPages, `Halaman ${i} dari ${src.numPages}`);
      const page = await src.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      if (!first) first = vp;
      const contentW = vp.width - 72;
      const pageImage = async () => {
        const c = await renderPage(page, { scale: 150 / 72 });
        const data = await blobBytes(await canvasToBlob(c, 'image/jpeg', 0.85));
        const wpx = contentW * 96 / 72, hpx = wpx * c.height / c.width;
        return new D.Paragraph({ pageBreakBefore: i > 1, children: [new D.ImageRun({ type: 'jpg', data, transformation: { width: Math.round(wpx), height: Math.round(hpx) } })] });
      };
      if (mode === 'image') { children.push(await pageImage()); continue; }
      const { lines } = await pageLines(page);
      const chars = lines.reduce((a, l) => a + l.text.length, 0);
      if (chars < 15 && val('pw-scan')) { children.push(await pageImage()); continue; }
      const paras = paragraphsFromLines(lines, vp.width);
      paras.forEach((p, k) => {
        children.push(new D.Paragraph({
          pageBreakBefore: i > 1 && k === 0,
          alignment: p.align === 'center' ? D.AlignmentType.CENTER : D.AlignmentType.LEFT,
          indent: p.indent > 8 && p.align !== 'center' ? { left: Math.round(p.indent * 20) } : undefined,
          spacing: { before: Math.round(Math.min(24, p.spaceBefore) * 20), after: 120 },
          children: [new D.TextRun({ text: p.text, bold: p.bold || p.heading, size: Math.max(12, Math.round(p.size * 2)), font: 'Calibri' })],
        }));
      });
      if (!paras.length) children.push(new D.Paragraph({ pageBreakBefore: i > 1, children: [] }));
    }
    const doc = new D.Document({
      creator: 'Atur PDF', title: baseName(it.name),
      sections: [{ properties: { page: { size: { width: Math.round(first.width * 20), height: Math.round(first.height * 20) }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children }],
    });
    const blob = await D.Packer.toBlob(doc);
    return [{ name: baseName(it.name) + '.docx', bytes: await blobBytes(blob) }];
  },
});

defineTool({
  id: 'pdf2ppt', cat: 'from', name: 'PDF ke PowerPoint', desc: 'Ubah setiap halaman PDF menjadi slide PPTX.',
  actionLabel: 'Ubah ke PowerPoint', keywords: 'powerpoint pptx slide presentasi',
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Isi slide'),
      segmented('pp-mode', [['image', 'Tampilan persis', 'halaman sebagai gambar'], ['text', 'Teks bisa diedit', 'kotak teks di slide putih'], ['both', 'Keduanya', 'gambar + kotak teks di atasnya']], 'image'));
  },
  async run(ctx) {
    await loadScript(LIB + 'pptxgen.min.js');
    const it = ctx.items[0];
    const src = await openPdfJs(it);
    const mode = val('pp-mode');
    const pptx = new window.PptxGenJS();
    const v1 = (await src.getPage(1)).getViewport({ scale: 1 });
    const W = v1.width / 72, H = v1.height / 72;
    pptx.defineLayout({ name: 'PDF', width: W, height: H });
    pptx.layout = 'PDF';
    pptx.title = baseName(it.name);
    for (let i = 1; i <= src.numPages; i++) {
      ctx.progress.set((i - 1) / src.numPages, `Slide ${i} dari ${src.numPages}`);
      const page = await src.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const sx = W / (vp.width / 72), sy = H / (vp.height / 72);
      const slide = pptx.addSlide();
      if (mode !== 'text') {
        const c = await renderPage(page, { scale: 150 / 72 });
        slide.addImage({ data: c.toDataURL('image/jpeg', 0.85), x: 0, y: 0, w: W, h: H });
      }
      if (mode !== 'image') {
        const { lines } = await pageLines(page);
        for (const l of lines) {
          const w = Math.max(0.3, ((l.x2 || l.x + l.size * l.text.length * 0.5) - l.x) / 72 * sx + 0.2);
          slide.addText(l.text, { x: (l.x / 72) * sx, y: ((l.y - l.size) / 72) * sy, w: Math.min(W, w), h: (l.size * 1.4) / 72 * sy, fontSize: Math.max(6, Math.round(l.size * sy)), bold: l.bold, fontFace: 'Arial', margin: 0, valign: 'top', color: mode === 'both' ? '000000' : '111111', transparency: mode === 'both' ? 100 : 0, fit: 'none', wrap: false });
        }
      }
    }
    const buf = await pptx.write({ outputType: 'arraybuffer' });
    const np = src.numPages;
    return [{ name: baseName(it.name) + '.pptx', bytes: new Uint8Array(buf), info: `${np} slide` }];
  },
});

defineTool({
  id: 'pdf2excel', cat: 'from', name: 'PDF ke Excel', desc: 'Tarik tabel dan data dari PDF ke lembar kerja XLSX.',
  actionLabel: 'Ubah ke Excel', keywords: 'excel xlsx tabel data spreadsheet',
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Lembar kerja'),
      segmented('px-sheets', [['page', 'Satu lembar per halaman'], ['one', 'Semua di satu lembar']], 'page'),
      checkbox('px-num', 'Ubah angka menjadi nilai numerik', true),
      h('p', { class: 'hint' }, 'Kolom ditebak dari posisi teks. Cocok untuk laporan, faktur, dan tabel berbasis teks.'));
  },
  async run(ctx) {
    const it = ctx.items[0];
    const src = await openPdfJs(it);
    const perPage = val('px-sheets') === 'page';
    const toNum = val('px-num');
    const sheets = [];
    let all = [];
    for (let i = 1; i <= src.numPages; i++) {
      ctx.progress.set((i - 1) / src.numPages, `Halaman ${i}`);
      const page = await src.getPage(i);
      const rows = await pageTable(page);
      if (perPage) sheets.push({ name: `Halaman ${i}`, rows });
      else { if (all.length) all.push([]); all = all.concat(rows); }
    }
    if (!perPage) sheets.push({ name: 'Data', rows: all });
    const bytes = await buildXlsx(sheets, toNum);
    const total = sheets.reduce((a, s) => a + s.rows.length, 0);
    return { outputs: [{ name: baseName(it.name) + '.xlsx', bytes, info: `${total} baris` }], note: total === 0 ? 'Tidak ada teks yang bisa dibaca di PDF ini. Jalankan OCR PDF dulu jika ini hasil pindaian.' : null };
  },
});
async function pageTable(page) {
  const { lines } = await pageLines(page);
  const cellsPerLine = lines.map((l) => {
    const cells = []; let cur = null;
    for (const it of l.items) {
      if (!it.str.trim()) continue;
      const gap = cur ? it.x - cur.x2 : Infinity;
      if (cur && gap < Math.max(3, it.size * 0.9)) { cur.t += (gap > it.size * 0.15 ? ' ' : '') + it.str; cur.x2 = it.x + it.w; }
      else { cur = { t: it.str, x: it.x, x2: it.x + it.w }; cells.push(cur); }
    }
    cells.forEach((c) => { c.t = c.t.replace(/\s+/g, ' ').trim(); });
    return cells;
  });
  /* blocks of consecutive multi-cell rows share columns taken from their widest row */
  const rows = cellsPerLine.map(() => null);
  let i = 0;
  while (i < cellsPerLine.length) {
    if (cellsPerLine[i].length < 2) { rows[i] = cellsPerLine[i].map((c) => c.t); i++; continue; }
    let j = i; while (j < cellsPerLine.length && cellsPerLine[j].length >= 2) j++;
    let widest = cellsPerLine[i];
    for (let k = i; k < j; k++) if (cellsPerLine[k].length > widest.length) widest = cellsPerLine[k];
    const centers = widest.map((c) => (c.x + c.x2) / 2);
    for (let k = i; k < j; k++) {
      const row = new Array(centers.length).fill('');
      for (const c of cellsPerLine[k]) {
        const cc = (c.x + c.x2) / 2; let best = 0;
        centers.forEach((v, q) => { if (Math.abs(v - cc) < Math.abs(centers[best] - cc)) best = q; });
        while (row[best] && best < row.length - 1) best++;
        row[best] = row[best] ? row[best] + ' ' + c.t : c.t;
      }
      rows[k] = row;
    }
    i = j;
  }
  return rows;
}
function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
async function buildXlsx(sheets, toNum) {
  const z = new JSZip();
  const names = sheets.map((s, i) => (s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  z.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  z.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  z.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  z.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`);
  sheets.forEach((s, si) => {
    const widths = [];
    let rowsXml = '';
    s.rows.forEach((r, ri) => {
      let cx = '';
      r.forEach((v, ci) => {
        if (v == null || v === '') return;
        widths[ci] = Math.max(widths[ci] || 6, Math.min(60, String(v).length + 2));
        const ref = colName(ci) + (ri + 1);
        const n = toNum ? parseNum(v) : null;
        cx += n != null ? `<c r="${ref}"><v>${n}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
      });
      rowsXml += `<row r="${ri + 1}">${cx}</row>`;
    });
    const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w || 8}" customWidth="1"/>`).join('')}</cols>` : '';
    z.file(`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rowsXml}</sheetData></worksheet>`);
  });
  return await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
function parseNum(v) {
  let s = String(v).trim().replace(/^Rp\.?\s*/i, '');
  if (!/^-?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  else if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  if (/^0\d/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const SRGB_ICC_B64 = 'AAACTGxjbXMEQAAAbW50clJHQiBYWVogB+oACgARAAgAGQAKYWNzcEFQUEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAAAUAAAABMd3RwdAAAAYwAAAAUY2hhZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggAAAAgZ1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMAAAAaAAAAHABzAFIARwBCACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwAIAB1AHMAZQAgAGYAcgBlAGUAbAB5WFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of///aIAAAPcAADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcAALeHAAAY2XBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAAVHsAAEzNAACZmgAAJmYAAA9c';
defineTool({
  id: 'pdfa', cat: 'from', name: 'PDF ke PDF/A', desc: 'Ubah PDF ke format arsip PDF/A-2b untuk penyimpanan jangka panjang.',
  actionLabel: 'Ubah ke PDF/A', keywords: 'pdfa arsip archive iso',
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Kepatuhan'),
      segmented('pa-mode', [['keep', 'Pertahankan teks', 'menambahkan profil warna, metadata XMP, dan ID'], ['raster', 'Ubah ke gambar', 'paling aman bila font tidak tertanam']], 'keep'),
      h('p', { class: 'hint' }, 'PDF/A mewajibkan semua font tertanam. Jika ada font yang tidak tertanam, kamu akan diberi tahu dan bisa memakai mode “Ubah ke gambar”.'));
  },
  async run(ctx) {
    const it = ctx.items[0];
    let doc;
    if (val('pa-mode') === 'raster') {
      const bytes = await rasterizePdf(it, { dpi: 150, q: 0.85, keepText: false, step: (f, t) => ctx.progress.set(f * 0.8, t) });
      doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    } else doc = await openPdfLib(it);
    ctx.progress.set(0.85, 'Menambahkan metadata PDF/A');
    const missing = unembeddedFonts(doc);
    makePdfA(doc, baseName(it.name));
    const bytes = await doc.save({ useObjectStreams: false, updateMetadata: false });
    const note = missing.length ? `Perhatian: ${missing.length} font tidak tertanam (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}). Pemeriksa PDF/A akan menolak file ini. Ulangi dengan mode “Ubah ke gambar” untuk hasil yang pasti patuh.` : 'Profil warna sRGB, metadata XMP PDF/A-2b, dan ID dokumen sudah ditambahkan. Semua font tertanam.';
    return { outputs: [{ name: baseName(it.name) + '_pdfa.pdf', bytes, info: 'PDF/A-2b' }], note };
  },
});
function unembeddedFonts(doc) {
  const { PDFName, PDFDict } = PDFLib;
  const out = new Set();
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict)) continue;
    if (o.get(PDFName.of('Type')) !== PDFName.of('Font')) continue;
    const sub = o.get(PDFName.of('Subtype'));
    if (sub === PDFName.of('Type0') || sub === PDFName.of('Type3')) continue;
    const fd = doc.context.lookup(o.get(PDFName.of('FontDescriptor')));
    const embedded = fd instanceof PDFDict && (fd.get(PDFName.of('FontFile')) || fd.get(PDFName.of('FontFile2')) || fd.get(PDFName.of('FontFile3')));
    if (!embedded) { const bf = o.get(PDFName.of('BaseFont')); out.add(bf ? bf.asString().slice(1) : 'tanpa nama'); }
  }
  return [...out];
}
function makePdfA(doc, title) {
  const { PDFName, PDFHexString, PDFString } = PDFLib;
  const ctx = doc.context;
  const icc = Uint8Array.from(atob(SRGB_ICC_B64), (c) => c.charCodeAt(0));
  const iccStream = ctx.flateStream(icc, { N: 3 });
  const iccRef = ctx.register(iccStream);
  const intent = ctx.obj({ Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'), Info: PDFString.of('sRGB IEC61966-2.1'), DestOutputProfile: iccRef });
  doc.catalog.set(PDFName.of('OutputIntents'), ctx.obj([ctx.register(intent)]));
  const now = new Date();
  const iso = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const t = doc.getTitle() || title;
  doc.setTitle(t); doc.setProducer('Atur PDF'); doc.setCreator(doc.getCreator() || 'Atur PDF'); doc.setModificationDate(now); if (!doc.getCreationDate()) doc.setCreationDate(now);
  const author = doc.getAuthor() || '';
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>
<dc:format>application/pdf</dc:format>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(t)}</rdf:li></rdf:Alt></dc:title>
${author ? `<dc:creator><rdf:Seq><rdf:li>${escapeXml(author)}</rdf:li></rdf:Seq></dc:creator>` : ''}
<xmp:CreateDate>${(doc.getCreationDate() || now).toISOString().replace(/\.\d+Z$/, 'Z')}</xmp:CreateDate><xmp:ModifyDate>${iso}</xmp:ModifyDate><xmp:MetadataDate>${iso}</xmp:MetadataDate><xmp:CreatorTool>${escapeXml(doc.getCreator() || 'Atur PDF')}</xmp:CreatorTool>
<pdf:Producer>Atur PDF</pdf:Producer>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  const meta = ctx.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(meta));
  const idHex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(idHex), PDFHexString.of(idHex)]);
}
