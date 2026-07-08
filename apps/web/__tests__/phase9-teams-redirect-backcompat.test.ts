/**
 * `/teams` URL contract — REWRITTEN by Phase 2B (Teams/Workspace
 * consolidation).
 *
 * History:
 *   - Phase Final-Closure-Remediation collapsed a then-duplicate `/teams`
 *     page into `/workspaces` and added a permanent server redirect.
 *   - Phase IA-self-serve-completion shipped a separate self-serve landing
 *     at `app/(app)/teams/page.tsx` and removed that redirect, so `/teams`
 *     rendered its own "Your teams" list.
 *   - Phase 2B resolves the parallel-surface problem per the Product
 *     Constitution: `/collaboration-teams` is the SINGLE canonical Teams
 *     product. The parallel `/teams` landing was DELETED; the bare `/teams`
 *     URL now 308s to `/collaboration-teams`, and the `/workspaces`
 *     self-serve redirect target was repointed from `/teams` to
 *     `/collaboration-teams` (no redirect loop). `/teams/[id]` (legacy team
 *     detail on `/v1/teams`) is retained for the backend migration phase.
 *
 * This test locks the Phase 2B contract so the deleted parallel landing
 * cannot silently return and no redirect loop can form.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NEXT_CONFIG_PATH = resolve(__dirname, "..", "next.config.js");
const TIERS_PATH = resolve(__dirname, "..", "lib", "surface", "tiers.ts");
const TEAMS_LANDING_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "teams",
  "page.tsx",
);
const TEAMS_DETAIL_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "teams",
  "[id]",
  "page.tsx",
);

const NEXT_CONFIG_SOURCE = readFileSync(NEXT_CONFIG_PATH, "utf8");
const TIERS_SOURCE = readFileSync(TIERS_PATH, "utf8");

test("the parallel self-serve /teams landing page is DELETED (canonical Teams is /collaboration-teams)", () => {
  assert.equal(
    existsSync(TEAMS_LANDING_PATH),
    false,
    "app/(app)/teams/page.tsx must NOT exist — it was a parallel Teams " +
      "surface duplicating the canonical /collaboration-teams product and " +
      "was deleted in Phase 2B.",
  );
});

test("bare /teams 308s to the canonical /collaboration-teams product", () => {
  assert.match(
    NEXT_CONFIG_SOURCE,
    /\{\s*source:\s*["']\/teams["']\s*,\s*destination:\s*["']\/collaboration-teams["']/,
    "next.config.js must redirect the bare /teams URL to the canonical " +
      "Teams product /collaboration-teams so old bookmarks keep working.",
  );
});

test("/teams/[id] legacy detail is retained (deferred to the backend migration phase)", () => {
  assert.equal(
    existsSync(TEAMS_DETAIL_PATH),
    true,
    "app/(app)/teams/[id]/page.tsx must remain — it is the legacy team " +
      "detail on /v1/teams and is deferred to the backend phase. The bare " +
      "/teams redirect is EXACT and must not shadow it.",
  );
});

test("/workspaces self-serve redirect target is /collaboration-teams (no /teams loop)", () => {
  assert.match(
    TIERS_SOURCE,
    /pathPrefix:\s*["']\/workspaces["'][\s\S]{0,300}?redirectTo:\s*["']\/collaboration-teams["']/,
    "lib/surface/tiers.ts must redirect self-serve /workspaces to " +
      "/collaboration-teams. Pointing it back at /teams would form a loop " +
      "with the /teams → /collaboration-teams redirect.",
  );
  assert.doesNotMatch(
    TIERS_SOURCE,
    /pathPrefix:\s*["']\/workspaces["'][\s\S]{0,300}?redirectTo:\s*["']\/teams["']/,
    "The /workspaces → /teams self-serve redirect must be gone (loop risk).",
  );
});
