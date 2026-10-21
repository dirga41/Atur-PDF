/* Atur PDF shell: tool registry, home grid, tool workspace runner, routing */
'use strict';

const CATS = [
  { id: 'organize', name: 'Susun PDF' },
  { id: 'optimize', name: 'Optimalkan' },
  { id: 'to', name: 'Konversi ke PDF' },
  { id: 'from', name: 'Konversi dari PDF' },
  { id: 'edit', name: 'Edit PDF' },
  { id: 'security', name: 'Keamanan' },
  { id: 'ai', name: 'Kecerdasan AI' },
];
const TOOLS = [];
function defineTool(t) { TOOLS.push(Object.assign({ accept: '.pdf,application/pdf', multiple: false, minFiles: t.noFiles ? 0 : 1, actionLabel: 'Proses' }, t)); }
/* PDF -> PDF tools offered as "continue with" after a single PDF result */
const CHAIN = ['merge', 'split', 'compress', 'organize', 'rotate', 'pagenumbers', 'watermark', 'protect', 'sign', 'edit', 'pdf2jpg', 'pdf2word', 'ocr', 'crop', 'redact', 'summarize'];

/* Small inline glyph set: page outline + a tool mark */
const MARKS = {
  merge: 'M8 9h4v6H8zM12 12h4',
  split: 'M12 7v10M8 10l-2 2 2 2M16 10l2 2-2 2',
  remove: 'M9 10l6 6M15 10l-6 6',
  extract: 'M12 16V9M9 12l3-3 3 3',
  organize: 'M8 9h3v3H8zM13 9h3v3h-3zM8 14h3v3H8zM13 14h3v3h-3z',
  scan: 'M8 9V8h2M16 8h-2M8 16v1h2M16 17h-2M7 12.5h10',
  compress: 'M12 7v4M10 9l2 2 2-2M12 17v-4M10 15l2-2 2 2',
  repair: 'M9 15l5-5M13 9l2 2M8 16l1-1',
  ocr: 'M8 10h8M8 13h6M8 16h7',
  jpg2pdf: 'M8 15l2.5-3 2 2 1.5-2 2 3zM10 10a1 1 0 1 0 0 .1',
  word2pdf: 'M8 9l1.3 6 1.4-4 1.3 4 1.3-6',
  ppt2pdf: 'M9 16V9h2.5a2 2 0 0 1 0 4H9',
  excel2pdf: 'M8.5 9l5 7M13.5 9l-5 7',
  html2pdf: 'M10 10l-2 2.5 2 2.5M14 10l2 2.5-2 2.5',
  pdf2jpg: 'M8 15l2.5-3 2 2 1.5-2 2 3z',
  pdf2word: 'M8 9l1.3 6 1.4-4 1.3 4 1.3-6',
  pdf2ppt: 'M9 16V9h2.5a2 2 0 0 1 0 4H9',
  pdf2excel: 'M8.5 9l5 7M13.5 9l-5 7',
  pdfa: 'M9 16l3-7 3 7M10.2 13.5h3.6',
  rotate: 'M15.5 11a3.5 3.5 0 1 0-1 3M15.5 8.5V11H13',
  pagenumbers: 'M10 15V9l-1.5 1M13 9h2.5l-2 6',
  watermark: 'M12 8.5c2 2.5 3 4 3 5.3a3 3 0 0 1-6 0c0-1.3 1-2.8 3-5.3z',
  crop: 'M10 7v8h8M7 10h8v8',
  edit: 'M9 16l1-3 5-5 2 2-5 5zM14 9l2 2',
  forms: 'M8 9h8v2.5H8zM8 13.5h8V16H8z',
  unlock: 'M9.5 12V10a2.5 2.5 0 0 1 5 0M9 12h6v4H9z',
  protect: 'M9.5 12v-1.5a2.5 2.5 0 0 1 5 0V12M9 12h6v4H9z',
  sign: 'M8 15c1.5-3 2.5-5 3.5-5s-1 4 .5 4 2-3 3-3M8 17h8',
  redact: 'M8 9h8M8 12h3M8 15h8M12.5 11h3.5v2h-3.5z',
  compare: 'M10 8v9M14 8v9M8 11h2M14 13h2',
  summarize: 'M8 9h8M8 12h8M8 15h4',
  translate: 'M8 9h5M10.5 9c0 3-1 5-2.5 6M9.5 12c1 1.5 2.3 2.5 3.5 3M13 16.5l2-5 2 5M13.6 15h2.8',
  markdown: 'M8 15V10l2 2 2-2v5M14.5 10v5M13 13.5l1.5 1.5 1.5-1.5',
};
function toolIcon(id) {
  return h('span', { class: 'ticon', 'aria-hidden': 'true', html:
    `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8.5L19 8v12.5H6z" opacity=".45"/><path d="M14.5 3.5V8H19" opacity=".45"/><path d="${MARKS[id] || ''}"/></svg>` });
}

