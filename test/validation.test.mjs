import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compare, isProtocolCellId, validateFingerprint } from '../dist/index.js'
import { loadBundledReference, parseFingerprintJson } from '../dist/reference.js'

function firstCellArtifact() {
  const source = loadBundledReference('openai/gpt-4o-mini')
  const [cellId, sourceCell] = Object.entries(source.cells)[0]
  const cell = structuredClone(sourceCell)
  const samplesPerCell = cell.totalCount
  return {
    formatVersion: 2,
    protocol: 'one-token/v2-test',
    model: source.model,
    collectedAt: '2026-08-21T00:00:00.000Z',
    samplesPerCell,
    postReasoning: false,
    cells: { [cellId]: cell },
    manifest: {
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
    },
    plan: {
      planVersion: 1,
      role: 'enrollment',
      cellIds: [cellId],
      samplesPerCell,
      expectedSamples: samplesPerCell,
      schedulerSeed: 'validation-test-seed',
      schedulerPolicy: 'repetition-index-seeded',
    },
    quality: {
      qualityVersion: 1,
      complete: true,
      completedSamples: cell.totalCount,
      expectedSamples: samplesPerCell,
      validSamples: cell.validCount,
      invalidSamples: cell.invalidCount,
      refusalSamples: cell.refusalCount,
      emptySamples: cell.emptyCount,
      errorSamples: cell.errorCount,
      directness: 'verified',
      reasoningTraceCount: 0,
      reasoningTokenCount: 0,
      reasoningUsageObservedSamples: cell.totalCount,
      rawEvidenceSha256: null,
    },
  }
}

function firstCell(value) {
  return Object.values(value.cells)[0]
}

test('strict validation still accepts legal V1 and V2 artifacts', () => {
  const v1 = loadBundledReference('openai/gpt-4o-mini')
  assert.equal(validateFingerprint(v1), v1)
  const v2 = firstCellArtifact()
  assert.equal(validateFingerprint(v2), v2)
  assert.equal(parseFingerprintJson(JSON.stringify(v1)).formatVersion, 1)
  assert.equal(parseFingerprintJson(JSON.stringify(v2)).formatVersion, 2)
})

test('counts must be non-negative finite integers', () => {
  for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    const fp = structuredClone(loadBundledReference('openai/gpt-4o-mini'))
    firstCell(fp).validCount = invalid
    assert.throws(() => validateFingerprint(fp), /non-negative finite integer/)
  }

  const invalidAnswerCount = structuredClone(loadBundledReference('openai/gpt-4o-mini'))
  const cell = firstCell(invalidAnswerCount)
  cell.counts[Object.keys(cell.counts)[0]] = 0.5
  assert.throws(() => validateFingerprint(invalidAnswerCount), /non-negative finite integer/)
})

test('valid-answer count sum and category total are exact invariants', () => {
  const answerMismatch = structuredClone(loadBundledReference('openai/gpt-4o-mini'))
  firstCell(answerMismatch).validCount += 1
  assert.throws(() => validateFingerprint(answerMismatch), /must equal validCount/)

  const categoryMismatch = structuredClone(loadBundledReference('openai/gpt-4o-mini'))
  firstCell(categoryMismatch).invalidCount += 1
  assert.throws(() => validateFingerprint(categoryMismatch), /must equal totalCount/)
})

test('cell object ids must equal their containing record key', () => {
  const fp = structuredClone(loadBundledReference('openai/gpt-4o-mini'))
  firstCell(fp).cellId = 'random-color:zh'
  assert.throws(() => validateFingerprint(fp), /must equal its containing key/)
})

test('partial artifacts can be retained but are rejected when eligibility is required', () => {
  const fp = structuredClone(loadBundledReference('openai/gpt-4o-mini'))
  const aggregate = Object.values(fp.cells).reduce(
    (sum, cell) => ({ total: sum.total + cell.totalCount, errors: sum.errors + cell.errorCount }),
    { total: 0, errors: 0 },
  )
  fp.partial = true
  fp.completedSamples = aggregate.total
  fp.expectedSamples = aggregate.total + 1
  fp.errorCount = aggregate.errors
  fp.incompleteReason = 'sampling_interrupted'
  assert.equal(validateFingerprint(fp), fp)
  assert.throws(
    () => validateFingerprint(fp, { rejectPartial: true, sourceLabel: 'checkpoint.json' }),
    /incomplete partial fingerprint/,
  )
  assert.throws(() => parseFingerprintJson(JSON.stringify(fp)), /cannot be used as a reference/)
})

test('V2 plan and quality fields must agree with cells', () => {
  const badPlan = firstCellArtifact()
  badPlan.plan.expectedSamples += 1
  assert.throws(() => validateFingerprint(badPlan), /plan.expectedSamples/)

  const badQuality = firstCellArtifact()
  badQuality.quality.validSamples += 1
  assert.throws(() => validateFingerprint(badQuality), /quality/)

  const wrongManifestProtocol = firstCellArtifact()
  wrongManifestProtocol.manifest.protocolId = 'different/v2'
  assert.throws(() => validateFingerprint(wrongManifestProtocol), /manifest.protocolId/)
})

test('V1 cell ids remain closed while V2 accepts bounded protocol-defined cells', () => {
  assert.equal(isProtocolCellId('num100-random:ru'), true)
  assert.equal(isProtocolCellId('coinflip:ar'), true)
  assert.equal(isProtocolCellId('missing-language'), false)

  const v1 = structuredClone(loadBundledReference('openai/gpt-4o-mini'))
  const [legacyId, legacyCell] = Object.entries(v1.cells)[0]
  delete v1.cells[legacyId]
  legacyCell.cellId = 'num100-random:ru'
  v1.cells['num100-random:ru'] = legacyCell
  assert.throws(() => validateFingerprint(v1), /outside the legacy V1 battery/)

  const v2 = firstCellArtifact()
  const [oldId, cell] = Object.entries(v2.cells)[0]
  delete v2.cells[oldId]
  cell.cellId = 'num100-random:ru'
  v2.cells['num100-random:ru'] = cell
  v2.plan.cellIds = ['num100-random:ru']
  assert.equal(validateFingerprint(v2), v2)
  assert.equal(compare(v2, structuredClone(v2)).meanJsd, 0)
})

