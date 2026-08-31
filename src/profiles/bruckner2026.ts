/**
 * Exact, opt-in Study A prompt profile derived from the author's archived
 * `config/prompts.json`. This module describes a protocol; it does not select
 * the profile for the legacy collector or perform network requests.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  BRUCKNER_2026_NORMALIZER_ID,
  BRUCKNER_2026_NORMALIZER_SOURCE_SHA256,
  BRUCKNER_2026_NORMALIZER_VERSION,
} from '../normalizers/bruckner2026.js'
import { canonicalSerialize, validateProtocolManifest } from '../protocol.js'
import type { ProtocolCellId, ProtocolManifest } from '../types.js'

export const BRUCKNER_2026_PROFILE_ID = 'bruckner-2026-canonical40'
export const BRUCKNER_2026_PROFILE_VERSION = '1.0.0'
export const BRUCKNER_2026_SOFTWARE_DOI = '10.5281/zenodo.21278793'
export const BRUCKNER_2026_PROMPTS_VERSION = '1.0.0'
export const BRUCKNER_2026_ARCHIVE_MD5 = 'd81de3b8ef5c0bca74fd7c2bdbb41a6b'
export const BRUCKNER_2026_ARCHIVE_SHA256 =
  '8a9c8db47609fd0682a44398e55a4e0b322cf3ae479c3189f0874aae928044ef'
export const BRUCKNER_2026_OFFICIAL_PROMPTS_SHA256 =
  '32f4fc3ab5077438f362bb4d0c06d1ebbe2bb5d2e0809474045dcd60a6b592c1'
export const BRUCKNER_2026_CANONICAL_PAYLOAD_SHA256 =
  '9ef56c982a503b4dba94710b63866aaff47db1e37cc34538e225acb9f5fe1341'
export const BRUCKNER_2026_SYSTEM_PROMPTS_SHA256 =
  '1f5353a59436724ba9c9140ad159d47dc274ea7d0783db5ea6792f90dd277962'
export const BRUCKNER_2026_TASKS_SHA256 =
  'f6f519484809a7f585e272ee68468927b0b3d4db574351b444acc2d6383c8937'

export const BRUCKNER_2026_LANGUAGES = ['en', 'ru', 'zh', 'ar'] as const
export type Bruckner2026ProfileLanguage = (typeof BRUCKNER_2026_LANGUAGES)[number]

export const BRUCKNER_2026_TASK_IDS = [
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
] as const
export type Bruckner2026TaskId = (typeof BRUCKNER_2026_TASK_IDS)[number]

export type Bruckner2026TaskCategory =
  | 'number'
  | 'letter'
  | 'word'
  | 'color'
  | 'animal'
  | 'city'
  | 'binary'
export type Bruckner2026TaskCondition = 'random' | 'favorite'
export type Bruckner2026TaskNormalizer = 'integer' | 'grapheme' | 'word' | 'binary'

export interface Bruckner2026ProfileTask {
  readonly id: Bruckner2026TaskId
  readonly category: Bruckner2026TaskCategory
  readonly condition: Bruckner2026TaskCondition
  readonly answer_space: string
  readonly normalize_as: Bruckner2026TaskNormalizer
  readonly prompts: Readonly<Record<Bruckner2026ProfileLanguage, string>>
}

export interface Bruckner2026CanonicalPayload {
  readonly languages: readonly Bruckner2026ProfileLanguage[]
  readonly system_prompts: Readonly<Record<Bruckner2026ProfileLanguage, string>>
  readonly tasks: readonly Bruckner2026ProfileTask[]
}

export interface Bruckner2026Canonical40Profile extends Bruckner2026CanonicalPayload {
  readonly profileId: typeof BRUCKNER_2026_PROFILE_ID
  readonly profileVersion: typeof BRUCKNER_2026_PROFILE_VERSION
  readonly study: {
    readonly paper: 1
    readonly label: 'Study A'
  }
  readonly authors: readonly [{ readonly name: 'Tomáš Bruckner'; readonly copyrightYear: 2026 }]
  readonly source: {
    readonly promptsVersion: typeof BRUCKNER_2026_PROMPTS_VERSION
    readonly softwareDoi: typeof BRUCKNER_2026_SOFTWARE_DOI
    readonly archiveFilename: 'pamela-publish-code.zip'
    readonly archiveMd5: typeof BRUCKNER_2026_ARCHIVE_MD5
    readonly archiveSha256: typeof BRUCKNER_2026_ARCHIVE_SHA256
    readonly officialPromptsSha256: typeof BRUCKNER_2026_OFFICIAL_PROMPTS_SHA256
    readonly canonicalPayloadSha256: typeof BRUCKNER_2026_CANONICAL_PAYLOAD_SHA256
    readonly normalizerSourcePath: 'stats/01-normalize.js'
    readonly normalizerSourceSha256: typeof BRUCKNER_2026_NORMALIZER_SOURCE_SHA256
  }
  readonly paraphrasePolicy: 'fixed'
}

export interface Bruckner2026ProtocolCell {
  readonly cellId: ProtocolCellId
  readonly taskId: Bruckner2026TaskId
  readonly language: Bruckner2026ProfileLanguage
  readonly systemPrompt: string
  readonly userPrompt: string
  readonly category: Bruckner2026TaskCategory
  readonly condition: Bruckner2026TaskCondition
  readonly answerSpace: string
  readonly normalizeAs: Bruckner2026TaskNormalizer
  readonly paraphrasePolicy: 'fixed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new Error(`Bruckner 2026 canonical profile: ${path} ${message}`)
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'must be an object')
  return value
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const expectedSet = new Set(expected)
  const missing = expected.filter((key) => !Object.hasOwn(value, key))
  if (missing.length > 0) fail(path, `is missing required key "${missing[0]}"`)
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key))
  if (unknown.length > 0) fail(path, `contains unknown key "${unknown[0]}"`)
}

function requireExact(value: unknown, expected: string | number, path: string): void {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`)
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string')
  return value
}

function requireStringEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function validateLanguageMap(value: unknown, path: string): Record<Bruckner2026ProfileLanguage, string> {
  const record = requireRecord(value, path)
  assertExactKeys(record, BRUCKNER_2026_LANGUAGES, path)
  return Object.fromEntries(
    BRUCKNER_2026_LANGUAGES.map((language) => [
      language,
      requireNonEmptyString(record[language], `${path}.${language}`),
    ]),
  ) as Record<Bruckner2026ProfileLanguage, string>
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** The canonical payload excludes provenance fields and retains array order. */
export function buildBruckner2026CanonicalPayload(
  profile: Bruckner2026Canonical40Profile,
): Bruckner2026CanonicalPayload {
  return {
    languages: [...profile.languages],
    system_prompts: { ...profile.system_prompts },
    tasks: profile.tasks.map((task) => ({
      id: task.id,
      category: task.category,
      condition: task.condition,
      answer_space: task.answer_space,
      normalize_as: task.normalize_as,
      prompts: { ...task.prompts },
    })),
  }
}

