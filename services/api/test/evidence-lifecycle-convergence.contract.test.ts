/**
 * EVIDENCE LIFECYCLE CONVERGENCE — the source-contract gate.
 *
 * This suite exists to make the convergence STRUCTURAL rather than reviewed.
 * Every assertion here corresponds to a duplicate authority that was removed,
 * and would fail the moment somebody added it back — which is the only kind of
 * guarantee worth having about "there is exactly one implementation of X",
 * because that property is not visible from any single file.
 *
 * The failure modes it locks out, all of which shipped:
 *
 *   - four independent physical-destruction executors, two of which issued
 *     destruction certificates without contacting storage at all;
 *   - a hard delete of the Evidence row and its custody chain as the final
 *     lifecycle step, leaving no tombstone;
 *   - four route-level copies of archive/trash/restore whose guards drifted;
 *   - a browser-side mirror of the retention rules that could not see the
 *     legal-hold tables and blocked recoverable trash on retention;
 *   - user-facing "Deleted" terminology for a scope in which nothing is
 *     deleted.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function src(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

/** Strip comments so a prose mention of a banned pattern is not a violation. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
}

const EVIDENCE_ROUTES = src("services/api/src/routes/evidence.routes.ts");
const LIFECYCLE_SERVICE = src(
  "services/api/src/services/evidence/evidence-lifecycle.service.ts",
);
const EXECUTOR = src("packages/shared-runtime/src/evidence-destruction/executor.ts");
const AUTHORITY = src("packages/shared/src/evidence-retention-lifecycle.ts");
const PURGE = src("services/worker/src/processor.ts");
const ORCHESTRATOR = src(
  "services/worker/src/governance/destruction-orchestrator.worker.ts",
);
const PHASE4B = src(
  "services/api/src/services/lifecycle/destruction-governance.service.ts",
);
const REVIEW_SERVICE = src(
  "services/api/src/services/governance-lifecycle/destruction-review.service.ts",
);
const WEB_ELIGIBILITY = src(
  "apps/web/app/(app)/evidence/lib/evidence-delete-eligibility.ts",
);
const WEB_TYPES = src("apps/web/app/(app)/evidence/lib/evidence-library-types.ts");
const WEB_FILTERS = src(
  "apps/web/app/(app)/evidence/components/EvidenceFilters.tsx",
);
const WEB_STATUS = src("apps/web/app/(app)/evidence/lib/evidence-library-status.ts");
const REVIEW_TAB = src(
  "apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx",
);
const BULK_TOOLBAR = src(
  "apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx",
);

// ===========================================================================
// 1. ONE product-state authority
// ===========================================================================

describe("one lifecycle authority defines product-state precedence", () => {
  it("the shared module is the only place the precedence is written", () => {
    // The precedence is "DESTROYED wins, then TRASHED, then ARCHIVED, else
    // ACTIVE". Its signature in code is a chain that tests the trash signal
    // before the archive signal. Anything outside the authority that does that
    // is a second implementation.
    expect(AUTHORITY).toMatch(/export function resolveEvidenceProductState/);

    for (const [label, source] of [
      ["evidence.routes.ts", EVIDENCE_ROUTES],
      ["evidence-lifecycle.service.ts", LIFECYCLE_SERVICE],
      ["destruction executor", EXECUTOR],
      ["purge processor", PURGE],
    ] as const) {
      expect(
        code(source),
        `${label} must not re-derive the product state from timestamps`,
      ).not.toMatch(/if \(\s*\w+\.deletedAt\s*\)\s*return\s*"TRASHED"/);
    }
  });

  it("the authority reports a trash block reason that is never a retention deadline", () => {
    expect(AUTHORITY).toMatch(/trashBlockReason/);
    // canTrash may depend on state, lock and hold — never on a retention date.
    const canTrashLine = AUTHORITY.slice(
      AUTHORITY.indexOf("    canTrash:"),
      AUTHORITY.indexOf("    canTrash:") + 200,
    );
    expect(canTrashLine).not.toMatch(/retention|RetainUntil|objectLock/i);
  });
});

// ===========================================================================
// 2. ONE physical destruction executor
// ===========================================================================

describe("only the canonical executor performs physical Evidence deletion", () => {
  it("the executor verifies deletion before it will tombstone or certify", () => {
    // The order matters, not merely the presence: verification must appear
    // BEFORE the DESTROYED write in the file, and the DESTROYED write must be
    // the only one.
    const verifyAt = EXECUTOR.indexOf("objectExists(target)");
    const destroyAt = EXECUTOR.indexOf('lifecycleState: "DESTROYED"');
    const certifyAt = EXECUTOR.indexOf("const certificateHash = sha256Hex(");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(destroyAt).toBeGreaterThan(verifyAt);
    expect(certifyAt).toBeGreaterThan(verifyAt);
  });

  it("a survivor after deletion releases the claim and returns a failure", () => {
    expect(EXECUTOR).toMatch(
      /if \(survivors\.length > 0\) \{\s*await releaseClaim\(\);\s*return \{\s*ok: false,\s*outcome: "STORAGE_VERIFY_FAILED"/,
    );
  });

  it("no other module deletes Evidence storage objects", () => {
    for (const [label, source] of [
      ["purge processor", PURGE],
      ["destruction orchestrator", ORCHESTRATOR],
      ["Phase-4B destruction governance", PHASE4B],
      ["destruction review service", REVIEW_SERVICE],
    ] as const) {
      expect(
        code(source),
        `${label} must not call deleteObject directly`,
      ).not.toMatch(/\bawait\s+deleteObject\s*\(/);
      expect(
        code(source),
        `${label} must not call deleteObjectIfExists`,
      ).not.toMatch(/deleteObjectIfExists\s*\(/);
    }
  });

  it("the three legacy destroyers are triggers — they call the executor", () => {
    for (const [label, source] of [
      ["purge processor", PURGE],
      ["destruction orchestrator", ORCHESTRATOR],
      ["Phase-4B destruction governance", PHASE4B],
      ["destruction review service", REVIEW_SERVICE],
    ] as const) {
      expect(source, `${label} must route through the executor`).toMatch(
        /executeEvidenceDestruction\(/,
      );
    }
  });

  it("no module outside the executor writes the DESTROYED lifecycle state", () => {
    for (const [label, source] of [
      ["evidence.routes.ts", EVIDENCE_ROUTES],
      ["evidence-lifecycle.service.ts", LIFECYCLE_SERVICE],
      ["purge processor", PURGE],
      ["destruction orchestrator", ORCHESTRATOR],
      ["Phase-4B destruction governance", PHASE4B],
    ] as const) {
      expect(
        code(source),
        `${label} must not write lifecycleState: "DESTROYED"`,
      ).not.toMatch(/lifecycleState:\s*"DESTROYED"/);
    }
  });

  it("no module outside the executor writes the physical-destruction timestamp", () => {
    for (const [label, source] of [
      ["evidence.routes.ts", EVIDENCE_ROUTES],
      ["evidence-lifecycle.service.ts", LIFECYCLE_SERVICE],
      ["purge processor", PURGE],
      ["destruction orchestrator", ORCHESTRATOR],
      ["Phase-4B destruction governance", PHASE4B],
      ["destruction review service", REVIEW_SERVICE],
    ] as const) {
      // Selecting it (`destroyedAtUtc: true`) and projecting it
      // (`destroyedAtUtc: row.destroyedAtUtc`) are reads. A WRITE is any other
      // right-hand side. Enumerating the permitted reads is stricter than a
      // negative lookahead, which silently passes anything it backtracks around.
      for (const m of code(source).matchAll(/destroyedAtUtc:\s*([^,\n]+)/g)) {
        expect(
          m[1].trim(),
          `${label} writes destroyedAtUtc — only the canonical executor may`,
        ).toMatch(/^(true|null|\w+\.destroyedAtUtc(\s*\?\?\s*null)?)$/);
      }
    }
  });
});

// ===========================================================================
// 3. The tombstone — no hard delete of the Evidence row
// ===========================================================================

describe("final destruction preserves a tombstone", () => {
  it("nothing hard-deletes an Evidence row as a lifecycle step", () => {
    for (const [label, source] of [
      ["purge processor", PURGE],
      ["destruction executor", EXECUTOR],
      ["destruction orchestrator", ORCHESTRATOR],
    ] as const) {
      expect(code(source), `${label} must not delete the Evidence row`).not.toMatch(
        /\bevidence\.delete\s*\(\s*\{/,
      );
    }
  });

  it("the routes' one remaining hard delete is a CREATE rollback, not a lifecycle step", () => {
    // `prisma.evidence.delete` survives in exactly one place in the routes:
    // undoing a row that was just created when the quota check then denies it.
    // That is a create failing, not a record ending — which is why this is
    // pinned rather than banned. A second occurrence fails here.
    const hits = [
      ...code(EVIDENCE_ROUTES).matchAll(/prisma\.evidence\.delete\s*\(/g),
    ];
    expect(hits).toHaveLength(1);
    const at = EVIDENCE_ROUTES.indexOf("prisma.evidence.delete(");
    expect(EVIDENCE_ROUTES.slice(Math.max(0, at - 400), at)).toMatch(
      /Roll back the just-created evidence/,
    );
  });

  it("the executor keeps the custody chain and clears the content pointers", () => {
    // The old purge deleted custodyEvent rows, which destroyed the only record
    // that the evidence had ever existed.
    expect(code(EXECUTOR)).not.toMatch(/custodyEvent\.deleteMany/);
    expect(EXECUTOR).toMatch(/storageBucket: null/);
    expect(EXECUTOR).toMatch(/storageKey: null/);
  });
});

// ===========================================================================
// 4. Routes do not write lifecycle state; single and bulk share one service
// ===========================================================================

describe("routes are adapters over the canonical lifecycle service", () => {
  it("no route writes an Evidence lifecycle timestamp or state pointer", () => {
    const routeCode = code(EVIDENCE_ROUTES);
    for (const field of [
      "archivedAt: new Date\\(\\)",
      "archivedAt: null",
      "deletedAt: now",
      "deleteScheduledForUtc",
    ]) {
      expect(
        routeCode,
        `evidence.routes.ts must not write ${field} — the lifecycle service owns it`,
      ).not.toMatch(new RegExp(`data:\\s*\\{[^}]*${field}`));
    }
  });

  it("the four single routes dispatch to applyEvidenceLifecycleAction", () => {
    for (const action of [
      '"ARCHIVE"',
      '"UNARCHIVE"',
      '"TRASH"',
      '"RESTORE_FROM_TRASH"',
    ]) {
      expect(EVIDENCE_ROUTES).toContain(`action: ${action},`);
    }
    expect(EVIDENCE_ROUTES).toMatch(/applyEvidenceLifecycleAction\(/);
  });

  it("bulk lifecycle branches call the SAME service through one mapping table", () => {
    expect(EVIDENCE_ROUTES).toMatch(/const BULK_LIFECYCLE_ACTION = \{/);
    expect(EVIDENCE_ROUTES).toMatch(
      /action: BULK_LIFECYCLE_ACTION\[body\.action\],/,
    );
    // The four bulk branches must share ONE body. A branch with its own
    // prisma.evidence.update is the drift this replaces.
    const bulkStart = EVIDENCE_ROUTES.indexOf('case "ARCHIVE":');
    const bulkEnd = EVIDENCE_ROUTES.indexOf('case "EXPORT_METADATA_CSV"');
    const bulkBlock = EVIDENCE_ROUTES.slice(bulkStart, bulkEnd);
    expect(bulkBlock).not.toMatch(/prisma\.evidence\.update\(/);
  });

  it("restore-from-trash no longer authorizes on creator identity", () => {
    // The old route loaded the row and 403'd unless the caller was the
    // CREATOR — so a workspace member holding `evidence.delete` was refused and
    // a creator who had lost every membership was allowed. Scoped to the
    // restore handler: an owner comparison elsewhere in this 12k-line file is a
    // different route's business.
    const start = EVIDENCE_ROUTES.indexOf('"/v1/evidence/:id/restore"');
    expect(start).toBeGreaterThan(-1);
    const handler = EVIDENCE_ROUTES.slice(start, start + 1600);
    expect(handler).not.toMatch(/ownerUserId !== /);
    expect(handler).toMatch(/action: "RESTORE_FROM_TRASH"/);
    expect(LIFECYCLE_SERVICE).toMatch(/resolveEvidenceDestructiveAccess\(/);
  });

  it("the retention assert that blocked soft-trash is gone", () => {
    expect(code(EVIDENCE_ROUTES)).not.toMatch(
      /assertEvidenceDeletionAllowedByRetention\s*\(/,
    );
  });
});

// ===========================================================================
// 5. The browser holds no lifecycle decision
// ===========================================================================

describe("the web surfaces consume the projection and decide nothing", () => {
  it("the eligibility module reads no raw retention column", () => {
    const body = code(WEB_ELIGIBILITY);
    for (const column of [
      "storageObjectLockMode",
      "storageObjectLockRetainUntilUtc",
      "storageObjectLockLegalHoldStatus",
      "retentionUntilUtc",
    ]) {
      expect(
        body,
        `the browser must not read ${column} — it cannot see the hold tables`,
      ).not.toContain(column);
    }
  });

  it("it reads the canonical projection", () => {
    expect(WEB_ELIGIBILITY).toMatch(/export function getEvidenceLifecycle/);
    expect(WEB_ELIGIBILITY).toMatch(/lifecycle\.canTrash/);
  });

  it("the projection type stays field-for-field with the shared authority", () => {
    const shared = AUTHORITY.slice(
      AUTHORITY.indexOf("export interface EvidenceLifecycleProjection {"),
    );
    const sharedFields = [
      ...shared.slice(0, shared.indexOf("\n}")).matchAll(/^\s{2}(\w+)[?]?:/gm),
    ].map((m) => m[1]);
    expect(sharedFields.length).toBeGreaterThan(10);
    for (const field of sharedFields) {
      expect(
        WEB_TYPES,
        `the web projection type is missing "${field}"`,
      ).toMatch(new RegExp(`\\n\\s{2}${field}:`));
    }
  });

  it("Evidence Details renders retention as a fact, not as a refusal", () => {
    expect(REVIEW_TAB).toMatch(/data-evidence-retention-posture/);
    expect(REVIEW_TAB).toMatch(/getRetentionPosture\(/);
    // The retired copy tied a retention date to the trash control.
    expect(REVIEW_TAB).not.toMatch(/cannot be moved to trash before that date/);
    expect(WEB_ELIGIBILITY).not.toMatch(/cannot be moved to trash before that date/);
  });

  it("Evidence Details offers actions from the projection, per state", () => {
    expect(REVIEW_TAB).toMatch(/lifecycle\?\.canArchive/);
    expect(REVIEW_TAB).toMatch(/lifecycle\?\.canUnarchive/);
    expect(REVIEW_TAB).toMatch(/lifecycle\?\.canRestoreFromTrash/);
    // A destroyed record gets a tombstone and no mutable action.
    expect(REVIEW_TAB).toMatch(/productState === "DESTROYED"/);
    expect(REVIEW_TAB).toMatch(/data-evidence-tombstone/);
  });

  it("bulk availability comes from the same projection for all four actions", () => {
    expect(BULK_TOOLBAR).toMatch(/getEvidenceLifecycle\(item\)/);
    for (const cap of [
      "lifecycle.canArchive",
      "lifecycle.canUnarchive",
      "lifecycle.canTrash",
      "lifecycle.canRestoreFromTrash",
    ]) {
      expect(BULK_TOOLBAR).toContain(cap);
    }
  });
});

// ===========================================================================
// 6. Terminology
// ===========================================================================

describe("the library speaks Active / Archived / Trash", () => {
  it("the scope union names trash, not deleted", () => {
    expect(WEB_TYPES).toMatch(
      /export type EvidenceListScope =\s*"active" \| "archived" \| "trash" \| "locked";/,
    );
    expect(EVIDENCE_ROUTES).toMatch(
      /const EvidenceListScopeSchema = z\.enum\(\[\s*"active",\s*"archived",\s*"trash",/,
    );
  });

  it("no user-visible label calls the scope Deleted", () => {
    expect(WEB_FILTERS).toMatch(/\{ value: "trash", label: "Trash" \}/);
    expect(WEB_FILTERS).not.toMatch(/label: "Deleted"/);
  });

  it("the scope resolver reads the projection, not the timestamps", () => {
    expect(WEB_STATUS).toMatch(/item\.lifecycle\?\.productState/);
  });

  it("the API still accepts the legacy scope value as an alias", () => {
    // Removing it outright would break the shipped mobile client.
    expect(EVIDENCE_ROUTES).toMatch(/EVIDENCE_LIST_SCOPE_WIRE_ALIASES/);
    expect(EVIDENCE_ROUTES).toMatch(/deleted: "trash"/);
  });
});

// ===========================================================================
// 7. The 90-day value is a recovery boundary
// ===========================================================================

describe("the 90-day value is a trash recovery boundary", () => {
  it("the constant says what it is", () => {
    expect(LIFECYCLE_SERVICE).toMatch(/export const TRASH_GRACE_DAYS = 90;/);
  });

  it("no surface promises automatic deletion in 90 days", () => {
    for (const [label, source] of [
      ["Evidence Details", REVIEW_TAB],
      ["eligibility module", WEB_ELIGIBILITY],
    ] as const) {
      expect(
        code(source),
        `${label} must not promise scheduled deletion`,
      ).not.toMatch(/Scheduled deletion/);
    }
    expect(REVIEW_TAB).toMatch(/Recoverable until/);
  });
});

// ===========================================================================
// 8. Automatic destruction is disabled by default
// ===========================================================================

describe("automatic production destruction stays gated", () => {
  const RECONCILER = src("services/worker/src/governance/trash-grace-reconciler.ts");

  it("the flag defaults to disabled and is read at call time", () => {
    expect(RECONCILER).toMatch(
      /AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED[\s\S]{0,120}=== "true"/,
    );
    // `?? ""` means an unset variable is not "true" — the default is off.
    expect(RECONCILER).toMatch(
      /process\.env\.AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED \?\? ""/,
    );
  });

  it("the enqueue is the only thing the flag gates, and dry-run overrides it", () => {
    expect(RECONCILER).toMatch(
      /const observeOnly = dryRun \|\| !automaticDestructionEnabled\(\);/,
    );
    expect(RECONCILER).toMatch(/if \(observeOnly\) \{\s*disposition = "ELIGIBLE_OBSERVE_ONLY";/);
  });

  it("the candidate report cannot mutate, whatever the flag says", () => {
    const REPORT = src("services/worker/src/scripts/destruction-candidates.ts");
    expect(REPORT).toMatch(/dryRun: true/);
    expect(code(REPORT)).not.toMatch(/prisma\./);
  });
});
