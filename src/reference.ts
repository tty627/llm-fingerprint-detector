/**
 * Bundled sample reference fingerprints (Node-only module — uses the
 * filesystem; import via `llm-fingerprint-detector/references`).
 *
 * The samples in `data/reference-fingerprints.sample.json` are derived from
 * the paper's public dataset (Bruckner, "Single-token output distributions as
 * behavioral fingerprints of large language models", Zenodo,
 * DOI 10.5281/zenodo.21278557, CC-BY-4.0). They were collected by the paper's
 * own harness — a slightly different prompt protocol than this package's
 * battery — so `compare()` flags them with `protocolMismatch: true`. They are
 * great for demos and exploration; for high-stakes verification, collect your
 * own reference from a trusted endpoint with this tool.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getTaskSpec, isCellId } from './battery.js'
import { FINGERPRINT_FORMAT_VERSION } from './constants.js'
import { domainSize, shannonEntropyBits } from './stats.js'
import { validateFingerprint } from './validation.js'
import type { CellDistribution, CellId, Fingerprint } from './types.js'

export interface SampleReferenceSource {
  dataset: string
  author: string
  datasetDoi: string
  paper: string
  license: string
  note?: string
}

export interface SampleReferenceEntry {
  model: string
  collectedAt: string
  channel?: string
  cells: Record<string, { n: number; counts: Record<string, number> }>
}

export interface SampleReferenceFile {
  formatVersion: number
  protocol: string
  samplesPerCell: number
  source: SampleReferenceSource
  models: Record<string, SampleReferenceEntry>
}

const DATA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'reference-fingerprints.sample.json',
)

let cached: SampleReferenceFile | null = null

function loadFile(): SampleReferenceFile {
  if (cached) return cached
  let text: string
  try {
    text = readFileSync(DATA_PATH, 'utf8')
  } catch {
    throw new Error(
      `Bundled reference data not found at ${DATA_PATH}. ` +
        'Reinstall the package, or build your own references (see README "Building your own reference fingerprints").',
    )
  }
  cached = JSON.parse(text) as SampleReferenceFile
  return cached
}

export interface BundledReferenceInfo {
  id: string
  model: string
  collectedAt: string
  channel?: string
  cellCount: number
}

export function listBundledReferences(): BundledReferenceInfo[] {
  const file = loadFile()
  return Object.entries(file.models).map(([id, entry]) => ({
    id,
    model: entry.model,
    collectedAt: entry.collectedAt,
    channel: entry.channel,
    cellCount: Object.keys(entry.cells).length,
  }))
}

export function getBundledAttribution(): SampleReferenceSource {
  return loadFile().source
}

function entryToFingerprint(id: string, entry: SampleReferenceEntry, file: SampleReferenceFile): Fingerprint {
  const cells: Partial<Record<CellId, CellDistribution>> = {}
  for (const [cellKey, cell] of Object.entries(entry.cells)) {
    if (!isCellId(cellKey)) continue
    const cellId = cellKey
    const entropyBits = shannonEntropyBits(cell.counts)
    const size = domainSize(getTaskSpec(cellId).domain)
    cells[cellId] = {
      cellId,
      counts: cell.counts,
      validCount: cell.n,
      invalidCount: 0,
      refusalCount: 0,
      emptyCount: 0,
      errorCount: 0,
      totalCount: cell.n,
      entropyBits,
      normalizedEntropy: size > 1 ? Math.min(1, entropyBits / Math.log2(size)) : 0,
      medianLatencyMs: null,
      meanCompletionTokens: null,
      meanReasoningTokens: null,
    }
  }
  return {
    formatVersion: FINGERPRINT_FORMAT_VERSION,
    protocol: file.protocol,
    model: entry.model,
    collectedAt: entry.collectedAt,
    samplesPerCell: file.samplesPerCell,
    postReasoning: false,
    cells,
    meta: {
      source: `${file.source.dataset} (DOI ${file.source.datasetDoi}, ${file.source.license})`,
      channel: entry.channel,
      note: `Bundled sample reference "${id}"`,
    },
  }
}

/** Load one bundled reference as a runtime Fingerprint. */
export function loadBundledReference(id: string): Fingerprint {
  const file = loadFile()
  if (!Object.hasOwn(file.models, id)) {
    const available = Object.keys(file.models).sort().join(', ')
    throw new Error(`Unknown bundled reference "${id}". Available: ${available}`)
  }
  const entry = file.models[id]
  return entryToFingerprint(id, entry, file)
}

/** Parse and strictly validate a complete V1 or V2 fingerprint JSON artifact. */
export function parseFingerprintJson(text: string, sourceLabel = 'fingerprint file'): Fingerprint {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${sourceLabel} is not valid JSON: ${(error as Error).message}`)
  }
  return validateFingerprint(parsed, { sourceLabel, rejectPartial: true })
}
