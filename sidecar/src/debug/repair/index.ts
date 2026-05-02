// Public surface of the repair engine. G5c's debug.applyFix handler
// imports from here.

export {
  abortBranch,
  commitAll,
  openBranch,
  squashOntoBase,
  type BranchSession,
  type RunGit,
  type RunResult,
} from "./branch.js";
export { dispatchTier1, hasTier1Codemod } from "./dispatcher.js";
export type { CodemodResult } from "./types.js";
