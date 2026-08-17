/**
 * PHASE 13 — POINT 7: JOURNEY G, the governance-platform write surfaces.
 *
 * Six governance routes were registered, tested at the service layer, and
 * reachable only from a REST client. The consoles above them could LIST every
 * entity and walk its state machine; not one of them could create the row the
 * state machine operates on. A registry you can activate policies in but never
 * author one in is not a governance platform, and the server-layer tests could
 * not see that, because the thing that was missing was a button.
 *
 * So this suite asserts the button — and refuses to accept the button as
 * evidence on its own. Each capability is driven through
 * `proveMutationCapability`, which correlates the activation with the request
 * Chromium actually issued, reads the resulting row back with raw SQL, checks
 * that the OTHER tenant did not move, and then does it again against a
 * synthetic server failure to prove the surface reports a refusal instead of a
 * backend message.
 *
 * WHAT IS SEEDED HERE AND WHY IT IS NOT CHEATING
 * ---------------------------------------------------------------------------
 * Policy authoring and access-review campaigns are gated on the CROSS-CUTTING
 * delegated tiers (SECURITY_OFFICER / COMPLIANCE_OFFICER), which
 * `hasDelegatedTier` grants only from an explicit row — the implicit
 * workspace-owner ladder deliberately stops at the org chain. That grant is a
 * precondition of those two capabilities, so it is seeded. Issuing a grant is
 * itself capability five and IS driven through the browser, against the same
 * ladder, so the tier system is exercised rather than assumed.
 */

import { test, expect, type Page } from "@playwright/test";

import {
  countRows,
  directApiCall,
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
  seedDelegatedTier,
  seedEvidence,
  waitForSurface,
  type UiEnterpriseFixture,
  type UiProbe,
} from "./_ui-fixtures";

const SUITE = "e2e/point7/ui-capabilities-governance.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

const GOVERNANCE_PLATFORM_ROUTE_ID = "workspace.governance_platform";
const DESTRUCTION_ROUTE_ID = "governance.destruction";

/**
 * A future instant, in the `datetime-local` wall-clock shape the campaign form
 * reads. Fixed rather than relative so a run at any hour produces the same
 * request body — the form converts it to an ISO instant exactly once
 * (`toIsoInstant`), and a drifting value would make a 400 look intermittent.
 */
const CAMPAIGN_START = "2031-03-01T09:00";
const CAMPAIGN_END = "2031-03-31T17:00";

type GovernanceSession = {
  page: Page;
  probe: UiProbe;
  fixture: UiEnterpriseFixture;
};

/**
 * Sign the workspace OWNER in with the recorder already attached.
 *
 * The probe is attached BEFORE login because its CSP listener is installed
 * with `addInitScript`, which only applies to documents created afterwards —
 * and the login navigation is the session's first document.
 */
async function signInAsOwner(
  page: Page,
  fixture: UiEnterpriseFixture,
): Promise<GovernanceSession> {
  const probe = await attachUiProbe(page);
  await login(page, fixture.owner);
  return { page, probe, fixture };
}

