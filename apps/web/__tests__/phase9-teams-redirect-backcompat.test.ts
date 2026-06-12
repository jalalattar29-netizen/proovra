/**
 * Phase 9 audit — `/teams` URL contract. REWRITTEN by Phase
 * HOME-DATA-OWNERSHIP.
 *
 * History:
 *   - Phase Final-Closure-Remediation collapsed a then-duplicate
 *     `/teams` page into `/workspaces` and added a permanent server
 *     redirect. The original version of this test locked that redirect.
 *   - Phase IA-self-serve-completion later shipped a REAL self-serve
 *     landing page at `app/(app)/teams/page.tsx` ("Your teams") and
 *     pointed Home's "Invite a teammate" checklist step at `/teams` —
 *     but the Phase 9 redirect still fired first, so the page was
 *     unreachable and every personal-space user who clicked "Invite a
 *     teammate" landed on `/workspaces`, whose `admin.teams`
 *     PageRouteGate (TEAM_VIEW) rendered a BLANK page.
 *   - Phase HOME-DATA-OWNERSHIP resolves the collision: `/teams` is
 *     canonical for self-serve team management; the redirect is GONE.
 *     Legacy deep links to `/workspaces` are mapped back to `/teams`
 *     for self-serve plans by the surface-tier rule in
 *     `lib/surface/tiers.ts` (`/workspaces` → redirectTo "/teams").
 *
 * This test now locks the corrected contract so the blank-page
 * regression can never silently return.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NEXT_CONFIG_PATH = resolve(__dirname, "..", "next.config.js");
const TIERS_PATH = resolve(__dirname, "..", "lib", "surface", "tiers.ts");
const TEAMS_PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "teams",
  "page.tsx",
);

const NEXT_CONFIG_SOURCE = readFileSync(NEXT_CONFIG_PATH, "utf8");
const TIERS_SOURCE = readFileSync(TIERS_PATH, "utf8");
const TEAMS_PAGE_SOURCE = readFileSync(TEAMS_PAGE_PATH, "utf8");

test("next.config.js does NOT redirect /teams away (the self-serve landing must be reachable)", () => {
  const redirectPattern =
    /\{\s*source:\s*["']\/teams["']\s*,\s*destination:/;

  assert.doesNotMatch(
    NEXT_CONFIG_SOURCE,
    redirectPattern,
    "A server redirect for `/teams` shadows app/(app)/teams/page.tsx " +
      "entirely — Home's 'Invite a teammate' CTA then lands on the " +
      "gated /workspaces surface, which renders BLANK for personal-" +
      "space users. /teams is the canonical self-serve team surface; " +
      "do not reintroduce the redirect.",
  );
});

test("the self-serve /teams landing page exists and renders real content", () => {
  assert.match(
    TEAMS_PAGE_SOURCE,
    /TeamsLandingPage/,
    "app/(app)/teams/page.tsx must export the self-serve teams landing.",
  );
  // It must not be wrapped in the admin.teams gate that blanked it
  // historically (capability TEAM_VIEW is not held by personal users).
  // Assert on the IMPORT — the page header comment legitimately
  // mentions the gate string when documenting the old bug.
  assert.doesNotMatch(
    TEAMS_PAGE_SOURCE,
    /import\s*\{[^}]*PageRouteGate[^}]*\}/,
    "The /teams landing must not re-wrap itself in the admin.teams " +
      "gate — that gate denies personal-space users and produced the " +
      "historic blank page.",
  );
});

test("legacy /workspaces deep links map back to /teams for self-serve (tier rule)", () => {
  assert.match(
    TIERS_SOURCE,
    /pathPrefix:\s*["']\/workspaces["'][\s\S]{0,200}?redirectTo:\s*["']\/teams["']/,
    "lib/surface/tiers.ts must keep the /workspaces → /teams mapping " +
      "so legacy bookmarks keep resolving for self-serve users.",
  );
});
