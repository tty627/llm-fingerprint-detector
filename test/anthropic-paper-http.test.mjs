import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_OPUS5_TRANSPORT_PROFILE,
  BRUCKNER_2026_HTTP_MAX_RETRY_DELAY_MS,
  PaperHttpRequestError,
  buildAnthropicMessagesOpus5Request,
  createAnthropicMessagesOpus5Transport,
  isUnsafePaperEndpointAddress,
} from '../dist/paper.js'
import {
  buildBruckner2026DirectRequest,
  collectBruckner2026PaperFingerprint,
  createBruckner2026CollectionJobs,
} from '../dist/paper-collector.js'

const PUBLIC_RESOLVER = async () => ['93.184.216.34']
const BODY = {
  model: 'claude-opus-5',
  messages: [
    { role: 'system', content: 'fixed system' },
    { role: 'user', content: 'fixed user' },
  ],
  temperature: 1,
  max_tokens: 16,
  reasoning: { enabled: false },
  usage: { include: true },
}

function anthropicResponse(content = [{ type: 'text', text: '7' }]) {
  return {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-20260801',
    content,
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 1 },
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}/v1`
}

async function closeServer(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

test('Anthropic Opus 5 body is exact and contains no OpenAI-only or fallback fields', () => {
  const body = buildAnthropicMessagesOpus5Request(BODY)
  assert.deepEqual(body, {
    model: 'claude-opus-5',
    system: 'fixed system',
    messages: [{ role: 'user', content: 'fixed user' }],
    temperature: 1,
    max_tokens: 16,
    thinking: { type: 'disabled' },
    output_config: { effort: 'high' },
  })
  for (const forbidden of ['top_p', 'top_k', 'tools', 'seed', 'stream', 'reasoning', 'usage']) {
    assert.equal(Object.hasOwn(body, forbidden), false)
  }
})

test('strict transport rejects query, fragment, credentials, and non-HTTP URLs before fetch', () => {
  for (const baseUrl of [
    'https://relay.invalid/v1?tenant=secret',
    'https://relay.invalid/v1#fragment',
    'https://user:password@relay.invalid/v1',
    'file:///private/v1',
  ]) {
    assert.throws(
      () => createAnthropicMessagesOpus5Transport({ baseUrl, apiKey: 'safe-key' }),
      (error) => error instanceof TypeError
        && !error.message.includes('tenant=secret')
        && !error.message.includes('user:password'),
    )
  }
})

test('Anthropic transport owns exact URL, headers, body, redirect policy, and response mapping', async () => {
  const secret = 'anthropic-key-only-in-header'
  let observedUrl
  let observedInit
  const request = createAnthropicMessagesOpus5Transport({
    baseUrl: 'https://relay.invalid/v1/',
    apiKey: secret,
    headers: {
      'anthropic-workspace-id': 'wrk_fixture',
      'X-API-Key': 'ignored-caller-key',
      'Anthropic-Version': 'ignored-version',
      Authorization: 'ignored-authorization',
      'content-TYPE': 'text/plain',
    },
    retries: 0,
    resolver: PUBLIC_RESOLVER,
    fetchImpl: async (url, init) => {
      observedUrl = url
      observedInit = init
      return new Response(JSON.stringify(anthropicResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const result = await request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} })
  const sent = JSON.parse(observedInit.body)
  assert.equal(observedUrl, 'https://relay.invalid/v1/messages')
  assert.equal(observedInit.method, 'POST')
  assert.equal(observedInit.redirect, 'error')
  assert.equal(observedInit.headers['x-api-key'], secret)
  assert.equal(observedInit.headers['anthropic-version'], ANTHROPIC_API_VERSION)
  assert.equal(observedInit.headers['Content-Type'], 'application/json')
  assert.equal(observedInit.headers['anthropic-workspace-id'], 'wrk_fixture')
  assert.deepEqual(Object.keys(observedInit.headers).sort(), [
    'Content-Type',
    'anthropic-version',
    'anthropic-workspace-id',
    'x-api-key',
  ])
  assert.deepEqual(sent, buildAnthropicMessagesOpus5Request(BODY))
  assert.equal(observedInit.body.includes(secret), false)
  assert.deepEqual(result, {
    response: {
      id: 'msg_fixture',
      model: 'claude-opus-5-20260801',
      choices: [{
        message: { role: 'assistant', content: '7' },
        finish_reason: 'end_turn',
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 1,
        reasoning_tokens: 0,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
  })
  assert.deepEqual(request.getTransportMetrics(), {
    attemptCount: 1,
    retryCount: 0,
    retryBudgetUsed: 0,
  })
})

test('Anthropic strict transport validates all canonical40 40x30 requests without fallback', async () => {
  const model = 'claude-opus-5-mock'
  const schedulerSeed = 'anthropic-canonical40-1200'
  const mockKey = 'mock-anthropic-key-never-real'
  const expectedBodies = new Map()
  for (const job of createBruckner2026CollectionJobs(30, schedulerSeed)) {
    const direct = buildBruckner2026DirectRequest(model, job)
    const serialized = JSON.stringify(buildAnthropicMessagesOpus5Request(direct))
    expectedBodies.set(serialized, (expectedBodies.get(serialized) ?? 0) + 1)
  }
  const observed = []
  const request = createAnthropicMessagesOpus5Transport({
    baseUrl: 'https://anthropic.mock.invalid/v1',
    apiKey: mockKey,
    headers: {
      'anthropic-workspace-id': 'wrk_mock_1200',
      'X-API-Key': 'caller-key-must-be-ignored',
      'Anthropic-Version': 'caller-version-must-be-ignored',
      Authorization: 'caller-authorization-must-be-ignored',
      'content-TYPE': 'text/plain',
    },
    retries: 0,
    fetchImpl: async (url, init) => {
      observed.push({
        url,
        method: init.method,
        redirect: init.redirect,
        headers: { ...init.headers },
        body: init.body,
      })
      return new Response(JSON.stringify(anthropicResponse([
        { type: 'thinking', thinking: 'mock-internal-trace' },
        { type: 'text', text: '7' },
      ])), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const collected = await collectBruckner2026PaperFingerprint({
    model,
    transportProfileId: ANTHROPIC_MESSAGES_OPUS5_TRANSPORT_PROFILE,
    role: 'audit',
    samplesPerCell: 30,
    schedulerSeed,
    concurrency: 3,
    request,
  })

  assert.equal(observed.length, 1_200)
  for (const item of observed) {
    assert.equal(item.url, 'https://anthropic.mock.invalid/v1/messages')
    assert.equal(item.method, 'POST')
    assert.equal(item.redirect, 'error')
    assert.deepEqual(item.headers, {
      'anthropic-workspace-id': 'wrk_mock_1200',
      'Content-Type': 'application/json',
      'x-api-key': mockKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    })
    assert.equal(typeof item.body, 'string')
    const remaining = expectedBodies.get(item.body) ?? 0
    assert.ok(remaining > 0, 'every wire body must be one exact frozen canonical40 request')
    expectedBodies.set(item.body, remaining - 1)
    const body = JSON.parse(item.body)
    assert.deepEqual(Object.keys(body), [
      'model',
      'system',
      'messages',
      'temperature',
      'max_tokens',
      'thinking',
      'output_config',
    ])
    for (const forbidden of [
      'top_p',
      'top_k',
      'tools',
      'seed',
      'stream',
      'reasoning',
      'usage',
    ]) {
      assert.equal(Object.hasOwn(body, forbidden), false)
    }
  }
  assert.ok([...expectedBodies.values()].every((remaining) => remaining === 0))
  assert.deepEqual(request.getTransportMetrics(), {
    attemptCount: 1_200,
    retryCount: 0,
    retryBudgetUsed: 0,
  })
  assert.equal(collected.fingerprint.quality.complete, true)
  assert.equal(collected.fingerprint.quality.attemptCount, 1_200)
  assert.equal(collected.fingerprint.quality.retryCount, 0)
  assert.equal(collected.fingerprint.quality.reasoningTraceCount, 1_200)
  assert.equal(collected.fingerprint.quality.directness, 'violated')
})

test('thinking, tool, and internal XML channels never enter the answer or retained evidence', async () => {
  const secret = 'anthropic-visible-secret-must-not-persist'
  const internalTrace = 'provider-internal-trace-must-not-persist'
  const fixtures = [
    [{ type: 'thinking', thinking: internalTrace }, { type: 'text', text: '7' }],
    [{ type: 'tool_use', id: 'tool', name: 'unsafe', input: { internalTrace } }, { type: 'text', text: '7' }],
    [{ type: 'text', text: `<thinking>${internalTrace}</thinking>7` }],
  ]

  for (const content of fixtures) {
    const request = createAnthropicMessagesOpus5Transport({
      baseUrl: 'https://relay.invalid/v1',
      apiKey: secret,
      retries: 0,
      resolver: PUBLIC_RESOLVER,
      fetchImpl: async () => new Response(JSON.stringify(anthropicResponse(content)), { status: 200 }),
    })
    const result = await request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} })
    assert.equal(result.response.choices[0].message.content, '')
    assert.equal(
      result.response.choices[0].message.reasoning_contamination,
      'anthropic_non_text_or_internal_content',
    )
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(JSON.stringify(result).includes(internalTrace), false)
  }

  const request = createAnthropicMessagesOpus5Transport({
    baseUrl: 'https://relay.invalid/v1',
    apiKey: secret,
    retries: 0,
    resolver: PUBLIC_RESOLVER,
    fetchImpl: async () => new Response(JSON.stringify(anthropicResponse([
      { type: 'thinking', thinking: internalTrace },
      { type: 'text', text: '7' },
    ])), { status: 200 }),
  })
  const collected = await collectBruckner2026PaperFingerprint({
    model: 'claude-opus-5',
    transportProfileId: ANTHROPIC_MESSAGES_OPUS5_TRANSPORT_PROFILE,
    role: 'audit',
    samplesPerCell: 1,
    schedulerSeed: 'anthropic-contamination',
    concurrency: 4,
    request,
  })
  assert.equal(collected.fingerprint.quality.invalidSamples, 40)
  assert.equal(collected.fingerprint.quality.reasoningTraceCount, 40)
  assert.equal(collected.fingerprint.quality.directness, 'violated')
  assert.equal(collected.fingerprint.quality.attemptCount, 40)
  assert.equal(collected.fingerprint.quality.retryCount, 0)
  assert.equal(collected.rawEvidenceJsonl.includes(secret), false)
})

test('retry set is exact, Retry-After is capped, auth is not retried, and budget is global', async () => {
  let calls = 0
  const delays = []
  const retrying = createAnthropicMessagesOpus5Transport({
    baseUrl: 'https://relay.invalid/v1',
    apiKey: 'safe-key',
    retries: 1,
    resolver: PUBLIC_RESOLVER,
    delay: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      calls += 1
      return calls === 1
        ? new Response('discarded', { status: 429, headers: { 'retry-after': '3600' } })
        : new Response(JSON.stringify(anthropicResponse()), { status: 200 })
    },
  })
  await retrying(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [BRUCKNER_2026_HTTP_MAX_RETRY_DELAY_MS])

  for (const status of [401, 403, 400, 501, 505]) {
    let attempts = 0
    const request = createAnthropicMessagesOpus5Transport({
      baseUrl: 'https://relay.invalid/v1',
      apiKey: 'safe-key',
      retries: 2,
      resolver: PUBLIC_RESOLVER,
      delay: async () => {},
      fetchImpl: async () => {
        attempts += 1
        return new Response('discarded-secret-body', { status })
      },
    })
    await assert.rejects(request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }))
    assert.equal(attempts, 1, `HTTP ${status} must not retry`)
  }

  let budgetCalls = 0
  const budgeted = createAnthropicMessagesOpus5Transport({
    baseUrl: 'https://relay.invalid/v1',
    apiKey: 'safe-key',
    retries: 2,
    retryBudget: 1,
    resolver: PUBLIC_RESOLVER,
    delay: async () => {},
    fetchImpl: async () => {
      budgetCalls += 1
      return new Response('discarded', { status: 503 })
    },
  })
  await assert.rejects(
    budgeted(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
    (error) => error instanceof PaperHttpRequestError
      && error.kind === 'retry_budget_exhausted'
      && !error.message.includes('discarded'),
  )
  assert.equal(budgetCalls, 2)
  assert.deepEqual(budgeted.getTransportMetrics(), {
    attemptCount: 2,
    retryCount: 1,
    retryBudgetUsed: 1,
  })
})

test('artifact quality records physical attempts and retries from the shared transport', async () => {
  let calls = 0
  const request = createAnthropicMessagesOpus5Transport({
    baseUrl: 'https://relay.invalid/v1',
    apiKey: 'safe-key',
    retries: 1,
    retryBudget: 4,
    resolver: PUBLIC_RESOLVER,
    delay: async () => {},
    fetchImpl: async () => {
      calls += 1
      return calls === 1
        ? new Response('discarded', { status: 503 })
        : new Response(JSON.stringify(anthropicResponse()), { status: 200 })
    },
  })
  const collected = await collectBruckner2026PaperFingerprint({
    model: 'claude-opus-5',
    transportProfileId: ANTHROPIC_MESSAGES_OPUS5_TRANSPORT_PROFILE,
    role: 'audit',
    samplesPerCell: 1,
    schedulerSeed: 'anthropic-retry-metrics',
    concurrency: 1,
    request,
  })
  assert.equal(calls, 41)
  assert.equal(collected.fingerprint.quality.attemptCount, 41)
  assert.equal(collected.fingerprint.quality.retryCount, 1)
})

test('DNS is checked on every attempt and a public-to-private rebind stops before fetch', async () => {
  let resolverCalls = 0
  let fetchCalls = 0
  const request = createAnthropicMessagesOpus5Transport({
    baseUrl: 'https://relay.invalid/v1',
    apiKey: 'safe-key',
    retries: 1,
    delay: async () => {},
    resolver: async () => {
      resolverCalls += 1
      return resolverCalls === 1 ? ['93.184.216.34'] : ['169.254.169.254']
    },
    fetchImpl: async () => {
      fetchCalls += 1
      return new Response('retry', { status: 503 })
    },
  })
  await assert.rejects(
    request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
    (error) => error instanceof PaperHttpRequestError && error.kind === 'unsafe_endpoint',
  )
  assert.equal(resolverCalls, 2)
  assert.equal(fetchCalls, 1)
  assert.deepEqual(request.getTransportMetrics(), {
    attemptCount: 2,
    retryCount: 1,
    retryBudgetUsed: 1,
  })

  const insecure = createAnthropicMessagesOpus5Transport({
    baseUrl: 'http://127.0.0.1/v1',
    apiKey: 'safe-key',
    retries: 0,
    resolver: async () => ['127.0.0.1'],
    fetchImpl: async () => { throw new Error('must not fetch') },
  })
  await assert.rejects(
    insecure(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
    (error) => error instanceof PaperHttpRequestError && error.kind === 'unsafe_endpoint',
  )
})

test('IPv6 endpoint policy accepts only public global-unicast and rejects special-purpose ranges', () => {
  for (const address of [
    '100::1',
    '2001:10::1',
    '2001:1f::1',
    '64:ff9b:1::c0a8:101',
    '64:ff9b::a00:1',
    '5f00::1',
    'fec0::1',
    '::192.168.1.1',
    '::ffff:192.168.1.1',
    '2001:db8::1',
    '2002:5db8:d822::1',
    '3fff::1',
    '2606:4700:4700::1111%lo0',
  ]) {
    assert.equal(isUnsafePaperEndpointAddress(address), true, address)
  }
  for (const address of [
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
  ]) {
    assert.equal(isUnsafePaperEndpointAddress(address), false, address)
  }
})

test('direct IPv6 URL is resolved without URL brackets before the injected fetch seam', async () => {
  let resolvedHostname = ''
  const request = createAnthropicMessagesOpus5Transport({
    baseUrl: 'https://[2606:4700:4700::1111]/v1',
    apiKey: 'safe-key',
    retries: 0,
    resolver: async (hostname) => {
      resolvedHostname = hostname
      return ['2606:4700:4700::1111']
    },
    fetchImpl: async () => new Response(JSON.stringify(anthropicResponse()), { status: 200 }),
  })
  await request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} })
  assert.equal(resolvedHostname, '2606:4700:4700::1111')
})

test('default transport binds the one validated DNS answer to the socket and ignores a malicious second answer', async () => {
  let resolverCalls = 0
  let serverCalls = 0
  let observedHost = ''
  const server = createServer((request, response) => {
    serverCalls += 1
    observedHost = request.headers.host ?? ''
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(anthropicResponse()))
  })
  const loopbackBase = await listen(server)
  const port = new URL(loopbackBase).port
  const previousProxy = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    NO_PROXY: process.env.NO_PROXY,
  }
  process.env.HTTP_PROXY = 'http://127.0.0.1:1'
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
  process.env.ALL_PROXY = 'http://127.0.0.1:1'
  process.env.NO_PROXY = ''

  try {
    const request = createAnthropicMessagesOpus5Transport({
      baseUrl: `http://rebind.invalid:${port}/v1`,
      apiKey: 'pinned-transport-key',
      retries: 0,
      timeoutMs: 2_000,
      allowInsecureLoopbackForTests: true,
      resolver: async () => {
        resolverCalls += 1
        // A vulnerable check-then-fetch implementation would resolve again and
        // receive the metadata address. The pinned transport resolves once.
        return resolverCalls === 1 ? ['127.0.0.1'] : ['169.254.169.254']
      },
    })
    const result = await request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} })
    assert.equal(result.response.choices[0].message.content, '7')
    assert.equal(resolverCalls, 1)
    assert.equal(serverCalls, 1)
    assert.equal(observedHost, `rebind.invalid:${port}`)
  } finally {
    for (const [name, value] of Object.entries(previousProxy)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await closeServer(server)
  }
})

