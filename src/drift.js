// Deterministic serial-reproduction analysis.
// Bartlett's taxonomy: leveling (loss), sharpening (exaggeration), assimilation (warp to
// the familiar). Plus invention. Everything here runs with zero model calls so a cold GPU
// never costs the group their reveal.

const STOP = new Set(('a an the of to in on at for with and or but is are was were be been being ' +
  'that this these those it its as by from he she they them his her their i you we us our your my ' +
  'me him not no nor do does did done have has had will would can could should may might must if ' +
  'then than so such about into over under out up down there here what which who whom whose when ' +
  'where why how all any both each few more most other some only own same too very just also').split(' '))

// Intensity ladders. Position = rung. Moving up a ladder is sharpening, down is leveling.
const LADDERS = [
  ['ok', 'fine', 'good', 'great', 'amazing', 'incredible', 'unbelievable'],
  ['bad', 'poor', 'awful', 'terrible', 'horrific', 'catastrophic'],
  ['some', 'several', 'many', 'most', 'nearly all', 'all', 'every'],
  ['a few', 'a bunch', 'dozens', 'hundreds', 'thousands'],
  ['said', 'told', 'claimed', 'insisted', 'swore', 'screamed'],
  ['asked', 'urged', 'demanded', 'ordered'],
  ['liked', 'loved', 'adored', 'worshipped'],
  ['annoyed', 'angry', 'furious', 'enraged', 'livid'],
  ['sad', 'upset', 'devastated', 'destroyed'],
  ['small', 'tiny', 'minuscule'],
  ['big', 'huge', 'enormous', 'massive', 'gigantic'],
  ['fast', 'quick', 'rapid', 'blazing', 'instant'],
  ['maybe', 'probably', 'definitely', 'certainly', 'absolutely'],
  ['sometimes', 'often', 'usually', 'always'],
  ['a little', 'somewhat', 'quite', 'very', 'extremely', 'insanely'],
  ['warm', 'hot', 'boiling', 'scorching'],
  ['worried', 'scared', 'terrified', 'petrified'],
]
const LADDER_INDEX = (() => {
  const m = new Map()
  LADDERS.forEach((l, li) => l.forEach((w, wi) => m.set(w, { ladder: li, rung: wi, len: l.length })))
  return m
})()

const NEGATORS = new Set(['not', "n't", 'no', 'never', 'none', 'nobody', 'nothing', 'nowhere',
  'neither', 'nor', 'cannot', 'cant', 'wont', 'didnt', 'doesnt', 'isnt', 'wasnt', 'arent', 'werent',
  'shouldnt', 'wouldnt', 'couldnt', 'hardly', 'barely', 'scarcely', 'without'])

const HEDGES = new Set(['maybe', 'perhaps', 'possibly', 'apparently', 'supposedly', 'allegedly',
  'reportedly', 'seemingly', 'probably', 'might', 'could', 'sort', 'kind', 'somewhat', 'think', 'guess'])

const NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1e6,
}

