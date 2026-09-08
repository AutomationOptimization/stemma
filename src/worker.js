import { analyzeChain } from './drift.js'
import { narrateReveal, seedMessage, warmUsher, decompose, fates, confederate, abduce, mapPool, PERSONAS } from './usher.js'

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no I/L/O/0/1
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })

function makeCode(len = 4) {
  const b = new Uint8Array(len); crypto.getRandomValues(b)
  return [...b].map(x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('')
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const p = url.pathname

    if (p === '/api/new') {
      // 31^4 codes with no collision check used to hand you the code of a game already in
      // progress: /init is a no-op when the DO already holds data. Ask, and retry.
      for (let i = 0; i < 6; i++) {
        const code = makeCode(i < 4 ? 4 : 5)
        const r = await env.ROOM.get(env.ROOM.idFromName(code))
          .fetch(new Request('https://do/init?code=' + code, { method: 'POST' }))
        const { fresh } = await r.json().catch(() => ({}))
        if (fresh) return json({ code })
      }
      return json({ error: 'could not allocate a room, try again' }, 503)
    }
    if (p.startsWith('/api/room/') || p.startsWith('/ws/')) {
      const code = (p.split('/')[p.startsWith('/ws/') ? 2 : 3] || '').toUpperCase()
      if (!/^[A-Z0-9]{3,8}$/.test(code)) return json({ error: 'bad code' }, 400)
      const stub = env.ROOM.get(env.ROOM.idFromName(code))
      return stub.fetch(new Request('https://do' + p + url.search, req))
    }
    if (p === '/api/health') {
      // Report the key separately: an unset secret and a cold GPU used to look identical.
      const r = await fetch(env.USHER_BASE.replace(/\/v1$/, '') + '/health').catch(() => null)
      return json({ worker: 'ok', key: env.USHER_KEY ? 'set' : 'missing',
        model: r && r.ok ? await r.json().catch(() => null) : 'cold' })
    }
    // Never let a browser hold a stale index.html against a new app.js.
    const res = await env.ASSETS.fetch(req)
    if ((res.headers.get('content-type') || '').includes('text/html')) {
      const h = new Headers(res.headers)
      h.set('Cache-Control', 'no-store, must-revalidate')
      return new Response(res.body, { status: res.status, headers: h })
    }
    return res
  },
}

