/* Outside claude.ai there is no window.claude. This shim gives the AI tools the same
   interface, backed by the site's own /api/claude function. If the server has no API key,
   use('sample') resolves null and the AI tools show their "not active" message. */
(function () {
  'use strict';
  if (window.claude && window.claude.use) return;

  var enabledP = null;
  function enabled() {
    if (!enabledP) {
      enabledP = fetch('/api/claude', { method: 'GET' })
        .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
        .then(function (j) { return !!j.enabled; })
        .catch(function () { return false; });
    }
    return enabledP;
  }
  function toB64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1]); };
      r.onerror = function () { rej(new Error('Gambar tidak bisa dibaca.')); };
      r.readAsDataURL(blob);
    });
  }
  async function call(input, o) {
    o = o || {};
    var list = !o.images ? [] : o.images instanceof Blob ? [o.images] : Array.from(o.images);
    var images = await Promise.all(list.map(async function (b) { return { media_type: b.type || 'image/jpeg', data: await toB64(b) }; }));
    var messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    var r;
    try {
      r = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: messages, images: images, tier: o.modelTier || 'default' }),
        signal: o.signal,
      });
    } catch (e) {
      throw { code: 'unavailable', message: 'Server AI tidak bisa dihubungi.' };
    }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw { code: j.code || (r.status === 429 ? 'rate_limited' : 'unavailable'), message: j.message || 'HTTP ' + r.status };
    if (o.onText) o.onText({ text: j.text, delta: j.text });
    return { text: j.text, truncated: !!j.truncated, modelTierApplied: o.modelTier || 'default' };
  }
  function sample(input, o) { return call(input, o); }
  sample.json = async function (input, o) {
    var prompt = typeof input === 'string' ? input + '\n\nRespond with valid JSON only, without code fences.' : input;
    var r = await call(prompt, o);
    var t = r.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    try { return JSON.parse(t); } catch (e) {
      var m = t.match(/[\[{][\s\S]*[\]}]/);
      if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fall through */ } }
      throw { code: 'invalid_json', message: 'Jawaban bukan JSON yang valid.', text: r.text };
    }
  };
  sample.limits = async function () {
    return { maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 4000000, mediaTypes: ['image/jpeg', 'image/png', 'image/webp'] } };
  };
  window.claude = {
    use: async function (name) {
      if (name === 'sample') return (await enabled()) ? sample : null;
      return null; /* downloads fall back to a normal browser download */
    },
  };
})();
