#!/usr/bin/env node
/**
 * llm-fingerprint — CLI for fingerprinting and verifying LLM endpoints.
 *
 * The API key is read from an environment variable (never from a file, never
 * logged). Historical verify exit codes are retained for compatibility:
 *   0 match · 2 mismatch · 3 uncertain · 4 insufficient · 1 error
 * These labels are legacy exploratory distance bands, not identity decisions.
 */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { compare, fingerprint, verify } from './api.js'
import { CELL_PRIORITY_ORDER, isCellId } from './battery.js'
import {
  DEFAULT_CELL_COUNT,
  DEFAULT_CONCURRENCY,
  DEFAULT_SAMPLES_PER_CELL,
} from './constants.js'
import {
  getBundledAttribution,
  listBundledReferences,
  loadBundledReference,
  parseFingerprintJson,
} from './reference.js'
import {
  collectBruckner2026PaperFingerprint,
  paperSplitHalfByRepetitionIndex,
  type PaperCollectionResult,
} from './paper-collector.js'
import {
  ANTHROPIC_MESSAGES_OPUS5_TRANSPORT_PROFILE,
  createAnthropicMessagesOpus5Transport,
  createOpenAICompatiblePaperTransport,
} from './paper-http.js'
import { ProbeRunError } from './sampler.js'
import type {
  CellId,
  ComparisonResult,
  Endpoint,
  Fingerprint,
  FingerprintOptions,
  VerdictLevel,
} from './types.js'

const DEFAULT_KEY_ENV_VARS = ['LLM_FINGERPRINT_API_KEY', 'OPENAI_API_KEY']
const OPENAI_CHAT_TRANSPORT_PROFILE = 'openai-chat-onetoken-v1' as const

const VALUE_OPTIONS = new Set([
  '--base-url',
  '--model',
  '--api-key',
  '--api-key-env',
  '--cells',
  '--samples',
  '--concurrency',
  '--timeout',
  '--preset',
  '--reference',
  '--out',
  '--role',
  '--scheduler-seed',
  '--samples-out',
  '--transport-profile',
  '--anthropic-workspace-id',
  '--retry-budget',
])
const BOOLEAN_OPTIONS = new Set(['--json', '--quiet', '--help', '-h', '--version', '-V'])

interface ParsedArgs {
  positionals: string[]
  options: Map<string, string | boolean>
}

class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const options = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('-')) {
      positionals.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 0) {
      options.set(token.slice(0, eq), token.slice(eq + 1))
      continue
    }
    if (BOOLEAN_OPTIONS.has(token)) {
      options.set(token, true)
      continue
    }
    if (VALUE_OPTIONS.has(token)) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        fail(`Option ${token} expects a value`)
      }
      options.set(token, value)
      i += 1
      continue
    }
    fail(`Unknown option: ${token} (see --help)`)
  }
  return { positionals, options }
}

function fail(message: string): never {
  throw new CliError(message)
}

function packageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version
  } catch {
    return 'unknown'
  }
}

