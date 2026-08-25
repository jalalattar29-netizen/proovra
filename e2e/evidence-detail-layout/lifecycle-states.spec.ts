/**
 * BROWSER VERIFICATION — the Evidence lifecycle section, in every state.
 *
 * WHY A BROWSER GATE FOR THIS
 * ---------------------------------------------------------------------------
 * The source contract proves the component READS the canonical projection. It
 * cannot prove what a user is offered, and the defect this convergence closed
 * was entirely about what a user was offered: a record retained until 2034 was
 * shown a disabled "Move to trash" button under an amber alert reading "It
 * cannot be moved to trash before that date" — for an operation that deletes
 * nothing and restores intact. Every part of that was rendered, none of it was
 * visible from a unit test, and all of it was wrong.
 *
 * So this drives the REAL production bundle through the four mutually exclusive
 * lifecycle shapes and asserts what is actually painted:
 *
 *   ACTIVE     → Archive + Move to trash, no restore
 *   ARCHIVED   → Restore to active + Move to trash, no archive
 *   TRASHED    → Restore from trash ONLY
 *   DESTROYED  → a tombstone and NO mutable action at all
 *
 * plus the case the whole program is named after: a record retained until 2034,
 * under COMPLIANCE Object Lock, whose "Move to trash" is ENABLED and whose
 * retention is reported separately as a constraint on physical destruction.
 *
 * The API is intercepted, so this reaches no database and no bucket — the web
 * tier is the only real thing, which is what makes it safe to run a destructive
 * surface's gate at all.
 */

import { expect, test, type Page } from "@playwright/test";

import { EVIDENCE_ID, installApi, type EvidenceOverride } from "./_fixtures";

const FAR_FUTURE = "2034-06-14T00:00:00.000Z";
const PAST = "2027-01-04T00:00:00.000Z";

/** A canonical projection as the API emits it, with the state under test set. */
function lifecycle(over: Record<string, unknown> = {}) {
  return {
    productState: "ACTIVE",
    canArchive: true,
    canUnarchive: false,
    canTrash: true,
    canRestoreFromTrash: false,
    trashBlockReason: null,
    archiveBlockReason: null,
    trashGraceUntilUtc: null,
    appRetentionUntilUtc: null,
    objectLockRetainUntilUtc: null,
    effectiveRetentionUntilUtc: null,
    objectLockCompliance: false,
    legalHold: false,
    destructionEligibleAtUtc: null,
    destructionBlockReason: null,
    ...over,
  };
}

async function openLifecycle(
  page: Page,
  evidence: EvidenceOverride,
): Promise<void> {
  await installApi(page, "organization", evidence);
  // The lifecycle section lives on the Review tab.
  await page.goto(`/evidence/${EVIDENCE_ID}?tab=review`);
  await page.waitForSelector('[data-evidence-section="record-actions"]', {
    timeout: 30_000,
  });
}

/** The lifecycle action buttons actually present, by their stable attribute. */
async function actions(page: Page): Promise<string[]> {
  return page
    .locator('[data-evidence-section="record-actions"] [data-evidence-action]')
    .evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.evidenceAction ?? ""),
    );
}

