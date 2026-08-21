import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BRUCKNER_2026_FIXED_PROMPT_VARIANT_ID,
  PaperCollectionRequestError,
  bruckner2026SeededShuffle,
  buildBruckner2026DirectRequest,
  collectBruckner2026PaperFingerprint,
  createBruckner2026CollectionJobs,
  hashPaperRawEvidence,
  paperSplitHalfByRepetitionIndex,
  serializePaperRawEvidenceJsonl,
} from '../dist/paper-collector.js'
import {
  BRUCKNER_2026_CANONICAL40_CELLS,
  BRUCKNER_2026_CANONICAL40_PROFILE,
} from '../dist/profiles/bruckner2026.js'
import { createOpenAICompatiblePaperTransport } from '../dist/paper-http.js'
import { validateFingerprint } from '../dist/validation.js'

const FIXED_TIME = '2026-08-21T00:00:00.000Z'

function validRawForJob(job) {
  if (job.taskId === 'num100-random' || job.taskId === 'num10-random') return '7'
  if (job.taskId === 'num-favorite') return '10001'
  if (job.taskId === 'letter-random') {
    return { en: 'a', ru: 'я', zh: '汉', ar: 'ا' }[job.language]
  }
  if (job.taskId === 'coin-flip') {
    return { en: 'heads', ru: 'орёл', zh: '正面', ar: 'صورة' }[job.language]
  }
  return { en: 'cat', ru: 'кот', zh: '猫', ar: 'قط' }[job.language]
}

