import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  canonicalSerialize,
  checkFingerprintCompatibility,
  serializeProtocolManifest,
  validateProtocolManifest,
} from '../dist/index.js'
import { loadBundledReference } from '../dist/reference.js'

function manifest() {
  return {
    manifestVersion: 1,
    protocolId: 'one-token/v2-test',
    battery: { id: 'paper-battery', version: '1', digest: `sha256:${'a'.repeat(64)}` },
    prompts: {
      systemPromptDigest: `sha256:${'b'.repeat(64)}`,
      templateDigest: `sha256:${'c'.repeat(64)}`,
    },
    normalization: { id: 'normalizer', version: '1', digest: `sha256:${'d'.repeat(64)}` },
    sampling: {
      temperature: 1,
      topP: null,
      maxTokens: 16,
      answerConstraint: 'one-word answer',
      reasoningPolicy: 'disable-or-declare-post-reasoning',
    },
  }
}

function v2Fingerprint(cellCount = 2) {
  const source = loadBundledReference('openai/gpt-4o-mini')
  const cellEntries = Object.entries(source.cells).slice(0, cellCount)
  const cells = Object.fromEntries(cellEntries.map(([id, cell]) => [id, structuredClone(cell)]))
  const cellIds = Object.keys(cells)
  const samplesPerCell = cells[cellIds[0]].totalCount
  const totals = Object.values(cells).reduce(
    (sum, cell) => ({
      valid: sum.valid + cell.validCount,
      invalid: sum.invalid + cell.invalidCount,
      refusal: sum.refusal + cell.refusalCount,
      empty: sum.empty + cell.emptyCount,
      error: sum.error + cell.errorCount,
      total: sum.total + cell.totalCount,
    }),
    { valid: 0, invalid: 0, refusal: 0, empty: 0, error: 0, total: 0 },
  )
  return {
    formatVersion: 2,
    protocol: 'one-token/v2-test',
    model: source.model,
    collectedAt: '2026-08-21T00:00:00.000Z',
    samplesPerCell,
    postReasoning: false,
    cells,
    manifest: manifest(),
    plan: {
      planVersion: 1,
      role: 'enrollment',
      cellIds,
      samplesPerCell,
      expectedSamples: cellIds.length * samplesPerCell,
      schedulerSeed: 'test-enrollment-seed',
      schedulerPolicy: 'repetition-index-seeded',
    },
    quality: {
      qualityVersion: 1,
      complete: true,
      completedSamples: totals.total,
      expectedSamples: cellIds.length * samplesPerCell,
      validSamples: totals.valid,
      invalidSamples: totals.invalid,
      refusalSamples: totals.refusal,
      emptySamples: totals.empty,
      errorSamples: totals.error,
      directness: 'verified',
      reasoningTraceCount: 0,
      reasoningTokenCount: 0,
      reasoningUsageObservedSamples: totals.total,
      rawEvidenceSha256: null,
    },
  }
}

test('canonical serialization sorts every object level and rejects lossy JSON values', () => {
  assert.equal(
    canonicalSerialize({ z: 1, nested: { y: true, a: null }, a: [3, 2] }),
    '{"a":[3,2],"nested":{"a":null,"y":true},"z":1}',
  )
  assert.equal(
    canonicalSerialize(JSON.parse('{"toString":1,"constructor":2,"__proto__":3}')),
    '{"__proto__":3,"constructor":2,"toString":1}',
  )
  assert.throws(() => canonicalSerialize({ value: Number.NaN }), /non-finite/)
  assert.throws(() => canonicalSerialize({ value: undefined }), /non-JSON/)
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => canonicalSerialize(cyclic), /cycle/)
})