export function tokenize(text) {
  return String(text || '').toLowerCase().replace(/[‘’]/g, "'")
    .match(/[a-z0-9]+(?:'[a-z]+)?/g) || []
}
// Keeps original casing + offsets, for diff rendering.
export function tokenizeRich(text) {
  const out = []
  const re = /[A-Za-z0-9]+(?:['’][A-Za-z]+)?|[^\sA-Za-z0-9]+/g
  let m
  while ((m = re.exec(String(text || '')))) {
    out.push({ raw: m[0], norm: m[0].toLowerCase().replace(/[‘’]/g, "'"), i: m.index,
      word: /[A-Za-z0-9]/.test(m[0]) })
  }
  return out
}
const content = ts => ts.filter(t => !STOP.has(t) && (t.length > 1 || /\d/.test(t)))
// "7" and "seven" are the same claim; without this a digit->word rewrite reads as invention.
const canon = t => (t in NUM_WORDS ? 'num:' + NUM_WORDS[t] : (/^\d+$/.test(t) ? 'num:' + parseInt(t, 10) : t))
const canonSet = ts => new Set(ts.map(canon))

// ---- similarity -------------------------------------------------------------
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b)
  if (!A.size && !B.size) return 1
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}
function trigrams(s) {
  const t = ' ' + String(s || '').toLowerCase().replace(/\s+/g, ' ').trim() + ' '
  const g = new Map()
  for (let i = 0; i + 3 <= t.length; i++) { const k = t.slice(i, i + 3); g.set(k, (g.get(k) || 0) + 1) }
  return g
}
function cosine(ga, gb) {
  let dot = 0, na = 0, nb = 0
  for (const [k, v] of ga) { na += v * v; const w = gb.get(k); if (w) dot += v * w }
  for (const v of gb.values()) nb += v * v
  return na && nb ? dot / Math.sqrt(na * nb) : (na === nb ? 1 : 0)
}
function levenshtein(a, b) {
  a = String(a || ''); b = String(b || '')
  if (a === b) return 0
  if (!a.length || !b.length) return Math.max(a.length, b.length)
  if (a.length > 4000 || b.length > 4000) return Math.abs(a.length - b.length)
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

// Blended fidelity. Trigram cosine carries the most weight: it degrades smoothly on the
// short texts this game produces, where Jaccard is jumpy and raw edit distance over-punishes
// harmless rewording.
export function similarity(a, b) {
  const ta = tokenize(a), tb = tokenize(b)
  const ca = content(ta), cb = content(tb)
  const jac = jaccard(ta, tb)
  const cjac = jaccard(ca.length ? ca : ta, cb.length ? cb : tb)
  const cos = cosine(trigrams(a), trigrams(b))
  const maxLen = Math.max(String(a || '').length, String(b || '').length) || 1
  const lev = 1 - Math.min(1, levenshtein(a, b) / maxLen)
  const score = 0.45 * cos + 0.25 * cjac + 0.15 * jac + 0.15 * lev
  return { fidelity: Math.round(Math.max(0, Math.min(1, score)) * 100), cos, jac, cjac, lev }
}

// ---- word-level diff (LCS) --------------------------------------------------
export function diffWords(aText, bText) {
  const A = tokenizeRich(aText), B = tokenizeRich(bText)
  const n = A.length, m = B.length
  // Guard: LCS is O(n*m); these are 1-4 sentence messages, but a paste-bomb shouldn't wedge the DO.
  if (n * m > 400000) {
    return [...A.map(t => ({ raw: t.raw, op: 'del' })), ...B.map(t => ({ raw: t.raw, op: 'add' }))]
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i].norm === B[j].norm ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i].norm === B[j].norm) { out.push({ raw: B[j].raw, op: 'same' }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ raw: A[i].raw, op: 'del' }); i++ }
    else { out.push({ raw: B[j].raw, op: 'add' }); j++ }
  }
  while (i < n) out.push({ raw: A[i++].raw, op: 'del' })
  while (j < m) out.push({ raw: B[j++].raw, op: 'add' })
  return out
}

