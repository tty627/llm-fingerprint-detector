/** V2 protocol manifests, canonical serialization, and compatibility checks. */

import { validateFingerprint } from './validation.js'
import type {
  CanonicalJsonValue,
  CollectionPlan,
  CompatibilityIssue,
  CompatibilityResult,
  Fingerprint,
  FingerprintV2,
  ProtocolManifest,
} from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaError(source: string, path: string, message: string): never {
  throw new Error(`${source}: ${path} ${message}`)
}

function requireRecord(value: unknown, source: string, path: string): Record<string, unknown> {
  if (!isRecord(value)) schemaError(source, path, 'must be an object')
  return value
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  source: string,
  path: string,
): void {
  const expectedSet = new Set(expected)
  const missing = expected.filter((key) => !Object.hasOwn(value, key))
  if (missing.length > 0) schemaError(source, path, `is missing required key "${missing[0]}"`)
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key))
  if (unknown.length > 0) schemaError(source, path, `contains unknown key "${unknown[0]}"`)
}

function requireNonEmptyString(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    schemaError(source, path, 'must be a non-empty string')
  }
  return value
}

function requireSha256Digest(value: unknown, source: string, path: string): string {
  const digest = requireNonEmptyString(value, source, path)
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    schemaError(source, path, 'must be a lowercase sha256:<64hex> digest')
  }
  return digest
}

function requireFiniteNumber(
  value: unknown,
  source: string,
  path: string,
  predicate: (number: number) => boolean,
  expectation: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !predicate(value)) {
    schemaError(source, path, expectation)
  }
  return value
}

/**
 * Strictly validate the complete V2 manifest schema. Unknown keys are rejected
 * so protocol equality cannot silently ignore a newly introduced choice.
 */
export function validateProtocolManifest(
  value: unknown,
  sourceLabel = 'protocol manifest',
): ProtocolManifest {
  const manifest = requireRecord(value, sourceLabel, 'manifest')
  assertExactKeys(
    manifest,
    ['manifestVersion', 'protocolId', 'battery', 'prompts', 'normalization', 'sampling'],
    sourceLabel,
    'manifest',
  )
  if (manifest.manifestVersion !== 1) {
    schemaError(sourceLabel, 'manifest.manifestVersion', 'must equal 1')
  }
  requireNonEmptyString(manifest.protocolId, sourceLabel, 'manifest.protocolId')

  const battery = requireRecord(manifest.battery, sourceLabel, 'manifest.battery')
  assertExactKeys(battery, ['id', 'version', 'digest'], sourceLabel, 'manifest.battery')
  requireNonEmptyString(battery.id, sourceLabel, 'manifest.battery.id')
  requireNonEmptyString(battery.version, sourceLabel, 'manifest.battery.version')
  requireSha256Digest(battery.digest, sourceLabel, 'manifest.battery.digest')

  const prompts = requireRecord(manifest.prompts, sourceLabel, 'manifest.prompts')
  assertExactKeys(
    prompts,
    ['systemPromptDigest', 'templateDigest'],
    sourceLabel,
    'manifest.prompts',
  )
  requireSha256Digest(
    prompts.systemPromptDigest,
    sourceLabel,
    'manifest.prompts.systemPromptDigest',
  )
  requireSha256Digest(prompts.templateDigest, sourceLabel, 'manifest.prompts.templateDigest')

  const normalization = requireRecord(
    manifest.normalization,
    sourceLabel,
    'manifest.normalization',
  )
  assertExactKeys(
    normalization,
    ['id', 'version', 'digest'],
    sourceLabel,
    'manifest.normalization',
  )
  requireNonEmptyString(normalization.id, sourceLabel, 'manifest.normalization.id')
  requireNonEmptyString(normalization.version, sourceLabel, 'manifest.normalization.version')
  requireSha256Digest(normalization.digest, sourceLabel, 'manifest.normalization.digest')

  const sampling = requireRecord(manifest.sampling, sourceLabel, 'manifest.sampling')
  assertExactKeys(
    sampling,
    ['temperature', 'topP', 'maxTokens', 'answerConstraint', 'reasoningPolicy'],
    sourceLabel,
    'manifest.sampling',
  )
  requireFiniteNumber(
    sampling.temperature,
    sourceLabel,
    'manifest.sampling.temperature',
    (number) => number >= 0,
    'must be a non-negative finite number',
  )
  if (sampling.topP !== null) {
    requireFiniteNumber(
      sampling.topP,
      sourceLabel,
      'manifest.sampling.topP',
      (number) => number > 0 && number <= 1,
      'must be null or a finite number in (0, 1]',
    )
  }
  requireFiniteNumber(
    sampling.maxTokens,
    sourceLabel,
    'manifest.sampling.maxTokens',
    (number) => Number.isInteger(number) && number > 0,
    'must be a positive finite integer',
  )
  requireNonEmptyString(
    sampling.answerConstraint,
    sourceLabel,
    'manifest.sampling.answerConstraint',
  )
  requireNonEmptyString(
    sampling.reasoningPolicy,
    sourceLabel,
    'manifest.sampling.reasoningPolicy',
  )
  return manifest as unknown as ProtocolManifest
}

