# Atur PDF

33 alat PDF yang berjalan di peramban. Semua pemrosesan PDF terjadi di perangkat pengguna. Hanya fitur AI (OCR, Ringkas, Terjemahkan, dan opsi rapikan Markdown) yang mengirim teks atau gambar halaman ke Claude lewat `api/claude.js`.

## Struktur

```
index.html          halaman utama
js/                 kode aplikasi (claude-shim.js menghubungkan fitur AI ke /api/claude)
lib/                pdf.js, pdf-lib, JSZip, docx, PptxGenJS
api/claude.js       fungsi server untuk fitur AI (Vercel)
vercel.json         header cache dan tipe file
dev-server.mjs      server lokal untuk mencoba sebelum deploy
```

## Coba di komputer sendiri

Butuh Node.js 18 atau lebih baru.

```
node dev-server.mjs
```

Buka http://localhost:3000. Untuk mencoba fitur AI secara lokal:

```
ANTHROPIC_API_KEY=sk-ant-... node dev-server.mjs
```

Jangan buka `index.html` dengan klik dua kali (alamat `file://`). Peramban memblokir modul pdf.js dari alamat seperti itu, jadi halaman harus disajikan lewat server.

## Deploy ke Vercel (disarankan)

1. Unggah folder ini ke repositori GitHub baru.
2. Di vercel.com, pilih **Add New → Project**, lalu impor repositori tersebut.
3. Framework Preset: **Other**. Build Command dan Output Directory dikosongkan.
4. Klik **Deploy**. Semua alat non-AI langsung berfungsi.
5. Untuk mengaktifkan fitur AI: buka **Settings → Environment Variables**, tambahkan `ANTHROPIC_API_KEY` berisi kunci dari console.anthropic.com, lalu **Redeploy**.
6. Domain sendiri (misalnya `pdf.namamu.id`): **Settings → Domains**, lalu ikuti petunjuk DNS yang muncul.

Cara alternatif tanpa GitHub: `npm i -g vercel`, lalu jalankan `vercel` dari dalam folder ini.

### Variabel lingkungan (opsional)

| Nama | Fungsi |
| --- | --- |
| `ANTHROPIC_API_KEY` | Wajib untuk fitur AI. Tanpa ini, fitur AI tampil sebagai "belum aktif". |
| `ATUR_MODEL` | Model untuk tugas biasa. Bawaan: `claude-sonnet-5-5`. |
| `ATUR_MODEL_QUICK`, `ATUR_MODEL_COMPLEX` | Model untuk tingkat cepat dan kompleks. |
| `ATUR_ALLOWED_ORIGINS` | Domain lain yang boleh memanggil API, dipisah koma. |

### Biaya dan keamanan fitur AI

Setiap pemakaian fitur AI memakai kuota API milikmu. Endpoint menolak permintaan dari domain lain, tetapi siapa pun yang membuka situsmu tetap bisa memakai fitur AI. Sebelum situs dibuka untuk umum:

- Pasang batas pengeluaran bulanan di console.anthropic.com (Settings → Limits).
- Pertimbangkan Vercel Firewall atau rate limiting untuk `/api/claude`.
- Jika situs hanya untuk dipakai sendiri, aktifkan Vercel Deployment Protection.

## Hosting statis lain (Netlify, Cloudflare Pages, GitHub Pages)

Unggah semua file kecuali `api/`, `vercel.json`, `package.json`, dan `dev-server.mjs`. Semua alat non-AI berjalan normal, sedangkan fitur AI tampil sebagai "belum aktif". Untuk mengaktifkan AI di platform tersebut, `api/claude.js` perlu ditulis ulang ke format fungsi platform itu (Netlify Functions atau Cloudflare Workers) dengan rute `/api/claude`.

Pastikan server menyajikan `.mjs` sebagai `text/javascript` dan `.wasm` sebagai `application/wasm`. Netlify dan Cloudflare Pages sudah melakukannya secara otomatis.

## Lisensi pihak ketiga

pdf.js (Apache-2.0), pdf-lib (MIT), JSZip (MIT/GPLv3), docx (MIT), PptxGenJS (MIT). Font standar pdf.js memakai lisensi Foxit dan Liberation; lihat `lib/pdfjs/standard_fonts/`.
