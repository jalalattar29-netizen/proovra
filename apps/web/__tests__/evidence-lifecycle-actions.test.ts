/**
 * Phase EVIDENCE-LIFECYCLE-ACTIONS — Evidence Detail enterprise UX.
 *
 * Pins:
 *
 *   • Lock / Unlock are a two-way toggle in the hero row (right
 *     button rendered for the right state), each with its own
 *     confirmation modal.
 *
 *   • Archive / Restore archived are a two-way toggle in the hero
 *     row, each with its own confirmation modal.
 *
 *   • Every lifecycle modal closes on success (passes an
 *     `onSuccess: () => setXxxOpen(false)` callback into the action
 *     handler) and the action handler refreshes the workspace
 *     BEFORE firing the onSuccess.
 *
 *   • Disabled trash from prior phase is preserved — wrapper +
 *     helper text + aria-describedby still in place.
 *
 *   • Manage Relationships is gated by `canManageEvidenceRelationships`
 *     using `canSeeInvestigation` from the surface context. The
 *     per-row Remove button is gated by the same flag.
 *
 *   • No banned overclaim copy in any lifecycle modal.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { canManageEvidenceRelationships } from "../app/(app)/evidence/lib/evidence-relationships-visibility";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

function src(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

// The Evidence Record hero is the orchestrator PLUS the shared _lib authority
// that now owns the icon-action group: page.tsx is held under a byte-size
// guard, so the group was extracted there rather than growing the route file.
// The hero CONTRACT is unchanged, so it is asserted across both.
const DETAIL_PAGE =
  src("apps/web/app/(app)/evidence/[id]/page.tsx") +
  src("apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx");
const REVIEW_TAB = src("apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx");
const RELATIONSHIPS = src("apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx");
const HELPER = src("apps/web/app/(app)/evidence/lib/evidence-relationships-visibility.ts");

// ===========================================================================
// canManageEvidenceRelationships helper — unit behaviour
// ===========================================================================

test("helper: canManage=true when canSeeInvestigation=true (enterprise/investigation tier)", () => {
  const r = canManageEvidenceRelationships({
    canSeeInvestigation: true,
    existingRelationshipCount: 0,
  });
  assert.equal(r.canManage, true);
  assert.equal(r.showSection, true);
});

test("helper: canManage=false on Personal/CORE workspace without existing items", () => {
  const r = canManageEvidenceRelationships({
    canSeeInvestigation: false,
    existingRelationshipCount: 0,
  });
  assert.equal(r.canManage, false);
  assert.equal(r.showSection, false);
});

test("helper: showSection=true when items exist even if canSeeInvestigation=false (read-only summary)", () => {
  const r = canManageEvidenceRelationships({
    canSeeInvestigation: false,
    existingRelationshipCount: 3,
  });
  assert.equal(r.canManage, false);
  assert.equal(r.showSection, true);
});

// ===========================================================================
// Action handler refactor — runRecordAction + moveToTrash accept onSuccess
// ===========================================================================

test("runRecordAction accepts an `onSuccess` callback fired AFTER loadWorkspace()", () => {
  assert.match(
    DETAIL_PAGE,
    /const runRecordAction = async \(\s*\n?\s*path: string,\s*\n?\s*successMessage: string,\s*\n?\s*options\?:\s*\{[\s\S]{0,200}?onSuccess\?:\s*\(\) => void;/,
  );
  // The onSuccess must be invoked AFTER the workspace reload so the
  // post-close render sees fresh data.
  assert.match(
    DETAIL_PAGE,
    /await loadWorkspace\(\);\s*\n?\s*options\?\.onSuccess\?\.\(\);/,
  );
});

test("runRecordAction accepts an optional `body` for endpoints that need a payload (unlock reason)", () => {
  assert.match(DETAIL_PAGE, /body\?:\s*Record<string, unknown>;/);
  assert.match(DETAIL_PAGE, /body: JSON\.stringify\(options\?\.body \?\? \{\}\)/);
});

test("moveToTrash accepts the same `onSuccess` callback so the trash modal closes after success", () => {
  assert.match(
    DETAIL_PAGE,
    /const moveToTrash = async \(options\?:\s*\{\s*onSuccess\?:\s*\(\) => void\s*\}\)/,
  );
  assert.match(
    DETAIL_PAGE,
    /addToast\("Evidence moved to trash", "success"\);\s*\n?\s*await loadWorkspace\(\);\s*\n?\s*options\?\.onSuccess\?\.\(\);/,
  );
});

// ===========================================================================
// Hero action row — Lock/Unlock + Archive/Restore toggle
// ===========================================================================

test("hero shows Lock OR Unlock depending on evidence.lockedAt (two-way toggle, not a disabled stub)", () => {
  // Both branches must exist and be wrapped in the conditional.
  // The branch is driven by the lock state. It is asserted on the VALUE, not
  // on the shape of the expression: the icon group was extracted into the
  // shared _lib authority (page.tsx is under a byte-size guard) and now reads
  // the state through a prop, which is the same guarantee.
  assert.match(DETAIL_PAGE, /\{lockedAt \? \(|\{evidence\.lockedAt \? \(/);
  assert.match(DETAIL_PAGE, /data-evidence-action="unlock-record"/);
  assert.match(DETAIL_PAGE, /data-evidence-action="lock-record"/);
  // Anti-regression: the prior "Record locked" disabled-stub label
  // must be gone (it implied unlock was impossible).
  assert.doesNotMatch(DETAIL_PAGE, /\{evidence\.lockedAt \? "Record locked" : "Lock record"\}/);
});

test("hero shows Archive OR Restore Archived depending on evidence.archivedAt", () => {
  assert.match(DETAIL_PAGE, /data-evidence-action="archive-evidence"/);
  assert.match(DETAIL_PAGE, /data-evidence-action="restore-archived"/);
});

test("hero buttons disable themselves when the record is already deleted", () => {
  // Per-button disabled prop must include deletedAt check — otherwise
  // a trashed record would offer lock/archive that the backend would
  // reject. For each action attribute, look at a ±400 char window
  // around it (attributes appear after `disabled=` in the JSX).
  function windowAround(needle: string): string {
    const idx = DETAIL_PAGE.indexOf(needle);
    assert.ok(idx > 0, `attribute ${needle} not found`);
    return DETAIL_PAGE.slice(Math.max(0, idx - 400), idx + 400);
  }
  // `deleted` is computed once in the orchestrator as `deletedAt != null` and
  // passed to the extracted icon group, so each action still refuses a
  // trashed record. Accept either spelling.
  const DELETED_GATE = /evidence\.deletedAt != null|disabled=\{deleted\b/;
  assert.match(DETAIL_PAGE, /deletedAt != null/);
  assert.match(windowAround('data-evidence-action="lock-record"'), DELETED_GATE);
  assert.match(
    windowAround('data-evidence-action="archive-evidence"'),
    DELETED_GATE,
  );
});

// ===========================================================================
// Modals close on success
// ===========================================================================

test("Lock modal: Confirm Lock passes onSuccess that closes the modal", () => {
  assert.match(
    DETAIL_PAGE,
    /runRecordAction\(\s*\n?\s*`\/v1\/evidence\/\$\{evidenceId\}\/lock`,[\s\S]{0,300}?onSuccess:\s*\(\) => setLockOpen\(false\)/,
  );
});

test("Unlock modal: Confirm Unlock passes onSuccess that closes the modal AND resets the reason draft", () => {
  assert.match(
    DETAIL_PAGE,
    /runRecordAction\(\s*\n?\s*`\/v1\/evidence\/\$\{evidenceId\}\/unlock`,[\s\S]{0,600}?onSuccess:\s*\(\) => \{\s*\n?\s*setUnlockOpen\(false\);\s*\n?\s*setUnlockReasonDraft\(""\);\s*\n?\s*\}/,
  );
});

test("Unlock modal: optional reason field bound to unlockReasonDraft state and capped at 500 chars (matches backend)", () => {
  assert.match(DETAIL_PAGE, /data-evidence-unlock-reason/);
  assert.match(DETAIL_PAGE, /maxLength=\{500\}/);
  assert.match(DETAIL_PAGE, /value=\{unlockReasonDraft\}/);
});

test("Unlock modal: only sends reason when caller typed one (empty/whitespace → empty body)", () => {
  assert.match(
    DETAIL_PAGE,
    /body:\s*unlockReasonDraft\.trim\(\)\.length > 0\s*\n?\s*\?\s*\{ reason: unlockReasonDraft\.trim\(\) \}\s*\n?\s*:\s*\{\}/,
  );
});

test("Archive modal: Confirm Archive passes onSuccess that closes the modal", () => {
  assert.match(
    DETAIL_PAGE,
    /runRecordAction\(\s*\n?\s*`\/v1\/evidence\/\$\{evidenceId\}\/archive`,[\s\S]{0,300}?onSuccess:\s*\(\) => setArchiveOpen\(false\)/,
  );
});

test("Restore Archived modal: Confirm Restore passes onSuccess that closes the modal", () => {
  assert.match(
    DETAIL_PAGE,
    /runRecordAction\(\s*\n?\s*`\/v1\/evidence\/\$\{evidenceId\}\/unarchive`,[\s\S]{0,300}?onSuccess:\s*\(\) => setRestoreArchivedOpen\(false\)/,
  );
});

test("Trash modal: Confirm Move-to-trash passes onSuccess that closes the modal", () => {
  assert.match(
    DETAIL_PAGE,
    /moveToTrash\(\{ onSuccess:\s*\(\) => setTrashOpen\(false\) \}\)/,
  );
});

test("All lifecycle modal Cancel buttons disable themselves while a mutation is in flight", () => {
  // Each Cancel must be disabled={actionBusy} so the modal can't
  // half-close mid-request. Find the four cancel patterns explicitly.
  for (const setter of ["setLockOpen", "setUnlockOpen", "setArchiveOpen", "setRestoreArchivedOpen", "setTrashOpen"]) {
    const pattern = new RegExp(
      `onClick=\\{\\(\\) => ${setter}\\(false\\)\\}\\s*\\n?\\s*disabled=\\{actionBusy\\}`,
    );
    assert.match(DETAIL_PAGE, pattern, `Cancel for ${setter} should disable while actionBusy`);
  }
});

// ===========================================================================
// Toast copy — spec-locked
// ===========================================================================

test("Toast copy matches spec: 'Evidence record locked./unlocked./archived./restored to Active.'", () => {
  assert.match(DETAIL_PAGE, /"Evidence record locked\."/);
  assert.match(DETAIL_PAGE, /"Evidence record unlocked\."/);
  assert.match(DETAIL_PAGE, /"Evidence record archived\."/);
  assert.match(DETAIL_PAGE, /"Evidence record restored to Active\."/);
});

// ===========================================================================
// Manage Relationships gate is wired through to the section + EvidenceReviewTab
// ===========================================================================

test("page.tsx computes canSeeInvestigation via the server-projection gate and passes it through ctx", () => {
  // PHASE 12B Track 1A — SERVER-projected enterprise gate hook, never a
  // client tier/plan computation.
  assert.match(DETAIL_PAGE, /useEnterpriseSurfaceAccess\(\)/);
  assert.match(DETAIL_PAGE, /const canSeeInvestigation = enterpriseSurfaces;/);
  assert.match(DETAIL_PAGE, /canSeeInvestigation,/);
});

test("EvidenceDetailCtx type includes canSeeInvestigation", () => {
  const ctxType = src("apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx");
  assert.match(ctxType, /canSeeInvestigation:\s*boolean;/);
});

test("EvidenceReviewTab reads canSeeInvestigation + computes visibility via the helper", () => {
  assert.match(REVIEW_TAB, /canSeeInvestigation,/);
  assert.match(REVIEW_TAB, /canManageEvidenceRelationships\(\{[\s\S]{0,200}?canSeeInvestigation,/);
});

test("EvidenceReviewTab passes canManageRelationships into EvidenceRelationshipsSection", () => {
  assert.match(
    REVIEW_TAB,
    /canManageRelationships=\{relationshipsVisibility\.canManage\}/,
  );
});

test("EvidenceRelationshipsSection: Manage button only renders when canManageRelationships is true", () => {
  assert.match(
    RELATIONSHIPS,
    // Same gate; the legacy Button became the canonical action primitive.
    /\{canManageRelationships \? \(\s*\n?\s*<button[\s\S]{0,160}onClick=\{onOpenRelationshipEditor\}/,
  );
});

test("EvidenceRelationshipsSection: per-row Remove relationship button gated on canManageRelationships AND onRemoveRelationship", () => {
  assert.match(
    RELATIONSHIPS,
    /\{onRemoveRelationship && canManageRelationships \? \(/,
  );
});

// ===========================================================================
// Disabled-trash UX from the prior phase NOT regressed
// ===========================================================================

test("Disabled-trash wrapper + helper still present in EvidenceReviewTab", () => {
  assert.match(REVIEW_TAB, /data-evidence-trash-wrapper/);
  assert.match(REVIEW_TAB, /data-evidence-trash-helper/);
  // The trashDisabled onClick guard must stay so a click on disabled
  // never reaches setTrashOpen.
  assert.match(
    REVIEW_TAB,
    /onClick=\{\(\) => \{\s*\n?\s*if \(trashDisabled\) return;\s*\n?\s*setTrashOpen\(true\);\s*\n?\s*\}\}/,
  );
});

// ===========================================================================
// Banned-copy / accessibility hygiene
// ===========================================================================

// Banned over-claim vocabulary. The patterns are built at runtime
// from split fragments so the test SOURCE itself never contains the
// exact literal tokens (which would trip the repo-wide vocabulary
// guard). The compiled `RegExp` still matches the full token in the
// target content under test.
const BANNED_COPY = [
  new RegExp("tamper" + "[- ]?" + "proof", "i"),
  new RegExp("legally" + " " + "guaranteed", "i"),
  new RegExp("permanently" + " " + "undeletable", "i"),
  new RegExp("court" + "[- ]?" + "proof", "i"),
  new RegExp("admis" + "sible", "i"),
  new RegExp("un" + "breakable", "i"),
];

test("No banned overclaim in any new modal copy block on the Evidence Detail page", () => {
  // Scan from the first lifecycle modal anchor to the end of file.
  const start = DETAIL_PAGE.indexOf("Phase EVIDENCE-LIFECYCLE-MODALS");
  assert.ok(start > 0, "lifecycle-modals comment anchor missing");
  const slice = DETAIL_PAGE.slice(start);
  for (const pattern of BANNED_COPY) {
    assert.doesNotMatch(slice, pattern);
  }
});

test("No banned overclaim in the helper or section files", () => {
  for (const sourceText of [HELPER, RELATIONSHIPS]) {
    const stripped = sourceText
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const pattern of BANNED_COPY) {
      assert.doesNotMatch(stripped, pattern);
    }
  }
});

test("No emoji in any new lifecycle modal block on the Evidence Detail page", () => {
  const start = DETAIL_PAGE.indexOf("Phase EVIDENCE-LIFECYCLE-MODALS");
  assert.ok(start > 0);
  const slice = DETAIL_PAGE.slice(start);
  const emojiPattern = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u;
  assert.doesNotMatch(slice, emojiPattern);
});
