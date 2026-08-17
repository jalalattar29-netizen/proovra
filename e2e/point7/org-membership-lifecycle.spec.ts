/**
 * PHASE 13 §1 — NEW-031: the Organization membership lifecycle, proven in a
 * real browser against the real API and a real PostgreSQL.
 *
 * THE DEFECT THIS LAYER EXISTS TO CLOSE
 * ---------------------------------------------------------------------------
 * `GET /v1/orgs/:id/members` SELECTed six lifecycle columns —
 * `status`, `statusChangedAtUtc`, `suspendedAtUtc`, `suspensionReason`,
 * `revokedAtUtc`, `revocationReason` — and projected NONE of them
 * (`organizations.routes.ts:499-546`). The comment beside the query said "the
 * status travels with each row so the surface can render it"; it did not. So
 * the administration console could not tell an ACTIVE membership from a
 * SUSPENDED or REVOKED one, offered BOTH lifecycle actions on every row, and
 * used the server's 409 as the way to discover which one applied. A 409 is not
 * a way to find out what a button does.
 *
 * It was fixed in source and never proven at runtime. Source-string assertions
 * cannot prove it: the projection could be present and the browser still fail
 * to render it, or render it from a stale client cache. So every scenario here
 * asserts three things together —
 *
 *   the AFFORDANCE that was offered or withheld,
 *   the ROUTE REQUEST that was or was not emitted (and its status),
 *   the DURABLE ROW that did or did not change.
 *
 * WHY THE FIXTURES ARE SEEDED
 * ---------------------------------------------------------------------------
 * A SUSPENDED and a REVOKED membership are the STARTING STATE of a roster an
 * administrator opens. Producing them by driving the product first would make
 * every scenario depend on the transition under test, so a broken transition
 * would present as a broken fixture. They are seeded with raw SQL that the
 * database's own `organization_memberships_status_timeline_chk` accepts.
 *
 * ENTERPRISE TIER IS A PRECONDITION, NOT A SUBJECT
 * ---------------------------------------------------------------------------
 * `/organizations/**` is an ENTERPRISE-tier surface whose gate reads the
 * SERVER-projected `flags.isEnterpriseWorkspace`, derived from the ACTIVE
 * workspace's plan. Every account here therefore has its restored workspace
 * pointed at the Organization's ENTERPRISE workspace. That is the state a real
 * enterprise administrator is in; it is not what is being asserted.
 */

import { test, expect, type Page } from "@playwright/test";

import {
  API_BASE,
  WEB_BASE,
  createAccount,
  directApiCall,
  login,
  provenBrowserScenario,
  recordRequests,
  sql,
} from "./_harness";
import {
  ORG_FORBIDDEN_BODY,
  orgMembersUrl,
  provisionEnterpriseOrganization,
  readMembership,
  seedOrgMembership,
  setCurrentWorkspace,
} from "./_org-upload-fixtures";

const SUITE = "e2e/point7/org-membership-lifecycle.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

/**
 * The six lifecycle fields the roster contract now carries.
 *
 * Listed here as DATA so a scenario asserts the whole set rather than the two
 * or three a test author happened to remember — dropping one silently is the
 * exact shape of the original defect.
 */
const LIFECYCLE_FIELDS = [
  "status",
  "statusChangedAtUtc",
  "suspendedAtUtc",
  "suspensionReason",
  "revokedAtUtc",
  "revocationReason",
] as const;

/**
 * Hold the FIRST request to `url` open for `holdMs`, then let it through
 * untouched; every later request to the same URL passes immediately.
 *
 * This is the harness's sanctioned second use of interception — delaying a
 * REAL response so a state that is otherwise milliseconds wide becomes
 * observable. Nothing about the request or the answer is altered, so a
 * scenario that passes because of this hold would also pass on a slower
 * network, which is exactly the condition the loading affordance exists for.
 */
async function holdOnce(page: Page, url: string, holdMs: number): Promise<void> {
  let held = false;
  await page.route(
    (candidate) => candidate.href === url,
    async (route) => {
      if (!held) {
        held = true;
        await new Promise((r) => setTimeout(r, holdMs));
      }
      // `fallback()`, not `continue()`: continuing here would bypass the
      // harness's outbound guard and drop this destination from the run's
      // browser-network ledger.
      await route.fallback();
    },
  );
}

