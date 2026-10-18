/**
 * PHASE 13 — POINT 7: JOURNEY E, the evidence-governance and video-redaction
 * write surfaces.
 *
 *   PUT  /v1/evidence/:id/verification-disclosure   — what the record's
 *        permanent verification page discloses (2026-10-18; it replaces the
 *        retired /v1/governance/evidence/:id/publish|unpublish routes)
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
 * WIDENING a verification page's disclosure (Verification only → Content
 * preview, or showing the recorded location) is gated by
 * `requireStepUpForSensitiveAction` with purpose PUBLIC_VERIFY_PUBLISH — the
 * gate publication carried. It accepts nothing but an
 * `x-proovra-step-up-challenge-id` naming a challenge that was APPROVED out of
 * band with a one-time code. Narrowing never needs it.
 *
 * That gate is untouched here. What changed is only where the code comes
 * from: the recording messaging provider mints and records it locally, the
 * way the recording EMAIL provider already does for invitation links, so the
 * handset the operator would have read is readable. Every leg below runs
 * through the product's own routes — `step-up/start`, `step-up/check`, then
 * the original mutation retried once with the challenge id — and the
 * middleware consumes the challenge exactly once. Nothing reads the
 * `step_up_challenges` row.
 *
 * There is no "publish first" ordering any more: every finalized record has
 * its page, and the disclosure is a compare-and-swap on the record's policy
 * version, recorded in the custody chain as VERIFICATION_DISCLOSURE_CHANGED.
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
  // 22. PUT /v1/evidence/:id/verification-disclosure — WIDENING (step-up)
  //
  // The full journey, step-up included: the save is refused with 401
  // STEP_UP_REQUIRED, the challenge is started and approved through the
  // product's own routes with the code the handset actually received, and the
  // ORIGINAL mutation is retried once with the challenge id. The driver counts
  // SUCCESSFUL mutations on a step-up surface, because a challenge is not a
  // write.
  // =========================================================================

  test("p7.ui.evidence.verification_disclosure_widened", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "ev-disclosure-widen" });
    const { probe } = await signInAsOwner(page, fixture);
    const ws = fixture.tenant.workspaceId;

    /**
     * A PAIR of subjects, both disclosing VERIFICATION_ONLY (the default).
     * Once the authorized pass has widened one, the injected-500 pass needs a
     * subject that still offers the change; `open()` selects it. The durable
     * count spans the pair, so "exactly one row moved" stays strict.
     */
    const subjects: string[] = [];
    for (const n of [1, 2]) {
      subjects.push(await seedEvidence(page, { teamId: ws, title: `P7 UI disclosure subject ${n}` }));
    }
    let target = subjects[0]!;

    const handset = uniqueHandset();
    // The step-up gate resolves its destination from the account's OWN
    // enrolled factor (NEW-058): enrolment is the precondition, driven
    // through the product's own surface.
    await enrolContactFactor(page, handset);
    const handsetBaseline = handsetFor(handset, "verification_start").length;

    const panel = () => page.locator('[data-evidence-section="verification-page"]');
    const contentPreview = () => panel().locator('[data-verification-disclosure-mode="CONTENT_PREVIEW"]');
    const saveControl = () => panel().locator('[data-verification-disclosure-action="save"]');

    const open = async () => {
      const rows = await sql<{ id: string }>(
        `SELECT id FROM evidence
          WHERE id = ANY($1::uuid[]) AND verification_disclosure_mode::text = 'VERIFICATION_ONLY'
          ORDER BY created_at ASC`,
        [subjects],
      );
      expect(rows.length, "both subjects already show a content preview").toBeGreaterThan(0);
      target = rows[0]!.id;
      await page.goto(`/evidence/${target}?tab=artifacts`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, EVIDENCE_ROUTE_ID);
      await expect(panel().locator('[role="radiogroup"]')).toBeVisible({ timeout: 30_000 });
      await expect(contentPreview()).toBeEnabled({ timeout: 30_000 });
    };

    const arm = async () => {
      await contentPreview().click();
      await expect(saveControl()).toBeEnabled({ timeout: 10_000 });
    };

    const widened = (where: string, params: unknown[]) =>
      countRows("evidence", `${where} AND verification_disclosure_mode::text = 'CONTENT_PREVIEW'`, params);

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.evidence.verification_disclosure_widened",
        pageUrl: "/evidence/{id}?tab=artifacts",
        control: '[data-verification-disclosure-mode="CONTENT_PREVIEW"] → [data-verification-disclosure-action="save"] → step-up',
        method: "PUT",
        apiPath: "PUT /v1/evidence/:id/verification-disclosure",
        pathFragment: "/verification-disclosure",
        tenantWorkspaceId: ws,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(saveControl(), keyboard);
        else await activateOnce(saveControl(), keyboard);
      },
      submitControl: saveControl,
      statusRegion: () => panel().locator("[data-verification-disclosure-notice]"),
      errorStatusRegion: () => panel().locator("[data-verification-disclosure-problem]"),
      countHere: () => widened("id = ANY($1::uuid[])", [subjects]),
      countThere: () => widened("team_id = $1", [fixture.otherTenant.workspaceId]),
      successCopy: /Saved\. The verification page now shows: Content preview/i,
      expectStatus: 200,
      resolveStepUp: stepUpWithRecordedCode(page, handset),
      expectRefreshed: async () => {
        // The panel prints the SERVER's answer: the saved mode and its preview.
        await expect(panel().locator("[data-verification-disclosure]")).toHaveAttribute(
          "data-verification-disclosure",
          "CONTENT_PREVIEW",
          { timeout: 20_000 },
        );
        await expect(saveControl()).toBeDisabled();
        const custody = await countRows(
          "custody_events",
          "evidence_id = $1 AND event_type = 'VERIFICATION_DISCLOSURE_CHANGED'",
          [target],
        );
        expect(custody, "the change must be recorded in the custody chain").toBeGreaterThan(0);
      },
    });

    proven("p7.ui.evidence.verification_disclosure_widened");

    const handsetTraffic = handsetFor(handset, "verification_start").slice(handsetBaseline);
    expect(handsetTraffic.length, "the challenge must have sent exactly one code to this handset").toBe(1);
    expect(handsetTraffic[0]!.code).toBeTruthy();

    // A caller in another tenant is refused by the SERVER, not a hidden control.
    await page.context().clearCookies();
    await login(page, fixture.outsider);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.evidence.verification_disclosure_widened",
      pageUrl: "/evidence/{id}?tab=artifacts",
      control: '[data-verification-disclosure-action="save"]',
      method: "PUT",
      apiPath: "PUT /v1/evidence/:id/verification-disclosure",
      requestPath: `/v1/evidence/${subjects[1]}/verification-disclosure`,
      body: { mode: "CONTENT_PREVIEW", showRecordedLocation: false, expectedVersion: 0 },
      tenantWorkspaceId: ws,
      countRowsNow: () => widened("id = ANY($1::uuid[])", [subjects]),
    });
  });

  // =========================================================================
  // 23. PUT /v1/evidence/:id/verification-disclosure — NARROWING (no step-up)
  //
  // Its own test: narrowing a page back to Verification only is never gated,
  // and that is a claim about the product that deserves its own proof rather
  // than a tail on the widening journey.
  // =========================================================================

  test("p7.ui.evidence.verification_disclosure_narrowed", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "ev-disclosure-narrow" });
    const { probe } = await signInAsOwner(page, fixture);
    const ws = fixture.tenant.workspaceId;

    const subjects: string[] = [];
    for (const n of [1, 2]) {
      subjects.push(await seedEvidence(page, { teamId: ws, title: `P7 UI narrowing subject ${n}` }));
    }
    // Initial state, not the transition under test: both pages show a content
    // preview with the recorded location.
    await sql(
      `UPDATE evidence
          SET verification_disclosure_mode = 'CONTENT_PREVIEW', show_recorded_location = true
        WHERE id = ANY($1::uuid[])`,
      [subjects],
    );
    let target = subjects[0]!;

    const panel = () => page.locator('[data-evidence-section="verification-page"]');
    const verificationOnly = () => panel().locator('[data-verification-disclosure-mode="VERIFICATION_ONLY"]');
    const saveControl = () => panel().locator('[data-verification-disclosure-action="save"]');

    const open = async () => {
      const rows = await sql<{ id: string }>(
        `SELECT id FROM evidence
          WHERE id = ANY($1::uuid[]) AND verification_disclosure_mode::text = 'CONTENT_PREVIEW'
          ORDER BY created_at ASC`,
        [subjects],
      );
      expect(rows.length, "both subjects already disclose verification only").toBeGreaterThan(0);
      target = rows[0]!.id;
      await page.goto(`/evidence/${target}?tab=artifacts`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, EVIDENCE_ROUTE_ID);
      await expect(panel().locator("[data-verification-disclosure-location]")).toBeChecked({ timeout: 30_000 });
    };

    const arm = async () => {
      await verificationOnly().click();
      // Narrowing clears the location and disables it — the reason is stated.
      await expect(panel().locator("[data-verification-disclosure-location]")).toBeDisabled();
      await expect(panel().locator("[data-verification-disclosure-location-help]")).toContainText(
        "Available only with Content preview",
      );
      await expect(saveControl()).toBeEnabled({ timeout: 10_000 });
    };

    const narrowed = (where: string, params: unknown[]) =>
      countRows(
        "evidence",
        `${where} AND verification_disclosure_mode::text = 'VERIFICATION_ONLY' AND show_recorded_location = false`,
        params,
      );

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.evidence.verification_disclosure_narrowed",
        pageUrl: "/evidence/{id}?tab=artifacts",
        control: '[data-verification-disclosure-mode="VERIFICATION_ONLY"] → [data-verification-disclosure-action="save"]',
        method: "PUT",
        apiPath: "PUT /v1/evidence/:id/verification-disclosure",
        pathFragment: "/verification-disclosure",
        tenantWorkspaceId: ws,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(saveControl(), keyboard);
        else await activateOnce(saveControl(), keyboard);
      },
      submitControl: saveControl,
      statusRegion: () => panel().locator("[data-verification-disclosure-notice]"),
      errorStatusRegion: () => panel().locator("[data-verification-disclosure-problem]"),
      countHere: () => narrowed("id = ANY($1::uuid[])", [subjects]),
      countThere: () => narrowed("team_id = $1", [fixture.otherTenant.workspaceId]),
      successCopy: /Saved\. The verification page now shows: Verification only/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        await expect(panel().locator("[data-verification-disclosure]")).toHaveAttribute(
          "data-verification-disclosure",
          "VERIFICATION_ONLY",
          { timeout: 20_000 },
        );
        const custody = await countRows(
          "custody_events",
          "evidence_id = $1 AND event_type = 'VERIFICATION_DISCLOSURE_CHANGED'",
          [target],
        );
        expect(custody).toBeGreaterThan(0);
      },
    });

    proven("p7.ui.evidence.verification_disclosure_narrowed");

    await page.context().clearCookies();
    await login(page, fixture.outsider);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.evidence.verification_disclosure_narrowed",
      pageUrl: "/evidence/{id}?tab=artifacts",
      control: '[data-verification-disclosure-action="save"]',
      method: "PUT",
      apiPath: "PUT /v1/evidence/:id/verification-disclosure",
      requestPath: `/v1/evidence/${subjects[1]}/verification-disclosure`,
      body: { mode: "VERIFICATION_ONLY", showRecordedLocation: false, expectedVersion: 0 },
      tenantWorkspaceId: ws,
      countRowsNow: () => narrowed("id = ANY($1::uuid[])", [subjects]),
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
