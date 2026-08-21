/**
 * Core type definitions.
 *
 * Method: Tomáš Bruckner, "One Token Is Enough: Fingerprinting and Verifying
 * Large Language Models from Single-Token Output Distributions"
 * (arXiv:2607.10252). A probe battery of task × language "cells" is sampled
 * repeatedly at temperature 1.0 with a one-word answer constraint; the
 * empirical distribution of normalized answers is the model's behavioral
 * fingerprint. Two fingerprints are compared with the mean per-cell
 * Jensen-Shannon divergence (base 2, so each cell's JSD lies in [0, 1] bit).
 */

export type ProbeTaskId =
  | 'random-number-1-100'
  | 'random-number-1-10'
  | 'random-letter'
  | 'random-color'
  | 'coin-flip'
  | 'random-animal'
  | 'random-city'
  | 'favorite-number'

export type ProbeLang = 'en' | 'zh'

/**
 * A cell is one task in one language. Distributions are only ever compared
 * within the same cell; there is no cross-language pooling.
 */
export type CellId = `${ProbeTaskId}:${ProbeLang}`

export type AnswerDomain =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'letter' }
  | { kind: 'color' }
  | { kind: 'coin' }
  | { kind: 'word' }

export interface ProbeTaskSpec {
  id: ProbeTaskId
  domain: AnswerDomain
  /**
   * At least 3 paraphrases per language. One is drawn at random per request,
   * so the probes are plain semantic questions with no fixed magic string a
   * gateway could keyword-filter.
   */
  paraphrases: Record<ProbeLang, string[]>
}

export type ProbePresetId = 'quick' | 'standard' | 'strict'

export interface ProbePreset {
  id: ProbePresetId
  cellCount: number
  samplesPerCell: number
}

/** An OpenAI-compatible chat-completions endpoint to probe. */
export interface Endpoint {
  /** Base URL, e.g. `https://api.openai.com/v1`. A bare domain gets `/v1` appended. */
  baseUrl: string
  /** Model id to request, e.g. `gpt-4o-mini`. */
  model: string
  /** API key sent as `Authorization: Bearer <key>`. Omit for keyless local servers. */
  apiKey?: string
  /** Extra HTTP headers merged into every request. */
  headers?: Record<string, string>
}

/** Internal, normalized endpoint (base URL cleaned up, key resolved). */
export interface ResolvedEndpoint {
  baseUrl: string
  model: string
  apiKey: string | null
  headers: Record<string, string>
}

/** Strategy used to disable hidden reasoning ("thinking") on the endpoint. */
export type ReasoningStrategyId =
  | 'openrouter-reasoning'
  | 'zhipu-thinking'
  | 'openai-effort'
  | 'none'

export interface ReasoningAdapter {
  strategy: ReasoningStrategyId
  /** Extra fields merged into the request body. */
  extraBody: Record<string, unknown>
  /** max_tokens used for probe requests. */
  maxTokens: number
  /**
   * True when no disabling strategy produced visible output and the run fell
   * back to a large max_tokens "post-reasoning" channel. Fingerprints
   * collected this way are lower confidence (reasoning shifts sampling).
   */
  postReasoning: boolean
}

export type SampleCategory = 'valid' | 'invalid' | 'refusal' | 'empty' | 'error'

export interface SampleUsage {
  promptTokens: number | null
  completionTokens: number | null
  reasoningTokens: number | null
}

export interface SampleResult {
  cellId: CellId
  /** Verbatim completion text. */
  raw: string
  /** Normalized answer; non-null only when `category === 'valid'`. */
  normalized: string | null
  category: SampleCategory
  latencyMs: number
  usage: SampleUsage | null
  /** Arrival order across the whole run (used for the split-half self check). */
  arrivalIndex: number
  errorMessage?: string
  /** Stable, credential-free error classification for progress reporting. */
  errorKind?: ProbeErrorKind | 'unknown'
  /** HTTP response status when the failure came from an HTTP response. */
  httpStatus?: number | null
}

/** Aggregated answer distribution for one cell. */
export interface StatisticalCellDistribution<TCellId extends string = string> {
  cellId: TCellId
  /** Normalized answer → count (valid samples only). */
  counts: Record<string, number>
  validCount: number
  invalidCount: number
  refusalCount: number
  emptyCount: number
  errorCount: number
  totalCount: number
  /** Shannon entropy of the valid-answer distribution, in bits. */
  entropyBits: number
  /** entropyBits / log2(nominal domain size), clamped to [0, 1]. */
  normalizedEntropy: number
  medianLatencyMs: number | null
  meanCompletionTokens: number | null
  meanReasoningTokens: number | null
}

/** V1 distribution, restricted to the built-in 8 task x 2 language battery. */
export interface CellDistribution extends StatisticalCellDistribution<CellId> {}