test('DNS resolution itself obeys request timeout and AbortSignal', async () => {
  let fetchCalls = 0
  const timeoutRequest = createAnthropicMessagesOpus5Transport({
    baseUrl: 'https://dns-timeout.invalid/v1',
    apiKey: 'safe-key',
    retries: 0,
    timeoutMs: 5,
    resolver: async () => await new Promise(() => {}),
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('must not fetch')
    },
  })
  await assert.rejects(
    timeoutRequest(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
    (error) => error instanceof PaperHttpRequestError && error.kind === 'timeout',
  )
  assert.deepEqual(timeoutRequest.getTransportMetrics(), {
    attemptCount: 1,
    retryCount: 0,
    retryBudgetUsed: 0,
  })

  const controller = new AbortController()
  const abortRequest = createAnthropicMessagesOpus5Transport({
    baseUrl: 'https://dns-abort.invalid/v1',
    apiKey: 'safe-key',
    retries: 0,
    timeoutMs: 2_000,
    signal: controller.signal,
    resolver: async () => await new Promise(() => {}),
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('must not fetch')
    },
  })
  const pending = abortRequest(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} })
  controller.abort()
  await assert.rejects(
    pending,
    (error) => error instanceof PaperHttpRequestError && error.kind === 'aborted',
  )
  assert.equal(fetchCalls, 0)
})

