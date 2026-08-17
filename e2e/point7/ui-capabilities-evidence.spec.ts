/**
 * PHASE 13 — POINT 7: JOURNEY E, the evidence-governance and video-redaction
 * write surfaces.
 *
 * Three registered write routes had no product surface:
 *
 *   POST /v1/governance/evidence/:id/publish      — public verification on
 *   POST /v1/governance/evidence/:id/unpublish    — public verification off
 *   POST /v1/redaction/videos/:evidenceId/frames/batch
 *   POST /v1/redaction/videos/:evidenceId/tracks/group
 *
 * The redaction pair is the more consequential absence. The video review
 * workspace could merge, split, approve and reject TRACKS, and tracks are
 * drawn against registered FRAMES — of which the product could register none.
 * Every control on that surface was operating on an empty set, which is a
 * shape server-layer tests cannot detect: each route was individually
 * correct, and the journey between them did not exist.
 *
 * THE STEP-UP LEG IS PART OF THE JOURNEY, NOT AN EXCUSE
 * ---------------------------------------------------------------------------
 * `publish` and `unpublish` are gated by `requireStepUpForSensitiveAction`
 * (governance.routes.ts:837-845 and :875-883) — a DIFFERENT mechanism from
 * the account step-up the workspace-lifecycle routes use. It accepts nothing
 * but an `x-proovra-step-up-challenge-id` naming a challenge that was
 * APPROVED out of band with a one-time code.
 *
 * That gate is untouched here. What changed is only where the code comes
 * from: the recording messaging provider mints and records it locally, the
 * way the recording EMAIL provider already does for invitation links, so the
 * handset the operator would have read is readable. Every leg below runs
 * through the product's own routes — `step-up/start`, `step-up/check`, then
 * the original mutation retried once with the challenge id — and the
 * middleware consumes the challenge exactly once. Nothing reads the
 * `step_up_challenges` row: the service never persists the code, so a
 * database-driven approval could only be manufactured by writing one, which
 * would demonstrate that the gate can be written around rather than that a
 * user can pass it.
 *
 * WHAT "REQUIRES PUBLISHED FIRST" ACTUALLY MEANS, MEASURED RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 * The withdrawal CONTROL requires it: the panel renders the withdraw button
 * only when `summary.state === "PUBLISHED"` and otherwise renders the publish
 * button in its place (PublicVerifyPublicationPanel.tsx:102, :290-320). The
 * ROUTE does not: `ALLOWED_TRANSITIONS` in publication.service.ts:49-54 also
 * permits `NOT_PUBLISHED → UNPUBLISHED`. So the ordering is a property of the
 * surface, and this suite proves the surface's version of it — the publish
 * journey ends by asserting the withdraw control has APPEARED where the
 * publish control was, and the withdrawal journey begins by asserting that a
 * never-published record offers no withdraw control at all. Claiming the
 * server enforced an order it does not enforce would have been the easy
 * sentence and the false one.
 */

import { test, expect, type Page } from "@playwright/test";

import {
  countRows,
  directApiCall,
  handsetFor,
  login,
  provenBrowserScenario,
  sql,
} from "./_harness";
import {
  activateOnce,
  activateTwice,
  attachUiProbe,
  buildEnterpriseFixture,
  expectSurfaceRendered,
  proveMutationCapability,
  proveServerRefusal,
  seedEvidence,
  enrolContactFactor,
  stepUpWithRecordedCode,
  uniqueHandset,
  waitForSurface,
  type UiEnterpriseFixture,
  type UiProbe,
} from "./_ui-fixtures";

const SUITE = "e2e/point7/ui-capabilities-evidence.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

const EVIDENCE_ROUTE_ID = "workspace.evidence";
const REDACTION_ROUTE_ID = "workspace.review_redaction";

type EvidenceSession = {
  page: Page;
  probe: UiProbe;
  fixture: UiEnterpriseFixture;
};

async function signInAsOwner(
  page: Page,
  fixture: UiEnterpriseFixture,
): Promise<EvidenceSession> {
  const probe = await attachUiProbe(page);
  await login(page, fixture.owner);
  return { page, probe, fixture };
}

