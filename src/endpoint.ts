/**
 * Endpoint normalization and per-provider reasoning-strategy hints.
 */

import type { Endpoint, ReasoningStrategyId, ResolvedEndpoint } from './types.js'

export interface BaseUrlNormalization {
  ok: boolean
  normalized: string
  reason?: 'empty' | 'invalid'
  /** Non-fatal notes, e.g. plain-http endpoints. */
  warnings: string[]
}

/**
 * Base URL cleanup:
 *  - trim whitespace and trailing slashes; drop an accidentally pasted
 *    `/chat/completions` suffix;
 *  - bare domains (no path) get `/v1` appended;
 *  - plain `http://` is allowed (local vLLM/Ollama/LM Studio) but flagged
 *    with a warning for non-local hosts.
 */
export function normalizeBaseUrl(input: string): BaseUrlNormalization {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return { ok: false, normalized: '', reason: 'empty', warnings: [] }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, normalized: trimmed, reason: 'invalid', warnings: [] }
  }
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, normalized: '', reason: 'invalid', warnings: [] }
  }

  const warnings: string[] = []
  const isLocal =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol === 'http:' && !isLocal) {
    warnings.push(`Plain http:// endpoint (${url.host}): the API key is sent unencrypted.`)
  }

  let path = url.pathname.replace(/\/+$/, '')
  path = path.replace(/\/chat\/completions$/, '')
  if (path === '' || path === '/') path = '/v1'

  return { ok: true, normalized: `${url.protocol}//${url.host}${path}`, warnings }
}

/** Order in which reasoning-disable strategies are probed for a given host. */
const HOST_ADAPTER_HINTS: Array<{ hostIncludes: string; hint: ReasoningStrategyId[] }> = [
  { hostIncludes: 'openrouter.ai', hint: ['openrouter-reasoning', 'openai-effort', 'zhipu-thinking'] },
  { hostIncludes: 'api.openai.com', hint: ['openai-effort', 'openrouter-reasoning', 'zhipu-thinking'] },
  { hostIncludes: 'api.deepseek.com', hint: ['openai-effort', 'zhipu-thinking', 'openrouter-reasoning'] },
  { hostIncludes: 'bigmodel.cn', hint: ['zhipu-thinking', 'openai-effort', 'openrouter-reasoning'] },
]

export const DEFAULT_ADAPTER_HINT: ReasoningStrategyId[] = [
  'openrouter-reasoning',
  'zhipu-thinking',
  'openai-effort',
]

export function guessAdapterHint(baseUrl: string): ReasoningStrategyId[] {
  const lower = baseUrl.toLowerCase()
  for (const { hostIncludes, hint } of HOST_ADAPTER_HINTS) {
    if (lower.includes(hostIncludes)) return hint
  }
  return DEFAULT_ADAPTER_HINT
}

/**
 * Validate and normalize a user-supplied endpoint. Throws on empty/invalid
 * base URL; returns the resolved endpoint plus non-fatal warnings.
 */
export function resolveEndpoint(endpoint: Endpoint): {
  resolved: ResolvedEndpoint
  warnings: string[]
} {
  const { ok, normalized, reason, warnings } = normalizeBaseUrl(endpoint.baseUrl)
  if (!ok) {
    throw new Error(
      reason === 'empty' ? 'Endpoint baseUrl is empty' : 'Invalid endpoint baseUrl',
    )
  }
  if (!endpoint.model || !endpoint.model.trim()) {
    throw new Error('Endpoint model is empty')
  }
  return {
    resolved: {
      baseUrl: normalized,
      model: endpoint.model.trim(),
      apiKey: endpoint.apiKey?.trim() || null,
      headers: endpoint.headers ?? {},
    },
    warnings,
  }
}