test('V2 can represent the paper-sized 10 task x 4 language matrix', () => {
  const fp = firstCellArtifact()
  const template = structuredClone(Object.values(fp.cells)[0])
  const languages = ['en', 'ru', 'zh', 'ar']
  const cellIds = Array.from({ length: 10 }, (_, task) =>
    languages.map((language) => `paper-task-${task + 1}:${language}`),
  ).flat()
  fp.cells = Object.fromEntries(
    cellIds.map((cellId) => [cellId, { ...structuredClone(template), cellId }]),
  )
  fp.plan.cellIds = cellIds
  fp.plan.expectedSamples = cellIds.length * fp.plan.samplesPerCell
  fp.quality.completedSamples = cellIds.length * template.totalCount
  fp.quality.expectedSamples = fp.plan.expectedSamples
  fp.quality.validSamples = cellIds.length * template.validCount
  fp.quality.invalidSamples = cellIds.length * template.invalidCount
  fp.quality.refusalSamples = cellIds.length * template.refusalCount
  fp.quality.emptySamples = cellIds.length * template.emptyCount
  fp.quality.errorSamples = cellIds.length * template.errorCount
  fp.quality.reasoningUsageObservedSamples = fp.quality.completedSamples

  assert.equal(Object.keys(validateFingerprint(fp).cells).length, 40)
})

test('V2 collection role, seeded scheduler, directness, reasoning, and raw hash are strict', () => {
  const badRole = firstCellArtifact()
  badRole.plan.role = 'reference'
  assert.throws(() => validateFingerprint(badRole), /plan.role/)

  const noSeed = firstCellArtifact()
  noSeed.plan.schedulerSeed = '   '
  assert.throws(() => validateFingerprint(noSeed), /schedulerSeed/)

  const badScheduler = firstCellArtifact()
  badScheduler.plan.schedulerPolicy = 'random'
  assert.throws(() => validateFingerprint(badScheduler), /schedulerPolicy/)

  const badDirectness = firstCellArtifact()
  badDirectness.quality.directness = 'assumed'
  assert.throws(() => validateFingerprint(badDirectness), /quality.directness/)

  const tooManyTraces = firstCellArtifact()
  tooManyTraces.quality.reasoningTraceCount = tooManyTraces.quality.completedSamples + 1
  assert.throws(() => validateFingerprint(tooManyTraces), /reasoningTraceCount/)

  const negativeReasoningTokens = firstCellArtifact()
  negativeReasoningTokens.quality.reasoningTokenCount = -1
  assert.throws(() => validateFingerprint(negativeReasoningTokens), /non-negative finite integer/)

  const badHash = firstCellArtifact()
  badHash.quality.rawEvidenceSha256 = 'abc123'
  assert.throws(() => validateFingerprint(badHash), /64 hexadecimal/)

  const goodHash = firstCellArtifact()
  goodHash.quality.rawEvidenceSha256 = 'a'.repeat(64)
  assert.equal(validateFingerprint(goodHash), goodHash)
})

test('V2 rejects unknown fields, non-canonical time, and contradictory verified quality', () => {
  for (const mutate of [
    (fp) => { fp.extraRoot = true },
    (fp) => { fp.plan.extraPlan = true },
    (fp) => { fp.quality.extraQuality = true },
    (fp) => { firstCell(fp).extraCell = true },
  ]) {
    const fp = firstCellArtifact()
    mutate(fp)
    assert.throws(() => validateFingerprint(fp), /contains unknown key/)
  }

  const badTime = firstCellArtifact()
  badTime.collectedAt = '2026-08-21'
  assert.throws(() => validateFingerprint(badTime), /canonical ISO-8601/)

  const observedReasoning = firstCellArtifact()
  observedReasoning.quality.reasoningTokenCount = 1
  assert.throws(() => validateFingerprint(observedReasoning), /cannot be verified/)

  const missingReasoningUsage = firstCellArtifact()
  missingReasoningUsage.quality.reasoningUsageObservedSamples -= 1
  assert.throws(() => validateFingerprint(missingReasoningUsage), /explicit reasoning-token usage/)

  const unknownDigest = firstCellArtifact()
  unknownDigest.manifest.battery.digest = 'sha256:not-a-real-digest'
  assert.throws(() => validateFingerprint(unknownDigest), /sha256:<64hex>/)
})

test('compare surfaces strict V2 manifest compatibility instead of trusting protocol id alone', () => {
  const left = firstCellArtifact()
  const sameProfile = compare(left, structuredClone(left))
  assert.equal(sameProfile.protocolMismatch, false)
  assert.equal(sameProfile.compatibility.status, 'compatible')
  assert.equal(sameProfile.compatibility.manifestMatch, true)
  assert.equal(sameProfile.decisionEligible, false)

  const driftedManifest = structuredClone(left)
  driftedManifest.manifest.prompts.templateDigest = `sha256:${'e'.repeat(64)}`
  const mismatch = compare(left, driftedManifest)
  assert.equal(mismatch.protocolMismatch, true)
  assert.equal(mismatch.compatibility.status, 'incompatible')
  assert.equal(mismatch.compatibility.manifestMatch, false)
  assert.equal(mismatch.decisionEligible, false)
})
