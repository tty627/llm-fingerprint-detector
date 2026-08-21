/**
 * Public high-level API:
 *
 *   fingerprint(endpoint, options?)          → collect a behavioral fingerprint
 *   compare(fingerprintA, fingerprintB)      → distance + legacy exploratory band
 *   verify(endpoint, reference, options?)    → fingerprint + exploratory comparison
 */

import { detectReasoningAdapter } from './adapter.js'
import { CELL_PRIORITY_ORDER, getTaskSpec, isCellId } from './battery.js'
import {
  DEFAULT_CELL_COUNT,
  DEFAULT_CONCURRENCY,
  DEFAULT_SAMPLES_PER_CELL,
  FINGERPRINT_FORMAT_VERSION,
  PROBE_PROTOCOL,
  SPLIT_HALF_WARN_THRESHOLD,
} from './constants.js'
import { resolveEndpoint } from './endpoint.js'
import { checkFingerprintCompatibility } from './protocol.js'
import { runProbeBattery } from './sampler.js'
import { buildCellDistribution, compareCellSets, splitHalfJsd } from './stats.js'
import {
  buildComparisonResult,
  LEGACY_DECISION_ELIGIBLE,
  LEGACY_VERDICT_SEMANTICS,
} from './verdict.js'
import { validateFingerprint } from './validation.js'
import type {
  CellDistribution,
  CellId,
  ComparisonResult,
  Endpoint,
  Fingerprint,
  FingerprintOptions,
  FingerprintRun,
  ReasoningAdapter,
  ResolvedEndpoint,
  SampleResult,
  VerifyResult,
} from './types.js'

function resolveCells(cells: FingerprintOptions['cells']): CellId[] {
  if (cells === undefined) return CELL_PRIORITY_ORDER.slice(0, DEFAULT_CELL_COUNT)
  if (typeof cells === 'number') {
    const count = Math.max(1, Math.min(CELL_PRIORITY_ORDER.length, Math.floor(cells)))
    return CELL_PRIORITY_ORDER.slice(0, count)
  }
  if (cells.length === 0) throw new Error('options.cells must not be empty')
  const invalid = cells.find((cell) => !isCellId(cell))
  if (invalid !== undefined) throw new Error(`options.cells contains unknown cell id "${invalid}"`)
  return cells
}

function isPartialFingerprint(fingerprint: Fingerprint): boolean {
  return fingerprint.partial === true
}

function assertCompleteFingerprint(fingerprint: Fingerprint, label: string): void {
  if (isPartialFingerprint(fingerprint)) {
    throw new Error(
      `${label} is an incomplete partial fingerprint ` +
        `(${fingerprint.completedSamples ?? 0}/${fingerprint.expectedSamples ?? '?'} samples); ` +
        'partial evidence cannot produce an identity verdict',
    )
  }
}

function buildFingerprint(
  resolved: ResolvedEndpoint,
  cells: CellId[],
  samplesPerCell: number,
  adapter: ReasoningAdapter,
  samplesByCell: Map<CellId, SampleResult[]>,
  collectedAt: string,
  meta: Fingerprint['meta'],
  partialState?: { completed: number; expected: number; errors: number; reason: string },
): Fingerprint {
  const cellDistributions: Partial<Record<CellId, CellDistribution>> = {}
  for (const cellId of cells) {
    cellDistributions[cellId] = buildCellDistribution(
      cellId,
      samplesByCell.get(cellId) ?? [],
      getTaskSpec(cellId).domain,
    )
  }

  const result: Fingerprint = {
    formatVersion: FINGERPRINT_FORMAT_VERSION,
    protocol: PROBE_PROTOCOL,
    model: resolved.model,
    collectedAt,
    samplesPerCell,
    postReasoning: adapter.postReasoning,
    cells: cellDistributions,
    meta: {
      tool: 'llm-fingerprint-detector',
      ...meta,
    },
  }
  if (partialState) {
    result.partial = true
    result.completedSamples = partialState.completed
    result.expectedSamples = partialState.expected
    result.errorCount = partialState.errors
    result.incompleteReason = partialState.reason
  }
  return result
}

/**
 * Probe an OpenAI-compatible endpoint and collect its behavioral fingerprint.
 *
 * Steps: normalize the endpoint → detect a working reasoning-disable strategy
 * → run the probe battery (shuffled, concurrent) → aggregate per-cell answer
 * distributions.
 */
