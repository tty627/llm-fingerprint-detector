/**
 * Explicit, paper-profile collector for Bruckner's 2026 Study A protocol.
 *
 * This module is intentionally disconnected from the legacy sampler. It can
 * only run when a caller supplies a request function; the opt-in `./paper`
 * subpath provides a strict HTTP adapter without enabling it in the root API.
 */

import { createHash } from 'node:crypto'

import {
  normalizeBruckner2026Answer,
  type Bruckner2026NormalizerOptions,
} from './normalizers/bruckner2026.js'
import {
  BRUCKNER_2026_CANONICAL40_CELLS,
  BRUCKNER_2026_CANONICAL40_PROFILE,
  buildBruckner2026Canonical40Manifest,
  type Bruckner2026ProfileLanguage,
  type Bruckner2026ProtocolCell,
  type Bruckner2026TaskId,
} from './profiles/bruckner2026.js'
import { canonicalSerialize } from './protocol.js'
import { jensenShannonDivergence, median, shannonEntropyBits } from './stats.js'
import type {
  CollectionPlan,
  CollectionQuality,
  FingerprintV2,
  ProtocolCellId,
  SampleCategory,
  SampleUsage,
  V2CellDistribution,
} from './types.js'
import { validateFingerprint } from './validation.js'

export const BRUCKNER_2026_DIRECT_REQUEST_TEMPERATURE = 1 as const
export const BRUCKNER_2026_DIRECT_REQUEST_MAX_TOKENS = 16 as const
export const BRUCKNER_2026_FIXED_PROMPT_VARIANT_ID = 'fixed-author-prompt/v1' as const
export const BRUCKNER_2026_SCHEDULER_POLICY =
  'bruckner-seeded-shuffle-mulberry32-v1' as const
export const BRUCKNER_2026_SCHEDULER_SOURCE_PATH = 'run/lib.js' as const
export const BRUCKNER_2026_SCHEDULER_SOURCE_SHA256 =
  '0ed556db47fa318416e777f63a80ea97b0397f7806488ca8d5db09121f972746' as const

export interface PaperDirectRequestBody {
  model: string
  messages: readonly [
    { readonly role: 'system'; readonly content: string },
    { readonly role: 'user'; readonly content: string },
  ]
  temperature: typeof BRUCKNER_2026_DIRECT_REQUEST_TEMPERATURE
  max_tokens: typeof BRUCKNER_2026_DIRECT_REQUEST_MAX_TOKENS
  reasoning: { readonly enabled: false }
  usage: { readonly include: true }
}

export interface PaperCollectionJob {
  jobId: string
  cellId: ProtocolCellId
  taskId: Bruckner2026TaskId
  language: Bruckner2026ProfileLanguage
  repetitionIndex: number
  promptVariantId: typeof BRUCKNER_2026_FIXED_PROMPT_VARIANT_ID
  systemPrompt: string
  userPrompt: string
}

export interface PaperRequestContext {
  role: CollectionPlan['role']
  schedulerSeed: string
  job: Readonly<PaperCollectionJob>
}

/** Credential-free transport metadata returned by the injected adapter. */
export interface PaperRequestMetadata {
  provider?: string | null
  reportedModel?: string | null
  generationId?: string | null
}

/**
 * The injected adapter returns parsed response JSON plus selected safe
 * transport metadata. It must throw for transport/HTTP failures.
 */
export interface PaperRequestResult {
  response: unknown
  metadata?: PaperRequestMetadata
}

export interface PaperSensitiveTextResult {
  text: string
  matched: boolean
}

export type PaperSensitiveTextRedactor = (value: string) => PaperSensitiveTextResult

export interface PaperTransportMetrics {
  attemptCount: number
  retryCount: number
}

export interface PaperRequestFunction {
  (
    body: Readonly<PaperDirectRequestBody>,
    context: Readonly<PaperRequestContext>,
  ): Promise<PaperRequestResult>
  /**
   * Optional transport-owned redactor for credentials used outside the request
   * body. The collector applies it to every response string it persists.
   */
  readonly redactSensitiveText?: PaperSensitiveTextRedactor
  /** Monotonic, credential-free counters shared by all requests in this run. */
  readonly getTransportMetrics?: () => PaperTransportMetrics
}

