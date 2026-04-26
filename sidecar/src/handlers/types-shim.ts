// Local shim of the IngestedFileKind union to avoid the sidecar importing
// from the main app. lib/files/types.ts is the canonical source; keep the two
// in sync (a follow-up could lift this into a shared package).

export type IngestedFileKindLite =
  | "document"
  | "image"
  | "schema"
  | "data"
  | "url"
  | "unknown";