test('real 307 redirect is never followed and never forwards the Anthropic key', async () => {
  const secret = 'redirect-key-must-not-be-forwarded'
  let destinationCalls = 0
  const destination = createServer((request, response) => {
    destinationCalls += 1
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(anthropicResponse()))
  })
  const destinationBase = await listen(destination)
  const source = createServer((request, response) => {
    request.resume()
    response.writeHead(307, { location: `${destinationBase}/messages` })
    response.end('redirect-body-secret')
  })
  const sourceBase = await listen(source)

  try {
    const request = createAnthropicMessagesOpus5Transport({
      baseUrl: sourceBase,
      apiKey: secret,
      retries: 0,
      allowInsecureLoopbackForTests: true,
    })
    await assert.rejects(
      request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
      (error) => {
        assert.ok(error instanceof PaperHttpRequestError)
        assert.ok(error.kind === 'network' || error.kind === 'redirect')
        assert.equal(JSON.stringify(error).includes(secret), false)
        assert.equal(error.message.includes('redirect-body-secret'), false)
        return true
      },
    )
    assert.equal(destinationCalls, 0)
  } finally {
    await closeServer(source)
    await closeServer(destination)
  }
})

test('malformed and HTTP errors are typed and disclose no key, URL, or response body', async () => {
  const secret = 'malformed-key-must-not-leak'
  const responseSecret = 'provider-private-details'
  for (const response of [
    new Response(JSON.stringify([responseSecret, secret]), { status: 200 }),
    new Response(`${responseSecret}-${secret}`, { status: 400 }),
  ]) {
    const request = createAnthropicMessagesOpus5Transport({
      baseUrl: 'https://sensitive-host.invalid/private/v1',
      apiKey: secret,
      retries: 0,
      resolver: PUBLIC_RESOLVER,
      fetchImpl: async () => response,
    })
    await assert.rejects(
      request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
      (error) => {
        assert.ok(error instanceof PaperHttpRequestError)
        const serialized = JSON.stringify(error)
        for (const forbidden of [secret, responseSecret, 'sensitive-host', 'private/v1']) {
          assert.equal(error.message.includes(forbidden), false)
          assert.equal(serialized.includes(forbidden), false)
        }
        return true
      },
    )
  }
})