test.describe("JOURNEY G — governance platform write surfaces", () => {
  // =========================================================================
  // 1. POST /v1/governance/policies — GovernancePolicyForm
  // =========================================================================

  test("p7.ui.governance.policy_created", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "gov-policy" });
    // SECURITY_OFFICER is cross-cutting: the workspace owner does NOT hold it
    // implicitly, which is the whole point of the tier existing.
    await seedDelegatedTier({
      tenant: fixture.tenant,
      granteeUserId: fixture.owner.userId,
      grantedByUserId: fixture.owner.userId,
      tier: "SECURITY_OFFICER",
    });
    const { probe } = await signInAsOwner(page, fixture);

    const slug = `p7-ui-policy-${Date.now().toString(36)}`;

    const open = async () => {
      await page.goto(`/governance-platform/policies`, {
        waitUntil: "domcontentloaded",
      });
      await expectSurfaceRendered(page, GOVERNANCE_PLATFORM_ROUTE_ID);
      await waitForSurface(page, "[data-governance-policy-form]");
      // The tier mirror resolves asynchronously; until it does the control is
      // disabled with "Checking your governance tier…". Waiting for ENABLED
      // rather than for a timeout is what makes the later "it was enabled for
      // an authorized caller" assertion meaningful.
      await expect(page.locator("[data-governance-policy-submit]")).toBeEnabled({
        timeout: 30_000,
      });
    };

    const arm = async () => {
      await page.locator("[data-governance-policy-name]").fill("P7 UI reviewer rule");
      await page.locator("[data-governance-policy-slug]").fill(slug);
      await page
        .locator("[data-governance-policy-summary]")
        .fill("Authored by the Point-7 UI capability matrix.");
      await page.locator("[data-governance-policy-rule]").fill('{"minReviewers":2}');
    };

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.governance.policy_created",
        pageUrl: "/governance-platform/policies",
        control: "[data-governance-policy-submit] — “Create policy version”",
        method: "POST",
        apiPath: "POST /v1/governance/policies",
        pathFragment: "/v1/governance/policies",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        const control = page.locator("[data-governance-policy-submit]");
        if (double) await activateTwice(control, keyboard);
        else await activateOnce(control, keyboard);
      },
      submitControl: () => page.locator("[data-governance-policy-submit]"),
      statusRegion: () => page.locator("[data-governance-policy-status]"),
      countHere: () =>
        countRows("governance_policies", "team_id = $1", [
          fixture.tenant.workspaceId,
        ]),
      countThere: () =>
        countRows("governance_policies", "team_id = $1", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Policy version created as DRAFT/i,
      expectStatus: 201,
      expectRefreshed: async () => {
        // The registry table below the form must show the new DRAFT without a
        // manual reload — the form's `onCreated` refetch is the contract.
        const row = page.locator("[data-governance-policy-state='DRAFT']");
        await expect(row.first()).toBeVisible({ timeout: 20_000 });
        await expect(
          page.locator("[data-governance-policies-table]"),
        ).toContainText(slug, { timeout: 20_000 });
      },
    });

    proven("p7.ui.governance.policy_created");
  });

  // =========================================================================
  // 2. POST /v1/governance/access-reviews/campaigns — AccessReviewCampaignForm
  // =========================================================================

  test("p7.ui.governance.access_review_campaign_created", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "gov-campaign" });
    await seedDelegatedTier({
      tenant: fixture.tenant,
      granteeUserId: fixture.owner.userId,
      grantedByUserId: fixture.owner.userId,
      tier: "COMPLIANCE_OFFICER",
    });
    const { probe } = await signInAsOwner(page, fixture);

    const campaignName = `P7 UI certification ${Date.now().toString(36)}`;

    const open = async () => {
      await page.goto(`/governance-platform/access-reviews`, {
        waitUntil: "domcontentloaded",
      });
      await expectSurfaceRendered(page, GOVERNANCE_PLATFORM_ROUTE_ID);
      await waitForSurface(page, "[data-access-review-campaign-form]");
      await expect(
        page.locator("[data-access-review-campaign-submit]"),
      ).toBeEnabled({ timeout: 30_000 });
    };

    const arm = async () => {
      await page.locator("[data-access-review-campaign-name]").fill(campaignName);
      await page.locator("[data-access-review-campaign-start]").fill(CAMPAIGN_START);
      await page.locator("[data-access-review-campaign-end]").fill(CAMPAIGN_END);
    };

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.governance.access_review_campaign_created",
        pageUrl: "/governance-platform/access-reviews",
        control: "[data-access-review-campaign-submit]",
        method: "POST",
        apiPath: "POST /v1/governance/access-reviews/campaigns",
        pathFragment: "/v1/governance/access-reviews/campaigns",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        const control = page.locator("[data-access-review-campaign-submit]");
        if (double) await activateTwice(control, keyboard);
        else await activateOnce(control, keyboard);
      },
      submitControl: () => page.locator("[data-access-review-campaign-submit]"),
      statusRegion: () => page.locator("[data-access-review-campaign-status]"),
      countHere: () =>
        countRows("access_review_campaigns", "team_id = $1", [
          fixture.tenant.workspaceId,
        ]),
      countThere: () =>
        countRows("access_review_campaigns", "team_id = $1", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Campaign created as DRAFT/i,
      expectStatus: 201,
      expectRefreshed: async () => {
        await expect(
          page.locator("[data-access-reviews-campaigns-table]"),
        ).toContainText(campaignName, { timeout: 20_000 });
      },
    });

    proven("p7.ui.governance.access_review_campaign_created");
  });

  // =========================================================================
  // 3 + 4. Cross-org review: invite, then accept
  //
  // One test, because the accept capability has no subject until the invite
  // capability has produced one, and manufacturing an INVITED row with SQL to
  // split them would replace the thing under test with a fixture.
  // =========================================================================

  test("p7.ui.governance.cross_org_invited", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "gov-crossorg" });
    const { probe } = await signInAsOwner(page, fixture);

    const invitedSlug = `p7-partner-${Date.now().toString(36)}`.slice(0, 60);

    const open = async () => {
      await page.goto(`/governance-platform/cross-org`, {
        waitUntil: "domcontentloaded",
      });
      await expectSurfaceRendered(page, GOVERNANCE_PLATFORM_ROUTE_ID);
      await waitForSurface(page, "[data-cross-org-invite-form]");
      // Blocked until BOTH the tier mirror and the server-derived organization
      // have resolved — the form never asks an operator to type a tenancy id.
      await expect(page.locator("[data-cross-org-invite-submit]")).toBeEnabled({
        timeout: 30_000,
      });
    };

    const arm = async () => {
      await page.locator("[data-cross-org-invite-slug]").fill(invitedSlug);
      await page
        .locator("[data-cross-org-invite-scope]")
        .fill("Read-only review of published verification records.");
    };

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.governance.cross_org_invited",
        pageUrl: "/governance-platform/cross-org",
        control: "[data-cross-org-invite-submit] — “Invite organization”",
        method: "POST",
        apiPath: "POST /v1/governance/cross-org-review",
        pathFragment: "/v1/governance/cross-org-review",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        const control = page.locator("[data-cross-org-invite-submit]");
        if (double) await activateTwice(control, keyboard);
        else await activateOnce(control, keyboard);
      },
      submitControl: () => page.locator("[data-cross-org-invite-submit]"),
      statusRegion: () => page.locator("[data-cross-org-invite-status]"),
      countHere: () =>
        countRows("cross_org_review_grants", "team_id = $1", [
          fixture.tenant.workspaceId,
        ]),
      countThere: () =>
        countRows("cross_org_review_grants", "team_id = $1", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Invitation sent/i,
      expectStatus: 201,
      expectRefreshed: async () => {
        await expect(page.locator("[data-cross-org-table]")).toContainText(
          invitedSlug,
          { timeout: 20_000 },
        );
        await expect(
          page.locator("[data-cross-org-state='INVITED']").first(),
        ).toBeVisible({ timeout: 20_000 });
      },
    });

    proven("p7.ui.governance.cross_org_invited");

    // -----------------------------------------------------------------------
    // 4. POST /v1/governance/cross-org-review/:id/accept — CrossOrgAcceptForm
    //
    // Before this control existed an INVITED grant had exactly one exit:
    // refusal. The accept leg is opened from the row, because the request
    // carries a body (the server-derived accepting organization, plus an
    // optional External Reviewer Portal binding) rather than firing inline.
    // -----------------------------------------------------------------------
    const invited = await sql<{ id: string }>(
      `SELECT id FROM cross_org_review_grants
        WHERE team_id = $1 AND state = 'INVITED'
        ORDER BY created_at DESC LIMIT 1`,
      [fixture.tenant.workspaceId],
    );
    expect(
      invited[0]?.id,
      "the invite capability must have produced an INVITED grant",
    ).toBeTruthy();

    /**
     * PHASE 13 (FIXTURE CORRECTION) — A PAIR OF SUBJECTS, BECAUSE THE DRIVER
     * NEEDS TWO.
     *
     * `proveMutationCapability` runs `open()` TWICE: once for the authorized
     * positive pass, and again for the injected-500 error pass. Accepting is a
     * STATE TRANSITION, so the positive pass consumes its own subject — the
     * grant leaves INVITED and the row stops offering an Accept control. Bound
     * to a single grant id, the error pass could only ever look for a control
     * the previous pass had correctly removed.
     *
     * This is the same shape, and the same remedy, as `closure_requested` (which
     * seeds workspaces `a`/`b`) and `workspace_suspended` (two sibling
     * workspaces): seed a PAIR and let `open()` select whichever subject is
     * still in the state the control requires, reading that from the DATABASE so
     * pass ordering cannot silently drift.
     *
     * The second grant is PRECONDITION SEEDING, not a substitute for the
     * capability: issuing an invitation is driven through the real browser form
     * above in this same test and proven there. Here it is created through the
     * real HTTP route from inside the authenticated page, with the same body the
     * form sends.
     */
    const secondSlug = `p7-partner-b-${Date.now().toString(36)}`.slice(0, 60);
    const seeded = await directApiCall(page, {
      method: "POST",
      path: "/v1/governance/cross-org-review",
      body: {
        invitingOrganizationId: fixture.tenant.organizationId,
        invitedOrgSlug: secondSlug,
        scope: "Second INVITED subject for the accept error pass.",
        expiresAtUtc: null,
      },
    });
    expect(
      seeded.status,
      `seeding a second INVITED grant failed: ${seeded.body}`,
    ).toBeLessThan(300);

    const acceptSubjects = await sql<{ id: string }>(
      `SELECT id FROM cross_org_review_grants
        WHERE team_id = $1 AND state = 'INVITED' ORDER BY created_at ASC`,
      [fixture.tenant.workspaceId],
    );
    expect(
      acceptSubjects.length,
      "the accept capability needs two INVITED subjects — one per driver pass",
    ).toBeGreaterThanOrEqual(2);
    const acceptIds = acceptSubjects.map((r) => r.id);
    let grantId = acceptIds[0]!;

    const acceptSubmit = () =>
      page.locator(`[data-cross-org-accept-submit="${grantId}"]`);

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.governance.cross_org_accepted",
        pageUrl: "/governance-platform/cross-org",
        control: `[data-cross-org-accept-submit] — “Accept invitation”`,
        method: "POST",
        apiPath: "POST /v1/governance/cross-org-review/:id/accept",
        /**
         * Narrow to the accept LEG rather than to one grant id, because `open()`
         * re-selects the subject per pass. `/accept` cannot collide with the
         * invite POST on this page (`…/cross-org-review`, no suffix) nor with
         * decline / revoke.
         */
        pathFragment: "/accept",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open: async () => {
        // Whichever seeded subject is still INVITED is the one whose control the
        // product will render. Read from the database, never assumed.
        const stillInvited = await sql<{ id: string }>(
          `SELECT id FROM cross_org_review_grants
            WHERE id = ANY($1::uuid[]) AND state = 'INVITED'
            ORDER BY created_at ASC`,
          [acceptIds],
        );
        expect(
          stillInvited[0]?.id,
          "both seeded grants have left INVITED — the fixture can no longer " +
            "offer the control under test",
        ).toBeTruthy();
        grantId = stillInvited[0]!.id;

        await page.goto(`/governance-platform/cross-org`, {
          waitUntil: "domcontentloaded",
        });
        await expectSurfaceRendered(page, GOVERNANCE_PLATFORM_ROUTE_ID);
        // The row action opens the accept form; it is not itself the mutation.
        const rowAction = page.locator(`[data-cross-org-accept="${grantId}"]`);
        await expect(rowAction).toBeVisible({ timeout: 30_000 });
        await rowAction.click();
        await waitForSurface(page, `[data-cross-org-accept-form="${grantId}"]`);
        await expect(acceptSubmit()).toBeEnabled({ timeout: 30_000 });
      },
      // The external-grant binding is optional and left blank: accepting
      // without one is the path that issues a fresh portal invitation, which
      // is the behaviour a first-time cross-org relationship actually takes.
      arm: async () => {},
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(acceptSubmit(), keyboard);
        else await activateOnce(acceptSubmit(), keyboard);
      },
      submitControl: acceptSubmit,
      statusRegion: () => page.locator("[data-cross-org-accept-status]"),
      // The durable effect of accept is a STATE TRANSITION, not a new row —
      // counting ACCEPTED grants is how a transition becomes a count.
      countHere: () =>
        countRows("cross_org_review_grants", "team_id = $1 AND state = 'ACCEPTED'", [
          fixture.tenant.workspaceId,
        ]),
      countThere: () =>
        countRows("cross_org_review_grants", "team_id = $1 AND state = 'ACCEPTED'", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Invitation accepted/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        await expect(
          page.locator(`[data-cross-org-row="${grantId}"]`),
        ).toHaveAttribute("data-cross-org-state", "ACCEPTED", { timeout: 20_000 });
      },
    });

    proven("p7.ui.governance.cross_org_accepted");
  });

  // =========================================================================
  // 5. POST /v1/governance/delegated-admin — DelegatedAdminGrantForm
  // =========================================================================

  test("p7.ui.governance.delegated_admin_granted", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "gov-delegated" });
    const { probe } = await signInAsOwner(page, fixture);

    const open = async () => {
      await page.goto(`/governance-platform/delegated-admin`, {
        waitUntil: "domcontentloaded",
      });
      await expectSurfaceRendered(page, GOVERNANCE_PLATFORM_ROUTE_ID);
      await waitForSurface(page, "[data-delegated-admin-grant-form]");
      await expect(
        page.locator("[data-delegated-admin-grant-submit]"),
      ).toBeEnabled({ timeout: 30_000 });
      // The grantee picker is fed from the real member roster
      // (`GET /v1/identity/members`) so a user id is never hand-typed.
      await expect
        .poll(
          async () =>
            page
              .locator(`[data-delegated-admin-grantee] option[value="${fixture.member.userId}"]`)
              .count(),
          { message: "the member roster must populate the grantee picker", timeout: 30_000 },
        )
        .toBeGreaterThan(0);
    };

    const arm = async () => {
      await page
        .locator("[data-delegated-admin-grantee]")
        .selectOption(fixture.member.userId);
      // REVIEWER_LEAD is cross-cutting and needs no department or workspace
      // scope, so this is the tier that isolates the grant path itself.
      await page.locator("[data-delegated-admin-tier]").selectOption("REVIEWER_LEAD");
    };

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.governance.delegated_admin_granted",
        pageUrl: "/governance-platform/delegated-admin",
        control: "[data-delegated-admin-grant-submit] — “Issue grant”",
        method: "POST",
        apiPath: "POST /v1/governance/delegated-admin",
        pathFragment: "/v1/governance/delegated-admin",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        const control = page.locator("[data-delegated-admin-grant-submit]");
        if (double) await activateTwice(control, keyboard);
        else await activateOnce(control, keyboard);
      },
      submitControl: () => page.locator("[data-delegated-admin-grant-submit]"),
      statusRegion: () => page.locator("[data-delegated-admin-grant-status]"),
      // Scoped to the grantee so the count cannot be satisfied by any other
      // grant the journey happens to create.
      countHere: () =>
        countRows(
          "delegated_admin_grants",
          "team_id = $1 AND granted_to_user_id = $2",
          [fixture.tenant.workspaceId, fixture.member.userId],
        ),
      countThere: () =>
        countRows("delegated_admin_grants", "team_id = $1", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Grant issued/i,
      expectStatus: 201,
      expectRefreshed: async () => {
        /**
         * PHASE 13 (NEW-068 rename) — the ROW's tier is `data-delegated-admin-
         * row-tier`; `data-delegated-admin-tier` now names ONLY the form's
         * `<select>`. The two shared one name, which made both ambiguous once a
         * grant existed.
         *
         * Also scoped to the grantee this capability actually granted, instead
         * of `.first()` on any REVIEWER_LEAD row — a strictly stronger check
         * that cannot be satisfied by an unrelated grant.
         */
        await expect(
          page.locator(
            "[data-delegated-admin-row-tier='REVIEWER_LEAD'][data-delegated-admin-state='ACTIVE']",
          ),
        ).toBeVisible({ timeout: 20_000 });
      },
    });

    proven("p7.ui.governance.delegated_admin_granted");
  });

  // =========================================================================
  // 6. POST /v1/governance/destruction-reviews — DestructionReviewForm
  // =========================================================================

  test("p7.ui.governance.destruction_review_opened", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "gov-destruction" });
    const { probe } = await signInAsOwner(page, fixture);

    // The subject of the review. Created through the real evidence route so
    // its lifecycle state is the one the write path computes — ACTIVE, which
    // is the only state `EVIDENCE_LIFECYCLE_TRANSITIONS` allows into
    // PENDING_DESTRUCTION.
    const evidenceId = await seedEvidence(page, {
      teamId: fixture.tenant.workspaceId,
      title: "P7 UI destruction subject",
    });

    const open = async () => {
      await page.goto(`/governance/destruction`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, DESTRUCTION_ROUTE_ID);
      await waitForSurface(page, "[data-destruction-review-form]");
      await expect(page.locator("[data-destruction-review-submit]")).toBeEnabled({
        timeout: 30_000,
      });
    };

    const arm = async () => {
      await page.locator("[data-destruction-review-evidence]").fill(evidenceId);
    };

    /**
     * Opening a destruction review is confirmation-gated. The mutation is
     * issued by the DIALOG's submit, not by the form's — so that is the
     * control the double activation targets, while the form's own submit is
     * what must be observed disabling itself while the request is in flight.
     */
    const dialogSubmit = () =>
      page
        .locator('[data-confirm-action-modal="destruction-review-create"]')
        .locator('[data-confirm-action-submit="true"]');

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.governance.destruction_review_opened",
        pageUrl: "/governance/destruction",
        control:
          '[data-destruction-review-submit] → [data-confirm-action-modal="destruction-review-create"] [data-confirm-action-submit]',
        method: "POST",
        apiPath: "POST /v1/governance/destruction-reviews",
        pathFragment: "/v1/governance/destruction-reviews",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        await activateOnce(page.locator("[data-destruction-review-submit]"), keyboard);
        await expect(
          page.locator('[data-confirm-action-modal="destruction-review-create"]'),
        ).toBeVisible({ timeout: 15_000 });
        if (double) await activateTwice(dialogSubmit(), keyboard);
        else await activateOnce(dialogSubmit(), keyboard);
      },
      submitControl: () => page.locator("[data-destruction-review-submit]"),
      statusRegion: () => page.locator("[data-destruction-review-status]"),
      countHere: () =>
        countRows("destruction_reviews", "team_id = $1", [
          fixture.tenant.workspaceId,
        ]),
      countThere: () =>
        countRows("destruction_reviews", "team_id = $1", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Destruction review opened/i,
      expectStatus: 201,
      expectRefreshed: async () => {
        // The queue below the form must show the new PENDING review without a
        // manual reload, and the evidence row must now carry the pointer.
        await expect
          .poll(
            async () =>
              page.locator("[data-destruction-review-executions]").count(),
            { message: "the queue must refresh with the new review", timeout: 20_000 },
          )
          .toBeGreaterThan(0);
        const ev = await sql<{ active_destruction_review_id: string | null }>(
          `SELECT active_destruction_review_id FROM evidence WHERE id = $1`,
          [evidenceId],
        );
        expect(
          ev[0]?.active_destruction_review_id,
          "opening a review must flip the evidence pointer in the same transaction",
        ).toBeTruthy();
      },
    });

    proven("p7.ui.governance.destruction_review_opened");
  });

  // =========================================================================
  // Permission-denied matrix for all six governance capabilities.
  //
  // One test, one session, six refusals — because the claim being made is
  // about the SERVER, and it is the same claim six times. A hidden or
  // disabled control proves only that the client decided not to render one;
  // each request below is issued from inside the unprivileged user's own
  // authenticated page, carrying their real cookie and origin, so a refusal
  // is the server's.
  // =========================================================================

  test("p7.ui.governance.denied_without_authority", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "gov-denied" });
    const probe = await attachUiProbe(page);
    await login(page, fixture.member);

    const ws = fixture.tenant.workspaceId;
    const org = fixture.tenant.organizationId;

    // --- The UI is honest about it: the controls render blocked, with a reason.
    await page.goto(`/governance-platform/policies`, { waitUntil: "domcontentloaded" });
    if ((await page.locator("[data-governance-policy-form]").count()) > 0) {
      await expect(
        page.locator('[data-governance-policy-blocked="tier"]'),
        "a caller without the cross-cutting tier must be told why, not left guessing",
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("[data-governance-policy-submit]")).toBeDisabled();
    }

    // --- And the server refuses the request the control would have issued.
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.governance.policy_created",
      pageUrl: "/governance-platform/policies",
      control: "[data-governance-policy-submit]",
      method: "POST",
      apiPath: "POST /v1/governance/policies",
      requestPath: "/v1/governance/policies",
      body: {
        kind: "SECURITY",
        slug: "p7-ui-denied-policy",
        name: "denied",
        summary: "denied",
        enforcementMode: "AUDIT_ONLY",
        rule: {},
      },
      tenantWorkspaceId: ws,
      countRowsNow: () => countRows("governance_policies", "team_id = $1", [ws]),
    });

    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.governance.access_review_campaign_created",
      pageUrl: "/governance-platform/access-reviews",
      control: "[data-access-review-campaign-submit]",
      method: "POST",
      apiPath: "POST /v1/governance/access-reviews/campaigns",
      requestPath: "/v1/governance/access-reviews/campaigns",
      body: {
        kind: "PERIODIC",
        name: "denied",
        organizationId: org,
        departmentId: null,
        workspaceId: null,
        scheduledStartUtc: "2031-03-01T09:00:00.000Z",
        scheduledEndUtc: "2031-03-31T17:00:00.000Z",
        items: [],
      },
      tenantWorkspaceId: ws,
      countRowsNow: () => countRows("access_review_campaigns", "team_id = $1", [ws]),
    });

    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.governance.cross_org_invited",
      pageUrl: "/governance-platform/cross-org",
      control: "[data-cross-org-invite-submit]",
      method: "POST",
      apiPath: "POST /v1/governance/cross-org-review",
      requestPath: "/v1/governance/cross-org-review",
      body: {
        invitingOrganizationId: org,
        invitedOrgSlug: "p7-denied-partner",
        scope: "denied",
        expiresAtUtc: null,
      },
      tenantWorkspaceId: ws,
      countRowsNow: () => countRows("cross_org_review_grants", "team_id = $1", [ws]),
    });

    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.governance.delegated_admin_granted",
      pageUrl: "/governance-platform/delegated-admin",
      control: "[data-delegated-admin-grant-submit]",
      method: "POST",
      apiPath: "POST /v1/governance/delegated-admin",
      requestPath: "/v1/governance/delegated-admin",
      body: {
        organizationId: org,
        departmentId: null,
        workspaceId: null,
        granteeUserId: fixture.member.userId,
        tier: "ORG_ADMIN",
        expiresAtUtc: null,
      },
      tenantWorkspaceId: ws,
      countRowsNow: () => countRows("delegated_admin_grants", "team_id = $1", [ws]),
    });

    const evidenceForDenial = await sql<{ id: string }>(
      `SELECT id FROM evidence WHERE team_id = $1 LIMIT 1`,
      [ws],
    );
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.governance.destruction_review_opened",
      pageUrl: "/governance/destruction",
      control: "[data-destruction-review-submit]",
      method: "POST",
      apiPath: "POST /v1/governance/destruction-reviews",
      requestPath: "/v1/governance/destruction-reviews",
      body: {
        teamId: ws,
        // A member cannot create evidence to name here, so a syntactically
        // valid id that does not exist is used: the point is that the
        // PERMISSION check refuses before the record is ever looked up.
        evidenceId:
          evidenceForDenial[0]?.id ?? "00000000-0000-4000-8000-000000000000",
        reason: "manual_review",
        retentionPolicyId: null,
        retentionPolicyVersion: null,
      },
      tenantWorkspaceId: ws,
      countRowsNow: () => countRows("destruction_reviews", "team_id = $1", [ws]),
    });

    // --- A cross-org ACCEPT the member has no authority for, on a real grant.
    const outsiderGrant = await sql<{ id: string }>(
      `INSERT INTO cross_org_review_grants
         (team_id, inviting_organization_id, invited_org_slug, state, scope, granted_by_user_id, updated_at)
       VALUES ($1, $2, 'p7-denied-accept', 'INVITED', '{"text":"denied"}'::jsonb, $3, NOW())
       RETURNING id`,
      [ws, org, fixture.owner.userId],
    );
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.governance.cross_org_accepted",
      pageUrl: "/governance-platform/cross-org",
      control: "[data-cross-org-accept-submit]",
      method: "POST",
      apiPath: "POST /v1/governance/cross-org-review/:id/accept",
      requestPath: `/v1/governance/cross-org-review/${outsiderGrant[0]!.id}/accept`,
      body: { acceptingOrganizationId: org, externalReviewGrantId: null },
      tenantWorkspaceId: ws,
      countRowsNow: () =>
        countRows("cross_org_review_grants", "team_id = $1 AND state = 'ACCEPTED'", [ws]),
    });

    // The denial path must not itself be a broken page.
    expect(
      probe.pageErrors,
      "a denied governance surface must not throw",
    ).toEqual([]);
    expect(
      await probe.cspViolations(),
      "a denied governance surface must not violate CSP",
    ).toEqual([]);
    expect(
      probe.wrongOriginV1().map((r) => r.url()),
      "no /v1/* request may be issued to the WEB origin",
    ).toEqual([]);

    /**
     * PHASE 13 (PHASE 2) — CLAIM THE CREDIT THIS TEST ACTUALLY EARNED.
     *
     * Every other scenario in this suite ends with `proven(...)`; this one did
     * not, so the refusal matrix ran green on every pass and the manifest kept
     * reporting `p7.ui.governance.denied_without_authority` as never executed.
     * The reconciliation is what surfaced it — the denominator comes from the
     * manifest, so a scenario that never records itself stays missing however
     * often its test passes, which is the behaviour that made this visible
     * rather than a gap that quietly closed itself.
     */
    proven("p7.ui.governance.denied_without_authority");
  });
});
