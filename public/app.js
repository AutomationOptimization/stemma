const $ = s => document.querySelector(s)
const view = $('#view')
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const LS = { get: k => { try { return localStorage.getItem(k) } catch { return null } },
             set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } }

let ws = null, S = null, myId = LS.get('tel.pid') || '', myName = LS.get('tel.name') || '', room = ''
let generating = false

function toast(m) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = m
  document.body.appendChild(d); setTimeout(() => d.remove(), 3400)
}
const send = o => { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(o)) } catch {} }

// ---------- routing ----------
function roomFromUrl() { return (location.hash.match(/^#\/r\/([A-Z0-9]{3,8})/i) || [])[1]?.toUpperCase() || '' }

async function boot() {
  room = roomFromUrl()
  if (!room) return renderHome()
  if (!myName) return renderNameGate()
  connect()
}
window.addEventListener('hashchange', () => location.reload())

function connect() {
  $('#codebox').classList.remove('hide'); $('#code').textContent = room
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws/${room}`)
  ws.onopen = () => send({ t: 'join', name: myName, playerId: myId })
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.t === 'you') { myId = m.playerId; LS.set('tel.pid', myId) }
    if (m.t === 'state') { S = m.v; render() }
    if (m.t === 'err') toast(m.m)
    if (m.t === 'genstart') { generating = true; render() }
    if (m.t === 'genend') { generating = false; if (!m.ok) toast('Model is warming up — write one yourself.'); render() }
  }
  ws.onclose = () => { view.insertAdjacentHTML('afterbegin',
    '<div class="warn">Disconnected. <a href="" style="color:#ffd166">Reload</a></div>') }
}

// ---------- screens ----------
function renderHome() {
  view.innerHTML = `<div class="panel">
    <p class="big">One person writes a message. It passes down the line — <b>each person sees only
    what the last one handed them</b>. At the end, everyone sees exactly how it mutated.</p>
    <div style="height:14px"></div>
    <button class="wide" id="new">Start a room</button>
    <div style="height:20px"></div>
    <h2 style="margin:0 0 9px">Join one</h2>
    <div class="row" id="joinrow"><input id="jc" placeholder="ROOM CODE" maxlength="8" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" inputmode="text"
      style="text-transform:uppercase;font-family:var(--mono);letter-spacing:.2em">
      <button class="ghost" id="join" style="flex:0 0 auto">Join</button></div>
  </div>`
  $('#new').onclick = async () => {
    $('#new').disabled = true; $('#new').textContent = 'Creating…'
    const r = await fetch('/api/new', { method: 'POST' }).then(r => r.json())
    location.hash = `#/r/${r.code}`
  }
  const go = () => { const c = $('#jc').value.trim().toUpperCase(); if (c) location.hash = `#/r/${c}` }
  $('#join').onclick = go
  $('#jc').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go() } }
  $('#joinrow').onclick = () => $('#jc').focus()
  setTimeout(() => { try { $('#jc').focus() } catch {} }, 60)
}

function renderNameGate() {
  $('#codebox').classList.remove('hide'); $('#code').textContent = room
  view.innerHTML = `<div class="panel"><h2 style="margin-top:0">Your name</h2>
    <p class="sub" style="margin-bottom:12px">So the group knows who did what to the message.</p>
    <div class="row" id="namerow"><input id="nm" placeholder="Name" maxlength="24" autocomplete="name" autocorrect="off" spellcheck="false">
    <button id="ok" style="flex:0 0 auto">Join</button></div></div>`
  const go = () => { const n = $('#nm').value.trim(); if (!n) return
    myName = n; LS.set('tel.name', n); connect() }
  $('#ok').onclick = go
  $('#nm').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go() } }
  $('#namerow').onclick = () => $('#nm').focus()
  setTimeout(() => { try { $('#nm').focus() } catch {} }, 60)
}