export class Room {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.sql = state.storage.sql
    this.sessions = new Map() // ws -> {playerId}
    state.blockConcurrencyWhile(async () => {
      this.data = (await state.storage.get('data')) || null
    })
  }

  async save() { await this.state.storage.put('data', this.data) }

  fresh(code) {
    return {
      code, createdAt: Date.now(), status: 'lobby', hostId: null,
      players: [], // {id, name, token, ai}
      seed: '', versions: [], // {index, author, authorId, text, at, ...timing}
      turn: 0, reveal: null, revealErr: null,
      exposure: null,   // {turn, playerId, shownAt, ms} — the live memory window
      exposeMs: null,   // null = scale to length, 0 = no limit (message stays up)
    }
  }

  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname

    if (p === '/init') {
      const existed = !!this.data
      if (!existed) { this.data = this.fresh(url.searchParams.get('code') || 'ROOM'); await this.save() }
      return json({ ok: true, fresh: !existed })
    }
    if (p.startsWith('/ws/')) {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected ws' }, 426)
      if (!this.data) { this.data = this.fresh(p.split('/')[2].toUpperCase()); await this.save() }
      const pair = new WebSocketPair()
      // Hibernation: the DO can evict from memory between turns without dropping players.
      this.state.acceptWebSocket(pair[1])
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    if (p.startsWith('/api/room/')) {
      if (!this.data) return json({ error: 'no room' }, 404)
      return json({ exists: true, status: this.data.status, players: this.data.players.length })
    }
    return json({ error: 'nf' }, 404)
  }

  // What the current holder must retell.
  handedText() {
    const d = this.data
    return d.versions.length ? d.versions[d.versions.length - 1].text : d.seed
  }

  // Memory mode. Long messages get longer, but the window is short enough that nobody can
  // transcribe: the point of the game is recall, not copying.
  exposureFor(text) {
    if (this.data.exposeMs === 0) return 0
    if (this.data.exposeMs) return this.data.exposeMs
    const words = String(text || '').trim().split(/\s+/).filter(Boolean).length
    return Math.max(4000, Math.min(15000, 2500 + words * 350))
  }

  // ---- blinding ------------------------------------------------------------
  // The single most important function here. A player may only ever receive the text
  // handed to them. Not the seed, not earlier links, not the live chain — until reveal.
  // Two invariants, both enforced here rather than in the client:
  //   1. Seats are claimed with a secret token, so a player id read off the wire is not
  //      enough to sit in someone else's chair and read what they were handed.
  //   2. Once a player's memory window has closed, the text is not sent again — otherwise
  //      pull-to-refresh is a free second look and memory mode means nothing.
  viewFor(playerId) {
    const d = this.data
    const me = d.players.find(x => x.id === playerId) || null
    const isHost = !!(playerId && playerId === d.hostId)
    const holder = d.status === 'running' ? d.players[d.turn] : null
    const myTurn = !!(holder && me && holder.id === me.id)

    const base = {
      code: d.code, status: d.status, isHost,
      // Never the token, for me or for anyone else.
      you: me ? { id: me.id, name: me.name, ai: me.ai || null } : null,
      players: d.players.map(x => ({ id: x.id, name: x.name, ai: x.ai || null })),
      turn: d.turn, total: d.players.length,
      holder: holder ? { id: holder.id, name: holder.name } : null,
      passed: d.versions.length,
      hasSeed: !!d.seed,
      exposeMs: d.exposeMs,
    }
    if (d.status === 'running') {
      const ex = d.exposure
      const mine = !!(ex && myTurn && ex.turn === d.turn && ex.playerId === me.id)
      // Grace covers one round trip so a reconnect at the boundary still works. Keep it
      // small: it extends the window for everybody, and on a 4s window 1.5s is half again
      // as long a look as the host asked for.
      const live = mine && (ex.ms === 0 || Date.now() < ex.shownAt + ex.ms + 400)
      base.handed = myTurn && live ? this.handedText() : null
      base.exposure = mine ? { shownAt: ex.shownAt, ms: ex.ms, live } : null
      base.handedExpired = mine && !live
      base.reading = !!(ex && ex.turn === d.turn)   // for everyone else's "they're reading it" state
      base.isFirst = myTurn && d.versions.length === 0
    }
    if (d.status === 'done') {
      base.reveal = d.reveal
      base.revealErr = d.revealErr
      base.seed = d.seed
      base.versions = d.versions
    }
    // The host composing the seed needs to see it; nobody else does, ever.
    if (isHost && d.status === 'lobby') base.seed = d.seed
    return base
  }

  broadcast() {
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() || {}
      try { ws.send(JSON.stringify({ t: 'state', v: this.viewFor(a.playerId) })) } catch {}
    }
  }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw) } catch { return }
    const d = this.data
    const att = ws.deserializeAttachment() || {}

    if (m.t === 'join') {
      const name = String(m.name || '').trim().slice(0, 24) || 'Anon'
      const pid = String(m.playerId || '').slice(0, 40)
      const token = String(m.token || '').slice(0, 80)
      const claimed = pid ? d.players.find(x => x.id === pid) : null

      // A seat is claimed by its token, not its id. Ids are broadcast to the whole room so
      // the roster can render; without this, any player could read the host's id off the
      // wire, rejoin as them, and be handed the seed.
      let pl = null
      if (claimed) {
        // Rooms created before tokens existed have none. Let the first claimant bind one
        // so a game already in flight survives the deploy; every room after this is sealed.
        if (!claimed.token) { claimed.token = crypto.randomUUID(); pl = claimed }
        else if (claimed.token === token) pl = claimed
        else {
          ws.serializeAttachment({ playerId: null })
          ws.send(JSON.stringify({ t: 'err', m: 'That seat is taken.' }))
          ws.send(JSON.stringify({ t: 'state', v: this.viewFor(null) })); return
        }
      }

      if (!pl) {
        if (d.status !== 'lobby') { // late joiner: let them watch, not play
          ws.serializeAttachment({ playerId: null })
          ws.send(JSON.stringify({ t: 'state', v: this.viewFor(null) })); return
        }
        if (d.players.length >= 9) {
          ws.serializeAttachment({ playerId: null })
          ws.send(JSON.stringify({ t: 'err', m: 'Chain is full.' }))
          ws.send(JSON.stringify({ t: 'state', v: this.viewFor(null) })); return
        }
        pl = { id: crypto.randomUUID(), name, token: crypto.randomUUID() }
        d.players.push(pl)
        if (!d.hostId) d.hostId = pl.id
      } else { pl.name = name }

      ws.serializeAttachment({ playerId: pl.id })
      await this.save()
      ws.send(JSON.stringify({ t: 'you', playerId: pl.id, token: pl.token }))
      this.broadcast(); return
    }

    const pid = att.playerId
    const isHost = pid && pid === d.hostId

    if (m.t === 'seed' && isHost && d.status === 'lobby') {
      d.seed = String(m.text || '').slice(0, 600); await this.save(); this.broadcast(); return
    }
    if (m.t === 'gen' && isHost && d.status === 'lobby') {
      ws.send(JSON.stringify({ t: 'genstart' }))
      const s = await seedMessage(this.env, String(m.topic || '').slice(0, 80))
      if (s) { d.seed = s; await this.save() }
      ws.send(JSON.stringify({ t: 'genend', ok: !!s }))
      this.broadcast(); return
    }
    if (m.t === 'addbot' && isHost && d.status === 'lobby') {
      const k = String(m.persona || 'faithful')
      if (!PERSONAS[k]) return
      if (d.players.length >= 9) { ws.send(JSON.stringify({ t: 'err', m: 'Chain is full.' })); return }
      d.players.push({ id: 'ai-' + crypto.randomUUID().slice(0, 8), name: PERSONAS[k].name, ai: k })
      await this.save(); this.broadcast(); return
    }
    if (m.t === 'kick' && isHost && d.status === 'lobby') {
      d.players = d.players.filter(x => x.id !== m.id || x.id === d.hostId)
      await this.save(); this.broadcast(); return
    }
    if (m.t === 'order' && isHost && d.status === 'lobby') {
      const ids = Array.isArray(m.ids) ? m.ids : []
      const byId = new Map(d.players.map(x => [x.id, x]))
      const next = ids.map(i => byId.get(i)).filter(Boolean)
      d.players.forEach(x => { if (!next.includes(x)) next.push(x) })
      d.players = next; await this.save(); this.broadcast(); return
    }
    if (m.t === 'start' && isHost && d.status === 'lobby') {
      if (!d.seed.trim() || d.players.length < 2) {
        ws.send(JSON.stringify({ t: 'err', m: 'Need a message and at least 2 players.' })); return
      }
      d.status = 'running'; d.turn = 0; d.versions = []
      await this.save(); this.broadcast()
      this.state.waitUntil((async () => { await warmUsher(this.env); await this.runBots() })())
      return
    }
    if (m.t === 'expose' && isHost && d.status === 'lobby') {
      const v = Number(m.ms)
      d.exposeMs = v === 0 ? 0 : (Number.isFinite(v) && v > 0 ? Math.max(3000, Math.min(60000, v)) : null)
      await this.save(); this.broadcast(); return
    }

    // The holder asks to be shown the message, which starts their memory window. Gated on a
    // tap so the clock cannot burn down while they are still reading the previous screen.
    if (m.t === 'ready' && d.status === 'running') {
      const holder = d.players[d.turn]
      if (!holder || holder.id !== pid) return
      if (!(d.exposure && d.exposure.turn === d.turn)) {
        d.exposure = { turn: d.turn, playerId: holder.id, shownAt: Date.now(), ms: this.exposureFor(this.handedText()) }
        await this.save()
      }
      this.broadcast(); return   // a reconnect inside the window lands here and gets the text back
    }

    if (m.t === 'pass' && d.status === 'running') {
      const holder = d.players[d.turn]
      if (!holder || holder.id !== pid) return // only the current holder may pass
      const ex = d.exposure
      // You cannot pass on a message you never asked to see.
      if (d.exposeMs !== 0 && !(ex && ex.turn === d.turn)) {
        ws.send(JSON.stringify({ t: 'err', m: 'Tap to see the message first.' })); return
      }
      const text = String(m.text || '').trim().slice(0, 600)
      if (!text) { ws.send(JSON.stringify({ t: 'err', m: 'Write something first.' })); return }
      const num = (v, cap) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(cap, n) : null }
      d.versions.push({ index: d.versions.length + 1, author: holder.name, authorId: holder.id, text, at: Date.now(),
        // Memory mode is a client-side timer, so record what actually happened rather than
        // trusting it: the reveal flags hops that look transcribed instead of recalled.
        exposureMs: ex ? ex.ms : null,
        recallMs: ex && ex.ms ? Math.max(0, Date.now() - (ex.shownAt + ex.ms)) : null,
        typedMs: num(m.typedMs, 900000), pasted: !!m.pasted })
      d.exposure = null
      d.turn++
      if (d.turn >= d.players.length) {
        d.status = 'done'; await this.save(); this.broadcast()
        await this.buildReveal()
      } else { await this.save(); this.broadcast(); this.state.waitUntil(this.runBots()) }
      return
    }
    // Let the current holder look once more — for a genuine misfire, not a second reading.
    if (m.t === 'reshow' && isHost && d.status === 'running') {
      d.exposure = null; await this.save(); this.broadcast(); return
    }

    // Roll back the last hop. A chain poisoned by one person — a troll, or someone who
    // wandered off mid-turn — should cost that turn, not the whole run.
    if (m.t === 'undo' && isHost && (d.status === 'running' || d.status === 'done')) {
      if (!d.versions.length) return
      d.versions.pop()
      d.turn = d.versions.length   // turn and version count advance together, always
      d.status = 'running'
      d.reveal = null; d.revealErr = null; d.exposure = null
      await this.save(); this.broadcast(); return
    }

    if (m.t === 'skip' && isHost && d.status === 'running') {
      const holder = d.players[d.turn]
      if (!holder) return
      const handed = this.handedText()
      d.exposure = null
      d.versions.push({ index: d.versions.length + 1, author: holder.name, authorId: holder.id,
        text: handed, at: Date.now(), skipped: true })
      d.turn++
      if (d.turn >= d.players.length) { d.status = 'done'; await this.save(); this.broadcast(); await this.buildReveal() }
      else { await this.save(); this.broadcast(); this.state.waitUntil(this.runBots()) }
      return
    }
    if (m.t === 'again' && isHost && d.status === 'done') {
      this.data = { ...this.fresh(d.code), players: d.players, hostId: d.hostId, exposeMs: d.exposeMs }
      await this.save(); this.broadcast(); return
    }
  }

  // Confederates take their turns automatically, one after another.
  async runBots() {
    for (let guard = 0; guard < 10; guard++) {
      const d = this.data
      if (d.status !== 'running') return
      const cur = d.players[d.turn]
      if (!cur || !cur.ai) return
      const handed = d.versions.length ? d.versions[d.versions.length - 1].text : d.seed
      const out = await confederate(this.env, cur.ai, handed)
      if (this.data.status !== 'running' || this.data.players[this.data.turn]?.id !== cur.id) return
      const text = out || handed // a dead endpoint must not stall the chain
      this.data.versions.push({ index: this.data.versions.length + 1, author: cur.name,
        authorId: cur.id, text, at: Date.now(), ai: cur.ai, degraded: !out })
      this.data.exposure = null
      this.data.turn++
      if (this.data.turn >= this.data.players.length) {
        this.data.status = 'done'; await this.save(); this.broadcast(); await this.buildReveal(); return
      }
      await this.save(); this.broadcast()
    }
  }

  async buildReveal() {
    const d = this.data
    // Carry the per-version metadata through: the reveal used to drop `ai`, so the tag
    // marking a confederate's turn could never render.
    const chain = [{ author: 'Original', text: d.seed }, ...d.versions.map(v => ({
      author: v.author, text: v.text, ai: v.ai || null,
      skipped: !!v.skipped, degraded: !!v.degraded, pasted: !!v.pasted,
      exposureMs: v.exposureMs ?? null, typedMs: v.typedMs ?? null,
    }))]
    let analysis
    try { analysis = analyzeChain(chain) } catch (e) { d.revealErr = 'analysis failed'; await this.save(); this.broadcast(); return }

    // Memory mode lives in the browser, so measure instead of trusting it. A hop that comes
    // back near-verbatim and was typed faster than anyone composes was copied, not recalled.
    analysis.hops.forEach(h => {
      const v = d.versions[h.index - 1]
      if (!v || v.ai || v.skipped) return
      const fast = v.typedMs > 0 && v.text.length / v.typedMs > 0.025 // ~300wpm, past human
      if (v.pasted) h.suspect = 'pasted'
      else if (h.fidelity >= 92 && fast) h.suspect = 'verbatim'
    })

    d.reveal = { chain, analysis, narration: null, narrating: true }
    await this.save(); this.broadcast()

    // Every stage runs concurrently and publishes the moment it lands, so the group sees the
    // reveal fill in rather than waiting on the slowest call. The container takes 8 at once.
    const lines = analysis.hops.map(h =>
      `${h.index}. ${h.to.author}: ${h.ops.slice(0, 3).map(o => `${o.type} (${o.label})`).join('; ') || 'kept it close'}`
    ).join('\n')
    const publish = async (fn) => { try { await fn() } catch {} }

    // One column per version, at most 8 in flight — the container takes 8, and a 9-player
    // chain used to queue the last call behind the retry backoff of the other eight.
    const columns = async (props, versions) => mapPool(versions, 8, async v => {
      const f = await fates(this.env, props, v.text)
      return { author: v.author, ai: v.ai || null,
        fates: f?.fates || props.map(p => ({ id: p.id, status: 'intact' })),
        invented: f?.invented || [], ok: !!f }
    })

    const flowJob = publish(async () => {
      const props = await decompose(this.env, d.seed)
      if (!props.length) return
      d.reveal.flow = { props, cols: [], pending: true }
      await this.save(); this.broadcast()
      d.reveal.flow = { props, cols: await columns(props, d.versions), pending: false }
      await this.save(); this.broadcast()

      // After a break, the rest of the chain is retelling a different message. Scoring it
      // against the seed's claims marks every ribbon dropped and hides whatever the chain
      // actually did afterwards — so run a second diagram from where it restarted.
      const rb = analysis.rebaseFrom
      if (rb > 0 && d.versions.length - rb >= 2) {
        const rprops = await decompose(this.env, chain[rb].text)
        if (!rprops.length) return
        const rest = d.versions.slice(rb)
        d.reveal.flow.rebase = { at: rb, author: chain[rb].author, props: rprops, cols: [], pending: true }
        await this.save(); this.broadcast()
        d.reveal.flow.rebase = { at: rb, author: chain[rb].author, props: rprops,
          cols: await columns(rprops, rest), pending: false }
        await this.save(); this.broadcast()
      }
    })

    const abdJob = publish(async () => {
      const b = analysis.biggestMutation
      // A snapped chain is not a memory distortion, so there is no mechanism to abduce.
      if (!b || b.isBreak) return
      const h = analysis.hops.find(x => x.index === b.index)
      if (!h) return
      const a = await abduce(this.env, h.from.text, h.to.text, h.ops.slice(0, 2).map(o => o.label).join('; '))
      if (a) { d.reveal.abduction = { ...a, author: b.author }; await this.save(); this.broadcast() }
    })

    const narrJob = publish(async () => {
      const n = await narrateReveal(this.env, { original: d.seed, final: chain[chain.length - 1].text,
        chainSummary: { hops: d.versions.length, lines }, fidelity: analysis.fidelity })
      if (n) { d.reveal.narration = n; await this.save(); this.broadcast() }
    })

    await Promise.all([flowJob, abdJob, narrJob])
    d.reveal.narrating = false
    await this.save(); this.broadcast()
  }

  async webSocketClose(ws) { this.sessions.delete(ws) }
  async webSocketError(ws) { this.sessions.delete(ws) }
}
