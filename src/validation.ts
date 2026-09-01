/** Strict runtime validation for persisted fingerprint artifacts. */

import { isCellId } from './battery.js'
import { validateProtocolManifest } from './protocol.js'
import type {
  CollectionPlan,
  CollectionQuality,
  Fingerprint,
  FingerprintV2,
  ProtocolCellId,
  StatisticalCellDistribution,
} from './types.js'

export interface FingerprintValidationOptions {
  /** Prefix used in validation errors. */
  sourceLabel?: string
  /** References and comparisons should set this: partial evidence is not eligible. */
  rejectPartial?: boolean
}

export class FingerprintValidationError extends Error {
  readonly path: string

  constructor(sourceLabel: string, path: string, message: string) {
    super(`${sourceLabel}: ${path} ${message}`)
    this.name = 'FingerprintValidationError'
    this.path = path
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(source: string, path: string, message: string): never {
  throw new FingerprintValidationError(source, path, message)
}

function requireRecord(value: unknown, source: string, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(source, path, 'must be an object')
  return value
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  source: string,
  path: string,
): void {
  const allowed = new Set([...required, ...optional])
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing !== undefined) fail(source, path, `is missing required key "${missing}"`)
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown !== undefined) fail(source, path, `contains unknown key "${unknown}"`)
}

function requireNonEmptyString(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(source, path, 'must be a non-empty string')
  }
  return value
}

function requireCanonicalIsoTimestamp(value: unknown, source: string, path: string): string {
  const timestamp = requireNonEmptyString(value, source, path)
  const parsed = new Date(timestamp)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    fail(source, path, 'must be a canonical ISO-8601 UTC timestamp')
  }
  return timestamp
}

function requireBoolean(value: unknown, source: string, path: string): boolean {
  if (typeof value !== 'boolean') fail(source, path, 'must be a boolean')
  return value
}

function requireNonNegativeInteger(value: unknown, source: string, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    fail(source, path, 'must be a non-negative finite integer')
  }
  return value
}

function requirePositiveInteger(value: unknown, source: string, path: string): number {
  const parsed = requireNonNegativeInteger(value, source, path)
  if (parsed === 0) fail(source, path, 'must be greater than zero')
  return parsed
}

function requireFiniteInRange(
  value: unknown,
  source: string,
  path: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(source, path, `must be a finite number in [${min}, ${max}]`)
  }
  return value
}

function requireNullableNonNegativeFinite(value: unknown, source: string, path: string): void {
  if (value === null) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(source, path, 'must be null or a non-negative finite number')
  }
}

interface AggregateCounts {
  valid: number
  invalid: number
  refusal: number
  empty: number
  error: number
  total: number
}

const PROTOCOL_CELL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z][a-z0-9-]{0,31}$/

/** Runtime guard for bounded, portable V2 protocol cell identifiers. */
export function isProtocolCellId(value: unknown): value is ProtocolCellId {
  return (
    typeof value === 'string' &&
    value.length <= 96 &&
    PROTOCOL_CELL_ID_PATTERN.test(value)
  )
}

/** Explicit V2-named alias. */
export const isV2CellId = isProtocolCellId

