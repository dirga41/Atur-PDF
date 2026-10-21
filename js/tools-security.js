/* Security: unlock, protect, sign, redact, compare */
'use strict';

defineTool({
  id: 'unlock', cat: 'security', name: 'Buka Kunci PDF', desc: 'Hapus kata sandi dan batasan izin dari PDF yang kamu punya aksesnya.',
  actionLabel: 'Buka kunci', keywords: 'unlock password sandi buka',
  setup(ctx) {
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Kata sandi'), h('p', { class: 'muted' }, 'Jika PDF butuh kata sandi untuk dibuka, kamu akan diminta memasukkannya. PDF yang hanya dibatasi izin cetak atau salin bisa langsung dibuka.'),
      h('p', { class: 'hint' }, 'Hanya buka kunci dokumen milikmu sendiri atau yang kamu berhak akses.'));
  },
  async run(ctx) {
    const it = ctx.items[0];
    let wasLocked = false;
    try { await PDFLib.PDFDocument.load(it.bytes, { updateMetadata: false }); } catch (e) { wasLocked = /encrypted/i.test(String(e && e.message)); }
    ctx.progress.set(0.3, 'Membuka enkripsi');
    const doc = await rebuildViaPdfJs(it);
    const bytes = await savePdf(doc);
    return { outputs: [{ name: baseName(it.name) + '_terbuka.pdf', bytes, info: 'tanpa kata sandi' }], note: wasLocked ? 'Enkripsi, kata sandi, dan batasan izin sudah dihapus.' : 'File ini ternyata tidak terkunci. Struktur PDF tetap disusun ulang tanpa enkripsi.' };
  },
});

