#!/usr/bin/env node

/**
 * Rebuild the small offline golden fixture from Bruckner's pinned Zenodo
 * software and data archives. This script never performs network requests.
 *
 * Usage:
 *   node scripts/generate-bruckner2026-author-golden.mjs \
 *     --author-source /path/to/extracted/pamela-publish-code \
 *     --author-code-zip /path/to/pamela-publish-code.zip \
 *     --author-data-zip /path/to/pamela-publish-data.zip
 *
 * The JSON is written to stdout. Review it, then update the checked-in fixture
 * with apply_patch. Archive bytes are accepted only after their pinned hashes
 * have been verified.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SOFTWARE_DOI = '10.5281/zenodo.21278793'
const DATASET_DOI = '10.5281/zenodo.21278557'

const PINNED = Object.freeze({
  codeArchiveMd5: 'd81de3b8ef5c0bca74fd7c2bdbb41a6b',
  codeArchiveSha256: '8a9c8db47609fd0682a44398e55a4e0b322cf3ae479c3189f0874aae928044ef',
  dataArchiveMd5: 'f2ce3fba3081f73e9908179fb2f061b6',
  dataArchiveSha256: '160104321694472ba328d48de6f6b93ee962d0e97fb4d212a023efa5a2de9f7c',
  normalizedSha256: '627c00076090f70db2feb154c88eb31eabf804dbbb100e249c2281dfaae5d237',
  promptsSha256: '32f4fc3ab5077438f362bb4d0c06d1ebbe2bb5d2e0809474045dcd60a6b592c1',
  normalizerSha256: '8f755ca604e4814126c253f44135199b1636ddfedcb070fa4ece3368fb858fa8',
  divergenceSha256: 'ebd794d9ff4da10fc8ecbe45db0bc7da13ce08a6840082c4204d9c3923c4ca30',
  schedulerSha256: '0ed556db47fa318416e777f63a80ea97b0397f7806488ca8d5db09121f972746',
  runnerSha256: 'cf260202850f2d64e8919dacd426a93da72914ecbdf4a3874c88f8d0af0aea8b',
  runConfigSha256: 'b188f9983ddd0046f7f754e9709fc5d700f9a2781d38d94b55742b9c38ac24e3',
  colorLexiconSha256: '6564dff8c3fbe64509bfd816bc8cc6f94249cdf4924818e301f74b58fdbac06c',
  canonicalPayloadSha256: '9ef56c982a503b4dba94710b63866aaff47db1e37cc34538e225acb9f5fe1341',
})

const DATASET_NORMALIZER_KEYS = [
  '61dd180cae7e8afd', // Arabic-Indic integer
  '1662d803f1189577', // Chinese numeral
  '51761ae0957e1848', // unbounded favourite number
  'd545a746607b1653', // archived zh grapheme permissiveness
  'ce42b4f784203517', // invalid multi-code-point Arabic grapheme
  'cb1a1ed58f29985d', // English refusal
  '5f1c1f313b8ed020', // Chinese refusal
  'de0c843e192bbc3d', // Russian coin mapping
  '4623c6023a1c81e9', // unsupported coin abbreviation
  '174fed8221244aea', // word response with more than three tokens
  'b7c732192eaec911', // non-numeric favourite-number answer
  'b0ac43b94d592657', // leading newline and zh city
  '0438510ad714e2f6', // case-folding and trailing newline
]

const PARITY_SELECTION = Object.freeze({
  model: 'meta-llama/llama-3.3-70b-instruct',
  taskId: 'animal-random',
  language: 'en',
  temperature: 1,
  firstRepetitions: 10,
})

const SYNTHETIC_CASES = [
  { id: 'arabic-indic-punctuation', taskId: 'num100-random', lang: 'ar', raw: '  “٤٢”.\n' },
  { id: 'persian-digits-leading-zero', taskId: 'num100-random', lang: 'ar', raw: '۰۷!' },
  { id: 'nfc-grapheme', taskId: 'letter-random', lang: 'en', raw: 'A\u030A' },
  { id: 'ellipsis-is-not-in-punctuation-set', taskId: 'word-random', lang: 'en', raw: '“…”' },
  { id: 'integer-first-digits-anywhere', taskId: 'num10-random', lang: 'en', raw: 'answer: 10' },
  { id: 'integer-range-invalid', taskId: 'num10-random', lang: 'ru', raw: '11' },
  { id: 'fullwidth-digits-invalid', taskId: 'num100-random', lang: 'en', raw: '４２' },
  { id: 'chinese-adjacent-digits-keeps-first', taskId: 'num100-random', lang: 'zh', raw: '一二' },
  { id: 'favourite-number-has-no-range', taskId: 'num-favorite', lang: 'en', raw: '10001' },
  { id: 'ascii-minus-is-cleaned', taskId: 'num-favorite', lang: 'en', raw: '-7' },
  { id: 'word-three-tokens-keeps-first', taskId: 'city-random', lang: 'en', raw: 'New York City' },
  { id: 'word-four-tokens-invalid', taskId: 'word-random', lang: 'ru', raw: 'один два три четыре' },
  { id: 'grapheme-finds-single-token', taskId: 'letter-random', lang: 'en', raw: 'letter A please' },
  { id: 'zh-grapheme-does-not-enforce-one-code-point', taskId: 'letter-random', lang: 'zh', raw: '汉字' },
  { id: 'coin-maps-heads', taskId: 'coin-flip', lang: 'en', raw: 'Heads!' },
  { id: 'coin-rejects-abbreviation', taskId: 'coin-flip', lang: 'en', raw: 'T' },
  { id: 'punctuation-only-is-empty', taskId: 'word-random', lang: 'en', raw: '"?!"' },
]

function usage(message = '') {
  if (message) console.error(message)
  console.error('Required: --author-source, --author-code-zip, --author-data-zip')
  process.exit(2)
}

function parseArgs(argv) {
  const args = {}
  for (let index = 2; index < argv.length; index += 1) {
    const match = /^--([a-z-]+)$/.exec(argv[index])
    if (!match) usage(`Unknown argument: ${argv[index]}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) usage(`Missing value for ${argv[index]}`)
    args[match[1]] = value
    index += 1
  }
  return args
}

function digestBuffer(algorithm, value) {
  return createHash(algorithm).update(value).digest('hex')
}

function digestFile(algorithm, filePath) {
  return digestBuffer(algorithm, readFileSync(filePath))
}

function readPinnedFile(root, relativePath, expectedSha256) {
  const filePath = path.join(root, relativePath)
  const bytes = readFileSync(filePath)
  assert.equal(
    digestBuffer('sha256', bytes),
    expectedSha256,
    `${relativePath} differs from the pinned software archive`,
  )
  return bytes.toString('utf8')
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function canonicalSerialize(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256Canonical(value) {
  return digestBuffer('sha256', Buffer.from(canonicalSerialize(value), 'utf8'))
}

function extractBlock(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, `Could not isolate ${label} from pinned source`)
  return source.slice(start, end)
}

function compileArchivedNormalizer(source, prompts, colorLexicon) {
  const block = extractBlock(
    source,
    'const AR_DIGITS =',
    '// ---------------------------------------------------------------- main',
    'normalizer',
  )
  const factory = new Function(
    'prompts',
    'colorLex',
    `"use strict";\nconst taskById = Object.fromEntries(prompts.tasks.map((task) => [task.id, task]));\n${block}\nreturn normalize;`,
  )
  return factory(prompts, colorLexicon)
}

function compileArchivedJsd(source) {
  const block = extractBlock(
    source,
    'const log2 = Math.log2;',
    '// ---------------------------------------------------------- full-sample JSD matrix',
    'JSD implementation',
  )
  return new Function(`"use strict";\n${block}\nreturn jsd;`)()
}

function compileArchivedShuffle(source) {
  const block = extractBlock(
    source,
    'export function seededShuffle',
    '// Minimal concurrency pool',
    'seeded shuffle implementation',
  ).replace('export function seededShuffle', 'function seededShuffle')
  return new Function(`"use strict";\n${block}\nreturn seededShuffle;`)()
}

function taskNormalizerInput(taskById, taskId, lang, raw) {
  const task = taskById[taskId]
  assert.ok(task, `Unknown fixture task: ${taskId}`)
  return { task_id: taskId, lang, raw }
}

function compactNormalizationResult(result) {
  return {
    normalized: result.normalized,
    category: result.answer_class,
  }
}

function countValues(records) {
  const counts = {}
  for (const record of records) counts[record.normalized] = (counts[record.normalized] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function readSelectedDatasetRecords(zipPath) {
  const normalized = execFileSync(
    'unzip',
    ['-p', zipPath, 'data/derived/normalized.jsonl'],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  )
  assert.equal(digestBuffer('sha256', Buffer.from(normalized, 'utf8')), PINNED.normalizedSha256)

  const keySet = new Set(DATASET_NORMALIZER_KEYS)
  const byKey = new Map()
  const parity = []
  for (const line of normalized.split('\n')) {
    if (!line) continue
    const couldBeKey = DATASET_NORMALIZER_KEYS.some((key) => line.includes(key))
    const couldBeParity = line.includes(`"model":"${PARITY_SELECTION.model}"`)
      && line.includes(`"task_id":"${PARITY_SELECTION.taskId}"`)
      && line.includes(`"lang":"${PARITY_SELECTION.language}"`)
    if (!couldBeKey && !couldBeParity) continue
    const record = JSON.parse(line)
    if (keySet.has(record.key)) byKey.set(record.key, record)
    if (
      record.model === PARITY_SELECTION.model
      && record.task_id === PARITY_SELECTION.taskId
      && record.lang === PARITY_SELECTION.language
      && record.temperature === PARITY_SELECTION.temperature
      && record.rep >= 0
      && record.rep < PARITY_SELECTION.firstRepetitions
    ) parity.push(record)
  }
  assert.deepEqual([...byKey.keys()].sort(), [...keySet].sort(), 'Not all fixed source keys were found')
  assert.equal(parity.length, PARITY_SELECTION.firstRepetitions)
  parity.sort((left, right) => left.rep - right.rep)
  return {
    normalizerRecords: DATASET_NORMALIZER_KEYS.map((key) => byKey.get(key)),
    parityRecords: parity,
  }
}

const args = parseArgs(process.argv)
const authorSource = args['author-source']
const codeZip = args['author-code-zip']
const dataZip = args['author-data-zip']
if (!authorSource || !codeZip || !dataZip) usage()

assert.equal(digestFile('md5', codeZip), PINNED.codeArchiveMd5, 'code archive MD5 mismatch')
assert.equal(digestFile('sha256', codeZip), PINNED.codeArchiveSha256, 'code archive SHA-256 mismatch')
assert.equal(digestFile('md5', dataZip), PINNED.dataArchiveMd5, 'data archive MD5 mismatch')
assert.equal(digestFile('sha256', dataZip), PINNED.dataArchiveSha256, 'data archive SHA-256 mismatch')

const promptsText = readPinnedFile(authorSource, 'config/prompts.json', PINNED.promptsSha256)
const normalizerSource = readPinnedFile(authorSource, 'stats/01-normalize.js', PINNED.normalizerSha256)
const divergenceSource = readPinnedFile(authorSource, 'stats/03-divergence.js', PINNED.divergenceSha256)
const schedulerSource = readPinnedFile(authorSource, 'run/lib.js', PINNED.schedulerSha256)
const runnerSource = readPinnedFile(authorSource, 'run/run-experiment.js', PINNED.runnerSha256)
const runConfigText = readPinnedFile(authorSource, 'config/run.config.json', PINNED.runConfigSha256)
const colorLexiconText = readPinnedFile(authorSource, 'stats/color-lexicon.json', PINNED.colorLexiconSha256)

assert.match(divergenceSource, /const half = r\.rep % 2 === 0 \? 'A' : 'B';/)
assert.match(runnerSource, /temperature: cell\.temperature, maxTokens: runCfg\.request\.max_tokens/)
assert.match(schedulerSource, /reasoning: \{ enabled: false \}/)
assert.match(schedulerSource, /usage: \{ include: true \}/)
assert.doesNotMatch(schedulerSource, /top_p\s*:/)

const prompts = JSON.parse(promptsText)
const runConfig = JSON.parse(runConfigText)
const colorLexicon = JSON.parse(colorLexiconText)
const authorPackage = JSON.parse(readFileSync(path.join(authorSource, 'package.json'), 'utf8'))
assert.equal(authorPackage.license, 'MIT')
const studyATasks = prompts.tasks.filter((task) => task.paper === 1)
assert.equal(studyATasks.length, 10)
const distributionPlan = runConfig.temperatures.main.find((entry) => entry.t === 1)
assert.ok(distributionPlan, 'Pinned run config is missing the main T=1 distribution plan')
const payload = {
  languages: prompts.languages,
  system_prompts: prompts.system_prompts,
  tasks: studyATasks.map(({ id, category, condition, answer_space, normalize_as, prompts: taskPrompts }) => ({
    id,
    category,
    condition,
    answer_space,
    normalize_as,
    prompts: taskPrompts,
  })),
}
assert.equal(sha256Canonical(payload), PINNED.canonicalPayloadSha256)

const normalize = compileArchivedNormalizer(normalizerSource, prompts, colorLexicon)
const archivedJsd = compileArchivedJsd(divergenceSource)
const archivedShuffle = compileArchivedShuffle(schedulerSource)
const taskById = Object.fromEntries(studyATasks.map((task) => [task.id, task]))
const selected = readSelectedDatasetRecords(dataZip)

const datasetNormalizerRecords = selected.normalizerRecords.map((record) => {
  const expected = compactNormalizationResult(
    normalize(taskNormalizerInput(taskById, record.task_id, record.lang, record.raw)),
  )
  assert.deepEqual(
    expected,
    { normalized: record.normalized, category: record.answer_class },
    `Pinned normalizer and published normalized record disagree for ${record.key}`,
  )
  return {
    sourceKey: record.key,
    taskId: record.task_id,
    lang: record.lang,
    rep: record.rep,
    raw: record.raw,
    expected,
  }
})

const syntheticNormalizerCases = SYNTHETIC_CASES.map((fixtureCase) => ({
  ...fixtureCase,
  expected: compactNormalizationResult(
    normalize(taskNormalizerInput(taskById, fixtureCase.taskId, fixtureCase.lang, fixtureCase.raw)),
  ),
}))

const parityRecords = selected.parityRecords.map((record) => {
  assert.equal(record.answer_class, 'valid')
  return {
    sourceKey: record.key,
    rep: record.rep,
    raw: record.raw,
    normalized: record.normalized,
    category: record.answer_class,
  }
})
const evenCounts = countValues(parityRecords.filter((record) => record.rep % 2 === 0))
const oddCounts = countValues(parityRecords.filter((record) => record.rep % 2 !== 0))
const parityJsd = archivedJsd(
  Object.fromEntries(Object.entries(evenCounts).map(([key, value]) => [key, value / 5])),
  Object.fromEntries(Object.entries(oddCounts).map(([key, value]) => [key, value / 5])),
)

const jsdCases = [
  { id: 'identical', countsP: { a: 4, b: 1 }, countsQ: { a: 4, b: 1 } },
  { id: 'disjoint', countsP: { a: 5 }, countsQ: { b: 5 } },
  { id: 'published-parity-subset', countsP: evenCounts, countsQ: oddCounts },
].map((fixtureCase) => {
  const toDistribution = (counts) => {
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
    return Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, count / total]))
  }
  const expectedBits = archivedJsd(
    toDistribution(fixtureCase.countsP),
    toDistribution(fixtureCase.countsQ),
  )
  return {
    ...fixtureCase,
    expectedBits,
    authorRounded4: Number(expectedBits.toFixed(4)),
  }
})

const shuffleInput = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
const fixture = {
  fixtureVersion: 1,
  scope: 'Offline author-behaviour golden checks only; this fixture does not reproduce ROC or EER.',
  provenance: {
    software: {
      doi: SOFTWARE_DOI,
      license: 'MIT',
      archiveFilename: 'pamela-publish-code.zip',
      archiveMd5: PINNED.codeArchiveMd5,
      archiveSha256: PINNED.codeArchiveSha256,
      sources: {
        prompts: { path: 'config/prompts.json', sha256: PINNED.promptsSha256 },
        normalizer: { path: 'stats/01-normalize.js', sha256: PINNED.normalizerSha256 },
        divergence: { path: 'stats/03-divergence.js', sha256: PINNED.divergenceSha256 },
        scheduler: { path: 'run/lib.js', sha256: PINNED.schedulerSha256 },
        runner: { path: 'run/run-experiment.js', sha256: PINNED.runnerSha256 },
        runConfig: { path: 'config/run.config.json', sha256: PINNED.runConfigSha256 },
        colorLexicon: { path: 'stats/color-lexicon.json', sha256: PINNED.colorLexiconSha256 },
      },
    },
    dataset: {
      doi: DATASET_DOI,
      license: 'CC-BY-4.0',
      archiveFilename: 'pamela-publish-data.zip',
      archiveMd5: PINNED.dataArchiveMd5,
      archiveSha256: PINNED.dataArchiveSha256,
      normalizedPath: 'data/derived/normalized.jsonl',
      normalizedSha256: PINNED.normalizedSha256,
      selection: 'Fixed source keys plus reps 0-9 of one fixed Study A cell; no records were generated by this project.',
    },
  },
  canonicalStudyA: {
    languages: payload.languages,
    taskIds: studyATasks.map((task) => task.id),
    cellCount: studyATasks.length * payload.languages.length,
    payloadSha256: PINNED.canonicalPayloadSha256,
    request: {
      temperature: distributionPlan.t,
      maxTokens: runConfig.request.max_tokens,
      topP: 'omitted',
      reasoningEnabled: false,
      usageInclude: true,
    },
    cells: studyATasks.flatMap((task) => payload.languages.map((lang) => ({
      cellId: `${task.id}:${lang}`,
      promptPairSha256: sha256Canonical({
        systemPrompt: payload.system_prompts[lang],
        userPrompt: task.prompts[lang],
      }),
    }))),
  },
  normalizerSyntheticCases: syntheticNormalizerCases,
  normalizerDatasetRecords: datasetNormalizerRecords,
  jsdCases,
  parityDatasetSubset: {
    ...PARITY_SELECTION,
    records: parityRecords,
    expectedEvenCounts: evenCounts,
    expectedOddCounts: oddCounts,
    expectedJsdBits: parityJsd,
    authorRounded4: Number(parityJsd.toFixed(4)),
  },
  schedulerCase: {
    seed: 'paper-golden-01',
    input: shuffleInput,
    expected: archivedShuffle(shuffleInput, 'paper-golden-01'),
  },
}

process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`)
