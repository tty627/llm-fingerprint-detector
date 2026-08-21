import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compare } from '../dist/api.js'
import {
  getBundledAttribution,
  listBundledReferences,
  loadBundledReference,
  parseFingerprintJson,
} from '../dist/reference.js'

test('bundled references load and carry attribution', () => {
  const references = listBundledReferences()
  assert.ok(references.length >= 5, 'expected several bundled sample references')

  const attribution = getBundledAttribution()
  assert.match(attribution.datasetDoi, /10\.5281\/zenodo\.21278557/)
  assert.match(attribution.license, /CC-BY-4\.0/)
  assert.match(attribution.author, /Bruckner/)
})

test('a bundled reference converts to a well-formed fingerprint', () => {
  const fp = loadBundledReference('openai/gpt-4o-mini')
  assert.equal(fp.model, 'openai/gpt-4o-mini')
  assert.equal(fp.protocol, 'bruckner-zenodo-2026')
  const cells = Object.values(fp.cells)
  assert.ok(cells.length >= 8)
  for (const cell of cells) {
    assert.ok(cell.validCount >= 10)
    const sum = Object.values(cell.counts).reduce((s, n) => s + n, 0)
    assert.ok(Math.abs(sum - cell.validCount) <= 2, `${cell.cellId}: counts ≈ validCount`)
    assert.ok(cell.entropyBits >= 0)
    assert.ok(cell.normalizedEntropy >= 0 && cell.normalizedEntropy <= 1)
  }
})

test('bundled references: self-compare → 0 distance, cross-model → clearly separated', () => {
  const gpt = loadBundledReference('openai/gpt-4o-mini')
  const self = compare(gpt, loadBundledReference('openai/gpt-4o-mini'))
  assert.equal(self.meanJsd, 0)
  assert.equal(self.verdict, 'match')

  const claude = loadBundledReference('anthropic/claude-sonnet-4.5')
  const cross = compare(gpt, claude)
  assert.ok(
    cross.meanJsd > 0.3,
    `different models should diverge (got ${cross.meanJsd}) — paper median is 0.463`,
  )
  assert.notEqual(cross.verdict, 'match')
})

test('unknown bundled id throws with the available list', () => {
  assert.throws(() => loadBundledReference('no/such-model'), /Available:/)
  assert.throws(() => loadBundledReference('constructor'), /Available:/)
  assert.throws(() => loadBundledReference('__proto__'), /Available:/)
})

test('parseFingerprintJson validates structure', () => {
  const fp = loadBundledReference('openai/gpt-4o-mini')
  const roundTripped = parseFingerprintJson(JSON.stringify(fp))
  assert.equal(roundTripped.model, fp.model)

  assert.throws(() => parseFingerprintJson('not json'), /not valid JSON/)
  assert.throws(() => parseFingerprintJson('{}'), /formatVersion/)
  assert.throws(
    () => parseFingerprintJson(JSON.stringify({ formatVersion: 1, model: 'x' })),
    /cells/,
  )
})
