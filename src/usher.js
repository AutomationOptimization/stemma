// Server-side proxy to the Modal-hosted model. Lives here (not in the browser) for two
// reasons: the endpoint sends no CORS headers, and the key must never reach a client.
// It scales to zero and answers 303 during a ~2min cold start, so every call is
// best-effort — the deterministic layer in drift.js always carries the reveal.

// The model slug the endpoint expects. The Modal deployment serves one model under the
// name 'usher'; any other OpenAI-compatible host (OpenRouter, together, a local vLLM)
// needs its own slug, so this is configurable.
const MODEL = env => env.USHER_MODEL || 'usher'

export async function warmUsher(env) {
  try { await fetch(env.USHER_BASE.replace(/\/v1$/, '') + '/health') } catch {}
}

async function warm(env) {
  try {
    const r = await fetch(env.USHER_BASE.replace(/\/v1$/, '') + '/health', { method: 'GET' })
    return r.ok
  } catch { return false }
}

export async function ushChat(env, messages, { maxTokens = 700, temperature = 0.1, retries = 8 } = {}) {
  if (!env.USHER_KEY) return null
  // Not every OpenAI-compatible provider accepts response_format. Ask for it, and drop it
  // for the rest of this call if the endpoint objects — looseJson already copes with a
  // model that fences or chats around its JSON, so this only costs strictness.
  let jsonMode = true
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(env.USHER_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.USHER_KEY}` },
        body: JSON.stringify({ model: MODEL(env), messages, max_tokens: maxTokens, temperature,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
      })
      // 303 == container cold-starting. Poke /health and back off.
      if (res.status === 303 || res.status === 503 || res.status === 429) {
        await warm(env)
        await new Promise(r => setTimeout(r, Math.min(12000, 2000 * (attempt + 1))))
        continue
      }
      const body = await res.text()
      if (!res.ok && jsonMode && /response_format|json_object|json mode/i.test(body)) {
        jsonMode = false
        continue   // same attempt's worth of work, without the unsupported field
      }
      if (!res.ok || /Missing request|expiry or cancellation/i.test(body)) {
        await new Promise(r => setTimeout(r, 900 * (attempt + 1)))
        continue
      }
      let j = null
      try { j = JSON.parse(body) } catch {
        await new Promise(r => setTimeout(r, 700 * (attempt + 1)))
        continue
      }
      const c = j?.choices?.[0]?.message?.content
      if (c == null) { await new Promise(r => setTimeout(r, 700 * (attempt + 1))); continue }
      return c
    } catch {
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  return null
}

// Bounded concurrency. The container serves 8 at a time, so firing a 9-player chain at it
// all at once puts the last call behind the retry backoff of the other eight.
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i) }
  }))
  return out
}

// The 7B is quantized and will sometimes fence its JSON or chat before it. Never trust it.
export function looseJson(raw) {
  if (!raw || typeof raw !== 'string') return null
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const first = Math.min(...['{', '['].map(c => { const i = s.indexOf(c); return i === -1 ? Infinity : i }))
  if (first !== Infinity) s = s.slice(first)
  const lastO = s.lastIndexOf('}'), lastA = s.lastIndexOf(']')
  const last = Math.max(lastO, lastA)
  if (last !== -1) s = s.slice(0, last + 1)
  s = s.replace(/,\s*([}\]])/g, '$1')
  try { return JSON.parse(s) } catch {}
  try { return JSON.parse(s.replace(/'/g, '"')) } catch {}
  return null
}

const clampArr = (a, n, len = 60) => (Array.isArray(a) ? a : []).slice(0, n)
  .map(x => String(typeof x === 'string' ? x : (x?.text ?? '')).slice(0, len)).filter(Boolean)

// One narration call for the whole reveal. Deterministic numbers stay authoritative;
// the model only supplies the human-readable read of what happened.
export async function narrateReveal(env, { original, final, chainSummary, fidelity }) {
  const sys = 'You analyse how a message mutated as it was retold person to person. ' +
    'Reply with ONE JSON object and nothing else. Keep every string short and concrete. ' +
    'Quote only words that actually appear in the messages given. Never invent details.'
  const user = `ORIGINAL MESSAGE:
"${original}"

FINAL MESSAGE after being retold ${chainSummary.hops} times:
"${final}"

WHAT EACH RETELLING DID (computed, trust this):
${chainSummary.lines}

Return exactly this JSON:
{"headline":"<punchy sentence a host reads aloud, max 20 words, specific to this message>",
 "exaggerated":["<short phrase that got blown up>"],
 "dropped":["<short phrase that was lost>"],
 "invented":["<short phrase that was made up>"],
 "why":"<one sentence on WHY this message drifted the way it did, max 25 words>"}
Arrays: max 4 items each, each item under 8 words. Use [] if none.`
  const raw = await ushChat(env, [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { maxTokens: 500, temperature: 0.15, retries: 8 })
  const j = looseJson(raw)
  if (!j) return null
  return {
    headline: String(j.headline || '').slice(0, 200),
    exaggerated: clampArr(j.exaggerated, 4),
    dropped: clampArr(j.dropped, 4),
    invented: clampArr(j.invented, 4),
    why: String(j.why || '').slice(0, 240),
  }
}

// Optional: generate a seed message worth mangling.
export async function seedMessage(env, topic) {
  const sys = 'You write short messages for a telephone game. Reply with ONE JSON object only.'
  const user = `Write one message for a game of telephone${topic ? ` about: ${topic}` : ''}.
It must be 2 sentences, 25-40 words, and contain: a specific number, a person's name, a place,
and one surprising detail. Everyday and concrete, not fantasy.
Return: {"message":"<the message>"}`
  const j = looseJson(await ushChat(env, [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { maxTokens: 200, temperature: 0.9, retries: 1 }))
  return j?.message ? String(j.message).slice(0, 400) : null
}

// ---------------------------------------------------------------------------
// AI as instrument and participant, not narrator.
// ---------------------------------------------------------------------------

// Decompose the seed into atomic propositions. These are the ribbons in the alluvial
// diagram — the units whose survival we actually track.
export async function decompose(env, message) {
  const sys = 'You break a message into atomic factual claims. Reply with ONE JSON object only.'
  const user = `MESSAGE: "${message}"

List each atomic claim separately. Each claim under 9 words. Max 7 claims.
salience = how memorable that detail is, 1 (incidental) to 5 (the vivid hook).
Return: {"props":[{"id":"p1","text":"...","salience":3}]}`
  const j = looseJson(await ushChat(env, [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { maxTokens: 400, temperature: 0 }))
  const props = Array.isArray(j?.props) ? j.props : []
  return props.slice(0, 7).map((p, i) => ({
    id: 'p' + (i + 1), text: String(p?.text || '').slice(0, 80),
    salience: Math.max(1, Math.min(5, Number(p?.salience) || 3)),
  })).filter(p => p.text && !/^(no |not |unspecified|none\b|there is no)/i.test(p.text))
}

// The entailment step: for one version of the message, what happened to each claim?
// This is an NLI-style judgement per proposition, which is what makes the ribbons honest.
export async function fates(env, props, version) {
  if (!props.length) return null
  const sys = 'You check which claims still appear in a retold message. Reply with ONE JSON object only.'
  const user = `CLAIMS:
${props.map(p => `${p.id}: ${p.text}`).join('\n')}

RETOLD MESSAGE: "${version}"

For EVERY claim id above, say what happened to it in the retold message:
"intact" = still there (paraphrase and synonyms still count as intact)
"weakened" = there but vaguer or less specific
"distorted" = there but changed to something different or exaggerated
"dropped" = gone
Also list content in the retold message that came from NO claim above.
Return: {"fates":[{"id":"p1","status":"intact"}],"invented":["..."]}
Include every claim id exactly once. Max 4 invented items.`
  const j = looseJson(await ushChat(env, [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { maxTokens: 500, temperature: 0 }))
  if (!j) return null
  const ok = new Set(['intact', 'weakened', 'distorted', 'dropped'])
  const got = new Map((Array.isArray(j.fates) ? j.fates : [])
    .map(f => [String(f?.id || ''), ok.has(f?.status) ? f.status : 'intact']))
  // The 7B drops ids; default a missing one to dropped rather than silently losing the ribbon.
  return {
    fates: props.map(p => ({ id: p.id, status: got.get(p.id) || 'dropped' })),
    invented: (Array.isArray(j.invented) ? j.invented : []).slice(0, 4)
      .map(x => String(typeof x === 'string' ? x : x?.text || '').slice(0, 60)).filter(Boolean),
  }
}

// AI confederates: planted participants with a Bartlett bias, so a group of two can still
// run a long chain — and so drift can be watched under a controlled distortion.
export const PERSONAS = {
  leveler:     { name: 'The Summarizer', bias: 'leveling',      temp: 0.6,
    rule: 'You compress. Keep only the gist. Drop specifics, names and numbers. Be noticeably SHORTER.' },
  sharpener:   { name: 'The Storyteller', bias: 'sharpening',   temp: 0.9,
    rule: 'You seize the most vivid detail and make it bigger. Round numbers upward, intensify every adjective.' },
  assimilator: { name: 'The Rationalizer', bias: 'assimilation', temp: 0.85,
    rule: 'You make it make sense. Reshape odd details into the familiar, expected version of this kind of story.' },
  faithful:    { name: 'The Careful One', bias: 'faithful',      temp: 0.35,
    rule: 'You try hard to pass it on accurately, but you are recalling it, so small wording changes creep in.' },
}

export async function confederate(env, personaKey, handed) {
  const p = PERSONAS[personaKey] || PERSONAS.faithful
  const sys = `You are a person in a game of telephone. Someone just told you something and you are ` +
    `telling the next person. ${p.rule}\n` +
    `Retell it DIRECTLY, as speech. Never say "the message" or "they said that". ` +
    `One or two sentences. Reply with ONE JSON object only.`
  const user = `You were told: "${handed}"\n\nWhat do you tell the next person?\nReturn: {"retelling":"..."}`
  const j = looseJson(await ushChat(env, [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { maxTokens: 250, temperature: p.temp, retries: 6 }))
  let t = String(j?.retelling || '').trim().slice(0, 400)
  // It occasionally narrates instead of retelling; strip the tell rather than failing the turn.
  t = t.replace(/^(?:the message (?:is|says|was)|they said|apparently,?)\s*/i, '')
  return t || null
}

// Abductive attribution: why THIS change happened, in cognitive terms — not a restatement.
export async function abduce(env, before, after, change) {
  const sys = 'You explain why memory distorts messages. Reply with ONE JSON object only.'
  const user = `BEFORE: "${before}"
AFTER: "${after}"
THE CHANGE: ${change}

Why did a person retelling this make that change? Give the cognitive reason, not a restatement.
mechanism must be one of: compression, vividness, plausibility, numeric_rounding, schema_fit, social_smoothing
Return: {"mechanism":"numeric_rounding","why":"<max 18 words>","confidence":70}`
  const j = looseJson(await ushChat(env, [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { maxTokens: 200, temperature: 0.3, retries: 4 }))
  if (!j?.why) return null
  return { mechanism: String(j.mechanism || '').slice(0, 30), why: String(j.why).slice(0, 160),
    confidence: Math.max(0, Math.min(100, Number(j.confidence) || 50)) }
}
