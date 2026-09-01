import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BRUCKNER_2026_HTTP_RETRIES,
  BRUCKNER_2026_HTTP_MAX_RESPONSE_BYTES,
  BRUCKNER_2026_HTTP_TIMEOUT_MS,
  PaperHttpRequestError,
  createOpenAICompatiblePaperTransport,
} from '../dist/paper.js'
import {
  buildBruckner2026DirectRequest,
  collectBruckner2026PaperFingerprint,
  createBruckner2026CollectionJobs,
} from '../dist/paper-collector.js'
import * as rootApi from '../dist/index.js'

const BODY = {
  model: 'paper-model',
  messages: [
    { role: 'system', content: 'fixed system' },
    { role: 'user', content: 'fixed user' },
  ],
  temperature: 1,
  max_tokens: 16,
  reasoning: { enabled: false },
  usage: { include: true },
}

test('paper HTTP defaults pin timeout and the two-retry safety bound', () => {
  assert.equal(BRUCKNER_2026_HTTP_TIMEOUT_MS, 30_000)
  assert.equal(BRUCKNER_2026_HTTP_RETRIES, 2)
  assert.equal(BRUCKNER_2026_HTTP_MAX_RESPONSE_BYTES, 64 * 1024)
  assert.throws(
    () => createOpenAICompatiblePaperTransport({
      baseUrl: 'https://paper.invalid/v1',
      timeoutMs: 30_001,
      fetchImpl: async () => { throw new Error('must not fetch') },
    }),
    /timeoutMs must not exceed 30000/,
  )
})

test('paper HTTP retry budget is hard-capped and exponential retries include bounded jitter', async () => {
  assert.throws(
    () => createOpenAICompatiblePaperTransport({
      baseUrl: 'https://paper.invalid/v1',
      retryBudget: 241,
      fetchImpl: async () => { throw new Error('must not fetch') },
    }),
    /retryBudget must not exceed 240/,
  )

  const delays = []
  let calls = 0
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://paper.invalid/v1',
    retries: 1,
    retryBudget: 1,
    jitterRandom: () => 0.5,
    delay: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) throw new Error('unreachable fixture')
      return new Response(JSON.stringify({ choices: [{ message: { content: '7' } }] }), {
        status: 200,
      })
    },
  })
  await request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} })
  assert.deepEqual(delays, [525])
})

