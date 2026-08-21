/**
 * End-to-end test against a local mock OpenAI-compatible server: adapter
 * detection, concurrent sampling, normalization, aggregation and verify().
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'

import { compare, fingerprint, verify } from '../dist/api.js'

/** Two simulated "models" with different answer distributions. */
const MODEL_BEHAVIOR = {
  'mock-alpha': {
    'random-number-1-100': () => (Math.random() < 0.8 ? '42' : '73'),
    'random-number-1-10': () => '7',
    'random-letter': () => 'k',
    'random-color': () => (Math.random() < 0.6 ? 'blue' : 'teal'),
    'coin-flip': () => (Math.random() < 0.7 ? 'Heads' : 'Tails'),
    'random-animal': () => 'octopus',
    'random-city': () => 'Tokyo',
    'favorite-number': () => '42',
  },
  'mock-beta': {
    'random-number-1-100': () => (Math.random() < 0.8 ? '57' : '3'),
    'random-number-1-10': () => '3',
    'random-letter': () => 'm',
    'random-color': () => 'crimson',
    'coin-flip': () => 'Tails',
    'random-animal': () => 'giraffe',
    'random-city': () => 'Paris',
    'favorite-number': () => '9',
  },
}

/** Map a user prompt back to the battery task (rough but sufficient for the mock). */
function taskFromPrompt(prompt) {
  const p = prompt.toLowerCase()
  if (p.includes('100') || p.includes('1 到 100') || p.includes('1 至 100') || p.includes('1 到 100'))
    return 'random-number-1-100'
  if (p.includes('10') || p.includes('1 到 10')) return 'random-number-1-10'
  if (p.includes('letter') || p.includes('字母')) return 'random-letter'
  if (p.includes('color') || p.includes('颜色')) return 'random-color'
  if (p.includes('coin') || p.includes('硬币')) return 'coin-flip'
  if (p.includes('animal') || p.includes('动物')) return 'random-animal'
  if (p.includes('city') || p.includes('城市')) return 'random-city'
  if (p.includes('favorite') || p.includes('favourite') || p.includes('喜欢') || p.includes('最爱'))
    return 'favorite-number'
  return 'random-number-1-100'
}