/** Validate schema, fixed provenance, exact cardinality, and canonical payload hash. */
export function validateBruckner2026Canonical40Profile(
  value: unknown,
): Bruckner2026Canonical40Profile {
  const profile = requireRecord(value, 'profile')
  assertExactKeys(
    profile,
    [
      'profileId',
      'profileVersion',
      'study',
      'authors',
      'source',
      'paraphrasePolicy',
      'languages',
      'system_prompts',
      'tasks',
    ],
    'profile',
  )
  requireExact(profile.profileId, BRUCKNER_2026_PROFILE_ID, 'profile.profileId')
  requireExact(profile.profileVersion, BRUCKNER_2026_PROFILE_VERSION, 'profile.profileVersion')
  requireExact(profile.paraphrasePolicy, 'fixed', 'profile.paraphrasePolicy')

  const study = requireRecord(profile.study, 'profile.study')
  assertExactKeys(study, ['paper', 'label'], 'profile.study')
  requireExact(study.paper, 1, 'profile.study.paper')
  requireExact(study.label, 'Study A', 'profile.study.label')

  if (!Array.isArray(profile.authors) || profile.authors.length !== 1) {
    fail('profile.authors', 'must contain exactly one author')
  }
  const author = requireRecord(profile.authors[0], 'profile.authors[0]')
  assertExactKeys(author, ['name', 'copyrightYear'], 'profile.authors[0]')
  requireExact(author.name, 'Tomáš Bruckner', 'profile.authors[0].name')
  requireExact(author.copyrightYear, 2026, 'profile.authors[0].copyrightYear')

  const source = requireRecord(profile.source, 'profile.source')
  assertExactKeys(
    source,
    [
      'promptsVersion',
      'softwareDoi',
      'archiveFilename',
      'archiveMd5',
      'archiveSha256',
      'officialPromptsSha256',
      'canonicalPayloadSha256',
      'normalizerSourcePath',
      'normalizerSourceSha256',
    ],
    'profile.source',
  )
  const exactSourceValues: Readonly<Record<string, string>> = {
    promptsVersion: BRUCKNER_2026_PROMPTS_VERSION,
    softwareDoi: BRUCKNER_2026_SOFTWARE_DOI,
    archiveFilename: 'pamela-publish-code.zip',
    archiveMd5: BRUCKNER_2026_ARCHIVE_MD5,
    archiveSha256: BRUCKNER_2026_ARCHIVE_SHA256,
    officialPromptsSha256: BRUCKNER_2026_OFFICIAL_PROMPTS_SHA256,
    canonicalPayloadSha256: BRUCKNER_2026_CANONICAL_PAYLOAD_SHA256,
    normalizerSourcePath: 'stats/01-normalize.js',
    normalizerSourceSha256: BRUCKNER_2026_NORMALIZER_SOURCE_SHA256,
  }
  for (const [key, expected] of Object.entries(exactSourceValues)) {
    requireExact(source[key], expected, `profile.source.${key}`)
  }

  if (!Array.isArray(profile.languages)) fail('profile.languages', 'must be an array')
  if (
    profile.languages.length !== BRUCKNER_2026_LANGUAGES.length
    || profile.languages.some((language, index) => language !== BRUCKNER_2026_LANGUAGES[index])
  ) {
    fail('profile.languages', `must equal ${BRUCKNER_2026_LANGUAGES.join(', ')}`)
  }
  validateLanguageMap(profile.system_prompts, 'profile.system_prompts')

  if (!Array.isArray(profile.tasks) || profile.tasks.length !== BRUCKNER_2026_TASK_IDS.length) {
    fail('profile.tasks', 'must contain exactly ten Study A tasks')
  }
  const categories = ['number', 'letter', 'word', 'color', 'animal', 'city', 'binary'] as const
  const conditions = ['random', 'favorite'] as const
  const normalizers = ['integer', 'grapheme', 'word', 'binary'] as const
  for (const [index, taskValue] of profile.tasks.entries()) {
    const path = `profile.tasks[${index}]`
    const task = requireRecord(taskValue, path)
    assertExactKeys(
      task,
      ['id', 'category', 'condition', 'answer_space', 'normalize_as', 'prompts'],
      path,
    )
    requireExact(task.id, BRUCKNER_2026_TASK_IDS[index], `${path}.id`)
    requireStringEnum(task.category, categories, `${path}.category`)
    requireStringEnum(task.condition, conditions, `${path}.condition`)
    requireNonEmptyString(task.answer_space, `${path}.answer_space`)
    requireStringEnum(task.normalize_as, normalizers, `${path}.normalize_as`)
    validateLanguageMap(task.prompts, `${path}.prompts`)
  }

  const typedProfile = profile as unknown as Bruckner2026Canonical40Profile
  const canonicalPayload = buildBruckner2026CanonicalPayload(typedProfile)
  const canonicalPayloadSha256 = sha256(canonicalSerialize(canonicalPayload))
  if (canonicalPayloadSha256 !== BRUCKNER_2026_CANONICAL_PAYLOAD_SHA256) {
    fail(
      'profile.source.canonicalPayloadSha256',
      `does not match the derived payload (actual ${canonicalPayloadSha256})`,
    )
  }
  if (sha256(canonicalSerialize(typedProfile.system_prompts)) !== BRUCKNER_2026_SYSTEM_PROMPTS_SHA256) {
    fail('profile.system_prompts', 'does not match the pinned Study A system prompts')
  }
  if (sha256(canonicalSerialize(typedProfile.tasks)) !== BRUCKNER_2026_TASKS_SHA256) {
    fail('profile.tasks', 'does not match the pinned Study A tasks')
  }
  return typedProfile
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return Object.freeze(value)
}

