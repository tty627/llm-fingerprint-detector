/**
 * Opt-in OpenAI-compatible HTTP transport for the paper-profile collector.
 *
 * The collector owns the complete request body. This adapter serializes that
 * body unchanged and adds only the HTTP envelope required to send it. In
 * particular, it never adds `stream`, `top_p`, `seed`, adapter probes, or a
 * fallback request shape.
 */

import type {
  PaperDirectRequestBody,
  PaperRequestFunction,
  PaperRequestResult,
  PaperSensitiveTextRedactor,
} from './paper-collector.js'

export type PaperHttpErrorKind =
  | 'aborted'
  | 'timeout'
  | 'auth'
  | 'http'
  | 'non_json'
  | 'network'
  | 'response_too_large'

/** Safe transport error: messages never contain credentials or response bodies. */
export class PaperHttpRequestError extends Error {
  readonly kind: PaperHttpErrorKind
  readonly status: number | null
  readonly attempts: number

  constructor(
    kind: PaperHttpErrorKind,
    message: string,
    options: { status?: number | null; attempts?: number } = {},
  ) {
    super(message)
    this.name = 'PaperHttpRequestError'
    this.kind = kind
    this.status = options.status ?? null
    this.attempts = options.attempts ?? 1
  }
}

export interface PaperHttpRetryEvent {
  /** One-based number of the request attempt that will run next. */
  attempt: number
  maxRetries: number
  kind: Extract<PaperHttpErrorKind, 'timeout' | 'http' | 'network'>
  status: number | null
  delayMs: number
}

export type PaperFetch = typeof fetch
export type PaperDelay = (milliseconds: number, signal?: AbortSignal) => Promise<void>

export interface OpenAICompatiblePaperTransportOptions {
  /** OpenAI-compatible base URL, normally ending in `/v1`. */
  baseUrl: string
  /** Used only as `Authorization: Bearer ...`; never placed in evidence or errors. */
  apiKey?: string
  /**
   * Optional endpoint compatibility headers. Case-insensitive Authorization
   * and Content-Type entries are ignored; those two headers are owned here.
   */
  headers?: Readonly<Record<string, string>>
  timeoutMs?: number
  /** Maximum accepted successful JSON response body. Default: 1 MiB. */
  maxResponseBytes?: number
  /** Retries after the initial attempt. Retried: timeout/network/429/5xx. */
  retries?: number
  signal?: AbortSignal
  fetchImpl?: PaperFetch
  delay?: PaperDelay
  onRetry?: (event: PaperHttpRetryEvent) => void
}

/** Defaults pinned to the archived Study-A run configuration. */
export const BRUCKNER_2026_HTTP_TIMEOUT_MS = 90_000
export const BRUCKNER_2026_HTTP_RETRIES = 5
export const BRUCKNER_2026_HTTP_MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_RETRY_DELAY_MS = 10_000

function requirePositiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`)
  }
  return value
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function chatCompletionsUrl(baseUrl: string): string {
  if (baseUrl.trim().length === 0) throw new TypeError('baseUrl must be a non-empty URL')
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new TypeError('baseUrl must be a valid HTTP(S) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('baseUrl must be an HTTP(S) URL')
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('baseUrl must not contain credentials')
  }
  parsed.search = ''
  parsed.hash = ''
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/chat/completions`
  return parsed.toString()
}

function retryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (value === null || value.trim().length === 0) return null
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - nowMs
  if (!Number.isFinite(milliseconds)) return null
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, milliseconds))
}

function retryDelay(attemptIndex: number, header: string | null = null): number {
  return retryAfterMs(header) ?? Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** attemptIndex)
}

const defaultDelay: PaperDelay = async (milliseconds, signal) => {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PaperHttpRequestError('aborted', 'Paper request aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new PaperHttpRequestError('aborted', 'Paper request aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

interface AttemptResult {
  result?: PaperRequestResult
  retryStatus?: number
  retryAfter?: string | null
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Error bodies are deliberately not retained. Cancellation is best-effort
    // and must never replace the safe typed HTTP error.
  }
}

async function readJsonWithLimit(
  response: Response,
  maxResponseBytes: number,
  attemptNumber: number,
): Promise<unknown> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      await cancelBody(response)
      throw new PaperHttpRequestError(
        'response_too_large',
        `Paper endpoint response exceeded ${maxResponseBytes} bytes`,
        { status: response.status, attempts: attemptNumber },
      )
    }
  }

  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  if (reader !== undefined) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        totalBytes += value.byteLength
        if (totalBytes > maxResponseBytes) {
          try {
            await reader.cancel()
          } catch {
            // Preserve the safe size error below.
          }
          throw new PaperHttpRequestError(
            'response_too_large',
            `Paper endpoint response exceeded ${maxResponseBytes} bytes`,
            { status: response.status, attempts: attemptNumber },
          )
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new PaperHttpRequestError(
      'non_json',
      'Paper endpoint returned a non-JSON response',
      { status: response.status, attempts: attemptNumber },
    )
  }
}

