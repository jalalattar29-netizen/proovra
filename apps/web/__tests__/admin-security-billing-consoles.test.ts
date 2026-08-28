/**
 * Platform Control Center P1 — Security & Billing console UX contracts.
 *
 * Source-contract style (matches admin-console-ux.test.ts): asserts the two
 * new admin consoles render through the shared PageShell (no marketing hero),
 * present honest null states, and never surface secrets / raw IPs / card
 * tokens in the client.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");
const exists = (rel: string): boolean => existsSync(resolve(APP_ROOT, rel));

const SECURITY = "app/(app)/admin/security/page.tsx";
const BILLING = "app/(app)/admin/billing/page.tsx";

/**
 * PHASE 12B (2026-07-30) — the security console became the full Security
 * Center and was decomposed into an orchestrator + `_sections/*` (the
 * established repo pattern past ~700 lines). These UX contracts describe the
 * SURFACE, not one file, so the security console is read as the page plus its
 * sections. The billing console is untouched and still read as a single file.
 */
const SECURITY_SECTIONS = [
  "app/(app)/admin/security/_sections/section-state.tsx",
  "app/(app)/admin/security/_sections/WorkspaceSecurityPostureSection.tsx",
  "app/(app)/admin/security/_sections/MfaPolicySection.tsx",
  "app/(app)/admin/security/_sections/MfaMemberPostureSection.tsx",
  "app/(app)/admin/security/_sections/MfaEventsSection.tsx",
  "app/(app)/admin/security/_sections/MfaDigestPreferencesSection.tsx",
  "app/(app)/admin/security/_sections/MfaSelfCheckSection.tsx",
  // ADM-034 — PlatformIncidentFeedSection is GONE from this page. It carried
  // the PLATFORM incident feed and the PLATFORM security-event feed on a page
  // whose other six sections administer ONE workspace, so a single surface
  // served two audiences at two scopes. Both platform halves now live at
  // /admin/operations, where the incidents also gained tenant attribution and
  // the ability to be acted on.
];

/** The platform-operations console the platform halves moved to. */
const OPERATIONS = "app/(app)/admin/operations/page.tsx";
const OPERATIONS_SECTIONS = [
  "app/(app)/admin/operations/_sections/PlatformSecurityEvents.tsx",
];
const readOperations = (): string =>
  [read(OPERATIONS), ...OPERATIONS_SECTIONS.map(read)].join("\n");

/** The whole console surface: the orchestrator plus every section it mounts. */
const readSurface = (rel: string): string =>
  rel === SECURITY
    ? [read(SECURITY), ...SECURITY_SECTIONS.map(read)].join("\n")
    : read(rel);

test("both new admin console pages exist", () => {
  assert.ok(exists(SECURITY), "security console page must exist");
  assert.ok(exists(BILLING), "billing console page must exist");
});

test("both consoles render through the shared PageShell (no marketing hero)", () => {
  for (const rel of [SECURITY, BILLING]) {
    const src = read(rel);
    assert.match(src, /PageShell/, `${rel} must use the shared PageShell`);
    assert.doesNotMatch(
      src,
      /app-hero-full|className="app-hero/,
      `${rel} must not render the marketing app-hero`,
    );
    assert.doesNotMatch(src, /cc-page|btn-/, `${rel} must not use legacy cc-page/btn- classes`);
    assert.match(
      readFileSync(resolve(APP_ROOT, "app/(app)/admin/layout.tsx"), "utf8"),
      /AdminConsoleNav/,
      "AdminConsoleNav moved to app/(app)/admin/layout.tsx (ADM-025): one nav for every admin page, so none can be added without one",
    );
  }
});

test("both consoles route errors through toSafeUserError (sanctioned path)", () => {
  for (const rel of [SECURITY, BILLING]) {
    assert.match(
      rel === SECURITY ? readSurface(rel) + readOperations() : readSurface(rel),
      /toSafeUserError/,
      `${rel} must use toSafeUserError`,
    );
  }
});

test("platform operations console renders honest empty states", () => {
  const src = readOperations();
  assert.match(src, /EmptyState/, "must render EmptyState");
  assert.match(src, /No security events/i, "honest empty state for events");
  assert.match(src, /No conditions match/i, "honest empty state for incidents");
  // The empty state must distinguish "nothing is open" from "nothing was
  // measured" — an empty incident table under a status filter is a real zero.
  assert.match(
    src,
    /not that nothing was measured/i,
    "empty state must say an empty table is a real zero, not an unmeasured signal",
  );
});

test("platform operations console exposes the type + severity FilterBar", () => {
  const src = readOperations();
  assert.match(src, /FilterBar/, "must render FilterBar");
  assert.match(src, /eventType/, "must filter by event type");
  assert.match(src, /severity/i, "must filter by severity");
});

test("billing console renders honest 'Not measured' MRR/ARR + not-connected webhook states", () => {
  const src = read(BILLING);
  assert.match(src, /Not measured/i, "honest 'Not measured' for non-derivable MRR/ARR");
  assert.match(src, /Not connected/i, "honest not-connected webhook state");
  assert.match(src, /MRR/, "renders an MRR tile, honestly not-measured");
  // ADM-012 — the tile is per-currency now; ARR remains honestly not-derivable.
  assert.match(src, /ARR follows from MRR|arrCents/, "ARR remains not-derivable");
});

test("neither console surfaces secrets, raw IPs, or card tokens in the client", () => {
  for (const rel of [SECURITY, BILLING]) {
    const src = rel === SECURITY ? readSurface(rel) + readOperations() : readSurface(rel);
    // Guard against actual data-leak field access, not descriptive prose.
    assert.doesNotMatch(src, /r\.ipAddress\b|\.ipAddress\b/, `${rel} must not read a raw IP field`);
    assert.doesNotMatch(src, /\.token\b|accessToken|apiKey|\.secret\b|cardNumber/i, `${rel} must not read token/secret/card fields`);
    assert.doesNotMatch(src, /providerPaymentId|providerSubId/, `${rel} must not surface provider payment identifiers`);
  }
});

test("billing console exposes only email as customer PII", () => {
  const src = read(BILLING);
  assert.match(src, /userEmail/, "payment rows show email");
  // ADM-030 — `customerName` is the customer ORGANIZATION name and is REQUIRED
  // here: an attention row that cannot say who is affected is exactly the
  // finding this page closed. What this assertion was actually guarding is
  // PERSONAL PII, so it guards that instead of a field name that now has to be
  // present.
  assert.doesNotMatch(
    src,
    /\.phone\b|\.ssn\b|dateOfBirth|\.postalAddress\b/i,
    "no personal PII beyond email",
  );
  assert.match(src, /customerName/, "attention rows must name the affected customer");
});
