import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
process.env.LLMFP_ALLOW_INSECURE_LOOPBACK_FOR_TESTS = '1'

function cell(cellId, answer) {
  return {
    cellId,
    counts: { [answer]: 10 },
    validCount: 10,
    invalidCount: 0,
    refusalCount: 0,
    emptyCount: 0,
    errorCount: 0,
    totalCount: 10,
    entropyBits: 0,
    normalizedEntropy: 0,
    medianLatencyMs: 1,
    meanCompletionTokens: 1,
    meanReasoningTokens: 0,
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}/v1`
}

test(
  'CLI drains a large piped JSON response before exiting',
  { timeout: 20_000 },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'llm-fingerprint-cli-'))
    const referencePath = join(tempDir, 'reference.json')
    const targetPath = join(tempDir, 'target.json')
    const padding = 'x'.repeat(8 * 1024 * 1024)
    const reference = {
      formatVersion: 1,
      protocol: 'one-token/v1',
      model: 'mock-large-output',
      collectedAt: '2026-08-20T00:00:00.000Z',
      samplesPerCell: 10,
      postReasoning: false,
      cells: {
        'random-number-1-100:en': cell('random-number-1-100:en', '42'),
        'random-number-1-100:zh': cell('random-number-1-100:zh', '42'),
        'random-color:en': cell('random-color:en', 'blue'),
        'random-animal:en': cell('random-animal:en', 'octopus'),
      },
      meta: { note: padding },
    }
    await writeFile(referencePath, JSON.stringify(reference), 'utf8')

    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        if (request.url !== '/v1/chat/completions') {
          response.writeHead(404).end('not found')
          return
        }
        const payload = JSON.parse(body)
        const prompt = payload.messages.find((message) => message.role === 'user')?.content ?? ''
        const lowerPrompt = prompt.toLowerCase()
        const answer = lowerPrompt.includes('color')
          ? 'blue'
          : lowerPrompt.includes('animal')
            ? 'octopus'
            : '42'
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: answer } }],
            usage: { prompt_tokens: 10, completion_tokens: 1 },
          }),
        )
      })
    })

    try {
      const baseUrl = await listen(server)
      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          'verify',
          '--base-url',
          baseUrl,
          '--model',
          'mock-large-output',
          '--reference',
          referencePath,
          '--cells',
          '4',
          '--samples',
          '10',
          '--concurrency',
          '10',
          '--out',
          targetPath,
          '--json',
          '--quiet',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )

      const stdout = []
      let stderr = ''
      let resumed = false
      let resumeTimer
      const resumeStdout = () => {
        if (resumed) return
        resumed = true
        child.stdout.resume()
      }

      // Hold the consumer briefly after sampling finishes. This forces output
      // above the pipe buffer to remain pending and reproduces the truncation
      // caused by calling process.exit() immediately after stdout.write().
      child.stdout.on('data', (chunk) => stdout.push(chunk))
      child.stdout.pause()
      child.stderr.on('data', (chunk) => {
        stderr += chunk
        if (stderr.includes('target fingerprint written to') && resumeTimer === undefined) {
          resumeTimer = setTimeout(resumeStdout, 200)
        }
      })
      const fallbackTimer = setTimeout(resumeStdout, 10_000)

      const [code, signal] = await once(child, 'close')
      clearTimeout(fallbackTimer)
      if (resumeTimer !== undefined) clearTimeout(resumeTimer)

      assert.equal(signal, null)
      assert.equal(code, 0, stderr)
      const text = Buffer.concat(stdout).toString('utf8')
      assert.ok(text.length > padding.length, 'expected JSON larger than the pipe buffer')
      const parsed = JSON.parse(text)
      assert.equal(parsed.verdict, 'match')
      assert.equal(parsed.verdictSemantics, 'legacy-exploratory')
      assert.equal(parsed.decisionEligible, false)
      assert.equal(parsed.comparison.verdictSemantics, 'legacy-exploratory')
      assert.equal(parsed.comparison.decisionEligible, false)
      assert.equal(parsed.reference.meta.note.length, padding.length)
    } finally {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await rm(tempDir, { recursive: true, force: true })
    }
  },
)

test('CLI presents protocol-mismatched labels as non-decision exploratory bands', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'llm-fingerprint-cli-bands-'))
  const leftPath = join(tempDir, 'left.json')
  const rightPath = join(tempDir, 'right.json')
  const cells = {
    'random-number-1-100:en': cell('random-number-1-100:en', '42'),
    'random-number-1-100:zh': cell('random-number-1-100:zh', '42'),
    'random-color:en': cell('random-color:en', 'blue'),
    'random-animal:en': cell('random-animal:en', 'octopus'),
  }
  const base = {
    formatVersion: 1,
    model: 'mock-offline',
    collectedAt: '2026-08-20T00:00:00.000Z',
    samplesPerCell: 10,
    postReasoning: false,
    cells,
  }

  try {
    await writeFile(leftPath, JSON.stringify({ ...base, protocol: 'one-token/v1' }), 'utf8')
    await writeFile(rightPath, JSON.stringify({ ...base, protocol: 'foreign/v1' }), 'utf8')

    const result = spawnSync(process.execPath, [CLI_PATH, 'compare', leftPath, rightPath], {
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Legacy exploratory band: LOW-DISTANCE/)
    assert.match(result.stdout, /legacy-exploratory · decision eligible: no/)
    assert.match(result.stdout, /protocol mismatch; only the raw distance is interpretable/)
    assert.doesNotMatch(result.stdout, /Verdict:/)
    assert.doesNotMatch(result.stdout, /Interpretation scale \(paper baselines/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