/**
 * V2 protocol cell identifier. Runtime validation additionally bounds length
 * and syntax; the open template supports paper cells beyond the legacy battery.
 */
export type ProtocolCellId = `${string}:${string}`

/** Distribution for a self-described V2 protocol cell (for example `num100-random:ru`). */
export interface V2CellDistribution extends StatisticalCellDistribution<ProtocolCellId> {}

/** JSON values accepted by the canonical protocol serializer. */
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue }

/**
 * Complete description of the protocol-defining choices for a V2 artifact.
 * Digests identify the exact battery/prompts/normalizer content; human-readable
 * ids alone are not sufficient for strict compatibility.
 */
export interface ProtocolManifest {
  manifestVersion: 1
  protocolId: string
  battery: {
    id: string
    version: string
    digest: string
  }
  prompts: {
    systemPromptDigest: string
    templateDigest: string
  }
  normalization: {
    id: string
    version: string
    digest: string
  }
  sampling: {
    temperature: number
    topP: number | null
    maxTokens: number
    answerConstraint: string
    reasoningPolicy: string
  }
}

/** The requests a V2 collector committed to before sampling began. */
export interface CollectionPlan {
  planVersion: 1
  role: 'enrollment' | 'audit'
  cellIds: ProtocolCellId[]
  samplesPerCell: number
  expectedSamples: number
  schedulerSeed: string
  schedulerPolicy:
    | 'repetition-index-seeded'
    | 'bruckner-seeded-shuffle-mulberry32-v1'
}

/** Aggregate terminal outcomes for a V2 collection. */
export interface CollectionQuality {
  qualityVersion: 1
  complete: boolean
  completedSamples: number
  expectedSamples: number
  validSamples: number
  invalidSamples: number
  refusalSamples: number
  emptySamples: number
  errorSamples: number
  /** Whether evidence came from the direct observable response channel without detected reasoning contamination. */
  directness: 'verified' | 'claimed' | 'violated' | 'unknown'
  /** Responses that exposed a reasoning trace in the collected raw evidence. */
  reasoningTraceCount: number
  /** Aggregate provider-reported reasoning tokens. */
  reasoningTokenCount: number
  /** Structurally successful responses that explicitly reported a reasoning-token count. */
  reasoningUsageObservedSamples: number
  /** SHA-256 of separately retained raw evidence, or null when none is retained. */
  rawEvidenceSha256: string | null
}

export type CompatibilityIssueCode =
  | 'invalid_fingerprint'
  | 'legacy_v1'
  | 'mixed_format_versions'
  | 'manifest_mismatch'
  | 'collection_plan_mismatch'

export interface CompatibilityIssue {
  code: CompatibilityIssueCode
  message: string
  side?: 'left' | 'right' | 'both'
}

export interface CompatibilityResult {
  /** Valid V2 artifacts with identical manifests are protocol-compatible. */
  compatible: boolean
  status: 'compatible' | 'exploratory' | 'incompatible'
  issues: CompatibilityIssue[]
  leftFormatVersion: number | null
  rightFormatVersion: number | null
  manifestMatch: boolean | null
  collectionPlanMatch: boolean | null
}

interface FingerprintBase {
  /**
   * Probe protocol identifier. Fingerprints are only strictly comparable when
   * both sides used the same protocol (same battery, same system prompt).
   * This package emits `one-token/v1`; bundled Zenodo-derived samples use
   * `bruckner-zenodo-2026`.
   */
  protocol: string
  model: string
  /** ISO timestamp. Fingerprints drift when models are updated, so age matters. */
  collectedAt: string
  samplesPerCell: number
  postReasoning: boolean
  /**
   * Present only on an incremental checkpoint. Partial fingerprints preserve
   * collected evidence but MUST NOT be used to produce an identity verdict.
   */
  partial?: true
  /** Requests that have reached a terminal sample result in this checkpoint. */
  completedSamples?: number
  /** Total requests planned for the collection. */
  expectedSamples?: number
  /** Terminal request failures represented in this checkpoint. */
  errorCount?: number
  /** Machine-readable reason why this artifact is not a complete fingerprint. */
  incompleteReason?: string
  meta?: {
    tool?: string
    channel?: string
    source?: string
    note?: string
    [key: string]: unknown
  }
}

/**
 * Legacy artifact emitted by the original CLI. It remains readable and is the
 * default output so the V2 protocol layer is additive and non-breaking.
 */
export interface FingerprintV1 extends FingerprintBase {
  formatVersion: 1
  cells: Partial<Record<CellId, CellDistribution>>
}

/**
 * Self-describing artifact for strict protocol compatibility checks.
 * Production collection does not emit this format until a future explicit
 * opt-in path is introduced.
 */