function render() {
  if (!S) return
  const ae = document.activeElement
  const keep = ae && ae.id && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
    ? { id: ae.id, v: ae.value, s: ae.selectionStart, e: ae.selectionEnd } : null

  if (S.status === 'lobby') renderLobby()
  else if (S.status === 'running') renderRunning()
  else if (S.status === 'done') renderReveal()

  if (keep) {
    const el = document.getElementById(keep.id)
    if (el) {
      // The user's in-progress text always wins over the server's echo of it.
      if (el.value !== keep.v) el.value = keep.v
      el.focus()
      try { el.setSelectionRange(keep.s, keep.e) } catch {}
    }
  }
}

const BIAS = { leveler: 'leveling', sharpener: 'sharpening', assimilator: 'assimilation', faithful: 'faithful' }
function playerList(highlightTurn) {
  return `<div>${S.players.map((p, i) => {
    const done = highlightTurn && i < S.turn, now = highlightTurn && i === S.turn
    return `<div class="seat ${done ? 'done' : ''} ${now ? 'now' : ''}">
      <span class="idx">${done ? '✓' : String(i + 1).padStart(2, '0')}</span>
      <span class="nm">${esc(p.name)}</span>
      <span class="sp">
        ${p.ai ? `<span class="tag t-${BIAS[p.ai]}">AI · ${BIAS[p.ai]}</span>` : ''}
        ${p.id === S.you?.id ? '<span class="pill">you</span>' : ''}
      </span></div>`
  }).join('')}</div>`
}

function renderLobby() {
  const host = S.isHost
  view.innerHTML = `
  <div class="panel">
    <h2 style="margin-top:0">Everyone joins first</h2>
    <p class="sub">Share the code <b style="color:var(--accent)">${room}</b> — or this link.</p>
    <div class="row" style="margin-top:11px">
      <input id="lnk" readonly value="${esc(location.href)}" style="font-size:13px">
      <button class="ghost" id="cp" style="flex:0 0 auto">Copy</button></div>
    ${playerList(false)}
    <p class="lab" style="margin-top:14px">The order above is the order the message travels ·
      <a href="#" id="rename" style="color:var(--ink1)">change your name</a></p>
  </div>
  ${host ? `<div class="panel" style="margin-top:16px">
    <h3>Seat an AI confederate</h3>
    <p class="lede" style="font-size:15px;margin:0 0 16px;max-width:52ch">A planted participant with a known
    bias. Put one in the chain to watch a specific distortion work — or to run a long chain with a small group.</p>
    <div class="row">
      <button class="ghost tiny" data-bot="leveler">The Summarizer · levels</button>
      <button class="ghost tiny" data-bot="sharpener">The Storyteller · sharpens</button>
      <button class="ghost tiny" data-bot="assimilator">The Rationalizer · assimilates</button>
      <button class="ghost tiny" data-bot="faithful">The Careful One · control</button>
    </div></div>` : ''}
  ${host ? `<div class="panel">
    <h2 style="margin-top:0">The starting message</h2>
    <p class="sub" style="margin-bottom:11px">Only you can see this. Make it specific — names, numbers,
    and one odd detail drift the most.</p>
    <textarea id="seed" rows="3" placeholder="Write the message that starts the chain…">${esc(S.seed || '')}</textarea>
    <div class="row" style="margin-top:11px">
      <input id="topic" placeholder="or a topic — e.g. a neighbour's dog">
      <button class="ghost" id="gen" style="flex:0 0 auto" ${generating ? 'disabled' : ''}>
        ${generating ? '<span class="spin"></span>Writing…' : 'Write one for me'}</button></div>
    <div style="height:13px"></div>
    <button class="wide" id="start" ${S.players.length < 2 ? 'disabled' : ''}>
      ${S.players.length < 2 ? 'Waiting for more players…' : `Send it to ${esc(S.players[0]?.name || '')} →`}</button>
  </div>` : `<div class="panel"><p class="big" style="color:var(--dim)">
    Waiting for the host to start. You won't see the message until it reaches you.</p></div>`}`

  $('#rename')?.addEventListener('click', e => {
    e.preventDefault()
    const n = prompt('Your name', myName)
    if (n && n.trim()) { myName = n.trim(); LS.set('tel.name', myName); send({ t: 'join', name: myName, playerId: myId }) }
  })
  document.querySelectorAll('[data-bot]').forEach(b =>
    b.addEventListener('click', () => send({ t: 'addbot', persona: b.dataset.bot })))
  $('#cp')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(location.href).then(() => toast('Link copied')).catch(() => {})
  })
  const seed = $('#seed')
  if (seed) {
    let t
    seed.oninput = () => { clearTimeout(t); t = setTimeout(() => send({ t: 'seed', text: seed.value }), 300) }
    $('#gen').onclick = () => send({ t: 'gen', topic: $('#topic').value })
    $('#start').onclick = () => { send({ t: 'seed', text: seed.value }); setTimeout(() => send({ t: 'start' }), 120) }
  }
}

