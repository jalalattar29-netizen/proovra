/**
 * PHASE 12 — POINT 7 CORRECTIVE PASS: the browser half of the two Sentry
 * findings and the TEAM/Personal-Space semantics.
 *
 * The server suites prove what the API and the database do. These prove what a
 * real signed-in user gets — which is the half that mattered for both
 * findings, because in each case the previous matrix accepted a 500 as a valid
 * "denial" and never looked at the status or the body.
 */

import { test, expect } from "@playwright/test";

import {
  countRows,
  createAccount,
  directApiCall,
  envelopeFromBrowser,
  login,
  personalTeamId,
  provenBrowserScenario,
  sql,
} from "./_harness";

const SUITE = "e2e/point7/corrective.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

test("p7.obs.free_limit.denied_as_canonical_4xx_not_captured", async ({ page }) => {
  const account = await createAccount({ label: "corr-free", plan: "FREE" });
  await login(page, account);

  for (let i = 0; i < 3; i += 1) {
    const ok = await directApiCall(page, {
      method: "POST",
      path: "/v1/evidence",
      body: { title: `p7 corrective free ${i}`, type: "PHOTO" },
    });
    expect(ok.status, ok.body).toBeLessThan(300);
  }
  const atCap = await countRows("evidence", "owner_user_id = $1", [account.userId]);
  expect(atCap).toBe(3);

  const denied = await directApiCall(page, {
    method: "POST",
    path: "/v1/evidence",
    body: { title: "p7 corrective over cap", type: "PHOTO" },
  });

  // The EXACT contract. The previous browser matrix asserted only
  // `status >= 400`, so it credited the 500 this used to return — which is how
  // a user-facing plan limit went on paging an operator through a green run.
  expect(denied.status).toBe(409);
  expect(denied.body).toContain("FREE_LIMIT_REACHED");
  // Honest product copy, and no server internals reaching the user.
  expect(denied.body).toMatch(/record limit/i);
  expect(denied.body).not.toMatch(/at Object|\.ts:\d+|SELECT |prisma|Internal server/i);

  // Nothing was created, and nothing was destroyed.
  expect(await countRows("evidence", "owner_user_id = $1", [account.userId])).toBe(
    atCap,
  );
  proven("p7.obs.free_limit.denied_as_canonical_4xx_not_captured");
});

test("p7.obs.missing_policy.bounded_fail_closed_response", async ({ page }) => {
  const owner = await createAccount({ label: "corr-org-owner", plan: "FREE" });
  const member = await createAccount({ label: "corr-org-member", plan: "FREE" });

  const name = `p7-corr-org-${Date.now().toString(36)}`;
  const org = (
    await sql<{ id: string }>(
      `INSERT INTO organizations (name, billing_owner_user_id, status, kind, updated_at)
       VALUES ($1, $2, 'ACTIVE'::"OrganizationStatus", 'CUSTOMER'::"OrganizationKind", NOW())
       RETURNING id`,
      [name, owner.userId],
    )
  )[0];
  const ws = (
    await sql<{ id: string }>(
      `INSERT INTO teams (name, owner_user_id, billing_owner_user_id, is_personal,
                          organization_id, workspace_kind, billing_plan, billing_status, updated_at)
       VALUES ($1, $2, $2, false, $3, 'ORGANIZATION'::"WorkspaceKind",
               'ENTERPRISE'::"PlanType", 'ACTIVE', NOW())
       RETURNING id`,
      [`${name}-ws`, owner.userId, org.id],
    )
  )[0];
  for (const [userId, role] of [
    [owner.userId, "OWNER"],
    [member.userId, "MEMBER"],
  ] as const) {
    await sql(
      `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
       VALUES ($1, $2, 'ORG_MEMBER'::"OrganizationRole", NOW())`,
      [org.id, userId],
    );
    await sql(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, $3::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
      [ws.id, userId, role],
    );
  }
  // Deliberately NO organization_security_policies row — the state that made
  // the switch route throw an unhandled exception carrying the Organization
  // UUID all the way to the client.
  await sql(
    `INSERT INTO enterprise_contracts (organization_id, status, updated_at)
     VALUES ($1, 'ACTIVE'::"EnterpriseContractStatus", NOW())`,
    [org.id],
  );

  await login(page, member);
  const before = await sql<{ current_workspace_id: string | null }>(
    `SELECT current_workspace_id FROM users WHERE id = $1`,
    [member.userId],
  );

  const res = await directApiCall(page, {
    method: "POST",
    path: "/v1/platform/context/switch-workspace",
    body: { workspaceId: ws.id },
  });

  // Bounded, canonical, fail-closed — and nothing internal on the wire.
  expect(res.status).toBe(503);
  expect(res.body).toContain("POLICY_NOT_PROVISIONED");
  expect(res.body).not.toContain(org.id);
  expect(res.body).not.toMatch(/at Object|\.ts:\d+|SELECT |prisma|Internal server/i);

  // The previously-authorized context is untouched, and no Organization
  // session was created.
  const after = await sql<{ current_workspace_id: string | null }>(
    `SELECT current_workspace_id FROM users WHERE id = $1`,
    [member.userId],
  );
  expect(after[0]?.current_workspace_id).toBe(before[0]?.current_workspace_id);
  expect(
    await countRows(
      "authenticated_sessions",
      "user_id = $1 AND organization_context_id = $2",
      [member.userId, org.id],
    ),
  ).toBe(0);
  proven("p7.obs.missing_policy.bounded_fail_closed_response");
});