function validateCellDistribution(
  value: unknown,
  key: string,
  source: string,
  formatVersion: 1 | 2,
): StatisticalCellDistribution {
  const path = `cells.${key}`
  if (formatVersion === 1 && !isCellId(key)) {
    fail(source, path, 'uses a cell id outside the legacy V1 battery')
  }
  if (formatVersion === 2 && !isProtocolCellId(key)) {
    fail(source, path, 'must use a bounded <probe>:<language> protocol cell id')
  }
  const cell = requireRecord(value, source, path)
  if (formatVersion === 2) {
    assertExactKeys(
      cell,
      [
        'cellId',
        'counts',
        'validCount',
        'invalidCount',
        'refusalCount',
        'emptyCount',
        'errorCount',
        'totalCount',
        'entropyBits',
        'normalizedEntropy',
        'medianLatencyMs',
        'meanCompletionTokens',
        'meanReasoningTokens',
      ],
      [],
      source,
      path,
    )
  }
  if (cell.cellId !== key) {
    fail(source, `${path}.cellId`, `must equal its containing key "${key}"`)
  }

  const counts = requireRecord(cell.counts, source, `${path}.counts`)
  let countSum = 0
  for (const [answer, count] of Object.entries(counts)) {
    const parsed = requireNonNegativeInteger(count, source, `${path}.counts.${answer}`)
    countSum += parsed
    if (!Number.isFinite(countSum)) fail(source, `${path}.counts`, 'sum must be finite')
  }

  const valid = requireNonNegativeInteger(cell.validCount, source, `${path}.validCount`)
  const invalid = requireNonNegativeInteger(cell.invalidCount, source, `${path}.invalidCount`)
  const refusal = requireNonNegativeInteger(cell.refusalCount, source, `${path}.refusalCount`)
  const empty = requireNonNegativeInteger(cell.emptyCount, source, `${path}.emptyCount`)
  const error = requireNonNegativeInteger(cell.errorCount, source, `${path}.errorCount`)
  const total = requireNonNegativeInteger(cell.totalCount, source, `${path}.totalCount`)

  if (countSum !== valid) {
    fail(source, `${path}.counts`, `sum (${countSum}) must equal validCount (${valid})`)
  }
  const categorySum = valid + invalid + refusal + empty + error
  if (!Number.isFinite(categorySum) || categorySum !== total) {
    fail(source, path, `category counts sum (${categorySum}) must equal totalCount (${total})`)
  }

  requireFiniteInRange(cell.entropyBits, source, `${path}.entropyBits`, 0, Number.MAX_VALUE)
  requireFiniteInRange(cell.normalizedEntropy, source, `${path}.normalizedEntropy`, 0, 1)
  requireNullableNonNegativeFinite(cell.medianLatencyMs, source, `${path}.medianLatencyMs`)
  requireNullableNonNegativeFinite(
    cell.meanCompletionTokens,
    source,
    `${path}.meanCompletionTokens`,
  )
  requireNullableNonNegativeFinite(cell.meanReasoningTokens, source, `${path}.meanReasoningTokens`)
  return cell as unknown as StatisticalCellDistribution
}

function validateCollectionPlan(
  value: unknown,
  source: string,
): CollectionPlan {
  const plan = requireRecord(value, source, 'plan')
  assertExactKeys(
    plan,
    [
      'planVersion',
      'role',
      'cellIds',
      'samplesPerCell',
      'expectedSamples',
      'schedulerSeed',
      'schedulerPolicy',
    ],
    [],
    source,
    'plan',
  )
  if (plan.planVersion !== 1) fail(source, 'plan.planVersion', 'must equal 1')
  if (plan.role !== 'enrollment' && plan.role !== 'audit') {
    fail(source, 'plan.role', 'must be "enrollment" or "audit"')
  }
  if (!Array.isArray(plan.cellIds) || plan.cellIds.length === 0) {
    fail(source, 'plan.cellIds', 'must be a non-empty array')
  }
  const seen = new Set<string>()
  for (let index = 0; index < plan.cellIds.length; index += 1) {
    const cellId = plan.cellIds[index]
    if (!isProtocolCellId(cellId)) {
      fail(source, `plan.cellIds[${index}]`, 'must be a bounded <probe>:<language> cell id')
    }
    if (seen.has(cellId)) fail(source, `plan.cellIds[${index}]`, 'must not be duplicated')
    seen.add(cellId)
  }
  const samplesPerCell = requirePositiveInteger(plan.samplesPerCell, source, 'plan.samplesPerCell')
  const expectedSamples = requireNonNegativeInteger(
    plan.expectedSamples,
    source,
    'plan.expectedSamples',
  )
  const calculatedExpected = plan.cellIds.length * samplesPerCell
  if (expectedSamples !== calculatedExpected) {
    fail(
      source,
      'plan.expectedSamples',
      `must equal cellIds.length * samplesPerCell (${calculatedExpected})`,
    )
  }
  const schedulerSeed = requireNonEmptyString(
    plan.schedulerSeed,
    source,
    'plan.schedulerSeed',
  )
  if (schedulerSeed.length > 256) fail(source, 'plan.schedulerSeed', 'must be at most 256 characters')
  if (
    plan.schedulerPolicy !== 'repetition-index-seeded'
    && plan.schedulerPolicy !== 'bruckner-seeded-shuffle-mulberry32-v1'
  ) {
    fail(
      source,
      'plan.schedulerPolicy',
      'must name a supported deterministic repetition scheduler',
    )
  }
  return plan as unknown as CollectionPlan
}