const HELP = `llm-fingerprint — compare LLM output distributions behind OpenAI-compatible APIs
Inspired by: "One Token Is Enough" (Bruckner, arXiv:2607.10252)

USAGE
  llm-fingerprint <command> [options]

COMMANDS
  fingerprint   Probe an endpoint and print/save its behavioral fingerprint
  verify        Fingerprint an endpoint and compare it to a reference
  compare       Compare two saved fingerprints (files or bundled ids)
  references    List bundled sample reference fingerprints
  paper-fingerprint
                Opt in to the exact T=1 Study-A 40-cell collection profile

ENDPOINT OPTIONS
  --base-url <url>      OpenAI-compatible base URL, e.g. https://api.openai.com/v1
  --model <id>          Model id to request, e.g. gpt-4o-mini
  --api-key-env <name>  Env var holding the API key
                        (default: tries ${DEFAULT_KEY_ENV_VARS.join(', ')})
  --api-key <key>       Legacy commands only; paper-fingerprint rejects literals

SAMPLING OPTIONS
  --cells <n|list>      Cell count 1-16 (top-N most discriminative) or a
                        comma-separated list of cell ids (default: ${DEFAULT_CELL_COUNT})
  --samples <n>         Samples per cell (default: ${DEFAULT_SAMPLES_PER_CELL})
  --preset <id>         quick (4×15) | standard (8×25) | strict (16×25)
  --concurrency <n>     Concurrent requests (default: ${DEFAULT_CONCURRENCY})
  --timeout <ms>        Per-request timeout (legacy default: 30000;
                        paper-fingerprint default: 90000)

PAPER-FINGERPRINT (EXPLICIT OPT-IN)
  --role <kind>         Required: enrollment | audit
  --scheduler-seed <s> Required non-secret scheduler seed
  --out <file>          Required V2 fingerprint output
  --samples-out <file>  Required canonical raw-evidence JSONL sidecar
  --samples <n>         Samples per each of 40 cells (default: 30)
  --concurrency <n>     Concurrent requests (default: ${DEFAULT_CONCURRENCY})
  --transport-profile <id>
                        openai-chat-onetoken-v1 (default) |
                        anthropic-messages-opus5-onetoken-v1
  --anthropic-workspace-id <id>
                        Optional Anthropic workspace header; Anthropic only
  --retry-budget <n>    Batch-wide extra-attempt budget (default: 240)
  This sends the pinned fixed prompts at T=1 and max_tokens=16. It is not a
  full reproduction of the paper's EER evaluation, has no validated decision
  policy, and does not produce a model-identity conclusion. Auth failures are
  not retried; network/timeout/429/selected 5xx get at most 2 retries. This
  command uses environment-sourced keys when authentication is needed and
  rejects literal keys.

VERIFY / COMPARE
  --reference <src>     Reference fingerprint: a JSON file produced by
                        'fingerprint --out', or a bundled id (see 'references')

OUTPUT
  --json                Machine-readable JSON on stdout
  --out <file>          Write the fingerprint JSON to a file
  --quiet               No progress output
  --help, -h            Show this help
  --version, -V         Show version

LEGACY COMPATIBILITY EXIT CODES (verify)
  0 match · 2 mismatch · 3 uncertain · 4 insufficient · 1 error
  The labels preserve existing automation only; they are not calibrated
  model-identity decisions (JSON: decisionEligible=false).

EXAMPLES
  # Fingerprint an endpoint (key read from OPENAI_API_KEY)
  llm-fingerprint fingerprint --base-url https://api.openai.com/v1 \\
    --model gpt-4o-mini --out gpt-4o-mini.fingerprint.json

  # Explore the distance between a reseller endpoint and a reference
  LLM_FINGERPRINT_API_KEY=sk-... llm-fingerprint verify \\
    --base-url https://cheap-api.example.com/v1 --model gpt-4o-mini \\
    --reference gpt-4o-mini.fingerprint.json

  # Quick demo against a bundled sample reference
  llm-fingerprint verify --base-url https://openrouter.ai/api/v1 \\
    --model openai/gpt-4o-mini --reference openai/gpt-4o-mini --preset quick

  # Compare two saved fingerprints offline
  llm-fingerprint compare a.fingerprint.json b.fingerprint.json

  # Explicit paper-profile collection (1,200 requests at the default 30/cell)
  llm-fingerprint paper-fingerprint --base-url https://api.example.com/v1 \
    --model model-id --role enrollment --scheduler-seed enrollment-2026-08 \
    --out enrollment.v2.json --samples-out enrollment.raw.jsonl

Web version (no install): https://tosea.ai/free-tools/llm-api-fingerprint-checker
`

function readEndpoint(args: ParsedArgs): Endpoint {
  const baseUrl = args.options.get('--base-url')
  const model = args.options.get('--model')
  if (typeof baseUrl !== 'string') fail('--base-url is required')
  if (typeof model !== 'string') fail('--model is required')
  return { baseUrl, model, apiKey: resolveApiKey(args) }
}

function resolveApiKey(args: ParsedArgs): string | undefined {
  const literal = args.options.get('--api-key')
  if (typeof literal === 'string' && literal.trim()) return literal.trim()

  const envName = args.options.get('--api-key-env')
  if (typeof envName === 'string') {
    const value = process.env[envName]
    if (!value) fail(`Environment variable ${envName} is empty or not set`)
    return value
  }

  for (const name of DEFAULT_KEY_ENV_VARS) {
    const value = process.env[name]
    if (value) return value
  }
  process.stderr.write(
    `note: no API key found (checked ${DEFAULT_KEY_ENV_VARS.join(', ')}); ` +
      'sending requests without Authorization header\n',
  )
  return undefined
}

