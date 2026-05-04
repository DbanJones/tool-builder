import { ResultAsync } from "neverthrow";

import { sidecarCall, type SidecarError } from "@/lib/sidecar/client";

export type EasterEggFindingCheck = "project" | "marker" | "text" | "shortcut";

export interface EasterEggFinding {
  check: EasterEggFindingCheck;
  ok: boolean;
  message: string;
}

export interface EasterEggVerifyResult {
  ok: boolean;
  findings: EasterEggFinding[];
  filesScanned: number;
  bytesScanned: number;
}

export type EasterEggError =
  | { kind: "Transport"; message: string }
  | { kind: "Sidecar"; code: string; message: string };

const fromSidecarError = (e: SidecarError): EasterEggError =>
  e.kind === "Sidecar"
    ? { kind: "Sidecar", code: e.code, message: e.message }
    : { kind: "Transport", message: e.message };

export function verifyDavidEasterEgg(
  projectId: string,
): ResultAsync<EasterEggVerifyResult, EasterEggError> {
  return sidecarCall<EasterEggVerifyResult>("easterEgg.verify", { projectId }).mapErr(
    fromSidecarError,
  );
}