test('paper HTTP transport sends the collector body unchanged and key only as Authorization', async () => {
  const secret = 'paper-secret-must-stay-in-header'
  let observedUrl
  let observedInit
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://paper.invalid/v1/',
    apiKey: secret,
    headers: {
      'X-Tenant': 'paper-fixture',
      authorization: 'Bearer caller-controlled-value-must-be-ignored',
      'content-TYPE': 'text/plain',
    },
    retries: 0,
    fetchImpl: async (url, init) => {
      observedUrl = url
      observedInit = init
      return new Response(
        JSON.stringify({
          id: 'generation-id',
          model: 'reported-model',
          choices: [{ message: { role: 'assistant', content: '7' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  const result = await request(BODY, {
    role: 'audit',
    schedulerSeed: 'safe-public-seed',
    job: {},
  })

  assert.equal(observedUrl, 'https://paper.invalid/v1/chat/completions')
  assert.equal(observedInit.redirect, 'error')
  assert.deepEqual(JSON.parse(observedInit.body), BODY)
  assert.deepEqual(Object.keys(JSON.parse(observedInit.body)), [
    'model',
    'messages',
    'temperature',
    'max_tokens',
    'reasoning',
    'usage',
  ])
  assert.equal(observedInit.headers.Authorization, `Bearer ${secret}`)
  assert.equal(observedInit.headers['Content-Type'], 'application/json')
  assert.equal(observedInit.headers['X-Tenant'], 'paper-fixture')
  assert.equal('authorization' in observedInit.headers, false)
  assert.equal('content-TYPE' in observedInit.headers, false)
  assert.deepEqual(Object.keys(observedInit.headers).sort(), [
    'Authorization',
    'Content-Type',
    'X-Tenant',
  ])
  assert.equal(observedInit.body.includes(secret), false)
  assert.equal('stream' in JSON.parse(observedInit.body), false)
  assert.equal('top_p' in JSON.parse(observedInit.body), false)
  assert.equal('seed' in JSON.parse(observedInit.body), false)
  assert.deepEqual(result, {
    response: {
      id: 'generation-id',
      model: 'reported-model',
      choices: [{ message: { role: 'assistant', content: '7' } }],
    },
  })
})

test('OpenAI strict transport validates all canonical40 40x30 requests without fallback', async () => {
  const model = 'openai-mock-model'
  const schedulerSeed = 'openai-canonical40-1200'
  const mockKey = 'mock-openai-key-never-real'
  const expectedBodies = new Map()
  for (const job of createBruckner2026CollectionJobs(30, schedulerSeed)) {
    const serialized = JSON.stringify(buildBruckner2026DirectRequest(model, job))
    expectedBodies.set(serialized, (expectedBodies.get(serialized) ?? 0) + 1)
  }
  const observed = []
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://openai.mock.invalid/v1',
    apiKey: mockKey,
    headers: {
      'X-Mock-Tenant': 'strict-1200',
      authorization: 'Bearer caller-value-must-be-ignored',
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
      return new Response(JSON.stringify({
        id: `mock-${observed.length}`,
        model: 'openai-mock-reported',
        choices: [{
          message: { role: 'assistant', content: '7', reasoning: 'mock-internal-trace' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 1,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const collected = await collectBruckner2026PaperFingerprint({
    model,
    transportProfileId: 'openai-chat-onetoken-v1',
    role: 'audit',
    samplesPerCell: 30,
    schedulerSeed,
    concurrency: 3,
    request,
  })

  assert.equal(observed.length, 1_200)
  for (const item of observed) {
    assert.equal(item.url, 'https://openai.mock.invalid/v1/chat/completions')
    assert.equal(item.method, 'POST')
    assert.equal(item.redirect, 'error')
    assert.deepEqual(item.headers, {
      'X-Mock-Tenant': 'strict-1200',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${mockKey}`,
    })
    assert.equal(typeof item.body, 'string')
    const remaining = expectedBodies.get(item.body) ?? 0
    assert.ok(remaining > 0, 'every wire body must be one exact frozen canonical40 request')
    expectedBodies.set(item.body, remaining - 1)
    const body = JSON.parse(item.body)
    assert.deepEqual(Object.keys(body), [
      'model',
      'messages',
      'temperature',
      'max_tokens',
      'reasoning',
      'usage',
    ])
    for (const forbidden of ['top_p', 'top_k', 'tools', 'seed', 'stream']) {
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

test('paper HTTP transport retries 429/5xx through injectable delay', async () => {
  let calls = 0
  const delays = []
  const retryEvents = []
  const attemptEvents = []
  const bodies = []
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://paper.invalid/v1',
    retries: 1,
    delay: async (milliseconds) => delays.push(milliseconds),
    onRetry: (event) => retryEvents.push(event),
    onAttempt: (event) => attemptEvents.push(event),
    fetchImpl: async (_url, init) => {
      calls += 1
      bodies.push(JSON.parse(init.body))
      if (calls === 1) {
        return new Response('provider-secret-error-body', {
          status: 503,
          headers: { 'retry-after': '0.001' },
        })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'blue' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const result = await request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [1])
  assert.deepEqual(retryEvents, [
    {
      attempt: 2,
      maxRetries: 1,
      kind: 'http',
      status: 503,
      delayMs: 1,
      attemptCount: 1,
      retryCount: 0,
      retryBudgetUsed: 1,
    },
  ])
  assert.deepEqual(attemptEvents, [
    { attempt: 1, attemptCount: 1, retryCount: 0, retryBudgetUsed: 0 },
    { attempt: 2, attemptCount: 2, retryCount: 1, retryBudgetUsed: 1 },
  ])
  assert.deepEqual(bodies, [BODY, BODY])
  assert.equal(result.response.choices[0].message.content, 'blue')
})

test('concurrent requests share the retry budget without oversubscription and emit monotonic counters', async () => {
  const initialResolvers = []
  const events = []
  let fetchCalls = 0
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://paper.invalid/v1',
    retries: 1,
    retryBudget: 2,
    delay: async () => {},
    onAttempt: (event) => events.push({ type: 'attempt', ...event }),
    onRetry: (event) => events.push({ type: 'retry', ...event }),
    fetchImpl: async () => {
      fetchCalls += 1
      if (fetchCalls <= 4) {
        return await new Promise((resolve) => initialResolvers.push(resolve))
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '7' } }] }), {
        status: 200,
      })
    },
  })

  const pending = Array.from(
    { length: 4 },
    () => request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
  )
  while (initialResolvers.length < 4) await new Promise((resolve) => setImmediate(resolve))
  for (const resolve of initialResolvers) resolve(new Response(null, { status: 503 }))
  const settled = await Promise.allSettled(pending)

  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 2)
  const rejected = settled.filter((result) => result.status === 'rejected')
  assert.equal(rejected.length, 2)
  assert.ok(rejected.every(
    (result) => result.reason instanceof PaperHttpRequestError
      && result.reason.kind === 'retry_budget_exhausted',
  ))
  assert.equal(fetchCalls, 6)
  assert.deepEqual(request.getTransportMetrics(), {
    attemptCount: 6,
    retryCount: 2,
    retryBudgetUsed: 2,
  })
  assert.equal(events.filter((event) => event.type === 'retry').length, 2)
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].attemptCount >= events[index - 1].attemptCount)
    assert.ok(events[index].retryCount >= events[index - 1].retryCount)
    assert.ok(events[index].retryBudgetUsed >= events[index - 1].retryBudgetUsed)
  }
})

test('cancelling during retry cooldown consumes the reservation without inventing a physical retry', async () => {
  const controller = new AbortController()
  const events = []
  let fetchCalls = 0
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://paper.invalid/v1',
    retries: 1,
    retryBudget: 1,
    signal: controller.signal,
    onAttempt: (event) => events.push({ type: 'attempt', ...event }),
    onRetry: (event) => {
      events.push({ type: 'retry', ...event })
      controller.abort()
    },
    fetchImpl: async () => {
      fetchCalls += 1
      return new Response(null, { status: 429, headers: { 'retry-after': '60' } })
    },
  })

  await assert.rejects(
    request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
    (error) => error instanceof PaperHttpRequestError && error.kind === 'aborted',
  )
  assert.equal(fetchCalls, 1)
  assert.deepEqual(events, [
    {
      type: 'attempt',
      attempt: 1,
      attemptCount: 1,
      retryCount: 0,
      retryBudgetUsed: 0,
    },
    {
      type: 'retry',
      attempt: 2,
      maxRetries: 1,
      kind: 'http',
      status: 429,
      delayMs: 60_000,
      attemptCount: 1,
      retryCount: 0,
      retryBudgetUsed: 1,
    },
  ])
  assert.deepEqual(request.getTransportMetrics(), {
    attemptCount: 1,
    retryCount: 0,
    retryBudgetUsed: 1,
  })
})

test('paper HTTP transport cancels non-success bodies before returning a safe error', async () => {
  let cancellations = 0
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://paper.invalid/v1',
    retries: 0,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('unretained-error-body'))
      },
      cancel() {
        cancellations += 1
      },
    }), { status: 503 }),
  })
  await assert.rejects(
    request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
    (error) => error instanceof PaperHttpRequestError && error.status === 503,
  )
  assert.equal(cancellations, 1)
})

test('paper HTTP transport rejects oversized successful JSON without retaining its body', async () => {
  const secretBody = `oversized-${'x'.repeat(256)}`
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://paper.invalid/v1',
    retries: 0,
    maxResponseBytes: 64,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: secretBody } }],
    }), { status: 200 }),
  })
  await assert.rejects(
    request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
    (error) => (
      error instanceof PaperHttpRequestError
      && error.kind === 'response_too_large'
      && !error.message.includes(secretBody)
    ),
  )
})

test('paper HTTP default network retry bound is three physical attempts per job', async () => {
  let calls = 0
  let delays = 0
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://paper.invalid/v1',
    delay: async () => {
      delays += 1
    },
    fetchImpl: async () => {
      calls += 1
      throw new Error('unreachable fixture')
    },
  })

  await assert.rejects(
    request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
    (error) =>
      error instanceof PaperHttpRequestError
      && error.kind === 'network'
      && error.attempts === 3,
  )
  assert.equal(calls, 3)
  assert.equal(delays, 2)
})

test('paper HTTP errors never disclose response bodies, credentials, or endpoint URLs', async () => {
  const secret = 'super-secret-paper-key'
  const responseSecret = 'private-provider-error-details'
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://sensitive-hostname.invalid/private/v1',
    apiKey: secret,
    retries: 0,
    fetchImpl: async () => new Response(responseSecret, { status: 400 }),
  })

  await assert.rejects(
    request(BODY, { role: 'enrollment', schedulerSeed: 'seed', job: {} }),
    (error) => {
      assert.ok(error instanceof PaperHttpRequestError)
      assert.equal(error.kind, 'http')
      assert.equal(error.status, 400)
      assert.equal(error.message, 'Paper endpoint returned HTTP 400')
      const serialized = JSON.stringify(error)
      for (const forbidden of [secret, responseSecret, 'sensitive-hostname', 'private/v1']) {
        assert.equal(error.message.includes(forbidden), false)
        assert.equal(serialized.includes(forbidden), false)
      }
      return true
    },
  )
})

test('paper HTTP non-JSON and timeout errors are safe and typed', async () => {
  const nonJson = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://paper.invalid/v1',
    retries: 0,
    fetchImpl: async () => new Response('secret-not-json', { status: 200 }),
  })
  await assert.rejects(
    nonJson(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
    (error) =>
      error instanceof PaperHttpRequestError
      && error.kind === 'non_json'
      && error.message === 'Paper endpoint returned a non-JSON response'
      && !error.message.includes('secret-not-json'),
  )

  const timeout = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://paper.invalid/v1',
    timeoutMs: 5,
    retries: 0,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('unsafe internal error')), {
          once: true,
        })
      }),
  })
  await assert.rejects(
    timeout(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
    (error) =>
      error instanceof PaperHttpRequestError
      && error.kind === 'timeout'
      && error.message === 'Paper request timed out after 5 ms'
      && !error.message.includes('unsafe internal error'),
  )
})

test('paper HTTP transport honors an outer AbortSignal before network access', async () => {
  const controller = new AbortController()
  controller.abort()
  let fetchCalls = 0
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://paper.invalid/v1',
    signal: controller.signal,
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('must not run')
    },
  })

  await assert.rejects(
    request(BODY, { role: 'audit', schedulerSeed: 'seed', job: {} }),
    (error) => error instanceof PaperHttpRequestError && error.kind === 'aborted',
  )
  assert.equal(fetchCalls, 0)
})

test('paper collector remains absent from the package root entrypoint', () => {
  assert.equal('collectBruckner2026PaperFingerprint' in rootApi, false)
  assert.equal('createOpenAICompatiblePaperTransport' in rootApi, false)
})
