import test from 'node:test'
import assert from 'node:assert/strict'
import {
  tokenize, similarity, diffWords, analyzeHop, analyzeChain, findBreaks, segmentsOf,
} from '../src/drift.js'

const ops = (a, b, type) => analyzeHop(a, b).ops.filter(o => !type || o.type === type)
const labels = (a, b, type) => ops(a, b, type).map(o => o.label)
const chain = (...texts) => analyzeChain(texts.map((text, i) => ({ author: i ? 'P' + i : 'Original', text })))

// ---- tokenizing -------------------------------------------------------------

test('tokenize lowercases, keeps digits, folds curly apostrophes', () => {
  assert.deepEqual(tokenize("Marcus didn’t buy 12 apples!"), ['marcus', "didn't", 'buy', '12', 'apples'])
})

test('tokenize is total on empty and nullish input', () => {
  for (const v of ['', null, undefined]) assert.deepEqual(tokenize(v), [])
})

// ---- similarity -------------------------------------------------------------

test('similarity is 100 for identical text and low for unrelated text', () => {
  const s = 'Marcus left twelve boxes at the bakery on Tuesday.'
  assert.equal(similarity(s, s).fidelity, 100)
  assert.ok(similarity(s, 'The tide charts for Ipswich are wrong again.').fidelity < 30)
})

test('similarity is symmetric', () => {
  const a = 'Anna found nine keys in the shed.'
  const b = 'Anna found some keys somewhere.'
  assert.equal(similarity(a, b).fidelity, similarity(b, a).fidelity)
})

test('similarity ranks a paraphrase above a rewrite', () => {
  const orig = 'Marcus left twelve boxes at the bakery on Tuesday.'
  const para = 'Marcus left 12 boxes at the bakery on Tuesday.'
  const rewrite = 'Someone dropped off a delivery somewhere last week.'
  assert.ok(similarity(orig, para).fidelity > similarity(orig, rewrite).fidelity)
})

// ---- word diff --------------------------------------------------------------

test('diffWords marks only the changed span', () => {
  const d = diffWords('the cat sat down', 'the dog sat down')
  assert.deepEqual(d.filter(t => t.op === 'del').map(t => t.raw), ['cat'])
  assert.deepEqual(d.filter(t => t.op === 'add').map(t => t.raw), ['dog'])
  assert.deepEqual(d.filter(t => t.op === 'same').map(t => t.raw), ['the', 'sat', 'down'])
})

test('diffWords reconstructs both sides exactly', () => {
  const a = 'Anna brought nine keys', b = 'Anna brought a dozen keys today'
  const d = diffWords(a, b)
  const side = skip => d.filter(t => t.op !== skip).map(t => t.raw).join(' ')
  assert.equal(side('add'), a)
  assert.equal(side('del'), b)
})

test('diffWords survives a paste bomb without quadratic blowup', () => {
  const big = 'word '.repeat(4000)
  const d = diffWords(big, big + 'tail')
  assert.ok(d.length > 0)
})

// ---- proper nouns (regression: sentence-opener false positives) --------------

test('a name lost mid-sentence is reported', () => {
  assert.ok(labels('Marcus paid the bill.', 'He paid the bill.').some(l => /lost the name "Marcus"/.test(l)))
})

test('a time word opening a later sentence is not a name', () => {
  // Regression: the old guard only checked word index 0, so "Yesterday" opening the
  // second sentence was counted as a proper noun and reported as a lost name.
  const a = 'The shop was shut. Yesterday she tried again.'
  const b = 'The shop was shut. She tried again.'
  assert.deepEqual(labels(a, b).filter(l => /lost the name/.test(l)), [])
})

test('a name is still found when it only ever opens sentences', () => {
  const a = 'Marcus paid the bill. Marcus left.'
  const b = 'He paid the bill. He left.'
  assert.ok(labels(a, b).some(l => /lost the name "Marcus"/.test(l)))
})

test('a name invented downstream is reported', () => {
  assert.ok(labels('Someone paid the bill.', 'Marcus paid the bill.', 'invention')
    .some(l => /named "Marcus"/.test(l)))
})

// ---- numbers ----------------------------------------------------------------

test('digits and number words are the same claim', () => {
  assert.deepEqual(analyzeHop('he brought 12 crates', 'he brought twelve crates').numChanged, [])
})

