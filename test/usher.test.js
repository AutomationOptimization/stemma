import test from 'node:test'
import assert from 'node:assert/strict'
import { looseJson, mapPool } from '../src/usher.js'

// ---- looseJson: the 7B fences, chats, and trails commas ----------------------

test('looseJson parses clean JSON', () => {
  assert.deepEqual(looseJson('{"a":1}'), { a: 1 })
})

test('looseJson unwraps a fenced block', () => {
  assert.deepEqual(looseJson('```json\n{"a":1}\n```'), { a: 1 })
})

test('looseJson ignores chatter either side', () => {
  assert.deepEqual(looseJson('Sure! Here you go: {"a":1} Hope that helps.'), { a: 1 })
})

test('looseJson tolerates a trailing comma', () => {
  assert.deepEqual(looseJson('{"a":1,"b":[2,3,],}'), { a: 1, b: [2, 3] })
})

test('looseJson falls back to single quotes', () => {
  assert.deepEqual(looseJson("{'a':1}"), { a: 1 })
})

test('looseJson returns null rather than throwing on junk', () => {
  for (const v of ['', null, undefined, 'no json here', '{"a":']) assert.equal(looseJson(v), null)
})

// ---- mapPool ----------------------------------------------------------------

test('mapPool preserves input order', async () => {
  const out = await mapPool([5, 1, 4, 2, 3], 2, async n => {
    await new Promise(r => setTimeout(r, n))
    return n * 10
  })
  assert.deepEqual(out, [50, 10, 40, 20, 30])
})

test('mapPool never exceeds its concurrency limit', async () => {
  let live = 0, peak = 0
  await mapPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
    peak = Math.max(peak, ++live)
    await new Promise(r => setTimeout(r, 2))
    live--
  })
  assert.equal(peak, 3)
})

test('mapPool handles an empty list without hanging', async () => {
  assert.deepEqual(await mapPool([], 8, async x => x), [])
})