type RosterMember = {
  membershipId: string;
  userId: string;
  email: string | null;
  role: string;
  memberSince: string;
  status: string;
  statusChangedAtUtc: string | null;
  suspendedAtUtc: string | null;
  suspensionReason: string | null;
  revokedAtUtc: string | null;
  revocationReason: string | null;
};

/**
 * The whole cast, in one place.
 *
 * An owner who administers, three members in the three lifecycle states, and
 * an outsider who belongs to a DIFFERENT tenant — the last is what makes the
 * non-disclosure assertion meaningful, because a merely unauthenticated caller
 * would be refused by the session layer long before the tenancy layer.
 */
async function buildOrgFixture(label: string) {
  const owner = await createAccount({ label: `${label}-owner`, plan: "ENTERPRISE" });
  const activeUser = await createAccount({ label: `${label}-active`, plan: "FREE" });
  const suspendedUser = await createAccount({ label: `${label}-susp`, plan: "FREE" });
  const revokedUser = await createAccount({ label: `${label}-revoked`, plan: "FREE" });

  const org = await provisionEnterpriseOrganization({
    ownerUserId: owner.userId,
    label,
  });

  const active = await seedOrgMembership({
    organizationId: org.organizationId,
    workspaceId: org.workspaceId,
    userId: activeUser.userId,
    status: "ACTIVE",
  });
  const suspended = await seedOrgMembership({
    organizationId: org.organizationId,
    workspaceId: org.workspaceId,
    userId: suspendedUser.userId,
    status: "SUSPENDED",
    actorUserId: owner.userId,
    reason: "Seeded pause pending review",
  });
  const revoked = await seedOrgMembership({
    organizationId: org.organizationId,
    workspaceId: org.workspaceId,
    userId: revokedUser.userId,
    status: "REVOKED",
    actorUserId: owner.userId,
    reason: "Seeded terminal removal",
  });

  await setCurrentWorkspace(owner.userId, org.workspaceId);

  return {
    owner,
    org,
    active: { ...active, account: activeUser },
    suspended: { ...suspended, account: suspendedUser },
    revoked: { ...revoked, account: revokedUser },
  };
}

// ===========================================================================
// 1 — the projection itself
// ===========================================================================

test.describe("NEW-031 roster projection", () => {
  test("p7.org.roster.lifecycle_fields_projected", async ({ page }) => {
    const fx = await buildOrgFixture("roster-proj");
    await login(page, fx.owner);

    // Issued from INSIDE the authenticated page, so this is the browser's own
    // credentials against the real route — not a harness fetch that could pass
    // with a cookie the product never had.
    const res = await directApiCall(page, {
      method: "GET",
      path: `/v1/orgs/${fx.org.organizationId}/members`,
    });
    expect(res.status, res.body).toBe(200);
    const body = JSON.parse(res.body) as { members: RosterMember[] };

    const byId = new Map(body.members.map((m) => [m.membershipId, m]));
    const activeRow = byId.get(fx.active.membershipId);
    const suspendedRow = byId.get(fx.suspended.membershipId);
    const revokedRow = byId.get(fx.revoked.membershipId);
    expect(activeRow, "ACTIVE membership missing from roster").toBeTruthy();
    expect(suspendedRow, "SUSPENDED membership missing from roster").toBeTruthy();
    expect(revokedRow, "REVOKED membership missing from roster").toBeTruthy();

    // ARCH-004: the ADMINISTRATION roster deliberately shows every membership,
    // including the ones that grant nothing — an administrator cannot restore
    // what the console will not show them.
    for (const row of [activeRow!, suspendedRow!, revokedRow!]) {
      for (const field of LIFECYCLE_FIELDS) {
        expect(
          Object.prototype.hasOwnProperty.call(row, field),
          `roster row is missing the projected field "${field}"`,
        ).toBe(true);
      }
    }

    expect(activeRow!.status).toBe("ACTIVE");
    expect(activeRow!.suspendedAtUtc).toBeNull();
    expect(activeRow!.revokedAtUtc).toBeNull();

    expect(suspendedRow!.status).toBe("SUSPENDED");
    expect(suspendedRow!.suspendedAtUtc).not.toBeNull();
    expect(suspendedRow!.suspensionReason).toBe("Seeded pause pending review");
    expect(suspendedRow!.revokedAtUtc).toBeNull();

    expect(revokedRow!.status).toBe("REVOKED");
    expect(revokedRow!.revokedAtUtc).not.toBeNull();
    expect(revokedRow!.revocationReason).toBe("Seeded terminal removal");

    // The projection agrees with the database it claims to describe.
    const durable = await readMembership(fx.suspended.membershipId);
    expect(durable?.status).toBe("SUSPENDED");
    expect(durable?.suspension_reason).toBe("Seeded pause pending review");

    proven("p7.org.roster.lifecycle_fields_projected");
  });
});

