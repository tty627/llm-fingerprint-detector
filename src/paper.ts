/**
 * Node-only, explicitly opt-in paper-profile collection surface.
 *
 * Import from `llm-fingerprint-detector/paper`; this module is intentionally
 * absent from the package's browser-oriented root entrypoint.
 */

export * from './paper-collector.js'
export * from './paper-http.js'

export {
  BRUCKNER_2026_CANONICAL40_CELLS,
  BRUCKNER_2026_CANONICAL40_PROFILE,
  buildBruckner2026Canonical40Manifest,
} from './profiles/bruckner2026.js'
export type {
  Bruckner2026Canonical40Profile,
  Bruckner2026ProfileLanguage,
  Bruckner2026ProtocolCell,
  Bruckner2026TaskId,
} from './profiles/bruckner2026.js'

export type {
  CollectionPlan,
  CollectionQuality,
  FingerprintV2,
  ProtocolCellId,
  V2CellDistribution,
} from './types.js'
