import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  BRUCKNER_2026_SCHEDULER_SOURCE_SHA256,
  bruckner2026SeededShuffle,
  buildBruckner2026DirectRequest,
  createBruckner2026CollectionJobs,
  paperSplitHalfByRepetitionIndex,
} from '../dist/paper-collector.js'
import { normalizeBruckner2026Answer } from '../dist/normalizers/bruckner2026.js'
import {
  BRUCKNER_2026_ARCHIVE_SHA256,
  BRUCKNER_2026_CANONICAL40_CELLS,
  BRUCKNER_2026_CANONICAL40_PROFILE,
  BRUCKNER_2026_OFFICIAL_PROMPTS_SHA256,
  BRUCKNER_2026_SOFTWARE_DOI,
  buildBruckner2026CanonicalPayload,
} from '../dist/profiles/bruckner2026.js'
import { canonicalSerialize } from '../dist/protocol.js'
import { jensenShannonDivergence } from '../dist/stats.js'

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/bruckner2026-author-golden.json', import.meta.url), 'utf8'),
)

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function normalizerOptions(fixtureCase) {
  const task = BRUCKNER_2026_CANONICAL40_PROFILE.tasks.find(
    (candidate) => candidate.id === fixtureCase.taskId,
  )
  assert.ok(task, `missing task for golden case ${fixtureCase.sourceKey ?? fixtureCase.id}`)
  if (task.normalize_as !== 'integer') {
    return { lang: fixtureCase.lang, normalizeAs: task.normalize_as }
  }
  const range = /(\d+)-(\d+)/.exec(task.answer_space)
  return range
    ? {
        lang: fixtureCase.lang,
        normalizeAs: 'integer',
        min: Number(range[1]),
        max: Number(range[2]),
      }
    : { lang: fixtureCase.lang, normalizeAs: 'integer' }
}

function promptPairHash(cell) {
  return sha256(canonicalSerialize({
    systemPrompt: cell.systemPrompt,
    userPrompt: cell.userPrompt,
  }))
}

test('golden fixture pins the exact software and public-data provenance without an EER claim', () => {
  assert.equal(fixture.fixtureVersion, 1)
  assert.match(fixture.scope, /does not reproduce ROC or EER/)
  assert.equal(fixture.provenance.software.doi, '10.5281/zenodo.21278793')
  assert.equal(fixture.provenance.software.license, 'MIT')
  assert.equal(fixture.provenance.dataset.doi, '10.5281/zenodo.21278557')
  assert.equal(fixture.provenance.dataset.license, 'CC-BY-4.0')
  assert.equal(BRUCKNER_2026_SOFTWARE_DOI, fixture.provenance.software.doi)
  assert.equal(BRUCKNER_2026_ARCHIVE_SHA256, fixture.provenance.software.archiveSha256)
  assert.equal(
    BRUCKNER_2026_OFFICIAL_PROMPTS_SHA256,
    fixture.provenance.software.sources.prompts.sha256,
  )
  assert.equal(
    BRUCKNER_2026_SCHEDULER_SOURCE_SHA256,
    fixture.provenance.software.sources.scheduler.sha256,
  )
})

test('canonical profile matches all 40 author prompt-pair hashes and the full payload hash', () => {
  const payload = buildBruckner2026CanonicalPayload(BRUCKNER_2026_CANONICAL40_PROFILE)
  assert.deepEqual(payload.languages, fixture.canonicalStudyA.languages)
  assert.deepEqual(
    payload.tasks.map((task) => task.id),
    fixture.canonicalStudyA.taskIds,
  )
  assert.equal(BRUCKNER_2026_CANONICAL40_CELLS.length, fixture.canonicalStudyA.cellCount)
  assert.equal(sha256(canonicalSerialize(payload)), fixture.canonicalStudyA.payloadSha256)
  assert.deepEqual(
    BRUCKNER_2026_CANONICAL40_CELLS.map((cell) => ({
      cellId: cell.cellId,
      promptPairSha256: promptPairHash(cell),
    })),
    fixture.canonicalStudyA.cells,
  )
})