/* ---------- AES-256 (PDF 2.0, revision 6) encryption ---------- */
const enc8 = (s) => new TextEncoder().encode(s).slice(0, 127);
function cat(...a) { const n = a.reduce((x, y) => x + y.length, 0); const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; }
async function digest(alg, d) { return new Uint8Array(await crypto.subtle.digest(alg, d)); }
async function aesCbc(key, iv, data, pad) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data));
  return pad ? out : out.slice(0, data.length);
}
async function hash2B(pwd, salt, udata) {
  let K = await digest('SHA-256', cat(pwd, salt, udata));
  let E = null, i = 0;
  while (i < 64 || E[E.length - 1] > i - 32) {
    const one = cat(pwd, K, udata);
    const K1 = new Uint8Array(one.length * 64);
    for (let j = 0; j < 64; j++) K1.set(one, j * one.length);
    E = await aesCbc(K.slice(0, 16), K.slice(16, 32), K1, false);
    let sum = 0; for (let j = 0; j < 16; j++) sum += E[j];
    const m = sum % 3;
    K = await digest(m === 0 ? 'SHA-256' : m === 1 ? 'SHA-384' : 'SHA-512', E);
    i++;
  }
  return K.slice(0, 32);
}
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function encryptPdf(bytesIn, { user, owner, perms }) {
  const { PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFRawStream, PDFNumber, PDFBool } = PDFLib;
  /* Normalise first: no object streams, every stream raw. */
  const base = await PDFLib.PDFDocument.load(bytesIn, { updateMetadata: false });
  const flat = await base.save({ useObjectStreams: false, updateMetadata: false });
  const doc = await PDFLib.PDFDocument.load(flat, { updateMetadata: false });
  const ctx = doc.context;
  const fileKey = rnd(32);
  const up = enc8(user), op = enc8(owner || toHex(rnd(16)));
  const uVal = rnd(8), uKey = rnd(8);
  const U = cat(await hash2B(up, uVal, new Uint8Array(0)), uVal, uKey);
  const UE = await aesCbc(await hash2B(up, uKey, new Uint8Array(0)), new Uint8Array(16), fileKey, false);
  const oVal = rnd(8), oKey = rnd(8);
  const O = cat(await hash2B(op, oVal, U), oVal, oKey);
  const OE = await aesCbc(await hash2B(op, oKey, U), new Uint8Array(16), fileKey, false);
  let P = 0xfffff0c0;
  if (perms.print) P |= 4 | 2048;
  if (perms.modify) P |= 8 | 1024;
  if (perms.copy) P |= 16 | 512;
  if (perms.annotate) P |= 32 | 256;
  P = P | 0;
  const permsPlain = new Uint8Array(16);
  new DataView(permsPlain.buffer).setInt32(0, P, true);
  permsPlain.set([0xff, 0xff, 0xff, 0xff], 4);
  permsPlain.set([84, 97, 100, 98], 8); /* 'T','a','d','b' */
  permsPlain.set(rnd(4), 12);
  const Perms = await aesCbc(fileKey, new Uint8Array(16), permsPlain, false);

  const encBytes = async (b) => { const iv = rnd(16); return cat(iv, await aesCbc(fileKey, iv, b, true)); };
  const walk = async (o) => {
    if (o instanceof PDFString || o instanceof PDFHexString) return PDFHexString.of(toHex(await encBytes(o.asBytes())));
    if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) o.set(i, await walk(o.get(i))); return o; }
    if (o instanceof PDFDict) { for (const [k, v] of o.entries()) o.set(k, await walk(v)); return o; }
    return o;
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const t = obj.dict.get(PDFName.of('Type'));
      if (t === PDFName.of('XRef')) continue;
      await walk(obj.dict);
      const data = await encBytes(obj.contents);
      obj.dict.set(PDFName.of('Length'), PDFNumber.of(data.length));
      ctx.assign(ref, PDFRawStream.of(obj.dict, data));
    } else if (obj instanceof PDFDict || obj instanceof PDFArray) await walk(obj);
    else if (obj instanceof PDFString || obj instanceof PDFHexString) ctx.assign(ref, await walk(obj));
  }
  const encDict = ctx.obj({
    Filter: 'Standard', V: 5, R: 6, Length: 256, P,
    O: PDFHexString.of(toHex(O)), U: PDFHexString.of(toHex(U)), OE: PDFHexString.of(toHex(OE)), UE: PDFHexString.of(toHex(UE)), Perms: PDFHexString.of(toHex(Perms)),
    StmF: 'StdCF', StrF: 'StdCF',
    CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } },
  });
  encDict.set(PDFName.of('EncryptMetadata'), PDFBool.True);
  ctx.trailerInfo.Encrypt = ctx.register(encDict);
  const id = toHex(rnd(16));
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  return await doc.save({ useObjectStreams: false, updateMetadata: false });
}

defineTool({
  id: 'protect', cat: 'security', name: 'Lindungi PDF', desc: 'Kunci PDF dengan kata sandi dan enkripsi AES-256.',
  actionLabel: 'Lindungi PDF', keywords: 'protect password sandi kunci enkripsi',
  ready: () => true,
  setup(ctx) {
    fileList(ctx);
    const p1 = h('input', { type: 'password', id: 'pr-pw', class: 'field', autocomplete: 'new-password' });
    const p2 = h('input', { type: 'password', id: 'pr-pw2', class: 'field', autocomplete: 'new-password' });
    const show = h('input', { type: 'checkbox', id: 'pr-show', onchange: () => { p1.type = p2.type = show.checked ? 'text' : 'password'; } });
    ctx.side.append(h('h3', null, 'Kata sandi'),
      field('Kata sandi untuk membuka', p1), field('Ulangi kata sandi', p2),
      h('label', { class: 'check', for: 'pr-show' }, show, h('span', null, 'Tampilkan kata sandi')),
      h('details', { class: 'fold' }, h('summary', null, 'Izin tambahan'),
        h('div', { class: 'stack' },
          field('Kata sandi pemilik (opsional)', h('input', { type: 'password', id: 'pr-owner', class: 'field', autocomplete: 'new-password' }), 'Dipakai untuk mengubah izin. Jika kosong, dibuat acak.'),
          checkbox('pr-print', 'Izinkan mencetak', true), checkbox('pr-copy', 'Izinkan menyalin teks', true), checkbox('pr-modify', 'Izinkan mengubah dokumen', false), checkbox('pr-annot', 'Izinkan komentar dan isi formulir', true))),
      h('p', { class: 'hint' }, 'Simpan kata sandi baik-baik. Tanpanya, file tidak bisa dibuka lagi.'));
  },
  async run(ctx) {
    const pw = val('pr-pw'), pw2 = val('pr-pw2');
    if (!pw) throw new Error('Isi kata sandi terlebih dahulu.');
    if (pw !== pw2) throw new Error('Kedua kata sandi tidak sama.');
    const it = ctx.items[0];
    ctx.progress.set(0.2, 'Menyiapkan dokumen');
    const doc = await openPdfLib(it);
    const plain = await savePdf(doc, { objectStreams: false });
    ctx.progress.set(0.5, 'Mengenkripsi dengan AES-256');
    const bytes = await encryptPdf(plain, { user: pw, owner: val('pr-owner'), perms: { print: val('pr-print'), copy: val('pr-copy'), modify: val('pr-modify'), annotate: val('pr-annot') } });
    return [{ name: baseName(it.name) + '_terkunci.pdf', bytes, info: 'AES-256' }];
  },
});