test("p7.sem.team_user_keeps_personal_space", async ({ page }) => {
  const account = await createAccount({ label: "corr-team", plan: "TEAM" });
  await login(page, account);

  // A TEAM account HAS a Personal Space, and it resolves at the account's own
  // plan. Before the corrective pass this space resolved at PRO — a plan the
  // account does not hold — because a purchase-target rule was being applied
  // to scope resolution.
  const personal = await personalTeamId(account.userId);
  expect(personal).not.toBeNull();

  const envelope = (await envelopeFromBrowser(page)) as {
    activeSpace: { type: string; plan: string | null };
    account: { accountPlan: string };
    personalSpaceAllowed?: boolean;
    contextOptions: { personalSpace: { workspaceId: string } | null };
  };
  expect(envelope.account.accountPlan).toBe("TEAM");
  expect(envelope.personalSpaceAllowed).not.toBe(false);
  expect(envelope.contextOptions.personalSpace?.workspaceId).toBe(personal);
  expect(envelope.activeSpace.plan).toBe("TEAM");

  // The commercial surface answers rather than 500-ing.
  const overview = await directApiCall(page, {
    method: "GET",
    path: "/v1/billing/overview",
  });
  expect(overview.status, overview.body).toBe(200);

  // And the user can work in it.
  const created = await directApiCall(page, {
    method: "POST",
    path: "/v1/evidence",
    body: { title: "p7 corrective team personal capture", type: "PHOTO" },
  });
  expect(created.status, created.body).toBeLessThan(300);
  expect(await countRows("evidence", "team_id = $1", [personal])).toBe(1);
  proven("p7.sem.team_user_keeps_personal_space");
});

test("p7.sem.no_personal_space_true_blocks_every_route", async ({ page }) => {
  const owner = await createAccount({ label: "corr-nps-owner", plan: "FREE" });
  const member = await createAccount({ label: "corr-nps-member", plan: "FREE" });

  const name = `p7-corr-nps-${Date.now().toString(36)}`;
  const org = (
    await sql<{ id: string }>(
      `INSERT INTO organizations (name, billing_owner_user_id, status, kind, updated_at)
       VALUES ($1, $2, 'ACTIVE'::"OrganizationStatus", 'CUSTOMER'::"OrganizationKind", NOW())
       RETURNING id`,
      [name, owner.userId],
    )
  )[0];
  const ws = (
    await sql<{ id: string }>(
      `INSERT INTO teams (name, owner_user_id, billing_owner_user_id, is_personal,
                          organization_id, workspace_kind, billing_plan, billing_status, updated_at)
       VALUES ($1, $2, $2, false, $3, 'ORGANIZATION'::"WorkspaceKind",
               'ENTERPRISE'::"PlanType", 'ACTIVE', NOW())
       RETURNING id`,
      [`${name}-ws`, owner.userId, org.id],
    )
  )[0];
  await sql(
    `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
     VALUES ($1, $2, 'ORG_MEMBER'::"OrganizationRole", NOW())`,
    [org.id, member.userId],
  );
  await sql(
    `INSERT INTO team_members (team_id, user_id, role, status)
     VALUES ($1, $2, 'MEMBER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
    [ws.id, member.userId],
  );
  await sql(
    `INSERT INTO organization_security_policies (organization_id, team_id, no_personal_space, updated_at)
     VALUES ($1, $2, false, NOW())`,
    [org.id, ws.id],
  );
  await sql(
    `INSERT INTO enterprise_contracts (organization_id, status, updated_at)
     VALUES ($1, 'ACTIVE'::"EnterpriseContractStatus", NOW())`,
    [org.id],
  );

  // Sign in FIRST, so a grandfathered Personal Space exists — the hard case.
  await login(page, member);
  const grandfathered = await personalTeamId(member.userId);
  expect(grandfathered).not.toBeNull();

  // Now the Organization forbids it.
  await sql(
    `UPDATE organization_security_policies SET no_personal_space = true WHERE organization_id = $1`,
    [org.id],
  );
  await page.reload({ waitUntil: "domcontentloaded" });

  const envelope = (await envelopeFromBrowser(page)) as {
    personalSpaceAllowed: boolean;
    contextOptions: { personalSpace: unknown };
    availableWorkspaces?: Array<{ id: string }>;
  };
  // SELECTION — neither list offers it.
  expect(envelope.personalSpaceAllowed).toBe(false);
  expect(envelope.contextOptions.personalSpace).toBeNull();
  expect((envelope.availableWorkspaces ?? []).map((w) => w.id)).not.toContain(
    grandfathered,
  );

  // DIRECT API — the null form and the stored-id form are both refused. The
  // second is the one that was open: a cached Personal Workspace id switched
  // straight past the policy, because only the null form was guarded.
  const byNull = await directApiCall(page, {
    method: "POST",
    path: "/v1/platform/context/switch-workspace",
    body: { workspaceId: null },
  });
  expect(byNull.status).toBe(403);
  expect(byNull.body).toContain("ORG_POLICY_NO_PERSONAL_SPACE");

  const byStoredId = await directApiCall(page, {
    method: "POST",
    path: "/v1/platform/context/switch-workspace",
    body: { workspaceId: grandfathered },
  });
  expect(byStoredId.status).toBe(403);
  expect(byStoredId.body).toContain("ORG_POLICY_NO_PERSONAL_SPACE");

  // The row still exists. A policy withholds access; it does not delete.
  expect(await countRows("teams", "id = $1", [grandfathered])).toBe(1);
  proven("p7.sem.no_personal_space_true_blocks_every_route");
});
