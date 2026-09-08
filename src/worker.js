import { analyzeChain } from './drift.js'
import { narrateReveal, seedMessage, warmUsher, decompose, fates, confederate, abduce, PERSONAS } from './usher.js'

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
      const code = makeCode()
      const id = env.ROOM.idFromName(code)
      await env.ROOM.get(id).fetch(new Request('https://do/init?code=' + code, { method: 'POST' }))
      return json({ code })
    }
    if (p.startsWith('/api/room/') || p.startsWith('/ws/')) {
      const code = (p.split('/')[p.startsWith('/ws/') ? 2 : 3] || '').toUpperCase()
      if (!/^[A-Z0-9]{3,8}$/.test(code)) return json({ error: 'bad code' }, 400)
      const stub = env.ROOM.get(env.ROOM.idFromName(code))
      return stub.fetch(new Request('https://do' + p + url.search, req))
    }
    if (p === '/api/health') {
      const r = await fetch(env.USHER_BASE.replace(/\/v1$/, '') + '/health').catch(() => null)
      return json({ worker: 'ok', model: r && r.ok ? await r.json().catch(() => null) : 'cold' })
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
      players: [], // {id,name,order}
      seed: '', versions: [], // {index, author, authorId, text, at}
      turn: 0, reveal: null, revealErr: null,
    }
  }

  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname

    if (p === '/init') {
      if (!this.data) { this.data = this.fresh(url.searchParams.get('code') || 'ROOM'); await this.save() }
      return json({ ok: true })
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

  // ---- blinding ------------------------------------------------------------
  // The single most important function here. A player may only ever receive the text
  // handed to them. Not the seed, not earlier links, not the live chain — until reveal.
  viewFor(playerId) {
    const d = this.data
    const me = d.players.find(x => x.id === playerId) || null
    const isHost = playerId && playerId === d.hostId
    const holder = d.status === 'running' ? d.players[d.turn] : null
    const myTurn = !!(holder && me && holder.id === me.id)

    const base = {
      code: d.code, status: d.status, isHost, you: me,
      players: d.players.map(x => ({ id: x.id, name: x.name, ai: x.ai || null })),
      turn: d.turn, total: d.players.length,
      holder: holder ? { id: holder.id, name: holder.name } : null,
      passed: d.versions.length,
      hasSeed: !!d.seed,
    }
    if (d.status === 'running') {
      // handed = what THIS player must retell. Nobody else can see it.
      base.handed = myTurn ? (d.versions.length ? d.versions[d.versions.length - 1].text : d.seed) : null
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
      let pid = String(m.playerId || '').slice(0, 40)
      let pl = d.players.find(x => x.id === pid)
      if (!pl) {
        if (d.status !== 'lobby') { // late joiner: let them watch, not play
          ws.serializeAttachment({ playerId: null })
          ws.send(JSON.stringify({ t: 'state', v: this.viewFor(null) })); return
        }
        pid = pid || crypto.randomUUID()
        pl = { id: pid, name }
        d.players.push(pl)
        if (!d.hostId) d.hostId = pid
      } else { pl.name = name }
      ws.serializeAttachment({ playerId: pl.id })
      await this.save()
      ws.send(JSON.stringify({ t: 'you', playerId: pl.id }))
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
    if (m.t === 'pass' && d.status === 'running') {
      const holder = d.players[d.turn]
      if (!holder || holder.id !== pid) return // only the current holder may pass
      const text = String(m.text || '').trim().slice(0, 600)
      if (!text) { ws.send(JSON.stringify({ t: 'err', m: 'Write something first.' })); return }
      d.versions.push({ index: d.versions.length + 1, author: holder.name, authorId: holder.id, text, at: Date.now() })
      d.turn++
      if (d.turn >= d.players.length) {
        d.status = 'done'; await this.save(); this.broadcast()
        await this.buildReveal()
      } else { await this.save(); this.broadcast(); this.state.waitUntil(this.runBots()) }
      return
    }
    if (m.t === 'skip' && isHost && d.status === 'running') {
      const holder = d.players[d.turn]
      if (!holder) return
      const handed = d.versions.length ? d.versions[d.versions.length - 1].text : d.seed
      d.versions.push({ index: d.versions.length + 1, author: holder.name, authorId: holder.id,
        text: handed, at: Date.now(), skipped: true })
      d.turn++
      if (d.turn >= d.players.length) { d.status = 'done'; await this.save(); this.broadcast(); await this.buildReveal() }
      else { await this.save(); this.broadcast(); this.state.waitUntil(this.runBots()) }
      return
    }
    if (m.t === 'again' && isHost && d.status === 'done') {
      this.data = { ...this.fresh(d.code), players: d.players, hostId: d.hostId }
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
      this.data.turn++
      if (this.data.turn >= this.data.players.length) {
        this.data.status = 'done'; await this.save(); this.broadcast(); await this.buildReveal(); return
      }
      await this.save(); this.broadcast()
    }
  }

  async buildReveal() {
    const d = this.data
    const chain = [{ author: 'Original', text: d.seed }, ...d.versions.map(v => ({ author: v.author, text: v.text }))]
    let analysis
    try { analysis = analyzeChain(chain) } catch (e) { d.revealErr = 'analysis failed'; await this.save(); this.broadcast(); return }
    d.reveal = { chain, analysis, narration: null, narrating: true }
    await this.save(); this.broadcast()

    // Every stage runs concurrently and publishes the moment it lands, so the group sees the
    // reveal fill in rather than waiting on the slowest call. The container takes 8 at once.
    const lines = analysis.hops.map(h =>
      `${h.index}. ${h.to.author}: ${h.ops.slice(0, 3).map(o => `${o.type} (${o.label})`).join('; ') || 'kept it close'}`
    ).join('\n')
    const publish = async (fn) => { try { await fn() } catch {} }

    const flowJob = publish(async () => {
      const props = await decompose(this.env, d.seed)
      if (!props.length) return
      d.reveal.flow = { props, cols: [], pending: true }
      await this.save(); this.broadcast()
      const cols = await Promise.all(d.versions.map(async v => {
        const f = await fates(this.env, props, v.text)
        return { author: v.author, ai: v.ai || null,
          fates: f?.fates || props.map(p => ({ id: p.id, status: 'intact' })),
          invented: f?.invented || [], ok: !!f }
      }))
      d.reveal.flow = { props, cols, pending: false }
      await this.save(); this.broadcast()
    })

    const abdJob = publish(async () => {
      const b = analysis.biggestMutation
      if (!b) return
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