test.describe("JOURNEY E — evidence governance and video redaction", () => {
  // =========================================================================
  // 22. POST /v1/governance/evidence/:id/publish
  //
  // The full journey, step-up included: the panel refuses the first attempt
  // with 401 STEP_UP_REQUIRED, the challenge is started and approved through
  // the product's own routes with the code the handset actually received, and
  // the ORIGINAL mutation is retried once with the challenge id. Every
  // dimension the driver asserts applies here unchanged — the challenge is a
  // leg of the journey, not a reason to check less.
  //
  // `apiFetch` no longer replays a 401 that names a deliberate denial code, so
  // one activation is one POST. The driver still counts SUCCESSFUL mutations
  // rather than requests on a step-up surface, because a challenge is not a
  // write; if the request count ever doubles, that is the replay regression
  // returning, not expected behaviour.
  // =========================================================================

  test("p7.ui.evidence.public_verify_published", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "ev-publish" });
    const { probe } = await signInAsOwner(page, fixture);

    const ws = fixture.tenant.workspaceId;

    /**
     * A PAIR of subjects, both moved to NOT_PUBLISHED.
     *
     * `Evidence.publicVerifyState` DEFAULTS to PUBLISHED, so a freshly created
     * record renders the WITHDRAW control; moving it to NOT_PUBLISHED is
     * initial state, and the transition that follows is the product's.
     *
     * There are two of them because publication is one-way on its subject:
     * once the authorized pass has published a record the panel offers
     * withdrawal in place of publication, so the injected-500 pass would be
     * acting on a surface that no longer carries the control — the product
     * behaving correctly, reported as a failure. `open()` selects whichever
     * subject is still unpublished. The durable count spans the pair, so
     * "exactly one row moved" stays exactly as strict as everywhere else.
     */
    const subjects: string[] = [];
    for (const n of [1, 2]) {
      const id = await seedEvidence(page, {
        teamId: ws,
        title: `P7 UI public-verify subject ${n}`,
      });
      subjects.push(id);
    }
    await sql(
      `UPDATE evidence SET public_verify_state = 'NOT_PUBLISHED'::"PublicVerifyState"
        WHERE id = ANY($1::uuid[])`,
      [subjects],
    );
    let target = subjects[0]!;

    // One handset per journey: the provider rate-limits verification starts
    // per recipient per hour, and the recorder answers with the newest code
    // for an alias — two journeys sharing a number would read each other's.
    const handset = uniqueHandset();

    /**
     * PHASE 13 (FIXTURE CORRECTION) — ENROL THE CONTACT FACTOR FIRST.
     *
     * Publication is gated by `requireStepUpForSensitiveAction`, and since
     * NEW-058 that gate resolves its destination from the account's OWN ACTIVE,
     * verified contact factor rather than from a handset the caller names. An
     * account with no factor gets `STEP_UP_ENROLLMENT_REQUIRED` and the
     * challenge never leaves the enrolment step — which is exactly what
     * `stepUpWithRecordedCode` reported here, naming this remedy.
     *
     * Enrolment is a PRECONDITION of this capability, not the capability, and it
     * is driven through the product's own surface (`/settings#security`) rather
     * than seeded — an `mfa_factors` row written directly would prove the gate
     * can be written around, not that a user can satisfy it.
     */
    await enrolContactFactor(page, handset);

    // Everything the handset received UP TO HERE belongs to the precondition.
    const handsetBaseline = handsetFor(handset, "verification_start").length;


    const publishControl = () => page.locator("[data-cc-public-verify-publish]");

    const open = async () => {
      const rows = await sql<{ id: string }>(
        `SELECT id FROM evidence
          WHERE id = ANY($1::uuid[])
            AND public_verify_state = 'NOT_PUBLISHED'::"PublicVerifyState"
          ORDER BY created_at ASC`,
        [subjects],
      );
      expect(
        rows.length,
        "both subjects are already published — the fixture can no longer offer " +
          "the control under test",
      ).toBeGreaterThan(0);
      target = rows[0]!.id;

      await page.goto(`/evidence/${target}?tab=overview`, {
        waitUntil: "domcontentloaded",
      });
      await expectSurfaceRendered(page, EVIDENCE_ROUTE_ID);
      await expect(
        page.locator('[data-evidence-section="public-verify-publication"]'),
        "the public-verify panel is rendered only when useEnterpriseSurfaceAccess() " +
          "is true. If it is absent on a workspace whose Organization holds an " +
          "ACTIVE ENTERPRISE contract, the enterprise projection in the " +
          "platform-context envelope is the defect, not this test.",
      ).toBeVisible({ timeout: 30_000 });

      const blocked = page.locator("[data-cc-public-verify-blocked]");
      if ((await blocked.count()) > 0) {
        throw new Error(
          `The publish control is blocked: "${(await blocked.first().textContent())?.trim()}". ` +
            "The four preconditions are reviewWorkflow.teamId, " +
            "workspaceCapabilitySnapshot.publicVerifyIncluded, summary.enabled and " +
            "summary.configured (PublicVerifyPublicationPanel.tsx:106-116). " +
            "`configured` is derived from getAnchorStatus(), which for a record " +
            "with no evidence_anchors row is Boolean(process.env.ANCHOR_PROVIDER) — " +
            "so the API process must export ANCHOR_PROVIDER.",
        );
      }
      await expect(publishControl()).toBeEnabled({ timeout: 30_000 });
    };

    // The internal note is optional and is recorded in the custody chain only
    // — filling it is what proves it never reaches the public surface.
    const arm = async () => {
      await page
        .locator("[data-cc-public-verify-reason]")
        .fill("Published by the Point-7 UI capability matrix.");
    };

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.evidence.public_verify_published",
        pageUrl: "/evidence/{id}",
        control:
          '[data-cc-public-verify-publish] → [data-confirm-action-modal="evidence-public-verify-publish"] → step-up',
        method: "POST",
        apiPath: "POST /v1/governance/evidence/:id/publish",
        // "/publish" is NOT a substring of "/unpublish" (the character before
        // `publish` there is `n`, not `/`), so the two legs stay distinct.
        pathFragment: "/publish",
        tenantWorkspaceId: ws,
      },
      open,
      arm,
      /**
       * Publication is irreversible in the sense that matters — a link
       * already shared has been live — so the control is typed-confirm gated
       * and the DIALOG's submit issues the request. The double activation
       * targets the dialog; the panel's own control is what must be observed
       * disabling itself for the whole round trip, step-up included.
       */
      fire: async ({ double, keyboard }) => {
        await activateOnce(publishControl(), keyboard);
        const modal = page.locator(
          '[data-confirm-action-modal="evidence-public-verify-publish"]',
        );
        await expect(modal).toBeVisible({ timeout: 15_000 });
        await modal.locator("[data-confirm-action-typed-input]").fill("PUBLISH");
        const dialogSubmit = modal.locator('[data-confirm-action-submit="true"]');
        await expect(dialogSubmit).toBeEnabled({ timeout: 10_000 });
        if (double) await activateTwice(dialogSubmit, keyboard);
        else await activateOnce(dialogSubmit, keyboard);
      },
      submitControl: publishControl,
      statusRegion: () => page.locator("[data-cc-public-verify-status]"),
      countHere: () =>
        countRows(
          "evidence",
          `id = ANY($1::uuid[]) AND public_verify_state = 'PUBLISHED'::"PublicVerifyState"`,
          [subjects],
        ),
      countThere: () =>
        countRows(
          "evidence",
          `team_id = $1 AND public_verify_state = 'PUBLISHED'::"PublicVerifyState"`,
          [fixture.otherTenant.workspaceId],
        ),
      successCopy: /now published to public verification/i,
      expectStatus: 200,
      resolveStepUp: stepUpWithRecordedCode(page, handset),
      expectRefreshed: async () => {
        // The panel re-reads the record rather than patching its own state,
        // and the proof is that the CONTROL changed identity: publication and
        // withdrawal are the same slot, and only the server's answer decides
        // which one occupies it.
        await expect(
          page.locator('[data-evidence-section="public-verify-publication"]'),
          "the panel must re-read and report the new state without a reload",
        ).toHaveAttribute("data-cc-public-verify-state", "PUBLISHED", {
          timeout: 20_000,
        });
        await expect(
          page.locator("[data-cc-public-verify-unpublish]"),
          "a published record must now offer withdrawal — this is the ordering " +
            "the withdrawal capability depends on, asserted rather than assumed",
        ).toBeVisible({ timeout: 20_000 });
        await expect(
          publishControl(),
          "and it must stop offering to publish what is already published",
        ).toHaveCount(0);
        // The internal note is custody-chain only. A note that reached the
        // public surface would be a privacy failure, not a copy bug.
        const custody = await countRows(
          "custody_events",
          "evidence_id = $1 AND event_type = 'PUBLIC_VERIFY_PUBLISHED'",
          [target],
        );
        expect(
          custody,
          "publication must be recorded in the custody chain",
        ).toBeGreaterThan(0);
      },
    });

    proven("p7.ui.evidence.public_verify_published");

    // The step-up challenge was genuinely exercised: a code was minted for
    // this handset and consumed. Asserted from the recorder, because the
    // database deliberately holds no code to check.
    /**
     * PHASE 13 (SPEC CORRECTION) — COUNT THE CHALLENGE'S CODE, NOT THE
     * PRECONDITION'S.
     *
     * Since NEW-058 the step-up gate resolves its destination from the account's
     * own ENROLLED contact factor, so enrolment and the challenge necessarily
     * address the SAME handset — enrolling on a different number would leave the
     * gate with no factor to resolve. That means this handset legitimately
     * receives two `verification_start` records in the journey: one to enrol the
     * factor (the precondition) and one for the challenge (the behaviour).
     *
     * A flat `toBe(1)` over the whole run therefore measured the fixture rather
     * than the product. The claim is preserved exactly by baselining at the point
     * enrolment finishes — the same discipline `proveMutationCapability` uses for
     * the console — so "the CHALLENGE sent exactly one code" stays a strict
     * assertion, and a challenge that silently sent two still fails.
     */
    const handsetTraffic = handsetFor(handset, "verification_start").slice(
      handsetBaseline,
    );
    expect(
      handsetTraffic.length,
      "the challenge must have sent exactly one code to this handset",
    ).toBe(1);
    expect(
      handsetTraffic[0]!.code,
      "a verification_start with no code means a provider other than the " +
        "recording one served the request",
    ).toBeTruthy();

    // A caller in another tenant is refused before the gate is even reached
    // (`requireMember(..., "evidence.publish_verify")` runs first), so the
    // refusal is the SERVER's and not a hidden button's.
    await page.context().clearCookies();
    await login(page, fixture.outsider);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.evidence.public_verify_published",
      pageUrl: "/evidence/{id}",
      control: "[data-cc-public-verify-publish]",
      method: "POST",
      apiPath: "POST /v1/governance/evidence/:id/publish",
      requestPath: `/v1/governance/evidence/${subjects[1]}/publish`,
      body: { teamId: ws, reason: null },
      tenantWorkspaceId: ws,
      countRowsNow: () =>
        countRows(
          "evidence",
          `id = ANY($1::uuid[]) AND public_verify_state = 'PUBLISHED'::"PublicVerifyState"`,
          [subjects],
        ),
    });
  });

  // =========================================================================
  // 23. POST /v1/governance/evidence/:id/unpublish
  //
  // Its own test rather than a tail on the publication journey, because two
  // full driver passes plus two step-up challenges in one test would be one
  // test doing two capabilities' worth of work — and the first thing to break
  // under that weight is the wall clock, which fails for a reason unrelated
  // to the product.
  //
  // The ordering the withdrawal control depends on is not assumed away: the
  // journey opens by proving that a NEVER-PUBLISHED record offers no
  // withdrawal control at all, and the publication journey above ends by
  // proving that publishing is what makes it appear.
  // =========================================================================

  test("p7.ui.evidence.public_verify_unpublished", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "ev-unpublish" });
    const { probe } = await signInAsOwner(page, fixture);

    const ws = fixture.tenant.workspaceId;

    // --- The precondition, measured on a record that was never published.
    const neverPublished = await seedEvidence(page, {
      teamId: ws,
      title: "P7 UI never-published record",
    });
    await sql(
      `UPDATE evidence SET public_verify_state = 'NOT_PUBLISHED'::"PublicVerifyState" WHERE id = $1`,
      [neverPublished],
    );
    await page.goto(`/evidence/${neverPublished}?tab=overview`, {
      waitUntil: "domcontentloaded",
    });
    await expectSurfaceRendered(page, EVIDENCE_ROUTE_ID);
    /**
     * PHASE 13 (SPEC CORRECTION) — the PERSISTED COLUMN and the PROJECTED
     * SUMMARY STATE are two different vocabularies, deliberately.
     *
     * The `UPDATE` above writes the column `public_verify_state =
     * 'NOT_PUBLISHED'`, and this assertion then expected that same spelling back
     * out of the UI. The API does not echo the column — it PROJECTS an operator-
     * facing state (`evidence.routes.ts:4206-4208`):
     *
     *   case "NOT_PUBLISHED": case null:
     *     state: configured ? "CONFIGURED_NOT_PUBLISHED" : "NOT_CONFIGURED"
     *
     * The distinction is the product's design, not drift: the panel's own
     * blocked-reason ladder branches on `!published && !summary.configured` to
     * say "this record has no publishable verification surface configured yet",
     * so "not published, but there IS something to publish" has to be a
     * different answer from "there is nothing to publish".
     *
     * `configured` is deterministic in this run, not incidental: the runner
     * exports `ANCHOR_PROVIDER`, which is what makes a record with no anchor row
     * report a configured verification surface. So the exact projected state is
     * asserted — this is a tightening, not a relaxation: the previous expectation
     * could never hold, and the weaker "anything that is not PUBLISHED" would
     * not distinguish a configured record from an unconfigurable one.
     */
    await expect(
      page.locator('[data-evidence-section="public-verify-publication"]'),
    ).toHaveAttribute(
      "data-cc-public-verify-state",
      "CONFIGURED_NOT_PUBLISHED",
      { timeout: 30_000 },
    );
    await expect(
      page.locator("[data-cc-public-verify-unpublish]"),
      "a record that was never published must not offer withdrawal — the " +
        "control and the state are the same slot",
    ).toHaveCount(0);
    await expect(
      page.locator("[data-cc-public-verify-publish]"),
      "…and must offer publication in its place",
    ).toBeVisible({ timeout: 20_000 });

    /**
     * A PAIR of PUBLISHED subjects, left at the schema default rather than
     * driven through the publication form — publication is capability
     * twenty-two and is driven through the browser there. Re-driving it here
     * would be re-proving that capability rather than proving withdrawal, and
     * would put two step-up challenges in one test.
     *
     * Two of them for the same reason as above: withdrawal is one-way on its
     * subject, so the injected-500 pass needs a record still in the
     * pre-state.
     */
    const subjects: string[] = [];
    for (const n of [1, 2]) {
      const id = await seedEvidence(page, {
        teamId: ws,
        title: `P7 UI withdrawal subject ${n}`,
      });
      subjects.push(id);
    }
    const seededStates = await sql<{ public_verify_state: string }>(
      `SELECT public_verify_state FROM evidence WHERE id = ANY($1::uuid[])`,
      [subjects],
    );
    expect(
      seededStates.map((r) => r.public_verify_state),
      "a freshly created record is expected to default to PUBLISHED; if that " +
        "default changed, this precondition must be seeded explicitly instead",
    ).toEqual(["PUBLISHED", "PUBLISHED"]);

    let target = subjects[0]!;
    const handset = uniqueHandset();

    /**
     * PHASE 13 (FIXTURE CORRECTION) — ENROL THE CONTACT FACTOR FIRST.
     *
     * Publication is gated by `requireStepUpForSensitiveAction`, and since
     * NEW-058 that gate resolves its destination from the account's OWN ACTIVE,
     * verified contact factor rather than from a handset the caller names. An
     * account with no factor gets `STEP_UP_ENROLLMENT_REQUIRED` and the
     * challenge never leaves the enrolment step — which is exactly what
     * `stepUpWithRecordedCode` reported here, naming this remedy.
     *
     * Enrolment is a PRECONDITION of this capability, not the capability, and it
     * is driven through the product's own surface (`/settings#security`) rather
     * than seeded — an `mfa_factors` row written directly would prove the gate
     * can be written around, not that a user can satisfy it.
     */
    await enrolContactFactor(page, handset);

    // Everything the handset received UP TO HERE belongs to the precondition.
    const handsetBaseline = handsetFor(handset, "verification_start").length;


    const unpublishControl = () =>
      page.locator("[data-cc-public-verify-unpublish]");

    const open = async () => {
      const rows = await sql<{ id: string }>(
        `SELECT id FROM evidence
          WHERE id = ANY($1::uuid[])
            AND public_verify_state = 'PUBLISHED'::"PublicVerifyState"
          ORDER BY created_at ASC`,
        [subjects],
      );
      expect(
        rows.length,
        "both subjects are already withdrawn — the fixture can no longer offer " +
          "the control under test",
      ).toBeGreaterThan(0);
      target = rows[0]!.id;

      await page.goto(`/evidence/${target}?tab=overview`, {
        waitUntil: "domcontentloaded",
      });
      await expectSurfaceRendered(page, EVIDENCE_ROUTE_ID);
      await expect(
        page.locator('[data-evidence-section="public-verify-publication"]'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(unpublishControl()).toBeEnabled({ timeout: 30_000 });
    };

    const arm = async () => {
      await page
        .locator("[data-cc-public-verify-reason]")
        .fill("Withdrawn by the Point-7 UI capability matrix.");
    };

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.evidence.public_verify_unpublished",
        pageUrl: "/evidence/{id}",
        control:
          '[data-cc-public-verify-unpublish] → [data-confirm-action-modal="evidence-public-verify-unpublish"] → step-up',
        method: "POST",
        apiPath: "POST /v1/governance/evidence/:id/unpublish",
        pathFragment: "/unpublish",
        tenantWorkspaceId: ws,
      },
      open,
      arm,
      // Withdrawal is confirmation-gated but NOT typed-confirm gated: taking
      // a public link down is the safe direction, and a typed phrase in front
      // of the safe direction is a reason not to take it.
      fire: async ({ double, keyboard }) => {
        await activateOnce(unpublishControl(), keyboard);
        const modal = page.locator(
          '[data-confirm-action-modal="evidence-public-verify-unpublish"]',
        );
        await expect(modal).toBeVisible({ timeout: 15_000 });
        const dialogSubmit = modal.locator('[data-confirm-action-submit="true"]');
        await expect(dialogSubmit).toBeEnabled({ timeout: 10_000 });
        if (double) await activateTwice(dialogSubmit, keyboard);
        else await activateOnce(dialogSubmit, keyboard);
      },
      submitControl: unpublishControl,
      statusRegion: () => page.locator("[data-cc-public-verify-status]"),
      countHere: () =>
        countRows(
          "evidence",
          `id = ANY($1::uuid[]) AND public_verify_state = 'UNPUBLISHED'::"PublicVerifyState"`,
          [subjects],
        ),
      countThere: () =>
        countRows(
          "evidence",
          `team_id = $1 AND public_verify_state = 'UNPUBLISHED'::"PublicVerifyState"`,
          [fixture.otherTenant.workspaceId],
        ),
      successCopy: /withdrawn from public verification/i,
      expectStatus: 200,
      resolveStepUp: stepUpWithRecordedCode(page, handset),
      expectRefreshed: async () => {
        await expect(
          page.locator('[data-evidence-section="public-verify-publication"]'),
          "the panel must re-read and report the withdrawn state without a reload",
        ).toHaveAttribute("data-cc-public-verify-state", "UNPUBLISHED", {
          timeout: 20_000,
        });
        await expect(
          unpublishControl(),
          "a withdrawn record must stop offering withdrawal",
        ).toHaveCount(0, { timeout: 20_000 });
        const custody = await countRows(
          "custody_events",
          "evidence_id = $1 AND event_type = 'PUBLIC_VERIFY_UNPUBLISHED'",
          [target],
        );
        expect(
          custody,
          "withdrawal must be recorded in the custody chain",
        ).toBeGreaterThan(0);
      },
    });

    proven("p7.ui.evidence.public_verify_unpublished");

    // Baselined past the enrolment code for the same reason as the publish
    // journey above: NEW-058 makes enrolment and the challenge share one
    // handset, so only the records AFTER enrolment belong to the challenge.
    const handsetTraffic = handsetFor(handset, "verification_start").slice(
      handsetBaseline,
    );
    expect(
      handsetTraffic.length,
      "the challenge must have sent exactly one code to this handset",
    ).toBe(1);
    expect(handsetTraffic[0]!.code).toBeTruthy();

    await page.context().clearCookies();
    await login(page, fixture.outsider);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.evidence.public_verify_unpublished",
      pageUrl: "/evidence/{id}",
      control: "[data-cc-public-verify-unpublish]",
      method: "POST",
      apiPath: "POST /v1/governance/evidence/:id/unpublish",
      requestPath: `/v1/governance/evidence/${subjects[1]}/unpublish`,
      body: { teamId: ws, reason: null },
      tenantWorkspaceId: ws,
      countRowsNow: () =>
        countRows(
          "evidence",
          `id = ANY($1::uuid[]) AND public_verify_state = 'UNPUBLISHED'::"PublicVerifyState"`,
          [subjects],
        ),
    });
  });


  // =========================================================================
  // 24. Video frame registration and track grouping
  //
  // ONE capability, TWO mutations, and they are ordered rather than
  // independent: the track panel is inert until frames exist, because a track
  // is a claim about frames. Asserting only the second would be asserting a
  // control that could never have been reached.
  // =========================================================================

  test("p7.ui.redaction.video_frames_and_tracks_authored", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "redaction-video" });
    const { probe } = await signInAsOwner(page, fixture);

    const ws = fixture.tenant.workspaceId;
    const evidenceId = await seedEvidence(page, {
      teamId: ws,
      title: "P7 UI video redaction subject",
      type: "VIDEO",
    });

    // The project and its DRAFT version are the SUBJECT of this capability,
    // not the capability — they are created through the real routes from
    // inside the authenticated page so their state is the one the write path
    // computes.
    const projectRes = await directApiCall(page, {
      method: "POST",
      path: "/v1/redaction/projects",
      body: { evidenceId, artifactKind: "VIDEO", title: "P7 UI video project" },
    });
    expect(
      projectRes.status,
      `opening the redaction project failed: ${projectRes.body}`,
    ).toBeLessThan(300);
    const projectId = (JSON.parse(projectRes.body) as { projectId: string }).projectId;
    expect(projectId, "the project route must return a project id").toBeTruthy();

    const versionRes = await directApiCall(page, {
      method: "POST",
      path: `/v1/redaction/projects/${projectId}/versions`,
      body: { rationale: "Point-7 UI capability matrix" },
    });
    expect(
      versionRes.status,
      `creating the draft version failed: ${versionRes.body}`,
    ).toBe(201);

    const openWorkspace = async () => {
      await page.goto(`/redaction/${projectId}`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, REDACTION_ROUTE_ID);
      await waitForSurface(page, "[data-redaction-video-review-workspace]");
    };

    // -----------------------------------------------------------------------
    // 24a. POST /v1/redaction/videos/:evidenceId/frames/batch — 202 Accepted
    // -----------------------------------------------------------------------
    const frameSubmit = () =>
      page.locator("[data-redaction-video-frame-batch-submit]");

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.redaction.video_frames_and_tracks_authored",
        pageUrl: "/redaction/{projectId}",
        control: "[data-redaction-video-frame-batch-submit] — “Register frames”",
        method: "POST",
        apiPath: "POST /v1/redaction/videos/:evidenceId/frames/batch",
        pathFragment: "/frames/batch",
        tenantWorkspaceId: ws,
      },
      open: async () => {
        await openWorkspace();
        await waitForSurface(page, "[data-redaction-video-frame-batch]");
        await expect(
          page.locator("[data-redaction-video-frame-locked]"),
          "a DRAFT version must not report its frame set as fixed",
        ).toHaveCount(0);
        await expect(frameSubmit()).toBeEnabled({ timeout: 30_000 });
      },
      /**
       * EXACTLY ONE frame. Not an arbitrary small number: the durable
       * assertion in the driver is "the row count moved by one", and it is
       * that strict everywhere else in this matrix. Registering sixty frames
       * would have meant relaxing the shared invariant for this capability
       * alone.
       */
      arm: async () => {
        await page.locator("[data-redaction-video-frame-start]").fill("0");
        await page.locator("[data-redaction-video-frame-count]").fill("1");
        await page.locator("[data-redaction-video-frame-interval]").fill("1000");
      },
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(frameSubmit(), keyboard);
        else await activateOnce(frameSubmit(), keyboard);
      },
      submitControl: frameSubmit,
      statusRegion: () => page.locator("[data-redaction-video-frame-status]"),
      countHere: () =>
        countRows("video_frames", "team_id = $1 AND evidence_id = $2", [
          ws,
          evidenceId,
        ]),
      countThere: () =>
        countRows("video_frames", "team_id = $1", [fixture.otherTenant.workspaceId]),
      successCopy: /Registered 1 new frame/i,
      // The route answers 202: registering a sampling grid is an accepted
      // description of work already done, not a completed computation.
      expectStatus: 202,
      expectRefreshed: async () => {
        // The parent bumps the frames token, which is what un-blocks the
        // track panel below. That is the cache invalidation that matters
        // here, and it is observable as the panel changing its own state.
        await expect(
          page.locator("[data-redaction-video-track-blocked]"),
          "registering frames must unblock the track panel without a reload",
        ).toHaveCount(0, { timeout: 20_000 });
      },
    });

    // -----------------------------------------------------------------------
    // 24b. POST /v1/redaction/videos/:evidenceId/tracks/group — 200 OK
    //
    // The same bbox across a contiguous range gives IoU 1.0, so the server's
    // grouping produces exactly one track from the single registered frame.
    // -----------------------------------------------------------------------
    const trackSubmit = () =>
      page.locator("[data-redaction-video-track-group-submit]");

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.redaction.video_frames_and_tracks_authored",
        pageUrl: "/redaction/{projectId}",
        control: "[data-redaction-video-track-group-submit] — “Group frames into tracks”",
        method: "POST",
        apiPath: "POST /v1/redaction/videos/:evidenceId/tracks/group",
        pathFragment: "/tracks/group",
        tenantWorkspaceId: ws,
      },
      open: async () => {
        await openWorkspace();
        await waitForSurface(page, "[data-redaction-video-track-grouping]");
        await expect(
          page.locator("[data-redaction-video-track-blocked]"),
          "the track panel must be operable once frames are registered",
        ).toHaveCount(0, { timeout: 30_000 });
        await expect(trackSubmit()).toBeEnabled({ timeout: 30_000 });
      },
      arm: async () => {
        await page.locator("[data-redaction-video-track-kind]").selectOption("FACE");
        await page.locator("[data-redaction-video-track-from]").fill("0");
        await page.locator("[data-redaction-video-track-to]").fill("0");
        await page.locator("[data-redaction-video-track-bbox-x]").fill("0.2");
        await page.locator("[data-redaction-video-track-bbox-y]").fill("0.2");
        await page.locator("[data-redaction-video-track-bbox-width]").fill("0.2");
        await page.locator("[data-redaction-video-track-bbox-height]").fill("0.2");
        await page.locator("[data-redaction-video-track-confidence]").fill("0.8");
        await page.locator("[data-redaction-video-track-iou]").fill("0.3");
      },
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(trackSubmit(), keyboard);
        else await activateOnce(trackSubmit(), keyboard);
      },
      submitControl: trackSubmit,
      statusRegion: () => page.locator("[data-redaction-video-track-status]"),
      countHere: () =>
        countRows("video_tracks", "team_id = $1 AND evidence_id = $2", [
          ws,
          evidenceId,
        ]),
      countThere: () =>
        countRows("video_tracks", "team_id = $1", [fixture.otherTenant.workspaceId]),
      successCopy: /Grouped 1 detection into 1 track/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        // The detection the track was built from is durable too — a track
        // with no detections would be a label with nothing under it.
        await expect
          .poll(
            async () =>
              countRows("video_track_detections", "team_id = $1", [ws]),
            {
              message: "the grouped detection must be persisted",
              timeout: 20_000,
            },
          )
          .toBeGreaterThan(0);
      },
    });

    proven("p7.ui.redaction.video_frames_and_tracks_authored");

    // `redaction.administer` is held only by REDACTION_ADMINISTRATOR, which
    // resolves from an OWNER/ADMIN workspace role — so an ordinary member is
    // refused by the SERVER, from inside their own authenticated page.
    await page.context().clearCookies();
    await login(page, fixture.member);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.redaction.video_frames_and_tracks_authored",
      pageUrl: "/redaction/{projectId}",
      control: "[data-redaction-video-frame-batch-submit]",
      method: "POST",
      apiPath: "POST /v1/redaction/videos/:evidenceId/frames/batch",
      requestPath: `/v1/redaction/videos/${evidenceId}/frames/batch`,
      body: {
        extractor: "FFMPEG_SAMPLE",
        samplePreset: "EVERY_1S",
        frames: [{ frameIndex: 900, timestampMs: 900_000 }],
      },
      tenantWorkspaceId: ws,
      countRowsNow: () =>
        countRows("video_frames", "team_id = $1 AND evidence_id = $2", [
          ws,
          evidenceId,
        ]),
    });
  });
});
