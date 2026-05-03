#!/usr/bin/env node
// Prepare a flat, prod-only sidecar bundle that Tauri ships in
// Resources/. Runs before `tauri build` (wired via package.json's
// `prebuild` hook). Idempotent: nukes the dest first.
//
// Layout produced:
//   src-tauri/sidecar-bundle/
//     package.json
//     dist/             ← compiled JS from sidecar/dist
//     migrations/       ← drizzle SQL migrations
//     node_modules/     ← prod deps, hoisted (no .pnpm/symlink trickery)
//
// The dest path is referenced by tauri.conf.json's bundle.resources, so
// every file lands under Resources/ in the packaged .app. spawn_sidecar
// resolves the script via app.path().resource_dir() at runtime.

import { execSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const sidecarSrc = join(repoRoot, "sidecar");
const sidecarDist = join(sidecarSrc, "dist");
const sidecarMigrations = join(sidecarSrc, "migrations");
const sidecarPkg = join(sidecarSrc, "package.json");
const sidecarLock = join(sidecarSrc, "pnpm-lock.yaml");
const dest = join(repoRoot, "src-tauri", "sidecar-bundle");

if (!existsSync(sidecarDist)) {
  console.error("package-sidecar: sidecar/dist not found — run `pnpm sidecar:build` first.");
  process.exit(1);
}

console.log("package-sidecar: cleaning", dest);
// Keep the directory itself + the .gitkeep that anchors it in git, so
// Tauri's codegen still resolves bundle.resources between builds.
// Wipe everything else.
mkdirSync(dest, { recursive: true });
for (const name of readdirSync(dest)) {
  if (name === ".gitkeep") continue;
  rmSync(join(dest, name), { recursive: true, force: true });
}

console.log("package-sidecar: copying dist + migrations + package.json + lockfile");
cpSync(sidecarDist, join(dest, "dist"), { recursive: true });
cpSync(sidecarMigrations, join(dest, "migrations"), { recursive: true });
copyFileSync(sidecarPkg, join(dest, "package.json"));
copyFileSync(sidecarLock, join(dest, "pnpm-lock.yaml"));

console.log("package-sidecar: installing prod deps (hoisted layout)");
// node-linker=hoisted gives a flat node_modules with no .pnpm symlink
// store, which Tauri's resource bundler copies cleanly.
execSync(
  "corepack pnpm install --prod --frozen-lockfile --config.node-linker=hoisted",
  { cwd: dest, stdio: "inherit" },
);

console.log("package-sidecar: done");
