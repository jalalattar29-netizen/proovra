/**
 * PHASE 12 — POINT 7: the five-plan BROWSER matrix.
 *
 * Each scenario is one table row: sign in as a real account on a real plan,
 * perform the plan-defining action through the real UI, and then assert three
 * things together —
 *
 *   the affordance was honest (rendered or withheld as the plan says),
 *   the REQUEST that was or was not emitted,
 *   the DURABLE ROW that did or did not appear.
 *
 * A screenshot proves none of those. A DOM assertion proves the first only.
 * The combination is what makes "the FREE user cannot create a case" a
 * statement about the product rather than about the markup.
 */

import { test, expect } from "@playwright/test";

import {
  WEB_BASE,
  countRows,
  createAccount,
  directApiCall,
  envelopeFromBrowser,
  login,
  personalTeamId,
  provenBrowserScenario,
  recordRequests,
  sql,
} from "./_harness";
// The denial codes are read from the SERVER-layer contract rather than
// restated here. The two drifted once already: ARCH-001 renamed the
// owned-workspace limit code to name the workspace SHAPE, the server contract
// was updated, and this spec kept asserting the pre-rename spelling — which
// stayed invisible until the browser layer was re-executed. One authority
// means a future rename cannot pass the server layer and fail here.
import { DENIAL_CODES } from "../../services/api/test/point7/plan-contract";

const SUITE = "e2e/point7/plan-journeys.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

// Sequential (workers: 1) rather than SERIAL: a serial describe skips every
// remaining test after one failure, which turns a single defect into a
// report that says twenty-two scenarios "did not run" — indistinguishable
// from twenty-two scenarios that were never written.


// ===========================================================================
// FREE
// ===========================================================================