export async function fingerprint(
  endpoint: Endpoint,
  options: FingerprintOptions = {},
): Promise<FingerprintRun> {
  const startedAt = Date.now()
  const { resolved, warnings } = resolveEndpoint(endpoint)
  const cells = resolveCells(options.cells)
  const samplesPerCell = options.samplesPerCell ?? DEFAULT_SAMPLES_PER_CELL
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const collectedAt = new Date().toISOString()

  const adapter =
    options.adapter ??
    (await detectReasoningAdapter(resolved, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onProbe: (strategy) =>
        options.onProgress?.({ stage: 'adapter', done: 0, total: 1, errors: 0, strategy }),
    }))

  if (adapter.postReasoning) {
    warnings.push(
      'Reasoning could not be disabled; fell back to the post-reasoning channel (max_tokens=1024). Fingerprint confidence is reduced.',
    )
  }

  const checkpointSamplesByCell = new Map<CellId, SampleResult[]>()
  for (const cellId of cells) checkpointSamplesByCell.set(cellId, [])
  let checkpointCompleted = 0
  let checkpointErrors = 0
  const expectedSamples = cells.length * samplesPerCell
  const emitPartialCheckpoint = () => {
    options.onCheckpoint?.(
      buildFingerprint(
        resolved,
        cells,
        samplesPerCell,
        adapter,
        checkpointSamplesByCell,
        collectedAt,
        options.meta,
        {
          completed: checkpointCompleted,
          expected: expectedSamples,
          errors: checkpointErrors,
          reason: 'sampling_in_progress',
        },
      ),
    )
  }
  emitPartialCheckpoint()

  const { samples, samplesByCell, errorCount } = await runProbeBattery({
    endpoint: resolved,
    adapter,
    cells,
    samplesPerCell,
    concurrency,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    signal: options.signal,
    onProgress: options.onProgress,
    onSample: (sample) => {
      checkpointSamplesByCell.get(sample.cellId)?.push(sample)
      checkpointCompleted += 1
      if (sample.category === 'error') checkpointErrors += 1
      emitPartialCheckpoint()
    },
  })

  const selfJsd = splitHalfJsd(samplesByCell)
  if (selfJsd !== null && selfJsd > SPLIT_HALF_WARN_THRESHOLD) {
    warnings.push(
      `Split-half self distance is high (${selfJsd.toFixed(3)} > ${SPLIT_HALF_WARN_THRESHOLD}); the endpoint may be routing across multiple backends.`,
    )
  }
  if (errorCount > 0) {
    warnings.push(`${errorCount} of ${samples.length} requests failed and were excluded.`)
  }

  const completeFingerprint = buildFingerprint(
    resolved,
    cells,
    samplesPerCell,
    adapter,
    samplesByCell,
    collectedAt,
    options.meta,
  )
  options.onCheckpoint?.(completeFingerprint)

  const result: FingerprintRun = {
    fingerprint: completeFingerprint,
    adapter,
    errorCount,
    splitHalfJsd: selfJsd,
    durationMs: Date.now() - startedAt,
    warnings,
  }
  if (options.keepSamples) result.samples = samples
  return result
}

/**
 * Compare two fingerprints: mean per-cell Jensen-Shannon divergence (base 2)
 * over cells where both sides have enough valid samples, plus the historical
 * three-way exploratory band retained for compatibility. The returned band is
 * explicitly not decision eligible.
 */
export function compare(a: Fingerprint, b: Fingerprint): ComparisonResult {
  assertCompleteFingerprint(a, 'Fingerprint A')
  assertCompleteFingerprint(b, 'Fingerprint B')
  const validatedA = validateFingerprint(a, {
    sourceLabel: 'Fingerprint A',
    rejectPartial: true,
  })
  const validatedB = validateFingerprint(b, {
    sourceLabel: 'Fingerprint B',
    rejectPartial: true,
  })
  const compatibility = checkFingerprintCompatibility(validatedA, validatedB)
  const { entries, meanJsd } = compareCellSets(validatedA.cells, validatedB.cells)
  const mixedFormats = compatibility.issues.some(
    (issue) => issue.code === 'mixed_format_versions',
  )
  const protocolMismatch =
    validatedA.protocol !== validatedB.protocol ||
    compatibility.manifestMatch === false ||
    mixedFormats
  return buildComparisonResult(entries, meanJsd, protocolMismatch, compatibility)
}

/**
 * Collect a fresh endpoint fingerprint and compare its output distributions
 * against a reference. The compatibility label is not an identity decision.
 */
export async function verify(
  endpoint: Endpoint,
  reference: Fingerprint,
  options: FingerprintOptions = {},
): Promise<VerifyResult> {
  assertCompleteFingerprint(reference, 'Reference fingerprint')
  const referenceCells = Object.keys(reference.cells) as CellId[]
  const cells =
    options.cells !== undefined
      ? resolveCells(options.cells)
      : CELL_PRIORITY_ORDER.filter((cellId) => referenceCells.includes(cellId))
  if (cells.length === 0) {
    throw new Error('Reference fingerprint has no cells overlapping the probe battery')
  }

  const target = await fingerprint(endpoint, { ...options, cells })
  const comparison = compare(target.fingerprint, reference)

  const warnings = [...target.warnings]
  if (comparison.protocolMismatch) {
    warnings.push(
      `Protocol mismatch: target "${target.fingerprint.protocol}" vs reference "${reference.protocol}". ` +
        'Only the raw distance is interpretable across different prompts/batteries; ' +
        'the legacy band must not be read as a model-identity finding.',
    )
  }
  if (reference.postReasoning) {
    warnings.push('Reference fingerprint was collected over the post-reasoning channel (reduced confidence).')
  }

  return {
    verdict: comparison.verdict,
    meanJsd: comparison.meanJsd,
    verdictSemantics: LEGACY_VERDICT_SEMANTICS,
    decisionEligible: LEGACY_DECISION_ELIGIBLE,
    comparison,
    target,
    reference,
    warnings,
  }
}
