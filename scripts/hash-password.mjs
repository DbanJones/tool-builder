#!/usr/bin/env node
// Hash a password into the SHA-256 hex digest used by lib/demo/config.ts.
//
// Usage:
//   node scripts/hash-password.mjs "my-new-password"
//
// Then paste the printed hash into PASSWORD_SHA256 in lib/demo/config.ts.
//
// .mjs (not .ts) so it runs without a transpiler step — keeps the workflow
// portable and avoids adding tsx as a dev dependency just for this.

import { createHash } from "node:crypto";

const password = process.argv[2];
if (typeof password !== "string" || password.length === 0) {
  console.error("Usage: node scripts/hash-password.mjs <password>");
  process.exit(2);
}

const digest = createHash("sha256").update(password).digest("hex");
console.log(digest);
