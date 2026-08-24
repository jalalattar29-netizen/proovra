/**
 * EVIDENCE REVIEW-STATE RESOLVER — behaviour + colour contract.
 *
 * The Evidence Library shows one of four review-state labels per row:
 *   Critical follow-up · Reviewer action recommended · Operational notes ·
 *   Stable review state
 * The user observed two "Reported" rows — one "Stable", one "Operational" —
 * with no obvious difference when each record was opened. This file pins WHY.
 *
 * AUDIT FINDING (proven by executing the shipped resolver, below). The library
 * row renders through `buildReviewPriority(item)` with NO detail argument
 * (EvidenceLibraryRow.tsx), so in the list only the alerts that need no detail
 * can fire. The ONLY informational alert reachable there is "No case assigned".
 * Therefore, for an otherwise-clean Reported record:
 *
 *   Operational notes  <=>  the record has NO case assigned
 *   Stable review state <=>  a case IS assigned
 *
 * That is real, user-visible domain state (`Evidence.caseId`, shown in the
 * detail as "Case: Unassigned" / "Case assignment"). The difference is
 * legitimate; the label was merely too vague to connect to its cause, which is
 * why the resolver now returns the concrete driving `notes` for the row to
 * surface. These tests execute the REAL resolver — no paraphrase.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildReviewPriority, buildReviewAlerts } from "../app/(app)/evidence/lib/evidence-library-alerts";
import type { EvidenceListItem } from "../app/(app)/evidence/lib/evidence-library-types";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

/** A clean, settled Reported record. Every decision input is benign. */
function evidence(over: Partial<EvidenceListItem>): EvidenceListItem {
  return {
    id: "ev-1",
    title: "incident.jpg",
    status: "REPORTED",
    verificationStatus: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    caseId: "case-1",
    reportReady: true,
    ...over,
  } as EvidenceListItem;
}

// ===========================================================================
// The audit, as executable assertions
// ===========================================================================

test("A. an Evidence with no qualifying review/operational note is Stable review state", () => {
  const p = buildReviewPriority(evidence({ caseId: "case-1", reportReady: true }));
  assert.equal(p.label, "Stable review state");
  assert.equal(p.level, "stable");
  // Stable is stable because NOTHING fired — the notes are empty, by definition.
  assert.deepEqual(p.notes, []);
});

test("B. an Evidence with a real qualifying note (no case assigned) is Operational notes", () => {
  const p = buildReviewPriority(evidence({ caseId: null, reportReady: true }));
  assert.equal(p.label, "Operational notes");
  assert.equal(p.level, "informational");
  // The label is now explainable: the concrete driving note travels with it.
  assert.deepEqual(
    p.notes.map((n) => n.label),
    ["No case assigned"],
  );
});

test("C. two Evidence identical w.r.t. the resolver's inputs render the same label", () => {
  // Same decision inputs, deliberately different in fields the resolver ignores
  // (id, title, timestamps). The label must not move.
  const a = buildReviewPriority(
    evidence({ id: "ev-a", title: "a.jpg", caseId: "case-1", createdAt: "2026-01-01T00:00:00Z" }),
  );
  const b = buildReviewPriority(
    evidence({ id: "ev-b", title: "b.png", caseId: "case-9", createdAt: "2026-09-09T00:00:00Z" }),
  );
  assert.equal(a.label, b.label);
  assert.equal(a.label, "Stable review state");
});

test("D. changing an unrelated field does not flip Stable <-> Operational", () => {
  const withCase = evidence({ caseId: "case-1" });
  const base = buildReviewPriority(withCase).label;
  for (const over of [
    { title: "renamed.jpg" },
    { createdAt: "2020-01-01T00:00:00Z" },
    { updatedAt: "2027-01-01T00:00:00Z" },
    { archivedAt: "2026-08-02T00:00:00Z" },
  ] as Array<Partial<EvidenceListItem>>) {
    assert.equal(
      buildReviewPriority(evidence({ caseId: "case-1", ...over })).label,
      base,
      `unrelated field ${Object.keys(over)[0]} moved the review state`,
    );
  }
  // The one field that IS supposed to flip it does so — the control for the above.
  assert.equal(buildReviewPriority(evidence({ caseId: null })).label, "Operational notes");
});