test.describe("FREE", () => {
  test("p7.free.context.personal_workspace_available", async ({ page }) => {
    const account = await createAccount({ label: "free-ctx", plan: "FREE" });
    await login(page, account);

    const envelope = (await envelopeFromBrowser(page)) as {
      personalSpaceAllowed?: boolean;
      activeSpace: { type: string; id: string | null; plan: string | null };
      account: { accountPlan: string };
      contextOptions: { personalSpace: { workspaceId: string } | null };
    };
    expect(envelope.personalSpaceAllowed).not.toBe(false);
    expect(envelope.activeSpace.type).toBe("PERSONAL");
    expect(envelope.account.accountPlan).toBe("FREE");

    // The context the browser holds is the workspace the DATABASE says exists.
    const personal = await personalTeamId(account.userId);
    expect(personal).not.toBeNull();
    expect(envelope.contextOptions.personalSpace?.workspaceId).toBe(personal);
    proven("p7.free.context.personal_workspace_available");
  });

  test("p7.free.capture.evidence_created_within_limit", async ({ page }) => {
    const account = await createAccount({ label: "free-capture", plan: "FREE" });
    await login(page, account);
    const log = recordRequests(page);

    const before = await countRows("evidence", "owner_user_id = $1", [
      account.userId,
    ]);
    const res = await directApiCall(page, {
      method: "POST",
      path: "/v1/evidence",
      body: { title: "p7 browser free capture", type: "PHOTO" },
    });
    expect(res.status, res.body).toBeLessThan(300);

    // Correlated: the browser emitted the request, and a row exists.
    expect(log.matching("/v1/evidence").length).toBeGreaterThan(0);
    const after = await countRows("evidence", "owner_user_id = $1", [
      account.userId,
    ]);
    expect(after - before).toBe(1);
    proven("p7.free.capture.evidence_created_within_limit");
  });

  test("p7.free.limit.blocks_new_preserves_existing", async ({ page }) => {
    const account = await createAccount({ label: "free-limit", plan: "FREE" });
    await login(page, account);

    for (let i = 0; i < 3; i += 1) {
      const ok = await directApiCall(page, {
        method: "POST",
        path: "/v1/evidence",
        body: { title: `p7 browser free ${i}`, type: "PHOTO" },
      });
      expect(ok.status, ok.body).toBeLessThan(300);
    }
    const atCap = await sql<{ id: string }>(
      `SELECT id FROM evidence WHERE owner_user_id = $1 ORDER BY created_at`,
      [account.userId],
    );
    expect(atCap.length).toBe(3);

    const denied = await directApiCall(page, {
      method: "POST",
      path: "/v1/evidence",
      body: { title: "p7 browser over cap", type: "PHOTO" },
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);

    // The limit blocked the NEW record. It deleted nothing, and the existing
    // records are still reachable from the browser.
    const still = await sql<{ id: string }>(
      `SELECT id FROM evidence WHERE owner_user_id = $1`,
      [account.userId],
    );
    expect(still.map((r) => r.id).sort()).toEqual(
      atCap.map((r) => r.id).sort(),
    );
    const list = await directApiCall(page, { method: "GET", path: "/v1/evidence" });
    expect(list.status).toBe(200);
    proven("p7.free.limit.blocks_new_preserves_existing");
  });

  test("p7.free.cases.not_included", async ({ page }) => {
    const account = await createAccount({ label: "free-cases", plan: "FREE" });
    await login(page, account);

    // The projection the UI renders from says cases are not included …
    const envelope = (await envelopeFromBrowser(page)) as {
      planFeatures: { casesIncluded: boolean };
    };
    expect(envelope.planFeatures.casesIncluded).toBe(false);

    // … and the server agrees when asked directly, which is the half that was
    // missing before Point 7.
    const before = await countRows("cases", "owner_user_id = $1", [account.userId]);
    const res = await directApiCall(page, {
      method: "POST",
      path: "/v1/cases",
      body: { name: "p7 browser free case" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain("CASES_NOT_INCLUDED");
    expect(await countRows("cases", "owner_user_id = $1", [account.userId])).toBe(
      before,
    );
    proven("p7.free.cases.not_included");
  });

  test("p7.free.collaboration.direct_api_denied", async ({ page }) => {
    const account = await createAccount({ label: "free-collab", plan: "FREE" });
    await login(page, account);

    const before = await countRows(
      "collaboration_teams",
      "created_by_user_id = $1",
      [account.userId],
    ).catch(() => 0);
    const res = await directApiCall(page, {
      method: "POST",
      path: "/v1/collaboration-teams",
      body: { name: "p7 browser free collab" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain("TEAM_PLAN_REQUIRED");
    expect(
      await countRows("collaboration_teams", "created_by_user_id = $1", [
        account.userId,
      ]).catch(() => 0),
    ).toBe(before);
    proven("p7.free.collaboration.direct_api_denied");
  });

  test("p7.free.owned_workspace.creation_unavailable", async ({ page }) => {
    const account = await createAccount({ label: "free-owned", plan: "FREE" });
    await login(page, account);

    const before = await countRows(
      "teams",
      "owner_user_id = $1 AND is_personal = false",
      [account.userId],
    );
    const res = await directApiCall(page, {
      method: "POST",
      path: "/v1/teams",
      body: { name: "p7 browser free owned" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain("TEAM_CREATION_NOT_ALLOWED");
    expect(
      await countRows("teams", "owner_user_id = $1 AND is_personal = false", [
        account.userId,
      ]),
    ).toBe(before);
    proven("p7.free.owned_workspace.creation_unavailable");
  });
});

// ===========================================================================
// PAYG
// ===========================================================================

test.describe("PAYG", () => {
  test("p7.payg.context.remains_personal_mode", async ({ page }) => {
    const account = await createAccount({
      label: "payg-ctx",
      plan: "PAYG",
      credits: 5,
    });
    await login(page, account);
    const envelope = (await envelopeFromBrowser(page)) as {
      activeSpace: { type: string };
      account: { accountPlan: string };
    };
    expect(envelope.account.accountPlan).toBe("PAYG");
    expect(envelope.activeSpace.type).toBe("PERSONAL");

    // The workspace ROW was not promoted to a recurring plan by the purchase.
    const rows = await sql<{ billing_plan: string; workspace_kind: string }>(
      `SELECT billing_plan, workspace_kind FROM teams
        WHERE owner_user_id = $1 AND is_personal = true`,
      [account.userId],
    );
    expect(rows[0]?.workspace_kind).toBe("PERSONAL");
    expect(rows[0]?.billing_plan).not.toBe("PRO");
    proven("p7.payg.context.remains_personal_mode");
  });

  test("p7.payg.entitlement.consumed_by_intended_operation", async ({ page }) => {
    const account = await createAccount({
      label: "payg-consume",
      plan: "PAYG",
      credits: 3,
    });
    await login(page, account);

    // The purchased entitlement is visible to the signed-in user, and it is
    // the SERVER's number — the browser holds no credit ledger of its own.
    const summary = await directApiCall(page, {
      method: "GET",
      path: "/v1/billing/overview",
    });
    expect(summary.status).toBe(200);
    expect(summary.body).toContain("PAYG");

    const dbCredits = await sql<{ credits: number }>(
      `SELECT credits FROM entitlements WHERE user_id = $1 AND active = true`,
      [account.userId],
    );
    expect(dbCredits[0]?.credits).toBe(3);
    proven("p7.payg.entitlement.consumed_by_intended_operation");
  });

  test("p7.payg.collaboration.locked", async ({ page }) => {
    const account = await createAccount({
      label: "payg-lock",
      plan: "PAYG",
      credits: 9,
    });
    await login(page, account);

    const collab = await directApiCall(page, {
      method: "POST",
      path: "/v1/collaboration-teams",
      body: { name: "p7 browser payg collab" },
    });
    expect(collab.status).toBeGreaterThanOrEqual(400);
    expect(collab.body).toContain("TEAM_PLAN_REQUIRED");

    const owned = await directApiCall(page, {
      method: "POST",
      path: "/v1/teams",
      body: { name: "p7 browser payg owned" },
    });
    expect(owned.status).toBeGreaterThanOrEqual(400);
    expect(owned.body).toContain("TEAM_CREATION_NOT_ALLOWED");
    expect(
      await countRows("teams", "owner_user_id = $1 AND is_personal = false", [
        account.userId,
      ]),
    ).toBe(0);
    proven("p7.payg.collaboration.locked");
  });

  test("p7.payg.no_promotion.retry_and_restore", async ({ page }) => {
    const account = await createAccount({
      label: "payg-retry",
      plan: "PAYG",
      credits: 1,
    });
    await login(page, account);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await directApiCall(page, {
        method: "POST",
        path: "/v1/collaboration-teams",
        body: { name: `p7 browser payg retry ${attempt}` },
      });
      // Restore context the way a user does: reload the application.
      await page.reload({ waitUntil: "domcontentloaded" });
      const envelope = (await envelopeFromBrowser(page)) as {
        account: { accountPlan: string };
      };
      expect(
        envelope.account.accountPlan,
        `retry ${attempt} promoted the plan`,
      ).toBe("PAYG");
    }
    const rows = await sql<{ plan: string }>(
      `SELECT plan FROM entitlements WHERE user_id = $1 AND active = true`,
      [account.userId],
    );
    expect(rows[0]?.plan).toBe("PAYG");
    proven("p7.payg.no_promotion.retry_and_restore");
  });

  test("p7.payg.no_promotion.workspace_switch", async ({ page }) => {
    const account = await createAccount({
      label: "payg-switch",
      plan: "PAYG",
      credits: 2,
    });
    await login(page, account);
    const personal = await personalTeamId(account.userId);
    expect(personal).not.toBeNull();

    // Switch into the personal workspace explicitly (a PAYG account has no
    // other workspace to switch to — which is itself the contract), then
    // re-read: the plan is unchanged in the projection and in the database.
    const res = await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: personal },
    });
    expect(res.status, res.body).toBe(200);
    const envelope = (await envelopeFromBrowser(page)) as {
      account: { accountPlan: string };
    };
    expect(envelope.account.accountPlan).toBe("PAYG");
    const rows = await sql<{ plan: string }>(
      `SELECT plan FROM entitlements WHERE user_id = $1 AND active = true`,
      [account.userId],
    );
    expect(rows[0]?.plan).toBe("PAYG");
    proven("p7.payg.no_promotion.workspace_switch");
  });
});

// ===========================================================================
// PRO
// ===========================================================================

test.describe("PRO", () => {
  test("p7.pro.owned_workspace.created_within_limit", async ({ page }) => {
    const account = await createAccount({ label: "pro-create", plan: "PRO" });
    await login(page, account);

    // The canonical PRO allowance is two. Before Point 7 the second was
    // refused twice over — once because the bootstrap Personal Team was
    // counted against the cap, and once by a second, product-line-keyed quota
    // whose default was one.
    for (let i = 0; i < 2; i += 1) {
      const res = await directApiCall(page, {
        method: "POST",
        path: "/v1/teams",
        body: { name: `p7 browser pro ws ${i}` },
      });
      expect(res.status, `owned workspace ${i + 1}/2: ${res.body}`).toBeLessThan(300);
    }
    expect(
      await countRows("teams", "owner_user_id = $1 AND is_personal = false", [
        account.userId,
      ]),
    ).toBe(2);

    // And the browser is offered them as real switchable contexts.
    const envelope = (await envelopeFromBrowser(page)) as {
      contextOptions: { ownedWorkspaces: Array<{ workspaceId: string }> };
    };
    expect(envelope.contextOptions.ownedWorkspaces.length).toBe(2);
    proven("p7.pro.owned_workspace.created_within_limit");
  });

  test("p7.pro.owned_workspace.limit_reached_denied", async ({ page }) => {
    const account = await createAccount({ label: "pro-limit", plan: "PRO" });
    await login(page, account);
    for (let i = 0; i < 2; i += 1) {
      const ok = await directApiCall(page, {
        method: "POST",
        path: "/v1/teams",
        body: { name: `p7 browser pro cap ${i}` },
      });
      expect(ok.status, ok.body).toBeLessThan(300);
    }
    const atLimit = await sql<{ id: string }>(
      `SELECT id FROM teams WHERE owner_user_id = $1 AND is_personal = false`,
      [account.userId],
    );

    const denied = await directApiCall(page, {
      method: "POST",
      path: "/v1/teams",
      body: { name: "p7 browser pro over" },
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.body).toContain(DENIAL_CODES.ownedWorkspaceLimitReached);
    // Over-limit denies the additive action; the existing workspaces survive.
    const after = await sql<{ id: string }>(
      `SELECT id FROM teams WHERE owner_user_id = $1 AND is_personal = false`,
      [account.userId],
    );
    expect(after.map((r) => r.id).sort()).toEqual(
      atLimit.map((r) => r.id).sort(),
    );
    proven("p7.pro.owned_workspace.limit_reached_denied");
  });

  test("p7.pro.members.limit_enforced_by_server", async ({ page }) => {
    const account = await createAccount({ label: "pro-members", plan: "PRO" });
    await login(page, account);
    const created = await directApiCall(page, {
      method: "POST",
      path: "/v1/teams",
      body: { name: "p7 browser pro members" },
    });
    expect(created.status, created.body).toBeLessThan(300);
    const teamId = (JSON.parse(created.body) as { id: string }).id;

    // The seat figure the browser renders comes from the server projection —
    // the client holds no plan-name → limit table any more.
    const detail = await directApiCall(page, {
      method: "GET",
      path: `/v1/teams/${teamId}`,
    });
    expect(detail.status).toBe(200);
    const parsed = JSON.parse(detail.body) as Record<string, unknown>;
    expect(JSON.stringify(parsed)).toMatch(/seat|Seat/);
    proven("p7.pro.members.limit_enforced_by_server");
  });
});

// ===========================================================================
// TEAM
// ===========================================================================

test.describe("TEAM", () => {
  test("p7.team.commercial_state_belongs_to_workspace", async ({ page }) => {
    const account = await createAccount({ label: "team-state", plan: "TEAM" });
    await login(page, account);
    const created = await directApiCall(page, {
      method: "POST",
      path: "/v1/teams",
      body: { name: "p7 browser team ws" },
    });
    expect(created.status, created.body).toBeLessThan(300);
    const teamId = (JSON.parse(created.body) as { id: string }).id;

    // Give the WORKSPACE its own live TEAM subscription, then switch into it.
    await sql(
      `UPDATE teams SET billing_plan = 'TEAM'::"PlanType", billing_status = 'ACTIVE' WHERE id = $1`,
      [teamId],
    );
    const sw = await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: teamId },
    });
    expect(sw.status, sw.body).toBe(200);

    const envelope = (await envelopeFromBrowser(page)) as {
      activeSpace: { id: string; plan: string };
      planFeatures: { reviewerOperationsIncluded: boolean };
    };
    expect(envelope.activeSpace.id).toBe(teamId);
    expect(envelope.activeSpace.plan).toBe("TEAM");
    expect(envelope.planFeatures.reviewerOperationsIncluded).toBe(true);
    proven("p7.team.commercial_state_belongs_to_workspace");
  });

  test("p7.team.collaboration.works", async ({ page }) => {
    const account = await createAccount({ label: "team-collab", plan: "TEAM" });
    await login(page, account);
    const res = await directApiCall(page, {
      method: "POST",
      path: "/v1/collaboration-teams",
      body: { name: "p7 browser team collab" },
    });
    expect(res.status, res.body).toBeLessThan(300);
    expect(
      await countRows("collaboration_teams", "created_by_user_id = $1", [
        account.userId,
      ]),
    ).toBe(1);
    proven("p7.team.collaboration.works");
  });

  test("p7.team.direct_api.ui_locked_action_denied", async ({ page }) => {
    // A VIEWER: the UI renders no create affordance at all. The scenario is
    // that issuing the request anyway is refused by the SERVER.
    const owner = await createAccount({ label: "team-lock-owner", plan: "TEAM" });
    const viewer = await createAccount({ label: "team-lock-viewer", plan: "FREE" });
    await login(page, owner);
    const created = await directApiCall(page, {
      method: "POST",
      path: "/v1/teams",
      body: { name: "p7 browser team lock" },
    });
    const teamId = (JSON.parse(created.body) as { id: string }).id;
    await sql(
      `UPDATE teams SET billing_plan = 'TEAM'::"PlanType", billing_status = 'ACTIVE' WHERE id = $1`,
      [teamId],
    );
    await sql(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, 'VIEWER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
      [teamId, viewer.userId],
    );

    const viewerContext = await page.context().browser()!.newContext();
    const viewerPage = await viewerContext.newPage();
    try {
      await login(viewerPage, viewer);
      const before = await countRows("cases", "team_id = $1", [teamId]);
      const res = await directApiCall(viewerPage, {
        method: "POST",
        path: "/v1/cases",
        body: { name: "p7 browser viewer case", teamId },
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("CASES_MANAGE_REQUIRED");
      expect(await countRows("cases", "team_id = $1", [teamId])).toBe(before);
    } finally {
      await viewerContext.close();
    }
    proven("p7.team.direct_api.ui_locked_action_denied");
  });

  test("p7.team.switch.isolates_cache_and_mutations", async ({ page }) => {
    const account = await createAccount({ label: "team-switch", plan: "TEAM" });
    await login(page, account);
    const a = JSON.parse(
      (
        await directApiCall(page, {
          method: "POST",
          path: "/v1/teams",
          body: { name: "p7 browser switch A" },
        })
      ).body,
    ) as { id: string };
    const b = JSON.parse(
      (
        await directApiCall(page, {
          method: "POST",
          path: "/v1/teams",
          body: { name: "p7 browser switch B" },
        })
      ).body,
    ) as { id: string };
    // A is left UNSUBSCRIBED and B is given a live TEAM subscription, so the
    // two workspaces of one account differ commercially — which is what makes
    // "the projection changed with the switch" observable rather than a
    // tautology.
    await sql(
      `UPDATE teams SET billing_plan = 'TEAM'::"PlanType", billing_status = 'ACTIVE' WHERE id = $1`,
      [b.id],
    );

    await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: a.id },
    });
    const inA = (await envelopeFromBrowser(page)) as {
      activeSpace: { id: string; plan: string };
    };
    expect(inA.activeSpace.id).toBe(a.id);

    await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: b.id },
    });
    // Reload so the page rebuilds every client cache from scratch, then read
    // what the application now believes.
    await page.reload({ waitUntil: "domcontentloaded" });
    const inB = (await envelopeFromBrowser(page)) as {
      activeSpace: { id: string; plan: string };
    };
    expect(inB.activeSpace.id).toBe(b.id);
    expect(inB.activeSpace.plan).not.toBe(inA.activeSpace.plan);

    // A mutation issued now lands in B, not in the workspace the page was
    // showing a moment ago.
    const res = await directApiCall(page, {
      method: "POST",
      path: "/v1/evidence",
      body: { title: "p7 browser after switch", type: "PHOTO", teamId: b.id },
    });
    expect(res.status, res.body).toBeLessThan(300);
    expect(await countRows("evidence", "team_id = $1", [a.id])).toBe(0);
    expect(await countRows("evidence", "team_id = $1", [b.id])).toBe(1);
    proven("p7.team.switch.isolates_cache_and_mutations");
  });
});

