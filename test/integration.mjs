// End-to-end run against a live `wrangler dev`: start the server, then `pnpm test:e2e`.
// Covers the things unit tests cannot — seat hijacking, the memory window surviving a
// reload, and the reveal a real chain actually produces.
import assert from 'node:assert/strict'
const BASE = 'http://localhost:8787'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0
const ok = (label) => { pass++; console.log('  ok  ' + label) }

class Client {
  constructor(code, name) { this.code = code; this.name = name; this.states = []; this.errs = [] }
  connect(seat = { id: '', token: '' }) {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://localhost:8787/ws/${this.code}`)
      this.ws.onmessage = e => {
        const m = JSON.parse(e.data)
        if (m.t === 'you') { this.id = m.playerId; this.token = m.token }
        if (m.t === 'state') { this.state = m.v; this.states.push(m.v); if (this._w) { this._w(); this._w = null } }
        if (m.t === 'err') this.errs.push(m.m)
      }
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ t: 'join', name: this.name, playerId: seat.id, token: seat.token }))
        setTimeout(res, 350)
      }
      this.ws.onerror = rej
    })
  }
  send(o) { this.ws.send(JSON.stringify(o)); return sleep(300) }
  close() { try { this.ws.close() } catch {} }
}

const { code } = await (await fetch(BASE + '/api/new', { method: 'POST' })).json()
console.log('room', code)

const host = new Client(code, 'Host'); await host.connect()
const p2 = new Client(code, 'Bea'); await p2.connect()
await sleep(300)

// ---- lobby blinding ---------------------------------------------------------
console.log('\nlobby')
await host.send({ t: 'seed', text: 'Marcus left twelve boxes of pastries at the bakery on Tuesday morning.' })
assert.ok(host.state.seed, 'host sees the seed they are composing')
ok('host can see the seed they are writing')
assert.equal(p2.state.seed, undefined)
ok('another player never receives the seed')

// ---- the attack this build used to allow ------------------------------------
console.log('\nseat hijack')
const hostId = p2.state.players.find(x => x.name === 'Host').id
assert.ok(hostId, "the host's id is broadcast in the roster, as the UI needs")
const attacker = new Client(code, 'Mallory')
await attacker.connect({ id: hostId, token: '' })   // id read straight off the wire
assert.ok(attacker.errs.some(e => /seat is taken/i.test(e)))
ok('claiming a seat by id alone is refused')
assert.equal(attacker.state.seed, undefined)
ok('the hijack attempt is not handed the seed')
assert.equal(attacker.state.isHost, false)
ok('the hijack attempt does not become host')
assert.ok(!attacker.state.players.some(x => x.token))
ok('no token is ever present in a broadcast roster')

// ---- memory window ----------------------------------------------------------
console.log('\nmemory window')
await host.send({ t: 'expose', ms: 3000 })
await host.send({ t: 'start' })
assert.equal(host.state.status, 'running')
assert.equal(host.state.handed, null)
ok('the message is not sent before the holder asks to see it')

await host.send({ t: 'pass', text: 'trying to skip ahead' })
assert.ok(host.errs.some(e => /Tap to see/i.test(e)))
ok('you cannot pass on a message you never asked to see')

await host.send({ t: 'ready' })
assert.ok(host.state.handed?.includes('Marcus'), 'holder gets the text')
assert.equal(host.state.exposure.live, true)
ok('asking to see it starts the window and delivers the text')
assert.equal(p2.state.handed, null)
ok('nobody else receives it, even while it is on screen')

// reload inside the window: the socket is new, the seat token is the same
const reload1 = new Client(code, 'Host')
await reload1.connect({ id: host.id, token: host.token })
assert.ok(reload1.state.handed?.includes('Marcus'))
ok('reconnecting inside the window gets the message back')
reload1.close()

await sleep(4200)   // window closes, plus the reconnect grace

const reload2 = new Client(code, 'Host')
await reload2.connect({ id: host.id, token: host.token })
assert.equal(reload2.state.handed, null)
assert.equal(reload2.state.handedExpired, true)
ok('reloading after the window does NOT hand the message back')
reload2.close()

await host.send({ t: 'pass', text: 'Marcus dropped a dozen boxes at the bakery Tuesday.', typedMs: 9000 })
assert.equal(host.state.turn, 1)
ok('the holder can still pass from memory once the window has closed')

// ---- a poisoned link and the recovery controls ------------------------------
console.log('\nchain break + host recovery')
await p2.send({ t: 'ready' })
await p2.send({ t: 'pass', text: 'the tide charts for Ipswich harbour are printed wrong again', typedMs: 8000 })
assert.equal(p2.state.status, 'done')
const A = p2.state.reveal.analysis
assert.equal(A.breaks.length, 1)
assert.equal(A.breaks[0].author, 'Bea')
ok('the off-script turn is flagged as a chain break')
assert.ok(A.fidelityRebased >= A.fidelity)
ok('a re-baselined fidelity is reported alongside the raw one')
assert.equal(p2.state.reveal.chain[1].ai, null)
assert.ok('exposureMs' in p2.state.reveal.chain[1])
ok('per-version metadata reaches the reveal (the dropped `ai` field is carried again)')

await host.send({ t: 'undo' })
assert.equal(host.state.status, 'running')
assert.equal(host.state.turn, 1)
assert.equal(host.state.passed, 1)
ok('the host can roll the poisoned turn back and replay it')

console.log(`\n${pass} assertions passed`)
process.exit(0)
