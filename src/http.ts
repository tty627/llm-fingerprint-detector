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
  /** Injectable resolver used to revalidate every physical request attempt. */
  resolver?: ProbeHostResolver
  /** Test-only escape hatch: HTTP is allowed only for an all-loopback result. */
  allowInsecureLoopbackForTests?: boolean
  /** Injectable transport used by deterministic security tests. */
  fetchImpl?: typeof fetch
}

export type ProbeHostResolver = (hostname: string) => Promise<readonly string[]>

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

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504])

function ipv4Number(address: string): number | null {
  const octets = address.split('.')
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/u.test(part))) return null
  const values = octets.map(Number)
  if (values.some((part) => part < 0 || part > 255)) return null
  return ((values[0] << 24) | (values[1] << 16) | (values[2] << 8) | values[3]) >>> 0
}

function inIpv4Range(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Number(base)
  if (baseValue === null) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (baseValue & mask)
}

function normalizedHostAddress(address: string): string {
  const withoutBrackets = address.startsWith('[') && address.endsWith(']')
    ? address.slice(1, -1)
    : address
  return withoutBrackets.toLowerCase().split('%')[0]
}

function isLoopbackAddress(address: string): boolean {
  const normalized = normalizedHostAddress(address)
  const ipv4 = ipv4Number(normalized)
  if (ipv4 !== null) return inIpv4Range(ipv4, '127.0.0.0', 8)
  return normalized === '::1' || normalized.startsWith('::ffff:127.')
}

/** Conservative public-address allow policy for endpoint credentials. */
export function isUnsafeProbeEndpointAddress(address: string): boolean {
  const normalized = normalizedHostAddress(address)
  const ipv4 = ipv4Number(normalized)
  if (ipv4 !== null) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, prefix]) => inIpv4Range(ipv4, base as string, prefix as number))
  }
  // URL parsing canonicalizes unusual IPv4 spellings before this point.
  if (!normalized.includes(':')) return true
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) {
    return isUnsafeProbeEndpointAddress(normalized.slice('::ffff:'.length))
  }
  return normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/u.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:')
    || normalized.startsWith('2001:2:')
    || normalized.startsWith('2002:')
}

const defaultResolver: ProbeHostResolver = async (hostname) => {
  const normalized = normalizedHostAddress(hostname)
  if (ipv4Number(normalized) !== null || normalized.includes(':')) return [normalized]
  const dns = await import('node:dns/promises')
  const records = await dns.lookup(normalized, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

async function assertSafeEndpoint(request: ChatCompletionRequest): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(`${request.endpoint.baseUrl}/chat/completions`)
  } catch {
    throw new ProbeRequestError('unsafe_endpoint', 'Endpoint URL is invalid')
  }
  let addresses: readonly string[]
  try {
    addresses = await (request.resolver ?? defaultResolver)(parsed.hostname)
  } catch {
    throw new ProbeRequestError('network', 'Endpoint DNS resolution failed')
  }
  if (addresses.length === 0) throw new ProbeRequestError('network', 'Endpoint DNS resolution failed')
  const envAllowsLoopback =
    typeof process !== 'undefined'
    && process.env.LLMFP_ALLOW_INSECURE_LOOPBACK_FOR_TESTS === '1'
  const allowLoopback = request.allowInsecureLoopbackForTests === true || envAllowsLoopback
  const onlyLoopback = addresses.every(isLoopbackAddress)
  if (parsed.protocol !== 'https:') {
    if (!(allowLoopback && onlyLoopback)) {
      throw new ProbeRequestError('unsafe_endpoint', 'Endpoint must use HTTPS')
    }
    return
  }
  if (addresses.some(isUnsafeProbeEndpointAddress)) {
    throw new ProbeRequestError('unsafe_endpoint', 'Endpoint resolved to a non-public address')
  }
}

/**
 * One chat/completions call with retries. Retried: 429, 5xx, timeouts.
 * Not retried: transport errors and 401/403 — those are classified and
 * re-thrown for the caller to decide.
 */
export async function fetchChatCompletion(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  const retries = Math.min(request.retries ?? DEFAULT_MAX_RETRIES, DEFAULT_MAX_RETRIES)
  const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  let lastError: ProbeRequestError | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (request.signal?.aborted) throw new ProbeRequestError('aborted', 'Aborted')
    await assertSafeEndpoint(request)

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
      const fetchImpl = request.fetchImpl ?? globalThis.fetch
      const response = await fetchImpl(`${request.endpoint.baseUrl}/chat/completions`, {
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
        redirect: 'error',
      })
      const latencyMs = performance.now() - startedAt

      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        try { await response.body?.cancel() } catch { /* Preserve safe typed error. */ }
        throw new ProbeRequestError('redirect', 'Endpoint redirect was rejected', response.status)
      }
      if (response.status === 401 || response.status === 403) {
        try { await response.body?.cancel() } catch { /* Preserve safe typed error. */ }
        throw new ProbeRequestError(
          'auth',
          `HTTP ${response.status} — API key rejected`,
          response.status,
        )
      }
      if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
        const retryAfterHeader = response.headers.get('retry-after')
        try { await response.body?.cancel() } catch { /* Preserve safe typed error. */ }
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
        try { await response.body?.cancel() } catch { /* Preserve safe typed error. */ }
        throw new ProbeRequestError(
          'http',
          `HTTP ${response.status}`,
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
        lastError = new ProbeRequestError('network', 'Endpoint request failed')
      }
      if ((lastError.kind === 'timeout' || lastError.kind === 'network') && attempt < retries) {
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
