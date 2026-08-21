import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CELL_PRIORITY_ORDER,
  PROBE_TASKS,
  SYSTEM_PROMPTS,
  getCellsForPreset,
  getSystemPrompt,
  getTaskSpec,
  isCellId,
  makeCellId,
  parseCellId,
  pickParaphrase,
} from '../dist/battery.js'

test('battery covers 8 tasks × 2 languages = 16 unique cells', () => {
  assert.equal(Object.keys(PROBE_TASKS).length, 8)
  assert.equal(CELL_PRIORITY_ORDER.length, 16)
  assert.equal(new Set(CELL_PRIORITY_ORDER).size, 16)
  for (const cellId of CELL_PRIORITY_ORDER) {
    assert.ok(isCellId(cellId), `${cellId} should be a valid cell id`)
  }
})

test('every task has ≥3 paraphrases per language (anti-filter design)', () => {
  for (const task of Object.values(PROBE_TASKS)) {
    for (const lang of ['en', 'zh']) {
      assert.ok(
        task.paraphrases[lang].length >= 3,
        `${task.id}:${lang} has only ${task.paraphrases[lang].length} paraphrases`,
      )
    }
  }
})

test('cell id round-trip', () => {
  const cellId = makeCellId('random-number-1-100', 'zh')
  assert.equal(cellId, 'random-number-1-100:zh')
  assert.deepEqual(parseCellId(cellId), { task: 'random-number-1-100', lang: 'zh' })
  assert.equal(isCellId('not-a-task:en'), false)
  assert.equal(isCellId('constructor:en'), false)
  assert.equal(isCellId('__proto__:zh'), false)
  assert.equal(isCellId('random-color:fr'), false)
})

test('system prompt matches the cell language', () => {
  assert.equal(getSystemPrompt('random-color:en'), SYSTEM_PROMPTS.en)
  assert.equal(getSystemPrompt('random-color:zh'), SYSTEM_PROMPTS.zh)
})

test('presets slice the priority order', () => {
  assert.deepEqual(getCellsForPreset('quick'), CELL_PRIORITY_ORDER.slice(0, 4))
  assert.deepEqual(getCellsForPreset('standard'), CELL_PRIORITY_ORDER.slice(0, 8))
  assert.deepEqual(getCellsForPreset('strict'), CELL_PRIORITY_ORDER)
})

test('pickParaphrase draws from the cell language pool', () => {
  const spec = getTaskSpec('coin-flip:zh')
  for (let i = 0; i < 20; i++) {
    const paraphrase = pickParaphrase('coin-flip:zh')
    assert.ok(spec.paraphrases.zh.includes(paraphrase))
  }
  // Deterministic draw with an injected RNG.
  assert.equal(pickParaphrase('coin-flip:en', () => 0), PROBE_TASKS['coin-flip'].paraphrases.en[0])
})