/* ---------- Sign ---------- */
function signatureModal() {
  return new Promise((resolve) => {
    let mode = 'draw';
    let color = '#1b2a6b';
    const pad = h('canvas', { class: 'sig-pad', width: 600, height: 200, 'aria-label': 'Area menggambar tanda tangan' });
    const px = pad.getContext('2d');
    let drawing = false, last = null, dirty = false;
    const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)]; };
    pad.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); });
    pad.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); px.strokeStyle = color; px.lineWidth = 3.2; px.lineCap = 'round'; px.lineJoin = 'round'; px.beginPath(); px.moveTo(...last); px.lineTo(...p); px.stroke(); last = p; dirty = true; });
    pad.addEventListener('pointerup', () => { drawing = false; });
    const nameIn = h('input', { type: 'text', id: 'sig-name', class: 'field', placeholder: 'Nama lengkap', value: '' });
    const fonts = ['Caveat', 'Dancing Script', 'Great Vibes', 'Homemade Apple'];
    let fontSel = fonts[0];
    const preview = h('div', { class: 'sig-fonts' });
    const drawFonts = () => { preview.innerHTML = ''; for (const f of fonts) preview.append(h('button', { type: 'button', class: 'sig-font', 'aria-pressed': String(f === fontSel), style: { fontFamily: `'${f}', cursive`, color }, onclick: () => { fontSel = f; drawFonts(); } }, nameIn.value || 'Tanda Tangan')); };
    nameIn.addEventListener('input', drawFonts);
    const upIn = h('input', { type: 'file', accept: 'image/png,image/jpeg', id: 'sig-up' });
    const colors = h('div', { class: 'row' }, ['#1b2a6b', '#111111', '#a01818'].map((c) => h('button', { type: 'button', class: 'dot', style: { background: c }, 'aria-label': { '#1b2a6b': 'Biru', '#111111': 'Hitam', '#a01818': 'Merah' }[c], onclick: () => { color = c; drawFonts(); } })));
    const panes = { draw: h('div', { class: 'stack' }, pad, h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { px.clearRect(0, 0, pad.width, pad.height); dirty = false; } }, 'Hapus coretan')), type: h('div', { class: 'stack' }, nameIn, preview), upload: h('div', { class: 'stack' }, upIn, h('p', { class: 'hint' }, 'Gunakan foto tanda tangan di kertas putih, atau PNG transparan.')) };
    const holder = h('div');
    const tabs = segmented('sig-mode', [['draw', 'Gambar'], ['type', 'Ketik'], ['upload', 'Unggah']], 'draw', (m) => { mode = m; holder.innerHTML = ''; holder.append(panes[m]); if (m === 'type') drawFonts(); });
    holder.append(panes.draw);
    const body = h('div', { class: 'stack' }, tabs, colors, holder);
    modal({ title: 'Buat tanda tangan', body, actions: [{ label: 'Batal', result: null }, { label: 'Pakai tanda tangan', primary: true, value: () => 'ok' }] }).then(async (r) => {
      if (!r) return resolve(null);
      if (mode === 'draw') { if (!dirty) return resolve(null); return resolve(await canvasToBlob(trimCanvas(pad), 'image/png')); }
      if (mode === 'type') {
        const t = nameIn.value.trim(); if (!t) return resolve(null);
        try { await document.fonts.load(`64px '${fontSel}'`); } catch {}
        const c = document.createElement('canvas'); c.width = 900; c.height = 220;
        const x = c.getContext('2d'); x.font = `110px '${fontSel}', cursive`; x.fillStyle = color; x.textBaseline = 'middle'; x.fillText(t, 20, 115);
        return resolve(await canvasToBlob(trimCanvas(c), 'image/png'));
      }
      const f = upIn.files[0]; if (!f) return resolve(null);
      const img = await fileToImage(f);
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) { const l = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3; if (l > 215) d.data[i + 3] = 0; }
      x.putImageData(d, 0, 0);
      resolve(await canvasToBlob(trimCanvas(c), 'image/png'));
    });
  });
}
function trimCanvas(c) {
  const x = c.getContext('2d'); const d = x.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let xx = 0; xx < c.width; xx++) if (d[(y * c.width + xx) * 4 + 3] > 10) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return c;
  const o = document.createElement('canvas'); o.width = x1 - x0 + 9; o.height = y1 - y0 + 9;
  o.getContext('2d').drawImage(c, x0 - 4, y0 - 4, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}

