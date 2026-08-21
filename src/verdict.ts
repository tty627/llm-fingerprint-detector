/**
 * Backward-compatible exploratory distance bands.
 *
 * The public `verdict` labels are retained because the CLI and downstream
 * integrations already consume them. The 0.25 / 0.35 cut points have not been
 * calibrated with this implementation's protocol, so every result is marked
 * `legacy-exploratory` and `decisionEligible: false`.
 */

import {
  JSD_BASELINE_CROSS_PROVIDER,
  JSD_BASELINE_DIFFERENT_MODEL,
  JSD_BASELINE_SELF,
  LEGACY_JSD_MATCH_THRESHOLD,
  LEGACY_JSD_MISMATCH_THRESHOLD,
  MIN_COMPARABLE_CELLS,
} from './constants.js'
import type { CellJsdEntry } from './stats.js'
import type {
  CellComparison,
  ComparisonResult,
  CompatibilityResult,
  VerdictLevel,
} from './types.js'

export const LEGACY_VERDICT_SEMANTICS = 'legacy-exploratory' as const
export const LEGACY_DECISION_ELIGIBLE = false as const

/**
 * Map a mean JSD into the historical labels consumed by existing callers.
 * This function is a legacy band classifier, not an identity decision rule.
 */
export function decideVerdict(meanJsd: number | null, comparableCellCount: number): VerdictLevel {
  if (meanJsd === null || comparableCellCount < MIN_COMPARABLE_CELLS) return 'insufficient'
  if (meanJsd <= LEGACY_JSD_MATCH_THRESHOLD) return 'match'
  if (meanJsd <= LEGACY_JSD_MISMATCH_THRESHOLD) return 'uncertain'
  return 'mismatch'
}

export function buildComparisonResult(
  entries: CellJsdEntry[],
  meanJsd: number | null,
  protocolMismatch: boolean,
  compatibility: CompatibilityResult | null = null,
): ComparisonResult {
  const cells: CellComparison[] = entries.map((entry) => ({
    cellId: entry.cellId,
    jsd: entry.jsd,
    validA: entry.validA,
    validB: entry.validB,
  }))
  return {
    meanJsd,
    verdict: decideVerdict(meanJsd, entries.length),
    verdictSemantics: LEGACY_VERDICT_SEMANTICS,
    decisionEligible: LEGACY_DECISION_ELIGIBLE,
    compatibility,
    cells,
    comparableCellCount: entries.length,
    protocolMismatch,
    thresholds: {
      match: LEGACY_JSD_MATCH_THRESHOLD,
      mismatch: LEGACY_JSD_MISMATCH_THRESHOLD,
    },
    baselines: {
      sameModelSelf: JSD_BASELINE_SELF,
      sameModelCrossProvider: JSD_BASELINE_CROSS_PROVIDER,
      differentModel: JSD_BASELINE_DIFFERENT_MODEL,
    },
  }
}