function renderRunning() {
  const mine = S.handed !== null && S.handed !== undefined
  if (mine) {
    view.innerHTML = `<div class="panel st">
      <h2 style="margin-top:0">${S.isFirst ? 'You start the chain' : 'Handed to you'}</h2>
      <div class="handed"><div class="quote">${esc(S.handed)}</div></div>
      <p class="lede" style="margin-top:13px;font-size:15px">Read it, then pass it on <b>in your own words</b>.
      You can look at it while you write — most people won't remember it exactly, and that's the point.</p>
      <textarea id="out" rows="3" placeholder="Pass it on…" style="margin-top:9px"></textarea>
      <div style="height:11px"></div>
      <button class="wide" id="pass">Pass to ${esc(S.players[S.turn + 1]?.name || 'the group')} →</button>
    </div>`
    $('#out').focus()
    $('#pass').onclick = () => {
      const v = $('#out').value.trim(); if (!v) return toast('Write something first.')
      $('#pass').disabled = true; send({ t: 'pass', text: v })
    }
  } else {
    view.innerHTML = `<div class="panel st">
      <h2 style="margin-top:0">In flight</h2>
      <p class="big">The message is with <b style="color:var(--accent)">${esc(S.holder?.name || '…')}</b>.</p>
      <p class="sub">Nobody else can see it — not even this screen. That's what makes the reveal honest.</p>
      ${playerList(true)}
      <p class="lab" style="margin-top:16px">${S.turn} of ${S.total} have passed it on</p>
      ${S.isHost ? `<div style="margin-top:18px"><button class="ghost tiny" id="skip">
        Skip ${esc(S.holder?.name || '')} — they dropped off</button></div>` : ''}
    </div>`
    $('#skip')?.addEventListener('click', () => send({ t: 'skip' }))
  }
}

// ---------- alluvial proposition flow ----------
// Each atomic claim from the original is a ribbon. It narrows as it weakens, shifts hue as it
// distorts, and frays out where it dies. Invented claims are born mid-diagram.
const HUE = [8, 42, 168, 205, 262, 320, 95]
const STATUS_STYLE = { intact: [.92, 1], weakened: [.45, .62], distorted: [.85, .8], dropped: [0, 0] }

function ribbonPath(x0, y0, t0, x1, y1, t1) {
  const cx = (x1 - x0) * 0.42
  const top = `M${x0},${y0 - t0 / 2} C${x0 + cx},${y0 - t0 / 2} ${x1 - cx},${y1 - t1 / 2} ${x1},${y1 - t1 / 2}`
  const bot = `L${x1},${y1 + t1 / 2} C${x1 - cx},${y1 + t1 / 2} ${x0 + cx},${y0 + t0 / 2} ${x0},${y0 + t0 / 2} Z`
  return top + ' ' + bot
}