defineTool({
  id: 'sign', cat: 'security', name: 'Tanda Tangani PDF', desc: 'Bubuhkan tanda tangan, inisial, dan tanggal di PDF.',
  actionLabel: 'Simpan dokumen bertanda tangan', keywords: 'sign tanda tangan ttd signature',
  async setup(ctx) {
    const ed = makeEditor(ctx, ctx.items[0], { tools: [['select', 'Pilih'], ['text', 'Teks']] });
    ctx.opts.ed = ed;
    const saved = [];
    const shelf = h('div', { class: 'sig-shelf' });
    const drawShelf = () => {
      shelf.innerHTML = '';
      if (!saved.length) shelf.append(h('p', { class: 'muted' }, 'Belum ada tanda tangan.'));
      saved.forEach((b) => { const u = URL.createObjectURL(b); shelf.append(h('button', { type: 'button', class: 'sig-item', 'aria-label': 'Tempel tanda tangan ini', onclick: () => place(b) }, h('img', { src: u, alt: 'Tanda tangan tersimpan' }))); });
    };
    const place = async (blob, frac = 0.28) => {
      const o = await ed.addImage(blob);
      const vw = ed.stage.viewport.width / ed.stage.scale, vh = ed.stage.viewport.height / ed.stage.scale;
      const r = o.h / o.w; o.w = vw * frac; o.h = o.w * r; o.x = vw - o.w - vw * 0.08; o.y = vh - o.h - vh * 0.1; ed.redraw();
    };
    drawShelf();
    ctx.side.append(h('h3', null, 'Tanda tangan'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => { const b = await signatureModal(); if (b) { saved.unshift(b); drawShelf(); await place(b); } } }, '+ Buat tanda tangan'),
      h('button', { type: 'button', class: 'btn ghost', onclick: async () => { const b = await signatureModal(); if (b) { saved.unshift(b); drawShelf(); await place(b, 0.12); } } }, '+ Inisial'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { const d = new Date(); const t = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; const vw = ed.stage.viewport.width / ed.stage.scale; ed.add({ kind: 'text', text: t, x: vw * 0.62, y: 60, w: 110, h: 20, size: 12, font: 'Helvetica', color: '#1a1a1a' }); } }, '+ Tanggal hari ini'),
      shelf,
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => {
        const o = ed.selected; if (!o) { toast('Pilih objek di halaman dulu.'); return; }
        for (let p = 0; p < ed.stage.count; p++) if (p !== o.page) ed.objects.push({ ...o, id: uid(), page: p });
        toast(`Disalin ke ${ed.stage.count - 1} halaman lain.`);
      } }, 'Salin objek terpilih ke semua halaman'),
      h('p', { class: 'hint' }, 'Seret tanda tangan ke posisi yang tepat dan tarik sudutnya untuk mengubah ukuran. Tanda tangan ini berupa gambar, bukan sertifikat digital.'));
  },
  async run(ctx) {
    const ed = ctx.opts.ed;
    if (!ed.objects.length) throw new Error('Tambahkan tanda tangan terlebih dahulu.');
    const it = ctx.items[0];
    const doc = await openPdfLib(it);
    await applyObjects(doc, ed.objects);
    return [{ name: baseName(it.name) + '_ditandatangani.pdf', bytes: await savePdf(doc) }];
  },
});

