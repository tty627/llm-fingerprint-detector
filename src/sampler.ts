/**
 * Sampling engine: a worker pool over a shuffled request queue with retries,
 * live progress callbacks and AbortSignal cancellation.
 *
 *  - Requests are shuffled so a single cell is never hammered in a burst,
 *    which would bias endpoint-side caching/rate-limiting systematically;
 *  - a request that still fails after retries is recorded as an `error`
 *    sample (excluded from distributions);
 *  - ≥N consecutive transport errors abort the run (endpoint unreachable);
 *  - 401/403 aborts immediately (bad key).
 */

import { getSystemPrompt, getTaskSpec, pickParaphrase } from './battery.js'
import { CONSECUTIVE_NETWORK_ERROR_LIMIT, PROBE_TEMPERATURE } from './constants.js'
import { fetchChatCompletion, ProbeRequestError } from './http.js'
import { normalizeAnswer } from './normalizer.js'
import type {
  CellId,
  ProbeErrorKind,
  ProgressEvent,
  ReasoningAdapter,
  ResolvedEndpoint,
  SampleResult,
} from './types.js'

export class ProbeRunError extends Error {
  readonly reason: 'network' | 'auth' | 'aborted'

  constructor(reason: 'network' | 'auth' | 'aborted', message: string) {
    super(message)
    this.name = 'ProbeRunError'
    this.reason = reason
  }
}

interface ProbeJob {
  cellId: CellId
  paraphrase: string
}

export interface SamplerOptions {
  endpoint: ResolvedEndpoint
  adapter: ReasoningAdapter
  cells: CellId[]
  samplesPerCell: number
  concurrency: number
  timeoutMs?: number
  maxRetries?: number
  signal?: AbortSignal
  onSample?: (sample: SampleResult) => void
  onProgress?: (event: ProgressEvent) => void
}

export interface SamplerResult {
  samples: SampleResult[]
  samplesByCell: Map<CellId, SampleResult[]>
  errorCount: number
}

function shuffle<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/**
 * Run the full probe battery against one endpoint. Throws ProbeRunError when
 * the whole run must stop (unreachable endpoint / invalid key / cancelled).
 */
export async function runProbeBattery(options: SamplerOptions): Promise<SamplerResult> {
  const jobs: ProbeJob[] = []
  for (const cellId of options.cells) {
    for (let i = 0; i < options.samplesPerCell; i++) {
      jobs.push({ cellId, paraphrase: pickParaphrase(cellId) })
    }
  }
  const queue = shuffle(jobs)

  const samples: SampleResult[] = []
  const samplesByCell = new Map<CellId, SampleResult[]>()
  for (const cellId of options.cells) samplesByCell.set(cellId, [])

  let arrivalIndex = 0
  let errorCount = 0
  let consecutiveNetworkErrors = 0
  let fatalError: ProbeRunError | null = null
  let cursor = 0
  let lastErrorKind: ProbeErrorKind | 'unknown' | null = null
  let lastHttpStatus: number | null = null

  const recordSample = (sample: SampleResult) => {
    samples.push(sample)
    samplesByCell.get(sample.cellId)?.push(sample)
    options.onSample?.(sample)
    options.onProgress?.({
      stage: 'sampling',
      done: samples.length,
      total: queue.length,
      errors: errorCount,
      cellId: sample.cellId,
      lastErrorKind,
      lastHttpStatus,
      retrying: false,
    })
  }

  async function worker(): Promise<void> {
    while (true) {
      if (fatalError || options.signal?.aborted) return
      const index = cursor
      cursor += 1
      if (index >= queue.length) return
      const job = queue[index]

      const startedAt = performance.now()
      const systemPrompt = getSystemPrompt(job.cellId)
      try {
        const result = await fetchChatCompletion({
          endpoint: options.endpoint,
          systemPrompt,
          userPrompt: job.paraphrase,
          temperature: PROBE_TEMPERATURE,
          maxTokens: options.adapter.maxTokens,
          extraBody: options.adapter.extraBody,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          retries: options.maxRetries,
          onRetry: (retry) => {
            lastErrorKind = retry.kind
            lastHttpStatus = retry.status
            options.onProgress?.({
              stage: 'sampling',
              done: samples.length,
              total: queue.length,
              errors: errorCount,
              cellId: job.cellId,
              detail: `retry ${retry.attempt}/${retry.maxRetries} in ${Math.round(retry.delayMs)}ms`,
              lastErrorKind,
              lastHttpStatus,
              retrying: true,
            })
          },
        })
        consecutiveNetworkErrors = 0
        const apiKey = options.endpoint.apiKey
        if (apiKey && result.content.includes(apiKey)) {
          lastErrorKind = 'unknown'
          lastHttpStatus = null
          errorCount += 1
          recordSample({
            cellId: job.cellId,
            raw: '',
            normalized: null,
            category: 'error',
            latencyMs: result.latencyMs,
            usage: null,
            arrivalIndex: arrivalIndex++,
            errorMessage: 'Response excluded because it echoed a request credential',
            errorKind: 'unknown',
            httpStatus: null,
          })
          continue
        }
        const domain = getTaskSpec(job.cellId).domain
        const { normalized, category } = normalizeAnswer(result.content, domain)
        recordSample({
          cellId: job.cellId,
          raw: result.content,
          normalized,
          category,
          latencyMs: result.latencyMs,
          usage: result.usage,
          arrivalIndex: arrivalIndex++,
        })
      } catch (error) {
        if (options.signal?.aborted) {
          fatalError = fatalError ?? new ProbeRunError('aborted', 'Run cancelled')
          return
        }
        if (error instanceof ProbeRequestError) {
          if (error.kind === 'aborted') {
            fatalError = fatalError ?? new ProbeRunError('aborted', 'Run cancelled')
            return
          }
          if (error.kind === 'auth') {
            fatalError = new ProbeRunError('auth', error.message)
          }
          if (error.kind === 'redirect' || error.kind === 'unsafe_endpoint') {
            fatalError = new ProbeRunError('network', error.message)
          }
          lastErrorKind = error.kind
          lastHttpStatus = error.status
          if (error.kind === 'network') {
            consecutiveNetworkErrors += 1
          } else {
            consecutiveNetworkErrors = 0
          }
          errorCount += 1
          recordSample({
            cellId: job.cellId,
            raw: '',
            normalized: null,
            category: 'error',
            latencyMs: performance.now() - startedAt,
            usage: null,
            arrivalIndex: arrivalIndex++,
            errorMessage: error.message,
            errorKind: error.kind,
            httpStatus: error.status,
          })
          if (
            error.kind === 'network' &&
            consecutiveNetworkErrors >= CONSECUTIVE_NETWORK_ERROR_LIMIT
          ) {
            fatalError = new ProbeRunError(
              'network',
              `Endpoint unreachable (${consecutiveNetworkErrors} consecutive transport errors): ${error.message}`,
            )
          }
        } else {
          lastErrorKind = 'unknown'
          lastHttpStatus = null
          errorCount += 1
          recordSample({
            cellId: job.cellId,
            raw: '',
            normalized: null,
            category: 'error',
            latencyMs: performance.now() - startedAt,
            usage: null,
            arrivalIndex: arrivalIndex++,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorKind: 'unknown',
            httpStatus: null,
          })
        }
      }
    }
  }

  const workerCount = Math.max(1, Math.min(options.concurrency, queue.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  if (fatalError) throw fatalError
  if (options.signal?.aborted) throw new ProbeRunError('aborted', 'Run cancelled')

  return { samples, samplesByCell, errorCount }
}
