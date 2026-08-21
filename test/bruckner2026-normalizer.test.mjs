import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BRUCKNER_2026_NORMALIZER_SOURCE_DOI,
  BRUCKNER_2026_NORMALIZER_SOURCE_SHA256,
  BRUCKNER_2026_NORMALIZER_ID,
  BRUCKNER_2026_NORMALIZER_VERSION,
  normalizeBruckner2026Answer,
  parseBruckner2026ChineseInteger,
} from '../dist/normalizers/bruckner2026.js'

const normalize = (raw, lang, normalizeAs, extra = {}) => (
  normalizeBruckner2026Answer(raw, { lang, normalizeAs, ...extra })
)

test('pins the archived behavioural source', () => {
  assert.equal(BRUCKNER_2026_NORMALIZER_ID, 'bruckner-author-compatible-normalizer/v1')
  assert.equal(BRUCKNER_2026_NORMALIZER_VERSION, '1.0.0')
  assert.equal(BRUCKNER_2026_NORMALIZER_SOURCE_DOI, '10.5281/zenodo.21278793')
  assert.match(BRUCKNER_2026_NORMALIZER_SOURCE_SHA256, /^[a-f0-9]{64}$/)
  assert.equal(
    BRUCKNER_2026_NORMALIZER_SOURCE_SHA256,
    '8f755ca604e4814126c253f44135199b1636ddfedcb070fa4ece3368fb858fa8',
  )
})

test('normalizes NFC, archived punctuation, whitespace, and Arabic-Indic digits', () => {
  assert.deepEqual(normalize('  “٤٢”.\n', 'ar', 'integer', { min: 1, max: 100 }), {
    normalized: '42',
    category: 'valid',
  })
  assert.deepEqual(normalize('۰۷!', 'ar', 'integer', { min: 1, max: 100 }), {
    normalized: '7',
    category: 'valid',
  })
  assert.deepEqual(normalize('A\u030A', 'en', 'grapheme'), {
    normalized: 'å',
    category: 'valid',
  })
  assert.equal(normalize('“…”', 'en', 'word').category, 'valid')
})

test('extracts integer digits and applies inclusive task ranges', () => {
  assert.deepEqual(normalize('answer: 10', 'en', 'integer', { min: 1, max: 10 }), {
    normalized: '10',
    category: 'valid',
  })
  assert.deepEqual(normalize('11', 'ru', 'integer', { min: 1, max: 10 }), {
    normalized: '11',
    category: 'invalid',
  })
  assert.deepEqual(normalize('forty-two', 'en', 'integer', { min: 1, max: 100 }), {
    normalized: null,
    category: 'invalid',
  })
  assert.equal(normalize('４２', 'en', 'integer', { min: 1, max: 100 }).category, 'invalid')
})

test('parses only the archived Chinese numeral boundary through 99', () => {
  assert.equal(parseBruckner2026ChineseInteger('七'), 7)
  assert.equal(parseBruckner2026ChineseInteger('十'), 10)
  assert.equal(parseBruckner2026ChineseInteger('十七'), 17)
  assert.equal(parseBruckner2026ChineseInteger('四十二'), 42)
  assert.equal(parseBruckner2026ChineseInteger('九十九'), 99)
  assert.equal(parseBruckner2026ChineseInteger('一二'), 1)
  assert.equal(parseBruckner2026ChineseInteger('一百'), null)
  assert.deepEqual(normalize('四十二', 'zh', 'integer', { min: 1, max: 100 }), {
    normalized: '42',
    category: 'valid',
  })
})

test('leaves favourite numbers unbounded when no explicit range is supplied', () => {
  assert.equal(normalize('0', 'en', 'integer').category, 'valid')
  assert.equal(normalize('10000', 'en', 'integer').category, 'valid')
  assert.deepEqual(normalize('10001', 'en', 'integer'), {
    normalized: '10001',
    category: 'valid',
  })
  assert.deepEqual(normalize('-7', 'en', 'integer'), {
    normalized: '7',
    category: 'valid',
  })
})

test('detects the archived refusal vocabulary in all four languages', () => {
  assert.equal(normalize("I'm sorry, I can't choose.", 'en', 'word').category, 'refusal')
  assert.equal(normalize('Извините, не могу ответить.', 'ru', 'word').category, 'refusal')
  assert.equal(normalize('抱歉，无法回答。', 'zh', 'word').category, 'refusal')
  assert.equal(normalize('عذراً، لا أستطيع.', 'ar', 'word').category, 'refusal')
})

test('word accepts up to three whitespace tokens and keeps the first', () => {
  assert.deepEqual(normalize('New York City', 'en', 'word'), {
    normalized: 'new',
    category: 'valid',
  })
  assert.deepEqual(normalize('один два три четыре', 'ru', 'word'), {
    normalized: null,
    category: 'invalid',
  })
  assert.deepEqual(normalize('北京 市', 'zh', 'word'), {
    normalized: '北京',
    category: 'valid',
  })
})

test('grapheme follows the archived code-point and Chinese boundaries', () => {
  assert.deepEqual(normalize('letter A please', 'en', 'grapheme'), {
    normalized: 'a',
    category: 'valid',
  })
  assert.deepEqual(normalize('буква я', 'ru', 'grapheme'), {
    normalized: 'я',
    category: 'valid',
  })
  assert.deepEqual(normalize('汉字', 'zh', 'grapheme'), {
    normalized: '汉字',
    category: 'valid',
  })
  assert.deepEqual(normalize('letter only', 'en', 'grapheme'), {
    normalized: null,
    category: 'invalid',
  })
})

test('maps the four language-specific coin pairs to h/t', () => {
  const cases = [
    ['Heads!', 'en', 'h'],
    ['tails', 'en', 't'],
    ['Орёл', 'ru', 'h'],
    ['решка', 'ru', 't'],
    ['正面', 'zh', 'h'],
    ['反', 'zh', 't'],
    ['صورة', 'ar', 'h'],
    ['كتابة', 'ar', 't'],
  ]
  for (const [raw, lang, expected] of cases) {
    assert.deepEqual(normalize(raw, lang, 'binary'), {
      normalized: expected,
      category: 'valid',
    })
  }
  assert.deepEqual(normalize('head', 'en', 'binary'), {
    normalized: null,
    category: 'invalid',
  })
  assert.deepEqual(normalize('constructor', 'en', 'binary'), {
    normalized: null,
    category: 'invalid',
  })
})

test('distinguishes empty input from punctuation-only and unknown values', () => {
  assert.equal(normalize(null, 'en', 'word').category, 'empty')
  assert.equal(normalize('   ', 'en', 'word').category, 'empty')
  assert.equal(normalize('"?!"', 'en', 'word').category, 'empty')
  assert.equal(normalize('maybe', 'en', 'binary').category, 'invalid')
})