/* ---------- Redact ---------- */
defineTool({
  id: 'redact', cat: 'security', name: 'Sensor PDF', desc: 'Hapus teks dan gambar sensitif secara permanen, bukan sekadar ditutupi.',
  actionLabel: 'Terapkan sensor', keywords: 'redact sensor hitamkan rahasia',
  async setup(ctx) {
    const ed = makeEditor(ctx, ctx.items[0], { tools: [['redact', 'Tandai area'], ['select', 'Pilih']], initialTool: 'redact' });
    ctx.opts.ed = ed;
    const q = textInput('rd-q', '', 'Contoh: 3578xxxx, nama, email');
    const found = h('p', { class: 'muted', 'aria-live': 'polite' });
    ctx.side.append(h('h3', null, 'Cari dan sensor'),
      field('Kata atau angka', q, 'Pisahkan beberapa kata dengan koma.'),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn ghost', onclick: async () => {
          const terms = q.value.split(',').map((s) => s.trim()).filter(Boolean);
          if (!terms.length) { toast('Isi kata yang ingin disensor.'); return; }
          const n = await markTerms(ed, ctx.items[0], terms.map((t) => ({ re: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') })));
          found.textContent = n ? `${n} kemunculan ditandai.` : 'Tidak ditemukan.';
        } }, 'Tandai semua'),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: async () => { const n = await markTerms(ed, ctx.items[0], [{ re: /[\w.+-]+@[\w-]+\.[\w.]+/g }]); found.textContent = `${n} alamat email ditandai.`; } }, 'Semua email'),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: async () => { const n = await markTerms(ed, ctx.items[0], [{ re: /(\+?\d[\d\s-]{8,}\d)/g }]); found.textContent = `${n} nomor ditandai.`; } }, 'Nomor telepon/NIK')),
      found,
      h('h3', null, 'Hasil'),
      checkbox('rd-text', 'Pertahankan teks lain agar tetap bisa dicari', true),
      checkbox('rd-meta', 'Hapus metadata dokumen (judul, penulis)', true),
      h('p', { class: 'hint' }, 'Halaman yang disensor diubah menjadi gambar sehingga isi di bawah kotak hitam benar-benar hilang. Halaman lain tidak diubah.'));
  },
  async run(ctx) {
    const ed = ctx.opts.ed;
    const boxes = ed.objects.filter((o) => o.kind === 'redact');
    if (!boxes.length) throw new Error('Tandai dulu area yang ingin disensor.');
    const it = ctx.items[0];
    const src = await openPdfLib(it);
    const js = await openPdfJs(it);
    const out = await PDFLib.PDFDocument.create();
    const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
    const n = src.getPageCount();
    for (let i = 0; i < n; i++) {
      ctx.progress.set(i / n, `Halaman ${i + 1}`);
      const bs = boxes.filter((b) => b.page === i);
      if (!bs.length) { const [p] = await out.copyPages(src, [i]); out.addPage(p); continue; }
      const page = await js.getPage(i + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const sc = 200 / 72;
      const c = await renderPage(page, { scale: sc });
      const x = c.getContext('2d'); x.fillStyle = '#000';
      for (const b of bs) x.fillRect(b.x * sc, b.y * sc, b.w * sc, b.h * sc);
      const jpg = await out.embedJpg(await blobBytes(await canvasToBlob(c, 'image/jpeg', 0.88)));
      const np = out.addPage([vp1.width, vp1.height]);
      np.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      if (val('rd-text')) {
        const { lines, height } = await pageLines(page);
        for (const l of lines) for (const itx of l.items) {
          const r = { x: itx.x, y: itx.y - itx.size, w: itx.w, h: itx.size * 1.2 };
          if (bs.some((b) => r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y)) continue;
          const t = winAnsi(itx.str); if (!t.trim()) continue;
          const w = font.widthOfTextAtSize(t, itx.size);
          np.pushOperators(PDFLib.pushGraphicsState(), PDFLib.setCharacterSqueeze(w > 0 && itx.w > 0 ? Math.max(20, Math.min(400, (itx.w / w) * 100)) : 100));
          np.drawText(t, { x: itx.x, y: height - itx.y, size: itx.size, font, opacity: 0 });
          np.pushOperators(PDFLib.popGraphicsState());
        }
      }
    }
    if (!val('rd-meta')) { out.setTitle(src.getTitle() || ''); out.setAuthor(src.getAuthor() || ''); }
    out.setProducer('Atur PDF');
    return [{ name: baseName(it.name) + '_disensor.pdf', bytes: await savePdf(out), info: `${boxes.length} area disensor` }];
  },
});
async function markTerms(ed, item, patterns) {
  const d = await openPdfJs(item);
  let count = 0;
  for (let p = 1; p <= d.numPages; p++) {
    const page = await d.getPage(p);
    const { lines } = await pageLines(page);
    for (const l of lines) for (const it of l.items) {
      if (!it.str) continue;
      for (const { re } of patterns) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(it.str))) {
          const per = it.w / Math.max(1, it.str.length);
          ed.objects.push({ id: uid(), page: p - 1, kind: 'redact', x: it.x + per * m.index - 1, y: it.y - it.size * 0.95, w: per * m[0].length + 2, h: it.size * 1.25 });
          count++;
          if (!m[0].length) re.lastIndex++;
        }
      }
    }
  }
  ed.redraw();
  return count;
}

