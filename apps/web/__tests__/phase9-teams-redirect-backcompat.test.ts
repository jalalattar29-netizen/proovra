/**
 * Phase 9 audit — regression lock: `/teams` → `/workspaces` backcompat
 * redirect must remain in `apps/web/next.config.js`.
 *
 * Context (Phase 9 binding rules):
 *   - Team is NOT Workspace. Workspace kinds remain ONLY PERSONAL,
 *     ORGANIZATION. Team is a separate collaboration feature available
 *     inside both PERSONAL and ORGANIZATION workspaces.
 *   - In a prior phase (Final-Closure-Remediation), the legacy
 *     `/teams` URL was collapsed because it had become a duplicate of
 *     the canonical `/workspaces` admin surface. The redirect was put
 *     in place so deep links to `/teams` (bookmarks, emails, external
 *     docs) keep resolving.
 *   - If a future refactor accidentally drops the redirect, those deep
 *     links 404. Worse, since "Team" and "Workspace" are intentionally
 *     distinct concepts under the Phase 9 vocabulary contract, a fresh
 *     `/teams` page added later would collide with the legacy URL
 *     semantics. The redirect is the seam that keeps the old URL
 *     pointing at the canonical admin surface while the live "Team"
 *     feature lives at its own routes.
 *
 * This test reads `next.config.js` as plain text and asserts the
 * canonical redirect entry is present. We intentionally do NOT import
 * the config: Next's config file is ESM-with-side-effects and pulling
 * it into a test runtime would drag in the Next build pipeline. Plain
 * substring assertions are sufficient to catch accidental deletion.
 *
 * Allowed fix kind under Phase 9: NEW_TEST (regression lock only).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NEXT_CONFIG_PATH = resolve(__dirname, "..", "next.config.js");

const NEXT_CONFIG_SOURCE = readFileSync(NEXT_CONFIG_PATH, "utf8");

test("next.config.js declares an async redirects() function", () => {
  assert.match(
    NEXT_CONFIG_SOURCE,
    /async\s+redirects\s*\(\s*\)\s*\{/,
    "next.config.js must expose an async redirects() function — the " +
      "Phase 9 backcompat redirects live inside it.",
  );
});

test("next.config.js contains the canonical /teams → /workspaces redirect", () => {
  // Match the entry tolerantly: order of keys, quote style, and
  // whitespace can drift across formatter passes. What we care about
  // is the (source, destination, permanent: true) triple appearing
  // together in a single redirect object literal.
  const redirectPattern =
    /\{\s*source:\s*["']\/teams["']\s*,\s*destination:\s*["']\/workspaces["']\s*,\s*permanent:\s*true\s*,?\s*\}/;

  assert.match(
    NEXT_CONFIG_SOURCE,
    redirectPattern,
    "The Phase 9 audit requires that next.config.js continues to " +
      "redirect `/teams` → `/workspaces` (permanent). This redirect " +
      "was introduced when the duplicate `/teams` page was retired " +
      "in favor of the canonical `/workspaces` admin surface. " +
      "Removing it would 404 every legacy deep link and break the " +
      "Workspace vs Team vocabulary contract that Phase 9 locks in.",
  );
});

test("the /teams redirect is permanent (308), not temporary (307)", () => {
  // Belt-and-braces: a future contributor might preserve the source
  // and destination but flip `permanent: true` → `false`. That would
  // silently demote the redirect from 308 → 307, which breaks
  // search-engine canonicalization and confuses HTTP caches. Lock the
  // status explicitly.
  const teamsBlockMatch = NEXT_CONFIG_SOURCE.match(
    /\{\s*source:\s*["']\/teams["'][\s\S]*?\}/,
  );

  assert.ok(
    teamsBlockMatch,
    "Could not locate the `/teams` redirect block in next.config.js.",
  );

  assert.match(
    teamsBlockMatch![0],
    /permanent:\s*true/,
    "The `/teams` redirect must remain permanent (308). Phase 9 " +
      "treats legacy URL collapses as canonical moves, not " +
      "temporary diversions.",
  );

  assert.doesNotMatch(
    teamsBlockMatch![0],
    /permanent:\s*false/,
    "The `/teams` redirect must not be flipped to a temporary " +
      "(307) redirect.",
  );
});

test("the /teams redirect destination is exactly /workspaces (not /workspaces/...)", () => {
  // Guard against a well-meaning but wrong refactor: pointing
  // `/teams` at a deeper page (e.g. `/workspaces/teams` or
  // `/workspaces/list`) would re-tangle the Team vs Workspace
  // vocabulary. The canonical destination is the `/workspaces` admin
  // landing exactly.
  const teamsBlockMatch = NEXT_CONFIG_SOURCE.match(
    /\{\s*source:\s*["']\/teams["'][\s\S]*?\}/,
  );

  assert.ok(
    teamsBlockMatch,
    "Could not locate the `/teams` redirect block in next.config.js.",
  );

  assert.match(
    teamsBlockMatch![0],
    /destination:\s*["']\/workspaces["']/,
    "The `/teams` redirect must target `/workspaces` exactly. A " +
      "deeper destination would re-introduce the Team/Workspace " +
      "vocabulary collision that Phase 9 forbids.",
  );
});