function alluvial(flow) {
  if (!flow?.props?.length) return ''
  const props = flow.props, cols = flow.cols
  const N = cols.length + 1, W = 130 * N + 150, PAD = 74
  const lane = 34, H = PAD + props.length * lane + 46
  const xs = i => 110 + i * ((W - 190) / Math.max(1, N - 1))

  let paths = '', dots = '', dead = ''
  props.forEach((p, pi) => {
    const hue = HUE[pi % HUE.length]
    const y = PAD + pi * lane
    const maxT = 6 + p.salience * 3.4
    let prev = { x: xs(0), t: maxT, alive: true }
    for (let c = 0; c < cols.length; c++) {
      const f = cols[c].fates.find(x => x.id === p.id)
      const st = f?.status || 'dropped'
      const [sat, op] = STATUS_STYLE[st] || STATUS_STYLE.intact
      const x = xs(c + 1)
      if (!prev.alive) break
      if (st === 'dropped') {
        // death: taper to nothing, then a terminal mark
        paths += `<path d="${ribbonPath(prev.x, y, prev.t, x - 26, y, 1.2)}"
          fill="hsl(${hue} 30% 46% / .30)" class="rb" style="--d:${(pi * 55 + c * 90)}ms"/>`
        dead += `<circle cx="${x - 22}" cy="${y}" r="2.4" fill="hsl(${hue} 30% 52%)" opacity=".5"/>`
        prev.alive = false; break
      }
      const t = st === 'weakened' ? Math.max(3, prev.t * 0.58) : st === 'distorted' ? prev.t * 0.9 : prev.t
      const light = st === 'distorted' ? 62 : 54
      const h2 = st === 'distorted' ? hue + 26 : hue
      paths += `<path d="${ribbonPath(prev.x, y, prev.t, x, y, t)}"
        fill="hsl(${h2} ${Math.round(sat * 70)}% ${light}% / ${op * 0.62})" class="rb"
        style="--d:${(pi * 55 + c * 90)}ms"/>`
      if (st === 'distorted') dots += `<circle cx="${x}" cy="${y}" r="3.2" fill="hsl(${h2} 75% 66%)"/>`
      prev = { x, t, alive: true }
    }
  })

  // invented claims: born at the column where they appear
  let born = ''
  cols.forEach((c, ci) => {
    (c.invented || []).slice(0, 2).forEach((iv, k) => {
      const y = PAD + props.length * lane + 6 + k * 20
      const x0 = xs(ci + 1), x1 = xs(cols.length)
      born += `<path d="${ribbonPath(x0, y, 1.5, Math.max(x1, x0 + 40), y, 9)}"
        fill="hsl(352 72% 58% / .5)" class="rb" style="--d:${700 + ci * 90}ms"/>
        <text x="${x0 + 8}" y="${y - 8}" class="flab" fill="#e05a6d">${esc(iv).slice(0, 34)}</text>`
    })
  })

  const heads = [`<text x="110" y="34" class="fnode" text-anchor="middle">ORIGINAL</text>`,
    ...cols.map((c, i) => `<text x="${xs(i + 1)}" y="34" class="fnode" text-anchor="middle">${esc(c.author).slice(0,12).toUpperCase()}</text>` +
      (c.ai ? `<text x="${xs(i + 1)}" y="48" class="fnode" fill="#7d776c" text-anchor="middle">AI</text>` : ''))].join('')
  const labels = props.map((p, pi) => `<text x="100" y="${PAD + pi * lane + 4}" class="flab"
    text-anchor="end">${esc(p.text).slice(0, 26)}</text>`).join('')

  return `<div class="flowwrap"><svg class="flow" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    <style>.rb{opacity:0;animation:rin .8s var(--e1) forwards;animation-delay:var(--d)}
      @keyframes rin{to{opacity:1}}
      @media(prefers-reduced-motion:reduce){.rb{animation:none;opacity:1}}</style>
    ${heads}${labels}${paths}${born}${dead}${dots}</svg></div>
  <div class="legend">
    <span class="lgi"><span class="sw" style="background:#4bbf8a"></span>intact</span>
    <span class="lgi"><span class="sw" style="background:#5aa9e6;height:1.5px"></span>weakened — ribbon narrows</span>
    <span class="lgi"><span class="sw" style="background:#b57edc"></span>distorted — hue shifts</span>
    <span class="lgi"><span class="sw" style="background:#35353d"></span>dropped — ribbon dies</span>
    <span class="lgi"><span class="sw" style="background:#e05a6d"></span>invented — born mid-chain</span>
  </div>`
}

