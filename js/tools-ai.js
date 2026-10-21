/* Intelligence: summarizer, translate, PDF to Markdown */
'use strict';

async function requireAI(ctx) {
  const s = await sampleCap();
  ctx.opts.ai = s;
  if (!s) ctx.side.append(h('p', { class: 'warn' }, 'Fitur AI belum aktif di situs ini. Pemilik situs perlu mengatur kunci API Claude di server.'));
  return s;
}
async function docPlainText(item, step) {
  const d = await openPdfJs(item);
  const pages = [];
  for (let i = 1; i <= d.numPages; i++) { step && step((i - 1) / d.numPages, `Membaca halaman ${i}`); const { lines } = await pageLines(await d.getPage(i)); pages.push(lines.map((l) => l.text).join('\n')); }
  return pages;
}
const LANGS = [['Indonesian', 'Indonesia'], ['English', 'Inggris'], ['Malay', 'Melayu'], ['Javanese', 'Jawa'], ['Sundanese', 'Sunda'], ['Arabic', 'Arab'], ['Chinese (Simplified)', 'Mandarin'], ['Japanese', 'Jepang'], ['Korean', 'Korea'], ['Spanish', 'Spanyol'], ['French', 'Prancis'], ['German', 'Jerman'], ['Dutch', 'Belanda'], ['Portuguese', 'Portugis'], ['Italian', 'Italia'], ['Turkish', 'Turki'], ['Thai', 'Thai'], ['Vietnamese', 'Vietnam']];
const LATIN_LANGS = new Set(['Indonesian', 'English', 'Malay', 'Javanese', 'Sundanese', 'Spanish', 'French', 'German', 'Dutch', 'Portuguese', 'Italian', 'Turkish', 'Vietnamese']);

