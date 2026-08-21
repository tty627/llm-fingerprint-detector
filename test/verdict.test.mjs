import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  JSD_MATCH_THRESHOLD,
  JSD_MISMATCH_THRESHOLD,
  LEGACY_JSD_MATCH_THRESHOLD,
  LEGACY_JSD_MISMATCH_THRESHOLD,
  MIN_COMPARABLE_CELLS,
} from '../dist/constants.js'
import { buildComparisonResult, decideVerdict } from '../dist/verdict.js'

test('legacy exploratory thresholds preserve match / uncertain / mismatch labels', () => {
  const cells = MIN_COMPARABLE_CELLS
  assert.equal(decideVerdict(0.0, cells), 'match')
  assert.equal(decideVerdict(LEGACY_JSD_MATCH_THRESHOLD, cells), 'match')
  assert.equal(decideVerdict(LEGACY_JSD_MATCH_THRESHOLD + 1e-9, cells), 'uncertain')
  assert.equal(decideVerdict(LEGACY_JSD_MISMATCH_THRESHOLD, cells), 'uncertain')
  assert.equal(decideVerdict(LEGACY_JSD_MISMATCH_THRESHOLD + 1e-9, cells), 'mismatch')
  assert.equal(decideVerdict(0.9, cells), 'mismatch')
})

test('deprecated threshold aliases retain their values for compatibility', () => {
  assert.equal(JSD_MATCH_THRESHOLD, LEGACY_JSD_MATCH_THRESHOLD)
  assert.equal(JSD_MISMATCH_THRESHOLD, LEGACY_JSD_MISMATCH_THRESHOLD)
})

test('verdict: too few comparable cells → insufficient', () => {
  assert.equal(decideVerdict(0.1, MIN_COMPARABLE_CELLS - 1), 'insufficient')
  assert.equal(decideVerdict(null, 10), 'insufficient')
})

test('buildComparisonResult carries thresholds, baselines and per-cell details', () => {
  const entries = [
    { cellId: 'random-number-1-100:en', jsd: 0.5, validA: 25, validB: 30 },
    { cellId: 'random-color:en', jsd: 0.1, validA: 25, validB: 30 },
    { cellId: 'coin-flip:en', jsd: 0.2, validA: 25, validB: 30 },
    { cellId: 'random-animal:en', jsd: 0.2, validA: 25, validB: 30 },
  ]
  const result = buildComparisonResult(entries, 0.25, false)
  assert.equal(result.verdict, 'match')
  assert.equal(result.comparableCellCount, 4)
  assert.equal(result.cells.length, 4)
  assert.equal(result.protocolMismatch, false)
  assert.equal(result.thresholds.match, LEGACY_JSD_MATCH_THRESHOLD)
  assert.equal(result.baselines.differentModel, 0.463)
  assert.equal(result.verdictSemantics, 'legacy-exploratory')
  assert.equal(result.decisionEligible, false)
})

test('protocol mismatch never makes the compatibility label decision eligible', () => {
  const entries = [
    { cellId: 'random-number-1-100:en', jsd: 0, validA: 25, validB: 25 },
    { cellId: 'random-color:en', jsd: 0, validA: 25, validB: 25 },
    { cellId: 'coin-flip:en', jsd: 0, validA: 25, validB: 25 },
    { cellId: 'random-animal:en', jsd: 0, validA: 25, validB: 25 },
  ]
  const result = buildComparisonResult(entries, 0, true)
  assert.equal(result.verdict, 'match')
  assert.equal(result.protocolMismatch, true)
  assert.equal(result.verdictSemantics, 'legacy-exploratory')
  assert.equal(result.decisionEligible, false)
})
