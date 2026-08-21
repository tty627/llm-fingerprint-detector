/**
 * llm-fingerprint-detector — fingerprint and verify LLMs behind
 * OpenAI-compatible APIs from single-token output distributions.
 *
 * Independent open-source implementation of Tomáš Bruckner,
 * "One Token Is Enough: Fingerprinting and Verifying Large Language Models
 * from Single-Token Output Distributions" (arXiv:2607.10252).
 *
 * Everything exported here is runtime-agnostic (Node ≥ 18 or browsers with
 * fetch). Bundled sample references are Node-only and live in the
 * `llm-fingerprint-detector/references` subpath export.
 */

export { fingerprint, compare, verify } from './api.js'

export {
  CELL_PRIORITY_ORDER,
  PROBE_PRESETS,
  PROBE_TASKS,
  SYSTEM_PROMPTS,
  getCellsForPreset,
  getSystemPrompt,
  getTaskSpec,
  isCellId,
  makeCellId,
  parseCellId,
  pickParaphrase,
} from './battery.js'

export {
  normalizeAnswer,
  parseAnyNumber,
  parseChineseNumeral,
  parseEnglishNumberWord,
} from './normalizer.js'
export type { NormalizedAnswer } from './normalizer.js'

export {
  BRUCKNER_2026_NORMALIZER_ID,
  BRUCKNER_2026_NORMALIZER_SOURCE_DOI,
  BRUCKNER_2026_NORMALIZER_SOURCE_SHA256,
  BRUCKNER_2026_NORMALIZER_VERSION,
  normalizeBruckner2026Answer,
  parseBruckner2026ChineseInteger,
} from './normalizers/bruckner2026.js'
export type {
  Bruckner2026AnswerCategory,
  Bruckner2026IntegerOptions,
  Bruckner2026Language,
  Bruckner2026NormalizeAs,
  Bruckner2026NormalizedAnswer,
  Bruckner2026NormalizerOptions,
  Bruckner2026TextOptions,
} from './normalizers/bruckner2026.js'

export {
  buildCellDistribution,
  compareCellSets,
  domainSize,
  jensenShannonDivergence,
  median,
  shannonEntropyBits,
  splitHalfJsd,
} from './stats.js'
export type { CellJsdEntry, CountMap } from './stats.js'

export { decideVerdict, buildComparisonResult } from './verdict.js'

export {
  assertValidProtocolManifest,
  canonicalSerialize,
  checkCompatibility,
  checkFingerprintCompatibility,
  normalizeCanonicalJson,
  serializeProtocolManifest,
  validateProtocolManifest,
} from './protocol.js'

export {
  FingerprintValidationError,
  assertValidFingerprint,
  isFingerprintV2,
  isProtocolCellId,
  isV2CellId,
  validateFingerprint,
} from './validation.js'
export type { FingerprintValidationOptions } from './validation.js'

export { detectReasoningAdapter, STRATEGY_BODIES } from './adapter.js'
export type { AdapterDetectionOptions } from './adapter.js'

export { runProbeBattery, ProbeRunError } from './sampler.js'
export type { SamplerOptions, SamplerResult } from './sampler.js'

export { fetchChatCompletion, ProbeRequestError } from './http.js'
export type { ChatCompletionRequest, ChatCompletionResult, ProbeErrorKind } from './http.js'

export { normalizeBaseUrl, resolveEndpoint, guessAdapterHint } from './endpoint.js'
export type { BaseUrlNormalization } from './endpoint.js'

export * from './constants.js'

export type {
  AnswerDomain,
  CellComparison,
  CellDistribution,
  CellId,
  CanonicalJsonValue,
  CollectionPlan,
  CollectionQuality,
  ComparisonBaselines,
  ComparisonResult,
  CompatibilityIssue,
  CompatibilityIssueCode,
  CompatibilityResult,
  Endpoint,
  Fingerprint,
  FingerprintV1,
  FingerprintV2,
  FingerprintOptions,
  FingerprintRun,
  ProtocolCellId,
  ProbeLang,
  ProbePreset,
  ProbePresetId,
  ProbeTaskId,
  ProbeTaskSpec,
  ProgressEvent,
  ProtocolManifest,
  ReasoningAdapter,
  ReasoningStrategyId,
  ResolvedEndpoint,
  SampleCategory,
  SampleResult,
  SampleUsage,
  StatisticalCellDistribution,
  V2CellDistribution,
  VerdictLevel,
  VerifyResult,
} from './types.js'