function readSamplingOptions(args: ParsedArgs): FingerprintOptions {
  const options: FingerprintOptions = {}

  const preset = args.options.get('--preset')
  if (typeof preset === 'string') {
    const presets: Record<string, { cells: number; samples: number }> = {
      quick: { cells: 4, samples: 15 },
      standard: { cells: 8, samples: 25 },
      strict: { cells: 16, samples: 25 },
    }
    if (!Object.hasOwn(presets, preset)) {
      fail(`Unknown preset "${preset}" (quick | standard | strict)`)
    }
    const found = presets[preset]
    options.cells = found.cells
    options.samplesPerCell = found.samples
  }

  const cells = args.options.get('--cells')
  if (typeof cells === 'string') {
    if (/^\d+$/.test(cells)) {
      const n = Number(cells)
      if (n < 1 || n > CELL_PRIORITY_ORDER.length) {
        fail(`--cells must be 1-${CELL_PRIORITY_ORDER.length} or a comma-separated cell list`)
      }
      options.cells = n
    } else {
      const list = cells.split(',').map((cell) => cell.trim())
      for (const cell of list) {
        if (!isCellId(cell)) {
          fail(`Unknown cell id "${cell}". Valid cells:\n  ${CELL_PRIORITY_ORDER.join('\n  ')}`)
        }
      }
      options.cells = list as CellId[]
    }
  }

  const samples = args.options.get('--samples')
  if (typeof samples === 'string') {
    const n = Number(samples)
    if (!Number.isInteger(n) || n < 1) fail('--samples must be a positive integer')
    options.samplesPerCell = n
  }

  const concurrency = args.options.get('--concurrency')
  if (typeof concurrency === 'string') {
    const n = Number(concurrency)
    if (!Number.isInteger(n) || n < 1) fail('--concurrency must be a positive integer')
    options.concurrency = n
  }

  const timeout = args.options.get('--timeout')
  if (typeof timeout === 'string') {
    const n = Number(timeout)
    if (!Number.isFinite(n) || n < 100) fail('--timeout must be ≥ 100 (milliseconds)')
    options.timeoutMs = n
  }

  return options
}

interface PaperCliOptions {
  role: 'enrollment' | 'audit'
  schedulerSeed: string
  out: string
  samplesOut: string
  samplesPerCell: number
  concurrency: number
  timeoutMs: number
  transportProfileId:
    | typeof OPENAI_CHAT_TRANSPORT_PROFILE
    | typeof ANTHROPIC_MESSAGES_OPUS5_TRANSPORT_PROFILE
  anthropicWorkspaceId: string | null
  retryBudget: number
}

function readPaperCliOptions(args: ParsedArgs): PaperCliOptions {
  const role = args.options.get('--role')
  if (role !== 'enrollment' && role !== 'audit') {
    fail('--role is required and must be enrollment or audit')
  }
  const schedulerSeed = args.options.get('--scheduler-seed')
  if (typeof schedulerSeed !== 'string' || schedulerSeed.trim().length === 0) {
    fail('--scheduler-seed is required and must be non-empty')
  }
  if (schedulerSeed.length > 256) fail('--scheduler-seed must be at most 256 characters')

  const out = args.options.get('--out')
  if (typeof out !== 'string' || out.trim().length === 0) {
    fail('--out is required for paper-fingerprint')
  }
  const samplesOut = args.options.get('--samples-out')
  if (typeof samplesOut !== 'string' || samplesOut.trim().length === 0) {
    fail('--samples-out is required for paper-fingerprint')
  }
  if (resolve(out) === resolve(samplesOut)) {
    fail('--out and --samples-out must name different files')
  }

  const samples = args.options.get('--samples')
  const samplesPerCell = typeof samples === 'string' ? Number(samples) : 30
  if (!Number.isSafeInteger(samplesPerCell) || samplesPerCell <= 0) {
    fail('--samples must be a positive integer')
  }
  const concurrencyValue = args.options.get('--concurrency')
  const concurrency = typeof concurrencyValue === 'string'
    ? Number(concurrencyValue)
    : DEFAULT_CONCURRENCY
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    fail('--concurrency must be a positive integer')
  }
  const timeoutValue = args.options.get('--timeout')
  const timeoutMs = typeof timeoutValue === 'string' ? Number(timeoutValue) : 90_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100) {
    fail('--timeout must be ≥ 100 (milliseconds)')
  }
  const requestedProfile = args.options.get('--transport-profile')
  const transportProfileId = requestedProfile === undefined
    ? OPENAI_CHAT_TRANSPORT_PROFILE
    : requestedProfile
  if (
    transportProfileId !== OPENAI_CHAT_TRANSPORT_PROFILE
    && transportProfileId !== ANTHROPIC_MESSAGES_OPUS5_TRANSPORT_PROFILE
  ) {
    fail(
      '--transport-profile must be openai-chat-onetoken-v1 or ' +
        'anthropic-messages-opus5-onetoken-v1',
    )
  }
  const workspaceValue = args.options.get('--anthropic-workspace-id')
  const anthropicWorkspaceId = typeof workspaceValue === 'string'
    ? workspaceValue.trim()
    : null
  if (anthropicWorkspaceId !== null) {
    if (transportProfileId !== ANTHROPIC_MESSAGES_OPUS5_TRANSPORT_PROFILE) {
      fail('--anthropic-workspace-id requires the Anthropic transport profile')
    }
    if (
      anthropicWorkspaceId.length === 0
      || anthropicWorkspaceId.length > 256
      || /[\r\n\0]/u.test(anthropicWorkspaceId)
    ) {
      fail('--anthropic-workspace-id must be 1-256 header-safe characters')
    }
  }
  const retryBudgetValue = args.options.get('--retry-budget')
  const retryBudget = typeof retryBudgetValue === 'string' ? Number(retryBudgetValue) : 240
  if (!Number.isSafeInteger(retryBudget) || retryBudget < 0) {
    fail('--retry-budget must be a non-negative integer')
  }
  return {
    role,
    schedulerSeed,
    out,
    samplesOut,
    samplesPerCell,
    concurrency,
    timeoutMs,
    transportProfileId,
    anthropicWorkspaceId,
    retryBudget,
  }
}