/** Assertion-style manifest validator. */
export function assertValidProtocolManifest(value: unknown): asserts value is ProtocolManifest {
  validateProtocolManifest(value)
}

function canonicalize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`)
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} contains a non-JSON value (${typeof value})`)
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalize(item, `${path}[${index}]`, ancestors))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`)
    }
    const record = value as Record<string, unknown>
    const result = Object.create(null) as Record<string, CanonicalJsonValue>
    for (const key of Object.keys(record).sort()) {
      result[key] = canonicalize(record[key], `${path}.${key}`, ancestors)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

/** Recursively sort object keys and reject values that JSON would silently lose. */
export function normalizeCanonicalJson(value: unknown): CanonicalJsonValue {
  return canonicalize(value, '$', new Set<object>())
}

/** Deterministic JSON serialization used for protocol equality. */
export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJson(value))
}

/** Validate, then serialize, a V2 manifest in canonical key order. */
export function serializeProtocolManifest(manifest: unknown): string {
  return canonicalSerialize(validateProtocolManifest(manifest))
}

function formatVersion(value: unknown): number | null {
  if (!isRecord(value) || typeof value.formatVersion !== 'number') return null
  return value.formatVersion
}

function canonicalPlan(plan: CollectionPlan): string {
  return canonicalSerialize({ ...plan, cellIds: [...plan.cellIds].sort() })
}

function invalidIssue(error: unknown, side: 'left' | 'right'): CompatibilityIssue {
  return {
    code: 'invalid_fingerprint',
    side,
    message: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Check whether two artifacts are eligible for strict protocol comparison.
 * Every pair containing V1 is explicitly exploratory; it is never promoted to
 * `compatible`, even when legacy protocol strings happen to match.
 */
export function checkFingerprintCompatibility(left: unknown, right: unknown): CompatibilityResult {
  const result: CompatibilityResult = {
    compatible: false,
    status: 'incompatible',
    issues: [],
    leftFormatVersion: formatVersion(left),
    rightFormatVersion: formatVersion(right),
    manifestMatch: null,
    collectionPlanMatch: null,
  }

  let validatedLeft: Fingerprint | null = null
  let validatedRight: Fingerprint | null = null
  try {
    validatedLeft = validateFingerprint(left, { sourceLabel: 'left fingerprint', rejectPartial: true })
  } catch (error) {
    result.issues.push(invalidIssue(error, 'left'))
  }
  try {
    validatedRight = validateFingerprint(right, {
      sourceLabel: 'right fingerprint',
      rejectPartial: true,
    })
  } catch (error) {
    result.issues.push(invalidIssue(error, 'right'))
  }
  if (!validatedLeft || !validatedRight) return result

  result.leftFormatVersion = validatedLeft.formatVersion
  result.rightFormatVersion = validatedRight.formatVersion
  if (validatedLeft.formatVersion === 1 || validatedRight.formatVersion === 1) {
    result.status = 'exploratory'
    result.issues.push(
      validatedLeft.formatVersion === 1 && validatedRight.formatVersion === 1
        ? {
            code: 'legacy_v1',
            side: 'both',
            message: 'V1 artifacts do not carry strict protocol manifests; comparison is exploratory.',
          }
        : {
            code: 'mixed_format_versions',
            side: 'both',
            message: 'V1/V2 pairs cannot establish strict protocol compatibility.',
          },
    )
    return result
  }

  const leftV2 = validatedLeft as FingerprintV2
  const rightV2 = validatedRight as FingerprintV2
  result.manifestMatch =
    serializeProtocolManifest(leftV2.manifest) === serializeProtocolManifest(rightV2.manifest)
  result.collectionPlanMatch = canonicalPlan(leftV2.plan) === canonicalPlan(rightV2.plan)
  if (!result.manifestMatch) {
    result.issues.push({
      code: 'manifest_mismatch',
      side: 'both',
      message: 'V2 protocol manifests are not identical.',
    })
    return result
  }
  if (!result.collectionPlanMatch) {
    result.issues.push({
      code: 'collection_plan_mismatch',
      side: 'both',
      message:
        'V2 collection plans differ; role, seed, cells, or sample counts require calibrated-policy review.',
    })
  }
  // Enrollment and audit collections commonly use different k/n, roles, and
  // scheduler seeds. Manifest equality establishes protocol compatibility;
  // decision eligibility for a particular plan pair belongs to calibration.
  result.compatible = true
  result.status = 'compatible'
  return result
}

/** Short alias for callers operating entirely in the protocol layer. */
export const checkCompatibility = checkFingerprintCompatibility