function validateCollectionQuality(
  value: unknown,
  source: string,
): CollectionQuality {
  const quality = requireRecord(value, source, 'quality')
  assertExactKeys(
    quality,
    [
      'qualityVersion',
      'complete',
      'completedSamples',
      'expectedSamples',
      'validSamples',
      'invalidSamples',
      'refusalSamples',
      'emptySamples',
      'errorSamples',
      'directness',
      'reasoningTraceCount',
      'reasoningTokenCount',
      'reasoningUsageObservedSamples',
      'rawEvidenceSha256',
    ],
    ['attemptCount', 'retryCount'],
    source,
    'quality',
  )
  if (quality.qualityVersion !== 1) fail(source, 'quality.qualityVersion', 'must equal 1')
  requireBoolean(quality.complete, source, 'quality.complete')
  const keys = [
    'completedSamples',
    'expectedSamples',
    'validSamples',
    'invalidSamples',
    'refusalSamples',
    'emptySamples',
    'errorSamples',
    'reasoningTraceCount',
    'reasoningTokenCount',
    'reasoningUsageObservedSamples',
  ] as const
  for (const key of keys) requireNonNegativeInteger(quality[key], source, `quality.${key}`)
  const hasAttemptCount = Object.hasOwn(quality, 'attemptCount')
  const hasRetryCount = Object.hasOwn(quality, 'retryCount')
  if (hasAttemptCount !== hasRetryCount) {
    fail(source, 'quality', 'attemptCount and retryCount must be present together')
  }
  if (hasAttemptCount) {
    requireNonNegativeInteger(quality.attemptCount, source, 'quality.attemptCount')
    requireNonNegativeInteger(quality.retryCount, source, 'quality.retryCount')
    if ((quality.retryCount as number) > (quality.attemptCount as number)) {
      fail(source, 'quality.retryCount', 'must not exceed attemptCount')
    }
  }
  if (
    quality.directness !== 'verified' &&
    quality.directness !== 'claimed' &&
    quality.directness !== 'violated' &&
    quality.directness !== 'unknown'
  ) {
    fail(source, 'quality.directness', 'must be verified, claimed, violated, or unknown')
  }
  if ((quality.reasoningTraceCount as number) > (quality.completedSamples as number)) {
    fail(source, 'quality.reasoningTraceCount', 'must not exceed completedSamples')
  }
  if ((quality.reasoningUsageObservedSamples as number) > (quality.completedSamples as number)) {
    fail(source, 'quality.reasoningUsageObservedSamples', 'must not exceed completedSamples')
  }
  if (
    quality.rawEvidenceSha256 !== null &&
    (typeof quality.rawEvidenceSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(quality.rawEvidenceSha256))
  ) {
    fail(source, 'quality.rawEvidenceSha256', 'must be null or exactly 64 hexadecimal characters')
  }
  const categoryTotal =
    (quality.validSamples as number) +
    (quality.invalidSamples as number) +
    (quality.refusalSamples as number) +
    (quality.emptySamples as number) +
    (quality.errorSamples as number)
  if (!Number.isFinite(categoryTotal) || categoryTotal !== quality.completedSamples) {
    fail(source, 'quality', 'category sample totals must equal completedSamples')
  }
  if (quality.directness === 'verified') {
    if ((quality.errorSamples as number) !== 0) {
      fail(source, 'quality.directness', 'cannot be verified when errorSamples is non-zero')
    }
    if (
      (quality.reasoningTraceCount as number) !== 0
      || (quality.reasoningTokenCount as number) !== 0
    ) {
      fail(source, 'quality.directness', 'cannot be verified with observed reasoning')
    }
    if (quality.reasoningUsageObservedSamples !== quality.completedSamples) {
      fail(
        source,
        'quality.directness',
        'requires explicit reasoning-token usage for every completed sample',
      )
    }
  }
  return quality as unknown as CollectionQuality
}