export interface PaperCollectorOptions {
  model: string
  /** Exact wire protocol; embedded in the manifest and compared strictly. */
  transportProfileId?: string
  role: CollectionPlan['role']
  samplesPerCell: number
  schedulerSeed: string
  request: PaperRequestFunction
  /** Maximum simultaneous injected requests. Does not change the job plan. */
  concurrency?: number
  /** Optional deterministic timestamp for reproducible/offline collection tests. */
  collectedAt?: string
  /** Injectable wall clock; credentials must never be captured by it. */
  now?: () => Date | string
  /**
   * Stop scheduling after the first thrown transport/request failure. The
   * default is false so offline evidence runs can retain failures as samples;
   * network-facing CLI callers should enable it to avoid request storms.
   */
  abortOnRequestError?: boolean
  /** Network-facing callers may stop after a provider error returned with HTTP 200. */
  abortOnProviderError?: boolean
  /** Abort the collection and all transport work that honors this signal. */
  signal?: AbortSignal
  /** Safe, credential-free progress emitted after every terminal sample. */
  onProgress?: (event: PaperCollectionProgressEvent) => void
  /**
   * Aggregate V2 + canonical JSONL checkpoint. Partial checkpoints are never
   * decision eligible and are emitted before their matching progress event.
   */
  onCheckpoint?: (checkpoint: PaperCollectionResult) => void
}

export interface PaperCollectionProgressEvent {
  stage: 'sampling'
  done: number
  total: number
  errors: number
  cellId: ProtocolCellId
  detail: null
  lastErrorKind: PaperCollectionRequestErrorKind | PaperRawSampleEvidence['errorKind']
  lastHttpStatus: number | null
  retrying: false
}

export type PaperCollectionRequestErrorKind =
  | 'aborted'
  | 'timeout'
  | 'auth'
  | 'http'
  | 'non_json'
  | 'network'
  | 'response_too_large'
  | 'redirect'
  | 'unsafe_endpoint'
  | 'malformed_response'
  | 'retry_budget_exhausted'
  | 'provider_error'
  | 'request_failed'

/** Sanitized fail-fast error; it never retains the thrown error or its message. */
export class PaperCollectionRequestError extends Error {
  readonly kind: PaperCollectionRequestErrorKind
  readonly status: number | null

  constructor(error: unknown) {
    const record = isRecord(error) ? error : null
    const acceptedKinds: readonly PaperCollectionRequestErrorKind[] = [
      'aborted',
      'timeout',
      'auth',
      'http',
      'non_json',
      'network',
      'response_too_large',
      'redirect',
      'unsafe_endpoint',
      'malformed_response',
      'retry_budget_exhausted',
      'provider_error',
      'request_failed',
    ]
    const kind = typeof record?.kind === 'string'
      && acceptedKinds.includes(record.kind as PaperCollectionRequestErrorKind)
      ? record.kind as PaperCollectionRequestErrorKind
      : 'request_failed'
    const status = typeof record?.status === 'number'
      && Number.isSafeInteger(record.status)
      && record.status >= 100
      && record.status <= 599
      ? record.status
      : null
    const suffix = status === null ? '' : ` (HTTP ${status})`
    super(`Paper collection aborted after ${kind} request failure${suffix}`)
    this.name = 'PaperCollectionRequestError'
    this.kind = kind
    this.status = status
  }
}

export type PaperEvidenceExclusionReason =
  | 'reasoning_contamination'
  | 'provider_error'
  | 'malformed_response'
  | 'sensitive_credential_echo'
  | null

export interface PaperSampleUsage extends SampleUsage {
  /** Provider-reported request cost, when present. */
  costUsd: number | null
  /** Provider-reported prompt-cache hit tokens, when present. */
  cachedPromptTokens: number | null
}

export interface PaperRawSampleEvidence {
  evidenceVersion: 1
  protocolId: string
  role: CollectionPlan['role']
  schedulerSeed: string
  jobId: string
  cellId: ProtocolCellId
  taskId: Bruckner2026TaskId
  language: Bruckner2026ProfileLanguage
  repetitionIndex: number
  promptVariantId: typeof BRUCKNER_2026_FIXED_PROMPT_VARIANT_ID
  requestedModel: string
  requestedAt: string
  receivedAt: string
  latencyMs: number
  provider: string | null
  reportedModel: string | null
  generationId: string | null
  finishReason: string | null
  raw: string
  normalized: string | null
  /** Result before the reasoning-contamination exclusion was applied. */
  normalizationCandidate: string | null
  category: SampleCategory
  normalizationCategory: Exclude<SampleCategory, 'error'> | null
  excludedFromDistribution: boolean
  exclusionReason: PaperEvidenceExclusionReason
  reasoningTraceFields: string[]
  reasoningTraceCharacterCount: number
  /** Persisted field names in which the transport credential was detected and redacted. */
  sensitiveCredentialEchoFields: string[]
  usage: PaperSampleUsage | null
  errorKind:
    | 'request_failed'
    | 'provider_error'
    | 'malformed_response'
    | 'sensitive_credential_echo'
    | null
}

