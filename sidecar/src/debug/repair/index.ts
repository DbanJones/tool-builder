// Public surface of the repair engine. G5c's debug.applyFix handler
// imports from here.

export {
  abortBranch,
  commitAll,
  headCommit,
  openBranch,
  revertCommit,
  squashOntoBase,
  type BranchSession,
  type RunGit,
  type RunResult,
} from "./branch.js";
export { dispatchTier1, hasTier1Codemod } from "./dispatcher.js";
export {
  sdkPatchTransport,
  stubPatchTransport,
  type PatchEdit,
  type PatchResponse,
  type PatchTransport,
} from "./patch-driver.js";
export { MAX_TIER2_ATTEMPTS, runTier2, type Tier2Outcome } from "./tier2.js";
export type { CodemodResult } from "./types.js";