/* ---------- Compare ---------- */
defineTool({
  id: 'compare', cat: 'security', name: 'Bandingkan PDF', desc: 'Lihat perbedaan teks antara dua versi dokumen, berdampingan.',
  multiple: true, minFiles: 2, actionLabel: 'Bandingkan', keywords: 'compare banding beda diff versi',
  pickLabel: 'Pilih dua PDF', dropHint: 'atau tarik versi lama dan versi baru ke sini',
  setup(ctx) {
    if (ctx.items.length > 2) ctx.items.splice(2);
    fileList(ctx);
    ctx.side.append(h('h3', null, 'Urutan'), h('p', { class: 'muted' }, 'File pertama dianggap versi lama, file kedua versi baru.'),
      checkbox('cmp-case', 'Abaikan perbedaan huruf besar/kecil', false),
      checkbox('cmp-space', 'Abaikan spasi berlebih', true));
  },
  async run(ctx) {
    if (ctx.items.length !== 2) throw new Error('Pilih tepat dua file PDF.');
    const [A, B] = ctx.items;
    const norm = (s) => { let t = s; if (val('cmp-space')) t = t.replace(/\s+/g, ' ').trim(); if (val('cmp-case')) t = t.toLowerCase(); return t; };
    const read = async (it, off) => { const d = await openPdfJs(it); const L = []; for (let p = 1; p <= d.numPages; p++) { ctx.progress.set(off + (p / d.numPages) * 0.4, `Membaca ${it.name}`); const pl = await pageLines(await d.getPage(p)); for (const l of pl.lines) L.push({ p, l, key: norm(l.text) }); } return { d, L }; };
    const a = await read(A, 0), b = await read(B, 0.4);
    ctx.progress.set(0.85, 'Mencari perbedaan');
    const ops = diffLines(a.L.map((x) => x.key), b.L.map((x) => x.key));
    const delA = new Set(), addB = new Set();
    const changes = [];
    for (const o of ops) {
      if (o.t === '-') { delA.add(o.i); changes.push({ t: '-', x: a.L[o.i] }); }
      if (o.t === '+') { addB.add(o.j); changes.push({ t: '+', x: b.L[o.j] }); }
    }
    /* Annotated copies */
    const mark = async (it, L, set, col) => {
      const doc = await openPdfLib(it);
      for (const i of set) { const { p, l } = L[i]; const page = doc.getPage(p - 1); const F = visualFrame(page); vDrawRect(page, F, { x: l.x - 2, y: l.y - l.size * 0.95, w: (l.x2 - l.x) + 4, h: l.size * 1.3 }, { color: col, opacity: 0.35, blendMode: PDFLib.BlendMode.Multiply }); }
      return await savePdf(doc);
    };
    const outA = await mark(A, a.L, delA, PDFLib.rgb(0.95, 0.3, 0.3));
    const outB = await mark(B, b.L, addB, PDFLib.rgb(0.25, 0.8, 0.4));
    const list = h('ol', { class: 'difflist' });
    for (const c of changes.slice(0, 400)) list.append(h('li', { class: c.t === '+' ? 'add' : 'del' }, h('span', { class: 'diff-tag' }, c.t === '+' ? `Ditambah · baru hlm ${c.x.p}` : `Dihapus · lama hlm ${c.x.p}`), h('span', null, c.x.l.text)));
    const summary = changes.length ? `${delA.size} baris dihapus, ${addB.size} baris ditambah atau diubah.` : 'Tidak ada perbedaan teks di antara kedua dokumen.';
    return {
      title: changes.length ? `${changes.length} perbedaan ditemukan` : 'Kedua dokumen sama',
      note: summary + (changes.length ? ' File di bawah memberi sorotan merah pada versi lama dan hijau pada versi baru.' : ''),
      outputs: changes.length ? [{ name: baseName(A.name) + '_lama_ditandai.pdf', bytes: outA }, { name: baseName(B.name) + '_baru_ditandai.pdf', bytes: outB }] : [],
      zipName: 'perbandingan',
      preview: changes.length ? h('div', null, h('h3', null, 'Daftar perubahan'), list, changes.length > 400 ? h('p', { class: 'muted' }, `Menampilkan 400 dari ${changes.length} perubahan.`) : null) : null,
    };
  },
});
/* Line diff (LCS), with a cheaper path for very long documents */
function diffLines(A, B) {
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0; while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a = A.slice(s, A.length - e), b = B.slice(s, B.length - e);
  const ops = [];
  if (a.length * b.length > 9e6) {
    const setB = new Map(); b.forEach((x) => setB.set(x, (setB.get(x) || 0) + 1));
    const setA = new Map(); a.forEach((x) => setA.set(x, (setA.get(x) || 0) + 1));
    a.forEach((x, i) => { if (!setB.get(x)) ops.push({ t: '-', i: i + s }); });
    b.forEach((x, j) => { if (!setA.get(x)) ops.push({ t: '+', j: j + s }); });
    return ops;
  }
  const n = a.length, m = b.length;
  const L = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = a[i] === b[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) { ops.push({ t: '-', i: i + s }); i++; }
    else { ops.push({ t: '+', j: j + s }); j++; }
  }
  while (i < n) ops.push({ t: '-', i: s + i++ });
  while (j < m) ops.push({ t: '+', j: s + j++ });
  return ops;
}
