// Cloudflare Pages Function: POST /api/plant  (plant / seedling photo -> structured care info)
// Settings (Cloudflare project, Variables and secrets): GEMINI_API_KEY (secret), GEMINI_MODEL (optional), GEMINI_FALLBACK_MODEL (optional)
//
// Request JSON:
//   { image: base64 jpeg (no data: prefix),
//     prevImage?: base64 jpeg of an OLDER photo of the same plant/batch (for before/after comparison),
//     mode?: "single" | "batch", name?: string (what the user calls it, trusted over your guess),
//     location?: "indoor" | "balcony", lang?: "en" | "zh" | "th", daysSinceWatered?: number }
// Response 200:
//   { species, confidence, stage, count, health, issues[], advice[], waterEveryDays, petSafety, petNote,
//     lowLight, change, changeNote }
// Response error: { error: string }

const LANG = { en: 'English', zh: 'Traditional Chinese', th: 'Thai' };

const SYSTEM = [
  'You are an experienced home grower who helps people keep plants, seedlings and regrown kitchen scraps alive in Bangkok, Thailand',
  '(hot, humid, strong sun on balconies, a rainy season from about May to October, little real winter).',
  'You look at a photo and answer ONLY with a JSON object. Be honest about uncertainty: if you are not sure of the species say so and lower confidence.',
  'Very young seedlings and cut vegetable bases are hard to identify from a photo; when the user gave a name, trust it and do not argue.',
  'Typical problems to look for: overwatering and root rot (yellowing, mushy stems, fungus gnats), underwatering (dry cracked soil, wilting), too little light (pale, stretched leggy stems),',
  'sun scorch (brown crispy patches), damping-off in seedlings (stems pinched and collapsing), seed husks stuck on seed leaves, empty cells that did not sprout, crowding.',
  'If the photo is dark, blurry or flash-lit so colors cannot be trusted, set lowLight true and say colors may be unreliable.',
  'JSON keys: ',
  'species (short common name, or "unknown"), ',
  'confidence (0 to 1), ',
  'stage (one of: seed, sprouting, seedling, young, mature, flowering, unknown), ',
  'count (integer number of separate plants visible, or null for a single pot with one plant), ',
  'health (one of: good, watch, bad), ',
  'issues (array of up to 4 short strings, empty if none), ',
  'advice (array of up to 3 short, concrete, actionable strings), ',
  'waterEveryDays (integer 1-30: sensible watering interval for this plant in this climate and location), ',
  'petSafety (one of: safe, toxic, unknown: whether it is safe for cats and dogs if chewed), ',
  'petNote (one short sentence, empty if unknown), ',
  'lowLight (boolean), ',
  'change (only when a previous photo is given: one of better, same, worse; otherwise null), ',
  'changeNote (one short sentence describing what changed since the previous photo, or empty).',
  'Never invent precision: counts and heights are estimates.'
].join(' ');

