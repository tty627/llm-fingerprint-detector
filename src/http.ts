/**
 * Minimal HTTP layer over `POST {baseUrl}/chat/completions`:
 * timeout + exponential backoff on 429/5xx/timeouts + AbortSignal
 * pass-through + error classification. Uses the global `fetch`
 * (Node ≥ 18 built-in, or any browser).
 *
 * The API key only ever appears in the Authorization header of the request
 * to the endpoint under test; it is never logged or sent anywhere else.
 */

import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_RETRY_DELAY_MS,
} from './constants.js'
import type { ProbeErrorKind, ResolvedEndpoint, SampleUsage } from './types.js'

export type { ProbeErrorKind } from './types.js'

export class ProbeRequestError extends Error {
  readonly kind: ProbeErrorKind
  readonly status: number | null

  constructor(kind: ProbeErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'ProbeRequestError'
    this.kind = kind
    this.status = status
  }
}

export interface ChatCompletionResult {
  content: string
  usage: SampleUsage | null
  latencyMs: number
  status: number
}

interface ChatCompletionUsagePayload {
  prompt_tokens?: number
  completion_tokens?: number
  reasoning_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

function parseUsage(payload: ChatCompletionUsagePayload | undefined | null): SampleUsage | null {
  if (!payload) return null
  return {
    promptTokens: typeof payload.prompt_tokens === 'number' ? payload.prompt_tokens : null,
    completionTokens:
      typeof payload.completion_tokens === 'number' ? payload.completion_tokens : null,
    reasoningTokens:
      typeof payload.completion_tokens_details?.reasoning_tokens === 'number'
        ? payload.completion_tokens_details.reasoning_tokens
        : typeof payload.reasoning_tokens === 'number'
          ? payload.reasoning_tokens
          : null,
  }
}

/** `content` is a string in the OpenAI schema, but some gateways send part arrays. */
function extractContent(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join('')
  }
  return ''
}

export interface ChatCompletionRequest {
  endpoint: ResolvedEndpoint
  systemPrompt: string
  userPrompt: string
  temperature: number
  maxTokens: number
  extraBody: Record<string, unknown>
  signal?: AbortSignal
  timeoutMs?: number
  retries?: number
  onRetry?: (event: RetryEvent) => void
}

export interface RetryEvent {
  /** One-based retry number (the request attempt that will run next). */
  attempt: number
  maxRetries: number
  kind: ProbeErrorKind
  status: number | null
  delayMs: number
}

/** Parse either Retry-After seconds or an HTTP date, then apply the hard cap. */
export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (value === null || value.trim() === '') return null
  const seconds = Number(value)
  let parsed: number
  if (Number.isFinite(seconds)) {
    parsed = seconds * 1_000
  } else {
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) return null
    parsed = timestamp - nowMs
  }
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, parsed))
}

/** Provider delay when valid, otherwise bounded exponential backoff. */
export function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  randomFraction = Math.random(),
): number {
  const providerDelay = parseRetryAfterMs(retryAfter)
  if (providerDelay !== null) return providerDelay
  const exponential = 800 * 2 ** attempt + Math.max(0, Math.min(1, randomFraction)) * 400
  return Math.min(MAX_RETRY_DELAY_MS, exponential)
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProbeRequestError('aborted', 'Aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ProbeRequestError('aborted', 'Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // Close the tiny race between the check above and listener registration.
    if (signal?.aborted) onAbort()
  })
}

/**
 * One chat/completions call with retries. Retried: 429, 5xx, timeouts.
 * Not retried: transport errors and 401/403 — those are classified and
 * re-thrown for the caller to decide.
 */
export async function fetchChatCompletion(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  const retries = request.retries ?? DEFAULT_MAX_RETRIES
  const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  let lastError: ProbeRequestError | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (request.signal?.aborted) throw new ProbeRequestError('aborted', 'Aborted')

    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
    const onOuterAbort = () => timeoutController.abort()
    request.signal?.addEventListener('abort', onOuterAbort, { once: true })

    const startedAt = performance.now()
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...request.endpoint.headers,
      }
      if (request.endpoint.apiKey) {
        headers.Authorization = `Bearer ${request.endpoint.apiKey}`
      }
      const response = await fetch(`${request.endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: request.endpoint.model,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stream: false,
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
          ...request.extraBody,
        }),
        signal: timeoutController.signal,
      })
      const latencyMs = performance.now() - startedAt

      if (response.status === 401 || response.status === 403) {
        throw new ProbeRequestError(
          'auth',
          `HTTP ${response.status} — API key rejected`,
          response.status,
        )
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfterHeader = response.headers.get('retry-after')
        lastError = new ProbeRequestError('http', `HTTP ${response.status}`, response.status)
        if (attempt < retries) {
          const backoff = retryDelayMs(retryAfterHeader, attempt)
          request.onRetry?.({
            attempt: attempt + 1,
            maxRetries: retries,
            kind: lastError.kind,
            status: lastError.status,
            delayMs: backoff,
          })
          await delay(backoff, request.signal)
          continue
        }
        throw lastError
      }
      if (!response.ok) {
        let detail = ''
        try {
          detail = (await response.text()).slice(0, 300)
        } catch {
          // Ignore body read failures.
        }
        throw new ProbeRequestError(
          'http',
          `HTTP ${response.status} ${detail}`.trim(),
          response.status,
        )
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: unknown }>
        usage?: ChatCompletionUsagePayload
      }
      return {
        content: extractContent(payload?.choices?.[0]?.message),
        usage: parseUsage(payload?.usage),
        latencyMs,
        status: response.status,
      }
    } catch (error) {
      if (error instanceof ProbeRequestError) throw error
      if (request.signal?.aborted) throw new ProbeRequestError('aborted', 'Aborted')
      if (timeoutController.signal.aborted) {
        lastError = new ProbeRequestError('timeout', `Request timed out after ${timeoutMs}ms`)
      } else {
        lastError = new ProbeRequestError(
          'network',
          error instanceof Error ? error.message : 'Network error',
        )
      }
      if (lastError.kind === 'timeout' && attempt < retries) {
        request.onRetry?.({
          attempt: attempt + 1,
          maxRetries: retries,
          kind: lastError.kind,
          status: lastError.status,
          delayMs: 0,
        })
        continue
      }
      throw lastError
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  throw lastError ?? new ProbeRequestError('network', 'Unknown error')
}