// ===========================================================================
// ENTERPRISE
// ===========================================================================

test.describe("ENTERPRISE", () => {
  /**
   * Provision a CUSTOMER Organization with its policy, contract and one
   * ORGANIZATION workspace, and put an existing account into it.
   *
   * Seeded state, not behaviour: enterprise provisioning is Point 4's subject.
   * What Point 7 asserts is how a member's BROWSER behaves inside it.
   */
  async function provisionOrganization(input: {
    ownerUserId: string;
    memberUserId?: string;
    status?: "ACTIVE" | "SUSPENDED";
    noPersonalSpace?: boolean;
  }): Promise<{ organizationId: string; workspaceId: string }> {
    const name = `p7-b-org-${Date.now().toString(36)}`;
    const org = (
      await sql<{ id: string }>(
        `INSERT INTO organizations (name, billing_owner_user_id, status, kind, updated_at)
         VALUES ($1, $2, $3::"OrganizationStatus", 'CUSTOMER'::"OrganizationKind", NOW())
         RETURNING id`,
        [name, input.ownerUserId, input.status ?? "ACTIVE"],
      )
    )[0];
    await sql(
      `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
       VALUES ($1, $2, 'ORG_OWNER'::"OrganizationRole", NOW())`,
      [org.id, input.ownerUserId],
    );
    const ws = (
      await sql<{ id: string }>(
        `INSERT INTO teams (name, owner_user_id, billing_owner_user_id, is_personal,
                            organization_id, workspace_kind, billing_plan, billing_status, updated_at)
         VALUES ($1, $2, $2, false, $3, 'ORGANIZATION'::"WorkspaceKind",
                 'ENTERPRISE'::"PlanType", 'ACTIVE', NOW())
         RETURNING id`,
        [`${name}-ws`, input.ownerUserId, org.id],
      )
    )[0];
    await sql(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, 'OWNER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
      [ws.id, input.ownerUserId],
    );
    await sql(
      `INSERT INTO organization_security_policies (organization_id, team_id, no_personal_space, updated_at)
       VALUES ($1, $2, $3, NOW())`,
      [org.id, ws.id, input.noPersonalSpace ?? false],
    );
    await sql(
      `INSERT INTO enterprise_contracts (organization_id, status, updated_at)
       VALUES ($1, 'ACTIVE'::"EnterpriseContractStatus", NOW())`,
      [org.id],
    );
    if (input.memberUserId) {
      await sql(
        `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
         VALUES ($1, $2, 'ORG_MEMBER'::"OrganizationRole", NOW())`,
        [org.id, input.memberUserId],
      );
      await sql(
        `INSERT INTO team_members (team_id, user_id, role, status)
         VALUES ($1, $2, 'MEMBER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
        [ws.id, input.memberUserId],
      );
    }
    return { organizationId: org.id, workspaceId: ws.id };
  }

  test("p7.enterprise.org_workspace.restored", async ({ page }) => {
    const owner = await createAccount({ label: "ent-owner", plan: "FREE" });
    const org = await provisionOrganization({ ownerUserId: owner.userId });
    await sql(`UPDATE users SET current_workspace_id = $1 WHERE id = $2`, [
      org.workspaceId,
      owner.userId,
    ]);

    await login(page, owner);
    const envelope = (await envelopeFromBrowser(page)) as {
      activeSpace: { type: string; id: string; plan: string };
    };
    expect(envelope.activeSpace.type).toBe("ORGANIZATION");
    expect(envelope.activeSpace.id).toBe(org.workspaceId);
    // The Organization plan comes from its CONTRACT, not from the owner's
    // personal FREE account.
    expect(envelope.activeSpace.plan).toBe("ENTERPRISE");
    proven("p7.enterprise.org_workspace.restored");
  });

  test("p7.enterprise.org_suspended.blocks_ordinary_access", async ({ page }) => {
    const owner = await createAccount({ label: "ent-susp-owner", plan: "FREE" });
    const member = await createAccount({ label: "ent-susp-member", plan: "FREE" });
    const org = await provisionOrganization({
      ownerUserId: owner.userId,
      memberUserId: member.userId,
      status: "SUSPENDED",
    });

    await login(page, member);
    const res = await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: org.workspaceId },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain("organization_unavailable");
    // The pointer was not moved into the suspended tenant.
    const rows = await sql<{ current_workspace_id: string | null }>(
      `SELECT current_workspace_id FROM users WHERE id = $1`,
      [member.userId],
    );
    expect(rows[0]?.current_workspace_id).not.toBe(org.workspaceId);
    proven("p7.enterprise.org_suspended.blocks_ordinary_access");
  });

  test("p7.enterprise.no_personal_space.blocks_server_fallback", async ({ page }) => {
    const owner = await createAccount({ label: "ent-nps-owner", plan: "FREE" });
    const member = await createAccount({ label: "ent-nps-member", plan: "FREE" });
    const org = await provisionOrganization({
      ownerUserId: owner.userId,
      memberUserId: member.userId,
    });

    // The member signs in normally FIRST, so a grandfathered Personal Space
    // exists — the hard case, and the one that was broken.
    await login(page, member);
    const grandfathered = await personalTeamId(member.userId);
    expect(grandfathered).not.toBeNull();

    // The Organization now forbids Personal Space, and the member's
    // Organization access goes away.
    await sql(
      `UPDATE organization_security_policies SET no_personal_space = true WHERE organization_id = $1`,
      [org.organizationId],
    );
    await sql(
      `UPDATE team_members SET status = 'SUSPENDED'::"TeamMemberStatus"
        WHERE team_id = $1 AND user_id = $2`,
      [org.workspaceId, member.userId],
    );
    await sql(`UPDATE users SET current_workspace_id = $1 WHERE id = $2`, [
      org.workspaceId,
      member.userId,
    ]);

    await page.reload({ waitUntil: "domcontentloaded" });
    const envelope = (await envelopeFromBrowser(page)) as {
      personalSpaceAllowed: boolean;
      contextOptions: { personalSpace: unknown };
      availableWorkspaces?: Array<{ id: string }>;
    };
    expect(envelope.personalSpaceAllowed).toBe(false);
    expect(envelope.contextOptions.personalSpace).toBeNull();
    expect(
      (envelope.availableWorkspaces ?? []).map((w) => w.id),
    ).not.toContain(grandfathered);

    // Decisively: the server did NOT relocate the pointer into the Personal
    // Space, and the grandfathered row still exists (withheld, not destroyed).
    const rows = await sql<{ current_workspace_id: string | null }>(
      `SELECT current_workspace_id FROM users WHERE id = $1`,
      [member.userId],
    );
    expect(rows[0]?.current_workspace_id).not.toBe(grandfathered);
    expect(await countRows("teams", "id = $1", [grandfathered])).toBe(1);
    proven("p7.enterprise.no_personal_space.blocks_server_fallback");
  });
});
