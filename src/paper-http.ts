/**
 * Strict HTTP transports for the opt-in canonical40 paper collector.
 *
 * Both transports use one fixed request shape, reject redirects, retain no
 * unsuccessful response body, and surface only typed credential-free errors.
 */

import { lookup } from 'node:dns/promises'
import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import { Readable } from 'node:stream'

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
  | 'sensitive_credential_echo'
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
  attemptCount: number
  retryCount: number
  retryBudgetUsed: number
}

export interface PaperHttpAttemptEvent {
  /** One-based attempt number within the current logical sample. */
  attempt: number
  /** Exact physical counters after this attempt has started. */
  attemptCount: number
  retryCount: number
  retryBudgetUsed: number
}

export type PaperFetch = typeof fetch
export type PaperDelay = (milliseconds: number, signal?: AbortSignal) => Promise<void>
export type PaperHostResolver = (hostname: string) => Promise<readonly string[]>

interface PaperTransportOptions {
  baseUrl: string
  apiKey?: string
  headers?: Readonly<Record<string, string>>
  timeoutMs?: number
  /** Maximum accepted successful JSON response body. Default: 64 KiB. */
  maxResponseBytes?: number
  /** Retries after the initial attempt. Hard maximum: 2. */
  retries?: number
  /** Aggregate retries shared across all logical jobs. Default: 240. */
  retryBudget?: number
  signal?: AbortSignal
  fetchImpl?: PaperFetch
  delay?: PaperDelay
  /** Injectable unit-test seam for retry jitter. Must return a value in [0, 1). */
  jitterRandom?: () => number
  onRetry?: (event: PaperHttpRetryEvent) => void
  /** Called after a physical attempt is counted and before DNS/network I/O. */
  onAttempt?: (event: PaperHttpAttemptEvent) => void
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

export const BRUCKNER_2026_HTTP_TIMEOUT_MS = 30_000
export const BRUCKNER_2026_HTTP_RETRIES = 2
export const BRUCKNER_2026_HTTP_MAX_RESPONSE_BYTES = 64 * 1024
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

function requireRetryBudget(value: number): number {
  const retryBudget = requireNonNegativeInteger(value, 'retryBudget')
  if (retryBudget > BRUCKNER_2026_HTTP_RETRY_BUDGET) {
    throw new TypeError(`retryBudget must not exceed ${BRUCKNER_2026_HTTP_RETRY_BUDGET}`)
  }
  return retryBudget
}

function requireRequestTimeout(value: number): number {
  const timeoutMs = requirePositiveFinite(value, 'timeoutMs')
  if (timeoutMs > BRUCKNER_2026_HTTP_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must not exceed ${BRUCKNER_2026_HTTP_TIMEOUT_MS}`)
  }
  return timeoutMs
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

function retryDelay(
  attemptIndex: number,
  header: string | null = null,
  random: () => number = Math.random,
): number {
  const base = retryAfterMs(header)
    ?? Math.min(BRUCKNER_2026_HTTP_MAX_RETRY_DELAY_MS, 500 * 2 ** attemptIndex)
  const draw = random()
  const boundedDraw = Number.isFinite(draw) && draw >= 0 && draw < 1 ? draw : 0
  // Positive jitter preserves Retry-After as a floor. Keep both backoff and
  // jitter inside the fixed 60-second cooldown ceiling.
  const jitterWindow = Math.min(250, Math.floor(base * 0.1))
  const jitter = Math.floor(boundedDraw * (jitterWindow + 1))
  return Math.min(BRUCKNER_2026_HTTP_MAX_RETRY_DELAY_MS, base + jitter)
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

function ipv6Number(address: string): bigint | null {
  const unscoped = address.toLowerCase().split('%')[0]
  if (isIP(unscoped) !== 6) return null

  let expanded = unscoped
  const lastColon = expanded.lastIndexOf(':')
  const dottedTail = expanded.slice(lastColon + 1)
  const embeddedIpv4 = ipv4Number(dottedTail)
  if (embeddedIpv4 !== null) {
    expanded = `${expanded.slice(0, lastColon)}:${(embeddedIpv4 >>> 16).toString(16)}:${(embeddedIpv4 & 0xffff).toString(16)}`
  }

  const halves = expanded.split('::')
  if (halves.length > 2) return null
  const left = halves[0].length === 0 ? [] : halves[0].split(':')
  const right = halves.length === 1 || halves[1].length === 0 ? [] : halves[1].split(':')
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null
  }
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right]
  if (groups.length !== 8) return null
  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) return null
    value = (value << 16n) | BigInt(`0x${group}`)
  }
  return value
}

function inIpv6Range(value: bigint, base: string, prefix: number): boolean {
  const baseValue = ipv6Number(base)
  if (baseValue === null) return false
  const bits = 128n
  const prefixBits = BigInt(prefix)
  const mask = prefix === 0 ? 0n : ((1n << prefixBits) - 1n) << (bits - prefixBits)
  return (value & mask) === (baseValue & mask)
}

function ipv4FromMappedIpv6(value: bigint): number | null {
  // ::ffff:0:0/96. Used only for peer equality; endpoint policy rejects it.
  if ((value >> 32n) !== 0xffffn) return null
  return Number(value & 0xffffffffn)
}

function isLoopbackAddress(address: string): boolean {
  const ipv4 = ipv4Number(address)
  if (ipv4 !== null) return inIpv4Range(ipv4, '127.0.0.0', 8)
  const ipv6 = ipv6Number(address)
  if (ipv6 === null) return false
  if (ipv6 === 1n) return true
  const mapped = ipv4FromMappedIpv6(ipv6)
  return mapped !== null && inIpv4Range(mapped, '127.0.0.0', 8)
}

/** Reject non-global addresses, including metadata, private, link-local, and reserved ranges. */
export function isUnsafePaperEndpointAddress(address: string): boolean {
  if (address.includes('%')) return true
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
      ['192.31.196.0', 24],
      ['192.52.193.0', 24],
      ['192.88.99.0', 24],
      ['192.168.0.0', 16],
      ['192.175.48.0', 24],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, prefix]) => inIpv4Range(ipv4, base as string, prefix as number))
  }
  const ipv6 = ipv6Number(address)
  if (ipv6 === null) return true

  // Fail closed: only IPv6 global-unicast space is eligible, then remove the
  // IANA special-purpose sub-ranges that still sit inside 2000::/3. This also
  // rejects IPv4-compatible/mapped, NAT64, discard-only, site-local, ULA,
  // link-local, multicast, and Segment Routing SID address space.
  if (!inIpv6Range(ipv6, '2000::', 3)) return true
  return [
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
  ].some(([base, prefix]) => inIpv6Range(ipv6, base as string, prefix as number))
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
  /** Injected test seam. Production/default requests use the pinned native transport. */
  fetchImpl?: PaperFetch
  delay: PaperDelay
  jitterRandom: () => number
  resolver: PaperHostResolver
  retryBudget: number
  retryBudgetUsed: number
  metrics: { attemptCount: number; retryCount: number }
  allowInsecureLoopbackForTests: boolean
  redactSensitiveText?: PaperSensitiveTextRedactor
  abortController: AbortController
  signal?: AbortSignal
  onRetry?: (event: PaperHttpRetryEvent) => void
  onAttempt?: (event: PaperHttpAttemptEvent) => void
}

interface PinnedEndpoint {
  /** Every address returned by this physical attempt's one DNS lookup. */
  addresses: readonly string[]
  /** The exact validated address bound to this attempt's socket. */
  address: string
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Error bodies are deliberately not retained. Cancellation is best-effort.
  }
}

function containsSensitiveValue(
  value: unknown,
  redactor: PaperSensitiveTextRedactor | undefined,
  seen: Set<object> = new Set(),
): boolean {
  if (redactor === undefined) return false
  if (typeof value === 'string') return redactor(value).matched
  if (typeof value !== 'object' || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveValue(item, redactor, seen))
  }
  return Object.entries(value).some(
    ([key, item]) => redactor(key).matched || containsSensitiveValue(item, redactor, seen),
  )
}

function responseHeadersContainSensitiveValue(
  response: Response,
  redactor: PaperSensitiveTextRedactor | undefined,
): boolean {
  if (redactor === undefined) return false
  let matched = false
  response.headers.forEach((value, name) => {
    if (redactor(name).matched || redactor(value).matched) matched = true
  })
  return matched
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('aborted')
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

function unbracketedHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
}

async function assertSafeEndpoint(
  prepared: PreparedTransport,
  attemptNumber: number,
  signal: AbortSignal,
): Promise<PinnedEndpoint> {
  let addresses: readonly string[]
  try {
    const resolved = await withAbort(
      Promise.resolve(prepared.resolver(unbracketedHostname(prepared.url))),
      signal,
    )
    addresses = [...resolved]
  } catch {
    if (signal.aborted) throw new Error('aborted')
    throw new PaperHttpRequestError('network', 'Paper endpoint DNS resolution failed', {
      attempts: attemptNumber,
    })
  }
  if (
    addresses.length === 0
    || addresses.some((address) => typeof address !== 'string' || isIP(address) === 0)
  ) {
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
    return { addresses, address: addresses[(attemptNumber - 1) % addresses.length] }
  }
  if (addresses.some(isUnsafePaperEndpointAddress)) {
    throw new PaperHttpRequestError(
      'unsafe_endpoint',
      'Paper endpoint resolved to a non-public address',
      { attempts: attemptNumber },
    )
  }
  return { addresses, address: addresses[(attemptNumber - 1) % addresses.length] }
}

function addressesEqual(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false
  const expectedIpv4 = ipv4Number(expected)
  const actualIpv4 = ipv4Number(actual)
  if (expectedIpv4 !== null && actualIpv4 !== null) return expectedIpv4 === actualIpv4
  const expectedIpv6 = ipv6Number(expected)
  const actualIpv6 = ipv6Number(actual)
  if (expectedIpv6 !== null && actualIpv6 !== null) return expectedIpv6 === actualIpv6
  if (expectedIpv4 !== null && actualIpv6 !== null) {
    return ipv4FromMappedIpv6(actualIpv6) === expectedIpv4
  }
  if (expectedIpv6 !== null && actualIpv4 !== null) {
    return ipv4FromMappedIpv6(expectedIpv6) === actualIpv4
  }
  return false
}

function responseFromIncoming(incoming: import('node:http').IncomingMessage): Response {
  const headers = new Headers()
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
  }
  const status = incoming.statusCode ?? 500
  const body = status === 204 || status === 205 || status === 304
    ? null
    : Readable.toWeb(incoming) as ReadableStream<Uint8Array>
  if (body === null) incoming.resume()
  return new Response(body, {
    status,
    statusText: incoming.statusMessage,
    headers,
  })
}

/**
 * Native one-shot HTTP(S) request whose agent lookup can return only the
 * already-validated address. The URL hostname remains unchanged, so TLS SNI
 * and certificate hostname verification still bind to the requested origin.
 * Node's native clients do not consume HTTP(S)_PROXY environment variables.
 */
async function pinnedNativeFetch(
  url: URL,
  init: RequestInit,
  pinned: PinnedEndpoint,
): Promise<Response> {
  const family = isIP(pinned.address)
  if (family !== 4 && family !== 6) throw new Error('invalid pinned address')
  const signal = init.signal
  if (signal?.aborted) throw new Error('aborted')

  const pinnedLookup = ((_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address: pinned.address, family }])
      return
    }
    callback(null, pinned.address, family)
  }) as LookupFunction
  const isTls = url.protocol === 'https:'
  const originHostname = unbracketedHostname(url)
  const agent = isTls
    ? new HttpsAgent({ keepAlive: false, maxCachedSessions: 0, lookup: pinnedLookup })
    : new HttpAgent({ keepAlive: false, lookup: pinnedLookup })
  const requestFn = isTls ? httpsRequest : httpRequest

  return await new Promise<Response>((resolve, reject) => {
    let finished = false
    let sent = false
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      agent.destroy()
    }
    const fail = (): void => {
      if (finished) return
      finished = true
      cleanup()
      reject(new Error('pinned request failed'))
    }
    const request = requestFn({
      protocol: url.protocol,
      hostname: originHostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: init.headers as Readonly<Record<string, string>> | undefined,
      agent,
      lookup: pinnedLookup,
      ...(isTls
        ? {
            ...(isIP(originHostname) === 0 ? { servername: originHostname } : {}),
            rejectUnauthorized: true,
          }
        : {}),
    }, (incoming) => {
      if (finished) {
        incoming.destroy()
        return
      }
      finished = true
      const cleanupAfterBody = (): void => cleanup()
      incoming.once('close', cleanupAfterBody)
      incoming.once('end', cleanupAfterBody)
      resolve(responseFromIncoming(incoming))
    })
    const onAbort = (): void => {
      request.destroy(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    request.once('error', fail)
    request.once('socket', (socket) => {
      const validateAndSend = (): void => {
        if (!addressesEqual(pinned.address, socket.remoteAddress)) {
          request.destroy(new Error('remote peer mismatch'))
          return
        }
        if (sent) return
        sent = true
        const body = typeof init.body === 'string' ? init.body : undefined
        request.end(body)
      }
      if (isTls) {
        if ('encrypted' in socket && !socket.connecting && socket.remoteAddress !== undefined) {
          validateAndSend()
        } else {
          socket.once('secureConnect', validateAndSend)
        }
      } else if (socket.connecting) {
        socket.once('connect', validateAndSend)
      } else {
        validateAndSend()
      }
    })
    if (signal?.aborted) onAbort()
  })
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), prepared.timeoutMs)
  const onOuterAbort = (): void => controller.abort()
  prepared.signal?.addEventListener('abort', onOuterAbort, { once: true })
  if (prepared.signal?.aborted) controller.abort()

  try {
    prepared.metrics.attemptCount += 1
    if (attemptNumber > 1) prepared.metrics.retryCount += 1
    prepared.onAttempt?.({
      attempt: attemptNumber,
      attemptCount: prepared.metrics.attemptCount,
      retryCount: prepared.metrics.retryCount,
      retryBudgetUsed: prepared.retryBudgetUsed,
    })
    // DNS resolution is part of this physical attempt and is bounded by the
    // same timeout/AbortSignal as connect, TLS, headers, and response body.
    const pinned = await assertSafeEndpoint(prepared, attemptNumber, controller.signal)
    const init: RequestInit = {
      method: 'POST',
      headers: prepared.headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    }
    // Injected fetch remains the complete test seam. Real/default traffic is
    // forced through the one-shot socket-pinned native implementation above.
    const response = prepared.fetchImpl === undefined
      ? await pinnedNativeFetch(prepared.url, init, pinned)
      : await prepared.fetchImpl(prepared.url.toString(), init)

    if (responseHeadersContainSensitiveValue(response, prepared.redactSensitiveText)) {
      await cancelBody(response)
      throw new PaperHttpRequestError(
        'sensitive_credential_echo',
        'Paper endpoint echoed credential material',
        { status: response.status, attempts: attemptNumber },
      )
    }

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

    const payload = await readJsonWithLimit(
      response,
      prepared.maxResponseBytes,
      attemptNumber,
    )
    if (containsSensitiveValue(payload, prepared.redactSensitiveText)) {
      throw new PaperHttpRequestError(
        'sensitive_credential_echo',
        'Paper endpoint echoed credential material',
        { status: response.status, attempts: attemptNumber },
      )
    }
    return { payload }
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
      const waitMs = retryDelay(attemptIndex, attempted.retryAfter, prepared.jitterRandom)
      prepared.onRetry?.({
        attempt: attemptNumber + 1,
        maxRetries: prepared.retries,
        kind: 'http',
        status,
        delayMs: waitMs,
        attemptCount: prepared.metrics.attemptCount,
        retryCount: prepared.metrics.retryCount,
        retryBudgetUsed: prepared.retryBudgetUsed,
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
      const waitMs = retryDelay(attemptIndex, null, prepared.jitterRandom)
      prepared.onRetry?.({
        attempt: attemptNumber + 1,
        maxRetries: prepared.retries,
        kind: safeError.kind,
        status: null,
        delayMs: waitMs,
        attemptCount: prepared.metrics.attemptCount,
        retryCount: prepared.metrics.retryCount,
        retryBudgetUsed: prepared.retryBudgetUsed,
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
  redactSensitiveText?: PaperSensitiveTextRedactor,
): PreparedTransport {
  const timeoutMs = requireRequestTimeout(
    options.timeoutMs ?? BRUCKNER_2026_HTTP_TIMEOUT_MS,
  )
  const retries = requireRetryCount(options.retries ?? BRUCKNER_2026_HTTP_RETRIES)
  const retryBudget = requireRetryBudget(
    options.retryBudget ?? BRUCKNER_2026_HTTP_RETRY_BUDGET,
  )
  const maxResponseBytes = requireNonNegativeInteger(
    options.maxResponseBytes ?? BRUCKNER_2026_HTTP_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  )
  if (maxResponseBytes === 0) throw new TypeError('maxResponseBytes must be greater than zero')
  const fetchImpl = options.fetchImpl
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function')
  }
  const abortController = new AbortController()
  if (options.signal?.aborted) {
    abortController.abort()
  } else {
    options.signal?.addEventListener('abort', () => abortController.abort(), { once: true })
  }
  return {
    url,
    headers,
    timeoutMs,
    retries,
    maxResponseBytes,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    delay: options.delay ?? defaultDelay,
    jitterRandom: options.jitterRandom ?? Math.random,
    // An injected fetch implementation is already a complete transport test
    // seam; avoid resolving its synthetic `.invalid` host unless the test also
    // injects a resolver to exercise DNS policy explicitly.
    resolver: options.resolver
      ?? (options.fetchImpl ? async () => ['93.184.216.34'] : defaultResolver),
    allowInsecureLoopbackForTests: options.allowInsecureLoopbackForTests === true,
    redactSensitiveText,
    abortController,
    retryBudget,
    retryBudgetUsed: 0,
    metrics: { attemptCount: 0, retryCount: 0 },
    signal: abortController.signal,
    onRetry: options.onRetry,
    onAttempt: options.onAttempt,
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

function buildCredentialRedactor(
  apiKey: string | undefined,
): PaperSensitiveTextRedactor | undefined {
  if (apiKey === undefined || apiKey.length === 0) return undefined
  const normalizedKey = apiKey.normalize('NFC').toLowerCase()
  const digitMap: Readonly<Record<string, string>> = {
    '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
    '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  }
  const legacyNormalize = (input: string): string =>
    [...input.normalize('NFC').toLowerCase()]
      .filter((character) => /[\p{L}\p{N}\s]/u.test(character))
      .map((character) => digitMap[character] ?? character)
      .join('')
      .replace(/\s+/gu, '')
  const legacyKey = legacyNormalize(apiKey)
  return (value) => {
    if (value.includes(apiKey)) {
      return {
        text: value.split(apiKey).join('[REDACTED_CREDENTIAL_ECHO]'),
        matched: true,
      }
    }
    const normalized = value.normalize('NFC').toLowerCase()
    const variantMatch =
      (normalizedKey.length > 0 && normalized.includes(normalizedKey))
      || (legacyKey.length > 0 && legacyNormalize(value).includes(legacyKey))
    return variantMatch
      ? { text: '[REDACTED_CREDENTIAL_ECHO]', matched: true }
      : { text: value, matched: false }
  }
}

function attachCredentialRedactor(
  request: PaperRequestFunction,
  redactSensitiveText: PaperSensitiveTextRedactor | undefined,
): void {
  if (redactSensitiveText === undefined) return
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
    value: () => ({ ...prepared.metrics, retryBudgetUsed: prepared.retryBudgetUsed }),
    enumerable: false,
    configurable: false,
    writable: false,
  })
}

function attachAbortController(
  request: PaperRequestFunction,
  prepared: PreparedTransport,
): void {
  Object.defineProperty(request, 'abortInFlight', {
    value: () => prepared.abortController.abort(),
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
  if (payload.stop_reason === 'tool_use') contaminated = true

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
  const redactSensitiveText = buildCredentialRedactor(apiKey)
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
    redactSensitiveText,
  )
  const request: PaperRequestFunction = async (body) => ({
    response: await requestJson(prepared, body),
  })
  attachCredentialRedactor(request, redactSensitiveText)
  attachTransportMetrics(request, prepared)
  attachAbortController(request, prepared)
  return request
}

/** Anthropic Messages strict Opus 5 paper-profile transport. */
export function createAnthropicMessagesOpus5Transport(
  options: AnthropicMessagesOpus5TransportOptions,
): PaperRequestFunction {
  const apiKey = options.apiKey.trim()
  if (apiKey.length === 0) throw new TypeError('apiKey must be non-empty')
  const redactSensitiveText = buildCredentialRedactor(apiKey)
  const headers = ownedHeaders(
    options.headers ?? {},
    new Set(['authorization', 'content-type', 'x-api-key', 'anthropic-version']),
    {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
  )
  const prepared = prepareTransport(
    options,
    endpointUrl(options.baseUrl, 'messages'),
    headers,
    redactSensitiveText,
  )
  const request: PaperRequestFunction = async (body) => {
    const payload = await requestJson(prepared, buildAnthropicMessagesOpus5Request(body))
    return normalizeAnthropicMessagesResponse(payload)
  }
  attachCredentialRedactor(request, redactSensitiveText)
  attachTransportMetrics(request, prepared)
  attachAbortController(request, prepared)
  return request
}
