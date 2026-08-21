import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}/v1`
}

async function closeServer(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

async function runCli(argv, env = {}) {
  const child = spawn(process.execPath, [CLI_PATH, ...argv], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const [code, signal] = await once(child, 'close')
  return {
    code,
    signal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

test('paper-fingerprint CLI writes V2 + SHA-bound JSONL without leaking headers or key', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'llm-paper-cli-'))
  const fingerprintPath = join(tempDir, 'audit.v2.json')
  const samplesPath = join(tempDir, 'audit.raw.jsonl')
  const secret = 'local-paper-test-key-do-not-persist'
  const receivedBodies = []
  const receivedAuthorizations = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      receivedAuthorizations.push(request.headers.authorization)
      receivedBodies.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: `local-generation-${receivedBodies.length}`,
          model: 'local-reported-model',
          choices: [{ message: { role: 'assistant', content: '7' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 1,
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        }),
      )
    })
  })

  try {
    const baseUrl = await listen(server)
    const result = await runCli(
      [
        'paper-fingerprint',
        '--base-url', baseUrl,
        '--model', 'local-paper-model',
        '--api-key-env', 'PAPER_LOCAL_TEST_KEY',
        '--role', 'audit',
        '--scheduler-seed', 'cli-local-seed',
        '--samples', '1',
        '--concurrency', '8',
        '--out', fingerprintPath,
        '--samples-out', samplesPath,
        '--json',
        '--quiet',
      ],
      { PAPER_LOCAL_TEST_KEY: secret },
    )

    assert.equal(result.signal, null)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(receivedBodies.length, 40)
    assert.ok(receivedAuthorizations.every((value) => value === `Bearer ${secret}`))
    for (const body of receivedBodies) {
      assert.deepEqual(Object.keys(body), [
        'model',
        'messages',
        'temperature',
        'max_tokens',
        'reasoning',
        'usage',
      ])
      assert.equal(body.model, 'local-paper-model')
      assert.equal(body.temperature, 1)
      assert.equal(body.max_tokens, 16)
      assert.deepEqual(body.reasoning, { enabled: false })
      assert.deepEqual(body.usage, { include: true })
      assert.equal('stream' in body, false)
      assert.equal('top_p' in body, false)
      assert.equal('seed' in body, false)
      assert.deepEqual(body.messages.map((message) => message.role), ['system', 'user'])
    }

    const fingerprintText = await readFile(fingerprintPath, 'utf8')
    const samplesText = await readFile(samplesPath, 'utf8')
    const stdout = JSON.parse(result.stdout)
    const fingerprint = JSON.parse(fingerprintText)
    const evidence = samplesText.trimEnd().split('\n').map((line) => JSON.parse(line))
    const digest = createHash('sha256').update(samplesText, 'utf8').digest('hex')

    assert.equal(fingerprint.formatVersion, 2)
    assert.equal(fingerprint.plan.role, 'audit')
    assert.equal(fingerprint.plan.cellIds.length, 40)
    assert.equal(fingerprint.plan.samplesPerCell, 1)
    assert.equal(fingerprint.plan.expectedSamples, 40)
    assert.equal(fingerprint.quality.completedSamples, 40)
    assert.equal(fingerprint.quality.reasoningUsageObservedSamples, 40)
    assert.equal(fingerprint.quality.rawEvidenceSha256, digest)
    assert.equal(evidence.length, 40)
    assert.equal((await stat(fingerprintPath)).mode & 0o777, 0o600)
    assert.equal((await stat(samplesPath)).mode & 0o777, 0o600)
    assert.equal(stdout.fingerprint.quality.rawEvidenceSha256, digest)
    assert.equal(stdout.collection.decisionEligible, false)
    assert.equal(stdout.collection.interpretation, 'uncalibrated-non-decision-evidence')
    assert.equal('verdict' in stdout, false)
    assert.equal('verdict' in stdout.collection, false)

    for (const persisted of [fingerprintText, samplesText, result.stdout, result.stderr]) {
      assert.equal(persisted.includes(secret), false)
      assert.equal(persisted.toLowerCase().includes('authorization'), false)
      assert.equal(persisted.includes('headers'), false)
    }
    const leftovers = (await readdir(tempDir)).filter((name) => name.endsWith('.paper.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    await closeServer(server)
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('paper-fingerprint is explicit, requires collection metadata, and documents default 30', () => {
  const help = spawnSync(process.execPath, [CLI_PATH, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /paper-fingerprint/)
  assert.match(help.stdout, /exact T=1 Study-A 40-cell collection profile/)
  assert.match(help.stdout, /Samples per each of 40 cells \(default: 30\)/)
  assert.match(help.stdout, /not a\n  full reproduction of the paper's EER evaluation/)
  assert.match(help.stdout, /does not produce a model-identity conclusion/)

  const missingRole = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      'paper-fingerprint',
      '--base-url', 'http://127.0.0.1:1/v1',
      '--model', 'never-contacted',
      '--scheduler-seed', 'seed',
      '--out', 'unused.json',
      '--samples-out', 'unused.jsonl',
      '--quiet',
    ],
    { encoding: 'utf8', env: { ...process.env, LLM_FINGERPRINT_API_KEY: '' } },
  )
  assert.equal(missingRole.status, 1)
  assert.match(missingRole.stderr, /--role is required/)

  const literalKey = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      'paper-fingerprint',
      '--base-url', 'http://127.0.0.1:1/v1',
      '--model', 'never-contacted',
      '--api-key', 'literal-key-must-not-be-accepted',
      '--role', 'audit',
      '--scheduler-seed', 'seed',
      '--out', 'unused.json',
      '--samples-out', 'unused.jsonl',
      '--quiet',
    ],
    { encoding: 'utf8' },
  )
  assert.equal(literalKey.status, 1)
  assert.match(literalKey.stderr, /forbids --api-key literals/)
  assert.equal(literalKey.stderr.includes('literal-key-must-not-be-accepted'), false)
})

test('paper-fingerprint preflights output targets before any request', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'llm-paper-cli-preflight-'))
  const fingerprintPath = join(tempDir, 'fingerprint-is-a-directory')
  const samplesPath = join(tempDir, 'must-not-exist.raw.jsonl')
  await mkdir(fingerprintPath)
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(500)
    response.end()
  })

  try {
    const baseUrl = await listen(server)
    const result = await runCli([
      'paper-fingerprint',
      '--base-url', baseUrl,
      '--model', 'never-contacted',
      '--role', 'audit',
      '--scheduler-seed', 'preflight-seed',
      '--samples', '1',
      '--out', fingerprintPath,
      '--samples-out', samplesPath,
      '--quiet',
    ], { LLM_FINGERPRINT_API_KEY: '' })

    assert.equal(result.code, 1)
    assert.equal(requests, 0)
    assert.match(result.stderr, /must be a regular file path/)
    assert.deepEqual(await readdir(tempDir), ['fingerprint-is-a-directory'])
  } finally {
    await closeServer(server)
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('paper-fingerprint rechecks targets after collection and removes reserved temporaries', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'llm-paper-cli-race-'))
  const fingerprintPath = join(tempDir, 'existing.v2.json')
  const samplesPath = join(tempDir, 'samples-became-a-directory')
  const originalFingerprint = 'existing fingerprint must survive\n'
  await writeFile(fingerprintPath, originalFingerprint, 'utf8')
  let createSamplesTarget
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', async () => {
      createSamplesTarget ??= mkdir(samplesPath)
      await createSamplesTarget
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '7' }, finish_reason: 'stop' }],
        usage: {
          completion_tokens: 1,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }))
    })
  })

  try {
    const baseUrl = await listen(server)
    const result = await runCli([
      'paper-fingerprint',
      '--base-url', baseUrl,
      '--model', 'local-paper-model',
      '--role', 'audit',
      '--scheduler-seed', 'output-race-seed',
      '--samples', '1',
      '--concurrency', '8',
      '--out', fingerprintPath,
      '--samples-out', samplesPath,
      '--quiet',
    ], { LLM_FINGERPRINT_API_KEY: '' })

    assert.equal(result.code, 1)
    assert.match(result.stderr, /target changed to a non-file/)
    assert.equal(await readFile(fingerprintPath, 'utf8'), originalFingerprint)
    assert.equal((await stat(samplesPath)).isDirectory(), true)
    assert.deepEqual((await readdir(tempDir)).sort(), [
      'existing.v2.json',
      'samples-became-a-directory',
    ])
  } finally {
    await closeServer(server)
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('paper-fingerprint bounds 401 failures and leaves no final or temporary output', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'llm-paper-cli-auth-'))
  const fingerprintPath = join(tempDir, 'must-not-exist.v2.json')
  const samplesPath = join(tempDir, 'must-not-exist.raw.jsonl')
  const secretKey = 'invalid-local-key-must-not-leak'
  const secretBody = 'private-auth-response-body-must-not-leak'
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: secretBody }))
  })

  try {
    const baseUrl = await listen(server)
    const result = await runCli(
      [
        'paper-fingerprint',
        '--base-url', baseUrl,
        '--model', 'local-paper-model',
        '--api-key-env', 'PAPER_INVALID_LOCAL_KEY',
        '--role', 'audit',
        '--scheduler-seed', 'auth-failure-seed',
        '--samples', '30',
        '--concurrency', '4',
        '--out', fingerprintPath,
        '--samples-out', samplesPath,
        '--json',
        '--quiet',
      ],
      { PAPER_INVALID_LOCAL_KEY: secretKey },
    )

    assert.equal(result.signal, null)
    assert.equal(result.code, 1)
    assert.ok(requests >= 1)
    assert.ok(requests <= 4, `expected at most four in-flight requests, observed ${requests}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Paper collection aborted after auth request failure \(HTTP 401\)/)
    for (const forbidden of [secretKey, secretBody, 'authorization', 'headers']) {
      assert.equal(result.stdout.toLowerCase().includes(forbidden.toLowerCase()), false)
      assert.equal(result.stderr.toLowerCase().includes(forbidden.toLowerCase()), false)
    }
    assert.deepEqual(await readdir(tempDir), [])
  } finally {
    await closeServer(server)
    await rm(tempDir, { recursive: true, force: true })
  }
})