let server
let baseUrl
let requestCount = 0
let sawReasoningField = 0

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requestCount += 1
      const payload = JSON.parse(body)

      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end('not found')
        return
      }
      if (req.headers.authorization !== 'Bearer test-key') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad key' } }))
        return
      }
      // The mock accepts the OpenRouter-style reasoning field (counts it for assertions).
      if (payload.reasoning !== undefined) sawReasoningField += 1

      const behavior = MODEL_BEHAVIOR[payload.model]
      if (!behavior) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `unknown model ${payload.model}` } }))
        return
      }
      const userPrompt = payload.messages.find((m) => m.role === 'user')?.content ?? ''
      const answer = behavior[taskFromPrompt(userPrompt)]()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: answer } }],
          usage: { prompt_tokens: 25, completion_tokens: 2 },
        }),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`
})

after(() => server.close())

test('fingerprint(): collects distributions from a live endpoint', async () => {
  const run = await fingerprint(
    { baseUrl, model: 'mock-alpha', apiKey: 'test-key' },
    { cells: 4, samplesPerCell: 12, concurrency: 6 },
  )
  assert.equal(run.errorCount, 0)
  assert.equal(run.fingerprint.model, 'mock-alpha')
  assert.equal(run.fingerprint.protocol, 'one-token/v1')
  assert.equal(Object.keys(run.fingerprint.cells).length, 4)

  const rn100 = run.fingerprint.cells['random-number-1-100:en']
  assert.ok(rn100, 'expected the top-priority cell to be probed')
  assert.equal(rn100.validCount, 12)
  assert.ok(rn100.counts['42'] > 0, 'mock-alpha answers 42 most of the time')
  assert.ok(run.adapter.postReasoning === false)
  assert.ok(sawReasoningField > 0, 'adapter probe should have tried the reasoning field')
})

test('fingerprint(): progress callback covers all requests', async () => {
  const events = []
  const run = await fingerprint(
    { baseUrl, model: 'mock-alpha', apiKey: 'test-key' },
    { cells: 2, samplesPerCell: 5, onProgress: (e) => events.push(e) },
  )
  const sampling = events.filter((e) => e.stage === 'sampling')
  assert.equal(sampling.length, 10)
  assert.equal(sampling.at(-1).done, 10)
  assert.equal(sampling.at(-1).total, 10)
  assert.equal(run.durationMs >= 0, true)
})

test('verify(): same mock model → match, different mock model → mismatch', async () => {
  const options = { cells: 6, samplesPerCell: 20, concurrency: 8 }
  const referenceRun = await fingerprint({ baseUrl, model: 'mock-alpha', apiKey: 'test-key' }, options)

  const same = await verify(
    { baseUrl, model: 'mock-alpha', apiKey: 'test-key' },
    referenceRun.fingerprint,
    options,
  )
  assert.equal(same.verdict, 'match')
  assert.equal(same.verdictSemantics, 'legacy-exploratory')
  assert.equal(same.decisionEligible, false)
  assert.equal(same.comparison.verdictSemantics, 'legacy-exploratory')
  assert.equal(same.comparison.decisionEligible, false)
  assert.ok(same.meanJsd < 0.25, `same model meanJsd should be small, got ${same.meanJsd}`)

  const different = await verify(
    { baseUrl, model: 'mock-beta', apiKey: 'test-key' },
    referenceRun.fingerprint,
    options,
  )
  assert.equal(different.verdict, 'mismatch')
  assert.ok(different.meanJsd > 0.35, `different model meanJsd should be large, got ${different.meanJsd}`)
})

test('compare(): flags protocol mismatch', async () => {
  const runA = await fingerprint(
    { baseUrl, model: 'mock-alpha', apiKey: 'test-key' },
    { cells: 4, samplesPerCell: 12 },
  )
  const foreign = { ...runA.fingerprint, protocol: 'someone-elses-protocol' }
  const result = compare(runA.fingerprint, foreign)
  assert.equal(result.protocolMismatch, true)
  assert.equal(result.verdict, 'match') // compatibility label is retained
  assert.equal(result.verdictSemantics, 'legacy-exploratory')
  assert.equal(result.decisionEligible, false)
})

test('fingerprint(): invalid API key aborts the run with an auth error', async () => {
  await assert.rejects(
    fingerprint(
      { baseUrl, model: 'mock-alpha', apiKey: 'wrong-key' },
      { cells: 2, samplesPerCell: 3 },
    ),
    (error) => {
      assert.match(error.message, /401/)
      return true
    },
  )
})

test('fingerprint(): AbortSignal cancels the run', async () => {
  const controller = new AbortController()
  const promise = fingerprint(
    { baseUrl, model: 'mock-alpha', apiKey: 'test-key' },
    {
      cells: 8,
      samplesPerCell: 50,
      onProgress: (e) => {
        if (e.stage === 'sampling' && e.done >= 5) controller.abort()
      },
      signal: controller.signal,
    },
  )
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'ProbeRunError')
    assert.equal(error.reason, 'aborted')
    return true
  })
})

test('endpoint validation: bad base URL rejects before any request', async () => {
  await assert.rejects(fingerprint({ baseUrl: '', model: 'x' }), /baseUrl is empty/)
  await assert.rejects(fingerprint({ baseUrl: 'https://ok.example/v1', model: ' ' }), /model is empty/)
  assert.ok(requestCount > 0)
})

test('fingerprint rejects Object prototype names supplied as runtime cell ids', async () => {
  await assert.rejects(
    fingerprint({ baseUrl, model: 'mock-alpha', apiKey: 'test-key' }, {
      cells: ['constructor:en'],
      samplesPerCell: 1,
    }),
    /unknown cell id/,
  )
})
