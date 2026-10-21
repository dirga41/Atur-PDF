// Local preview: node dev-server.mjs  ->  http://localhost:3000
// Serves the static files and runs api/claude.js like Vercel does.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/claude.js';
const __filename = fileURLToPath(import.meta.url);
const root = path.dirname(__filename); // Ganti cara lama dengan ini
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/claude') {
    let raw = ''; for await (const c of req) raw += c;
    req.body = raw ? JSON.parse(raw) : {};
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    return handler(req, res);
  }
  const p = path.join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('content-type', types[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log('Atur PDF di http://localhost:' + (process.env.PORT || 3000)));
