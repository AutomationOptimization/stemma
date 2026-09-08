const $ = s => document.querySelector(s)
const view = $('#view')
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const LS = { get: k => { try { return localStorage.getItem(k) } catch { return null } },
             set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } }

let ws = null, S = null, myName = LS.get('tel.name') || '', room = ''
let generating = false

// A seat is (id, token) and belongs to one room. The token is what proves the seat is
// yours — ids are broadcast to everyone so the roster can render, so an id alone must not
// be enough to claim a chair and be handed someone else's message.
let seat = { id: '', token: '' }
const seatKey = () => 'tel.seat.' + room
function loadSeat() { try { seat = JSON.parse(LS.get(seatKey())) || { id: '', token: '' } } catch { seat = { id: '', token: '' } } }
function saveSeat() { LS.set(seatKey(), JSON.stringify(seat)) }

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
  loadSeat()
  if (!myName) return renderNameGate()
  connect()
}
window.addEventListener('hashchange', () => location.reload())

let retries = 0, reconnectTimer = null
function setLink(state) {
  const el = $('#link')
  if (el) { el.className = 'link ' + state; el.title = state }
}

function connect() {
  clearTimeout(reconnectTimer)
  $('#codebox').classList.remove('hide'); $('#code').textContent = room
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws/${room}`)

  ws.onopen = () => {
    retries = 0; setLink('ok')
    document.querySelector('.warn')?.remove()
    send({ t: 'join', name: myName, playerId: seat.id, token: seat.token })
  }
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.t === 'you') { seat = { id: m.playerId, token: m.token || '' }; saveSeat() }
    if (m.t === 'state') { S = m.v; render() }
    if (m.t === 'err') toast(m.m)
    if (m.t === 'genstart') { generating = true; render() }
    if (m.t === 'genend') { generating = false; if (!m.ok) toast('Model is warming up — write one yourself.'); render() }
  }
  // Phones drop the socket whenever the tab backgrounds. Reconnecting silently matters more
  // here than almost anywhere: the chain stalls on whoever is holding the message.
  ws.onclose = () => {
    setLink('off')
    const wait = Math.min(15000, 600 * Math.pow(1.7, retries++))
    if (retries > 1 && !document.querySelector('.warn')) {
      view.insertAdjacentHTML('afterbegin',
        '<div class="warn" id="warn">Reconnecting… <a href="" style="color:#ffd166">reload</a></div>')
    }
    reconnectTimer = setTimeout(connect, wait)
  }
  ws.onerror = () => { try { ws.close() } catch {} }
}
// Come back the moment the user does, rather than waiting out the backoff.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ws && ws.readyState > 1) { retries = 0; connect() }
})

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
  ${host ? `<div class="panel" style="margin-top:16px">
    <h3>How long they get to look</h3>
    <p class="lede" style="font-size:15px;margin:0 0 16px;max-width:52ch">The message is taken away
    before they write. Recall is the whole experiment — leave people looking at it and you measure
    paraphrasing, not memory.</p>
    <div class="row">
      ${[['Auto', ''], ['5s', 5000], ['10s', 10000], ['No limit', 0]].map(([lab, ms]) =>
        `<button class="ghost tiny ${(ms === '' ? S.exposeMs == null : S.exposeMs === ms) ? 'on' : ''}"
          data-exp="${ms}">${lab}</button>`).join('')}
    </div>
    <p class="lab" style="margin-top:12px">Auto scales with the message: 4–15 seconds.</p>
  </div>` : ''}
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
    if (n && n.trim()) { myName = n.trim(); LS.set('tel.name', myName); send({ t: 'join', name: myName, playerId: seat.id, token: seat.token }) }
  })
  document.querySelectorAll('[data-bot]').forEach(b =>
    b.addEventListener('click', () => send({ t: 'addbot', persona: b.dataset.bot })))
  document.querySelectorAll('[data-exp]').forEach(b =>
    b.addEventListener('click', () => send({ t: 'expose', ms: b.dataset.exp === '' ? null : Number(b.dataset.exp) })))
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

// ---------- the turn ----------
// The message is shown for a few seconds and then taken away. Without that this is serial
// transcription, not serial reproduction: what drifts is whatever you chose to paraphrase,
// not what your memory actually did to it.

let draft = ''            // survives re-renders; the server echoes state at awkward moments
let typeStart = 0, pasted = false
let shownKey = null, hiddenKey = null, hideTimer = null, tickTimer = null

function resetTurn() {
  clearTimeout(hideTimer); clearInterval(tickTimer)
  hideTimer = tickTimer = null; shownKey = hiddenKey = null
  draft = ''; typeStart = 0; pasted = false
}

function hostControls() {
  if (!S.isHost) return ''
  return `<div class="hostbar">
    <button class="ghost tiny" id="skip">Skip ${esc(S.holder?.name || '')}</button>
    ${S.reading ? '<button class="ghost tiny" id="reshow">Let them look again</button>' : ''}
    ${S.passed ? '<button class="ghost tiny" id="undo">Undo last turn</button>' : ''}
  </div>`
}
function wireHostControls() {
  $('#skip')?.addEventListener('click', () => send({ t: 'skip' }))
  $('#reshow')?.addEventListener('click', () => send({ t: 'reshow' }))
  $('#undo')?.addEventListener('click', () => {
    if (confirm('Roll back the last turn? They will be handed the message again.')) send({ t: 'undo' })
  })
}

// Turn the composer on once the message is gone. Locking it while the message is up is the
// actual enforcement — given a textarea and the text side by side, people transcribe.
function openComposer() {
  hiddenKey = shownKey
  const out = $('#out'), pass = $('#pass'), gone = $('#gone')
  if (!out) return
  $('#msg')?.remove()          // out of the DOM, not just hidden
  gone?.classList.remove('hide')
  out.disabled = false; pass.disabled = false
  out.placeholder = 'What did it say?'
  out.value = draft
  out.focus()
}

function startCountdown(ms) {
  const ring = $('#ctd'), num = $('#ctdn')
  if (!ring) return
  const end = Date.now() + ms
  const C = 2 * Math.PI * 15
  ring.style.strokeDasharray = C
  ring.style.strokeDashoffset = 0
  requestAnimationFrame(() => {
    ring.style.transition = `stroke-dashoffset ${ms}ms linear`
    ring.style.strokeDashoffset = C
  })
  tickTimer = setInterval(() => {
    const left = Math.max(0, end - Date.now())
    if (num) num.textContent = Math.ceil(left / 1000)
    if (!left) clearInterval(tickTimer)
  }, 100)
  hideTimer = setTimeout(() => { clearInterval(tickTimer); openComposer() }, ms)
}

function renderMyTurn() {
  const ex = S.exposure
  const key = ex ? `${S.turn}:${ex.shownAt}` : null
  // Once this window has closed locally it stays closed. The server's grace period keeps
  // `live` true for a moment longer so a reconnect works, and a state broadcast landing in
  // that gap would otherwise put the message back on screen — a free second look.
  const showing = !!(S.handed && ex?.live && key !== hiddenKey)
  const noLimit = S.exposeMs === 0

  // Not shown yet: gate behind a tap so the clock cannot burn down while they are still
  // reading the last screen.
  if (!ex) {
    resetTurn()
    view.innerHTML = `<div class="panel st">
      <h2 style="margin-top:0">${S.isFirst ? 'You start the chain' : 'It’s your turn'}</h2>
      <p class="big">${S.isFirst ? 'You’ll see the starting message' : 'You’ll see the message'}
        ${noLimit ? '' : ' for <b>a few seconds only</b>'}, then it disappears and you retell it
        ${noLimit ? '' : '<b>from memory</b>'}.</p>
      <p class="sub">Don’t tap until you’re ready to read.</p>
      <div style="height:16px"></div>
      <button class="wide" id="show">Show me the message</button>
    </div>`
    $('#show').onclick = () => { $('#show').disabled = true; send({ t: 'ready' }) }
    return
  }

  view.innerHTML = `<div class="panel st">
    <h2 style="margin-top:0">${S.isFirst ? 'You start the chain' : 'Handed to you'}</h2>
    ${showing ? `<div id="msg">
      ${noLimit ? '' : `<div class="ctdwrap"><svg width="36" height="36" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15" fill="none" stroke="var(--rule2)" stroke-width="3"/>
        <circle id="ctd" cx="18" cy="18" r="15" fill="none" stroke="var(--sharp)" stroke-width="3"
          stroke-linecap="round" transform="rotate(-90 18 18)"/></svg>
        <span class="ctdn" id="ctdn"></span><span class="lab">memorise it</span></div>`}
      <div class="handed"><div class="quote">${esc(S.handed)}</div></div></div>` : ''}
    <div id="gone" class="${showing ? 'hide' : ''}">
      <div class="lede" style="margin:0 0 4px">${noLimit ? 'Retell it in your own words.' : 'It’s gone. Retell it from memory, in your own words.'}</div>
      <p class="sub" style="margin:0 0 12px">Whatever you remember is the right answer — the gaps are the experiment.</p>
    </div>
    <textarea id="out" rows="3" placeholder="${showing ? 'Read it first…' : 'What did it say?'}"
      ${showing ? 'disabled' : ''}></textarea>
    <div style="height:11px"></div>
    <button class="wide" id="pass" ${showing ? 'disabled' : ''}>Pass to ${esc(S.players[S.turn + 1]?.name || 'the group')} →</button>
  </div>`

  const out = $('#out')
  out.value = draft
  out.addEventListener('input', () => { draft = out.value; if (!typeStart) typeStart = Date.now() })
  // Blocking paste doesn't stop a determined player, but it does stop the lazy path, and
  // the flag is recorded either way so the reveal can discount the hop.
  const nope = e => { e.preventDefault(); pasted = true; toast('Paste is off — write what you remember.') }
  out.addEventListener('paste', nope)
  out.addEventListener('drop', nope)

  $('#pass').onclick = () => {
    const v = out.value.trim(); if (!v) return toast('Write something first.')
    $('#pass').disabled = true
    send({ t: 'pass', text: v, typedMs: typeStart ? Date.now() - typeStart : null, pasted })
    resetTurn()
  }

  if (showing && !noLimit && key !== shownKey) {
    shownKey = key
    // Clamp against clock skew between the phone and the edge: never longer than the window.
    const left = Math.max(600, Math.min(ex.ms, ex.shownAt + ex.ms - Date.now()))
    startCountdown(left)
  } else if (!showing) {
    out.focus()
  }
}

function renderRunning() {
  const myTurn = S.holder && S.you && S.holder.id === S.you.id
  if (myTurn) return renderMyTurn()
  resetTurn()
  view.innerHTML = `<div class="panel st">
    <h2 style="margin-top:0">In flight</h2>
    <p class="big">The message is with <b style="color:var(--accent)">${esc(S.holder?.name || '…')}</b>${
      S.reading ? ', reading it now' : ''}.</p>
    <p class="sub">Nobody else can see it — not even this screen. That's what makes the reveal honest.</p>
    ${playerList(true)}
    <p class="lab" style="margin-top:16px">${S.turn} of ${S.total} have passed it on</p>
    ${hostControls()}
  </div>`
  wireHostControls()
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
  // Claim labels sit in a left gutter. It has to be wide enough for the truncated text or
  // the labels run off the viewBox and get clipped.
  const LEFT = 176, RIGHT = 74, LANE = 34, PAD = 74
  const N = cols.length + 1
  const W = LEFT + 140 * Math.max(1, N - 1) + RIGHT
  const xs = i => LEFT + i * ((W - LEFT - RIGHT) / Math.max(1, N - 1))
  // Every invented claim gets its own row across the whole diagram; stacking them per
  // column put two ribbons and two labels on the same y.
  const bornItems = cols.flatMap((c, ci) => (c.invented || []).slice(0, 2).map(text => ({ text, ci })))
    .slice(0, 6)
  const H = PAD + props.length * LANE + (bornItems.length ? 18 + bornItems.length * 26 : 0) + 34
  const lane = LANE

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

  // invented claims: born at the column where they appear, one per row
  const bornTop = PAD + props.length * lane + 18
  const born = bornItems.map((it, k) => {
    const y = bornTop + k * 26
    // Ends at the final column, not the edge of the viewBox.
    const x0 = xs(it.ci + 1), x1 = Math.max(xs(N - 1), x0 + 40)
    return `<path d="${ribbonPath(x0, y, 1.5, x1, y, 9)}"
      fill="hsl(352 72% 58% / .5)" class="rb" style="--d:${700 + it.ci * 90}ms"/>
      <text x="${x0 + 8}" y="${y - 9}" class="flab" fill="#e05a6d">${esc(it.text).slice(0, 30)}</text>`
  }).join('')

  const heads = [`<text x="${LEFT}" y="34" class="fnode" text-anchor="middle">ORIGINAL</text>`,
    ...cols.map((c, i) => `<text x="${xs(i + 1)}" y="34" class="fnode" text-anchor="middle">${esc(c.author).slice(0,12).toUpperCase()}</text>` +
      (c.ai ? `<text x="${xs(i + 1)}" y="48" class="fnode" fill="#7d776c" text-anchor="middle">AI</text>` : ''))].join('')
  const labels = props.map((p, pi) => {
    const t = p.text.length > 24 ? p.text.slice(0, 23) + '…' : p.text
    return `<text x="${LEFT - 14}" y="${PAD + pi * lane + 4}" class="flab"
      text-anchor="end">${esc(t)}</text>`
  }).join('')

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

function sparkline(curve, breaks = []) {
  const W = 100, H = 42, n = curve.length
  const x = i => (i / Math.max(1, n - 1)) * W
  const line = key => curve.map((c, i) =>
    `${i ? 'L' : 'M'}${x(i).toFixed(1)},${(H - (c[key] / 100) * H).toFixed(1)}`).join(' ')
  const pts = curve.map((c, i) => [x(i), H - (c.fidelity / 100) * H])
  const d = line('fidelity')
  const area = `${d} L${W},${H} L0,${H} Z`
  const cut = breaks.map(b => `<line x1="${x(b.index).toFixed(1)}" y1="0" x2="${x(b.index).toFixed(1)}" y2="${H}"
    stroke="#e05a6d" stroke-width="1" stroke-dasharray="2 2" vector-effect="non-scaling-stroke" opacity=".8"/>`).join('')
  return `<div class="curve"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:110px">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd166" stop-opacity=".32"/><stop offset="1" stop-color="#ffd166" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#g)"/>${cut}
    ${breaks.length ? `<path d="${line('segFidelity')}" fill="none" stroke="#4bbf8a" stroke-width="1.4"
      stroke-dasharray="3 2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` : ''}
    <path d="${d}" fill="none" stroke="#ffd166" stroke-width="1.6"
      vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    ${pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="1.9" fill="#08090d"
      stroke="#ffd166" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`).join('')}
  </svg>
  <div style="display:flex;justify-content:space-between;font:600 10px var(--mono);color:var(--dim2);padding:0 2px">
    ${curve.map((c, i) => `<span>${i === 0 ? 'START' : c.fidelity + '%'}</span>`).join('')}</div>
  ${breaks.length ? `<div class="legend"><span class="lgi"><span class="sw" style="background:#ffd166"></span>against the original</span>
    <span class="lgi"><span class="sw" style="background:#4bbf8a"></span>against the message the chain restarted from</span>
    <span class="lgi"><span class="sw" style="background:#e05a6d"></span>the chain broke here</span></div>` : ''}</div>`
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
  const breaks = A.breaks || []

  // One person going off-script is a real result, not a failed run — so say so plainly, and
  // report the stretch either side of it rather than one number that hides the whole story.
  const broke = breaks.length ? `<div class="broke st">
    <div class="lab" style="margin-bottom:10px">The chain broke</div>
    <div class="n">${breaks.map(b => esc(b.author)).join(' · ')}</div>
    <div class="lede" style="margin-top:10px;max-width:52ch">${breaks.length > 1 ? 'These turns' : 'This turn'}
      bore no recoverable relation to what came in, so everything downstream is a retelling of
      something else. The ${A.fidelity}% above is measured against the original; against the message
      the chain actually restarted from, <b style="color:var(--keep)">${A.fidelityRebased}%</b> survived.</div>
    ${A.segments?.length > 1 ? `<div class="segs">${A.segments.map(s => `<div class="seg">
      <span class="mono">${esc(chain[s.from].author)} → ${esc(chain[s.to].author)}</span>
      <span class="sv" style="color:${s.fidelity > 66 ? 'var(--keep)' : s.fidelity > 33 ? 'var(--sharp)' : 'var(--invent)'}">${s.fidelity}%</span>
      <span class="lab">${s.hops} hop${s.hops === 1 ? '' : 's'}</span></div>`).join('')}</div>` : ''}
  </div>` : ''

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

  ${broke}

  ${R.flow ? `<h2>Every claim, and where it died</h2>
    <p class="lede measure" style="margin:0 0 var(--s3)">The original message broken into atomic claims.
    Each ribbon is one claim, tracked hop by hop — narrowing as it weakens, shifting as it distorts,
    fraying where it dies.</p>${alluvial(R.flow)}`
   : R.narrating ? '' : ''}

  ${R.flow?.rebase && !R.flow.rebase.pending ? `<h2>And again, from where it restarted</h2>
    <p class="lede measure" style="margin:0 0 var(--s3)">Everything after ${esc(R.flow.rebase.author)} is
    a retelling of a different message, so against the original every ribbon above simply dies. These are
    the claims in <b>${esc(R.flow.rebase.author)}’s</b> version, tracked down the rest of the chain — what
    the group actually did after the break.</p>${alluvial(R.flow.rebase)}` : ''}

  <h2>Decay</h2>${sparkline(A.curve, A.breaks || [])}

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
  ${A.hops.map(h => `<div class="hop${breaks.some(b => b.index === h.index) ? ' snapped' : ''}">
    <div class="hh"><span class="who">${esc(h.to.author)}</span>
      ${chain[h.index]?.ai ? `<span class="tag t-${BIAS[chain[h.index].ai]||'faithful'}">AI · ${BIAS[chain[h.index].ai]||'faithful'}</span>` : ''}
      ${chain[h.index]?.skipped ? '<span class="tag" style="color:var(--ink2);border-color:var(--rule2)">SKIPPED</span>' : ''}
      ${breaks.some(b => b.index === h.index) ? '<span class="tag t-invention">BROKE THE CHAIN</span>' : ''}
      ${h.suspect ? `<span class="tag t-invention" title="Memory mode is enforced in the browser, so this is measured, not certain">${
        h.suspect === 'pasted' ? 'PASTED' : 'LIKELY COPIED'}</span>` : ''}
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
