// Node host for the same game.
//
// The Room class in src/worker.js is written against a small slice of the Durable Object
// API, so rather than forking the game logic for a second platform, this provides that
// slice: per-room storage, a socket set, and the serializeAttachment/waitUntil helpers.
// Room is imported and run unchanged, which is the point — blinding, turn order, the
// memory window and the reveal have exactly one implementation.
//
// The one thing this cannot reproduce is durability. A Durable Object persists rooms and
// survives eviction; here they live in the process, so a redeploy or crash drops games in
// flight. See the note in README-RAILWAY.md.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { Room } from '../src/worker.js'

const PORT = Number(process.env.PORT) || 8080
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url))
// Pass every USHER_* variable through rather than naming them one by one. Listing them
// individually already cost one silent outage: USHER_MODEL was missing here, so usher.js
// fell back to the default slug and every model call 400'd into the retry loop.
const env = {
  USHER_BASE: 'https://kalebautomates--usher-usher-serve.modal.run/v1',
  USHER_KEY: '',
  ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('USHER_') && v)),
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no I/L/O/0/1
const makeCode = (len = 4) =>
  Array.from(crypto.getRandomValues(new Uint8Array(len)), x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('')

// ---- the Durable Object slice Room actually uses ----------------------------
class RoomHost {
  constructor() {
    this.map = new Map()
    this.sockets = new Set()
    this.storage = {
      get: async k => this.map.get(k),
      put: async (k, v) => { this.map.set(k, v) },
    }
  }
  blockConcurrencyWhile(fn) { return fn() }
  acceptWebSocket(ws) { this.sockets.add(ws) }
  getWebSockets() { return [...this.sockets] }
  // On Workers this keeps the isolate alive past the response; here the process is
  // already long-lived, so the promise only needs its rejection swallowed.
  waitUntil(p) { Promise.resolve(p).catch(() => {}) }
}

const rooms = new Map()
function roomFor(code) {
  let r = rooms.get(code)
  if (!r) {
    const host = new RoomHost()
    // Seed storage before constructing. Room's constructor loads `data` inside
    // blockConcurrencyWhile, which resolves a microtask after the constructor returns —
    // so assigning room.data afterwards would just be overwritten by that load.
    host.map.set('data', Room.prototype.fresh.call({}, code))
    r = { host, room: new Room(host, env), touched: Date.now() }
    rooms.set(code, r)
  }
  r.touched = Date.now()
  return r
}

// Rooms are in memory, so without this a long-running instance leaks every game ever
// played. An hour idle is well past the end of any real session.
const ROOM_TTL = 60 * 60 * 1000
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL
  for (const [code, r] of rooms) if (r.touched < cutoff && r.host.sockets.size === 0) rooms.delete(code)
}, 5 * 60 * 1000).unref()

// ---- static assets ----------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

async function serveStatic(req, res, pathname) {
  // normalize + prefix check: no path can escape public/.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(PUBLIC, rel)
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'text/plain', 'forbidden')
  try {
    const s = await stat(file)
    if (s.isDirectory()) file = join(file, 'index.html')
  } catch {
    file = join(PUBLIC, 'index.html')   // SPA fallback, matching not_found_handling
  }
  try {
    const body = await readFile(file)
    const type = TYPES[extname(file)] || 'application/octet-stream'
    // Never let a browser hold a stale index.html against a new app.js.
    const cache = type.startsWith('text/html') ? 'no-store, must-revalidate' : 'public, max-age=3600'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache })
    res.end(body)
  } catch {
    send(res, 404, 'text/plain', 'not found')
  }
}

const send = (res, status, type, body) => {
  res.writeHead(status, { 'Content-Type': type })
  res.end(body)
}
const json = (res, obj, status = 200) => send(res, status, 'application/json', JSON.stringify(obj))

// ---- http -------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  if (p === '/api/new') {
    for (let i = 0; i < 6; i++) {
      const code = makeCode(i < 4 ? 4 : 5)
      if (!rooms.has(code)) { roomFor(code); return json(res, { code }) }
    }
    return json(res, { error: 'could not allocate a room, try again' }, 503)
  }

  if (p === '/api/health') {
    // The /health probe only means anything on the Modal deployment; a generic
    // OpenAI-compatible host has no such route, so report the config too rather than
    // leaving "cold" as the single ambiguous signal.
    const r = await fetch(env.USHER_BASE.replace(/\/v1$/, '') + '/health').catch(() => null)
    return json(res, {
      worker: 'ok', rooms: rooms.size,
      key: env.USHER_KEY ? 'set' : 'missing',
      base: env.USHER_BASE,
      modelSlug: env.USHER_MODEL || 'usher (default)',
      model: r && r.ok ? await r.json().catch(() => null) : 'no /health on this host',
    })
  }

  if (p.startsWith('/api/room/')) {
    const code = (p.split('/')[3] || '').toUpperCase()
    const r = rooms.get(code)
    // data lands a microtask after construction; a probe in that window is a miss, not a 500.
    const d = r?.room?.data
    if (!d) return json(res, { error: 'no room' }, 404)
    return json(res, { exists: true, status: d.status, players: d.players.length })
  }

  return serveStatic(req, res, p)
})

// ---- websockets -------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  const m = pathname.match(/^\/ws\/([A-Za-z0-9]{3,8})$/)
  if (!m) { socket.destroy(); return }
  const code = m[1].toUpperCase()
  wss.handleUpgrade(req, socket, head, ws => {
    const { host, room } = roomFor(code)
    // Room stores per-connection identity through these; on Workers they survive
    // hibernation, here they are just a property on the socket.
    let attachment = {}
    ws.serializeAttachment = v => { attachment = v }
    ws.deserializeAttachment = () => attachment
    host.acceptWebSocket(ws)

    ws.on('message', raw => {
      Promise.resolve(room.webSocketMessage(ws, raw.toString())).catch(e =>
        console.error('room error', code, e))
    })
    const drop = () => { host.sockets.delete(ws); room.webSocketClose?.(ws) }
    ws.on('close', drop)
    ws.on('error', drop)
  })
})

server.listen(PORT, () => console.log(`stemma listening on :${PORT}`))

const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref() }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