test('two vanished numbers do not both claim the same replacement', () => {
  // Regression: `near` was recomputed identically each iteration, so 3 and 7 both
  // reported as becoming 50.
  const { numChanged } = analyzeHop('3 dogs and 7 cats', '50 dogs and 60 cats')
  const tos = numChanged.map(c => c.to).filter(Boolean)
  assert.equal(new Set(tos).size, tos.length, 'each replacement is claimed at most once')
  assert.equal(numChanged.length, 2)
})

test('a number vanishing with no replacement levels', () => {
  const { numChanged } = analyzeHop('she saw 40 birds', 'she saw some birds')
  assert.deepEqual(numChanged, [{ from: '40', to: null }])
  assert.ok(labels('she saw 40 birds', 'she saw some birds', 'leveling').some(l => /40 vanished/.test(l)))
})

test('a number appearing from nowhere is an invention', () => {
  const { numChanged } = analyzeHop('she saw some birds', 'she saw 40 birds')
  assert.deepEqual(numChanged, [{ from: null, to: '40' }])
})

// ---- Bartlett signals -------------------------------------------------------

test('climbing an intensity ladder is sharpening', () => {
  assert.ok(labels('a bunch of people showed up', 'dozens of people showed up', 'sharpening').length)
})

test('descending an intensity ladder is leveling', () => {
  assert.ok(labels('dozens of people showed up', 'a bunch of people showed up', 'leveling').length)
})

test('a negation flip is assimilation and outranks noise', () => {
  const o = ops('the alarm was working', 'the alarm was not working', 'assimilation')
  assert.ok(o.length)
  assert.ok(o[0].weight >= 0.8)
})

test('dropping a hedge is sharpening, adding one is leveling', () => {
  assert.ok(labels('apparently the road is shut', 'the road is shut', 'sharpening')
    .some(l => /hedging removed/.test(l)))
  assert.ok(labels('the road is shut', 'apparently the road is shut', 'leveling')
    .some(l => /hedging added/.test(l)))
})

test('heavy compression levels', () => {
  const a = 'Marcus left twelve boxes of pastries at the bakery on Tuesday morning before the rain.'
  assert.ok(labels(a, 'Marcus dropped off some boxes.', 'leveling').length)
})

test('a faithful hop produces no ops and near-full fidelity', () => {
  const s = 'Anna found nine keys in the garden shed.'
  const h = analyzeHop(s, s)
  assert.deepEqual(h.ops, [])
  assert.equal(h.fidelity, 100)
})

test('invention is judged against the original, not just the previous hop', () => {
  // "bakery" returning after being dropped is a recovery, not a fabrication.
  const orig = 'Marcus left boxes at the bakery.'
  assert.ok(!analyzeHop('Marcus left boxes somewhere.', 'Marcus left boxes at the bakery.', orig)
    .invented.includes('bakery'))
  assert.ok(analyzeHop('Marcus left boxes somewhere.', 'Marcus left boxes at the casino.', orig)
    .invented.includes('casino'))
})

test('ops are ordered by weight and capped', () => {
  const h = analyzeHop('Marcus told Anna that 12 of the 40 boxes at the bakery were fine',
    'not a single one of the hundreds of crates in Ipswich was any good, Priya screamed')
  assert.ok(h.ops.length <= 8)
  for (let i = 1; i < h.ops.length; i++) assert.ok(h.ops[i - 1].weight >= h.ops[i].weight)
})

// ---- chain rollup -----------------------------------------------------------

test('an unbroken chain reports no breaks and rebases to the original', () => {
  const a = chain(
    'Marcus left twelve boxes of pastries at the bakery on Tuesday.',
    'Marcus left twelve boxes of pastries at the bakery on Tuesday morning.',
    'Marcus left a dozen boxes of pastries at the bakery on Tuesday.',
    'Marcus left about a dozen pastry boxes at the bakery Tuesday.')
  assert.deepEqual(a.breaks, [])
  assert.equal(a.rebaseFrom, 0)
  assert.equal(a.fidelityRebased, a.fidelity)
  assert.equal(a.segments.length, 1)
})

test('the decay curve starts at 100 and has one point per version', () => {
  const a = chain('one two three four five', 'one two three four', 'one two three')
  assert.equal(a.curve.length, 3)
  assert.equal(a.curve[0].fidelity, 100)
  assert.equal(a.curve[0].segFidelity, 100)
  assert.ok(a.curve[2].fidelity <= a.curve[1].fidelity)
})

