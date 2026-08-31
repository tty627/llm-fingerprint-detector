/**
 * Strict HTTP transports for the opt-in canonical40 paper collector.
 *
 * Both transports use one fixed request shape, reject redirects, retain no
 * unsuccessful response body, and surface only typed credential-free errors.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

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
  | 'redirect'
  | 'non_json'
  | 'network'
  | 'unsafe_endpoint'
  | 'response_too_large'
  | 'malformed_response'
  | 'retry_budget_exhausted'

/** Safe transport error: messages never contain credentials, URLs, or response bodies. */
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
export type PaperHostResolver = (hostname: string) => Promise<readonly string[]>

interface PaperTransportOptions {
  baseUrl: string
  apiKey?: string
  headers?: Readonly<Record<string, string>>
  timeoutMs?: number
  /** Maximum accepted successful JSON response body. Default: 1 MiB. */
  maxResponseBytes?: number
  /** Retries after the initial attempt. Hard maximum: 2. */
  retries?: number
  /** Aggregate retries shared across all logical jobs. Default: 240. */
  retryBudget?: number
  signal?: AbortSignal
  fetchImpl?: PaperFetch
  delay?: PaperDelay
  onRetry?: (event: PaperHttpRetryEvent) => void
  /** Injectable resolver. Every physical attempt is revalidated. */
  resolver?: PaperHostResolver
  /** Test-only escape hatch: allow HTTP only when every resolved address is loopback. */
  allowInsecureLoopbackForTests?: boolean
}

export interface OpenAICompatiblePaperTransportOptions extends PaperTransportOptions {
  /** OpenAI-compatible base URL, normally ending in `/v1`. */
  baseUrl: string
  /** Used only as `Authorization: Bearer ...`; never placed in evidence or errors. */
  apiKey?: string
}

export interface AnthropicMessagesOpus5TransportOptions extends PaperTransportOptions {
  /** Anthropic-compatible base URL, normally ending in `/v1`. */
  baseUrl: string
  /** Used only as `x-api-key`; never placed in request bodies, evidence, or errors. */
  apiKey: string
}

export interface AnthropicMessagesOpus5RequestBody {
  model: string
  system: string
  messages: readonly [{ readonly role: 'user'; readonly content: string }]
  temperature: 1
  max_tokens: 16
  thinking: { readonly type: 'disabled' }
  output_config: { readonly effort: 'high' }
}

export const ANTHROPIC_MESSAGES_OPUS5_TRANSPORT_PROFILE =
  'anthropic-messages-opus5-onetoken-v1' as const
export const ANTHROPIC_API_VERSION = '2023-06-01' as const

export const BRUCKNER_2026_HTTP_TIMEOUT_MS = 90_000
export const BRUCKNER_2026_HTTP_RETRIES = 2
export const BRUCKNER_2026_HTTP_MAX_RESPONSE_BYTES = 1024 * 1024
export const BRUCKNER_2026_HTTP_MAX_RETRY_DELAY_MS = 60_000
export const BRUCKNER_2026_HTTP_RETRY_BUDGET = 240

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504])
const INTERNAL_XML = /<\s*\/?\s*(?:think(?:ing)?|analysis|reasoning|tool(?:_use|_result)?|function_calls?|invoke|use_mcp_tool)\b[^>]*>/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

function requireRetryCount(value: number): number {
  const retries = requireNonNegativeInteger(value, 'retries')
  if (retries > BRUCKNER_2026_HTTP_RETRIES) {
    throw new TypeError(`retries must not exceed ${BRUCKNER_2026_HTTP_RETRIES}`)
  }
  return retries
}