interface CliProgressEvent {
  stage: 'adapter' | 'sampling'
  done: number
  total: number
  errors: number
  strategy?: string
  detail?: string | null
  lastErrorKind?: string | null
  lastHttpStatus?: number | null
  retrying?: boolean
}

function makeProgressRenderer(args: ParsedArgs): ((event: CliProgressEvent) => void) | undefined {
  if (args.options.get('--quiet')) return undefined
  const isTty = process.stderr.isTTY === true
  return (event) => {
    if (!isTty) {
      const detail =
        event.detail ??
        (event.stage === 'adapter' && event.strategy
          ? `probing reasoning adapter (${event.strategy})`
          : null)
      process.stderr.write(
        `LLMFP_PROGRESS ${JSON.stringify({
          stage: event.stage,
          done: event.done,
          total: event.total,
          errors: event.errors,
          detail,
          lastErrorKind: event.lastErrorKind ?? null,
          lastHttpStatus: event.lastHttpStatus ?? null,
          retrying: event.retrying === true,
        })}\n`,
      )
      return
    }

    if (event.stage === 'adapter') {
      process.stderr.write(`\rprobing reasoning adapter (${event.strategy})...          `)
      return
    }
    const errs = event.errors > 0 ? `, errors: ${event.errors}` : ''
    const status = event.lastHttpStatus !== null && event.lastHttpStatus !== undefined
      ? ` HTTP ${event.lastHttpStatus}`
      : event.lastErrorKind
        ? ` ${event.lastErrorKind}`
        : ''
    const retry = event.retrying ? `, retrying${status}` : ''
    process.stderr.write(`\rsampling ${event.done}/${event.total}${errs}${retry}          `)
    if (event.done === event.total && !event.retrying) process.stderr.write('\n')
  }
}

