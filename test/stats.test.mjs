import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildCellDistribution,
  compareCellSets,
  jensenShannonDivergence,
  median,
  shannonEntropyBits,
  splitHalfJsd,
} from '../dist/stats.js'

function almostEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected} (±${epsilon})`,
  )
}

test('entropy: uniform over 4 outcomes is 2 bits, point mass is 0', () => {
  almostEqual(shannonEntropyBits({ a: 1, b: 1, c: 1, d: 1 }), 2)
  almostEqual(shannonEntropyBits({ a: 10 }), 0)
  almostEqual(shannonEntropyBits({}), 0)
})

test('JSD: identical distributions → 0', () => {
  almostEqual(jensenShannonDivergence({ a: 3, b: 1 }, { a: 6, b: 2 }), 0)
})

test('JSD: disjoint distributions → 1 bit', () => {
  almostEqual(jensenShannonDivergence({ a: 5 }, { b: 7 }), 1)
})

test('JSD: known hand-computed value', () => {
  // P = (1, 0), Q = (0.5, 0.5), M = (0.75, 0.25)
  // JSD = H(M) − (H(P)+H(Q))/2 = 0.8112781245 − 0.5 = 0.3112781245
  almostEqual(jensenShannonDivergence({ a: 4 }, { a: 2, b: 2 }), 0.31127812445913294, 1e-12)
})

test('JSD is symmetric and count-scale invariant', () => {
  const p = { x: 3, y: 9, z: 1 }
  const q = { x: 5, y: 2 }
  almostEqual(jensenShannonDivergence(p, q), jensenShannonDivergence(q, p))
  almostEqual(
    jensenShannonDivergence(p, q),
    jensenShannonDivergence({ x: 30, y: 90, z: 10 }, q),
  )
})

test('median of even/odd lists', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.equal(median([]), null)
})

function sample(cellId, normalized, category, arrivalIndex, latencyMs = 100) {
  return {
    cellId,
    raw: normalized ?? '',
    normalized,
    category,
    latencyMs,
    usage: { promptTokens: 20, completionTokens: 2, reasoningTokens: null },
    arrivalIndex,
  }
}

test('buildCellDistribution aggregates categories and entropy', () => {
  const cellId = 'random-number-1-100:en'
  const samples = [
    sample(cellId, '42', 'valid', 0, 100),
    sample(cellId, '42', 'valid', 1, 200),
    sample(cellId, '7', 'valid', 2, 300),
    sample(cellId, 'banana', 'invalid', 3, 400),
    sample(cellId, null, 'refusal', 4, 500),
    sample(cellId, null, 'empty', 5, 600),
    sample(cellId, null, 'error', 6, 9999), // error latency is excluded
  ]
  const dist = buildCellDistribution(cellId, samples, { kind: 'int', min: 1, max: 100 })
  assert.deepEqual(dist.counts, { 42: 2, 7: 1 })
  assert.equal(dist.validCount, 3)
  assert.equal(dist.invalidCount, 1)
  assert.equal(dist.refusalCount, 1)
  assert.equal(dist.emptyCount, 1)
  assert.equal(dist.errorCount, 1)
  assert.equal(dist.totalCount, 7)
  almostEqual(dist.entropyBits, shannonEntropyBits({ a: 2, b: 1 }))
  assert.ok(dist.normalizedEntropy > 0 && dist.normalizedEntropy <= 1)
  assert.equal(dist.medianLatencyMs, 350) // median of [100..600]; the error sample is excluded
  assert.equal(dist.meanCompletionTokens, 2)
})

test('distribution builders treat Object prototype names as ordinary answers', () => {
  const cellId = 'random-animal:en'
  const samples = [
    sample(cellId, 'constructor', 'valid', 0),
    sample(cellId, 'toString', 'valid', 1),
    sample(cellId, '__proto__', 'valid', 2),
  ]
  const dist = buildCellDistribution(cellId, samples, { kind: 'word' })
  assert.equal(Object.hasOwn(dist.counts, 'constructor'), true)
  assert.equal(Object.hasOwn(dist.counts, 'toString'), true)
  assert.equal(Object.hasOwn(dist.counts, '__proto__'), true)
  assert.deepEqual(Object.values(dist.counts), [1, 1, 1])
})

test('compareCellSets: skips thin cells, averages the rest', () => {
  const mk = (counts, validCount) => ({ counts, validCount })
  const a = {
    'random-number-1-100:en': mk({ 42: 20 }, 20),
    'random-color:en': mk({ blue: 15 }, 15),
    'coin-flip:en': mk({ heads: 3 }, 3), // below the 10-valid minimum
  }
  const b = {
    'random-number-1-100:en': mk({ 42: 20 }, 20),
    'random-color:en': mk({ red: 15 }, 15),
    'coin-flip:en': mk({ heads: 30 }, 30),
  }
  const { entries, meanJsd } = compareCellSets(a, b)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].cellId, 'random-color:en') // sorted by descending JSD
  almostEqual(entries[0].jsd, 1)
  almostEqual(entries[1].jsd, 0)
  almostEqual(meanJsd, 0.5)
})

test('compareCellSets: nothing comparable → meanJsd null', () => {
  const { entries, meanJsd } = compareCellSets({}, {})
  assert.equal(entries.length, 0)
  assert.equal(meanJsd, null)
})

test('splitHalfJsd: stable endpoint → 0, alternating endpoint → 1', () => {
  const cellId = 'random-number-1-100:en'
  const stable = new Map([
    [cellId, Array.from({ length: 20 }, (_, i) => sample(cellId, '42', 'valid', i))],
  ])
  almostEqual(splitHalfJsd(stable), 0)

  const alternating = new Map([
    [
      cellId,
      Array.from({ length: 20 }, (_, i) => sample(cellId, i % 2 === 0 ? '1' : '2', 'valid', i)),
    ],
  ])
  almostEqual(splitHalfJsd(alternating), 1)
})

test('splitHalfJsd: too few samples → null', () => {
  const cellId = 'random-number-1-100:en'
  const thin = new Map([
    [cellId, Array.from({ length: 6 }, (_, i) => sample(cellId, '42', 'valid', i))],
  ])
  assert.equal(splitHalfJsd(thin), null)
})