const profileUrl = new URL('../../data/profiles/bruckner-2026-canonical40.json', import.meta.url)
const profileJson = JSON.parse(readFileSync(profileUrl, 'utf8')) as unknown

/** Strictly validated, immutable author prompt profile. */
export const BRUCKNER_2026_CANONICAL40_PROFILE = deepFreeze(
  validateBruckner2026Canonical40Profile(profileJson),
)

/** Exact 10 task x 4 language cells; each task has one fixed wording per language. */
export const BRUCKNER_2026_CANONICAL40_CELLS: readonly Bruckner2026ProtocolCell[] = deepFreeze(
  BRUCKNER_2026_CANONICAL40_PROFILE.tasks.flatMap((task) =>
    BRUCKNER_2026_CANONICAL40_PROFILE.languages.map((language) => ({
      cellId: `${task.id}:${language}` as ProtocolCellId,
      taskId: task.id,
      language,
      systemPrompt: BRUCKNER_2026_CANONICAL40_PROFILE.system_prompts[language],
      userPrompt: task.prompts[language],
      category: task.category,
      condition: task.condition,
      answerSpace: task.answer_space,
      normalizeAs: task.normalize_as,
      paraphrasePolicy: BRUCKNER_2026_CANONICAL40_PROFILE.paraphrasePolicy,
    })),
  ),
)

