/* Readers for Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) into printable HTML */
'use strict';

async function zipToDataUrl(zip, path) {
  const f = zip.file(path);
  if (!f) return null;
  const ext = extOf(path);
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' }[ext];
  if (!mime || mime === 'image/tiff') return null;
  return `data:${mime};base64,` + (await f.async('base64'));
}
const twip = (v) => (v == null ? null : parseFloat(v) / 20); /* twentieths of a point -> pt */
function cssFamily(name) {
  const n = (name || '').toLowerCase();
  if (/courier|consolas|mono|lucida console/.test(n)) return MONO;
  if (/times|cambria|georgia|garamond|book antiqua|palatino|serif/.test(n) && !/sans/.test(n)) return SERIF;
  return SANS;
}

/* ===================== DOCX ===================== */
async function docxToHtml(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const docPath = 'word/document.xml';
  if (!zip.file(docPath)) throw new Error('File ini bukan dokumen Word (.docx) yang valid.');
  const doc = parseXml(await zip.file(docPath).async('string'));
  const rels = await readRels(zip, docPath);
  const styles = zip.file('word/styles.xml') ? parseXml(await zip.file('word/styles.xml').async('string')) : null;
  const numbering = zip.file('word/numbering.xml') ? parseXml(await zip.file('word/numbering.xml').async('string')) : null;

  /* ---- styles ---- */
  const styleMap = {};
  let defRPr = {}, defPPr = {};
  if (styles) {
    const dd = desc(styles, 'docDefaults')[0];
    if (dd) { defRPr = readRPr(desc(dd, 'rPr')[0]); defPPr = readPPr(desc(dd, 'pPr')[0]); }
    for (const s of desc(styles, 'style')) {
      styleMap[attr(s, 'w:styleId')] = { type: attr(s, 'w:type'), name: (attr(kid(s, 'name'), 'w:val') || '').toLowerCase(), basedOn: attr(kid(s, 'basedOn'), 'w:val'), rPr: readRPr(kid(s, 'rPr')), pPr: readPPr(kid(s, 'pPr')), tbl: kid(s, 'tblPr') };
    }
  }
  const resolved = {};
  function styleChain(id) {
    if (!id || !styleMap[id]) return { rPr: {}, pPr: {}, name: '' };
    if (resolved[id]) return resolved[id];
    const s = styleMap[id];
    const base = s.basedOn && s.basedOn !== id ? styleChain(s.basedOn) : { rPr: {}, pPr: {} };
    return (resolved[id] = { rPr: { ...base.rPr, ...s.rPr }, pPr: { ...base.pPr, ...s.pPr }, name: s.name });
  }
  const defaultPara = Object.keys(styleMap).find((k) => styleMap[k].type === 'paragraph' && (k === 'Normal' || styleMap[k].name === 'normal'));

  /* ---- numbering ---- */
  const abstracts = {}, nums = {};
  if (numbering) {
    for (const a of desc(numbering, 'abstractNum')) {
      const lv = {};
      for (const l of kids(a, 'lvl')) lv[attr(l, 'w:ilvl')] = { fmt: attr(kid(l, 'numFmt'), 'w:val') || 'decimal', text: attr(kid(l, 'lvlText'), 'w:val') || '%1.', start: +(attr(kid(l, 'start'), 'w:val') || 1), ind: twip(attr(desc(l, 'ind')[0], 'w:left')) };
      abstracts[attr(a, 'w:abstractNumId')] = lv;
    }
    for (const n of desc(numbering, 'num')) nums[attr(n, 'w:numId')] = attr(kid(n, 'abstractNumId'), 'w:val');
  }
  const counters = {};
  function marker(numId, ilvl) {
    const abs = abstracts[nums[numId]]; if (!abs) return { text: '•', ind: 18 * (ilvl + 1) };
    const lv = abs[ilvl] || abs['0'];
    const key = numId;
    counters[key] = counters[key] || {};
    const c = counters[key];
    c[ilvl] = (c[ilvl] == null ? lv.start - 1 : c[ilvl]) + 1;
    for (const k of Object.keys(c)) if (+k > ilvl) delete c[k];
    if (lv.fmt === 'bullet' || lv.fmt === 'none') return { text: lv.fmt === 'none' ? '' : ['•', '◦', '▪'][ilvl % 3], ind: lv.ind || 18 * (ilvl + 1) };
    const txt = lv.text.replace(/%(\d)/g, (_, d) => { const L = +d - 1; const v = c[L] != null ? c[L] : (abs[L] ? abs[L].start : 1); return fmtNum(v, (abs[L] || lv).fmt); });
    return { text: txt, ind: lv.ind || 18 * (ilvl + 1) };
  }
  function fmtNum(n, f) {
    if (/lowerLetter/.test(f)) return String.fromCharCode(96 + ((n - 1) % 26) + 1);
    if (/upperLetter/.test(f)) return String.fromCharCode(64 + ((n - 1) % 26) + 1);
    if (/lowerRoman/.test(f)) return toRoman(n, true);
    if (/upperRoman/.test(f)) return toRoman(n, false);
    return String(n);
  }

  /* ---- page setup from the last section ---- */
  const sect = desc(doc, 'sectPr').pop();
  const pgSz = kid(sect, 'pgSz'), pgMar = kid(sect, 'pgMar');
  const page = {
    w: twip(attr(pgSz, 'w:w')) || 595.28, h: twip(attr(pgSz, 'w:h')) || 841.89,
    mt: twip(attr(pgMar, 'w:top')) ?? 72, mb: twip(attr(pgMar, 'w:bottom')) ?? 72, ml: twip(attr(pgMar, 'w:left')) ?? 72, mr: twip(attr(pgMar, 'w:right')) ?? 72,
  };

  /* ---- body ---- */
  const body = desc(doc, 'body')[0];
  const out = [];
  const imgCache = {};
  async function image(rid, cx, cy) {
    const r = rels[rid]; if (!r || r.external) return '';
    if (!(r.target in imgCache)) imgCache[r.target] = await zipToDataUrl(zip, r.target);
    const src = imgCache[r.target];
    const w = cx ? cx / 9525 : null, hh = cy ? cy / 9525 : null;
    if (!src) return `<span style="display:inline-block;width:${w || 120}px;height:${hh || 60}px;border:1px dashed #999"></span>`;
    return `<img src="${src}" style="${w ? `width:${w}px;` : 'max-width:100%;'}${hh ? `height:${hh}px;` : ''}vertical-align:bottom">`;
  }
  async function runs(container, pr) {
    let html = '';
    for (const n of Array.from(container.children)) {
      const ln = n.localName;
      if (ln === 'r') html += await run(n, pr);
      else if (ln === 'hyperlink' || ln === 'smartTag' || ln === 'ins' || ln === 'fldSimple' || ln === 'customXml') {
        const inner = await runs(n, pr);
        const rid = attr(n, 'r:id');
        html += rid && rels[rid] && rels[rid].external ? `<span style="color:#1155cc;text-decoration:underline">${inner}</span>` : inner;
      } else if (ln === 'sdt') { const c = kid(n, 'sdtContent'); if (c) html += await runs(c, pr); }
    }
    return html;
  }
  async function run(r, pr) {
    const rs = readRPr(kid(r, 'rPr'));
    const sty = rs.style ? styleChain(rs.style).rPr : {};
    const p = { ...pr, ...sty, ...rs };
    if (p.vanish) return '';
    let txt = '';
    for (const c of Array.from(r.children)) {
      const ln = c.localName;
      if (ln === 't') txt += escapeHtml(c.textContent);
      else if (ln === 'tab') txt += '<span style="display:inline-block;width:36pt"></span>';
      else if (ln === 'br') txt += attr(c, 'w:type') === 'page' ? '</span><div class="pb"></div><span>' : '<br>';
      else if (ln === 'noBreakHyphen') txt += '-';
      else if (ln === 'drawing' || ln === 'pict') {
        const blip = desc(c, 'blip')[0] || desc(c, 'imagedata')[0];
        const ext = desc(c, 'extent')[0];
        const rid = blip ? (attr(blip, 'r:embed') || attr(blip, 'r:id')) : null;
        if (rid) txt += await image(rid, ext ? +attr(ext, 'cx') : 0, ext ? +attr(ext, 'cy') : 0);
      }
    }
    if (!txt) return '';
    return `<span style="${rStyle(p)}">${txt}</span>`;
  }
  function rStyle(p) {
    const s = [];
    if (p.font) s.push(`font-family:${cssFamily(p.font)}`);
    if (p.sz) s.push(`font-size:${p.sz}pt`);
    if (p.b) s.push('font-weight:bold');
    if (p.i) s.push('font-style:italic');
    const dec = [p.u ? 'underline' : '', p.strike ? 'line-through' : ''].filter(Boolean).join(' ');
    if (dec) s.push(`text-decoration:${dec}`);
    if (p.color && p.color !== 'auto') s.push(`color:#${p.color}`);
    if (p.hl) s.push(`background:${p.hl}`);
    if (p.caps) s.push('text-transform:uppercase');
    if (p.va === 'superscript') s.push('vertical-align:super;font-size:70%');
    if (p.va === 'subscript') s.push('vertical-align:sub;font-size:70%');
    return s.join(';');
  }
  async function para(p, inTable) {
    const own = readPPr(kid(p, 'pPr'));
    const sid = own.style || defaultPara;
    const st = styleChain(sid);
    const pp = { ...defPPr, ...st.pPr, ...own };
    const baseR = { ...defRPr, ...st.rPr, ...readRPr(desc(kid(p, 'pPr'), 'rPr')[0]) };
    delete baseR.vanish;
    const inner = await runs(p, baseR);
    let pre = '';
    let ind = pp.indL || 0;
    if (pp.numId && pp.numId !== '0') {
      const mk = marker(pp.numId, +(pp.ilvl || 0));
      ind = pp.indL || mk.ind;
      pre = `<span style="display:inline-block;min-width:18pt;margin-left:-18pt;${rStyle(baseR)}">${escapeHtml(mk.text)}</span>`;
    }
    const css = [];
    css.push(`margin:${inTable ? 0 : (pp.before ?? 0)}pt ${pp.indR || 0}pt ${inTable ? 2 : (pp.after ?? 8)}pt ${ind}pt`);
    if (pp.firstLine) css.push(`text-indent:${pp.firstLine}pt`);
    if (pp.hanging && !pre) css.push(`text-indent:-${pp.hanging}pt`);
    if (pp.jc) css.push(`text-align:${{ both: 'justify', distribute: 'justify', center: 'center', right: 'right', end: 'right', left: 'left', start: 'left' }[pp.jc] || 'left'}`);
    if (pp.line) css.push(`line-height:${pp.line}`);
    if (baseR.sz) css.push(`font-size:${baseR.sz}pt`);
    if (baseR.font) css.push(`font-family:${cssFamily(baseR.font)}`);
    if (pp.shd) css.push(`background:#${pp.shd}`);
    const h = /^heading (\d)$/.exec(st.name || '') || /^title$/.test(st.name || '');
    const tag = h && Array.isArray(h) ? `h${Math.min(6, +h[1])}` : 'p';
    const brk = pp.pageBreakBefore ? '<div class="pb"></div>' : '';
    return `${brk}<${tag} style="${css.join(';')}">${pre}${inner || '&nbsp;'}</${tag}>`;
  }
  async function table(t) {
    const rows = kids(t, 'tr');
    const grid = kids(kid(t, 'tblGrid'), 'gridCol').map((g) => twip(attr(g, 'w:w')) || 0);
    const borders = !!desc(kid(t, 'tblPr'), 'tblBorders').length || true;
    const spans = {};
    const cellsByRow = [];
    for (let ri = 0; ri < rows.length; ri++) {
      let col = 0; const cells = [];
      for (const tc of kids(rows[ri], 'tc')) {
        const pr = kid(tc, 'tcPr');
        const span = +(attr(kid(pr, 'gridSpan'), 'w:val') || 1);
        const vm = kid(pr, 'vMerge');
        const vmv = vm ? (attr(vm, 'w:val') || 'continue') : null;
        if (vmv === 'continue' && spans[col]) { spans[col].rowspan++; col += span; continue; }
        const shd = attr(kid(pr, 'shd'), 'w:fill');
        const w = grid.slice(col, col + span).reduce((a, b) => a + b, 0);
        const cell = { tc, span, rowspan: 1, shd: shd && shd !== 'auto' ? shd : null, w };
        if (vmv === 'restart') spans[col] = cell; else delete spans[col];
        cells.push(cell); col += span;
      }
      cellsByRow.push(cells);
    }
    let html = `<table style="border-collapse:collapse;margin:4pt 0 10pt;${grid.length ? `width:${Math.min(grid.reduce((a, b) => a + b, 0), page.w - page.ml - page.mr)}pt` : 'width:100%'}">`;
    for (const cells of cellsByRow) {
      html += '<tr>';
      for (const c of cells) {
        let inner = '';
        for (const n of Array.from(c.tc.children)) {
          if (n.localName === 'p') inner += await para(n, true);
          else if (n.localName === 'tbl') inner += await table(n);
        }
        html += `<td${c.span > 1 ? ` colspan="${c.span}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''} style="${borders ? 'border:0.75pt solid #444;' : ''}padding:3pt 5pt;vertical-align:top;${c.w ? `width:${c.w}pt;` : ''}${c.shd ? `background:#${c.shd};` : ''}">${inner}</td>`;
      }
      html += '</tr>';
    }
    return html + '</table>';
  }
  async function block(n) {
    if (n.localName === 'p') return para(n);
    if (n.localName === 'tbl') return table(n);
    if (n.localName === 'sdt') { const c = kid(n, 'sdtContent'); let s = ''; if (c) for (const k of Array.from(c.children)) s += await block(k); return s; }
    return '';
  }
  for (const n of Array.from(body.children)) out.push(await block(n));

  const baseSize = defRPr.sz || 11;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:${cssFamily(defRPr.font)};font-size:${baseSize}pt;line-height:1.25;color:#000;background:#fff;overflow-wrap:break-word}
    h1,h2,h3,h4,h5,h6{font-weight:bold} p{orphans:1}
    h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13pt}
    img{max-width:100%} table{max-width:100%} td p{margin:0}
    .pb{height:0}
  </style></head><body>${out.join('\n')}</body></html>`;
  return { html, page };

  function readRPr(r) {
    if (!r) return {};
    const o = {};
    const on = (k) => { const e = kid(r, k); if (!e) return undefined; const v = attr(e, 'w:val'); return !(v === '0' || v === 'false' || v === 'none'); };
    const b = on('b'); if (b !== undefined) o.b = b;
    const i = on('i'); if (i !== undefined) o.i = i;
    const u = kid(r, 'u'); if (u) o.u = attr(u, 'w:val') !== 'none';
    const st = on('strike'); if (st !== undefined) o.strike = st;
    const cp = on('caps'); if (cp !== undefined) o.caps = cp;
    const v = on('vanish'); if (v !== undefined) o.vanish = v;
    const sz = attr(kid(r, 'sz'), 'w:val'); if (sz) o.sz = +sz / 2;
    const col = attr(kid(r, 'color'), 'w:val'); if (col) o.color = col;
    const fonts = kid(r, 'rFonts'); if (fonts) { const f = attr(fonts, 'w:ascii') || attr(fonts, 'w:hAnsi'); if (f) o.font = f; }
    const hl = attr(kid(r, 'highlight'), 'w:val'); if (hl && hl !== 'none') o.hl = hl;
    const shd = attr(kid(r, 'shd'), 'w:fill'); if (shd && shd !== 'auto') o.hl = '#' + shd;
    const va = attr(kid(r, 'vertAlign'), 'w:val'); if (va) o.va = va;
    const rs = attr(kid(r, 'rStyle'), 'w:val'); if (rs) o.style = rs;
    return o;
  }
  function readPPr(p) {
    if (!p) return {};
    const o = {};
    const ps = attr(kid(p, 'pStyle'), 'w:val'); if (ps) o.style = ps;
    const jc = attr(kid(p, 'jc'), 'w:val'); if (jc) o.jc = jc;
    const sp = kid(p, 'spacing');
    if (sp) {
      if (attr(sp, 'w:before') != null) o.before = twip(attr(sp, 'w:before'));
      if (attr(sp, 'w:after') != null) o.after = twip(attr(sp, 'w:after'));
      const line = attr(sp, 'w:line'), rule = attr(sp, 'w:lineRule');
      if (line && (!rule || rule === 'auto')) o.line = Math.max(1, (+line / 240) * 1.15).toFixed(2);
    }
    const ind = kid(p, 'ind');
    if (ind) {
      const l = attr(ind, 'w:left') ?? attr(ind, 'w:start'); if (l != null) o.indL = twip(l);
      const r = attr(ind, 'w:right') ?? attr(ind, 'w:end'); if (r != null) o.indR = twip(r);
      if (attr(ind, 'w:firstLine') != null) o.firstLine = twip(attr(ind, 'w:firstLine'));
      if (attr(ind, 'w:hanging') != null) o.hanging = twip(attr(ind, 'w:hanging'));
    }
    const np = kid(p, 'numPr');
    if (np) { o.numId = attr(kid(np, 'numId'), 'w:val'); o.ilvl = attr(kid(np, 'ilvl'), 'w:val') || '0'; }
    if (kid(p, 'pageBreakBefore') && attr(kid(p, 'pageBreakBefore'), 'w:val') !== '0') o.pageBreakBefore = true;
    const shd = attr(kid(p, 'shd'), 'w:fill'); if (shd && shd !== 'auto') o.shd = shd;
    return o;
  }
}

/* ===================== XLSX ===================== */
async function xlsxSheets(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  if (!zip.file('xl/workbook.xml')) throw new Error('File ini bukan buku kerja Excel (.xlsx) yang valid.');
  const wb = parseXml(await zip.file('xl/workbook.xml').async('string'));
  const rels = await readRels(zip, 'xl/workbook.xml');
  const date1904 = attr(desc(wb, 'workbookPr')[0], 'date1904') === '1';
  const ss = [];
  if (zip.file('xl/sharedStrings.xml')) {
    const x = parseXml(await zip.file('xl/sharedStrings.xml').async('string'));
    for (const si of kids(x.documentElement, 'si')) ss.push(desc(si, 't').filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join(''));
  }
  const fmts = {}, xfs = [], fonts = [], fills = [];
  if (zip.file('xl/styles.xml')) {
    const st = parseXml(await zip.file('xl/styles.xml').async('string'));
    for (const n of desc(st, 'numFmt')) fmts[attr(n, 'numFmtId')] = attr(n, 'formatCode');
    for (const f of kids(desc(st, 'fonts')[0], 'font')) fonts.push({ b: !!kid(f, 'b'), i: !!kid(f, 'i'), color: (attr(kid(f, 'color'), 'rgb') || '').slice(-6), sz: +(attr(kid(f, 'sz'), 'val') || 11) });
    for (const f of kids(desc(st, 'fills')[0], 'fill')) { const fg = desc(f, 'fgColor')[0]; fills.push(attr(desc(f, 'patternFill')[0], 'patternType') === 'solid' && fg ? (attr(fg, 'rgb') || '').slice(-6) : null); }
    for (const x of kids(desc(st, 'cellXfs')[0], 'xf')) {
      const al = kid(x, 'alignment');
      xfs.push({ num: attr(x, 'numFmtId'), font: +attr(x, 'fontId') || 0, fill: +attr(x, 'fillId') || 0, h: attr(al, 'horizontal'), wrap: attr(al, 'wrapText') === '1' });
    }
  }
  const sheets = [];
  for (const s of desc(wb, 'sheet')) {
    if (attr(s, 'state') === 'hidden' || attr(s, 'state') === 'veryHidden') continue;
    const r = rels[attr(s, 'r:id') || attr(s, 'id')]; if (!r || !zip.file(r.target)) continue;
    const x = parseXml(await zip.file(r.target).async('string'));
    const cols = {};
    for (const c of desc(x, 'col')) { const w = +attr(c, 'width'); for (let i = +attr(c, 'min'); i <= +attr(c, 'max') && i < 300; i++) cols[i - 1] = { w: Math.round(w * 7 + 5), hidden: attr(c, 'hidden') === '1' }; }
    const cells = {}; let maxR = -1, maxC = -1;
    for (const row of desc(x, 'row')) {
      if (attr(row, 'hidden') === '1') continue;
      for (const c of kids(row, 'c')) {
        const ref = attr(c, 'r'); const [ci, ri] = cellRef(ref);
        const t = attr(c, 't'); const v = kid(c, 'v'); const xf = xfs[+attr(c, 's') || 0] || {};
        let val = null;
        if (t === 's') val = ss[+v.textContent];
        else if (t === 'inlineStr') val = desc(c, 't').map((e) => e.textContent).join('');
        else if (t === 'b') val = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'str' || t === 'e') val = v ? v.textContent : '';
        else if (v) val = formatNumber(+v.textContent, xf.num, fmts, date1904);
        if (val == null || val === '') { if (!xf.fill || !fills[xf.fill]) continue; val = ''; }
        const f = fonts[xf.font] || {};
        cells[ri + ':' + ci] = { v: val, num: !t && v, b: f.b, i: f.i, color: f.color && f.color !== '000000' ? f.color : null, fill: fills[xf.fill] || null, h: xf.h, wrap: xf.wrap, sz: f.sz };
        if (val !== '') { if (ri > maxR) maxR = ri; if (ci > maxC) maxC = ci; }
      }
    }
    const merges = desc(x, 'mergeCell').map((m) => { const [a, b] = attr(m, 'ref').split(':'); const [c1, r1] = cellRef(a), [c2, r2] = cellRef(b || a); return { r1, c1, r2, c2 }; });
    sheets.push({ name: attr(s, 'name'), cells, maxR, maxC, cols, merges });
  }
  return sheets;
  function cellRef(ref) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref || 'A1'); let c = 0;
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    return [c - 1, +m[2] - 1];
  }
}
function formatNumber(n, id, fmts, d1904) {
  const code = fmts[id] || '';
  const iid = +id;
  const isDate = (iid >= 14 && iid <= 22) || (iid >= 45 && iid <= 47) || (/[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,%\s]+$/.test(code));
  if (isDate && n > 0 && n < 2958466) {
    const ms = Math.round((n - (d1904 ? -1462 : 0) - 25569) * 86400000);
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    const hasTime = /h|s/i.test(code) || (iid >= 18 && iid <= 22) || (n % 1 !== 0 && iid !== 14);
    const date = `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
    const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    if (iid >= 18 && iid <= 21 || (/^\[?h/i.test(code) && !/[dy]/i.test(code))) return time;
    return hasTime ? `${date} ${time}` : date;
  }
  if (iid === 9 || iid === 10 || /%$/.test(code)) { const dec = iid === 10 ? 2 : ((/0\.(0+)%/.exec(code) || [])[1] || '').length; return (n * 100).toLocaleString('id-ID', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + '%'; }
  const dm = /0\.(0+)/.exec(code);
  const dec = dm ? dm[1].length : iid === 2 || iid === 4 ? 2 : null;
  const grouping = /#,##|,/.test(code) || iid === 3 || iid === 4;
  if (dec != null || grouping) return n.toLocaleString('id-ID', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0, useGrouping: grouping });
  if (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-6 && n !== 0)) return n.toExponential(4);
  return String(Math.round(n * 1e10) / 1e10).replace('.', ',');
}
function sheetToHtml(sh, { gridlines = true, scale = 1 } = {}) {
  if (sh.maxR < 0) return `<h2 class="sheet-name">${escapeHtml(sh.name)}</h2><p style="color:#666">Lembar kosong</p>`;
  const covered = new Set(); const spanAt = {};
  for (const m of sh.merges) { spanAt[m.r1 + ':' + m.c1] = m; for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(r + ':' + c); }
  let html = `<h2 class="sheet-name">${escapeHtml(sh.name)}</h2><table class="xl" style="font-size:${10 * scale}pt"><colgroup>`;
  for (let c = 0; c <= sh.maxC; c++) { const col = sh.cols[c]; html += col && col.hidden ? '<col style="width:0;visibility:collapse">' : `<col style="width:${((col ? col.w : 64) * scale)}px">`; }
  html += '</colgroup>';
  for (let r = 0; r <= sh.maxR; r++) {
    html += '<tr>';
    for (let c = 0; c <= sh.maxC; c++) {
      const key = r + ':' + c; if (covered.has(key)) continue;
      const cell = sh.cells[key]; const m = spanAt[key];
      const st = [];
      if (cell) {
        if (cell.b) st.push('font-weight:bold'); if (cell.i) st.push('font-style:italic');
        if (cell.color) st.push(`color:#${cell.color}`); if (cell.fill) st.push(`background:#${cell.fill}`);
        st.push(`text-align:${cell.h && cell.h !== 'general' ? (cell.h === 'centerContinuous' ? 'center' : cell.h) : cell.num ? 'right' : 'left'}`);
        if (cell.wrap) st.push('white-space:normal');
        if (cell.sz && cell.sz !== 11) st.push(`font-size:${(cell.sz * 10 / 11) * scale}pt`);
      }
      html += `<td${m ? ` colspan="${m.c2 - m.c1 + 1}" rowspan="${m.r2 - m.r1 + 1}"` : ''} style="${st.join(';')}">${cell ? escapeHtml(cell.v) : ''}</td>`;
    }
    html += '</tr>';
  }
  return html + '</table>';
}
function xlsxHtmlDoc(inner, gridlines) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:${SANS};color:#000;background:#fff}
  .sheet-name{font-size:11pt;margin:0 0 6pt;color:#333}
  table.xl{border-collapse:collapse;table-layout:fixed;margin-bottom:16pt}
  table.xl td{${gridlines ? 'border:0.5pt solid #b7b7b7;' : ''}padding:1pt 3pt;white-space:nowrap;overflow:hidden;vertical-align:bottom;line-height:1.25}
  .pb{height:0}
  </style></head><body>${inner}</body></html>`;
}

/* ===================== PPTX ===================== */
async function pptxToHtml(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const presPath = 'ppt/presentation.xml';
  if (!zip.file(presPath)) throw new Error('File ini bukan presentasi PowerPoint (.pptx) yang valid.');
  const pres = parseXml(await zip.file(presPath).async('string'));
  const prels = await readRels(zip, presPath);
  const sz = desc(pres, 'sldSz')[0];
  const cx = +attr(sz, 'cx') || 12192000, cy = +attr(sz, 'cy') || 6858000;
  const W = 960, scale = W / cx, H = Math.round(cy * scale);
  const ptPx = W / (cx / 12700);
  const xmlCache = {};
  const getXml = async (p) => (xmlCache[p] ||= zip.file(p) ? parseXml(await zip.file(p).async('string')) : null);
  const imgCache = {};
  const img = async (p) => (p in imgCache ? imgCache[p] : (imgCache[p] = await zipToDataUrl(zip, p)));

  const slides = [];
  for (const sid of desc(desc(pres, 'sldIdLst')[0], 'sldId')) {
    const r = prels[attr(sid, 'r:id') || attr(sid, 'id')]; if (r) slides.push(r.target);
  }
  let out = '';
  for (let si = 0; si < slides.length; si++) {
    const sp = slides[si];
    const sx = await getXml(sp); if (!sx) continue;
    if (attr(sx.documentElement, 'show') === '0') continue;
    const srels = await readRels(zip, sp);
    const layoutPath = Object.values(srels).find((x) => /slideLayout$/.test(x.type))?.target;
    const lx = layoutPath ? await getXml(layoutPath) : null;
    const lrels = layoutPath ? await readRels(zip, layoutPath) : {};
    const masterPath = Object.values(lrels).find((x) => /slideMaster$/.test(x.type))?.target;
    const mx = masterPath ? await getXml(masterPath) : null;
    const mrels = masterPath ? await readRels(zip, masterPath) : {};
    const themePath = Object.values(mrels).find((x) => /theme$/.test(x.type))?.target;
    const tx = themePath ? await getXml(themePath) : null;
    const scheme = {};
    if (tx) for (const c of Array.from((desc(tx, 'clrScheme')[0] || { children: [] }).children)) { const v = desc(c, 'srgbClr')[0] || desc(c, 'sysClr')[0]; if (v) scheme[c.localName] = attr(v, 'val') === 'windowText' ? '000000' : attr(v, 'val') === 'window' ? 'FFFFFF' : (attr(v, 'lastClr') || attr(v, 'val')); }
    const map = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
    const color = (el) => {
      if (!el) return null;
      const s = kid(el, 'srgbClr') || kid(el, 'schemeClr') || kid(el, 'sysClr') || kid(el, 'prstClr');
      if (!s) return null;
      let hex = s.localName === 'srgbClr' ? attr(s, 'val') : s.localName === 'schemeClr' ? scheme[map[attr(s, 'val')] || attr(s, 'val')] : s.localName === 'sysClr' ? (attr(s, 'lastClr') || '000000') : ({ black: '000000', white: 'FFFFFF', red: 'FF0000' }[attr(s, 'val')] || '000000');
      if (!hex) return null;
      const lm = kid(s, 'lumMod'), lo = kid(s, 'lumOff'), al = kid(s, 'alpha');
      let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.substr(i, 2), 16));
      if (lm || lo) { const m = lm ? +attr(lm, 'val') / 100000 : 1, o = lo ? +attr(lo, 'val') / 100000 : 0; [r, g, b] = [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v * m + 255 * o)))); }
      const a = al ? +attr(al, 'val') / 100000 : 1;
      return `rgba(${r},${g},${b},${a})`;
    };
    /* background */
    let bg = '#ffffff', bgImg = '';
    for (const [x, rels] of [[sx, srels], [lx, lrels], [mx, mrels]]) {
      if (!x) continue;
      const bgPr = desc(x, 'bgPr')[0];
      const bgRef = desc(x, 'bgRef')[0];
      if (bgPr) {
        const sf = kid(bgPr, 'solidFill'); const gf = kid(bgPr, 'gradFill'); const bf = kid(bgPr, 'blipFill');
        if (sf) { bg = color(sf) || bg; break; }
        if (gf) { const stops = desc(gf, 'gs').map((g) => color(g)).filter(Boolean); if (stops.length) { bg = stops[0]; } break; }
        if (bf) { const blip = desc(bf, 'blip')[0]; const rr = rels[attr(blip, 'r:embed')]; if (rr) bgImg = await img(rr.target) || ''; break; }
      } else if (bgRef) { bg = color(bgRef) || bg; break; }
    }
    /* placeholder geometry lookup */
    const phOf = (sp) => { const ph = desc(kid(sp, 'nvSpPr') || kid(sp, 'nvPicPr') || sp, 'ph')[0]; return ph ? { type: attr(ph, 'type') || 'body', idx: attr(ph, 'idx') } : null; };
    const findPh = (x, ph) => {
      if (!x || !ph) return null;
      const all = desc(x, 'sp');
      return all.find((s) => { const p = phOf(s); return p && ph.idx != null && p.idx === ph.idx; })
        || all.find((s) => { const p = phOf(s); return p && p.type === ph.type; })
        || all.find((s) => { const p = phOf(s); return p && ((ph.type === 'ctrTitle' && p.type === 'title') || (ph.type === 'subTitle' && p.type === 'body')); });
    };
    const xfrmOf = (s) => { const x = desc(kid(s, 'spPr') || kid(s, 'grpSpPr') || s, 'xfrm')[0] || (s.localName === 'graphicFrame' ? kid(s, 'xfrm') : null); if (!x) return null; const o = kid(x, 'off'), e = kid(x, 'ext'); if (!o || !e) return null; return { x: +attr(o, 'x'), y: +attr(o, 'y'), w: +attr(e, 'cx'), h: +attr(e, 'cy'), rot: +(attr(x, 'rot') || 0) / 60000, flipH: attr(x, 'flipH') === '1' }; };

    const masterTitleSz = (() => { const t = desc(desc(mx || pres, 'titleStyle')[0], 'defRPr')[0]; return t && attr(t, 'sz') ? +attr(t, 'sz') / 100 : 40; })();
    const masterBodySz = (() => { const t = desc(desc(mx || pres, 'bodyStyle')[0], 'lvl1pPr')[0]; const d = t ? desc(t, 'defRPr')[0] : null; return d && attr(d, 'sz') ? +attr(d, 'sz') / 100 : 24; })();

    let shapesHtml = '';
    async function renderTree(tree, rels, ownerX, isMaster, gT) {
      for (const n of Array.from(tree.children)) {
        const ln = n.localName;
        if (ln === 'grpSp') {
          const gx = desc(kid(n, 'grpSpPr'), 'xfrm')[0];
          let t = gT;
          if (gx) {
            const o = kid(gx, 'off'), e = kid(gx, 'ext'), co = kid(gx, 'chOff'), ce = kid(gx, 'chExt');
            if (o && e && co && ce) {
              const sxF = (+attr(ce, 'cx') ? +attr(e, 'cx') / +attr(ce, 'cx') : 1), syF = (+attr(ce, 'cy') ? +attr(e, 'cy') / +attr(ce, 'cy') : 1);
              const inner = { ox: +attr(o, 'x') - +attr(co, 'x') * sxF, oy: +attr(o, 'y') - +attr(co, 'y') * syF, sx: sxF, sy: syF };
              t = gT ? { ox: gT.ox + inner.ox * gT.sx, oy: gT.oy + inner.oy * gT.sy, sx: inner.sx * gT.sx, sy: inner.sy * gT.sy } : inner;
            }
          }
          await renderTree(n, rels, ownerX, isMaster, t);
          continue;
        }
        if (!['sp', 'pic', 'graphicFrame', 'cxnSp'].includes(ln)) continue;
        const ph = phOf(n);
        if (isMaster && ph) continue;
        let xf = xfrmOf(n);
        let inheritSp = null;
        if (ph && !isMaster) { inheritSp = findPh(lx, ph) || findPh(mx, ph); if (!xf && inheritSp) xf = xfrmOf(inheritSp) || (findPh(mx, ph) ? xfrmOf(findPh(mx, ph)) : null); }
        if (!xf) continue;
        if (gT) xf = { ...xf, x: gT.ox + xf.x * gT.sx, y: gT.oy + xf.y * gT.sy, w: xf.w * gT.sx, h: xf.h * gT.sy };
        const box = `left:${xf.x * scale}px;top:${xf.y * scale}px;width:${xf.w * scale}px;height:${xf.h * scale}px;${xf.rot ? `transform:rotate(${xf.rot}deg);` : ''}`;
        if (ln === 'pic') {
          const blip = desc(n, 'blip')[0]; const rr = blip ? rels[attr(blip, 'r:embed')] : null;
          const src = rr ? await img(rr.target) : null;
          shapesHtml += src ? `<img class="s" style="${box}object-fit:fill" src="${src}">` : `<div class="s" style="${box}border:1px dashed #aaa"></div>`;
          continue;
        }
        if (ln === 'graphicFrame') {
          const tbl = desc(n, 'tbl')[0];
          if (tbl) {
            let th = `<table style="border-collapse:collapse;width:100%;font-size:${14 * ptPx}px">`;
            for (const tr of kids(tbl, 'tr')) {
              th += '<tr>';
              for (const tc of kids(tr, 'tc')) {
                if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') continue;
                const span = attr(tc, 'gridSpan'); const fill = color(kid(kid(tc, 'tcPr'), 'solidFill'));
                th += `<td${span ? ` colspan="${span}"` : ''} style="border:1px solid #888;padding:${4 * ptPx}px;${fill ? `background:${fill}` : ''}">${await textBody(kid(tc, 'txBody'), 'cell', null, 14)}</td>`;
              }
              th += '</tr>';
            }
            shapesHtml += `<div class="s" style="${box}height:auto">${th}</table></div>`;
          } else shapesHtml += `<div class="s" style="${box}border:1px dashed #aaa;display:flex;align-items:center;justify-content:center;color:#888;font-size:${12 * ptPx}px">grafik</div>`;
          continue;
        }
        const spPr = kid(n, 'spPr');
        const geom = attr(desc(spPr, 'prstGeom')[0], 'prst') || 'rect';
        let fill = null, line = null;
        if (spPr) {
          if (kid(spPr, 'solidFill')) fill = color(kid(spPr, 'solidFill'));
          else if (kid(spPr, 'gradFill')) fill = desc(kid(spPr, 'gradFill'), 'gs').map((g) => color(g)).filter(Boolean)[0] || null;
          else if (!kid(spPr, 'noFill')) { const sr = desc(kid(n, 'style'), 'fillRef')[0]; if (sr && attr(sr, 'idx') !== '0') fill = color(sr); }
          const lnEl = kid(spPr, 'ln');
          if (lnEl && !kid(lnEl, 'noFill')) { const lc = color(kid(lnEl, 'solidFill')); if (lc) line = { c: lc, w: Math.max(1, (+attr(lnEl, 'w') || 12700) * scale) }; }
          else if (!lnEl) { const lr = desc(kid(n, 'style'), 'lnRef')[0]; if (lr && attr(lr, 'idx') !== '0') line = { c: color(lr) || '#333', w: 1 }; }
        }
        if (ln === 'cxnSp' || geom === 'line' || geom.startsWith('straightConnector')) {
          if (line || true) { const c = line ? line.c : '#333', w = line ? line.w : 1; const horiz = xf.h * scale < 3; shapesHtml += `<div class="s" style="left:${xf.x * scale}px;top:${xf.y * scale}px;width:${Math.max(w, xf.w * scale)}px;height:${Math.max(w, xf.h * scale)}px;${horiz ? `border-top:${w}px solid ${c}` : xf.w * scale < 3 ? `border-left:${w}px solid ${c}` : `border-top:${w}px solid ${c}`}"></div>`; }
          continue;
        }
        const radius = geom === 'ellipse' ? 'border-radius:50%;' : geom === 'roundRect' ? `border-radius:${Math.min(xf.w, xf.h) * scale * 0.16}px;` : '';
        const tb = kid(n, 'txBody');
        const bodyPr = tb ? kid(tb, 'bodyPr') : null;
        const inhBodyPr = inheritSp ? desc(inheritSp, 'bodyPr')[0] : null;
        const anchor = attr(bodyPr, 'anchor') || attr(inhBodyPr, 'anchor') || (ph && /title/i.test(ph.type) ? 'ctr' : 't');
        const ins = (k, d) => (+(attr(bodyPr, k) ?? attr(inhBodyPr, k) ?? d)) * scale;
        const pad = `padding:${ins('tIns', 45720)}px ${ins('rIns', 91440)}px ${ins('bIns', 45720)}px ${ins('lIns', 91440)}px;`;
        const just = { t: 'flex-start', ctr: 'center', b: 'flex-end' }[anchor] || 'flex-start';
        const isTitle = ph && /title/i.test(ph.type);
        const defSz = isTitle ? masterTitleSz : ph && (ph.type === 'body' || ph.type === 'subTitle' || ph.type === 'obj') ? (ph.type === 'subTitle' ? Math.min(masterBodySz, 24) : masterBodySz) : 18;
        const autofit = desc(bodyPr, 'normAutofit')[0];
        const fscale = autofit && attr(autofit, 'fontScale') ? +attr(autofit, 'fontScale') / 100000 : 1;
        const inner = tb ? await textBody(tb, ph ? ph.type : 'shape', inheritSp, defSz, fscale) : '';
        shapesHtml += `<div class="s" style="${box}${radius}${fill ? `background:${fill};` : ''}${line ? `border:${line.w}px solid ${line.c};` : ''}${pad}display:flex;flex-direction:column;justify-content:${just};overflow:visible">${inner}</div>`;
      }
    }
    async function textBody(tb, phType, inheritSp, defSz, fscale = 1) {
      if (!tb) return '';
      let html = '';
      const lst = kid(tb, 'lstStyle');
      const inhLst = inheritSp ? desc(inheritSp, 'lstStyle')[0] : null;
      for (const p of kids(tb, 'p')) {
        const pPr = kid(p, 'pPr');
        const lvl = +(attr(pPr, 'lvl') || 0);
        const lvlKey = `lvl${lvl + 1}pPr`;
        const inhLvl = (inhLst && desc(inhLst, lvlKey)[0]) || (lst && desc(lst, lvlKey)[0]);
        const algn = attr(pPr, 'algn') || attr(inhLvl, 'algn') || (phType === 'ctrTitle' || phType === 'subTitle' ? 'ctr' : 'l');
        const defR = desc(inhLvl, 'defRPr')[0];
        let pSz = attr(desc(pPr, 'defRPr')[0], 'sz') || attr(defR, 'sz');
        pSz = pSz ? +pSz / 100 : defSz - (phType === 'body' || phType === 'obj' ? lvl * 2 : 0);
        const bullet = (phType === 'body' || phType === 'obj') && !kid(pPr, 'buNone') && !(inhLvl && kid(inhLvl, 'buNone'));
        const buChar = attr(kid(pPr, 'buChar'), 'char') || (bullet ? '•' : null);
        const isNum = !!kid(pPr, 'buAutoNum');
        let runs = '';
        for (const r of Array.from(p.children)) {
          if (r.localName === 'br') { runs += '<br>'; continue; }
          if (r.localName !== 'r' && r.localName !== 'fld') continue;
          const rPr = kid(r, 'rPr');
          const t = kid(r, 't'); if (!t) continue;
          const sz = attr(rPr, 'sz') ? +attr(rPr, 'sz') / 100 : pSz;
          const b = attr(rPr, 'b') === '1' || (attr(rPr, 'b') == null && attr(defR, 'b') === '1');
          const it = attr(rPr, 'i') === '1';
          const u = attr(rPr, 'u') && attr(rPr, 'u') !== 'none';
          const c = color(kid(rPr, 'solidFill')) || color(kid(defR, 'solidFill')) || (phType && /title/i.test(phType) ? color(desc(desc(mx || pres, 'titleStyle')[0], 'solidFill')[0]) : null) || color(desc(desc(mx || pres, 'bodyStyle')[0], 'solidFill')[0]) || '#000';
          const latin = attr(kid(rPr, 'latin'), 'typeface') || '';
          runs += `<span style="font-size:${sz * fscale * ptPx}px;${b ? 'font-weight:bold;' : ''}${it ? 'font-style:italic;' : ''}${u ? 'text-decoration:underline;' : ''}color:${c};font-family:${cssFamily(latin)}">${escapeHtml(t.textContent)}</span>`;
        }
        const ind = lvl * 28 * ptPx;
        const marker = buChar && runs ? `<span style="display:inline-block;width:${pSz * fscale * ptPx}px;margin-left:-${pSz * fscale * ptPx}px">${escapeHtml(isNum ? '•' : buChar)}</span>` : '';
        html += `<p style="margin:0 0 ${pSz * fscale * ptPx * 0.25}px ${ind + (marker ? pSz * fscale * ptPx : 0)}px;text-align:${{ l: 'left', ctr: 'center', r: 'right', just: 'justify' }[algn] || 'left'};font-size:${pSz * fscale * ptPx}px;line-height:1.15">${marker}${runs || '&nbsp;'}</p>`;
      }
      return html;
    }
    if (mx) { const t = desc(mx, 'spTree')[0]; if (t) await renderTree(t, mrels, mx, true); }
    if (lx && attr(lx.documentElement, 'showMasterSp') !== '0') { const t = desc(lx, 'spTree')[0]; if (t) await renderTree(t, lrels, lx, true); }
    await renderTree(desc(sx, 'spTree')[0], srels, sx, false);
    out += `<section class="slide" data-wpt="${cx / 12700}" data-hpt="${cy / 12700}" style="width:${W}px;height:${H}px;background:${bg};${bgImg ? `background-image:url('${bgImg}');background-size:cover;` : ''}">${bgImg ? `<img class="s" src="${bgImg}" style="left:0;top:0;width:${W}px;height:${H}px">` : ''}${shapesHtml}</section>`;
  }
  if (!out) throw new Error('Presentasi ini tidak punya slide yang bisa ditampilkan.');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#fff;font-family:${SANS}}
    .slide{position:relative;overflow:hidden;margin:0 0 20px}
    .s{position:absolute;box-sizing:border-box;overflow-wrap:break-word}
    p{margin:0}
  </style></head><body>${out}</body></html>`;
  return { html, wpt: cx / 12700, hpt: cy / 12700, count: slides.length };
}
