import test from 'node:test'
import assert from 'node:assert/strict'
import { sampleShowcasePrizes } from '../src/showcase-prizes.js'
import { prizeView } from '../src/presenters.js'

test('showcase sampling uses its own weight, excludes zero weights, and never samples a prize twice', () => {
  const prizes = [
    { id: 'hidden', showcaseWeight: 0, weight: 99999 },
    { id: 'small', showcaseWeight: 1, weight: 99999 },
    { id: 'large', showcaseWeight: 3, weight: 1 },
    { id: 'legacy' }
  ]
  // 0.3 * 5 lands in the large prize's interval, regardless of draw weight.
  assert.equal(sampleShowcasePrizes(prizes, 1, () => 0.3)[0].id, 'large')
  const selected = sampleShowcasePrizes(prizes, 6, () => 0.3)
  assert.deepEqual(selected.map(prize => prize.id).sort(), ['large', 'legacy', 'small'])
  assert.equal(prizes.length, 4)
  assert.deepEqual(sampleShowcasePrizes([{ id: 'hidden', showcaseWeight: 0 }]), [])
})

test('showcase samples are capped at five while all positive candidates remain selectable', () => {
  const prizes = Array.from({ length: 10 }, (_, index) => ({ id: index, showcaseWeight: 1 }))
  assert.deepEqual(sampleShowcasePrizes(prizes, 5, () => 0).map(prize => prize.id), [0, 1, 2, 3, 4])
  assert.deepEqual(sampleShowcasePrizes(prizes, 5, () => 0.999999).map(prize => prize.id), [9, 8, 7, 6, 5])
})

test('a sixth candidate can be omitted, so low-weight showcase prizes are genuinely occasional', () => {
  const prizes = Array.from({ length: 6 }, (_, index) => ({ id: index, showcaseWeight: 1 }))
  const selected = sampleShowcasePrizes(prizes, 5, () => 0)
  assert.equal(selected.length, 5)
  assert.equal(selected.some(prize => prize.id === 5), false)
})

test('admin prize views preserve display settings while public views omit operational fields', () => {
  const row = { id: 'display', value_cents: 1000, status: 'active', display_only: 1, showcase_weight: '2.5000', weight: '5.0000', stock: 12 }
  const admin = prizeView(row)
  assert.equal(admin.displayOnly, true)
  assert.equal(admin.showcaseWeight, 2.5)
  const publicPrize = prizeView(row, true)
  for (const key of ['displayOnly', 'showcaseWeight', 'weight', 'stock']) assert.equal(key in publicPrize, false)
  assert.equal(prizeView({ value_cents: 0 }).displayOnly, false)
  assert.equal(prizeView({ value_cents: 0 }).showcaseWeight, 1)
})
