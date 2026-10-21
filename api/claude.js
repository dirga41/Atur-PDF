// Serverless function for Vercel: forwards the AI tools' requests to the Claude API.
// The API key stays on the server (environment variable ANTHROPIC_API_KEY).

export const config = { maxDuration: 60 };

const MODELS = {
  quick: process.env.ATUR_MODEL_QUICK || 'claude-haiku-5-5',
  default: process.env.ATUR_MODEL || 'claude-sonnet-5-5',
  complex: process.env.ATUR_MODEL_COMPLEX || 'claude-opus-5-5',
};
const MAX_PROMPT_CHARS = 260000;
const MAX_IMAGES = 5;

export default async function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return res.status(200).json({ enabled: !!key });
  if (req.method !== 'POST') return res.status(405).json({ code: 'bad_request', message: 'Gunakan POST.' });
  if (!key) return res.status(503).json({ code: 'unavailable', message: 'ANTHROPIC_API_KEY belum diatur di server.' });

  // Only accept calls from this site's own pages.
  const origin = req.headers.origin || '';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const allowed = (process.env.ATUR_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origin && !origin.endsWith('//' + host) && !allowed.includes(origin)) {
    return res.status(403).json({ code: 'not_granted', message: 'Asal permintaan tidak diizinkan.' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ code: 'bad_request', message: 'Pesan terakhir harus dari user.' });
  }
  const size = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  if (size > MAX_PROMPT_CHARS) return res.status(413).json({ code: 'bad_request', message: 'Teks terlalu panjang.' });

  const apiMessages = messages.map((m, i) => {
    const text = String(m.content || '');
    if (i !== messages.length - 1 || !images.length) return { role: m.role === 'assistant' ? 'assistant' : 'user', content: text };
    return {
      role: 'user',
      content: [
        ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })),
        { type: 'text', text },
      ],
    };
  });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODELS[body.tier] || MODELS.default, max_tokens: 8000, messages: apiMessages }),
    });
    const data = await r.json();
    if (!r.ok) {
      const code = r.status === 429 || r.status === 529 ? 'rate_limited' : 'unavailable';
      return res.status(r.status === 429 ? 429 : 502).json({ code, message: (data.error && data.error.message) || 'Claude API error' });
    }
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return res.status(200).json({ text, truncated: data.stop_reason === 'max_tokens' });
  } catch (e) {
    return res.status(502).json({ code: 'unavailable', message: 'Gagal menghubungi Claude API.' });
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
