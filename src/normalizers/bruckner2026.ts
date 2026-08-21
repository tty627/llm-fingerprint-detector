/**
 * Clean-room implementation of the answer-normalization behaviour archived
 * with Bruckner's 2026 single-token fingerprinting study.
 *
 * This module is deliberately opt-in. The legacy `normalizeAnswer` pipeline
 * remains unchanged so existing `one-token/v1` fingerprints keep their
 * original semantics.
 *
 * Behavioural reference:
 *   DOI: 10.5281/zenodo.21278793
 *   archived file: stats/01-normalize.js
 *   SHA-256: 8f755ca604e4814126c253f44135199b1636ddfedcb070fa4ece3368fb858fa8
 */

export const BRUCKNER_2026_NORMALIZER_ID = 'bruckner-author-compatible-normalizer/v1'
export const BRUCKNER_2026_NORMALIZER_VERSION = '1.0.0'
export const BRUCKNER_2026_NORMALIZER_SOURCE_DOI = '10.5281/zenodo.21278793'
export const BRUCKNER_2026_NORMALIZER_SOURCE_SHA256 =
  '8f755ca604e4814126c253f44135199b1636ddfedcb070fa4ece3368fb858fa8'

export type Bruckner2026Language = 'en' | 'ru' | 'zh' | 'ar'
export type Bruckner2026NormalizeAs = 'integer' | 'word' | 'grapheme' | 'binary'
export type Bruckner2026AnswerCategory = 'valid' | 'invalid' | 'refusal' | 'empty'

interface Bruckner2026BaseOptions {
  lang: Bruckner2026Language
}

export interface Bruckner2026IntegerOptions extends Bruckner2026BaseOptions {
  normalizeAs: 'integer'
  /** Inclusive lower bound for an ordinary integer task. */
  min?: number
  /** Inclusive upper bound for an ordinary integer task. */
  max?: number
}

export interface Bruckner2026TextOptions extends Bruckner2026BaseOptions {
  normalizeAs: Exclude<Bruckner2026NormalizeAs, 'integer'>
}

export type Bruckner2026NormalizerOptions =
  | Bruckner2026IntegerOptions
  | Bruckner2026TextOptions

export interface Bruckner2026NormalizedAnswer {
  normalized: string | null
  category: Bruckner2026AnswerCategory
}

const PUNCTUATION = new Set([
  '«', '»', '"', '“', '”', '„', "'", '’', '‘', '`',
  '(', ')', '.', ',', '!', '?', '。', '！', '？', '、', '：', ':', ';',
  '؛', '؟', '[', ']', '{', '}', '*', '_', '#', '-',
])

const ARABIC_DIGIT_ZEROES = [0x0660, 0x06f0] as const

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
  '零': 0,
  '一': 1,
  '二': 2,
  '两': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
}

const REFUSAL_PATTERNS: ReadonlyArray<RegExp> = [
  /i can.?t/i,
  /i cannot/i,
  /i'm sorry/i,
  /as an ai/i,
  /не могу/i,
  /извин/i,
  /抱歉/,
  /无法/,
  /لا أستطيع/i,
  /عذراً/i,
  /آسف/i,
]

const COIN_ANSWERS: Readonly<Record<Bruckner2026Language, Readonly<Record<string, 'h' | 't'>>>> = {
  en: { heads: 'h', tails: 't' },
  ru: { 'орёл': 'h', 'орел': 'h', 'решка': 't' },
  zh: { '正面': 'h', '正': 'h', '反面': 't', '反': 't' },
  ar: { 'صورة': 'h', 'كتابة': 't' },
}

function cleanPunctuationAndWhitespace(raw: string): string {
  let result = ''
  let previousWasSpace = false

  for (const char of raw.normalize('NFC')) {
    const replacement = PUNCTUATION.has(char) ? ' ' : char
    if (/\s/u.test(replacement)) {
      if (!previousWasSpace) result += ' '
      previousWasSpace = true
    } else {
      result += replacement
      previousWasSpace = false
    }
  }

  return result.trim()
}

