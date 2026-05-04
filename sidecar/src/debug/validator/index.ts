// Public surface of the Layer 2 validator module. G4c's handler uses
// these; G4d's webview wrapper consumes the same shapes through the
// JSON-RPC wire.

export { extractSlice, renderContext, type SubgraphSlice } from "./slice.js";
export { renderPrompt, type RenderedPrompt } from "./prompt.js";
export {
  parseValidatorResponse,
  sdkTransport,
  stubTransport,
  validateFinding,
  type ValidatorResult,
  type ValidatorTransport,
  type ValidatorVerdict,
} from "./driver.js";
