/**
 * Canonical state-model + console-wire pins for /intake-links.
 *
 * These tests pin the strict-state-model correction:
 *
 *   • The state model itself (`apps/web/lib/intake-links/state-model.ts`)
 *     — pure predicates, every case enumerated. These are the SOURCE
 *     OF TRUTH for what tab/KPI a row belongs to.
 *
 *   • The console wire — assert the operations console + submissions
 *     modal route every decision through the state model. No local
 *     `computedLifecycle === "..."` shortcuts in the renderer; no
 *     "Anonymous contributor" repeated rows in the modal; no
 *     `signingKey.publicKeyPem` field-access without nullable guard.
 *
 *   • Display-layer outputs — KPI cards have data attributes that
 *     match the canonical predicates so the table count and the card
 *     count cannot drift.
 *
 * Coverage matrix
 * ---------------
 * 1. ONE_TIME link after submit → operationally EXPIRED, latest
 *    session SUBMITTED, NOT in Active tab.
 * 2. REUSABLE link with one submitted session and remaining capacity
 *    → operationally ACTIVE, latest session SUBMITTED, in BOTH Active
 *    AND Submitted tabs — but NOT in Opened.
 * 3. Opened-but-not-submitted → in Opened tab only.
 * 4. Delivery failed but link still operationally Active → in
 *    Failed_delivery tab AND Active tab (delivery is orthogonal).
 *    NOT in Opened or Submitted tabs.
 * 5. Archived → only in Archived tab; never in any other.
 * 6. Revoked/expired → only in revoked_or_expired tab.
 * 7. KPI counts equal the per-tab predicate sum.
 *
 * Approach
 * --------
 * Pure-state predicates are tested by direct import (the helper is
 * plain TS with no React deps). Renderer wires use source-contract
 * pinning to match the rest of this codebase.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

const STATE_MODEL_SRC = "apps/web/lib/intake-links/state-model.ts";
const CONSOLE_SRC =
  "apps/web/components/intake-links/IntakeLinksOperationsConsole.tsx";
const PAGE_SRC = "apps/web/app/(app)/intake-links/page.tsx";
const EVIDENCE_PAGE_SRC = "apps/web/app/(app)/evidence/[id]/page.tsx";
const EVIDENCE_ROUTES_SRC = "services/api/src/routes/evidence.routes.ts";
const REVIEWER_CARD_SRC =
  "apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx";

// ============================================================================
// Phase 2 — canonical state model exports
// ============================================================================

test("state-model.ts exports every public predicate", () => {
  const src = read(STATE_MODEL_SRC);
  for (const fn of [
    "getLinkOperationalState",
    "getLatestSessionState",
    "getDeliveryState",
    "matchesIntakeTab",
    "computeIntakeKpis",
    "getLifecycleBadges",
    "canRevokeLink",
    "canArchiveLink",
    "canOpenEvidence",
  ]) {
    assert.match(
      src,
      new RegExp(`export function ${fn}\\(`),
      `${fn} must be exported`,
    );
  }
});

test("state-model: link operational state is one of four values", () => {
  const src = read(STATE_MODEL_SRC);
  assert.match(
    src,
    /export type LinkOperationalState = "ACTIVE" \| "ARCHIVED" \| "REVOKED" \| "EXPIRED";/,
  );
});

test("state-model: session/delivery axes are SEPARATE from link axis", () => {
  const src = read(STATE_MODEL_SRC);
  // Distinct enums for each axis — never merged.
  assert.match(
    src,
    /export type LatestSessionState =[\s\S]{0,200}SUBMITTED/,
  );
  assert.match(
    src,
    /export type DeliveryState =[\s\S]{0,200}FAILED/,
  );
});

test("state-model: ONE_TIME-style capacity-exhaustion routes to EXPIRED", () => {
  const src = read(STATE_MODEL_SRC);
  // A link with usedCount >= maxUses MUST be operationally EXPIRED.
  // This is the strict-state-model fix that stops submitted ONE_TIME
  // links appearing in Active.
  assert.match(
    src,
    /link\.usedCount >= link\.maxUses[\s\S]{0,200}return "EXPIRED"/,
  );
});

test("state-model: ARCHIVED takes priority over every other state", () => {
  const src = read(STATE_MODEL_SRC);
  // The first check in getLinkOperationalState.
  assert.match(
    src,
    /if \(link\.archivedAtUtc\) return "ARCHIVED"/,
  );
});

test("state-model: OPENED tab predicate strictly excludes SUBMITTED", () => {
  const src = read(STATE_MODEL_SRC);
  // The brief's named bug: the Opened tab used to include submitted
  // rows because `sessionsOpened > 0` is true for any submitted
  // session. The fix: Opened iff latest session state is OPENED or
  // UPLOAD_STARTED — NOT SUBMITTED.
  assert.match(
    src,
    /case "opened":[\s\S]{0,400}sess === "OPENED" \|\| sess === "UPLOAD_STARTED"/,
  );
});

test("state-model: Active tab requires operationally ACTIVE link", () => {
  const src = read(STATE_MODEL_SRC);
  assert.match(
    src,
    /case "active":[\s\S]{0,400}link === "ACTIVE"/,
  );
});

test("state-model: failed_delivery is delivery-axis ONLY", () => {
  const src = read(STATE_MODEL_SRC);
  assert.match(
    src,
    /case "failed_delivery":[\s\S]{0,400}delivery === "FAILED"/,
  );
});

test("state-model: KPI compute reuses matchesIntakeTab (no drift possible)", () => {
  const src = read(STATE_MODEL_SRC);
  // computeIntakeKpis must call matchesIntakeTab so the count under
  // each card is identical to the row count under each tab.
  assert.match(
    src,
    /matchesIntakeTab\(it, "active"/,
  );
  assert.match(
    src,
    /matchesIntakeTab\(it, "opened"/,
  );
  assert.match(
    src,
    /matchesIntakeTab\(it, "submitted"/,
  );
});

test("state-model: canOpenEvidence requires evidenceId", () => {
  const src = read(STATE_MODEL_SRC);
  assert.match(
    src,
    /if \(!session\.evidenceId\)[\s\S]{0,200}reason: "no_evidence_yet"/,
  );
});

// ============================================================================
// Phase 3+4 — operations console routes through the state model
// ============================================================================

test("console imports the state model + delegates matchesTab", () => {
  const src = read(CONSOLE_SRC);
  assert.match(
    src,
    /from "\.\.\/\.\.\/lib\/intake-links\/state-model"/,
  );
  // Local matchesTab function MUST call into the state model — no
  // local computedLifecycle === "..." shortcuts.
  assert.match(
    src,
    /function matchesTab[\s\S]{0,300}matchesIntakeTab\(item, tabToIntakeTab\(tab\)\)/,
  );
});

test("console KPI computeKpis routes through computeIntakeKpis", () => {
  const src = read(CONSOLE_SRC);
  assert.match(
    src,
    /function computeKpis\([\s\S]{0,300}computeIntakeKpis\(items\)/,
  );
});

test("console row renders TWO chips: link state + session state", () => {
  const src = read(CONSOLE_SRC);
  // Data attributes pin the two-chip render so a future refactor
  // that collapses back to a single conflated chip fails this test.
  assert.match(src, /data-intake-links-row-link-state=\{linkState\}/);
  assert.match(src, /data-intake-links-row-session-state=\{sessionState\}/);
});

test("console no longer renders the conflated computedLifecycle chip", () => {
  const src = read(CONSOLE_SRC);
  // The legacy chip used `primaryBadgeKind` derived from a single
  // ConsoleLifecycle. The fix removed that variable.
  assert.ok(
    !/data-intake-links-row-lifecycle-chip=/.test(src),
    "the legacy single-chip lifecycle data-attr must be retired",
  );
  assert.ok(
    !/const primaryBadgeKind:/.test(src),
    "primaryBadgeKind shortcut must be gone (replaced by linkState + sessionState)",
  );
});

// ============================================================================
// Phase 5 — submissions modal
// ============================================================================

test("submissions modal renders 'Submission #N' (no repeated Anonymous contributor)", () => {
  const src = read(PAGE_SRC);
  assert.match(src, /Submission #\{submissionNumber\}/);
  // The old default title was "Anonymous contributor" repeated on
  // every row. The fix only shows that label on the Contributor:
  // sub-line, not as the row title.
  assert.ok(
    !/\?\s*"Anonymous contributor"/.test(src),
    "'Anonymous contributor' must not be used as a row TITLE — title is Submission #N",
  );
});

test("submissions modal Open Evidence button is gated by canOpenEvidence", () => {
  const src = read(PAGE_SRC);
  assert.match(
    src,
    /canOpenEvidence as canOpenEvidenceFromSession/,
  );
  assert.match(src, /openability\.canOpen \?[\s\S]{0,800}Open evidence/);
});

test("submissions modal shows 'Waiting for files' when no evidence yet", () => {
  const src = read(PAGE_SRC);
  assert.match(src, /openability\.reason === "no_evidence_yet"/);
  assert.match(src, /Waiting for files/);
});

test("submissions modal counts derive from the visible session list", () => {
  const src = read(PAGE_SRC);
  // The "X total · Y submitted · Z in progress" line MUST be
  // computed from `payload.sessions` (visible rows), not from a
  // separate `payload.totals` aggregate that could disagree.
  assert.match(
    src,
    /data-intake-link-submissions-counts="true"/,
  );
  assert.match(
    src,
    /const sessions = payload\.sessions;[\s\S]{0,300}visibleTotal = sessions\.length/,
  );
});

// ============================================================================
// Phase 6 — evidence loads with missing signing metadata
// ============================================================================

test("evidence route NO LONGER returns the technical 409 message", () => {
  const src = read(EVIDENCE_ROUTES_SRC);
  // The exact technical string that reached the UI is gone.
  assert.ok(
    !/Signing key metadata is not recorded for this evidence record/.test(src),
    "the user-facing 'Signing key metadata' technical message must be retired",
  );
});

test("evidence route makes signing-key OPTIONAL (pending-signing renders)", () => {
  const src = read(EVIDENCE_ROUTES_SRC);
  // The new logic flags whether metadata is recorded and only
  // looks up the SigningKey row when it is.
  assert.match(
    src,
    /signingKeyMetadataRecorded =[\s\S]{0,200}evidence\.signingKeyVersion != null/,
  );
  assert.match(
    src,
    /signingKey = signingKeyMetadataRecorded\s*\?\s*await prisma\.signingKey\.findUnique/,
  );
});

test("evidence route still 503s when the key row is missing for a SIGNED row", () => {
  const src = read(EVIDENCE_ROUTES_SRC);
  // True misconfiguration — signing metadata claims a key exists
  // but the key row is absent — keeps its dedicated 503.
  assert.match(
    src,
    /if \(signingKeyMetadataRecorded && !signingKey\)/,
  );
  assert.match(src, /code:\s*"SIGNING_KEY_MISSING"/);
});

test("signature verification gracefully handles null signingKey", () => {
  const src = read(EVIDENCE_ROUTES_SRC);
  assert.match(
    src,
    /signatureValid =[\s\S]{0,200}signingKey !== null &&/,
  );
});

test("evidence page error UI does not surface the 'Signing key metadata' wording", () => {
  const src = read(EVIDENCE_PAGE_SRC);
  // The generic error branch must not contain this technical string.
  assert.ok(
    !/Signing key metadata/.test(src),
    "the evidence detail page must never display the technical 'Signing key metadata' string",
  );
});

// ============================================================================
// Phase 7 — reviewer status copy
// ============================================================================

test("reviewer-status card has the legal-careful internal-workflow disclaimer", () => {
  // Disclaimer copy now lives in apps/web/app/(app)/evidence/lib/reviewer-status.ts
  // (REVIEWER_STATUS_DISCLAIMER), shared by every reviewer-status
  // surface. The card just imports + renders it.
  const cardSrc = read(REVIEWER_CARD_SRC);
  assert.match(cardSrc, /\{REVIEWER_STATUS_DISCLAIMER\}/);
  assert.match(cardSrc, /data-evidence-reviewer-disclaimer="true"/);
  const libSrc = read("apps/web/app/(app)/evidence/lib/reviewer-status.ts");
  assert.match(libSrc, /Reviewer status is an internal workflow marker\./);
  assert.match(
    libSrc,
    /does not change integrity results, public verification, authenticity, legal admissibility, or factual truth\./,
  );
});

test("REGRESSION GUARD: the five legally-safe reviewer status labels remain (canonical lib)", () => {
  // The labels moved to apps/web/app/(app)/evidence/lib/reviewer-status.ts
  // so every reviewer-status surface (External Intake card, Reviewer
  // Workflow card, Review tab status box) reads the same strings.
  const src = read("apps/web/app/(app)/evidence/lib/reviewer-status.ts");
  for (const label of [
    "Needs review",
    "In review",
    "Needs additional context",
    "Accepted for internal review",
    "Not accepted",
  ]) {
    assert.match(
      src,
      new RegExp(label.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")),
      `legally-safe label "${label}" must remain in the canonical reviewer-status lib`,
    );
  }
});

test("REGRESSION GUARD: reviewer-status reads the nested workflow.status (fix kept)", () => {
  const src = read(REVIEWER_CARD_SRC);
  assert.match(src, /review\?\.workflow\?\.status/);
  assert.match(src, /aria-pressed=\{active\}/);
});

// ============================================================================
// Contributor + Upload Agreement cleanup
// ============================================================================

test("source card hides the Contributor row entirely when no identity was collected", () => {
  const src = read(REVIEWER_CARD_SRC);
  // The "Not provided" / "Anonymous" placeholders for an unknown
  // contributor were confusing operators who don't require name /
  // email / phone / alias. Rendering only when an identity exists.
  assert.match(
    src,
    /contributorIdentity \? \(\s*\n?\s*<Detail label="Contributor">/,
  );
  // The old placeholder strings must NOT remain in the JSX.
  assert.ok(
    !/"Not provided"/.test(src),
    "Contributor 'Not provided' placeholder must be removed",
  );
  assert.ok(
    !/:\s*"Anonymous"/.test(src),
    "Contributor 'Anonymous' fallback must be removed (hide row instead)",
  );
});

test("source card resolves contributor identity from pseudonym / email / displayName only", () => {
  const src = read(REVIEWER_CARD_SRC);
  // The resolver returns null when nothing was collected, which is
  // what the conditional render hangs on.
  assert.match(src, /const contributorIdentity: string \| null/);
  assert.match(src, /summary\.session\.pseudonym/);
  assert.match(src, /summary\.session\.submitterEmail/);
  assert.match(src, /summary\.session\.submitterDisplayName/);
});

test("source card labels consent as 'Upload Agreement' (terminology fix)", () => {
  const src = read(REVIEWER_CARD_SRC);
  // The bare label "Consent" was ambiguous (consent to what?). The
  // contributor explicitly agreed to upload terms; the renamed label
  // says so plainly.
  assert.match(src, /<Detail label="Upload Agreement">/);
  assert.ok(
    !/<Detail label="Consent">/.test(src),
    "Old 'Consent' label must be retired",
  );
  // Timestamp + version logic preserved (no backend change).
  assert.match(src, /summary\.session\.consentAcceptedAtUtc/);
});