test('protocol manifest validation is strict and serializes deterministically', () => {
  const value = manifest()
  assert.equal(validateProtocolManifest(value), value)
  assert.equal(serializeProtocolManifest(value), canonicalSerialize(value))

  const unknown = structuredClone(value)
  unknown.sampling.untrackedProviderDefault = true
  assert.throws(() => validateProtocolManifest(unknown), /unknown key/)

  const invalidTopP = structuredClone(value)
  invalidTopP.sampling.topP = 1.1
  assert.throws(() => validateProtocolManifest(invalidTopP), /topP/)
})

test('valid equal V2 artifacts are compatible; plan cell order is not semantic', () => {
  const left = v2Fingerprint()
  const right = structuredClone(left)
  right.plan.cellIds.reverse()
  const result = checkFingerprintCompatibility(left, right)
  assert.equal(result.status, 'compatible')
  assert.equal(result.compatible, true)
  assert.equal(result.manifestMatch, true)
  assert.equal(result.collectionPlanMatch, true)
  assert.deepEqual(result.issues, [])
})

test('V2 manifest changes are incompatible; plan changes are policy inputs', () => {
  const left = v2Fingerprint(2)
  const manifestMismatch = structuredClone(left)
  manifestMismatch.manifest.battery.digest = `sha256:${'e'.repeat(64)}`
  const manifestResult = checkFingerprintCompatibility(left, manifestMismatch)
  assert.equal(manifestResult.status, 'incompatible')
  assert.equal(manifestResult.manifestMatch, false)
  assert.ok(manifestResult.issues.some((issue) => issue.code === 'manifest_mismatch'))

  const transportMismatch = structuredClone(left)
  transportMismatch.manifest.transportProfileId = 'anthropic-messages-opus5-onetoken-v1'
  const transportResult = checkFingerprintCompatibility(left, transportMismatch)
  assert.equal(transportResult.status, 'incompatible')
  assert.equal(transportResult.manifestMatch, false)

  const differentPlan = v2Fingerprint(1)
  const planResult = checkFingerprintCompatibility(left, differentPlan)
  assert.equal(planResult.status, 'compatible')
  assert.equal(planResult.compatible, true)
  assert.equal(planResult.collectionPlanMatch, false)
  assert.ok(planResult.issues.some((issue) => issue.code === 'collection_plan_mismatch'))
})

test('enrollment/audit role and scheduler seed differences do not block compatibility', () => {
  const enrollment = v2Fingerprint()
  const audit = structuredClone(enrollment)
  audit.plan.role = 'audit'
  audit.plan.schedulerSeed = 'audit-seed-with-independent-order'

  const result = checkFingerprintCompatibility(enrollment, audit)
  assert.equal(result.status, 'compatible')
  assert.equal(result.compatible, true)
  assert.equal(result.manifestMatch, true)
  assert.equal(result.collectionPlanMatch, false)
  assert.ok(result.issues.some((issue) => issue.code === 'collection_plan_mismatch'))
})

test('every comparison containing V1 is exploratory, never compatible', () => {
  const v1 = loadBundledReference('openai/gpt-4o-mini')
  const v1Pair = checkFingerprintCompatibility(v1, structuredClone(v1))
  assert.equal(v1Pair.status, 'exploratory')
  assert.equal(v1Pair.compatible, false)
  assert.ok(v1Pair.issues.some((issue) => issue.code === 'legacy_v1'))

  const mixed = checkFingerprintCompatibility(v1, v2Fingerprint())
  assert.equal(mixed.status, 'exploratory')
  assert.equal(mixed.compatible, false)
  assert.ok(mixed.issues.some((issue) => issue.code === 'mixed_format_versions'))
})

test('malformed artifacts cannot pass compatibility checks', () => {
  const left = v2Fingerprint()
  const malformed = structuredClone(left)
  const firstCell = Object.values(malformed.cells)[0]
  firstCell.validCount += 1
  const result = checkFingerprintCompatibility(left, malformed)
  assert.equal(result.status, 'incompatible')
  assert.equal(result.compatible, false)
  assert.ok(result.issues.some((issue) => issue.code === 'invalid_fingerprint'))
})