function sumCells(cells: StatisticalCellDistribution[]): AggregateCounts {
  return cells.reduce<AggregateCounts>(
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
}

function validateV2Consistency(
  fp: Record<string, unknown>,
  cells: StatisticalCellDistribution[],
  cellKeys: string[],
  source: string,
): void {
  const manifest = validateProtocolManifest(fp.manifest, source)
  const plan = validateCollectionPlan(fp.plan, source)
  const quality = validateCollectionQuality(fp.quality, source)

  if (fp.protocol !== manifest.protocolId) {
    fail(source, 'protocol', 'must equal manifest.protocolId')
  }
  if (fp.samplesPerCell !== plan.samplesPerCell) {
    fail(source, 'samplesPerCell', 'must equal plan.samplesPerCell')
  }
  const actualCellIds = [...cellKeys].sort()
  const plannedCellIds = [...plan.cellIds].sort()
  if (
    actualCellIds.length !== plannedCellIds.length ||
    actualCellIds.some((cellId, index) => cellId !== plannedCellIds[index])
  ) {
    fail(source, 'cells', 'keys must exactly match plan.cellIds')
  }
  if (quality.expectedSamples !== plan.expectedSamples) {
    fail(source, 'quality.expectedSamples', 'must equal plan.expectedSamples')
  }
  if (fp.postReasoning === true && quality.directness === 'verified') {
    fail(source, 'postReasoning', 'cannot be true when quality.directness is verified')
  }

  const aggregate = sumCells(cells)
  const expectedQuality: Array<[keyof CollectionQuality, number]> = [
    ['completedSamples', aggregate.total],
    ['validSamples', aggregate.valid],
    ['invalidSamples', aggregate.invalid],
    ['refusalSamples', aggregate.refusal],
    ['emptySamples', aggregate.empty],
    ['errorSamples', aggregate.error],
  ]
  for (const [key, expected] of expectedQuality) {
    if (quality[key] !== expected) {
      fail(source, `quality.${key}`, `must equal aggregate cell count (${expected})`)
    }
  }
  const partial = fp.partial === true
  if (quality.complete === partial) {
    fail(source, 'quality.complete', 'must be false exactly when partial is true')
  }
  if (quality.complete && quality.completedSamples !== quality.expectedSamples) {
    fail(source, 'quality.completedSamples', 'must equal expectedSamples for a complete collection')
  }
  if (!quality.complete && quality.completedSamples > quality.expectedSamples) {
    fail(source, 'quality.completedSamples', 'must not exceed expectedSamples')
  }

  const duplicateFields: Array<[string, unknown, number]> = [
    ['completedSamples', fp.completedSamples, quality.completedSamples],
    ['expectedSamples', fp.expectedSamples, quality.expectedSamples],
    ['errorCount', fp.errorCount, quality.errorSamples],
  ]
  for (const [key, actual, expected] of duplicateFields) {
    if (actual !== undefined && actual !== expected) {
      fail(source, key, `must equal quality.${key === 'errorCount' ? 'errorSamples' : key}`)
    }
  }
}

/**
 * Validate a parsed V1 or V2 artifact and return the same value with a trusted
 * type. This function does not silently coerce malformed data.
 */
export function validateFingerprint(
  value: unknown,
  options: FingerprintValidationOptions = {},
): Fingerprint {
  const source = options.sourceLabel ?? 'fingerprint'
  const fp = requireRecord(value, source, 'artifact')
  if (fp.formatVersion !== 1 && fp.formatVersion !== 2) {
    fail(source, 'formatVersion', `has unsupported value ${String(fp.formatVersion)}`)
  }
  if (fp.formatVersion === 2) {
    assertExactKeys(
      fp,
      [
        'formatVersion',
        'protocol',
        'model',
        'collectedAt',
        'samplesPerCell',
        'postReasoning',
        'cells',
        'manifest',
        'plan',
        'quality',
      ],
      [
        'partial',
        'completedSamples',
        'expectedSamples',
        'errorCount',
        'incompleteReason',
        'meta',
      ],
      source,
      'artifact',
    )
  }
  requireNonEmptyString(fp.model, source, 'model')
  // Preserve the legacy parser's most useful structural error ordering.
  const cellsRecord = requireRecord(fp.cells, source, 'cells')
  requireNonEmptyString(fp.protocol, source, 'protocol')
  if (fp.formatVersion === 2) {
    requireCanonicalIsoTimestamp(fp.collectedAt, source, 'collectedAt')
  } else {
    requireNonEmptyString(fp.collectedAt, source, 'collectedAt')
  }
  requirePositiveInteger(fp.samplesPerCell, source, 'samplesPerCell')
  requireBoolean(fp.postReasoning, source, 'postReasoning')

  if (fp.partial !== undefined && fp.partial !== true) {
    fail(source, 'partial', 'may only be true when present')
  }
  if (fp.partial === true && options.rejectPartial) {
    throw new Error(
      `${source}: incomplete partial fingerprint ` +
        `(${String(fp.completedSamples ?? 0)}/${String(fp.expectedSamples ?? '?')} samples) ` +
        'cannot be used as a reference',
    )
  }

  const cellEntries = Object.entries(cellsRecord)
  if (cellEntries.length === 0) fail(source, 'cells', 'must contain at least one cell')
  const cells = cellEntries.map(([key, cell]) =>
    validateCellDistribution(cell, key, source, fp.formatVersion as 1 | 2),
  )
  const aggregate = sumCells(cells)

  if (fp.partial === true) {
    const completed = requireNonNegativeInteger(fp.completedSamples, source, 'completedSamples')
    const expected = requireNonNegativeInteger(fp.expectedSamples, source, 'expectedSamples')
    if (completed > expected) fail(source, 'completedSamples', 'must not exceed expectedSamples')
    if (completed !== aggregate.total) {
      fail(source, 'completedSamples', `must equal aggregate cell total (${aggregate.total})`)
    }
    if (fp.errorCount !== undefined) {
      const errorCount = requireNonNegativeInteger(fp.errorCount, source, 'errorCount')
      if (errorCount !== aggregate.error) {
        fail(source, 'errorCount', `must equal aggregate cell error count (${aggregate.error})`)
      }
    }
    requireNonEmptyString(fp.incompleteReason, source, 'incompleteReason')
  }

  if (fp.formatVersion === 2) {
    validateV2Consistency(fp, cells, cellEntries.map(([key]) => key), source)
  }
  return fp as unknown as Fingerprint
}

/** Assertion-style alias for callers that prefer explicit naming. */
export function assertValidFingerprint(
  value: unknown,
  options: FingerprintValidationOptions = {},
): asserts value is Fingerprint {
  validateFingerprint(value, options)
}

export function isFingerprintV2(value: Fingerprint): value is FingerprintV2 {
  return value.formatVersion === 2
}