/* ---------- Home ---------- */
let activeCat = 'all';
let query = '';
function renderHome() {
  const home = $('#home');
  const grid = $('#tool-grid');
  grid.innerHTML = '';
  const q = query.trim().toLowerCase();
  const list = TOOLS.filter((t) => (activeCat === 'all' || t.cat === activeCat) && (!q || (t.name + ' ' + t.desc + ' ' + (t.keywords || '')).toLowerCase().includes(q)));
  for (const t of list) {
    grid.append(h('a', { class: 'tcard', href: '#' + t.id, 'data-cat': t.cat },
      toolIcon(t.id),
      h('span', { class: 'tcard-name' }, t.name),
      h('span', { class: 'tcard-desc' }, t.desc),
      t.ai ? h('span', { class: 'chip ai' }, 'Pakai Claude') : null));
  }
  if (!list.length) grid.append(h('p', { class: 'empty' }, `Tidak ada alat yang cocok dengan “${query}”.`));
  $('#count').textContent = `${TOOLS.length} alat`;
  $$('#cats button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === activeCat)));
  home.hidden = false;
}
function buildCats() {
  const nav = $('#cats');
  nav.innerHTML = '';
  for (const c of [{ id: 'all', name: 'Semua' }, ...CATS]) {
    nav.append(h('button', { type: 'button', 'data-cat': c.id, 'aria-pressed': String(activeCat === c.id), onclick: () => { activeCat = c.id; try { localStorage.setItem('atur-cat', c.id); } catch {} renderHome(); } }, c.name));
  }
}

/* ---------- Tool runner ---------- */
let currentRun = null;
function openTool(id, seedItems) {
  const t = TOOLS.find((x) => x.id === id);
  if (!t) { showHome(); return; }
  $('#home').hidden = true;
  const view = $('#tool');
  view.hidden = false;
  view.innerHTML = '';
  view.dataset.cat = t.cat;
  const run = { tool: t, items: [], id: uid() };
  currentRun = run;
  const head = h('div', { class: 'tool-head' },
    h('a', { href: '#', class: 'back', onclick: (e) => { e.preventDefault(); location.hash = ''; } }, '← Semua alat'),
    h('div', { class: 'tool-title' }, toolIcon(t.id), h('div', null, h('h1', null, t.name), h('p', null, t.long || t.desc))));
  const body = h('div', { class: 'tool-body' });
  view.append(head, body);
  window.scrollTo({ top: 0 });

  const ctx = {
    tool: t, run, body,
    main: null, side: null, opts: {},
    get items() { return run.items; },
    progress: null,
    setBusy(b) { const btn = ctx.actionBtn; if (btn) { btn.disabled = b; btn.classList.toggle('busy', b); } },
    refreshAction() { if (ctx.actionBtn) ctx.actionBtn.disabled = run.items.length < t.minFiles || (t.ready && !t.ready(ctx)); },
  };

  if (t.noFiles) { workspace(); return; }
  if (seedItems && seedItems.length) { run.items.push(...seedItems); workspace(); return; }
  body.append(dropzone(t, async (files) => { await addFiles(files); workspace(); }));

  async function addFiles(files) {
    for (const f of files) {
      if (t.filter && !t.filter(f)) { toast(`${f.name} bukan format yang didukung alat ini.`, 'error'); continue; }
      run.items.push(await toItem(f));
      if (!t.multiple && run.items.length > 1) run.items.splice(0, run.items.length - 1);
    }
  }
  ctx.addFiles = addFiles;

  async function workspace() {
    if (currentRun !== run) return;
    if (!run.items.length && !t.noFiles) { openTool(t.id); return; }
    body.innerHTML = '';
    const main = h('div', { class: 'ws-main' });
    const side = h('aside', { class: 'ws-side', 'aria-label': 'Pengaturan' });
    const sideInner = h('div', { class: 'ws-side-inner' });
    side.append(sideInner);
    body.append(h('div', { class: 'ws' }, main, side));
    ctx.main = main; ctx.side = sideInner;
    ctx.rerender = workspace;
    const actionBtn = h('button', { type: 'button', class: 'btn primary block action', id: 'act-' + t.id }, t.actionLabel);
    ctx.actionBtn = actionBtn;
    try {
      if (t.setup) await t.setup(ctx);
      else fileList(ctx);
    } catch (e) { main.append(h('p', { class: 'err' }, e.message || String(e))); console.error(e); }
    if (currentRun !== run) return;
    if (t.run) {
      ctx.progress = progressUI(); ctx.progress.el.hidden = true;
      sideInner.append(h('div', { class: 'side-foot' }, ctx.progress.el, actionBtn));
      actionBtn.onclick = () => go();
      ctx.refreshAction();
    }
  }

  async function go() {
    ctx.setBusy(true);
    ctx.progress.el.hidden = false; ctx.progress.set(0, 'Memproses…');
    try {
      const res = await t.run(ctx);
      if (currentRun !== run) return;
      if (res && res.stay) { ctx.setBusy(false); ctx.progress.el.hidden = true; return; }
      showResult(ctx, Array.isArray(res) ? { outputs: res } : res);
    } catch (e) {
      console.error(e);
      toast(e && e.message ? e.message : String(e), 'error');
      ctx.setBusy(false);
      ctx.progress.el.hidden = true;
    }
  }
}

function dropzone(t, onFiles) {
  const input = h('input', { type: 'file', id: 'file-' + t.id, accept: t.accept, multiple: t.multiple, hidden: true, onchange: () => { if (input.files.length) onFiles(Array.from(input.files)); } });
  const cam = t.capture ? h('input', { type: 'file', id: 'cam-' + t.id, accept: 'image/*', capture: 'environment', hidden: true, onchange: () => { if (cam.files.length) onFiles(Array.from(cam.files)); } }) : null;
  const zone = h('div', { class: 'drop', tabindex: '-1' },
    h('div', { class: 'drop-art', 'aria-hidden': 'true' }, toolIcon(t.id)),
    h('button', { type: 'button', class: 'btn primary lg', onclick: () => input.click() }, t.pickLabel || (t.multiple ? 'Pilih file' : 'Pilih file')),
    cam ? h('button', { type: 'button', class: 'btn ghost', onclick: () => cam.click() }, 'Ambil foto dengan kamera') : null,
    h('p', { class: 'drop-hint' }, t.dropHint || (t.multiple ? 'atau tarik beberapa file ke sini' : 'atau tarik file ke sini')),
    input, cam);
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('hot'); }));
  zone.addEventListener('drop', (e) => { const fs = Array.from(e.dataTransfer.files || []); if (fs.length) onFiles(fs); });
  return h('div', { class: 'drop-wrap' }, zone, h('p', { class: 'privacy' }, t.ai ? 'File dibaca di peramban kamu. Teks atau gambar halaman dikirim ke Claude untuk diproses.' : 'File diproses di peramban kamu dan tidak diunggah ke server mana pun.'));
}

