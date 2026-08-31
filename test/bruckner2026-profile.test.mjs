import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { canonicalSerialize } from '../dist/protocol.js'
import {
  BRUCKNER_2026_CANONICAL40_CELLS,
  BRUCKNER_2026_CANONICAL40_PROFILE,
  BRUCKNER_2026_CANONICAL_PAYLOAD_SHA256,
  BRUCKNER_2026_LANGUAGES,
  BRUCKNER_2026_TASK_IDS,
  buildBruckner2026Canonical40Manifest,
  buildBruckner2026CanonicalPayload,
  validateBruckner2026Canonical40Profile,
} from '../dist/profiles/bruckner2026.js'

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

test('canonical Study A profile exposes exactly 10 tasks x 4 languages', () => {
  assert.deepEqual(BRUCKNER_2026_CANONICAL40_PROFILE.languages, ['en', 'ru', 'zh', 'ar'])
  assert.deepEqual(BRUCKNER_2026_LANGUAGES, ['en', 'ru', 'zh', 'ar'])
  assert.deepEqual(
    BRUCKNER_2026_CANONICAL40_PROFILE.tasks.map((task) => task.id),
    [
      'num100-random',
      'num10-random',
      'num-favorite',
      'letter-random',
      'word-random',
      'color-random',
      'color-favorite',
      'animal-random',
      'city-random',
      'coin-flip',
    ],
  )
  assert.deepEqual(BRUCKNER_2026_TASK_IDS, BRUCKNER_2026_CANONICAL40_PROFILE.tasks.map((task) => task.id))
  assert.equal(BRUCKNER_2026_CANONICAL40_CELLS.length, 40)
  assert.equal(new Set(BRUCKNER_2026_CANONICAL40_CELLS.map((cell) => cell.cellId)).size, 40)

  for (const taskId of BRUCKNER_2026_TASK_IDS) {
    for (const language of BRUCKNER_2026_LANGUAGES) {
      assert.ok(
        BRUCKNER_2026_CANONICAL40_CELLS.some((cell) => cell.cellId === `${taskId}:${language}`),
        `missing ${taskId}:${language}`,
      )
    }
  }
  assert.ok(BRUCKNER_2026_CANONICAL40_CELLS.every((cell) => cell.paraphrasePolicy === 'fixed'))
})

test('canonical profile retains exact multilingual author prompts', () => {
  assert.equal(
    BRUCKNER_2026_CANONICAL40_PROFILE.system_prompts.ru,
    'Отвечай только одним словом или одним числом. Не выводи ничего больше: без объяснений, без знаков препинания, без кавычек.',
  )
  assert.equal(
    BRUCKNER_2026_CANONICAL40_CELLS.find((cell) => cell.cellId === 'num100-random:en')?.userPrompt,
    'Name a random number between 1 and 100.',
  )
  assert.equal(
    BRUCKNER_2026_CANONICAL40_CELLS.find((cell) => cell.cellId === 'letter-random:zh')?.userPrompt,
    '说出一个随机的汉字。',
  )
  assert.equal(
    BRUCKNER_2026_CANONICAL40_CELLS.find((cell) => cell.cellId === 'coin-flip:ar')?.userPrompt,
    'ارمِ قطعة نقود. أجب "صورة" أو "كتابة".',
  )
  assert.deepEqual(BRUCKNER_2026_CANONICAL40_PROFILE.authors, [
    { name: 'Tomáš Bruckner', copyrightYear: 2026 },
  ])
})

test('canonical Study A payload reproduces the pinned derivation hash', () => {
  const payload = buildBruckner2026CanonicalPayload(BRUCKNER_2026_CANONICAL40_PROFILE)
  assert.equal(
    sha256(canonicalSerialize(payload)),
    '9ef56c982a503b4dba94710b63866aaff47db1e37cc34538e225acb9f5fe1341',
  )
  assert.equal(
    BRUCKNER_2026_CANONICAL_PAYLOAD_SHA256,
    BRUCKNER_2026_CANONICAL40_PROFILE.source.canonicalPayloadSha256,
  )
})

test('profile validator rejects unknown fields and prompt drift', () => {
  const unknownField = structuredClone(BRUCKNER_2026_CANONICAL40_PROFILE)
  unknownField.extra = true
  assert.throws(
    () => validateBruckner2026Canonical40Profile(unknownField),
    /contains unknown key "extra"/,
  )

  const drifted = structuredClone(BRUCKNER_2026_CANONICAL40_PROFILE)
  drifted.tasks[0].prompts.en += ' '
  assert.throws(
    () => validateBruckner2026Canonical40Profile(drifted),
    /does not match the derived payload/,
  )
})

test('V2 manifest pins author-compatible normalization and sampling requirements', () => {
  const manifest = buildBruckner2026Canonical40Manifest()
  assert.equal(manifest.transportProfileId, 'openai-chat-onetoken-v1')
  assert.deepEqual(manifest.normalization, {
    id: 'bruckner-author-compatible-normalizer/v1',
    version: '1.0.0',
    digest: 'sha256:8f755ca604e4814126c253f44135199b1636ddfedcb070fa4ece3368fb858fa8',
  })
  assert.deepEqual(manifest.sampling, {
    temperature: 1,
    topP: null,
    maxTokens: 16,
    answerConstraint: 'fixed-system-single-word-or-number',
    reasoningPolicy: 'disabled-required',
  })
  assert.equal(
    manifest.battery.digest,
    'sha256:9ef56c982a503b4dba94710b63866aaff47db1e37cc34538e225acb9f5fe1341',
  )
})
