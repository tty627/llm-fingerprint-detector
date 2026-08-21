import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { compare, fingerprint } from '../dist/api.js'
import { MAX_RETRY_DELAY_MS } from '../dist/constants.js'
import { fetchChatCompletion, retryDelayMs } from '../dist/http.js'
import { parseFingerprintJson } from '../dist/reference.js'

const CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const FIXED_ADAPTER = {
  strategy: 'none',
  extraBody: {},
  maxTokens: 16,
  postReasoning: false,
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

function completion(response, answer = '42') {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: answer } }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    }),
  )
}

test('checkpoint is rewritten after every sample and a partial cannot produce a verdict', async () => {
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      requests += 1
      if (requests === 1) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'temporarily unavailable' } }))
        return
      }
      completion(response)
    })
  })
  const baseUrl = await listen(server)
  const progress = []
  const checkpoints = []

  try {
    const run = await fingerprint(
      { baseUrl, model: 'checkpoint-model' },
      {
        adapter: FIXED_ADAPTER,
        cells: 1,
        samplesPerCell: 3,
        concurrency: 1,
        maxRetries: 0,
        onProgress: (event) => progress.push(event),
        onCheckpoint: (checkpoint) => checkpoints.push(structuredClone(checkpoint)),
      },
    )

    const completedProgress = progress.filter(
      (event) => event.stage === 'sampling' && event.retrying !== true,
    )
    assert.deepEqual(
      completedProgress.map((event) => event.done),
      [1, 2, 3],
    )
    assert.deepEqual(
      completedProgress.map((event) => event.errors),
      [1, 1, 1],
    )
    assert.equal(completedProgress.at(-1).lastErrorKind, 'http')
    assert.equal(completedProgress.at(-1).lastHttpStatus, 503)

    assert.equal(checkpoints.length, 5, 'initial + one per sample + complete')
    assert.deepEqual(
      checkpoints.slice(0, -1).map((checkpoint) => checkpoint.completedSamples),
      [0, 1, 2, 3],
    )
    assert.ok(checkpoints.slice(0, -1).every((checkpoint) => checkpoint.partial === true))
    assert.equal(checkpoints[1].errorCount, 1)
    assert.equal(checkpoints[1].expectedSamples, 3)
    assert.equal(checkpoints[1].incompleteReason, 'sampling_in_progress')
    assert.equal(run.fingerprint.partial, undefined)
    assert.equal(run.fingerprint.completedSamples, undefined)
    assert.equal(checkpoints.at(-1).partial, undefined)

    assert.throws(
      () => compare(checkpoints[1], run.fingerprint),
      /partial fingerprint.*cannot produce an identity verdict/i,
    )
    assert.throws(
      () => parseFingerprintJson(JSON.stringify(checkpoints[1]), 'partial.json'),
      /incomplete partial fingerprint.*cannot be used as a reference/i,
    )
  } finally {
    await closeServer(server)
  }
})

test('Retry-After is capped and its wait remains abortable', async () => {
  assert.equal(MAX_RETRY_DELAY_MS, 60_000)
  assert.equal(retryDelayMs('3600', 0, 0), MAX_RETRY_DELAY_MS)
  assert.equal(retryDelayMs('not-a-date', 20, 1), MAX_RETRY_DELAY_MS)

  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(503, { 'retry-after': '3600' })
      response.end('unavailable')
    })
  })
  const baseUrl = await listen(server)
  const controller = new AbortController()
  const startedAt = performance.now()
  const pending = fetchChatCompletion({
    endpoint: { baseUrl, model: 'retry-model', apiKey: null, headers: {} },
    systemPrompt: 'system',
    userPrompt: 'user',
    temperature: 1,
    maxTokens: 1,
    extraBody: {},
    retries: 1,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 30)
  try {
    await assert.rejects(pending, (error) => error.kind === 'aborted')
    assert.ok(performance.now() - startedAt < 500, 'abort should interrupt Retry-After wait')
  } finally {
    await closeServer(server)
  }
})

test('non-TTY CLI emits JSONL for every sample and preserves a valid partial on SIGTERM', async () => {
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      requests += 1
      // Adapter probe and first sample finish; the second sample stays in flight.
      if (requests <= 2) completion(response)
    })
  })
  const baseUrl = await listen(server)
  const tempDir = await mkdtemp(join(tmpdir(), 'llm-fingerprint-checkpoint-'))
  const outputPath = join(tempDir, 'partial.json')
  const child = spawn(
    process.execPath,
    [
      CLI_PATH,
      'fingerprint',
      '--base-url',
      baseUrl,
      '--model',
      'slow-model',
      '--cells',
      '1',
      '--samples',
      '3',
      '--concurrency',
      '1',
      '--timeout',
      '10000',
      '--out',
      outputPath,
      '--json',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.resume()

  let stderr = ''
  let observedDoneOne = false
  const doneOne = new Promise((resolve) => {
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      for (const line of stderr.split('\n').slice(0, -1)) {
        if (!line.startsWith('LLMFP_PROGRESS ')) continue
        const event = JSON.parse(line.slice('LLMFP_PROGRESS '.length))
        if (event.stage === 'sampling' && event.done === 1 && event.retrying === false) {
          observedDoneOne = true
          resolve()
        }
      }
    })
  })

  try {
    await Promise.race([
      doneOne,
      new Promise((_, reject) => setTimeout(() => reject(new Error(stderr)), 5_000)),
    ])
    child.kill('SIGTERM')
    await once(child, 'close')

    assert.equal(observedDoneOne, true)
    const progressLines = stderr
      .split('\n')
      .filter((line) => line.startsWith('LLMFP_PROGRESS '))
      .map((line) => JSON.parse(line.slice('LLMFP_PROGRESS '.length)))
    const firstSample = progressLines.find(
      (event) => event.stage === 'sampling' && event.done === 1 && event.retrying === false,
    )
    assert.deepEqual(
      Object.keys(firstSample).sort(),
      [
        'detail',
        'done',
        'errors',
        'lastErrorKind',
        'lastHttpStatus',
        'retrying',
        'stage',
        'total',
      ].sort(),
    )

    const partial = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(partial.partial, true)
    assert.equal(partial.completedSamples, 1)
    assert.equal(partial.expectedSamples, 3)
    assert.equal(partial.errorCount, 0)
    assert.equal(partial.incompleteReason, 'sampling_in_progress')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closeServer(server)
    await rm(tempDir, { recursive: true, force: true })
  }
})