// ===========================================================================
// 2 — the round trip through the browser
// ===========================================================================

test.describe("NEW-031 browser lifecycle", () => {
  test("p7.org.roster.suspend_restore_round_trip", async ({ page }) => {
    const fx = await buildOrgFixture("roster-trip");
    await login(page, fx.owner);
    const log = recordRequests(page);

    await page.goto(orgMembersUrl(WEB_BASE, fx.org.organizationId), {
      waitUntil: "domcontentloaded",
    });

    const id = fx.active.membershipId;
    const row = page.locator(`li[data-membership-id="${id}"]`);
    const badge = page.locator(`[data-testid="member-status-${id}"]`);
    const suspendOpen = page.locator(`[data-testid="member-suspend-${id}"]`);
    const restore = page.locator(`[data-testid="member-restore-${id}"]`);
    const announcement = page.locator(
      `[data-org-member-lifecycle-status="${id}"]`,
    );

    // 2 — the ACTIVE badge is rendered as TEXT, not colour alone.
    await expect(badge).toHaveAttribute("data-member-status", "ACTIVE");
    await expect(badge).toHaveText("Active");

    // 3 — only the transition the state admits is offered.
    await expect(suspendOpen).toBeVisible();
    await expect(suspendOpen).toHaveText("Suspend…");
    await expect(restore).toHaveCount(0);

    // 4 — the real click path: Suspend… opens an explicit confirmation that
    // will not send until a reason is supplied, because suspension revokes
    // live sessions and is recorded on the audit event.
    await suspendOpen.click();
    const confirm = page.locator(`[data-testid="member-suspend-confirm-${id}"]`);
    const reasonInput = page.locator(
      `[data-testid="member-suspend-reason-${id}"]`,
    );
    await expect(confirm).toBeVisible();
    await reasonInput.fill("Suspended during the Point-7 browser run");

    // 5 — correlate the UI action with the request it actually emitted, to the
    // API ORIGIN. A same-origin `/v1/...` request would 404 at the web server;
    // asserting the origin is what catches that.
    const suspendPath = `/v1/orgs/${fx.org.organizationId}/members/${id}/suspend`;
    const suspendUrl = `${API_BASE}${suspendPath}`;
    // The in-flight window is otherwise a few milliseconds wide on loopback,
    // so asserting the loading affordance would be a race the assertion
    // usually loses. Holding the REAL request open for a moment is the
    // harness's sanctioned "delay a real response" — the server's answer is
    // untouched, only when it is asked for is ours.
    await holdOnce(page, suspendUrl, 1_500);
    const suspendResponse = page.waitForResponse(
      (r) => r.url() === suspendUrl && r.request().method() === "POST",
      { timeout: 30_000 },
    );
    await confirm.click();

    // 15a — the control is disabled while the request is in flight, so the
    // operator cannot fire a second transition by impatience, and the group
    // reports itself busy to assistive technology.
    await expect(confirm).toBeDisabled();
    await expect(
      page.locator(`[data-org-member-lifecycle="${id}"]`),
    ).toHaveAttribute("aria-busy", "true");
    await expect(announcement).toContainText("Suspending");

    const suspendRes = await suspendResponse;
    expect(
      suspendRes.status(),
      await suspendRes.text().catch(() => ""),
    ).toBeLessThan(300);

    const emitted = log
      .matching(suspendPath)
      .filter((r) => r.method() === "POST");
    expect(emitted.length, "expected exactly one suspend request").toBe(1);
    expect(emitted[0]!.url().startsWith(API_BASE)).toBe(true);

    // 6 — the row becomes SUSPENDED WITHOUT a manual reload. The component
    // re-reads the roster; it never mutates its own copy.
    await expect(badge).toHaveAttribute("data-member-status", "SUSPENDED", {
      timeout: 15_000,
    });
    await expect(badge).toHaveText("Suspended");
    expect(page.url()).toContain("/admin/members");

    // 7 — reason and timestamp are displayed, from the projection.
    const detail = row.locator('[data-state="suspended-detail"]');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Suspended during the Point-7 browser run");
    await expect(detail).toContainText("Suspended on ");

    // 15b — the outcome is announced in a live region, not only redrawn.
    await expect(announcement).toHaveAttribute("aria-live", "polite");
    await expect(announcement).toHaveAttribute("role", "status");
    await expect(announcement).toContainText("suspended");

    // The durable row agrees, read with raw SQL rather than through the route
    // that just told us it had changed.
    const afterSuspend = await readMembership(id);
    expect(afterSuspend?.status).toBe("SUSPENDED");
    expect(afterSuspend?.suspension_reason).toBe(
      "Suspended during the Point-7 browser run",
    );
    expect(afterSuspend?.suspended_by_user_id).toBe(fx.owner.userId);
    expect(afterSuspend?.status_generation).toBe(1);

    // 8 — the offered transition has flipped with the state.
    await expect(restore).toBeVisible();
    await expect(restore).toHaveText("Restore");
    await expect(suspendOpen).toHaveCount(0);

    // 9/10 — restore, and the row returns to ACTIVE.
    const restorePath = `/v1/orgs/${fx.org.organizationId}/members/${id}/restore`;
    const restoreResponse = page.waitForResponse(
      (r) => r.url() === `${API_BASE}${restorePath}` && r.request().method() === "POST",
      { timeout: 30_000 },
    );
    await restore.click();
    const restoreRes = await restoreResponse;
    expect(
      restoreRes.status(),
      await restoreRes.text().catch(() => ""),
    ).toBeLessThan(300);

    await expect(badge).toHaveAttribute("data-member-status", "ACTIVE", {
      timeout: 15_000,
    });
    await expect(suspendOpen).toBeVisible();
    await expect(restore).toHaveCount(0);

    const afterRestore = await readMembership(id);
    expect(afterRestore?.status).toBe("ACTIVE");
    // ACTIVE clears the suspension columns — the CHECK constraint requires it,
    // and a restore that left them set would misreport the member as paused.
    expect(afterRestore?.suspended_at_utc).toBeNull();
    expect(afterRestore?.suspension_reason).toBeNull();
    expect(afterRestore?.status_generation).toBe(2);

    proven("p7.org.roster.suspend_restore_round_trip");
  });

  test("p7.org.roster.terminal_state_offers_no_transition", async ({ page }) => {
    const fx = await buildOrgFixture("roster-terminal");
    await login(page, fx.owner);
    await page.goto(orgMembersUrl(WEB_BASE, fx.org.organizationId), {
      waitUntil: "domcontentloaded",
    });

    const revokedRow = page.locator(
      `li[data-membership-id="${fx.revoked.membershipId}"]`,
    );
    await expect(
      page.locator(`[data-testid="member-status-${fx.revoked.membershipId}"]`),
    ).toHaveAttribute("data-member-status", "REVOKED");

    // 11 — neither invalid transition is offered on a terminal row, and the
    // reason it is not is SAID rather than left as an empty gap.
    await expect(
      revokedRow.locator(`[data-testid="member-suspend-${fx.revoked.membershipId}"]`),
    ).toHaveCount(0);
    await expect(
      revokedRow.locator(`[data-testid="member-restore-${fx.revoked.membershipId}"]`),
    ).toHaveCount(0);
    await expect(revokedRow.locator('[data-state="revoked-terminal"]')).toContainText(
      "revoked",
    );

    // The scalar, computed across EVERY rendered row rather than the one this
    // scenario is named for: an invalid affordance anywhere on the roster is
    // the defect, not just an invalid affordance on the terminal row.
    const invalidVisibleActions = await page.evaluate(() => {
      let invalid = 0;
      const rows = Array.from(
        document.querySelectorAll("li[data-membership-id]"),
      );
      for (const li of rows) {
        const id = li.getAttribute("data-membership-id");
        const badge = li.querySelector<HTMLElement>("[data-member-status]");
        const status = badge?.getAttribute("data-member-status") ?? "";
        const suspend = li.querySelector(
          `[data-testid="member-suspend-${id}"]`,
        );
        const restore = li.querySelector(
          `[data-testid="member-restore-${id}"]`,
        );
        if (suspend && status !== "ACTIVE") invalid += 1;
        if (restore && status !== "SUSPENDED") invalid += 1;
      }
      return invalid;
    });
    expect(invalidVisibleActions, "OrgLifecycleInvalidVisibleActions").toBe(0);

    // Every seeded state is represented on the page — otherwise a roster that
    // rendered nothing would also score zero invalid actions.
    const renderedStates = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-member-status]")).map((n) =>
        n.getAttribute("data-member-status"),
      ),
    );
    expect(renderedStates).toEqual(
      expect.arrayContaining(["ACTIVE", "SUSPENDED", "REVOKED"]),
    );

    proven("p7.org.roster.terminal_state_offers_no_transition");
  });

  /**
   * A double-click must not produce a second transition.
   *
   * The interesting assertion is the DURABLE one. `status_generation` is
   * incremented inside the same guarded UPDATE that changes the status
   * (`org-membership-lifecycle.service.ts:178-202`), so a second transition
   * that landed would leave the generation at 2 even though the visible status
   * looks identical. Counting requests alone would miss a duplicate the client
   * suppressed and the server still applied twice from a retry.
   */
  test("p7.org.roster.double_click_single_transition", async ({ page }) => {
    const fx = await buildOrgFixture("roster-dbl");
    await login(page, fx.owner);
    const log = recordRequests(page);
    await page.goto(orgMembersUrl(WEB_BASE, fx.org.organizationId), {
      waitUntil: "domcontentloaded",
    });

    const id = fx.active.membershipId;
    const before = await readMembership(id);
    expect(before?.status).toBe("ACTIVE");
    expect(before?.status_generation).toBe(0);

    await page.locator(`[data-testid="member-suspend-${id}"]`).click();
    await page
      .locator(`[data-testid="member-suspend-reason-${id}"]`)
      .fill("Double-click guard");

    const suspendPath = `/v1/orgs/${fx.org.organizationId}/members/${id}/suspend`;
    // Hold the first suspend open so the second click of the double-click
    // genuinely lands while the first is still in flight. Without the hold the
    // response can return between the two clicks, and the scenario would pass
    // by finishing early rather than by guarding.
    await holdOnce(page, `${API_BASE}${suspendPath}`, 1_500);
    // A real double-click: two down/up pairs from the same pointer, with no
    // actionability wait between them. Dispatching a synthetic click at a
    // disabled button instead would prove something no user can do.
    await page.locator(`[data-testid="member-suspend-confirm-${id}"]`).dblclick();

    await expect(
      page.locator(`[data-testid="member-status-${id}"]`),
    ).toHaveAttribute("data-member-status", "SUSPENDED", { timeout: 15_000 });

    const posts = log.matching(suspendPath).filter((r) => r.method() === "POST");
    expect(posts.length, "exactly one suspend request").toBe(1);

    const after = await readMembership(id);
    expect(after?.status).toBe("SUSPENDED");
    expect(after?.status_generation, "exactly one durable transition").toBe(1);

    const suspendedRows = await sql<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM organization_memberships
        WHERE id = $1 AND status = 'SUSPENDED'::"OrganizationMembershipStatus"`,
      [id],
    );
    expect(Number(suspendedRows[0]!.n)).toBe(1);

    proven("p7.org.roster.double_click_single_transition");
  });
});

// ===========================================================================
// 3 — refusal, and what a refusal is allowed to reveal
// ===========================================================================

test.describe("NEW-031 authorization", () => {
  /**
   * "Not an org admin" has two distinct shapes, and the source treats them
   * differently, so both are asserted rather than conflated:
   *
   *   - a NON-MEMBER is refused the roster READ outright
   *     (`checkOrgAccess` default minRole ORG_MEMBER, `routes:488`);
   *   - an ORG_MEMBER may READ the roster (an administrator's roster is not a
   *     secret from the organization) but is refused every MUTATION, which the
   *     suspend/restore handler gates at `minRole: "ORG_ADMIN"` (`routes:1769`).
   *
   * Both are asserted at the SERVER, from inside the authenticated page. A
   * hidden or disabled control is a courtesy, not a boundary.
   */
  test("p7.org.roster.non_admin_refused_by_server", async ({ page }) => {
    const fx = await buildOrgFixture("roster-authz");

    const plainMember = await createAccount({
      label: "roster-plain",
      plan: "FREE",
    });
    await seedOrgMembership({
      organizationId: fx.org.organizationId,
      workspaceId: fx.org.workspaceId,
      userId: plainMember.userId,
      role: "ORG_MEMBER",
      status: "ACTIVE",
    });
    await setCurrentWorkspace(plainMember.userId, fx.org.workspaceId);

    await login(page, plainMember);

    // Reads are permitted at ORG_MEMBER — asserted so the next assertion is
    // about the MUTATION gate and not about a blanket denial.
    const read = await directApiCall(page, {
      method: "GET",
      path: `/v1/orgs/${fx.org.organizationId}/members`,
    });
    expect(read.status, read.body).toBe(200);

    const mutate = await directApiCall(page, {
      method: "POST",
      path: `/v1/orgs/${fx.org.organizationId}/members/${fx.active.membershipId}/suspend`,
      body: { reason: "should be refused" },
    });
    expect(mutate.status).toBe(403);

    // Nothing moved.
    const untouched = await readMembership(fx.active.membershipId);
    expect(untouched?.status).toBe("ACTIVE");
    expect(untouched?.status_generation).toBe(0);

    // And the console does not offer the operator a control that would fail:
    // the row's lifecycle group renders, disabled, with the reason stated.
    await page.goto(orgMembersUrl(WEB_BASE, fx.org.organizationId), {
      waitUntil: "domcontentloaded",
    });
    const controls = page.locator(
      `[data-org-member-lifecycle="${fx.active.membershipId}"]`,
    );
    await expect(controls.locator('[data-state="forbidden"]')).toBeVisible();
    await expect(
      controls.locator(`[data-testid="member-suspend-${fx.active.membershipId}"]`),
    ).toBeDisabled();

    proven("p7.org.roster.non_admin_refused_by_server");
  });

  /**
   * Cross-tenant refusal must be NON-DISCLOSING.
   *
   * The property is not "the outsider gets an error" — it is that the error
   * for "this Organization exists and you are not in it" is INDISTINGUISHABLE
   * from "no such Organization". `checkOrgAccess` returns `not_found` for the
   * second and `forbidden` for the first, and every roster route collapses
   * both to the same 403 body. The assertion therefore compares the two
   * responses TO EACH OTHER; comparing each to a constant would still pass if
   * both drifted together into something that leaked.
   */
  test("p7.org.roster.cross_tenant_non_disclosing", async ({ page }) => {
    const fx = await buildOrgFixture("roster-xtenant");

    const outsider = await createAccount({ label: "roster-out", plan: "ENTERPRISE" });
    const otherOrg = await provisionEnterpriseOrganization({
      ownerUserId: outsider.userId,
      label: "roster-out-org",
    });
    await setCurrentWorkspace(outsider.userId, otherOrg.workspaceId);

    await login(page, outsider);

    // The Organization that EXISTS but is not theirs.
    const existing = await directApiCall(page, {
      method: "GET",
      path: `/v1/orgs/${fx.org.organizationId}/members`,
    });
    // An Organization that does not exist at all. A syntactically valid UUID,
    // so the shared 400 "invalid id" branch cannot be what answers.
    const absentId = "00000000-0000-4000-8000-000000000000";
    const absent = await directApiCall(page, {
      method: "GET",
      path: `/v1/orgs/${absentId}/members`,
    });

    expect(existing.status).toBe(absent.status);
    expect(existing.body).toBe(absent.body);
    expect(existing.status).toBe(403);
    expect(existing.body).toBe(ORG_FORBIDDEN_BODY);

    // The mutation surface refuses on the same terms.
    const crossSuspend = await directApiCall(page, {
      method: "POST",
      path: `/v1/orgs/${fx.org.organizationId}/members/${fx.active.membershipId}/suspend`,
      body: { reason: "cross-tenant attempt" },
    });
    expect(crossSuspend.status).toBeGreaterThanOrEqual(400);
    expect(crossSuspend.status).toBeLessThan(500);

    // CrossTenantOrgRosterAccess — nothing in the victim tenant moved, and the
    // outsider's own roster is unaffected.
    const victim = await readMembership(fx.active.membershipId);
    expect(victim?.status).toBe("ACTIVE");
    expect(victim?.status_generation).toBe(0);

    const leaked = await sql<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM organization_memberships
        WHERE organization_id = $1 AND user_id = $2`,
      [fx.org.organizationId, outsider.userId],
    );
    expect(Number(leaked[0]!.n), "CrossTenantOrgRosterAccess").toBe(0);

    proven("p7.org.roster.cross_tenant_non_disclosing");
  });
});
