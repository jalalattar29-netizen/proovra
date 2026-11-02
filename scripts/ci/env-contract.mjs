#!/usr/bin/env node
/**
 * OPS-003 — A VARIABLE THAT READS AS A CONTROL EITHER GOVERNS BEHAVIOUR OR DOES NOT
 * EXIST.
 *
 * The example env files named switches and secrets no code reads, so setting one
 * changed nothing while looking like a control. This fails when a name in an example
 * file has no reader in code, unless scripts/ci/env-contract.allow.json states why.
 *
 * A compose file passing a name through is not a reader: LOG_AGGREGATION_ENABLED was
 * passed everywhere and read nowhere. Scans source as text, so a name built at run
 * time must be listed in the allowance with the place that builds it.
 *
 *   node scripts/ci/env-contract.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const EXAMPLE_FILES = ["services/api/.env.example", "services/worker/.env.example"];

const SOURCE_ROOTS = [
  "services/api/src",
  "services/api/scripts",
  "services/api/prisma.config.ts",
  "services/worker/src",
  "packages/shared/src",
  "packages/shared-runtime/src",
  "apps/web/app",
  "apps/web/lib",
  "apps/web/components",
  "apps/web/middleware.ts",
  "apps/web/next.config.js",
  "scripts/deploy-prod-pull.sh",
  "scripts/ops",
];
const CODE = /\.(ts|tsx|mjs|cjs|js|sh)$/;

function* files(path) {
  if (!existsSync(path)) return;
  if (statSync(path).isFile()) {
    if (CODE.test(path)) yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    yield* files(join(path, entry));
  }
}

export function exampleKeys(repo = REPO) {
  const keys = new Map();
  for (const rel of EXAMPLE_FILES) {
    const p = join(repo, rel);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (m) keys.set(m[1], rel);
    }
  }
  return keys;
}

export function loadAllowance(repo = REPO) {
  return JSON.parse(readFileSync(join(repo, "scripts", "ci", "env-contract.allow.json"), "utf8"));
}

export function unreadKeys(repo = REPO) {
  const haystack = [];
  for (const root of SOURCE_ROOTS) {
    for (const f of files(join(repo, root))) haystack.push(readFileSync(f, "utf8"));
  }
  const text = haystack.join("\n");
  const allowed = Object.keys(loadAllowance(repo)).map((k) => new RegExp(`^${k.replace(/\*/g, "[A-Z0-9_]*")}\x24`));
  const out = [];
  for (const [key, file] of exampleKeys(repo)) {
    if (allowed.some((re) => re.test(key))) continue;
    if (!new RegExp(`(?<![A-Z0-9_])${key}(?![A-Z0-9_])`).test(text)) out.push({ key, file: relative(repo, join(repo, file)) });
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const unread = unreadKeys();
  for (const { key, file } of unread) console.error(`${file}: ${key} has no reader`);
  if (unread.length > 0) {
    console.error(`env-contract: ${unread.length} name(s) with no reader. Remove them, or state why in env-contract.allow.json.`);
    process.exit(1);
  }
  console.log("env-contract: every example name has a reader or a stated reason.");
}