/** Build the self-describing V2 manifest without enabling this profile by default. */
export function buildBruckner2026Canonical40Manifest(
  transportProfileId = 'openai-chat-onetoken-v1',
): ProtocolManifest {
  return validateProtocolManifest({
    manifestVersion: 1,
    protocolId: `${BRUCKNER_2026_PROFILE_ID}/v1`,
    transportProfileId,
    battery: {
      id: BRUCKNER_2026_PROFILE_ID,
      version: BRUCKNER_2026_PROFILE_VERSION,
      digest: `sha256:${BRUCKNER_2026_CANONICAL_PAYLOAD_SHA256}`,
    },
    prompts: {
      systemPromptDigest: `sha256:${BRUCKNER_2026_SYSTEM_PROMPTS_SHA256}`,
      templateDigest: `sha256:${BRUCKNER_2026_TASKS_SHA256}`,
    },
    normalization: {
      id: BRUCKNER_2026_NORMALIZER_ID,
      version: BRUCKNER_2026_NORMALIZER_VERSION,
      digest: `sha256:${BRUCKNER_2026_NORMALIZER_SOURCE_SHA256}`,
    },
    sampling: {
      temperature: 1,
      topP: null,
      maxTokens: 16,
      answerConstraint: 'fixed-system-single-word-or-number',
      reasoningPolicy: 'disabled-required',
    },
  })
}