defineTool({
  id: 'summarize', cat: 'ai', name: 'Ringkas PDF dengan AI', desc: 'Dapatkan ringkasan singkat dari artikel, laporan, atau makalah.', ai: true,
  actionLabel: 'Buat ringkasan', keywords: 'summary ringkas rangkum ai',
  ready: (ctx) => !!ctx.opts.ai,
  async setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Ringkasan'),
      field('Panjang', segmented('sm-len', [['short', 'Singkat'], ['medium', 'Sedang'], ['long', 'Rinci']], 'medium')),
      field('Bentuk', segmented('sm-form', [['bullets', 'Poin-poin'], ['prose', 'Paragraf']], 'bullets')),
      field('Bahasa ringkasan', select('sm-lang', [['same', 'Sama dengan dokumen'], ...LANGS], 'Indonesian')),
      field('Fokus (opsional)', textInput('sm-focus', '', 'Contoh: angka keuangan, kesimpulan')));
    await requireAI(ctx);
  },
  async run(ctx) {
    const s = ctx.opts.ai; const it = ctx.items[0];
    const pages = await docPlainText(it, (f, t) => ctx.progress.set(f * 0.3, t));
    const full = pages.map((p, i) => `[Halaman ${i + 1}]\n${p}`).join('\n\n');
    if (full.replace(/\[Halaman \d+\]|\s/g, '').length < 40) throw new Error('PDF ini hampir tidak punya teks. Jalankan OCR PDF dulu jika ini hasil pindaian.');
    const len = { short: 'about 5 bullet points or 1 short paragraph', medium: 'about 8-12 bullet points or 3 paragraphs', long: 'a detailed summary with section headings, about 600-900 words' }[val('sm-len')];
    const lang = val('sm-lang');
    const instr = `Summarize the document below. Length: ${len}. Form: ${val('sm-form') === 'bullets' ? 'Markdown bullet points, grouped under short headings when useful' : 'flowing Markdown paragraphs'}. Language: ${lang === 'same' ? 'the same language as the document' : lang}. ${val('sm-focus') ? `Pay special attention to: ${val('sm-focus')}.` : ''} Mention page numbers like (hlm. 3) for key facts. Output only the summary in Markdown, starting with a one-line title as a level-2 heading.`;
    const out = h('div', { class: 'md-out', 'aria-live': 'polite' });
    const LIMIT = 170000;
    let text;
    try {
      if (new TextEncoder().encode(full).length <= LIMIT) {
        ctx.progress.set(0.4, 'Claude sedang meringkas');
        showLive(ctx, out);
        const r = await s(`${instr}\n\n<document>\n${full}\n</document>`, { modelTier: 'default', onText: ({ text: t }) => { out.innerHTML = mdToHtml(t); } });
        text = r.text;
      } else {
        const chunks = chunkText(full, LIMIT * 0.8);
        const parts = [];
        for (let i = 0; i < chunks.length; i++) {
          ctx.progress.set(0.35 + (i / chunks.length) * 0.45, `Meringkas bagian ${i + 1} dari ${chunks.length}`);
          parts.push((await s(`Write detailed notes (bullet points, keep page numbers) of this part ${i + 1}/${chunks.length} of a long document:\n<part>\n${chunks[i]}\n</part>`, { modelTier: 'default' })).text);
        }
        ctx.progress.set(0.85, 'Menggabungkan ringkasan');
        showLive(ctx, out);
        text = (await s(`${instr}\n\nThe document was too long, so here are notes from each part:\n<notes>\n${parts.join('\n\n')}\n</notes>`, { modelTier: 'default', onText: ({ text: t }) => { out.innerHTML = mdToHtml(t); } })).text;
      }
    } catch (e) { throw new Error(aiErrorText(e)); }
    out.innerHTML = mdToHtml(text);
    const b = baseName(it.name);
    return { title: 'Ringkasan siap', outputs: [{ name: b + '_ringkasan.md', bytes: new TextEncoder().encode(text) }, { name: b + '_ringkasan.txt', bytes: new TextEncoder().encode(text.replace(/^#+\s*/gm, '').replace(/\*\*/g, '')) }], zipName: b + '_ringkasan', preview: out };
  },
});
function showLive(ctx, node) { if (!node.isConnected) ctx.main.prepend(h('section', { class: 'live' }, h('h3', null, 'Hasil sementara'), node)); }
function chunkText(t, max) { const out = []; let cur = ''; for (const para of t.split(/\n(?=\[Halaman )/)) { if ((cur + para).length > max && cur) { out.push(cur); cur = ''; } cur += para + '\n'; } if (cur) out.push(cur); return out; }
function mdToHtml(md) {
  const lines = String(md).split('\n'); let html = ''; let inList = false;
  const inline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`(.+?)`/g, '<code>$1</code>');
  for (const ln of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(ln); const li = /^\s*[-*]\s+(.*)$/.exec(ln); const ol = /^\s*\d+[.)]\s+(.*)$/.exec(ln);
    if (!li && !ol && inList) { html += '</ul>'; inList = false; }
    if (m) html += `<h${Math.min(6, m[1].length + 1)}>${inline(m[2])}</h${Math.min(6, m[1].length + 1)}>`;
    else if (li || ol) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline((li || ol)[1])}</li>`; }
    else if (ln.trim()) html += `<p>${inline(ln)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function wrapLines(text, font, size, maxW) {
  const words = text.split(/\s+/).filter(Boolean); const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(t, size) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

defineTool({
  id: 'translate', cat: 'ai', name: 'Terjemahkan PDF', desc: 'Terjemahkan PDF ke bahasa lain dengan tata letak yang dipertahankan.', ai: true,
  actionLabel: 'Terjemahkan', keywords: 'translate terjemah bahasa',
  ready: (ctx) => !!ctx.opts.ai,
  async setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Terjemahan'),
      field('Ke bahasa', select('tr-lang', LANGS, 'English')),
      field('Halaman', textInput('tr-pages', '', 'Kosongkan untuk semua')),
      field('Hasil', segmented('tr-out', [['layout', 'PDF tata letak asli', 'teks diganti di tempatnya'], ['doc', 'Dokumen Word', 'teks mengalir, mudah diedit']], 'layout')),
      h('p', { class: 'hint' }, 'PDF tata letak asli memakai huruf standar Latin. Untuk bahasa beraksara non-Latin (Arab, Mandarin, Jepang, Korea, Thai) hasilnya otomatis berupa dokumen Word.'));
    await requireAI(ctx);
  },
  async run(ctx) {
    const s = ctx.opts.ai; const it = ctx.items[0];
    const lang = val('tr-lang');
    const layout = val('tr-out') === 'layout' && LATIN_LANGS.has(lang);
    const d = await openPdfJs(it);
    const n = d.numPages;
    const sel = val('tr-pages') ? parseRanges(val('tr-pages'), n) : [...Array(n).keys()];
    const doc = layout ? await openPdfLib(it) : null;
    const fonts = {};
    const font = async (b) => (fonts[b] ||= await doc.embedFont(b ? PDFLib.StandardFonts.HelveticaBold : PDFLib.StandardFonts.Helvetica));
    const docxParas = [];
    let any = 0;
    for (let k = 0; k < sel.length; k++) {
      const pi = sel[k];
      ctx.progress.set(k / sel.length, `Menerjemahkan halaman ${pi + 1} (${k + 1}/${sel.length})`);
      const page = await d.getPage(pi + 1);
      const vp = page.getViewport({ scale: 1 });
      const { lines } = await pageLines(page);
      const paras = paragraphsFromLines(lines, vp.width);
      if (!paras.length) { docxParas.push({ page: pi + 1, paras: [] }); continue; }
      let tr;
      try {
        const r = await s.json(`Translate each string in the JSON array below into ${lang}. Keep numbers, names, codes, URLs and email addresses unchanged. Return JSON {"t":[...]} with exactly ${paras.length} strings in the same order.\n${JSON.stringify(paras.map((p) => p.text))}`, { modelTier: 'default' });
        tr = Array.isArray(r && r.t) ? r.t : null;
      } catch (e) { if (e && e.code && e.code !== 'invalid_json') throw new Error(aiErrorText(e)); tr = null; }
      if (!tr || tr.length !== paras.length) throw new Error(`Terjemahan halaman ${pi + 1} tidak lengkap. Coba lagi.`);
      any += paras.length;
      docxParas.push({ page: pi + 1, paras: paras.map((p, i) => ({ ...p, tr: String(tr[i] ?? p.text) })) });
      if (layout) {
        const pg = doc.getPage(pi);
        const F = visualFrame(pg);
        for (let i = 0; i < paras.length; i++) {
          const p = paras[i]; const t = winAnsi(String(tr[i] ?? p.text));
          const box = { x: p.x1 - 1, y: p.top - 1, w: Math.max(30, p.x2 - p.x1 + 2), h: Math.max(p.size * 1.2, p.bot - p.top + 2) };
          vDrawRect(pg, F, box, { color: PDFLib.rgb(1, 1, 1) });
          const f = await font(p.bold || p.heading);
          let size = p.size, wrapped = wrapLines(t, f, size, box.w);
          while (size > 4.5 && wrapped.length * size * 1.18 > box.h + p.size * 0.6) { size *= 0.93; wrapped = wrapLines(t, f, size, box.w); }
          vDrawText(pg, F, wrapped.join('\n'), box.x + 1, box.y + Math.max(0, (p.size - size) * 0.3), { size, font: f, color: PDFLib.rgb(0.07, 0.07, 0.07), lineHeight: 1.18 });
        }
      }
    }
    if (!any) throw new Error('Tidak ada teks yang bisa diterjemahkan. Jalankan OCR PDF dulu jika ini hasil pindaian.');
    const b = baseName(it.name);
    const code = { Indonesian: 'id', English: 'en', Malay: 'ms', Japanese: 'ja', Arabic: 'ar', 'Chinese (Simplified)': 'zh', Korean: 'ko', Spanish: 'es', French: 'fr', German: 'de', Dutch: 'nl', Portuguese: 'pt', Italian: 'it', Turkish: 'tr', Thai: 'th', Vietnamese: 'vi', Javanese: 'jv', Sundanese: 'su' }[lang] || 'tr';
    const outs = [];
    if (layout) outs.push({ name: `${b}_${code}.pdf`, bytes: await savePdf(doc), info: lang });
    await loadScript(LIB + 'docx.iife.js');
    const D = window.docx;
    const children = [];
    docxParas.forEach((pg, k) => pg.paras.forEach((p, i) => children.push(new D.Paragraph({ pageBreakBefore: k > 0 && i === 0, alignment: p.align === 'center' ? D.AlignmentType.CENTER : D.AlignmentType.LEFT, spacing: { after: 120 }, children: [new D.TextRun({ text: p.tr, bold: p.bold || p.heading, size: Math.max(16, Math.round(p.size * 2)) })] }))));
    const wd = new D.Document({ creator: 'Atur PDF', sections: [{ children }] });
    outs.push({ name: `${b}_${code}.docx`, bytes: await blobBytes(await D.Packer.toBlob(wd)), info: lang });
    return { outputs: outs, zipName: `${b}_${code}`, title: 'Terjemahan siap', note: !layout && val('tr-out') === 'layout' ? `Bahasa ${(LANGS.find((l) => l[0] === lang) || [, lang])[1]} memakai aksara non-Latin, jadi hasilnya berupa dokumen Word.` : null };
  },
});

defineTool({
  id: 'markdown', cat: 'ai', name: 'PDF ke Markdown', desc: 'Ubah PDF menjadi Markdown dengan judul, daftar, tabel, dan tautan.', ai: false,
  actionLabel: 'Ubah ke Markdown', keywords: 'markdown md teks',
  async setup(ctx) {
    fileList(ctx);
    const s = await sampleCap();
    ctx.opts.ai = s;
    ctx.side.append(h('h3', null, 'Markdown'),
      checkbox('md-pages', 'Beri penanda setiap halaman', false),
      checkbox('md-ai', 'Rapikan struktur dengan Claude (lebih akurat untuk dokumen rumit)', false),
      !s ? h('p', { class: 'hint' }, 'Opsi Claude belum aktif di situs ini.') : null);
    if (!s) { const c = document.getElementById('md-ai'); if (c) c.disabled = true; }
  },
  async run(ctx) {
    const it = ctx.items[0];
    const d = await openPdfJs(it);
    const allLines = [];
    for (let i = 1; i <= d.numPages; i++) { const pg = await d.getPage(i); const pl = await pageLines(pg); let links = []; try { links = (await pg.getAnnotations()).filter((a) => a.subtype === 'Link' && a.url); } catch {} allLines.push({ ...pl, links, vp: pg.getViewport({ scale: 1 }) }); ctx.progress.set((i / d.numPages) * 0.5, `Halaman ${i}`); }
    const sizeCount = new Map();
    for (const p of allLines) for (const l of p.lines) { const k = Math.round(l.size); sizeCount.set(k, (sizeCount.get(k) || 0) + l.text.length); }
    const body = [...sizeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
    const heads = [...sizeCount.keys()].filter((s) => s >= body * 1.18).sort((a, b) => b - a).slice(0, 4);
    let md = '';
    allLines.forEach((p, pi) => {
      if (val('md-pages')) md += `\n<!-- Halaman ${pi + 1} -->\n\n`;
      const linkFor = (l) => p.links.find((a) => { const [x1, y1, x2, y2] = p.vp.convertToViewportRectangle(a.rect); const top = Math.min(y1, y2), bot = Math.max(y1, y2); return l.y > top - 2 && l.y < bot + l.size && Math.min(x1, x2) <= l.x + 4; });
      const paras = paragraphsFromLines(p.lines, p.width);
      /* table detection: consecutive lines that split into the same 2+ cell layout */
      const rows = p.lines.map((l) => { const cells = []; let cur = null; for (const it2 of l.items) { if (!it2.str.trim()) continue; const gap = cur ? it2.x - cur.x2 : Infinity; if (cur && gap < it2.size * 1.2) { cur.t += (gap > it2.size * 0.15 ? ' ' : '') + it2.str; cur.x2 = it2.x + it2.w; } else { cur = { t: it2.str, x: it2.x, x2: it2.x + it2.w }; cells.push(cur); } } return cells; });
      const tableAt = new Map();
      for (let i = 0; i < rows.length;) {
        let j = i; while (j < rows.length && rows[j].length >= 2 && rows[j].length === rows[i].length) j++;
        if (j - i >= 3) { tableAt.set(i, j); i = j; } else i++;
      }
      const tableLines = new Set(); for (const [a, b] of tableAt) for (let k = a; k < b; k++) tableLines.add(p.lines[k]);
      const emitted = new Set();
      let lineIdx = 0;
      for (const para of paras) {
        const firstLine = para.lines[0];
        if (emitted.has(firstLine)) continue;
        if (tableLines.has(firstLine)) {
          const start = p.lines.indexOf(firstLine);
          let a0 = start; while (a0 > 0 && !tableAt.has(a0)) a0--;
          const end = tableAt.get(a0);
          if (end != null) {
            const tr = rows.slice(a0, end).map((r) => '| ' + r.map((c) => c.t.replace(/\|/g, '\\|').trim()).join(' | ') + ' |');
            md += tr[0] + '\n|' + rows[a0].map(() => ' --- ').join('|') + '|\n' + tr.slice(1).join('\n') + '\n\n';
            for (let k = a0; k < end; k++) emitted.add(p.lines[k]);
          }
          continue;
        }
        if (firstLine) emitted.add(firstLine);
        let t = para.text;
        const lk = firstLine ? linkFor(firstLine) : null;
        if (lk) t = /^https?:/.test(t) ? `<${lk.url}>` : `[${t}](${lk.url})`;
        const hi = heads.indexOf(Math.round(para.size));
        if (hi >= 0 && t.length < 160) md += `${'#'.repeat(hi + 1)} ${t}\n\n`;
        else if (/^[•●▪◦\-–*]\s*/.test(t)) md += `- ${t.replace(/^[•●▪◦\-–*]\s*/, '')}\n`;
        else if (/^\d+[.)]\s/.test(t)) md += `${t}\n`;
        else if (para.bold && t.length < 120) md += `**${t}**\n\n`;
        else md += `${t}\n\n`;
        lineIdx++;
      }
      md += '\n';
    });
    md = md.replace(/\n{3,}/g, '\n\n').trim() + '\n';
    if (val('md-ai') && ctx.opts.ai) {
      ctx.progress.set(0.6, 'Claude merapikan struktur');
      try {
        const r = await ctx.opts.ai(`Below is Markdown extracted automatically from a PDF. Fix its structure without changing the wording: correct heading levels, join broken paragraphs, format lists and tables properly, keep links. Output only the corrected Markdown.\n\n${md.slice(0, 160000)}`, { modelTier: 'default' });
        md = r.text.replace(/^```(?:markdown)?\n|\n```$/g, '');
      } catch (e) { toast(aiErrorText(e), 'error'); }
    }
    const b = baseName(it.name);
    return { outputs: [{ name: b + '.md', bytes: new TextEncoder().encode(md), info: `${md.split('\n').length} baris` }], preview: h('pre', { class: 'textprev' }, md.slice(0, 8000)) };
  },
});
