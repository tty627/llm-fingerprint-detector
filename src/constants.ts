/**
 * Statistical constants used by the legacy `one-token/v1` implementation.
 *
 * The 0.25 / 0.35 cut points were selected by this project as convenient
 * exploratory distance bands. They were not fitted or validated with the
 * paper's evaluation pipeline, and MUST NOT be treated as calibrated identity
 * decision thresholds.
 */

/** Legacy low-distance band upper bound. Exploratory only; not decision eligible. */
export const LEGACY_JSD_MATCH_THRESHOLD = 0.25

/** Legacy mid-distance band upper bound. Exploratory only; not decision eligible. */
export const LEGACY_JSD_MISMATCH_THRESHOLD = 0.35

/**
 * @deprecated Use `LEGACY_JSD_MATCH_THRESHOLD`. This alias is retained for API
 * and downstream Python compatibility only.
 */
export const JSD_MATCH_THRESHOLD = LEGACY_JSD_MATCH_THRESHOLD

/**
 * @deprecated Use `LEGACY_JSD_MISMATCH_THRESHOLD`. This alias is retained for
 * API and downstream Python compatibility only.
 */
export const JSD_MISMATCH_THRESHOLD = LEGACY_JSD_MISMATCH_THRESHOLD

/** Published paper medians, exposed as context only (not local calibration). */
export const JSD_BASELINE_SELF = 0.14
export const JSD_BASELINE_CROSS_PROVIDER = 0.227
export const JSD_BASELINE_DIFFERENT_MODEL = 0.463

/** A cell participates in the distance only when both sides have ≥ this many valid samples. */
export const MIN_VALID_SAMPLES_PER_CELL = 10

/** Fewer comparable cells than this → verdict `insufficient`. */
export const MIN_COMPARABLE_CELLS = 4

/** Split-half self check: a cell participates only when each half has ≥ this many valid samples. */
export const MIN_SPLIT_HALF_SAMPLES = 5

/** Split-half JSD above this suggests unstable routing (multi-backend aggregator). */
export const SPLIT_HALF_WARN_THRESHOLD = 0.25

/** Probe request parameters (paper protocol). */
export const PROBE_TEMPERATURE = 1.0
export const PROBE_MAX_TOKENS = 16
/** Fallback max_tokens when reasoning cannot be disabled (post-reasoning channel). */
export const POST_REASONING_MAX_TOKENS = 1024

/** Sampler defaults. */
export const DEFAULT_SAMPLES_PER_CELL = 25
export const DEFAULT_CELL_COUNT = 8
export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_RETRIES = 2
/** Honor slow rate-limited relays while bounding a single Retry-After wait. */
export const MAX_RETRY_DELAY_MS = 60_000
/** Abort the run after this many consecutive transport-level failures. */
export const CONSECUTIVE_NETWORK_ERROR_LIMIT = 8

/** Fingerprint artifact identifiers. */
export const FINGERPRINT_FORMAT_VERSION = 1 as const
/** Protocol id for fingerprints collected by this package's battery. */
export const PROBE_PROTOCOL = 'one-token/v1'
/** Protocol id for samples derived from the paper's Zenodo dataset. */
export const ZENODO_PROTOCOL = 'bruckner-zenodo-2026'