async function makeAttempt(
  fetchImpl: PaperFetch,
  url: string,
  apiKey: string | undefined,
  compatibilityHeaders: Readonly<Record<string, string>>,
  body: Readonly<PaperDirectRequestBody>,
  timeoutMs: number,
  maxResponseBytes: number,
  outerSignal: AbortSignal | undefined,
  attemptNumber: number,
): Promise<AttemptResult> {
  if (outerSignal?.aborted) {
    throw new PaperHttpRequestError('aborted', 'Paper request aborted', {
      attempts: attemptNumber,
    })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = (): void => controller.abort()
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(compatibilityHeaders)) {
      const normalized = name.trim().toLowerCase()
      if (normalized === 'authorization' || normalized === 'content-type') continue
      headers[name] = value
    }
    headers['Content-Type'] = 'application/json'
    if (apiKey !== undefined && apiKey.length > 0) {
      headers.Authorization = `Bearer ${apiKey}`
    }
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = response.headers.get('retry-after')
      await cancelBody(response)
      return {
        retryStatus: response.status,
        retryAfter,
      }
    }
    if (response.status === 401 || response.status === 403) {
      await cancelBody(response)
      throw new PaperHttpRequestError(
        'auth',
        `Paper endpoint rejected Authorization (HTTP ${response.status})`,
        { status: response.status, attempts: attemptNumber },
      )
    }
    if (!response.ok) {
      await cancelBody(response)
      throw new PaperHttpRequestError(
        'http',
        `Paper endpoint returned HTTP ${response.status}`,
        { status: response.status, attempts: attemptNumber },
      )
    }

    const payload = await readJsonWithLimit(response, maxResponseBytes, attemptNumber)
    return { result: { response: payload } }
  } catch (error) {
    if (error instanceof PaperHttpRequestError) throw error
    if (outerSignal?.aborted) {
      throw new PaperHttpRequestError('aborted', 'Paper request aborted', {
        attempts: attemptNumber,
      })
    }
    if (controller.signal.aborted) {
      throw new PaperHttpRequestError(
        'timeout',
        `Paper request timed out after ${timeoutMs} ms`,
        { attempts: attemptNumber },
      )
    }
    throw new PaperHttpRequestError('network', 'Paper endpoint request failed', {
      attempts: attemptNumber,
    })
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * Create the explicit HTTP adapter consumed by
 * `collectBruckner2026PaperFingerprint`. No request is made until the returned
 * function is called.
 */
export function createOpenAICompatiblePaperTransport(
  options: OpenAICompatiblePaperTransportOptions,
): PaperRequestFunction {
  const url = chatCompletionsUrl(options.baseUrl)
  const timeoutMs = requirePositiveFinite(
    options.timeoutMs ?? BRUCKNER_2026_HTTP_TIMEOUT_MS,
    'timeoutMs',
  )
  const retries = requireNonNegativeInteger(
    options.retries ?? BRUCKNER_2026_HTTP_RETRIES,
    'retries',
  )
  const maxResponseBytes = requireNonNegativeInteger(
    options.maxResponseBytes ?? BRUCKNER_2026_HTTP_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  )
  if (maxResponseBytes === 0) throw new TypeError('maxResponseBytes must be greater than zero')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required')
  const delay = options.delay ?? defaultDelay
  const apiKey = options.apiKey?.trim()

  const request: PaperRequestFunction = async (body) => {
    let lastError: PaperHttpRequestError | null = null
    for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex += 1) {
      const attemptNumber = attemptIndex + 1
      try {
        const attempted = await makeAttempt(
          fetchImpl,
          url,
          apiKey,
          options.headers ?? {},
          body,
          timeoutMs,
          maxResponseBytes,
          options.signal,
          attemptNumber,
        )
        if (attempted.result !== undefined) return attempted.result

        const status = attempted.retryStatus ?? 500
        lastError = new PaperHttpRequestError(
          'http',
          `Paper endpoint returned HTTP ${status}`,
          { status, attempts: attemptNumber },
        )
        if (attemptIndex >= retries) throw lastError
        const waitMs = retryDelay(attemptIndex, attempted.retryAfter)
        options.onRetry?.({
          attempt: attemptNumber + 1,
          maxRetries: retries,
          kind: 'http',
          status,
          delayMs: waitMs,
        })
        await delay(waitMs, options.signal)
      } catch (error) {
        const safeError = error instanceof PaperHttpRequestError
          ? error
          : new PaperHttpRequestError('network', 'Paper endpoint request failed', {
              attempts: attemptNumber,
            })
        if (
          (safeError.kind !== 'timeout' && safeError.kind !== 'network')
          || attemptIndex >= retries
        ) throw safeError
        lastError = safeError
        const waitMs = retryDelay(attemptIndex)
        options.onRetry?.({
          attempt: attemptNumber + 1,
          maxRetries: retries,
          kind: safeError.kind,
          status: null,
          delayMs: waitMs,
        })
        await delay(waitMs, options.signal)
      }
    }
    throw lastError ?? new PaperHttpRequestError('network', 'Paper endpoint request failed')
  }
  if (apiKey !== undefined && apiKey.length > 0) {
    const redactSensitiveText: PaperSensitiveTextRedactor = (value) => {
      if (!value.includes(apiKey)) return { text: value, matched: false }
      return {
        text: value.split(apiKey).join('[REDACTED_CREDENTIAL_ECHO]'),
        matched: true,
      }
    }
    Object.defineProperty(request, 'redactSensitiveText', {
      value: redactSensitiveText,
      enumerable: false,
      configurable: false,
      writable: false,
    })
  }
  return request
}
