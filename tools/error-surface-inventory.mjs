#!/usr/bin/env node
/**
 * THE ERROR SURFACE — every rejection the product can produce, and what each
 * client actually SAYS about it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The web app has a 93-entry dictionary turning a backend code into calm,
 * actionable copy. The native app has none: it classifies by HTTP status alone
 * and answers from eight generic sentences. So on a phone, a plan limit, a
 * legal hold, an org-lifecycle refusal and a genuine permission problem are
 * all "You don't have access to this." — and every 409 conflict, which is the
 * shape of most product refusals, reads "Something went wrong. Please try
 * again." for something retrying will never fix.
 *
 * That is not a copy problem. It is the product telling a person the wrong
 * thing about their own work, on the client most likely to be used under
 * pressure.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MEASURES, AND FROM WHAT
 * ---------------------------------------------------------------------------
 * Nothing here is typed by hand. Three inventories are read from the tree:
 *
 *   PRODUCED   every code the API can emit — the `ErrorCode` enum, plus every
 *              string literal handed to `AppError`, `code:` on an error
 *              envelope, or a `denial:` reply.
 *   WEB        the codes `apps/web/lib/feedback/toSafeUserError.ts` maps, plus
 *              any code a web file names directly.
 *   NATIVE     the codes `apps/mobile` names anywhere — a shared dictionary
 *              entry, a screen comparing `err.code`, or a product module.
 *
 * A code PRODUCED and consumed by neither client is not necessarily a defect:
 * plenty are internal, or reach a user only as a status bucket. The rows that
 * matter are the ones a person can actually provoke, and the report ranks by
 * that rather than by count.
 *
 * Usage:  node tools/error-surface-inventory.mjs [--json] [--check]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".expo",
  "ios",
  "android",
  "test-results",
  "playwright-report",
  "audit-output",
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (abs) => relative(REPO, abs).split(sep).join("/");

/** A code is SHOUT_CASE with at least one underscore — never a random word. */
const CODE_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Codes the API can actually emit.
 *
 * Read from the places that PRODUCE one, not from a list somebody keeps: the
 * canonical enum, `new AppError(ErrorCode.X | "X")`, `code: "X"` on a reply,
 * and `denial: "X"` — the capture-trust surfaces answer with that shape.
 */
function producedCodes() {
  const found = new Map(); // code -> Set(file)
  const add = (code, file) => {
    if (!CODE_SHAPE.test(code)) return;
    if (!found.has(code)) found.set(code, new Set());
    found.get(code).add(rel(file));
  };

  const enumFile = join(REPO, "services/api/src/errors.ts");
  const enumSrc = readFileSync(enumFile, "utf8");
  for (const m of enumSrc.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*"([A-Z][A-Z0-9_]+)"/gm)) {
    add(m[2], enumFile);
  }

  for (const file of walk(join(REPO, "services/api/src"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bcode:\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1], file);
    for (const m of src.matchAll(/\bdenial:\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1], file);
    for (const m of src.matchAll(/new AppError\(\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1], file);
    for (const m of src.matchAll(/DirectCaptureError\(\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1], file);
  }
  return found;
}

/** Codes each client NAMES, and where. */
function clientCodes(root, extra = []) {
  const found = new Map();
  const files = [...walk(join(REPO, root)), ...extra.map((p) => join(REPO, p))];
  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (/\.(test|spec)\.[tm]sx?$/.test(file) || /__tests__/.test(file)) continue;
    for (const m of src.matchAll(/"([A-Z][A-Z0-9_]+)"|'([A-Z][A-Z0-9_]+)'/g)) {
      const code = m[1] ?? m[2];
      if (!CODE_SHAPE.test(code)) continue;
      if (!found.has(code)) found.set(code, new Set());
      found.get(code).add(rel(file));
    }
    // The web dictionary's keys are bare identifiers, not string literals.
    if (file.endsWith("toSafeUserError.ts")) {
      for (const m of src.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s*\{/gm)) {
        const code = m[1];
        if (!CODE_SHAPE.test(code)) continue;
        if (!found.has(code)) found.set(code, new Set());
        found.get(code).add(rel(file));
      }
    }
  }
  return found;
}

/** The shared dictionary, when one exists — the goal state for both clients. */
function sharedDictionaryCodes() {
  const file = join(REPO, "packages/shared/src/user-facing-errors.ts");
  const found = new Set();
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return found;
  }
  for (const m of src.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s*\{/gm)) {
    if (CODE_SHAPE.test(m[1])) found.add(m[1]);
  }
  return found;
}

export function inventory() {
  const produced = producedCodes();
  const web = clientCodes("apps/web", ["apps/web/lib/feedback/toSafeUserError.ts"]);
  const native = clientCodes("apps/mobile");
  const shared = sharedDictionaryCodes();

  const rows = [];
  for (const [code, files] of produced) {
    const webFiles = web.get(code);
    const nativeFiles = native.get(code);
    // A code in the SHARED dictionary is answered on both clients: each
    // resolver reads it before falling back to its status buckets. Counting
    // it only where a file happens to name the string would understate the
    // coverage the move created — and understating it is how somebody
    // "fixes" it twice.
    const inShared = shared.has(code);
    rows.push({
      code,
      producedIn: [...files].slice(0, 4),
      producedCount: files.size,
      web: inShared || Boolean(webFiles),
      webFiles: webFiles ? [...webFiles].slice(0, 3) : [],
      native: inShared || Boolean(nativeFiles),
      nativeFiles: nativeFiles ? [...nativeFiles].slice(0, 3) : [],
      shared: inShared,
    });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));

  const counts = {
    produced: rows.length,
    web: rows.filter((r) => r.web).length,
    native: rows.filter((r) => r.native).length,
    shared: rows.filter((r) => r.shared).length,
    neither: rows.filter((r) => !r.web && !r.native).length,
    webOnly: rows.filter((r) => r.web && !r.native).length,
    nativeOnly: rows.filter((r) => r.native && !r.web).length,
  };
  return { rows, counts };
}

/* -------------------------------------------------------------------- main */

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { rows, counts } = inventory();
  console.log(
    `error codes produced by the API: ${counts.produced}  ` +
      `web ${counts.web}  native ${counts.native}  shared-dictionary ${counts.shared}  ` +
      `named by neither client ${counts.neither}`,
  );

  if (process.argv.includes("--json")) {
    const out = join(REPO, "docs/architecture/error-surface-inventory.json");
    writeFileSync(out, `${JSON.stringify({ counts, rows }, null, 2)}\n`);
    console.log(`wrote ${rel(out)}`);
  }
}