test("E. severity precedence: critical and operational outrank the informational note", () => {
  // A no-case record that ALSO has a higher-severity condition is NOT
  // "Operational notes" — the stronger signal wins, so the informational note
  // never masks a real problem.
  assert.equal(
    buildReviewPriority(evidence({ caseId: null, verificationStatus: "FAILED" })).label,
    "Critical follow-up",
  );
  assert.equal(
    buildReviewPriority(evidence({ caseId: null, verificationStatus: "REVIEW_REQUIRED" })).label,
    "Reviewer action recommended",
  );
  assert.equal(
    buildReviewPriority(evidence({ caseId: null, status: "REPORTED", reportReady: false })).label,
    "Reviewer action recommended",
  );
});

test("F. the driving notes come from the ONE canonical alert builder — no second computation", () => {
  const item = evidence({ caseId: null });
  const p = buildReviewPriority(item);
  const alerts = buildReviewAlerts(item);
  // The notes the row surfaces are exactly the deciding-severity subset of the
  // canonical alerts, not a parallel list computed a second way.
  assert.deepEqual(
    p.notes,
    alerts.filter((a) => a.severity === "informational"),
  );
});

test("G. every note carries a human explanation, so the label is never unexplainable", () => {
  const p = buildReviewPriority(evidence({ caseId: null }));
  for (const note of p.notes) {
    assert.ok(note.label.trim().length > 0, "a note has no label");
    assert.ok(note.detail.trim().length > 8, "a note has no explanation");
  }
});

// ===========================================================================
// Colour contract (Part 1)
// ===========================================================================

test("H. Stable review state -> blue, Operational notes -> orange (canonical tokens)", () => {
  const status = read("apps/web/app/(app)/evidence/lib/evidence-library-status.ts");
  assert.match(status, /stable: "blue",/);
  assert.match(status, /informational: "orange",/);
  // The AppTone -> ink resolution: blue is the AA-safe --info, orange the
  // AA-safe --orange-ink. No new colour tokens.
  const prim = read("apps/web/components/app-primitives/app-primitives.css");
  assert.match(prim, /\.app-status-text\[data-tone="blue"\] \{ --app-status-tone: var\(--info\); \}/);
  assert.match(prim, /\.app-status-text\[data-tone="orange"\] \{ --app-status-tone: var\(--orange-ink\); \}/);
});

test("I. Integrity `Recorded` -> blue, and every state stays text-only", () => {
  const integrity = read("apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx");
  assert.match(integrity, /recorded: \{ label: "Recorded", tone: "blue" \}/);
  assert.doesNotMatch(integrity, /recorded: \{ label: "Recorded", tone: "orange" \}/);
  // Text-only: the matrix state carries the text primitive, never a capsule.
  assert.match(integrity, /className="app-status-text evidence-detail-matrix-cell__state"/);
  assert.doesNotMatch(integrity, /app-status-badge/);
});

test("J. the library review-state label is explainable at the point of display", () => {
  // The row surfaces the concrete notes as the label's tooltip, so a reader who
  // sees "Operational notes" can find out it means "No case assigned" without
  // opening the record. It reuses `priority.notes` — no second computation.
  const row = read("apps/web/app/(app)/evidence/components/EvidenceLibraryRow.tsx");
  assert.match(row, /priority\.notes/);
  assert.match(row, /title=\{reviewStateTitle\}/);
});

test("K. the Evidence Detail view exposes the driver (case assignment) in domain terms", () => {
  // The audit's discriminator is `caseId`; the detail must show it so the
  // library label is explainable from real domain state, not only from UI code.
  const detail = read("apps/web/app/(app)/evidence/[id]/page.tsx");
  assert.match(detail, /label: "Case assignment"/);
  assert.match(detail, /workspace\.relationships\.caseName \|\| "Unassigned"/);
});
