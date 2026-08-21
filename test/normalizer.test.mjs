import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeAnswer, parseAnyNumber } from '../dist/normalizer.js'

const INT_100 = { kind: 'int', min: 1, max: 100 }
const INT_10 = { kind: 'int', min: 1, max: 10 }

test('digits pass through', () => {
  assert.deepEqual(normalizeAnswer('42', INT_100), { normalized: '42', category: 'valid' })
  assert.deepEqual(normalizeAnswer('  7.\n', INT_100), { normalized: '7', category: 'valid' })
})

test('English number words fold to digits', () => {
  assert.deepEqual(normalizeAnswer('Seven!', INT_100), { normalized: '7', category: 'valid' })
  assert.deepEqual(normalizeAnswer('forty-two', INT_100), { normalized: '42', category: 'valid' })
  assert.deepEqual(normalizeAnswer('Twelve', INT_100), { normalized: '12', category: 'valid' })
  assert.equal(parseAnyNumber('onehundred'), 100)
  assert.equal(parseAnyNumber('constructor'), null)
})

test('Chinese numerals fold to digits', () => {
  assert.deepEqual(normalizeAnswer('四十二', INT_100), { normalized: '42', category: 'valid' })
  assert.deepEqual(normalizeAnswer('十五', INT_100), { normalized: '15', category: 'valid' })
  assert.deepEqual(normalizeAnswer('两', INT_10), { normalized: '2', category: 'valid' })
  assert.deepEqual(normalizeAnswer('一百', INT_100), { normalized: '100', category: 'valid' })
})

test('full-width and Arabic-Indic digits fold to Latin', () => {
  assert.deepEqual(normalizeAnswer('４２', INT_100), { normalized: '42', category: 'valid' })
  assert.deepEqual(normalizeAnswer('٤٢', INT_100), { normalized: '42', category: 'valid' })
})

test('out-of-range numbers are invalid', () => {
  assert.equal(normalizeAnswer('101', INT_100).category, 'invalid')
  assert.equal(normalizeAnswer('0', INT_100).category, 'invalid')
  assert.equal(normalizeAnswer('42', INT_10).category, 'invalid')
})

test('refusals are detected in both languages', () => {
  assert.equal(normalizeAnswer('I cannot help with that request.', INT_100).category, 'refusal')
  assert.equal(normalizeAnswer("I'm sorry, but I can't do that", INT_100).category, 'refusal')
  assert.equal(normalizeAnswer('抱歉，我不能这样做。', INT_100).category, 'refusal')
  assert.equal(normalizeAnswer('作为一个AI，我没有偏好。', INT_100).category, 'refusal')
})

test('empty and whitespace-only answers are empty', () => {
  assert.equal(normalizeAnswer('', INT_100).category, 'empty')
  assert.equal(normalizeAnswer('   \n ', INT_100).category, 'empty')
  assert.equal(normalizeAnswer('"…"', INT_100).category, 'empty')
})

test('colors: quotes stripped, aliases folded, Chinese 色 suffix dropped', () => {
  const COLOR = { kind: 'color' }
  assert.deepEqual(normalizeAnswer('"Blue".', COLOR), { normalized: 'blue', category: 'valid' })
  assert.deepEqual(normalizeAnswer('Grey', COLOR), { normalized: 'gray', category: 'valid' })
  assert.deepEqual(normalizeAnswer('蓝色', COLOR), { normalized: '蓝', category: 'valid' })
  assert.deepEqual(normalizeAnswer('青', COLOR), { normalized: '青', category: 'valid' })
})

test('letters: single letters and letter names', () => {
  const LETTER = { kind: 'letter' }
  assert.deepEqual(normalizeAnswer('Q', LETTER), { normalized: 'q', category: 'valid' })
  assert.deepEqual(normalizeAnswer('zee', LETTER), { normalized: 'z', category: 'valid' })
  assert.deepEqual(normalizeAnswer('queue', LETTER), { normalized: 'q', category: 'valid' })
  assert.equal(normalizeAnswer('hello', LETTER).category, 'invalid')
  assert.deepEqual(normalizeAnswer('constructor', LETTER), {
    normalized: 'constructor',
    category: 'invalid',
  })
})

test('coin: heads/tails variants in both languages', () => {
  const COIN = { kind: 'coin' }
  assert.deepEqual(normalizeAnswer('Heads!', COIN), { normalized: 'heads', category: 'valid' })
  assert.deepEqual(normalizeAnswer('tail', COIN), { normalized: 'tails', category: 'valid' })
  assert.deepEqual(normalizeAnswer('正面', COIN), { normalized: 'heads', category: 'valid' })
  assert.deepEqual(normalizeAnswer('反', COIN), { normalized: 'tails', category: 'valid' })
  assert.equal(normalizeAnswer('maybe', COIN).category, 'invalid')
})

test('word tasks: first word, Latin or CJK', () => {
  const WORD = { kind: 'word' }
  assert.deepEqual(normalizeAnswer('Tokyo', WORD), { normalized: 'tokyo', category: 'valid' })
  assert.deepEqual(normalizeAnswer('New York City', WORD), { normalized: 'new', category: 'valid' })
  assert.deepEqual(normalizeAnswer('大象', WORD), { normalized: '大象', category: 'valid' })
})

test('emoji and punctuation are stripped before classification', () => {
  assert.deepEqual(normalizeAnswer('🎲 42 🎲', INT_100), { normalized: '42', category: 'valid' })
})