function endpointUrl(baseUrl: string, suffix: 'chat/completions' | 'messages'): URL {
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
  if (parsed.search || parsed.hash) {
    throw new TypeError('baseUrl must not contain a query or fragment')
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/${suffix}`
  return parsed
}

function retryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (value === null || value.trim().length === 0) return null
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - nowMs
  if (!Number.isFinite(milliseconds)) return null
  return Math.min(BRUCKNER_2026_HTTP_MAX_RETRY_DELAY_MS, Math.max(0, milliseconds))
}

function retryDelay(attemptIndex: number, header: string | null = null): number {
  return retryAfterMs(header)
    ?? Math.min(BRUCKNER_2026_HTTP_MAX_RETRY_DELAY_MS, 500 * 2 ** attemptIndex)
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

const defaultResolver: PaperHostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null
  const octets = address.split('.').map(Number)
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

function inIpv4Range(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Number(base)
  if (baseValue === null) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (baseValue & mask)
}

function isLoopbackAddress(address: string): boolean {
  const ipv4 = ipv4Number(address)
  if (ipv4 !== null) return inIpv4Range(ipv4, '127.0.0.0', 8)
  const normalized = address.toLowerCase().split('%')[0]
  return normalized === '::1' || normalized.startsWith('::ffff:127.')
}

/** Reject non-global addresses, including metadata, private, link-local, and reserved ranges. */
export function isUnsafePaperEndpointAddress(address: string): boolean {
  const ipv4 = ipv4Number(address)
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
  if (isIP(address) !== 6) return true
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) {
    return isUnsafePaperEndpointAddress(normalized.slice('::ffff:'.length))
  }
  return normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/u.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:')
    || normalized.startsWith('2001:2:')
    || normalized.startsWith('2002:')
}

interface AttemptResult {
  payload?: unknown
  retryStatus?: number
  retryAfter?: string | null
}

interface PreparedTransport {
  url: URL
  headers: Readonly<Record<string, string>>
  timeoutMs: number
  retries: number
  maxResponseBytes: number
  fetchImpl: PaperFetch
  delay: PaperDelay
  resolver: PaperHostResolver
  retryBudget: number
  retryBudgetUsed: number
  metrics: { attemptCount: number; retryCount: number }
  allowInsecureLoopbackForTests: boolean
  signal?: AbortSignal
  onRetry?: (event: PaperHttpRetryEvent) => void
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Error bodies are deliberately not retained. Cancellation is best-effort.
  }
}

async function assertSafeEndpoint(prepared: PreparedTransport, attemptNumber: number): Promise<void> {
  let addresses: readonly string[]
  try {
    addresses = await prepared.resolver(prepared.url.hostname)
  } catch {
    throw new PaperHttpRequestError('network', 'Paper endpoint DNS resolution failed', {
      attempts: attemptNumber,
    })
  }
  if (addresses.length === 0) {
    throw new PaperHttpRequestError('network', 'Paper endpoint DNS resolution failed', {
      attempts: attemptNumber,
    })
  }
  const onlyLoopback = addresses.every(isLoopbackAddress)
  if (prepared.url.protocol !== 'https:') {
    if (!(prepared.allowInsecureLoopbackForTests && onlyLoopback)) {
      throw new PaperHttpRequestError(
        'unsafe_endpoint',
        'Paper endpoint must use HTTPS',
        { attempts: attemptNumber },
      )
    }
    return
  }
  if (addresses.some(isUnsafePaperEndpointAddress)) {
    throw new PaperHttpRequestError(
      'unsafe_endpoint',
      'Paper endpoint resolved to a non-public address',
      { attempts: attemptNumber },
    )
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
            // Preserve the safe typed size error below.
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
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new PaperHttpRequestError(
      'non_json',
      'Paper endpoint returned a non-JSON response',
      { status: response.status, attempts: attemptNumber },
    )
  }
}

async function makeAttempt(
  prepared: PreparedTransport,
  body: unknown,
  attemptNumber: number,
): Promise<AttemptResult> {
  if (prepared.signal?.aborted) {
    throw new PaperHttpRequestError('aborted', 'Paper request aborted', {
      attempts: attemptNumber,
    })
  }
  await assertSafeEndpoint(prepared, attemptNumber)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), prepared.timeoutMs)
  const onOuterAbort = (): void => controller.abort()
  prepared.signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    prepared.metrics.attemptCount += 1
    if (attemptNumber > 1) prepared.metrics.retryCount += 1
    const response = await prepared.fetchImpl(prepared.url.toString(), {
      method: 'POST',
      headers: prepared.headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    })

    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await cancelBody(response)
      throw new PaperHttpRequestError(
        'redirect',
        'Paper endpoint redirect was rejected',
        { status: response.status, attempts: attemptNumber },
      )
    }
    if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
      const retryAfter = response.headers.get('retry-after')
      await cancelBody(response)
      return { retryStatus: response.status, retryAfter }
    }
    if (response.status === 401 || response.status === 403) {
      await cancelBody(response)
      throw new PaperHttpRequestError(
        'auth',
        `Paper endpoint rejected credentials (HTTP ${response.status})`,
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

    return { payload: await readJsonWithLimit(response, prepared.maxResponseBytes, attemptNumber) }
  } catch (error) {
    if (error instanceof PaperHttpRequestError) throw error
    if (prepared.signal?.aborted) {
      throw new PaperHttpRequestError('aborted', 'Paper request aborted', {
        attempts: attemptNumber,
      })
    }
    if (controller.signal.aborted) {
      throw new PaperHttpRequestError(
        'timeout',
        `Paper request timed out after ${prepared.timeoutMs} ms`,
        { attempts: attemptNumber },
      )
    }
    throw new PaperHttpRequestError('network', 'Paper endpoint request failed', {
      attempts: attemptNumber,
    })
  } finally {
    clearTimeout(timer)
    prepared.signal?.removeEventListener('abort', onOuterAbort)
  }
}

async function requestJson(prepared: PreparedTransport, body: unknown): Promise<unknown> {
  let lastError: PaperHttpRequestError | null = null
  for (let attemptIndex = 0; attemptIndex <= prepared.retries; attemptIndex += 1) {
    const attemptNumber = attemptIndex + 1
    try {
      const attempted = await makeAttempt(prepared, body, attemptNumber)
      if (Object.hasOwn(attempted, 'payload')) return attempted.payload

      const status = attempted.retryStatus ?? 500
      lastError = new PaperHttpRequestError(
        'http',
        `Paper endpoint returned HTTP ${status}`,
        { status, attempts: attemptNumber },
      )
      if (attemptIndex >= prepared.retries) throw lastError
      if (prepared.retryBudgetUsed >= prepared.retryBudget) {
        throw new PaperHttpRequestError(
          'retry_budget_exhausted',
          'Paper transport retry budget exhausted',
          { status, attempts: attemptNumber },
        )
      }
      prepared.retryBudgetUsed += 1
      const waitMs = retryDelay(attemptIndex, attempted.retryAfter)
      prepared.onRetry?.({
        attempt: attemptNumber + 1,
        maxRetries: prepared.retries,
        kind: 'http',
        status,
        delayMs: waitMs,
      })
      await prepared.delay(waitMs, prepared.signal)
    } catch (error) {
      const safeError = error instanceof PaperHttpRequestError
        ? error
        : new PaperHttpRequestError('network', 'Paper endpoint request failed', {
            attempts: attemptNumber,
          })
      if (
        (safeError.kind !== 'timeout' && safeError.kind !== 'network')
        || attemptIndex >= prepared.retries
      ) throw safeError
      lastError = safeError
      if (prepared.retryBudgetUsed >= prepared.retryBudget) {
        throw new PaperHttpRequestError(
          'retry_budget_exhausted',
          'Paper transport retry budget exhausted',
          { attempts: attemptNumber },
        )
      }
      prepared.retryBudgetUsed += 1
      const waitMs = retryDelay(attemptIndex)
      prepared.onRetry?.({
        attempt: attemptNumber + 1,
        maxRetries: prepared.retries,
        kind: safeError.kind,
        status: null,
        delayMs: waitMs,
      })
      await prepared.delay(waitMs, prepared.signal)
    }
  }
  throw lastError ?? new PaperHttpRequestError('network', 'Paper endpoint request failed')
}

function prepareTransport(
  options: PaperTransportOptions,
  url: URL,
  headers: Readonly<Record<string, string>>,
): PreparedTransport {
  const timeoutMs = requirePositiveFinite(
    options.timeoutMs ?? BRUCKNER_2026_HTTP_TIMEOUT_MS,
    'timeoutMs',
  )
  const retries = requireRetryCount(options.retries ?? BRUCKNER_2026_HTTP_RETRIES)
  const retryBudget = requireNonNegativeInteger(
    options.retryBudget ?? BRUCKNER_2026_HTTP_RETRY_BUDGET,
    'retryBudget',
  )
  const maxResponseBytes = requireNonNegativeInteger(
    options.maxResponseBytes ?? BRUCKNER_2026_HTTP_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  )
  if (maxResponseBytes === 0) throw new TypeError('maxResponseBytes must be greater than zero')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required')
  return {
    url,
    headers,
    timeoutMs,
    retries,
    maxResponseBytes,
    fetchImpl,
    delay: options.delay ?? defaultDelay,
    // An injected fetch implementation is already a complete transport test
    // seam; avoid resolving its synthetic `.invalid` host unless the test also
    // injects a resolver to exercise DNS policy explicitly.
    resolver: options.resolver
      ?? (options.fetchImpl ? async () => ['93.184.216.34'] : defaultResolver),
    allowInsecureLoopbackForTests: options.allowInsecureLoopbackForTests === true,
    retryBudget,
    retryBudgetUsed: 0,
    metrics: { attemptCount: 0, retryCount: 0 },
    signal: options.signal,
    onRetry: options.onRetry,
  }
}

function ownedHeaders(
  compatibilityHeaders: Readonly<Record<string, string>>,
  protectedNames: ReadonlySet<string>,
  required: Readonly<Record<string, string>>,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(compatibilityHeaders)) {
    if (protectedNames.has(name.trim().toLowerCase())) continue
    headers[name] = value
  }
  return { ...headers, ...required }
}

function attachCredentialRedactor(request: PaperRequestFunction, apiKey: string | undefined): void {
  if (apiKey === undefined || apiKey.length === 0) return
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

function attachTransportMetrics(
  request: PaperRequestFunction,
  prepared: PreparedTransport,
): void {
  Object.defineProperty(request, 'getTransportMetrics', {
    value: () => ({ ...prepared.metrics }),
    enumerable: false,
    configurable: false,
    writable: false,
  })
}

/** Build the one and only Anthropic Messages body accepted by this profile. */
export function buildAnthropicMessagesOpus5Request(
  body: Readonly<PaperDirectRequestBody>,
): AnthropicMessagesOpus5RequestBody {
  if (
    body.temperature !== 1
    || body.max_tokens !== 16
    || body.reasoning?.enabled !== false
    || body.usage?.include !== true
    || body.messages.length !== 2
    || body.messages[0].role !== 'system'
    || body.messages[1].role !== 'user'
  ) {
    throw new TypeError('Anthropic Opus 5 transport requires the strict canonical40 request')
  }
  return {
    model: body.model,
    system: body.messages[0].content,
    messages: [{ role: 'user', content: body.messages[1].content }],
    temperature: 1,
    max_tokens: 16,
    thinking: { type: 'disabled' },
    output_config: { effort: 'high' },
  }
}

function nullableTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function normalizeAnthropicMessagesResponse(payload: unknown): PaperRequestResult {
  if (!isRecord(payload)) {
    throw new PaperHttpRequestError(
      'malformed_response',
      'Anthropic endpoint returned an invalid Messages response',
      { status: 200 },
    )
  }
  if (Object.hasOwn(payload, 'error') && payload.error != null) {
    return { response: { error: { type: 'anthropic_provider_error' } } }
  }
  if (payload.role !== 'assistant' || !Array.isArray(payload.content)) {
    throw new PaperHttpRequestError(
      'malformed_response',
      'Anthropic endpoint returned an invalid Messages response',
      { status: 200 },
    )
  }

  const textParts: string[] = []
  let contaminated = false
  for (const block of payload.content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      contaminated = true
      continue
    }
    if (INTERNAL_XML.test(block.text)) {
      contaminated = true
      continue
    }
    textParts.push(block.text)
  }

  const usage = isRecord(payload.usage) ? payload.usage : {}
  const message: Record<string, unknown> = {
    role: 'assistant',
    // Fail closed: any non-text/internal channel excludes all text from counts.
    content: contaminated ? '' : textParts.join(''),
  }
  if (contaminated) {
    message.reasoning_contamination = 'anthropic_non_text_or_internal_content'
  }

  return {
    response: {
      id: typeof payload.id === 'string' ? payload.id : undefined,
      model: typeof payload.model === 'string' ? payload.model : undefined,
      choices: [{
        message,
        finish_reason: typeof payload.stop_reason === 'string' ? payload.stop_reason : null,
      }],
      usage: {
        prompt_tokens: nullableTokenCount(usage.input_tokens),
        completion_tokens: nullableTokenCount(usage.output_tokens),
        // This zero records the enforced thinking-disabled request policy.
        // Visible thinking/tool channels remain independently excluded above.
        reasoning_tokens: 0,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
  }
}

/** OpenAI-compatible strict paper-profile transport. */
export function createOpenAICompatiblePaperTransport(
  options: OpenAICompatiblePaperTransportOptions,
): PaperRequestFunction {
  const apiKey = options.apiKey?.trim()
  const headers = ownedHeaders(
    options.headers ?? {},
    new Set(['authorization', 'content-type']),
    {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  )
  const prepared = prepareTransport(
    options,
    endpointUrl(options.baseUrl, 'chat/completions'),
    headers,
  )
  const request: PaperRequestFunction = async (body) => ({
    response: await requestJson(prepared, body),
  })
  attachCredentialRedactor(request, apiKey)
  attachTransportMetrics(request, prepared)
  return request
}

/** Anthropic Messages strict Opus 5 paper-profile transport. */
export function createAnthropicMessagesOpus5Transport(
  options: AnthropicMessagesOpus5TransportOptions,
): PaperRequestFunction {
  const apiKey = options.apiKey.trim()
  if (apiKey.length === 0) throw new TypeError('apiKey must be non-empty')
  const headers = ownedHeaders(
    options.headers ?? {},
    new Set(['authorization', 'content-type', 'x-api-key', 'anthropic-version']),
    {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
  )
  const prepared = prepareTransport(options, endpointUrl(options.baseUrl, 'messages'), headers)
  const request: PaperRequestFunction = async (body) => {
    const payload = await requestJson(prepared, buildAnthropicMessagesOpus5Request(body))
    return normalizeAnthropicMessagesResponse(payload)
  }
  attachCredentialRedactor(request, apiKey)
  attachTransportMetrics(request, prepared)
  return request
}