export interface PaperCollectionResult {
  fingerprint: FingerprintV2
  /** Canonically sorted, credential-free raw evidence objects. */
  evidence: PaperRawSampleEvidence[]
  /** Canonical JSONL whose SHA-256 is stored in fingerprint.quality. */
  rawEvidenceJsonl: string
  /** Precomputed, deterministic scheduler order for audit/debugging. */
  jobs: PaperCollectionJob[]
}

export interface PaperSplitHalfCellResult {
  cellId: ProtocolCellId
  evenValidCount: number
  oddValidCount: number
  jsd: number
}

export interface PaperSplitHalfResult {
  meanJsd: number | null
  cells: PaperSplitHalfCellResult[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function normalizeIsoTimestamp(value: Date | string, name: string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid timestamp`)
  return date.toISOString()
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function jobIdentity(
  cellId: ProtocolCellId,
  repetitionIndex: number,
  promptVariantId: string,
): string {
  return `${cellId}\u0000${repetitionIndex}\u0000${promptVariantId}`
}

/**
 * Clean-room equivalent of the author's archived string-hash + mulberry32 +
 * in-place Fisher-Yates seededShuffle. The returned array is always a copy.
 */
export function bruckner2026SeededShuffle<T>(
  values: readonly T[],
  seed: string,
): T[] {
  requireNonEmptyString(seed, 'seed')
  let state = 1779033703 ^ seed.length
  for (const character of seed) {
    state = Math.imul(state ^ character.charCodeAt(0), 3432918353)
    state = (state << 13) | (state >>> 19)
  }
  let randomState = state >>> 0
  const random = (): number => {
    randomState |= 0
    randomState = (randomState + 0x6d2b79f5) | 0
    let mixed = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
  const shuffled = [...values]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    const current = shuffled[index]
    shuffled[index] = shuffled[swapIndex]
    shuffled[swapIndex] = current
  }
  return shuffled
}

/**
 * Build the complete fixed-prompt job list in the author's grid order, then
 * apply the author's seeded shuffle. Worker count, latency, and completion
 * order cannot change this precomputed plan.
 */
export function createBruckner2026CollectionJobs(
  samplesPerCell: number,
  schedulerSeed: string,
): PaperCollectionJob[] {
  requirePositiveInteger(samplesPerCell, 'samplesPerCell')
  requireNonEmptyString(schedulerSeed, 'schedulerSeed')

  const jobs = BRUCKNER_2026_CANONICAL40_CELLS.flatMap((cell) =>
    Array.from({ length: samplesPerCell }, (_, repetitionIndex) => {
      const identity = jobIdentity(
        cell.cellId,
        repetitionIndex,
        BRUCKNER_2026_FIXED_PROMPT_VARIANT_ID,
      )
      const jobId = sha256(identity)
      const job: PaperCollectionJob = {
        jobId,
        cellId: cell.cellId,
        taskId: cell.taskId,
        language: cell.language,
        repetitionIndex,
        promptVariantId: BRUCKNER_2026_FIXED_PROMPT_VARIANT_ID,
        systemPrompt: cell.systemPrompt,
        userPrompt: cell.userPrompt,
      }
      return job
    }),
  )
  return bruckner2026SeededShuffle(jobs, schedulerSeed)
}

/** Build the exact direct-request body used by the paper profile. */
export function buildBruckner2026DirectRequest(
  model: string,
  job: Readonly<PaperCollectionJob>,
): PaperDirectRequestBody {
  requireNonEmptyString(model, 'model')
  return {
    model,
    messages: [
      { role: 'system', content: job.systemPrompt },
      { role: 'user', content: job.userPrompt },
    ],
    temperature: BRUCKNER_2026_DIRECT_REQUEST_TEMPERATURE,
    max_tokens: BRUCKNER_2026_DIRECT_REQUEST_MAX_TOKENS,
    reasoning: { enabled: false },
    usage: { include: true },
  }
}

function safeMetadataString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  // Identifiers are useful provenance, but unbounded fields are not raw bodies.
  return value.slice(0, 512)
}

function firstChoice(response: Record<string, unknown>): Record<string, unknown> | null {
  const choices = response.choices
  if (!Array.isArray(choices) || !isRecord(choices[0])) return null
  return choices[0]
}

function responseMessage(choice: Record<string, unknown> | null): Record<string, unknown> | null {
  return choice && isRecord(choice.message) ? choice.message : null
}

function traceLength(value: unknown): number {
  if (value === null || value === undefined || value === false) return 0
  if (typeof value === 'string') return value.trim().length
  if (Array.isArray(value)) {
    if (value.length === 0) return 0
    try {
      return canonicalSerialize(value).length
    } catch {
      return 1
    }
  }
  if (isRecord(value)) {
    if (Object.keys(value).length === 0) return 0
    try {
      return canonicalSerialize(value).length
    } catch {
      return 1
    }
  }
  if (typeof value === 'number') return value === 0 ? 0 : String(value).length
  if (value === true) return 1
  return 0
}

function inspectReasoningTrace(
  response: Record<string, unknown>,
  choice: Record<string, unknown> | null,
  message: Record<string, unknown> | null,
): { fields: string[]; characterCount: number } {
  const containers: ReadonlyArray<[string, Record<string, unknown> | null]> = [
    ['choices[0].message', message],
    ['choices[0]', choice],
    ['', response],
  ]
  const reasoningField = /^(?:reasoning(?:_|$)|reasoningDetails$|thinking(?:_|$)|analysis(?:_|$))/i
  const fields: string[] = []
  let characterCount = 0
  for (const [prefix, container] of containers) {
    if (!container) continue
    for (const [key, value] of Object.entries(container)) {
      if (!reasoningField.test(key)) continue
      const length = traceLength(value)
      if (length === 0) continue
      fields.push(prefix ? `${prefix}.${key}` : key)
      characterCount += length
    }
  }
  return { fields, characterCount }
}

const CREDENTIAL_REDACTION = '[REDACTED_CREDENTIAL_ECHO]'

function redactPersistedString(
  value: string | null,
  field: string,
  redactor: PaperSensitiveTextRedactor | undefined,
  matchedFields: string[],
): string | null {
  if (value === null || redactor === undefined) return value
  const redacted = redactor(value)
  if (redacted.matched) matchedFields.push(field)
  // A transport redactor must never return the original sensitive bytes. Use
  // a collector-owned marker if it reports a match without changing the text.
  return redacted.matched && redacted.text === value ? CREDENTIAL_REDACTION : redacted.text
}

function redactMetadataString(
  value: unknown,
  field: string,
  redactor: PaperSensitiveTextRedactor | undefined,
  matchedFields: string[],
): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  // Detect against the complete transport value before applying the evidence
  // length cap, otherwise a credential straddling byte 512 could leak a prefix.
  return safeMetadataString(redactPersistedString(value, field, redactor, matchedFields))
}

function preferredMetadataValue(primary: unknown, fallback: unknown): unknown {
  return typeof primary === 'string' && primary.length > 0 ? primary : fallback
}

function nullableTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function nullableNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function extractUsage(response: Record<string, unknown>): PaperSampleUsage | null {
  if (!isRecord(response.usage)) return null
  const usage = response.usage
  const promptTokens = nullableTokenCount(usage.prompt_tokens ?? usage.input_tokens)
  const completionTokens = nullableTokenCount(usage.completion_tokens ?? usage.output_tokens)
  const details = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : isRecord(usage.output_tokens_details)
      ? usage.output_tokens_details
      : null
  const candidates = [
    nullableTokenCount(usage.reasoning_tokens),
    nullableTokenCount(details?.reasoning_tokens),
  ].filter((value): value is number => value !== null)
  const reasoningTokens = candidates.length > 0 ? Math.max(...candidates) : null
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null
  const costUsd = nullableNonNegativeNumber(usage.cost_usd ?? usage.cost)
  const cachedPromptTokens = nullableTokenCount(promptDetails?.cached_tokens)
  if (
    promptTokens === null
    && completionTokens === null
    && reasoningTokens === null
    && costUsd === null
    && cachedPromptTokens === null
  ) return null
  return { promptTokens, completionTokens, reasoningTokens, costUsd, cachedPromptTokens }
}

function normalizerOptions(
  cell: Bruckner2026ProtocolCell,
): Bruckner2026NormalizerOptions {
  if (cell.normalizeAs !== 'integer') {
    return { lang: cell.language, normalizeAs: cell.normalizeAs }
  }
  if (cell.taskId === 'num100-random') {
    return { lang: cell.language, normalizeAs: 'integer', min: 1, max: 100 }
  }
  if (cell.taskId === 'num10-random') {
    return { lang: cell.language, normalizeAs: 'integer', min: 1, max: 10 }
  }
  // The author's favorite-number task accepts any parsed integer.
  return { lang: cell.language, normalizeAs: 'integer' }
}

function cellForJob(job: PaperCollectionJob): Bruckner2026ProtocolCell {
  const cell = BRUCKNER_2026_CANONICAL40_CELLS.find((candidate) => candidate.cellId === job.cellId)
  if (!cell) throw new Error(`unknown paper-profile cell ${job.cellId}`)
  return cell
}

function durationMs(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start))
}

async function collectOne(
  options: PaperCollectorOptions,
  protocolId: string,
  job: PaperCollectionJob,
  now: () => Date | string,
): Promise<PaperRawSampleEvidence> {
  const requestedAt = normalizeIsoTimestamp(now(), 'now()')
  const context: PaperRequestContext = {
    role: options.role,
    schedulerSeed: options.schedulerSeed,
    job,
  }
  let result: PaperRequestResult
  try {
    result = await options.request(buildBruckner2026DirectRequest(options.model, job), context)
  } catch (error) {
    if (options.abortOnRequestError === true) {
      throw new PaperCollectionRequestError(error)
    }
    const receivedAt = normalizeIsoTimestamp(now(), 'now()')
    return {
      evidenceVersion: 1,
      protocolId,
      role: options.role,
      schedulerSeed: options.schedulerSeed,
      jobId: job.jobId,
      cellId: job.cellId,
      taskId: job.taskId,
      language: job.language,
      repetitionIndex: job.repetitionIndex,
      promptVariantId: job.promptVariantId,
      requestedModel: options.model,
      requestedAt,
      receivedAt,
      latencyMs: durationMs(requestedAt, receivedAt),
      provider: null,
      reportedModel: null,
      generationId: null,
      finishReason: null,
      raw: '',
      normalized: null,
      normalizationCandidate: null,
      category: 'error',
      normalizationCategory: null,
      excludedFromDistribution: true,
      exclusionReason: null,
      reasoningTraceFields: [],
      reasoningTraceCharacterCount: 0,
      sensitiveCredentialEchoFields: [],
      usage: null,
      errorKind: 'request_failed',
    }
  }

  const receivedAt = normalizeIsoTimestamp(now(), 'now()')
  const resultRecord = isRecord(result) ? result : null
  const responseValue = resultRecord?.response
  const response = isRecord(responseValue) ? responseValue : {}
  const metadata = resultRecord && isRecord(resultRecord.metadata)
    ? resultRecord.metadata
    : null
  const choice = firstChoice(response)
  const message = responseMessage(choice)
  const providerError =
    isRecord(responseValue) && Object.hasOwn(response, 'error') && response.error != null
  const malformedResponse =
    !providerError
    && (
      !isRecord(responseValue)
      || choice === null
      || message === null
      || message.role !== 'assistant'
      || typeof message.content !== 'string'
    )
  const unredactedRaw = !providerError && !malformedResponse && typeof message?.content === 'string'
    ? message.content
    : ''
  const sensitiveCredentialEchoFields: string[] = []
  const raw = redactPersistedString(
    unredactedRaw,
    'raw',
    options.request.redactSensitiveText,
    sensitiveCredentialEchoFields,
  ) ?? ''
  const usage = extractUsage(response)
  const trace = inspectReasoningTrace(response, choice, message)
  const reasoningContamination =
    trace.fields.length > 0 || (usage?.reasoningTokens ?? 0) > 0
  const provider = redactMetadataString(
    preferredMetadataValue(metadata?.provider, response.provider),
    'provider',
    options.request.redactSensitiveText,
    sensitiveCredentialEchoFields,
  )
  const reportedModel = redactMetadataString(
    preferredMetadataValue(metadata?.reportedModel, response.model),
    'reportedModel',
    options.request.redactSensitiveText,
    sensitiveCredentialEchoFields,
  )
  const generationId = redactMetadataString(
    preferredMetadataValue(metadata?.generationId, response.id),
    'generationId',
    options.request.redactSensitiveText,
    sensitiveCredentialEchoFields,
  )
  const finishReason = redactMetadataString(
    malformedResponse || providerError ? null : choice?.finish_reason,
    'finishReason',
    options.request.redactSensitiveText,
    sensitiveCredentialEchoFields,
  )
  const sensitiveCredentialEcho = sensitiveCredentialEchoFields.length > 0
  if (providerError && options.abortOnProviderError === true) {
    throw new PaperCollectionRequestError({ kind: 'provider_error' })
  }
  const normalized = providerError || malformedResponse || sensitiveCredentialEcho
    ? null
    : normalizeBruckner2026Answer(raw, normalizerOptions(cellForJob(job)))
  const excluded =
    reasoningContamination || providerError || malformedResponse || sensitiveCredentialEcho

  return {
    evidenceVersion: 1,
    protocolId,
    role: options.role,
    schedulerSeed: options.schedulerSeed,
    jobId: job.jobId,
    cellId: job.cellId,
    taskId: job.taskId,
    language: job.language,
    repetitionIndex: job.repetitionIndex,
    promptVariantId: job.promptVariantId,
    requestedModel: options.model,
    requestedAt,
    receivedAt,
    latencyMs: durationMs(requestedAt, receivedAt),
    provider,
    reportedModel,
    generationId,
    finishReason,
    raw,
    normalized: excluded ? null : normalized?.normalized ?? null,
    normalizationCandidate: normalized?.normalized ?? null,
    category: providerError || malformedResponse || sensitiveCredentialEcho
      ? 'error'
      : reasoningContamination
        ? 'invalid'
        : normalized?.category ?? 'error',
    normalizationCategory: normalized?.category ?? null,
    excludedFromDistribution: excluded,
    exclusionReason: providerError
      ? 'provider_error'
      : malformedResponse
        ? 'malformed_response'
        : sensitiveCredentialEcho
          ? 'sensitive_credential_echo'
          : reasoningContamination
            ? 'reasoning_contamination'
            : null,
    reasoningTraceFields: trace.fields,
    reasoningTraceCharacterCount: trace.characterCount,
    sensitiveCredentialEchoFields,
    usage,
    errorKind: providerError
      ? 'provider_error'
      : malformedResponse
        ? 'malformed_response'
        : sensitiveCredentialEcho
          ? 'sensitive_credential_echo'
          : null,
  }
}

function compareEvidenceOrder(left: PaperRawSampleEvidence, right: PaperRawSampleEvidence): number {
  const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const cellOrder = compareText(left.cellId, right.cellId)
  if (cellOrder !== 0) return cellOrder
  const repetitionOrder = left.repetitionIndex - right.repetitionIndex
  if (repetitionOrder !== 0) return repetitionOrder
  const variantOrder = compareText(left.promptVariantId, right.promptVariantId)
  return variantOrder !== 0 ? variantOrder : compareText(left.jobId, right.jobId)
}

/** Canonical, order-independent JSONL representation of raw sample evidence. */
export function serializePaperRawEvidenceJsonl(
  evidence: readonly PaperRawSampleEvidence[],
): string {
  return [...evidence]
    .sort(compareEvidenceOrder)
    .map((sample) => canonicalSerialize(sample))
    .join('\n') + (evidence.length > 0 ? '\n' : '')
}

/** SHA-256 corresponding exactly to serializePaperRawEvidenceJsonl(). */
export function hashPaperRawEvidence(evidence: readonly PaperRawSampleEvidence[]): string {
  return sha256(serializePaperRawEvidenceJsonl(evidence))
}

function nominalDomainSize(
  cell: Bruckner2026ProtocolCell,
  observedSupport: number,
): number {
  if (cell.taskId === 'num100-random') return 100
  if (cell.taskId === 'num10-random') return 10
  if (cell.taskId === 'coin-flip') return 2
  // Open answer spaces have no finite protocol cardinality. This field is
  // descriptive only; use the observed support rather than inventing one.
  return Math.max(2, observedSupport)
}

function buildCellDistribution(
  cell: Bruckner2026ProtocolCell,
  samples: readonly PaperRawSampleEvidence[],
): V2CellDistribution {
  const counts = Object.create(null) as Record<string, number>
  const latencies: number[] = []
  let validCount = 0
  let invalidCount = 0
  let refusalCount = 0
  let emptyCount = 0
  let errorCount = 0
  let completionTokenSum = 0
  let completionTokenCount = 0
  let reasoningTokenSum = 0
  let reasoningTokenCount = 0

  for (const sample of samples) {
    if (sample.category === 'valid') {
      validCount += 1
      if (sample.normalized !== null) {
        counts[sample.normalized] = (counts[sample.normalized] ?? 0) + 1
      }
    } else if (sample.category === 'invalid') invalidCount += 1
    else if (sample.category === 'refusal') refusalCount += 1
    else if (sample.category === 'empty') emptyCount += 1
    else errorCount += 1

    if (sample.category !== 'error') latencies.push(sample.latencyMs)
    if (sample.category !== 'error' && sample.usage?.completionTokens != null) {
      completionTokenSum += sample.usage.completionTokens
      completionTokenCount += 1
    }
    if (sample.category !== 'error' && sample.usage?.reasoningTokens != null) {
      reasoningTokenSum += sample.usage.reasoningTokens
      reasoningTokenCount += 1
    }
  }

  const entropyBits = shannonEntropyBits(counts)
  const domainSize = nominalDomainSize(cell, Object.keys(counts).length)
  return {
    cellId: cell.cellId,
    counts: { ...counts },
    validCount,
    invalidCount,
    refusalCount,
    emptyCount,
    errorCount,
    totalCount: samples.length,
    entropyBits,
    normalizedEntropy: Math.min(1, entropyBits / Math.log2(domainSize)),
    medianLatencyMs: median(latencies),
    meanCompletionTokens:
      completionTokenCount > 0 ? completionTokenSum / completionTokenCount : null,
    meanReasoningTokens:
      reasoningTokenCount > 0 ? reasoningTokenSum / reasoningTokenCount : null,
  }
}

function buildQuality(
  evidence: readonly PaperRawSampleEvidence[],
  expectedSamples: number,
  rawEvidenceSha256: string,
  transportMetrics: PaperTransportMetrics,
): CollectionQuality {
  const count = (category: SampleCategory): number =>
    evidence.filter((sample) => sample.category === category).length
  const reasoningTokenCount = evidence.reduce(
    (sum, sample) => Math.min(Number.MAX_SAFE_INTEGER, sum + (sample.usage?.reasoningTokens ?? 0)),
    0,
  )
  const reasoningTraceCount = evidence.filter(
    (sample) => sample.reasoningTraceFields.length > 0,
  ).length
  const observableResponseSamples = evidence.filter((sample) => sample.errorKind === null).length
  const reasoningUsageObservedSamples = evidence.filter(
    (sample) => sample.errorKind === null && sample.usage?.reasoningTokens !== null,
  ).length
  const contaminated = reasoningTraceCount > 0 || reasoningTokenCount > 0
  const hasUnobservedResponse = evidence.some((sample) => sample.category === 'error')
  const hasUnobservedReasoningUsage =
    reasoningUsageObservedSamples !== observableResponseSamples
  return {
    qualityVersion: 1,
    complete: evidence.length === expectedSamples,
    completedSamples: evidence.length,
    expectedSamples,
    validSamples: count('valid'),
    invalidSamples: count('invalid'),
    refusalSamples: count('refusal'),
    emptySamples: count('empty'),
    errorSamples: count('error'),
    // "verified" is deliberately narrow: every retained successful sample is
    // the directly observed assistant response channel from the strict body.
    // It does not claim visibility into unreported provider-internal compute.
    directness: contaminated
      ? 'violated'
      : hasUnobservedResponse || hasUnobservedReasoningUsage
        ? 'unknown'
        : 'verified',
    reasoningTraceCount,
    reasoningTokenCount,
    reasoningUsageObservedSamples,
    rawEvidenceSha256,
    attemptCount: transportMetrics.attemptCount,
    retryCount: transportMetrics.retryCount,
  }
}

/**
 * Split each cell by planned repetition parity, never by response arrival.
 * Contaminated, failed, and otherwise invalid samples are excluded.
 */
export function paperSplitHalfByRepetitionIndex(
  evidence: readonly PaperRawSampleEvidence[],
  minPerHalf = 5,
): PaperSplitHalfResult {
  requirePositiveInteger(minPerHalf, 'minPerHalf')
  const grouped = new Map<ProtocolCellId, PaperRawSampleEvidence[]>()
  for (const sample of evidence) {
    const samples = grouped.get(sample.cellId) ?? []
    samples.push(sample)
    grouped.set(sample.cellId, samples)
  }

  const cells: PaperSplitHalfCellResult[] = []
  for (const [cellId, samples] of grouped.entries()) {
    const even = Object.create(null) as Record<string, number>
    const odd = Object.create(null) as Record<string, number>
    let evenValidCount = 0
    let oddValidCount = 0
    for (const sample of samples) {
      if (sample.category !== 'valid' || sample.normalized === null) continue
      const counts = sample.repetitionIndex % 2 === 0 ? even : odd
      counts[sample.normalized] = (counts[sample.normalized] ?? 0) + 1
      if (sample.repetitionIndex % 2 === 0) evenValidCount += 1
      else oddValidCount += 1
    }
    if (evenValidCount < minPerHalf || oddValidCount < minPerHalf) continue
    cells.push({
      cellId,
      evenValidCount,
      oddValidCount,
      jsd: jensenShannonDivergence(even, odd),
    })
  }
  cells.sort((left, right) =>
    left.cellId < right.cellId ? -1 : left.cellId > right.cellId ? 1 : 0,
  )
  return {
    meanJsd:
      cells.length === 0
        ? null
        : cells.reduce((sum, cell) => sum + cell.jsd, 0) / cells.length,
    cells,
  }
}

/**
 * Run the opt-in canonical 40-cell collection through an injected request
 * adapter, then bind canonical raw evidence into a validated V2 artifact.
 */
export async function collectBruckner2026PaperFingerprint(
  options: PaperCollectorOptions,
): Promise<PaperCollectionResult> {
  requireNonEmptyString(options.model, 'model')
  requireNonEmptyString(options.schedulerSeed, 'schedulerSeed')
  requirePositiveInteger(options.samplesPerCell, 'samplesPerCell')
  if (options.role !== 'enrollment' && options.role !== 'audit') {
    throw new TypeError('role must be "enrollment" or "audit"')
  }
  const concurrency = requirePositiveInteger(options.concurrency ?? 1, 'concurrency')
  const now = options.now ?? (() => new Date())
  const collectedAt = normalizeIsoTimestamp(options.collectedAt ?? now(), 'collectedAt')
  const manifest = buildBruckner2026Canonical40Manifest(options.transportProfileId)
  const jobs = createBruckner2026CollectionJobs(options.samplesPerCell, options.schedulerSeed)
  const evidenceInScheduleOrder = new Array<PaperRawSampleEvidence>(jobs.length)
  let nextJobIndex = 0
  let fatalRequestError: PaperCollectionRequestError | null = null

  const completedEvidence = (): PaperRawSampleEvidence[] =>
    evidenceInScheduleOrder.filter(
      (sample): sample is PaperRawSampleEvidence => sample !== undefined,
    )

  const buildResult = (incompleteReason?: string): PaperCollectionResult => {
    const evidence = completedEvidence().sort(compareEvidenceOrder)
    const rawEvidenceJsonl = serializePaperRawEvidenceJsonl(evidence)
    const rawEvidenceSha256 = sha256(rawEvidenceJsonl)
    const cellIds = BRUCKNER_2026_CANONICAL40_CELLS.map((cell) => cell.cellId)
    const plan: CollectionPlan = {
      planVersion: 1,
      role: options.role,
      cellIds,
      samplesPerCell: options.samplesPerCell,
      expectedSamples: jobs.length,
      schedulerSeed: options.schedulerSeed,
      schedulerPolicy: BRUCKNER_2026_SCHEDULER_POLICY,
    }
    const transportMetrics = options.request.getTransportMetrics?.() ?? {
      attemptCount: evidence.length,
      retryCount: 0,
    }
    const quality = buildQuality(evidence, jobs.length, rawEvidenceSha256, transportMetrics)
    const cells: Partial<Record<ProtocolCellId, V2CellDistribution>> = {}
    for (const cell of BRUCKNER_2026_CANONICAL40_CELLS) {
      cells[cell.cellId] = buildCellDistribution(
        cell,
        evidence.filter((sample) => sample.cellId === cell.cellId),
      )
    }

    const fingerprint: FingerprintV2 = {
      formatVersion: 2,
      protocol: manifest.protocolId,
      model: options.model,
      collectedAt,
      samplesPerCell: options.samplesPerCell,
      // This collector never uses the legacy post-reasoning fallback. Observable
      // contamination is represented solely by quality.directness/counters.
      postReasoning: false,
      cells,
      manifest,
      plan,
      quality,
      completedSamples: quality.completedSamples,
      expectedSamples: quality.expectedSamples,
      errorCount: quality.errorSamples,
      meta: {
        tool: 'llm-fingerprint-detector',
        channel: 'paper-profile-direct',
        source: `doi:${BRUCKNER_2026_CANONICAL40_PROFILE.source.softwareDoi}`,
        note: 'opt-in canonical Study A profile; raw evidence retained separately',
      },
    }
    if (!quality.complete) {
      fingerprint.partial = true
      fingerprint.incompleteReason = incompleteReason ?? 'sampling_in_progress'
    }
    validateFingerprint(fingerprint, {
      sourceLabel: quality.complete ? 'paper collection' : 'paper collection checkpoint',
      rejectPartial: quality.complete,
    })
    return { fingerprint, evidence, rawEvidenceJsonl, jobs }
  }

  const emitCheckpoint = (incompleteReason = 'sampling_in_progress'): void => {
    options.onCheckpoint?.(buildResult(incompleteReason))
  }

  // An initial aggregate-only checkpoint makes a controlled interruption safe
  // even before the first request finishes. The CLI only exposes it when at
  // least one evidence record exists.
  emitCheckpoint()

  async function worker(): Promise<void> {
    while (fatalRequestError === null) {
      if (options.signal?.aborted) {
        fatalRequestError = new PaperCollectionRequestError({ kind: 'aborted' })
        return
      }
      const jobIndex = nextJobIndex
      nextJobIndex += 1
      if (jobIndex >= jobs.length) return
      try {
        const sample = await collectOne(
          options,
          manifest.protocolId,
          jobs[jobIndex],
          now,
        )
        evidenceInScheduleOrder[jobIndex] = sample
        // Capture the evidence before reporting progress. A controller that
        // cancels immediately on this event can therefore still retain it.
        emitCheckpoint()
        const evidence = completedEvidence()
        options.onProgress?.({
          stage: 'sampling',
          done: evidence.length,
          total: jobs.length,
          errors: evidence.filter((item) => item.category === 'error').length,
          cellId: sample.cellId,
          detail: null,
          lastErrorKind: sample.errorKind,
          lastHttpStatus: null,
          retrying: false,
        })
      } catch (error) {
        if (fatalRequestError === null) {
          fatalRequestError = error instanceof PaperCollectionRequestError
            ? error
            : new PaperCollectionRequestError(error)
        }
        return
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  )
  const collectionError = fatalRequestError as PaperCollectionRequestError | null
  if (collectionError !== null) {
    emitCheckpoint(
      collectionError.kind === 'aborted' ? 'sampling_interrupted' : 'sampling_failed',
    )
    throw collectionError
  }

  const result = buildResult()
  options.onCheckpoint?.(result)
  return result
}