function normalizeArabicIndicDigits(value: string): string {
  let result = ''
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? -1
    let replacement: string | null = null
    for (const zero of ARABIC_DIGIT_ZEROES) {
      if (codePoint >= zero && codePoint <= zero + 9) {
        replacement = String(codePoint - zero)
        break
      }
    }
    result += replacement ?? char
  }
  return result
}

/** Parse the study's deliberately narrow Chinese integer vocabulary (0-99). */
export function parseBruckner2026ChineseInteger(value: string): number | null {
  if (!value) return null

  const characters = [...value]
  const tenIndex = characters.indexOf('十')
  if (tenIndex === -1) {
    if (characters.length < 1 || characters.length > 2) return null
    if (characters.some((character) => CHINESE_DIGITS[character] === undefined)) return null
    // The archived matcher permits two adjacent digit glyphs and, without a
    // tens marker, keeps the leading glyph. Preserve that edge case here.
    return CHINESE_DIGITS[characters[0]]
  }
  if (tenIndex !== characters.lastIndexOf('十') || characters.length > 3) return null

  const before = characters.slice(0, tenIndex)
  const after = characters.slice(tenIndex + 1)
  if (before.length > 1 || after.length > 1) return null

  const tens = before.length === 0 ? 1 : CHINESE_DIGITS[before[0]]
  const ones = after.length === 0 ? 0 : CHINESE_DIGITS[after[0]]
  if (tens === undefined || ones === undefined) return null
  return (tens * 10) + ones
}

function normalizeInteger(
  cleaned: string,
  options: Bruckner2026IntegerOptions,
): Bruckner2026NormalizedAnswer {
  const digitMatch = /\d+/.exec(cleaned)
  const parsed = digitMatch === null
    ? (options.lang === 'zh' ? parseBruckner2026ChineseInteger(cleaned) : null)
    : Number.parseInt(digitMatch[0], 10)

  if (parsed === null) return { normalized: null, category: 'invalid' }

  const lowerBound = options.min
  const upperBound = options.max
  const inRange = (lowerBound === undefined || parsed >= lowerBound)
    && (upperBound === undefined || parsed <= upperBound)

  return {
    normalized: String(parsed),
    category: inRange ? 'valid' : 'invalid',
  }
}

function normalizeBinary(
  firstWord: string,
  lang: Bruckner2026Language,
): Bruckner2026NormalizedAnswer {
  const answers = COIN_ANSWERS[lang]
  const normalized = Object.hasOwn(answers, firstWord) ? answers[firstWord] : undefined
  return normalized === undefined
    ? { normalized: null, category: 'invalid' }
    : { normalized, category: 'valid' }
}

/**
 * Normalize one response using the archived study semantics.
 *
 * The function accepts task-level normalization metadata instead of importing
 * the archive's prompt catalog, which keeps this implementation dependency-free
 * and makes protocol selection explicit at the call site.
 */
export function normalizeBruckner2026Answer(
  raw: string | null | undefined,
  options: Bruckner2026NormalizerOptions,
): Bruckner2026NormalizedAnswer {
  if (raw == null || raw.trim() === '') return { normalized: null, category: 'empty' }
  if (REFUSAL_PATTERNS.some((pattern) => pattern.test(raw))) {
    return { normalized: null, category: 'refusal' }
  }

  const cleaned = normalizeArabicIndicDigits(cleanPunctuationAndWhitespace(raw))
  if (!cleaned) return { normalized: null, category: 'empty' }

  if (options.normalizeAs === 'integer') return normalizeInteger(cleaned, options)

  const words = cleaned.toLowerCase().split(' ')
  const firstWord = words[0]
  if (!firstWord) return { normalized: null, category: 'empty' }

  if (options.normalizeAs === 'binary') return normalizeBinary(firstWord, options.lang)

  if (options.normalizeAs === 'word') {
    if (words.length > 3) return { normalized: null, category: 'invalid' }
    return { normalized: firstWord, category: 'valid' }
  }

  if ([...firstWord].length === 1 || options.lang === 'zh') {
    return { normalized: firstWord, category: 'valid' }
  }

  const singleCodePointWord = words.find((word) => [...word].length === 1)
  return singleCodePointWord === undefined
    ? { normalized: null, category: 'invalid' }
    : { normalized: singleCodePointWord, category: 'valid' }
}