test('a wholly unrelated hop is flagged as a break', () => {
  const a = chain(
    'Marcus left twelve boxes of pastries at the bakery on Tuesday.',
    'Marcus left twelve boxes of pastries at the bakery Tuesday.',
    'the tide charts for Ipswich harbour are printed wrong again',
    'the tide charts for Ipswich harbour are wrong again this year')
  assert.equal(a.breaks.length, 1)
  assert.equal(a.breaks[0].index, 2)
  assert.equal(a.breaks[0].reason, 'unrecognizable')
})

test('re-baselining rescues the measurement after a break', () => {
  const a = chain(
    'Marcus left twelve boxes of pastries at the bakery on Tuesday.',
    'Marcus left twelve boxes of pastries at the bakery Tuesday.',
    'the tide charts for Ipswich harbour are printed wrong again',
    'the tide charts for Ipswich harbour are wrong again this year')
  assert.equal(a.rebaseFrom, 2)
  // Against the original everything after the break looks destroyed; against the text
  // the chain actually restarted from, the last stretch clearly held together.
  assert.ok(a.fidelityRebased > a.fidelity + 30)
  assert.ok(a.curve[3].segFidelity > a.curve[3].fidelity + 30)
})

test('breaks split the chain into per-run segments', () => {
  const a = chain(
    'Marcus left twelve boxes of pastries at the bakery on Tuesday.',
    'Marcus left twelve boxes of pastries at the bakery Tuesday.',
    'the tide charts for Ipswich harbour are printed wrong again',
    'the tide charts for Ipswich harbour are wrong again this year')
  assert.deepEqual(a.segments.map(s => [s.from, s.to]), [[0, 1], [2, 3]])
  assert.ok(a.segments.every(s => s.fidelity > 60))
})

test('the biggest mutation skips the break and names the real distortion', () => {
  // The break is already reported on its own. Letting it win "biggest mutation" too would
  // bury the largest thing memory actually did to the message.
  const a = chain(
    'Marcus left twelve boxes of pastries at the bakery on Tuesday.',
    'Marcus left twelve boxes of pastries at the bakery Tuesday.',
    'the tide charts for Ipswich harbour are printed wrong again',
    'the tide charts for Ipswich harbour are wrong again this year')
  assert.equal(a.breaks[0].index, 2)
  assert.notEqual(a.biggestMutation.index, 2)
  assert.equal(a.biggestMutation.isBreak, false)
})

test('when every hop is a break the biggest mutation still resolves', () => {
  const a = chain(
    'Marcus left twelve boxes of pastries at the bakery on Tuesday.',
    'the tide charts for Ipswich harbour are printed wrong',
    'rhubarb futures collapsed in Osaka overnight')
  assert.ok(a.biggestMutation)
  assert.equal(a.biggestMutation.isBreak, true)
})

test('ordinary drift is not mistaken for a break', () => {
  const a = chain(
    'Marcus left twelve boxes of pastries at the bakery on Tuesday.',
    'Marcus left a dozen boxes of pastries at the bakery Tuesday.',
    'Marcus dropped off a dozen pastry boxes at the bakery.',
    'Marcus dropped off some pastries at the bakery.',
    'someone dropped off pastries at the bakery.')
  assert.deepEqual(a.breaks, [])
  assert.equal(a.biggestMutation.isBreak, false)
})

// ---- break helpers in isolation ---------------------------------------------

test('findBreaks needs three hops before trusting the outlier test', () => {
  const hop = (index, severity, fidelity) => ({ index, severity, fidelity, to: { author: 'P' + index } })
  assert.deepEqual(findBreaks([hop(1, 10, 90), hop(2, 95, 40)]), [])
  const found = findBreaks([hop(1, 10, 90), hop(2, 12, 88), hop(3, 95, 40), hop(4, 11, 89)])
  assert.equal(found.length, 1)
  assert.equal(found[0].index, 3)
  assert.equal(found[0].reason, 'outlier')
})

test('findBreaks is empty on an empty chain', () => {
  assert.deepEqual(findBreaks([]), [])
})

test('segmentsOf drops runs with no hops in them', () => {
  // Back-to-back breaks leave no measurable run between them.
  const segs = segmentsOf(['a', 'b', 'c', 'd'], [{ index: 1 }, { index: 2 }])
  assert.deepEqual(segs.map(s => [s.from, s.to]), [[2, 3]])
})

test('segmentsOf on an unbroken chain is one span end to end', () => {
  assert.deepEqual(segmentsOf(['a', 'b', 'c'], []).map(s => [s.from, s.to]), [[0, 2]])
})
