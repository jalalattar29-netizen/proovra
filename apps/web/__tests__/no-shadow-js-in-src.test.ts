/**
 * Phase CASES-EVIDENCE-NAMES-ROOT-CAUSE — repo-wide hygiene gate.
 *
 * Backend packages (`services/api`, `services/worker`) are pure
 * TypeScript. Their ESM imports use explicit `.js` extensions per
 * Node ESM resolver rules (e.g.
 * `import { x } from "./foo.service.js"`). When a stale `foo.js`
 * sits beside `foo.ts` inside `src/`, Node loads the `.js` file
 * literally and tsx never transpiles the `.ts`. The
 * consequence is invisible: edits to the `.ts` source are
 * silently ignored at runtime.
 *
 * That is exactly how the "Untitled evidence" fix went live
 * without effect — a stale `matter-workspace.service.js` (from
 * 2026-06-03) shadowed every subsequent `.ts` edit, including
 * the one that added `displayFileName` / `originalFileName` /
 * `mimeType` / `_count.parts` to the matter-workspace evidence
 * payload. The frontend resolver had nothing to fall through to,
 * so it kept returning the literal `"Untitled evidence"` baked
 * into the stale `.js`.
 *
 * The compiled output belongs in `dist/`. Any `.js` inside
 * `services/api/src/` or `services/worker/src/` is a build
 * artifact that should not exist. This test fails the moment one
 * is reintroduced.
 *
 * (Web app lives in `apps/web/` and uses Next.js, which compiles
 * to `.next/` — not affected by this hygiene rule.)
 */

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

function* walk(root: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(root, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function findShadowJs(packageSrc: string): string[] {
  const root = resolve(REPO_ROOT, packageSrc);
  const shadows: string[] = [];
  for (const file of walk(root)) {
    if (!file.endsWith(".js") && !file.endsWith(".js.map")) continue;
    shadows.push(relative(REPO_ROOT, file));
  }
  return shadows;
}

test("services/api/src/ contains zero compiled .js artifacts (TypeScript-only package)", () => {
  const shadows = findShadowJs("services/api/src");
  assert.deepEqual(
    shadows,
    [],
    `Stale .js shadows found under services/api/src/. These files shadow their .ts siblings at ESM runtime and silently void any code change to the .ts source.

  Found:\n${shadows.map((s) => `    ${s}`).join("\n")}\n\nDelete them. Compiled output belongs in services/api/dist/.`,
  );
});

test("services/worker/src/ contains zero compiled .js artifacts (TypeScript-only package)", () => {
  const shadows = findShadowJs("services/worker/src");
  assert.deepEqual(
    shadows,
    [],
    `Stale .js shadows found under services/worker/src/. These files shadow their .ts siblings at ESM runtime and silently void any code change to the .ts source.

  Found:\n${shadows.map((s) => `    ${s}`).join("\n")}\n\nDelete them. Compiled output belongs in services/worker/dist/.`,
  );
});

test(".gitignore excludes future src/**/*.js shadow artifacts in API + worker", () => {
  // Anti-regression: even if someone runs `tsc` locally and
  // generates new shadows, git will not accept them.
  const gitignore = readdirSync(REPO_ROOT).includes(".gitignore");
  assert.ok(gitignore, ".gitignore missing at repo root");
  const text = readFileSync(resolve(REPO_ROOT, ".gitignore"), "utf8");
  assert.match(text, /services\/api\/src\/\*\*\/\*\.js/);
  assert.match(text, /services\/worker\/src\/\*\*\/\*\.js/);
});