test('paper request helper matches the pinned author request shape and exact fixed prompts', () => {
  const job = createBruckner2026CollectionJobs(1, 'author-golden-request')[0]
  const body = buildBruckner2026DirectRequest('offline-fixture-model', job)
  const request = fixture.canonicalStudyA.request
  assert.equal(body.temperature, request.temperature)
  assert.equal(body.max_tokens, request.maxTokens)
  assert.deepEqual(body.reasoning, { enabled: request.reasoningEnabled })
  assert.deepEqual(body.usage, { include: request.usageInclude })
  assert.equal('top_p' in body, false)
  assert.equal(request.topP, 'omitted')
  assert.equal('seed' in body, false)
  assert.deepEqual(body.messages, [
    { role: 'system', content: job.systemPrompt },
    { role: 'user', content: job.userPrompt },
  ])
})

test('clean-room normalizer matches edge cases executed from the pinned author source', () => {
  for (const fixtureCase of fixture.normalizerSyntheticCases) {
    assert.deepEqual(
      normalizeBruckner2026Answer(fixtureCase.raw, normalizerOptions(fixtureCase)),
      fixtureCase.expected,
      fixtureCase.id,
    )
  }
})

test('clean-room normalizer matches the selected CC-BY published records', () => {
  for (const fixtureCase of fixture.normalizerDatasetRecords) {
    assert.deepEqual(
      normalizeBruckner2026Answer(fixtureCase.raw, normalizerOptions(fixtureCase)),
      fixtureCase.expected,
      fixtureCase.sourceKey,
    )
  }
})

test('base-2 JSD agrees with the pinned author implementation', () => {
  for (const fixtureCase of fixture.jsdCases) {
    const actual = jensenShannonDivergence(fixtureCase.countsP, fixtureCase.countsQ)
    assert.ok(
      Math.abs(actual - fixtureCase.expectedBits) < 1e-15,
      `${fixtureCase.id}: expected ${fixtureCase.expectedBits}, got ${actual}`,
    )
    assert.equal(Number(actual.toFixed(4)), fixtureCase.authorRounded4, fixtureCase.id)
  }
})

test('split-half uses published repetition parity, independent of record order', () => {
  const source = fixture.parityDatasetSubset
  const evidence = source.records.map((record) => ({
    cellId: `${source.taskId}:${source.language}`,
    repetitionIndex: record.rep,
    normalized: record.normalized,
    category: record.category,
  }))
  const split = paperSplitHalfByRepetitionIndex(evidence, 5)
  assert.equal(split.cells.length, 1)
  assert.deepEqual(
    Object.fromEntries(
      source.records
        .filter((record) => record.rep % 2 === 0)
        .reduce((counts, record) => {
          counts.set(record.normalized, (counts.get(record.normalized) ?? 0) + 1)
          return counts
        }, new Map()),
    ),
    source.expectedEvenCounts,
  )
  assert.deepEqual(
    Object.fromEntries(
      source.records
        .filter((record) => record.rep % 2 !== 0)
        .reduce((counts, record) => {
          counts.set(record.normalized, (counts.get(record.normalized) ?? 0) + 1)
          return counts
        }, new Map()),
    ),
    source.expectedOddCounts,
  )
  assert.equal(split.cells[0].evenValidCount, 5)
  assert.equal(split.cells[0].oddValidCount, 5)
  assert.ok(Math.abs(split.cells[0].jsd - source.expectedJsdBits) < 1e-15)
  assert.equal(Number(split.cells[0].jsd.toFixed(4)), source.authorRounded4)
  assert.deepEqual(split, paperSplitHalfByRepetitionIndex([...evidence].reverse(), 5))
})

test('seeded scheduler agrees with the function extracted from the pinned author source', () => {
  const schedulerCase = fixture.schedulerCase
  assert.deepEqual(
    bruckner2026SeededShuffle(schedulerCase.input, schedulerCase.seed),
    schedulerCase.expected,
  )
  assert.deepEqual(
    schedulerCase.input,
    ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'],
  )
})