function writeFingerprintAtomic(path: string, fingerprint: Fingerprint): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(fingerprint, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

interface PreparedPaperOutput {
  target: string
  temporary: string
  descriptor: number
  closed: boolean
  committed: boolean
  backup: string | null
}

interface PreparedPaperOutputs {
  fingerprint: PreparedPaperOutput
  samples: PreparedPaperOutput
}

function pathState(path: string): 'missing' | 'file' | 'symlink' | 'directory' | 'other' {
  try {
    const stat = lstatSync(path)
    if (stat.isDirectory()) return 'directory'
    if (stat.isFile()) return 'file'
    if (stat.isSymbolicLink()) return 'symlink'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function randomSiblingPath(target: string, label: string): string {
  return join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(16).toString('hex')}.${label}`,
  )
}

function preparePaperOutput(targetPath: string): PreparedPaperOutput {
  const target = resolve(targetPath)
  const parent = dirname(target)
  if (!statSync(parent).isDirectory()) fail(`Output parent is not a directory: ${parent}`)
  const state = pathState(target)
  if (state === 'directory' || state === 'other') {
    fail(`Paper output target must be a regular file path: ${targetPath}`)
  }

  // A random same-directory file opened with O_EXCL prevents predictable-temp
  // symlink attacks and proves writability before any network requests run.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporary = randomSiblingPath(target, 'paper.tmp')
    try {
      const descriptor = openSync(temporary, 'wx', 0o600)
      return {
        target,
        temporary,
        descriptor,
        closed: false,
        committed: false,
        backup: null,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  fail(`Could not reserve a secure temporary output beside ${targetPath}`)
}

function closePreparedOutput(output: PreparedPaperOutput): void {
  if (output.closed) return
  closeSync(output.descriptor)
  output.closed = true
}

function abortPaperOutputs(outputs: PreparedPaperOutputs): void {
  for (const output of [outputs.fingerprint, outputs.samples]) {
    try {
      closePreparedOutput(output)
    } catch {
      // Continue cleaning the other output.
    }
    if (!output.committed) {
      try {
        unlinkSync(output.temporary)
      } catch {
        // It may already have been renamed or removed.
      }
    }
  }
}

function preparePaperOutputs(
  fingerprintPath: string,
  samplesPath: string,
): PreparedPaperOutputs {
  const fingerprint = preparePaperOutput(fingerprintPath)
  try {
    const samples = preparePaperOutput(samplesPath)
    return { fingerprint, samples }
  } catch (error) {
    try {
      closePreparedOutput(fingerprint)
    } catch {
      // Preserve the preparation error.
    }
    try {
      unlinkSync(fingerprint.temporary)
    } catch {
      // Preserve the preparation error.
    }
    throw error
  }
}

function reserveBackupPath(target: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const backup = randomSiblingPath(target, 'paper.backup')
    if (pathState(backup) === 'missing') return backup
  }
  throw new Error(`Could not reserve a backup path beside ${target}`)
}

function rollbackPaperOutputs(outputs: PreparedPaperOutputs): void {
  for (const output of [outputs.fingerprint, outputs.samples]) {
    try {
      if (output.backup !== null) {
        if (output.committed) {
          try {
            unlinkSync(output.target)
          } catch {
            // The final may already be absent; attempt restoration below.
          }
        }
        renameSync(output.backup, output.target)
        output.backup = null
      } else if (output.committed) {
        unlinkSync(output.target)
      }
    } catch {
      // Preserve the original commit failure; recovery remains best-effort.
    }
    output.committed = false
  }
}

function writePaperOutputsAtomic(
  outputs: PreparedPaperOutputs,
  result: PaperCollectionResult,
): void {
  try {
    writeFileSync(
      outputs.fingerprint.descriptor,
      `${JSON.stringify(result.fingerprint, null, 2)}\n`,
      'utf8',
    )
    writeFileSync(outputs.samples.descriptor, result.rawEvidenceJsonl, 'utf8')
    fsyncSync(outputs.fingerprint.descriptor)
    fsyncSync(outputs.samples.descriptor)
    closePreparedOutput(outputs.fingerprint)
    closePreparedOutput(outputs.samples)

    // Recheck after collection so a target created during the network run
    // cannot turn a commit into a directory replacement or special-file write.
    for (const output of [outputs.fingerprint, outputs.samples]) {
      const state = pathState(output.target)
      if (state === 'directory' || state === 'other') {
        throw new Error(`Paper output target changed to a non-file: ${output.target}`)
      }
    }
    for (const output of [outputs.fingerprint, outputs.samples]) {
      if (pathState(output.target) !== 'missing') {
        output.backup = reserveBackupPath(output.target)
        renameSync(output.target, output.backup)
      }
    }

    // The fingerprint is the manifest that binds the sidecar hash, so expose
    // the sidecar first and the fingerprint last. Any ordinary failure rolls
    // both paths back to their previous state below.
    renameSync(outputs.samples.temporary, outputs.samples.target)
    outputs.samples.committed = true
    renameSync(outputs.fingerprint.temporary, outputs.fingerprint.target)
    outputs.fingerprint.committed = true

    for (const output of [outputs.fingerprint, outputs.samples]) {
      if (output.backup === null) continue
      try {
        unlinkSync(output.backup)
        output.backup = null
      } catch {
        // The new pair is complete; retain an inaccessible random backup rather
        // than report a false collection failure or remove the new outputs.
      }
    }
  } catch (error) {
    rollbackPaperOutputs(outputs)
    abortPaperOutputs(outputs)
    throw error
  }
}

function requireCompleteFingerprint(fingerprint: Fingerprint, source: string): Fingerprint {
  if (fingerprint.partial === true) {
    fail(
      `Incomplete partial fingerprint cannot be used for compare/verify: ${source} ` +
        `(${fingerprint.completedSamples ?? 0}/${fingerprint.expectedSamples ?? '?'} samples)`,
    )
  }
  return fingerprint
}

/** Load a reference: a JSON file path first, then a bundled sample id. */
function loadReference(source: string): Fingerprint {
  let fileText: string | null = null
  try {
    fileText = readFileSync(source, 'utf8')
  } catch {
    fileText = null
  }
  if (fileText !== null) {
    return requireCompleteFingerprint(parseFingerprintJson(fileText, source), source)
  }
  try {
    return requireCompleteFingerprint(loadBundledReference(source), source)
  } catch (error) {
    fail(
      `"${source}" is neither a readable file nor a bundled reference id.\n${(error as Error).message}`,
    )
  }
}

function verdictLabel(verdict: VerdictLevel): string {
  switch (verdict) {
    case 'match':
      return 'LOW-DISTANCE (legacy label: match)'
    case 'uncertain':
      return 'MID-DISTANCE (legacy label: uncertain)'
    case 'mismatch':
      return 'HIGH-DISTANCE (legacy label: mismatch)'
    case 'insufficient':
      return 'INSUFFICIENT (legacy label: insufficient)'
  }
}

function verdictExitCode(verdict: VerdictLevel): number {
  switch (verdict) {
    case 'match':
      return 0
    case 'mismatch':
      return 2
    case 'uncertain':
      return 3
    case 'insufficient':
      return 4
  }
}

function renderComparison(result: ComparisonResult): string {
  const lines: string[] = []
  const mean = result.meanJsd === null ? 'n/a' : result.meanJsd.toFixed(3)
  lines.push(`Legacy exploratory band: ${verdictLabel(result.verdict)}`)
  lines.push(
    `Semantics: ${result.verdictSemantics} · decision eligible: ${result.decisionEligible ? 'yes' : 'no'}`,
  )
  lines.push(`Mean JSD: ${mean} over ${result.comparableCellCount} comparable cell(s)`)
  lines.push('')
  lines.push('Published paper medians (context only; not calibration for this implementation):')
  lines.push(
    `  same model ≈ ${result.baselines.sameModelSelf} · same model, other provider ≈ ${result.baselines.sameModelCrossProvider} · different model ≈ ${result.baselines.differentModel}`,
  )
  lines.push(
    `  local legacy bands: low ≤ ${result.thresholds.match} < mid ≤ ${result.thresholds.mismatch} < high`,
  )
  if (result.cells.length > 0) {
    lines.push('')
    lines.push('Per-cell JSD (most divergent first):')
    for (const cell of result.cells) {
      lines.push(
        `  ${cell.cellId.padEnd(26)} ${cell.jsd.toFixed(3)}  (${cell.validA} vs ${cell.validB} valid)`,
      )
    }
  }
  if (result.protocolMismatch) {
    lines.push('')
    lines.push(
      'note: protocol mismatch; only the raw distance is interpretable. Do not read the legacy band as a model-identity finding.',
    )
  }
  return lines.join('\n')
}

function summarizeFingerprint(fp: Fingerprint): string {
  const lines: string[] = []
  lines.push(`Model: ${fp.model}`)
  lines.push(`Protocol: ${fp.protocol} · collected ${fp.collectedAt}`)
  lines.push(`Cells: ${Object.keys(fp.cells).length} × ${fp.samplesPerCell} samples`)
  if (fp.postReasoning) lines.push('warning: collected via post-reasoning fallback (reduced confidence)')
  lines.push('')
  lines.push('Top answers per cell:')
  for (const [cellId, cell] of Object.entries(fp.cells)) {
    if (!cell) continue
    const top = Object.entries(cell.counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([answer, count]) => `${answer}×${count}`)
      .join(', ')
    lines.push(
      `  ${cellId.padEnd(26)} valid ${String(cell.validCount).padStart(3)}  H=${cell.entropyBits.toFixed(2)}b  ${top || '(no valid answers)'}`,
    )
  }
  return lines.join('\n')
}

function writeWarnings(warnings: string[]): void {
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`)
}

async function cmdFingerprint(args: ParsedArgs): Promise<number> {
  const endpoint = readEndpoint(args)
  const options = readSamplingOptions(args)
  options.onProgress = makeProgressRenderer(args)
  const out = args.options.get('--out')
  if (typeof out === 'string') {
    options.onCheckpoint = (checkpoint) => writeFingerprintAtomic(out, checkpoint)
  }

  const run = await fingerprint(endpoint, options)
  writeWarnings(run.warnings)

  if (typeof out === 'string') {
    writeFingerprintAtomic(out, run.fingerprint)
    process.stderr.write(`fingerprint written to ${out}\n`)
  }

  if (args.options.get('--json')) {
    const { fingerprint: fp, adapter, errorCount, splitHalfJsd, durationMs, warnings } = run
    process.stdout.write(
      `${JSON.stringify({ fingerprint: fp, run: { adapter, errorCount, splitHalfJsd, durationMs, warnings } }, null, 2)}\n`,
    )
  } else if (typeof out !== 'string') {
    process.stdout.write(`${summarizeFingerprint(run.fingerprint)}\n`)
  } else {
    process.stderr.write(`${summarizeFingerprint(run.fingerprint)}\n`)
  }
  return 0
}

function paperSafeSummary(result: PaperCollectionResult): Record<string, unknown> {
  const splitHalf = paperSplitHalfByRepetitionIndex(result.evidence)
  return {
    artifactKind: 'paper-profile-collection-v2',
    interpretation: 'uncalibrated-non-decision-evidence',
    decisionEligible: false,
    protocol: result.fingerprint.protocol,
    transportProfileId: result.fingerprint.manifest.transportProfileId ?? null,
    model: result.fingerprint.model,
    role: result.fingerprint.plan.role,
    cellCount: result.fingerprint.plan.cellIds.length,
    samplesPerCell: result.fingerprint.samplesPerCell,
    expectedSamples: result.fingerprint.quality.expectedSamples,
    validSamples: result.fingerprint.quality.validSamples,
    invalidSamples: result.fingerprint.quality.invalidSamples,
    errorSamples: result.fingerprint.quality.errorSamples,
    attemptCount: result.fingerprint.quality.attemptCount ?? null,
    retryCount: result.fingerprint.quality.retryCount ?? null,
    directness: result.fingerprint.quality.directness,
    splitHalfMeanJsd: splitHalf.meanJsd,
    splitHalfComparableCells: splitHalf.cells.length,
    rawEvidenceSha256: result.fingerprint.quality.rawEvidenceSha256,
  }
}

async function cmdPaperFingerprint(args: ParsedArgs): Promise<number> {
  if (typeof args.options.get('--api-key') === 'string') {
    fail('paper-fingerprint forbids --api-key literals; use --api-key-env')
  }
  const endpoint = readEndpoint(args)
  const paper = readPaperCliOptions(args)
  const preparedOutputs = preparePaperOutputs(paper.out, paper.samplesOut)
  const plannedRequests = 40 * paper.samplesPerCell
  if (!args.options.get('--quiet')) {
    process.stderr.write(
      `paper-profile collection: ${plannedRequests} fixed-prompt requests ` +
        `(${paper.role}, 40 cells × ${paper.samplesPerCell})\n`,
    )
  }

  const abortController = new AbortController()
  let interruptedSignal: NodeJS.Signals | null = null
  const interrupt = (signal: NodeJS.Signals): void => {
    interruptedSignal = signal
    abortController.abort()
  }
  const onSigterm = (): void => interrupt('SIGTERM')
  const onSigint = (): void => interrupt('SIGINT')
  process.once('SIGTERM', onSigterm)
  process.once('SIGINT', onSigint)

  const renderProgress = makeProgressRenderer(args)
  let lastCheckpoint: PaperCollectionResult | null = null
  let completedSamples = 0
  let errorSamples = 0
  let result: PaperCollectionResult
  try {
    const commonTransportOptions = {
      baseUrl: endpoint.baseUrl,
      timeoutMs: paper.timeoutMs,
      retryBudget: paper.retryBudget,
      allowInsecureLoopbackForTests:
        process.env.LLMFP_ALLOW_INSECURE_LOOPBACK_FOR_TESTS === '1',
      signal: abortController.signal,
      onRetry: (event: {
        kind: string
        status: number | null
      }) => {
        renderProgress?.({
          stage: 'sampling',
          done: completedSamples,
          total: plannedRequests,
          errors: errorSamples,
          detail: 'retry_wait',
          lastErrorKind: event.kind,
          lastHttpStatus: event.status,
          retrying: true,
        })
      },
    }
    const request = paper.transportProfileId === ANTHROPIC_MESSAGES_OPUS5_TRANSPORT_PROFILE
      ? createAnthropicMessagesOpus5Transport({
          ...commonTransportOptions,
          apiKey: endpoint.apiKey
            ?? fail('Anthropic transport requires --api-key-env'),
          headers: paper.anthropicWorkspaceId === null
            ? undefined
            : { 'anthropic-workspace-id': paper.anthropicWorkspaceId },
        })
      : createOpenAICompatiblePaperTransport({
          ...commonTransportOptions,
          apiKey: endpoint.apiKey,
        })
    result = await collectBruckner2026PaperFingerprint({
      model: endpoint.model,
      transportProfileId: paper.transportProfileId,
      role: paper.role,
      schedulerSeed: paper.schedulerSeed,
      samplesPerCell: paper.samplesPerCell,
      concurrency: paper.concurrency,
      request,
      abortOnRequestError: true,
      abortOnProviderError: true,
      signal: abortController.signal,
      onCheckpoint: (checkpoint) => {
        lastCheckpoint = checkpoint
      },
      onProgress: (event) => {
        completedSamples = event.done
        errorSamples = event.errors
        renderProgress?.(event)
      },
    })
    writePaperOutputsAtomic(preparedOutputs, result)
  } catch (error) {
    const retained = lastCheckpoint as PaperCollectionResult | null
    if (
      interruptedSignal !== null
      && retained !== null
      && retained.fingerprint.partial === true
      && retained.fingerprint.quality.completedSamples > 0
    ) {
      retained.fingerprint.incompleteReason = 'sampling_interrupted'
      writePaperOutputsAtomic(preparedOutputs, retained)
      process.stderr.write(
        `paper-profile partial evidence retained after ${interruptedSignal}: ` +
          `${retained.fingerprint.quality.completedSamples}/${plannedRequests}\n`,
      )
    } else {
      abortPaperOutputs(preparedOutputs)
    }
    throw error
  } finally {
    process.off('SIGTERM', onSigterm)
    process.off('SIGINT', onSigint)
  }
  process.stderr.write(`paper-profile V2 fingerprint written to ${paper.out}\n`)
  process.stderr.write(`canonical raw evidence written to ${paper.samplesOut}\n`)

  const summary = paperSafeSummary(result)
  if (args.options.get('--json')) {
    process.stdout.write(
      `${JSON.stringify({ fingerprint: result.fingerprint, collection: summary }, null, 2)}\n`,
    )
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  }
  return 0
}

async function cmdVerify(args: ParsedArgs): Promise<number> {
  const referenceSource = args.options.get('--reference')
  if (typeof referenceSource !== 'string') {
    fail('--reference <file-or-bundled-id> is required (see `llm-fingerprint references`)')
  }
  const reference = loadReference(referenceSource)
  const endpoint = readEndpoint(args)
  const options = readSamplingOptions(args)
  options.onProgress = makeProgressRenderer(args)
  const out = args.options.get('--out')
  if (typeof out === 'string') {
    options.onCheckpoint = (checkpoint) => writeFingerprintAtomic(out, checkpoint)
  }

  const result = await verify(endpoint, reference, options)
  writeWarnings(result.warnings)

  if (typeof out === 'string') {
    writeFingerprintAtomic(out, result.target.fingerprint)
    process.stderr.write(`target fingerprint written to ${out}\n`)
  }

  if (args.options.get('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderComparison(result.comparison)}\n`)
    process.stdout.write(
      `\nReference: ${reference.model} (collected ${reference.collectedAt}, protocol ${reference.protocol})\n`,
    )
  }
  return verdictExitCode(result.verdict)
}

async function cmdCompare(args: ParsedArgs): Promise<number> {
  if (args.positionals.length !== 2) {
    fail('compare expects exactly two arguments: <fingerprint-a> <fingerprint-b>')
  }
  const a = loadReference(args.positionals[0])
  const b = loadReference(args.positionals[1])
  const result = compare(a, b)

  if (args.options.get('--json')) {
    process.stdout.write(`${JSON.stringify({ a: a.model, b: b.model, ...result }, null, 2)}\n`)
  } else {
    process.stdout.write(`A: ${a.model} (${a.collectedAt})\nB: ${b.model} (${b.collectedAt})\n\n`)
    process.stdout.write(`${renderComparison(result)}\n`)
  }
  return verdictExitCode(result.verdict)
}

function cmdReferences(args: ParsedArgs): number {
  const references = listBundledReferences()
  const attribution = getBundledAttribution()
  if (args.options.get('--json')) {
    process.stdout.write(`${JSON.stringify({ source: attribution, references }, null, 2)}\n`)
    return 0
  }
  process.stdout.write('Bundled sample reference fingerprints:\n\n')
  for (const ref of references) {
    process.stdout.write(
      `  ${ref.id.padEnd(36)} ${String(ref.cellCount).padStart(2)} cells  collected ${ref.collectedAt}\n`,
    )
  }
  process.stdout.write(
    `\nSource: ${attribution.dataset}\n` +
      `by ${attribution.author} — DOI ${attribution.datasetDoi} (${attribution.license})\n` +
      'Converted from the paper dataset into legacy sample artifacts. They do not\n' +
      'share the local one-token/v1 protocol; use them for distance exploration only.\n' +
      'For a local same-protocol comparison, collect your own reference.\n',
  )
  return 0
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2)
    const args = parseArgs(argv)

    if (args.options.get('--version') || args.options.get('-V')) {
      process.stdout.write(`${packageVersion()}\n`)
      process.exitCode = 0
      return
    }
    const command = args.positionals.shift()
    if (!command || args.options.get('--help') || args.options.get('-h') || command === 'help') {
      process.stdout.write(HELP)
      process.exitCode = 0
      return
    }

    let exitCode: number
    switch (command) {
      case 'fingerprint':
        exitCode = await cmdFingerprint(args)
        break
      case 'verify':
        exitCode = await cmdVerify(args)
        break
      case 'compare':
        exitCode = await cmdCompare(args)
        break
      case 'references':
        exitCode = cmdReferences(args)
        break
      case 'paper-fingerprint':
        exitCode = await cmdPaperFingerprint(args)
        break
      default:
        fail(`Unknown command: ${command} (see --help)`)
    }
    // Do not call process.exit() after writing output. stdout is asynchronous
    // when connected to a pipe, and forcing an exit can truncate large JSON
    // responses before their pending writes have drained.
    process.exitCode = exitCode
  } catch (error) {
    let message: string
    if (error instanceof ProbeRunError) {
      const hints: Record<string, string> = {
        auth: 'The endpoint rejected the API key (401/403).',
        network: 'The endpoint is unreachable — check the base URL and your network.',
        aborted: 'Run cancelled.',
      }
      message = `${hints[error.reason] ?? ''} ${error.message}`.trim()
    } else {
      message = error instanceof Error ? error.message : String(error)
    }
    process.stderr.write(`error: ${message}\n`)
    process.exitCode = 1
  }
}

void main()