// ---------- reveal ----------
const TYPE_WORD = { leveling: 'dropped', sharpening: 'exaggerated', assimilation: 'warped', invention: 'invented' }

function ring(pct) {
  const r = 52, c = 2 * Math.PI * r, off = c * (1 - pct / 100)
  const col = pct > 66 ? 'var(--good)' : pct > 33 ? 'var(--sharp)' : 'var(--invent)'
  return `<div class="fidring"><svg width="118" height="118">
    <circle cx="59" cy="59" r="${r}" fill="none" stroke="#1e2331" stroke-width="9"/>
    <circle cx="59" cy="59" r="${r}" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c}" style="transition:stroke-dashoffset 1.4s cubic-bezier(.2,.8,.2,1)"
      id="fidarc"/></svg><div class="val" style="color:${col}">${pct}%</div></div>
    <div class="fidcap">survived intact</div>`
}

function sparkline(curve) {
  const W = 100, H = 42, n = curve.length
  const pts = curve.map((c, i) => [(i / Math.max(1, n - 1)) * W, H - (c.fidelity / 100) * H])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${d} L${W},${H} L0,${H} Z`
  return `<div class="curve"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:110px">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd166" stop-opacity=".32"/><stop offset="1" stop-color="#ffd166" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#g)"/><path d="${d}" fill="none" stroke="#ffd166" stroke-width="1.6"
      vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    ${pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="1.9" fill="#08090d"
      stroke="#ffd166" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`).join('')}
  </svg>
  <div style="display:flex;justify-content:space-between;font:600 10px var(--mono);color:var(--dim2);padding:0 2px">
    ${curve.map((c, i) => `<span>${i === 0 ? 'START' : c.fidelity + '%'}</span>`).join('')}</div></div>`
}

function diffHtml(diff) {
  return diff.map(t => {
    const c = t.op === 'add' ? 'add' : t.op === 'del' ? 'del' : ''
    const sp = /^[^\w]/.test(t.raw) ? '' : ' '
    return sp + (c ? `<span class="${c}">${esc(t.raw)}</span>` : esc(t.raw))
  }).join('').trim()
}

// Follow one detail down the chain: show the versions where its fate visibly changed.
function traces(chain, analysis) {
  const out = []
  analysis.hops.forEach(h => {
    h.ops.forEach(o => {
      if ((o.type === 'sharpening' || o.type === 'leveling') && o.from && o.to) {
        out.push({ from: o.from, to: o.to, at: h.to.author, i: h.index })
      }
    })
  })
  const seen = new Set()
  const uniq = out.filter(t => { const k = t.from + '>' + t.to; if (seen.has(k)) return false; seen.add(k); return true })
  if (!uniq.length) return ''
  return `<h2>Follow a detail</h2><div class="panel" style="padding:8px 16px">
    ${uniq.slice(0, 6).map(t => `<div class="trace">
      <span style="color:var(--good)">${esc(t.from)}</span><span class="ar">→</span>
      <span style="color:var(--sharp)">${esc(t.to)}</span>
      <span style="margin-left:auto;color:var(--dim2);font-size:12px">at ${esc(t.at)}</span></div>`).join('')}
  </div>`
}

function renderReveal() {
  const R = S.reveal
  if (!R) return view.innerHTML = `<p class="lede" style="margin-top:var(--s4)"><span class="spin"></span>Analysing the chain…</p>`
  const A = R.analysis, chain = R.chain, N = R.narration
  const orig = chain[0].text, fin = chain[chain.length - 1].text

  view.innerHTML = `
  <div class="hero st">
    <div class="hbox a"><div class="lab">What was sent</div><div class="quote" style="margin-top:14px">${esc(orig)}</div></div>
    <div class="fid"><span class="n">${A.fidelity}<span style="font-size:.42em">%</span></span>
      <span class="c">survived ${A.hops.length} hops</span></div>
    <div class="hbox b"><div class="lab">What came out</div><div class="quote" style="margin-top:14px">${esc(fin)}</div></div>
  </div>

  ${N?.headline ? `<div class="verdict st" style="animation-delay:.12s">${esc(N.headline)}
    ${N.why ? `<div class="why">${esc(N.why)}</div>` : ''}</div>`
   : R.narrating ? `<p class="lede" style="margin-top:var(--s4)"><span class="spin"></span>Reading the drift…</p>` : ''}

  ${R.flow ? `<h2>Every claim, and where it died</h2>
    <p class="lede measure" style="margin:0 0 var(--s3)">The original message broken into atomic claims.
    Each ribbon is one claim, tracked hop by hop — narrowing as it weakens, shifting as it distorts,
    fraying where it dies.</p>${alluvial(R.flow)}`
   : R.narrating ? '' : ''}

  <h2>Decay</h2>${sparkline(A.curve)}

  ${A.biggestMutation ? `<div class="blame st">
    <div class="lab" style="margin-bottom:10px">Biggest single mutation</div>
    <div class="n">${esc(A.biggestMutation.author)}</div>
    <div class="lede" style="margin-top:10px">${esc(A.biggestMutation.headline)}</div>
    ${R.abduction ? `<div style="margin-top:20px;padding-top:18px;border-top:1px solid var(--rule)">
      <div class="mech">${esc(R.abduction.mechanism.replace(/_/g,' '))} · ${R.abduction.confidence}% confidence</div>
      <div class="lede" style="font-size:19px;max-width:44ch">${esc(R.abduction.why)}</div></div>` : ''}
  </div>` : ''}

  <h2>Fate of the original</h2>
  <div class="cols">
    <div class="fate s"><h3 style="color:var(--keep)">Survived</h3><div class="chips">${A.survived.slice(0,14).map(w=>`<span class="chip">${esc(w)}</span>`).join('')||'<span class="chip">nothing</span>'}</div></div>
    <div class="fate l"><h3 style="color:var(--level)">Lost</h3><div class="chips">${A.lost.slice(0,14).map(w=>`<span class="chip">${esc(w)}</span>`).join('')||'<span class="chip">nothing</span>'}</div></div>
    <div class="fate i"><h3 style="color:var(--invent)">Invented</h3><div class="chips">${A.invented.slice(0,14).map(w=>`<span class="chip">${esc(w)}</span>`).join('')||'<span class="chip">nothing</span>'}</div></div>
  </div>

  ${traces(chain, A)}

  <h2>Every version</h2>
  <div style="padding:var(--s3) 0;border-top:1px solid var(--rule)">
    <div class="lab">Original</div><div class="quote" style="margin-top:12px">${esc(orig)}</div></div>
  ${A.hops.map(h => `<div class="hop">
    <div class="hh"><span class="who">${esc(h.to.author)}</span>
      ${chain[h.index]?.ai ? `<span class="tag t-${BIAS[chain[h.index].ai]||'faithful'}">AI</span>` : ''}
      <span class="m">${h.fidelity}% KEPT · DRIFT ${h.severity}</span></div>
    <div class="diff">${diffHtml(h.diff)}</div>
    ${h.ops.length ? `<div class="ops">${h.ops.map(o=>`<div class="op ${o.type}"><b>${TYPE_WORD[o.type]||o.type}</b>${esc(o.label)}</div>`).join('')}</div>`
      : '<div class="ops"><div class="op" style="border-color:var(--rule2);color:var(--ink2)">passed on almost intact</div></div>'}
  </div>`).join('')}

  <div style="height:var(--s4)"></div>
  ${S.isHost ? '<button class="wide" id="again">Run it again with the same group</button><div style="height:12px"></div>' : ''}
  <button class="ghost wide" id="share">Copy the transcript</button>`

  $('#again')?.addEventListener('click', () => send({ t: 'again' }))
  $('#share')?.addEventListener('click', () => {
    const txt = `TELEPHONE — ${A.fidelity}% survived ${A.hops.length} hops\n\n` +
      chain.map((c, i) => `${i === 0 ? 'START' : c.author}: ${c.text}`).join('\n\n') +
      (N?.headline ? `\n\n${N.headline}` : '')
    navigator.clipboard?.writeText(txt).then(() => toast('Summary copied')).catch(() => toast('Copy failed'))
  })
}

boot()