/* Default main area: list of files (reorderable when multiple) */
function fileList(ctx, { sortable = ctx.tool.multiple } = {}) {
  const t = ctx.tool;
  const list = h('div', { class: 'flist', role: 'list' });
  const draw = () => {
    list.innerHTML = '';
    ctx.items.forEach((it, i) => {
      const thumb = h('div', { class: 'fthumb' });
      fileThumb(it).then((u) => { if (u) thumb.append(h('img', { src: u, alt: '' })); else thumb.append(h('span', { class: 'fext' }, extOf(it.name).toUpperCase() || 'FILE')); });
      const pagesInfo = h('span', { class: 'fmeta-pages' });
      if (/pdf/.test(it.type) || extOf(it.name) === 'pdf') openPdfJs(it).then((d) => { it.pages = d.numPages; pagesInfo.textContent = `${d.numPages} hlm · `; }).catch(() => { pagesInfo.textContent = ''; });
      list.append(h('div', { class: 'fcard', role: 'listitem' },
        h('span', { class: 'fidx' }, String(i + 1)),
        thumb,
        h('div', { class: 'finfo' }, h('div', { class: 'fname', title: it.name }, it.name), h('div', { class: 'fmeta' }, pagesInfo, fmtBytes(it.size))),
        h('div', { class: 'factions' },
          sortable ? h('button', { type: 'button', class: 'mini', 'aria-label': `Naikkan ${it.name}`, disabled: i === 0, onclick: () => { const [m] = ctx.items.splice(i, 1); ctx.items.splice(i - 1, 0, m); draw(); } }, '↑') : null,
          sortable ? h('button', { type: 'button', class: 'mini', 'aria-label': `Turunkan ${it.name}`, disabled: i === ctx.items.length - 1, onclick: () => { const [m] = ctx.items.splice(i, 1); ctx.items.splice(i + 1, 0, m); draw(); } }, '↓') : null,
          h('button', { type: 'button', class: 'mini danger', 'aria-label': `Hapus ${it.name}`, onclick: () => { ctx.items.splice(i, 1); if (!ctx.items.length) ctx.rerender(); else { draw(); ctx.refreshAction(); } } }, '✕'))));
    });
  };
  draw();
  const more = h('input', { type: 'file', accept: t.accept, multiple: t.multiple, hidden: true, id: 'more-' + t.id, onchange: async () => { await ctx.addFiles(Array.from(more.files)); more.value = ''; draw(); ctx.refreshAction(); } });
  const addBtn = h('button', { type: 'button', class: 'btn ghost', onclick: () => more.click() }, t.multiple ? '+ Tambah file' : 'Ganti file');
  ctx.main.append(list, h('div', { class: 'row' }, addBtn, more));
  if (t.minFiles > 1) ctx.main.append(h('p', { class: 'hint' }, `Butuh minimal ${t.minFiles} file.`));
  ctx.drawList = draw;
  return list;
}
const _thumbs = new Map();
function fileThumb(it) {
  if (_thumbs.has(it.id)) return _thumbs.get(it.id);
  const p = (async () => {
    try {
      if (/^image\//.test(it.type)) return URL.createObjectURL(it.file);
      if (/pdf/.test(it.type) || extOf(it.name) === 'pdf') {
        const d = await openPdfJs(it);
        const c = await renderPage(await d.getPage(1), { maxDim: 180 });
        return c.toDataURL('image/jpeg', 0.8);
      }
    } catch {}
    return null;
  })();
  _thumbs.set(it.id, p);
  return p;
}

/* ---------- Result ---------- */
function showResult(ctx, res) {
  const { outputs = [], preview, note, title } = res;
  const t = ctx.tool;
  const body = ctx.body;
  body.innerHTML = '';
  const total = outputs.reduce((a, o) => a + o.bytes.length, 0);
  const list = h('div', { class: 'olist' });
  for (const o of outputs) {
    list.append(h('div', { class: 'ocard' },
      h('span', { class: 'fext' }, extOf(o.name).toUpperCase()),
      h('div', { class: 'finfo' }, h('div', { class: 'fname', title: o.name }, o.name), h('div', { class: 'fmeta' }, fmtBytes(o.bytes.length), o.info ? ' · ' + o.info : '')),
      h('button', { type: 'button', class: 'btn primary sm', onclick: () => saveFile(o) }, 'Unduh')));
  }
  const actions = h('div', { class: 'row wrap' });
  if (outputs.length > 1) {
    actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => saveFile(await zipOutputs(outputs, (res.zipName || baseName(ctx.items[0] ? ctx.items[0].name : 'aturpdf')) + '.zip')) }, `Unduh semua (.zip)`));
  }
  actions.append(h('button', { type: 'button', class: 'btn ghost', onclick: () => openTool(t.id) }, 'Mulai lagi'));
  const card = h('section', { class: 'result' },
    h('div', { class: 'result-head' },
      h('span', { class: 'stamp', 'aria-hidden': 'true' }, 'SELESAI'),
      h('div', null, h('h2', null, title || (outputs.length === 1 ? 'File siap diunduh' : outputs.length ? `${outputs.length} file siap diunduh` : 'Selesai')), outputs.length ? h('p', { class: 'muted' }, `Total ${fmtBytes(total)}`) : null)),
    note ? h('div', { class: 'note' }, note) : null,
    outputs.length ? list : null,
    actions,
    preview ? h('div', { class: 'preview' }, preview) : null);
  body.append(card);
  const single = outputs.length === 1 && extOf(outputs[0].name) === 'pdf' ? outputs[0] : null;
  if (single) {
    const chips = h('div', { class: 'chips' });
    for (const id of CHAIN) {
      if (id === t.id) continue;
      const tt = TOOLS.find((x) => x.id === id); if (!tt) continue;
      chips.append(h('button', { type: 'button', class: 'chip-btn', 'data-cat': tt.cat, onclick: () => { history.replaceState(null, '', '#' + id); openTool(id, [outputToItem(single)]); } }, tt.name));
    }
    body.append(h('section', { class: 'continue' }, h('h3', null, 'Lanjutkan dengan alat lain'), h('p', { class: 'muted' }, 'Hasil di atas langsung dipakai sebagai file masukan.'), chips));
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- Form helpers for option panels ---------- */
function field(label, control, hint) {
  const id = control.id || (control.id = 'f-' + uid());
  return h('div', { class: 'fieldrow' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}
function select(id, options, value) {
  const s = h('select', { id, class: 'field' }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  return s;
}
function segmented(id, options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup', id });
  wrap.value = value;
  const draw = () => {
    wrap.innerHTML = '';
    for (const [v, l, d] of options) {
      wrap.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === wrap.value), class: 'seg-btn', onclick: () => { wrap.value = v; draw(); onChange && onChange(v); } },
        h('span', { class: 'seg-l' }, l), d ? h('span', { class: 'seg-d' }, d) : null));
    }
  };
  draw();
  return wrap;
}
function checkbox(id, label, checked) {
  const c = h('input', { type: 'checkbox', id, checked });
  return h('label', { class: 'check', for: id }, c, h('span', null, label));
}
function numberInput(id, value, min, max, step = 1) { return h('input', { type: 'number', id, class: 'field', value, min, max, step }); }
function textInput(id, value, placeholder) { return h('input', { type: 'text', id, class: 'field', value: value || '', placeholder: placeholder || '' }); }
const val = (id) => { const e = document.getElementById(id); if (!e) return null; if (e.type === 'checkbox') return e.checked; if (e.classList.contains('seg')) return e.value; return e.value; };
const checked = (id) => { const e = document.getElementById(id); return !!(e && e.querySelector ? (e.type === 'checkbox' ? e.checked : (e.querySelector('input') || {}).checked) : false); };

/* ---------- Routing ---------- */
function showHome() {
  $('#tool').hidden = true; $('#tool').innerHTML = '';
  currentRun = null;
  renderHome();
}
function route() {
  const id = location.hash.replace(/^#/, '');
  if (id && TOOLS.some((t) => t.id === id)) openTool(id); else showHome();
}

function boot() {
  try { const c = localStorage.getItem('atur-cat'); if (c) activeCat = c; } catch {}
  buildCats();
  const s = $('#search');
  s.addEventListener('input', () => { query = s.value; if ($('#home').hidden) location.hash = ''; renderHome(); });
  window.addEventListener('hashchange', route);
  $('#brand').addEventListener('click', (e) => { e.preventDefault(); activeCat = 'all'; query = ''; s.value = ''; location.hash = ''; showHome(); });
  route();
  pdfjs().catch(() => toast('Mesin PDF gagal dimuat. Muat ulang halaman.', 'error'));
}
