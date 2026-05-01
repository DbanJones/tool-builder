// Public surface of the Debug module. Phase G G2a ships the taxonomy +
// priority scoring + detector interface only; concrete detectors land in
// G2b and the sidecar `debug.scan` handler in G2c. See ADR-0007.

export {
  bandOf,
  BAND_RANGES,
  CLASS_META,
  type Band,
  type BandRange,
  type ClassMeta,
  type DefectClass,
} from "./taxonomy";
export {
  priority,
  type PriorityInputs,
  type PriorityResult,
  type UserMode,
} from "./priority";
export {
  type Detector,
  type DetectorError,
  type RawFinding,
  type ScanContext,
} from "./detectors/types";