test.describe("Evidence Detail — lifecycle states", () => {
  test("ACTIVE offers Archive and Move to trash, and no restore", async ({
    page,
  }) => {
    await openLifecycle(page, {
      lifecycle: lifecycle(),
      archivedAt: null,
      deletedAt: null,
      lockedAt: null,
    });

    expect(await actions(page)).toEqual(["archive", "trash"]);
    const trash = page.locator('[data-evidence-action="trash"]');
    await expect(trash).toBeEnabled();
    await expect(
      page.locator("[data-evidence-trash-helper]"),
    ).toHaveCount(0);
    await expect(page.locator("[data-evidence-tombstone]")).toHaveCount(0);

    // THE REPORTED SYMPTOM, pinned as a string.
    //
    // The panel showed "Record state is loading. Try again in a moment." for
    // this exact record — permanently, because the response the page reads
    // carried no lifecycle projection and the eligibility helper refuses to
    // guess. A loading message is only ever truthful while something is
    // loading; once the record has rendered its controls, it is a lie about
    // the record's state.
    await expect(page.getByText("Record state is loading")).toHaveCount(0);
  });

  test("a record RETAINED UNTIL 2034 can still be moved to trash", async ({
    page,
  }) => {
    // THE headline case. Before the convergence this rendered a disabled button
    // and told the user to come back in eight years.
    await openLifecycle(page, {
      lifecycle: lifecycle({
        appRetentionUntilUtc: FAR_FUTURE,
        objectLockRetainUntilUtc: FAR_FUTURE,
        effectiveRetentionUntilUtc: FAR_FUTURE,
        objectLockCompliance: true,
        destructionEligibleAtUtc: FAR_FUTURE,
        destructionBlockReason: "OBJECT_LOCK_RETENTION_ACTIVE",
      }),
      archivedAt: null,
      deletedAt: null,
      lockedAt: null,
    });

    const trash = page.locator('[data-evidence-action="trash"]');
    await expect(trash).toBeEnabled();
    await expect(trash).toHaveAttribute("data-evidence-trash-reason", "ELIGIBLE");
    // No "unavailable" alert, because it is available.
    await expect(page.locator("[data-evidence-trash-helper]")).toHaveCount(0);

    // Retention is reported as a FACT about the record, in its own block, and
    // it names what it actually constrains.
    const posture = page.locator("[data-evidence-retention-posture]");
    await expect(posture).toBeVisible();
    await expect(page.locator("[data-evidence-retained-until]")).toHaveText(
      "Retained until Jun 14, 2034",
    );
    await expect(page.locator("[data-evidence-object-lock]")).toHaveText(
      "Object Lock: Compliance",
    );
    await expect(page.locator("[data-evidence-destruction-note]")).toHaveText(
      "Physical destruction unavailable until Jun 14, 2034",
    );
    // The retired copy, in any form, must not be anywhere on the page.
    await expect(page.locator("body")).not.toContainText(
      "cannot be moved to trash before that date",
    );
  });

  test("ARCHIVED offers Restore to active and Move to trash, not Archive", async ({
    page,
  }) => {
    await openLifecycle(page, {
      lifecycle: lifecycle({
        productState: "ARCHIVED",
        canArchive: false,
        canUnarchive: true,
        canTrash: true,
      }),
      archivedAt: PAST,
      deletedAt: null,
      lockedAt: null,
    });

    expect(await actions(page)).toEqual(["restore-archive", "trash"]);
    await expect(
      page.locator('[data-evidence-action="restore-archive"]'),
    ).toHaveText("Restore to active");
  });

  test("TRASHED offers ONLY Restore from trash", async ({ page }) => {
    await openLifecycle(page, {
      lifecycle: lifecycle({
        productState: "TRASHED",
        canArchive: false,
        canUnarchive: false,
        canTrash: false,
        canRestoreFromTrash: true,
        trashBlockReason: "ALREADY_IN_STATE",
        trashGraceUntilUtc: "2027-04-04T00:00:00.000Z",
      }),
      archivedAt: null,
      deletedAt: PAST,
      deleteScheduledForUtc: "2027-04-04T00:00:00.000Z",
      lockedAt: null,
    });

    expect(await actions(page)).toEqual(["restore-trash"]);
    // No "Move to trash is unavailable" alert for a record that IS in the
    // trash — that was noise the state made meaningless.
    await expect(page.locator("[data-evidence-trash-helper]")).toHaveCount(0);
  });

  test("the 90-day value is labelled as a recovery boundary, not a deletion date", async ({
    page,
  }) => {
    await openLifecycle(page, {
      lifecycle: lifecycle({
        productState: "TRASHED",
        canArchive: false,
        canTrash: false,
        canRestoreFromTrash: true,
        trashBlockReason: "ALREADY_IN_STATE",
        trashGraceUntilUtc: "2027-04-04T00:00:00.000Z",
      }),
      deletedAt: PAST,
      deleteScheduledForUtc: "2027-04-04T00:00:00.000Z",
    });

    // Scoped to the lifecycle section: the Review tab renders a second
    // facts grid for relationships, and an unscoped locator matches both.
    const facts = page.locator(
      '[data-evidence-section="record-actions"] [data-evidence-facts-grid]',
    );
    await expect(facts).toContainText("Recoverable until");
    await expect(facts).toContainText("Moved to trash");
    // The old labels promised something the system never did.
    await expect(facts).not.toContainText("Scheduled deletion");
    await expect(facts).not.toContainText("Deleted at");
  });

  test("DESTROYED shows a tombstone and NO mutable action", async ({ page }) => {
    await openLifecycle(page, {
      lifecycle: lifecycle({
        productState: "DESTROYED",
        canArchive: false,
        canUnarchive: false,
        canTrash: false,
        canRestoreFromTrash: false,
        trashBlockReason: "TERMINAL_DESTROYED",
      }),
      archivedAt: null,
      deletedAt: PAST,
      lockedAt: null,
    });

    expect(await actions(page)).toEqual([]);
    const tombstone = page.locator("[data-evidence-tombstone]");
    await expect(tombstone).toBeVisible();
    await expect(tombstone).toContainText("This record has been destroyed");
    await expect(tombstone).toContainText("the removal was verified");
  });

  test("a LEGAL HOLD blocks trash and says so — without mentioning retention", async ({
    page,
  }) => {
    await openLifecycle(page, {
      lifecycle: lifecycle({
        canTrash: false,
        trashBlockReason: "LEGAL_HOLD_ACTIVE",
        legalHold: true,
        appRetentionUntilUtc: FAR_FUTURE,
        effectiveRetentionUntilUtc: FAR_FUTURE,
      }),
      archivedAt: null,
      deletedAt: null,
      lockedAt: null,
    });

    const trash = page.locator('[data-evidence-action="trash"]');
    await expect(trash).toBeDisabled();
    await expect(trash).toHaveAttribute(
      "data-evidence-trash-reason",
      "LEGAL_HOLD",
    );
    const helper = page.locator("[data-evidence-trash-helper]");
    await expect(helper).toBeVisible();
    await expect(helper).toContainText("legal hold");
    // The reason is the hold. Retention is reported separately, as its own
    // fact, and is not offered as an explanation for the block.
    await expect(helper).not.toContainText("2034");
    await expect(page.locator("[data-evidence-legal-hold]")).toHaveText(
      "Legal hold: active",
    );
  });

  test("a LEGAL HOLD also withdraws Archive, and the page says which actions are gone", async ({
    page,
  }) => {
    // The projection is what the API now emits for a held record: BOTH verdicts
    // false, both with the same reason. Before the correction the same record
    // came back with `canArchive: true`, so the page offered an Archive button
    // whose click returned 409 — and for a personal-scope record the click
    // actually archived it.
    await openLifecycle(page, {
      lifecycle: lifecycle({
        canArchive: false,
        archiveBlockReason: "LEGAL_HOLD_ACTIVE",
        canTrash: false,
        trashBlockReason: "LEGAL_HOLD_ACTIVE",
        legalHold: true,
      }),
      archivedAt: null,
      deletedAt: null,
      lockedAt: null,
    });

    // No Archive control at all — not a disabled one, because archive under a
    // hold is not "try again later", it is unavailable while the hold stands.
    await expect(page.locator('[data-evidence-action="archive"]')).toHaveCount(0);

    const helper = page.locator("[data-evidence-trash-helper]");
    // The heading covers BOTH withdrawn actions. "Move to trash is
    // unavailable" beside a vanished Archive button describes half the page.
    await expect(helper).toContainText("Lifecycle changes are unavailable");
    // …and the verdict is stated rather than left to be inferred from a
    // control that is not on the page.
    await expect(helper).toHaveAttribute(
      "data-evidence-archive-reason",
      "LEGAL_HOLD_ACTIVE",
    );
    // The alternative-action copy must NOT appear: offering "Archive instead"
    // under a hold that blocks archive is the contradiction being removed.
    await expect(helper).not.toContainText("Archive removes the record");
  });

  test("a disabled trash control cannot open the confirmation modal", async ({
    page,
  }) => {
    await openLifecycle(page, {
      lifecycle: lifecycle({
        canTrash: false,
        trashBlockReason: "EVIDENCE_LOCKED",
      }),
      lockedAt: PAST,
      archivedAt: null,
      deletedAt: null,
    });

    const wrapper = page.locator("[data-evidence-trash-wrapper]");
    await expect(wrapper).toHaveAttribute("data-evidence-trash-disabled", "true");
    // Force the click past the disabled attribute: the guard in the handler is
    // what must refuse, not the browser's own pointer-event suppression.
    await wrapper.locator("button").click({ force: true }).catch(() => undefined);
    await expect(page.locator("[role=dialog]")).toHaveCount(0);
  });
});