function cleanResponse(job) {
  return {
    response: {
      id: `gen-${job.jobId}`,
      model: 'reported-paper-model',
      provider: 'local-fixture',
      choices: [
        {
          message: { role: 'assistant', content: validRawForJob(job) },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 1,
        cost: 0.000001,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
  }
}

function baseOptions(request, overrides = {}) {
  return {
    model: 'requested-paper-model',
    role: 'audit',
    samplesPerCell: 1,
    schedulerSeed: 'offline-seed-2026',
    request,
    collectedAt: FIXED_TIME,
    now: () => FIXED_TIME,
    ...overrides,
  }
}

test('canonical scheduler contains each fixed cell/repetition job exactly once', () => {
  const jobsA = createBruckner2026CollectionJobs(3, 'seed-a')
  const jobsARepeat = createBruckner2026CollectionJobs(3, 'seed-a')
  const jobsB = createBruckner2026CollectionJobs(3, 'seed-b')

  assert.deepEqual(jobsA, jobsARepeat)
  assert.equal(jobsA.length, 40 * 3)
  assert.notDeepEqual(
    jobsA.map((job) => job.jobId),
    jobsB.map((job) => job.jobId),
  )
  assert.equal(new Set(jobsA.map((job) => job.jobId)).size, jobsA.length)

  const identities = new Set(
    jobsA.map((job) => `${job.cellId}:${job.repetitionIndex}:${job.promptVariantId}`),
  )
  assert.equal(identities.size, jobsA.length)
  assert.ok(jobsA.every((job) => job.promptVariantId === BRUCKNER_2026_FIXED_PROMPT_VARIANT_ID))
  assert.deepEqual(
    [...new Set(jobsA.map((job) => job.cellId))].sort(),
    BRUCKNER_2026_CANONICAL40_CELLS.map((cell) => cell.cellId).sort(),
  )
})

test('author-compatible seeded shuffle matches the archived golden fixture', () => {
  const input = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
  assert.deepEqual(bruckner2026SeededShuffle(input, 'paper-golden-01'), [
    'delta',
    'eta',
    'alpha',
    'zeta',
    'gamma',
    'beta',
    'epsilon',
    'theta',
  ])
  assert.deepEqual(input, ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'])
})

test('direct request body is exact and never adds top_p, seed, or fallback tokens', () => {
  const job = createBruckner2026CollectionJobs(1, 'request-shape')[0]
  const body = buildBruckner2026DirectRequest('paper-model', job)
  const cell = BRUCKNER_2026_CANONICAL40_CELLS.find((entry) => entry.cellId === job.cellId)

  assert.deepEqual(body, {
    model: 'paper-model',
    messages: [
      { role: 'system', content: cell.systemPrompt },
      { role: 'user', content: cell.userPrompt },
    ],
    temperature: 1,
    max_tokens: 16,
    reasoning: { enabled: false },
    usage: { include: true },
  })
  assert.equal('top_p' in body, false)
  assert.equal('seed' in body, false)
  assert.equal(JSON.stringify(body).includes('1024'), false)
})

test('concurrency and deliberately out-of-order completion do not change jobs or artifact', async () => {
  const expectedJobs = createBruckner2026CollectionJobs(2, 'offline-seed-2026')
  const firstJobId = expectedJobs[0].jobId

  function transport(completions) {
    return async (_body, context) => {
      if (context.job.jobId === firstJobId) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      completions.push(context.job.jobId)
      return cleanResponse(context.job)
    }
  }

  const serialCompletions = []
  const parallelCompletions = []
  const serial = await collectBruckner2026PaperFingerprint(
    baseOptions(transport(serialCompletions), { samplesPerCell: 2, concurrency: 1 }),
  )
  const parallel = await collectBruckner2026PaperFingerprint(
    baseOptions(transport(parallelCompletions), { samplesPerCell: 2, concurrency: 8 }),
  )

  assert.deepEqual(serialCompletions, expectedJobs.map((job) => job.jobId))
  assert.notEqual(parallelCompletions[0], firstJobId)
  assert.deepEqual(serial.jobs, parallel.jobs)
  assert.deepEqual(serial.evidence, parallel.evidence)
  assert.deepEqual(serial.fingerprint, parallel.fingerprint)
  assert.equal(serial.fingerprint.quality.rawEvidenceSha256, hashPaperRawEvidence(serial.evidence))
  assert.equal(
    serial.fingerprint.plan.schedulerPolicy,
    'bruckner-seeded-shuffle-mulberry32-v1',
  )
  assert.equal(serial.fingerprint.plan.role, 'audit')
  assert.equal(serial.fingerprint.plan.expectedSamples, 80)
  assert.equal(serial.fingerprint.quality.validSamples, 80)
  assert.equal(serial.fingerprint.quality.directness, 'verified')
  assert.equal(serial.fingerprint.postReasoning, false)
  assert.equal(serial.evidence[0].usage.costUsd, 0.000001)
  assert.equal(serial.evidence[0].usage.cachedPromptTokens, 3)
  assert.equal(validateFingerprint(serial.fingerprint), serial.fingerprint)
})

test('model-controlled Object prototype keys remain ordinary answer keys', async () => {
  const result = await collectBruckner2026PaperFingerprint(
    baseOptions(async () => ({
      response: {
        choices: [
          { message: { role: 'assistant', content: 'constructor' }, finish_reason: 'stop' },
        ],
        usage: {
          completion_tokens: 1,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      },
    })),
  )

  const wordCell = result.fingerprint.cells['word-random:en']
  assert.equal(Object.hasOwn(wordCell.counts, 'constructor'), true)
  assert.equal(wordCell.counts.constructor, 1)
  assert.equal(result.fingerprint.quality.completedSamples, 40)
  assert.doesNotThrow(() => JSON.stringify(result.fingerprint))
})

test('split half uses per-cell repetitionIndex parity, not array or completion order', async () => {
  const collected = await collectBruckner2026PaperFingerprint(
    baseOptions(async (_body, context) => cleanResponse(context.job)),
  )
  const base = collected.evidence[0]
  const shuffled = [3, 0, 2, 1].map((repetitionIndex) => ({
    ...base,
    jobId: `synthetic-${repetitionIndex}`,
    repetitionIndex,
    category: 'valid',
    normalized: repetitionIndex % 2 === 0 ? 'even-answer' : 'odd-answer',
  }))

  const result = paperSplitHalfByRepetitionIndex(shuffled, 2)
  assert.equal(result.cells.length, 1)
  assert.equal(result.cells[0].evenValidCount, 2)
  assert.equal(result.cells[0].oddValidCount, 2)
  assert.equal(result.cells[0].jsd, 1)
  assert.deepEqual(result, paperSplitHalfByRepetitionIndex([...shuffled].reverse(), 2))
})

test('reasoning traces and positive reasoning tokens contaminate and exclude samples fail-closed', async () => {
  const result = await collectBruckner2026PaperFingerprint(
    baseOptions(
      async (_body, context) => {
        const fixture = cleanResponse(context.job)
        if (context.job.repetitionIndex === 0) {
          const field = context.job.language === 'en' ? 'reasoning' : 'reasoning_content'
          fixture.response.choices[0].message[field] = 'hidden trace must not enter counts'
        } else {
          fixture.response.usage.reasoning_tokens = 2
        }
        return fixture
      },
      { samplesPerCell: 2, concurrency: 5 },
    ),
  )

  assert.equal(result.fingerprint.quality.completedSamples, 80)
  assert.equal(result.fingerprint.quality.validSamples, 0)
  assert.equal(result.fingerprint.quality.invalidSamples, 80)
  assert.equal(result.fingerprint.quality.reasoningTraceCount, 40)
  assert.equal(result.fingerprint.quality.reasoningTokenCount, 80)
  assert.equal(result.fingerprint.quality.directness, 'violated')
  assert.equal(result.fingerprint.postReasoning, false)
  assert.ok(result.evidence.every((sample) => sample.excludedFromDistribution))
  assert.ok(result.evidence.every((sample) => sample.normalized === null))
  assert.ok(result.evidence.every((sample) => sample.normalizationCandidate !== null))
  assert.ok(
    Object.values(result.fingerprint.cells).every(
      (cell) => cell.validCount === 0 && Object.keys(cell.counts).length === 0,
    ),
  )
})

test('reasoning_details is contamination and missing reasoning usage cannot be verified', async () => {
  const detailed = await collectBruckner2026PaperFingerprint(
    baseOptions(async (_body, context) => {
      const fixture = cleanResponse(context.job)
      fixture.response.choices[0].message.reasoning_details = [
        { type: 'text', text: 'observable reasoning' },
      ]
      return fixture
    }),
  )
  assert.equal(detailed.fingerprint.quality.directness, 'violated')
  assert.equal(detailed.fingerprint.quality.reasoningTraceCount, 40)
  assert.equal(detailed.fingerprint.quality.invalidSamples, 40)
  assert.equal(detailed.fingerprint.postReasoning, false)

  const missingUsage = await collectBruckner2026PaperFingerprint(
    baseOptions(async (_body, context) => {
      const fixture = cleanResponse(context.job)
      delete fixture.response.usage.completion_tokens_details.reasoning_tokens
      return fixture
    }),
  )
  assert.equal(missingUsage.fingerprint.quality.validSamples, 40)
  assert.equal(missingUsage.fingerprint.quality.reasoningUsageObservedSamples, 0)
  assert.equal(missingUsage.fingerprint.quality.directness, 'unknown')
})

test('assistant role is required for a structurally direct response', async () => {
  const result = await collectBruckner2026PaperFingerprint(
    baseOptions(async (_body, context) => {
      const fixture = cleanResponse(context.job)
      delete fixture.response.choices[0].message.role
      return fixture
    }),
  )
  assert.equal(result.fingerprint.quality.errorSamples, 40)
  assert.equal(result.fingerprint.quality.directness, 'unknown')
  assert.ok(result.evidence.every((sample) => sample.errorKind === 'malformed_response'))
})

test('transport credential echoes are redacted from every persisted response field and excluded', async () => {
  const secret = 'paper-credential-echo-must-never-persist'
  const request = createOpenAICompatiblePaperTransport({
    baseUrl: 'https://offline.invalid/v1',
    apiKey: secret,
    retries: 0,
    fetchImpl: async () => new Response(JSON.stringify({
      id: `id-${secret}`,
      model: `model-${secret}`,
      provider: `provider-${secret}`,
      choices: [
        {
          message: { role: 'assistant', content: `answer-${secret}` },
          finish_reason: `finish-${secret}`,
        },
      ],
      usage: {
        completion_tokens: 1,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const result = await collectBruckner2026PaperFingerprint(
    baseOptions(request, { concurrency: 8 }),
  )

  assert.equal(result.rawEvidenceJsonl.includes(secret), false)
  assert.equal(JSON.stringify(result.fingerprint).includes(secret), false)
  assert.equal(result.fingerprint.quality.errorSamples, 40)
  assert.equal(result.fingerprint.quality.directness, 'unknown')
  assert.ok(result.evidence.every((sample) => sample.errorKind === 'sensitive_credential_echo'))
  assert.ok(result.evidence.every((sample) => sample.excludedFromDistribution))
  assert.ok(result.evidence.every((sample) => sample.sensitiveCredentialEchoFields.length === 5))
})

test('credential echoes in adapter metadata are redacted before truncation and excluded', async () => {
  const secret = 'metadata-credential-echo-must-never-persist'
  const request = async (_body, context) => {
    const fixture = cleanResponse(context.job)
    fixture.metadata = {
      provider: `metadata-provider-${secret}`,
      reportedModel: `${'m'.repeat(510)}-${secret}`,
      generationId: `metadata-id-${secret}`,
    }
    return fixture
  }
  Object.defineProperty(request, 'redactSensitiveText', {
    value: (value) => ({
      text: value.split(secret).join('[REDACTED_CREDENTIAL_ECHO]'),
      matched: value.includes(secret),
    }),
  })

  const result = await collectBruckner2026PaperFingerprint(
    baseOptions(request, { concurrency: 8 }),
  )

  assert.equal(result.rawEvidenceJsonl.includes(secret), false)
  assert.equal(JSON.stringify(result.fingerprint).includes(secret), false)
  assert.equal(result.fingerprint.quality.errorSamples, 40)
  assert.ok(result.evidence.every((sample) => sample.errorKind === 'sensitive_credential_echo'))
  assert.ok(result.evidence.every((sample) => sample.excludedFromDistribution))
  assert.ok(result.evidence.every((sample) => (
    sample.sensitiveCredentialEchoFields.includes('provider')
    && sample.sensitiveCredentialEchoFields.includes('reportedModel')
    && sample.sensitiveCredentialEchoFields.includes('generationId')
  )))
})

test('structurally malformed responses are errors, excluded, and never treated as direct output', async () => {
  const secretBody = 'malformed-body-must-not-be-retained'
  const malformedResponses = [
    null,
    { unexpected: secretBody },
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: null }] },
    { choices: [{ message: { content: { text: secretBody } } }] },
  ]
  let callIndex = 0
  const result = await collectBruckner2026PaperFingerprint(
    baseOptions(async () => ({
      response: malformedResponses[callIndex++ % malformedResponses.length],
    })),
  )

  assert.equal(result.fingerprint.quality.errorSamples, 40)
  assert.equal(result.fingerprint.quality.emptySamples, 0)
  assert.equal(result.fingerprint.quality.directness, 'unknown')
  assert.ok(result.evidence.every((sample) => sample.category === 'error'))
  assert.ok(result.evidence.every((sample) => sample.errorKind === 'malformed_response'))
  assert.ok(result.evidence.every((sample) => sample.exclusionReason === 'malformed_response'))
  assert.ok(result.evidence.every((sample) => sample.excludedFromDistribution))
  assert.ok(result.evidence.every((sample) => sample.normalizationCategory === null))
  assert.ok(result.evidence.every((sample) => sample.raw === ''))
  assert.equal(result.rawEvidenceJsonl.includes(secretBody), false)
})

test('a structurally valid response with message.content empty string remains an empty sample', async () => {
  const result = await collectBruckner2026PaperFingerprint(
    baseOptions(async (_body, context) => {
      const fixture = cleanResponse(context.job)
      fixture.response.choices[0].message.content = ''
      return fixture
    }),
  )

  assert.equal(result.fingerprint.quality.errorSamples, 0)
  assert.equal(result.fingerprint.quality.emptySamples, 40)
  assert.equal(result.fingerprint.quality.directness, 'verified')
  assert.ok(result.evidence.every((sample) => sample.category === 'empty'))
  assert.ok(result.evidence.every((sample) => sample.errorKind === null))
  assert.ok(result.evidence.every((sample) => !sample.excludedFromDistribution))
  assert.ok(result.evidence.every((sample) => sample.normalizationCategory === 'empty'))
})

test('canonical JSONL and SHA are stable under evidence reordering', async () => {
  const result = await collectBruckner2026PaperFingerprint(
    baseOptions(async (_body, context) => cleanResponse(context.job)),
  )
  const reversed = [...result.evidence].reverse()
  assert.equal(serializePaperRawEvidenceJsonl(result.evidence), result.rawEvidenceJsonl)
  assert.equal(serializePaperRawEvidenceJsonl(reversed), result.rawEvidenceJsonl)
  assert.equal(hashPaperRawEvidence(reversed), result.fingerprint.quality.rawEvidenceSha256)
  assert.ok(result.rawEvidenceJsonl.endsWith('\n'))
})

test('request bodies and retained evidence never persist keys or thrown error messages', async () => {
  const secret = 'sk-test-secret-must-not-be-saved'
  const observedBodies = []
  let calls = 0
  const result = await collectBruckner2026PaperFingerprint(
    baseOptions(async (body, context) => {
      observedBodies.push(body)
      calls += 1
      if (calls === 1) throw new Error(`upstream rejected ${secret}`)
      const fixture = cleanResponse(context.job)
      fixture.response.api_key = secret
      fixture.response.headers = { authorization: `Bearer ${secret}` }
      return fixture
    }),
  )

  assert.equal(result.fingerprint.quality.errorSamples, 1)
  assert.equal(result.fingerprint.quality.directness, 'unknown')
  const failed = result.evidence.find((sample) => sample.category === 'error')
  assert.equal(failed.errorKind, 'request_failed')
  assert.equal(failed.normalizationCategory, null)
  assert.ok(observedBodies.every((body) => !JSON.stringify(body).includes(secret)))
  assert.equal(result.rawEvidenceJsonl.includes(secret), false)
  assert.equal(JSON.stringify(result.fingerprint).includes(secret), false)
  assert.equal(result.rawEvidenceJsonl.includes('authorization'), false)
  assert.equal(BRUCKNER_2026_CANONICAL40_PROFILE.paraphrasePolicy, 'fixed')
})

test('opt-in fail-fast bounds thrown request failures by concurrency and sanitizes the error', async () => {
  const secret = 'unsafe-upstream-message-and-key'
  let calls = 0
  await assert.rejects(
    collectBruckner2026PaperFingerprint(
      baseOptions(
        async () => {
          calls += 1
          throw new Error(`request rejected with ${secret}`)
        },
        { samplesPerCell: 30, concurrency: 4, abortOnRequestError: true },
      ),
    ),
    (error) => {
      assert.ok(error instanceof PaperCollectionRequestError)
      assert.equal(error.kind, 'request_failed')
      assert.equal(error.status, null)
      assert.equal(error.message, 'Paper collection aborted after request_failed request failure')
      assert.equal(error.message.includes(secret), false)
      assert.equal(JSON.stringify(error).includes(secret), false)
      return true
    },
  )
  assert.ok(calls >= 1)
  assert.ok(calls <= 4, `expected at most the concurrency window, observed ${calls}`)
})

test('fail-fast applies only to throws; 200 provider errors remain quality evidence', async () => {
  const result = await collectBruckner2026PaperFingerprint(
    baseOptions(async () => ({ response: { error: { type: 'provider_fixture' } } }), {
      abortOnRequestError: true,
      concurrency: 4,
    }),
  )

  assert.equal(result.fingerprint.quality.completedSamples, 40)
  assert.equal(result.fingerprint.quality.errorSamples, 40)
  assert.ok(result.evidence.every((sample) => sample.errorKind === 'provider_error'))
})

test('network-facing provider-error fail-fast is opt-in and bounded by concurrency', async () => {
  let calls = 0
  await assert.rejects(
    collectBruckner2026PaperFingerprint(
      baseOptions(async () => {
        calls += 1
        return { response: { error: { type: 'provider_fixture' } } }
      }, {
        samplesPerCell: 30,
        concurrency: 4,
        abortOnProviderError: true,
      }),
    ),
    (error) => error instanceof PaperCollectionRequestError && error.kind === 'provider_error',
  )
  assert.ok(calls >= 1)
  assert.ok(calls <= 4)
})