export interface FingerprintV2 extends FingerprintBase {
  formatVersion: 2
  cells: Partial<Record<ProtocolCellId, V2CellDistribution>>
  manifest: ProtocolManifest
  plan: CollectionPlan
  quality: CollectionQuality
}

/** Any supported fingerprint artifact. */
export type Fingerprint = FingerprintV1 | FingerprintV2

export type VerdictLevel = 'match' | 'uncertain' | 'mismatch' | 'insufficient'

export interface CellComparison {
  cellId: ProtocolCellId
  /** Jensen-Shannon divergence, base 2, in [0, 1] bit. */
  jsd: number
  validA: number
  validB: number
}

export interface ComparisonBaselines {
  /** Median split-half distance of a model against itself (paper): ≈ 0.140. */
  sameModelSelf: number
  /** Median distance, same model served by different providers (paper): ≈ 0.227. */
  sameModelCrossProvider: number
  /** Median distance between different models (paper): ≈ 0.463. */
  differentModel: number
}

export interface ComparisonResult {
  /** Mean per-cell JSD across comparable cells; null when none are comparable. */
  meanJsd: number | null
  /** The historical labels are exploratory distance bands, not identity decisions. */
  verdictSemantics: 'legacy-exploratory'
  /** Legacy one-token/v1 results are never eligible for an operational decision. */
  decisionEligible: false
  /** Strict artifact/profile compatibility; null only for low-level legacy builder calls. */
  compatibility: CompatibilityResult | null
  verdict: VerdictLevel
  /** Per-cell details, sorted by descending JSD. */
  cells: CellComparison[]
  comparableCellCount: number
  /** True when the two fingerprints were collected under different probe protocols. */
  protocolMismatch: boolean
  thresholds: { match: number; mismatch: number }
  baselines: ComparisonBaselines
}

export interface ProgressEvent {
  stage: 'adapter' | 'sampling'
  /** Completed requests (sampling stage) or probes attempted (adapter stage). */
  done: number
  total: number
  errors: number
  cellId?: CellId
  strategy?: ReasoningStrategyId
  /** Human-readable detail that never contains response bodies or credentials. */
  detail?: string
  /** Most recent safe error class, retained on later progress events. */
  lastErrorKind?: ProbeErrorKind | 'unknown' | null
  /** Most recent HTTP failure status, or null for non-HTTP failures. */
  lastHttpStatus?: number | null
  /** True while a retry backoff is pending for an in-flight sample. */
  retrying?: boolean
}

export type ProbeErrorKind = 'network' | 'auth' | 'http' | 'timeout' | 'aborted'

export interface FingerprintOptions {
  /**
   * Cells to probe: an explicit list, or a number N meaning the top-N cells
   * from the discriminativeness-ordered battery. Default: 8 (standard preset).
   */
  cells?: CellId[] | number
  /** Samples per cell. Default: 25. */
  samplesPerCell?: number
  /** Concurrent in-flight requests. Default: 4. */
  concurrency?: number
  /** Per-request timeout in milliseconds. Default: 30000. */
  timeoutMs?: number
  /** Retries per request on 429/5xx/timeout. Default: 2. */
  maxRetries?: number
  /** Abort the whole run (in-flight requests are cancelled). */
  signal?: AbortSignal
  onProgress?: (event: ProgressEvent) => void
  /**
   * Called after adapter detection, after every completed sample, and once
   * with the final complete fingerprint. Checkpoints are aggregate-only: raw
   * prompts, responses and credentials are never included.
   */
  onCheckpoint?: (fingerprint: Fingerprint) => void
  /** Skip reasoning-adapter detection and use this adapter directly. */
  adapter?: ReasoningAdapter
  /** Keep raw per-sample results on the run result (off by default). */
  keepSamples?: boolean
  /** Free-form metadata merged into `fingerprint.meta`. */
  meta?: Fingerprint['meta']
}

export interface FingerprintRun {
  fingerprint: Fingerprint
  adapter: ReasoningAdapter
  /** Requests that errored out after retries (excluded from distributions). */
  errorCount: number
  /**
   * Mean JSD between odd/even arrival halves of the run itself.
   * Values far above the same-model baseline (≈ 0.14) suggest the endpoint
   * routes across multiple backends (aggregator behavior).
   */
  splitHalfJsd: number | null
  durationMs: number
  /** Present only when `keepSamples: true`. */
  samples?: SampleResult[]
  /** Human-readable caveats collected during the run. */
  warnings: string[]
}

export interface VerifyResult {
  verdict: VerdictLevel
  meanJsd: number | null
  /** The historical labels are exploratory distance bands, not identity decisions. */
  verdictSemantics: 'legacy-exploratory'
  /** Legacy one-token/v1 results are never eligible for an operational decision. */
  decisionEligible: false
  comparison: ComparisonResult
  target: FingerprintRun
  reference: Fingerprint
  warnings: string[]
}
