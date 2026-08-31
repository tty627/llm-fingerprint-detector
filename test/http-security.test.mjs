import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchChatCompletion, ProbeRequestError } from '../dist/http.js'
import { resolveEndpoint } from '../dist/endpoint.js'

function requestOptions(overrides = {}) {
  return {
    endpoint: {
      baseUrl: 'https://relay.invalid/v1',
      model: 'model-id',
      apiKey: 'legacy-key-must-stay-safe',
      headers: {},
    },
    systemPrompt: 'system',
    userPrompt: 'user',
    temperature: 1,
    maxTokens: 16,
    extraBody: { reasoning: { enabled: false } },
    retries: 0,
    resolver: async () => ['93.184.216.34'],
    ...overrides,
  }
}

test('legacy endpoint normalization rejects userinfo, query, and fragment without echoing URL', () => {
  for (const baseUrl of [
    'https://user:secret@relay.invalid/v1',
    'https://relay.invalid/v1?key=secret',
    'https://relay.invalid/v1#secret',
  ]) {
    assert.throws(
      () => resolveEndpoint({ baseUrl, model: 'model' }),
      (error) => error.message === 'Invalid endpoint baseUrl'
        && !error.message.includes('secret')
        && !error.message.includes('relay.invalid'),
    )
  }
})

test('legacy transport rejects redirects and never includes response body or URL in errors', async () => {
  let observedInit
  const responseSecret = 'private-upstream-error-body'
  await assert.rejects(
    fetchChatCompletion(requestOptions({
      fetchImpl: async (_url, init) => {
        observedInit = init
        return new Response(responseSecret, { status: 307, headers: { location: 'https://other.invalid' } })
      },
    })),
    (error) => {
      assert.ok(error instanceof ProbeRequestError)
      assert.equal(error.kind, 'redirect')
      assert.equal(error.message, 'Endpoint redirect was rejected')
      assert.equal(error.message.includes(responseSecret), false)
      assert.equal(error.message.includes('relay.invalid'), false)
      return true
    },
  )
  assert.equal(observedInit.redirect, 'error')

  await assert.rejects(
    fetchChatCompletion(requestOptions({
      fetchImpl: async () => new Response(responseSecret, { status: 400 }),
    })),
    (error) => error instanceof ProbeRequestError
      && error.message === 'HTTP 400'
      && !error.message.includes(responseSecret),
  )
})

test('legacy transport revalidates DNS before every physical retry and blocks rebinding', async () => {
  let resolverCalls = 0
  let fetchCalls = 0
  await assert.rejects(
    fetchChatCompletion(requestOptions({
      retries: 1,
      resolver: async () => {
        resolverCalls += 1
        return resolverCalls === 1 ? ['93.184.216.34'] : ['10.0.0.7']
      },
      fetchImpl: async () => {
        fetchCalls += 1
        return new Response('discarded', { status: 503, headers: { 'retry-after': '0' } })
      },
    })),
    (error) => error instanceof ProbeRequestError && error.kind === 'unsafe_endpoint',
  )
  assert.equal(resolverCalls, 2)
  assert.equal(fetchCalls, 1)
})

test('legacy transport retries network failures at most twice with safe generic errors', async () => {
  let calls = 0
  await assert.rejects(
    fetchChatCompletion(requestOptions({
      retries: 99,
      fetchImpl: async () => {
        calls += 1
        throw new Error('unsafe internal URL and key details')
      },
    })),
    (error) => error instanceof ProbeRequestError
      && error.kind === 'network'
      && error.message === 'Endpoint request failed',
  )
  assert.equal(calls, 3)
})