// ---- signal detectors -------------------------------------------------------
function numbersIn(text) {
  const out = []
  const toks = tokenize(text)
  toks.forEach(t => {
    if (t === 'one') return // pronoun far more often than a count
    if (/^\d+$/.test(t)) out.push({ tok: t, val: parseInt(t, 10) })
    else if (t in NUM_WORDS) out.push({ tok: t, val: NUM_WORDS[t] })
  })
  return out
}
function properNouns(text) {
  const out = new Set()
  const words = String(text || '').match(/[A-Za-z][A-Za-z'’-]+/g) || []
  const sentStarts = new Set()
  let idx = 0
  String(text || '').split(/(?<=[.!?])\s+/).forEach(s => {
    const w = (s.match(/[A-Za-z][A-Za-z'-]+/) || [])[0]
    if (w) sentStarts.add(w)
    idx++
  })
  words.forEach((w, k) => {
    if (/^[A-Z]/.test(w) && w.length > 1) {
      // A capitalized word that also opens a sentence is ambiguous; keep it only if it
      // recurs mid-sentence somewhere, which real names usually do.
      if (k === 0 && sentStarts.has(w)) return
      if (!STOP.has(w.toLowerCase())) out.add(w)
    }
  })
  return out
}
function countIn(toks, set) { return toks.reduce((n, t) => n + (set.has(t) ? 1 : 0), 0) }

function intensityShift(aToks, bToks) {
  const rungs = toks => {
    const found = []
    for (let i = 0; i < toks.length; i++) {
      const two = toks[i] + ' ' + (toks[i + 1] || '')
      if (LADDER_INDEX.has(two)) { found.push({ w: two, ...LADDER_INDEX.get(two) }); i++; continue }
      if (LADDER_INDEX.has(toks[i])) found.push({ w: toks[i], ...LADDER_INDEX.get(toks[i]) })
    }
    return found
  }
  const ra = rungs(aToks), rb = rungs(bToks)
  const events = []
  const byLadder = arr => arr.reduce((m, r) => { (m[r.ladder] ||= []).push(r); return m }, {})
  const ma = byLadder(ra), mb = byLadder(rb)
  for (const L of new Set([...Object.keys(ma), ...Object.keys(mb)])) {
    const xa = ma[L] || [], xb = mb[L] || []
    if (!xa.length || !xb.length) continue
    const pa = Math.max(...xa.map(r => r.rung / (r.len - 1 || 1)))
    const pb = Math.max(...xb.map(r => r.rung / (r.len - 1 || 1)))
    if (Math.abs(pb - pa) > 0.001) {
      const from = xa.reduce((x, y) => (y.rung > x.rung ? y : x))
      const to = xb.reduce((x, y) => (y.rung > x.rung ? y : x))
      events.push({ from: from.w, to: to.w, up: pb > pa, delta: Math.abs(pb - pa) })
    }
  }
  return events
}

// Per-hop analysis: what did this one person do to the message they were handed?
export function analyzeHop(prev, next, original) {
  const pa = tokenize(prev), pb = tokenize(next)
  const ca = content(pa), cb = content(pb)
  const co = content(tokenize(original ?? prev))
  const sim = similarity(prev, next)

  const setA = canonSet(ca), setB = canonSet(cb), setO = canonSet(co)
  const dropped = [...new Set(ca)].filter(w => !setB.has(canon(w)))
  const added = [...new Set(cb)].filter(w => !setA.has(canon(w)))
  // Invented = new here AND never in the original. Distinguishes fabrication from a
  // word that merely resurfaced.
  const invented = added.filter(w => !setO.has(canon(w)))

  const lenRatio = pa.length ? pb.length / pa.length : 1
  const nA = numbersIn(prev), nB = numbersIn(next)
  const numChanged = []
  const bVals = nB.map(x => x.val)
  nA.forEach(x => { if (!bVals.includes(x.val)) {
    const near = nB.find(y => !nA.some(z => z.val === y.val))
    numChanged.push({ from: x.tok, to: near ? near.tok : null })
  } })
  nB.forEach(y => { if (!nA.some(x => x.val === y.val) && !numChanged.some(c => c.to === y.tok)) {
    numChanged.push({ from: null, to: y.tok })
  } })

  const propA = properNouns(prev), propB = properNouns(next)
  const namesLost = [...propA].filter(w => !propB.has(w))
  const namesGained = [...propB].filter(w => !propA.has(w))

  const negDelta = countIn(pb, NEGATORS) - countIn(pa, NEGATORS)
  const hedgeDelta = countIn(pb, HEDGES) - countIn(pa, HEDGES)
  const intensity = intensityShift(pa, pb)

  const ops = []
  const push = (type, label, weight, detail) => ops.push({ type, label, weight, ...detail })

  if (lenRatio < 0.72 || dropped.length > Math.max(1, ca.length * 0.28)) {
    push('leveling', dropped.length ? `dropped: ${dropped.slice(0, 4).join(', ')}` : 'message flattened',
      Math.min(1, (1 - lenRatio) + dropped.length / Math.max(4, ca.length)), { items: dropped.slice(0, 8) })
  }
  intensity.forEach(e => {
    if (e.up) push('sharpening', `"${e.from}" → "${e.to}"`, 0.4 + e.delta * 0.6, { from: e.from, to: e.to })
    else push('leveling', `"${e.from}" → "${e.to}"`, 0.3 + e.delta * 0.5, { from: e.from, to: e.to })
  })
  numChanged.forEach(c => {
    if (c.from && c.to) push('sharpening', `number ${c.from} → ${c.to}`, 0.75, c)
    else if (c.from) push('leveling', `number ${c.from} vanished`, 0.55, c)
    else push('invention', `number ${c.to} appeared`, 0.7, c)
  })
  namesLost.forEach(n => push('leveling', `lost the name "${n}"`, 0.5, { name: n }))
  namesGained.forEach(n => push('invention', `named "${n}" out of nowhere`, 0.75, { name: n }))
  if (negDelta !== 0) push('assimilation', negDelta > 0 ? 'a negation appeared' : 'a negation was dropped', 0.85, { negDelta })
  if (hedgeDelta < 0) push('sharpening', 'hedging removed — stated as fact', 0.5, { hedgeDelta })
  if (hedgeDelta > 0) push('leveling', 'hedging added — confidence lost', 0.35, { hedgeDelta })
  if (invented.length) push('invention', `new content: ${invented.slice(0, 4).join(', ')}`,
    Math.min(1, 0.35 + invented.length * 0.15), { items: invented.slice(0, 8) })
  if (lenRatio > 1.45) push('sharpening', 'message inflated', Math.min(1, (lenRatio - 1) * 0.6), { lenRatio })

  const novelty = cb.length ? invented.length / cb.length : 0
  const severity = Math.round(Math.min(100, (100 - sim.fidelity) * 0.6 +
    ops.reduce((s, o) => s + o.weight, 0) * 9 + novelty * 30))

  return {
    fidelity: sim.fidelity, severity, lenRatio: +lenRatio.toFixed(2), novelty: +novelty.toFixed(3),
    dropped, added, invented, numChanged, namesLost, namesGained, negDelta, hedgeDelta,
    ops: ops.sort((x, y) => y.weight - x.weight).slice(0, 8),
    diff: diffWords(prev, next),
  }
}

// Whole-chain rollup: per-hop drift plus the decay curve of each version against the original.
export function analyzeChain(versions) {
  const texts = versions.map(v => v.text)
  const original = texts[0] ?? ''
  const hops = []
  for (let i = 1; i < texts.length; i++) {
    hops.push({ index: i, from: versions[i - 1], to: versions[i], ...analyzeHop(texts[i - 1], texts[i], original) })
  }
  const curve = texts.map((t, i) => ({ index: i, fidelity: i === 0 ? 100 : similarity(original, t).fidelity }))
  const final = texts[texts.length - 1] ?? ''
  const endToEnd = similarity(original, final)

  const co = content(tokenize(original)), cf = content(tokenize(final))
  const so = canonSet(co), sf = canonSet(cf)
  const survived = [...new Set(co)].filter(w => sf.has(canon(w)))
  const lost = [...new Set(co)].filter(w => !sf.has(canon(w)))
  const invented = [...new Set(cf)].filter(w => !so.has(canon(w)))

  const biggest = hops.length ? hops.reduce((a, b) => (b.severity > a.severity ? b : a)) : null
  const totals = { leveling: 0, sharpening: 0, assimilation: 0, invention: 0 }
  hops.forEach(h => h.ops.forEach(o => { totals[o.type] = (totals[o.type] || 0) + o.weight }))

  return {
    hops, curve, survived, lost, invented, totals,
    fidelity: endToEnd.fidelity,
    biggestMutation: biggest && { index: biggest.index, author: biggest.to.author, severity: biggest.severity,
      headline: biggest.ops[0]?.label || 'rewrote it wholesale' },
    finalDiff: diffWords(original, final),
  }
}