export async function onRequestPost({ request, env }) {
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!key) return reply(500, { error: 'GEMINI_API_KEY is not set in Cloudflare.' });

  let body;
  try { body = await request.json(); } catch (e) { return reply(400, { error: 'Bad request.' }); }
  const ok = (s) => typeof s === 'string' && s.length > 0 && s.length <= 3000000;
  if (!ok(body.image)) return reply(400, { error: 'Send a photo (jpeg, base64, under about 2 MB).' });
  if (body.prevImage != null && !ok(body.prevImage)) return reply(400, { error: 'Previous photo is invalid or too large.' });

  const lang = LANG[body.lang] ? body.lang : 'en';
  const mode = body.mode === 'batch' ? 'batch' : 'single';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
  const where = body.location === 'balcony' ? 'balcony (outdoor, strong sun and rain exposure)' : 'indoors';
  const since = Number.isFinite(Number(body.daysSinceWatered)) ? Math.max(0, Math.round(Number(body.daysSinceWatered))) : null;

  const parts = [];
  if (body.prevImage) {
    parts.push({ text: 'PREVIOUS photo (older):' });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: body.prevImage } });
    parts.push({ text: 'CURRENT photo (newer):' });
  }
  parts.push({ inline_data: { mime_type: 'image/jpeg', data: body.image } });
  parts.push({ text:
    'Subject: ' + (mode === 'batch' ? 'a BATCH of several small plants/seedlings (a tray, box or group): count them and judge the batch as a whole.' : 'a single plant.') +
    (name ? ' The user calls it: "' + name + '".' : '') +
    ' Location: ' + where + '.' +
    (since !== null ? ' It was last watered ' + since + ' day(s) ago.' : '') +
    (body.prevImage ? ' Compare CURRENT with PREVIOUS and fill change and changeNote.' : ' There is no previous photo: set change to null and changeNote to an empty string.') +
    ' Write species, issues, advice, petNote and changeNote in ' + LANG[lang] + '.' });

  // tried in order; the last one is an older, usually less busy model
  const models = [env.GEMINI_MODEL || 'gemini-3.5-flash-lite', env.GEMINI_FALLBACK_MODEL || 'gemini-3.8-flash', env.GEMINI_FALLBACK_MODEL2 || 'gemini-2.5-flash-lite']
    .filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);
  const queue = models.length > 1 ? models : [models[0], models[0]];
  const started = Date.now();
  const deadline = started + 50000; // Pages Functions can wait this long; the phone shows a spinner meanwhile
  const notes = [];
  let lowThink = true; // ask the model to think less so it answers faster

  for (let i = 0; i < queue.length; i++) {
    const left = deadline - Date.now();
    if (left < 3000) break;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${queue[i]}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(i < queue.length - 1 ? Math.min(left, 18000) : left),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ parts }],
          generationConfig: Object.assign({ responseMimeType: 'application/json', temperature: 0.2 },
            lowThink ? { thinkingConfig: { thinkingLevel: 'low' } } : {})
        })
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = (data.error && data.error.message) || 'request failed';
        console.error('Gemini error', queue[i], res.status, msg);
        notes.push(queue[i] + ' (' + res.status + '): ' + String(msg).slice(0, 90));
        if (res.status === 400 && lowThink && /think/i.test(msg)) { lowThink = false; i--; continue; } // model does not accept the setting: retry without it
        if (res.status === 429 || res.status === 503 || res.status === 500) { await sleep(700); continue; }
        break;
      }
      const cand = data.candidates && data.candidates[0];
      const text = cand && cand.content && cand.content.parts
        ? cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('') : '';
      if (!text) { notes.push(queue[i] + ': no text'); continue; }
      let o;
      try { o = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
      catch (e) { notes.push(queue[i] + ': unreadable answer'); continue; }
      return reply(200, clean(o, mode, !!body.prevImage));
    } catch (e) {
      console.error('plant failed', queue[i], e && e.name, e && e.message);
      notes.push(queue[i] + ': ' + (e && e.name === 'TimeoutError' ? 'no answer in ' + Math.round((Date.now() - started) / 1000) + 's' : String((e && e.message) || e).slice(0, 100)));
    }
  }
  return reply(502, { error: notes.join(' | ') || 'Gemini is busy. Try again in a moment.' });
}

export async function onRequest() { return reply(405, { error: 'Use POST.' }); }

function oneOf(v, list, d) { return list.includes(v) ? v : d; }
function strs(a, n) { return (Array.isArray(a) ? a : []).map((x) => String(x).slice(0, 160)).filter(Boolean).slice(0, n); }
function clean(o, mode, hasPrev) {
  const cnt = Math.round(Number(o.count));
  const wd = Math.round(Number(o.waterEveryDays));
  return {
    species: String(o.species || 'unknown').slice(0, 60),
    confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)),
    stage: oneOf(o.stage, ['seed', 'sprouting', 'seedling', 'young', 'mature', 'flowering', 'unknown'], 'unknown'),
    count: mode === 'batch' && cnt > 0 && cnt < 500 ? cnt : null,
    health: oneOf(o.health, ['good', 'watch', 'bad'], 'watch'),
    issues: strs(o.issues, 4),
    advice: strs(o.advice, 3),
    waterEveryDays: wd >= 1 && wd <= 30 ? wd : 3,
    petSafety: oneOf(o.petSafety, ['safe', 'toxic', 'unknown'], 'unknown'),
    petNote: String(o.petNote || '').slice(0, 160),
    lowLight: o.lowLight === true,
    change: hasPrev ? oneOf(o.change, ['better', 'same', 'worse'], 'same') : null,
    changeNote: hasPrev ? String(o.changeNote || '').slice(0, 200) : ''
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function reply(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
