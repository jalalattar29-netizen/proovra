/**
 * PHASE 13 — POINT 7: JOURNEY W, the workspace-lifecycle write surfaces.
 *
 * Seven registered lifecycle routes governed a workspace's whole life —
 * creation, closure, cancellation, reopening, ownership transfer, and
 * organization-level suspension and resumption — and every one of them was
 * reachable only from a REST client. A product that can list workspaces but
 * cannot create one, and can close one but never take it back, is not a
 * workspace administration console; it is a viewer with a changelog. The
 * service-layer tests could not see that, because the thing that was missing
 * was a button.
 *
 * Each capability runs through `proveMutationCapability`, which refuses a DOM
 * assertion as evidence: it correlates the activation with the request
 * Chromium actually issued, reads the resulting row back with raw SQL, checks
 * that the OTHER tenant did not move, and repeats against a synthetic server
 * failure to prove the surface reports a refusal instead of a backend message.
 *
 * WHY THESE JOURNEYS SEED OWNED WORKSPACES
 * ---------------------------------------------------------------------------
 * Four of the seven refuse an ORGANIZATION workspace ON PURPOSE — closure,
 * cancellation, reopen and ownership transfer are OWNED-kind operations, and
 * `workspace-lifecycle.service.ts` answers 409
 * `ORG_WORKSPACE_OWNERSHIP_IS_ORG_GOVERNED` for the organization kind. The
 * shared enterprise fixture provisions an ORGANIZATION workspace, so those
 * four need an owned one alongside it. Creating an owned workspace IS
 * capability seven and is driven through the browser there; everywhere else
 * the owned workspace is the SUBJECT of the capability and is seeded
 * (`seedOwnedWorkspace`), in the exact shape `POST /v1/teams` produces.
 *
 * WHY MOST CAPABILITIES HERE GET *TWO* SUBJECT WORKSPACES
 * ---------------------------------------------------------------------------
 * `proveMutationCapability` runs the authorized path and then, on the same
 * surface, an injected-500 path. A lifecycle control is by nature ONE-WAY on
 * its subject: once a workspace has an open closure request the request form
 * is replaced by the cancel control, and once ownership has moved the transfer
 * card belongs to somebody else. Re-running the error pass against the same
 * workspace would therefore be running it against a surface that no longer
 * offers the control — which is the product behaving correctly, reported as a
 * test failure.
 *
 * So each of those capabilities is given a PAIR of identical subjects and its
 * `open()` selects whichever one is still in the pre-state. The durable count
 * spans the pair, so "exactly one row appeared" remains exactly as strict as
 * it is everywhere else — the pair widens the fixture, never the assertion.
 *
 * TWO KNOWN GAPS THIS SUITE DELIBERATELY DOES NOT PAPER OVER
 * ---------------------------------------------------------------------------
 * `WorkspaceClosureCard` announces NEITHER outcome in a live region: a
 * successful closure request re-renders a plain `<div
 * data-workspace-closure-status>` with no `role`/`aria-live`
 * (WorkspaceClosureCard.tsx:252), and a successful CANCELLATION renders no
 * confirmation at all — the card simply returns to its initial state
 * (WorkspaceClosureCard.tsx:266-279 → the `!open` branch). The reopen leg, by
 * contrast, does announce (`[data-workspace-reopen-status]`, line 385-390).
 *
 * The two affected capabilities are therefore written against
 * `[data-workspace-closure-card] [role="status"]` — a role query rather than
 * an invented data attribute, so it binds to whatever live region the fix
 * adds — and they are EXPECTED TO FAIL on the announcement dimension against
 * the current build. That failure is the finding. Pointing them at a region
 * that does not announce, or dropping the dimension for these two alone, is
 * the dishonest version of this file: capability nine would then be checking
 * less than capability one.
 */

import { test, expect, type Page } from "@playwright/test";

import { countRows, login, provenBrowserScenario, sql } from "./_harness";
import {
  activateOnce,
  activateTwice,
  attachUiProbe,
  buildEnterpriseFixture,
  expectSurfaceRendered,
  latestClosureRequest,
  proveMutationCapability,
  proveServerRefusal,
  seedOrganizationWorkspace,
  seedOwnedWorkspace,
  seedWorkspaceClosureRequest,
  stepUpWithPassword,
  waitForSurface,
  type UiEnterpriseFixture,
  type UiProbe,
} from "./_ui-fixtures";

const SUITE = "e2e/point7/ui-capabilities-workspace.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

/**
 * `/workspaces` and `/teams/{id}` are both registered under `admin.teams`
 * (routeRegistry.ts:1394, `requiredActiveSpace: "NONE"`). The bare `/teams`
 * landing page was deleted and now redirects, which is why every navigation
 * below addresses `/workspaces` for the index and `/teams/{id}` for detail.
 */
const WORKSPACE_ADMIN_ROUTE_ID = "admin.teams";
const ORGANIZATION_DETAIL_ROUTE_ID = "account.organization-detail";

/** The server's own confirmation phrase (`teams.routes.ts` closure route). */
const CLOSURE_PHRASE = "close this workspace";

/** The marker reason org-workspace suspension stamps on every membership. */
const ORG_SUSPENSION_REASON = "organization workspace suspended";

type WorkspaceSession = {
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
): Promise<WorkspaceSession> {
  const probe = await attachUiProbe(page);
  await login(page, fixture.owner);
  return { page, probe, fixture };
}

test.describe("JOURNEY W — workspace lifecycle write surfaces", () => {
  // ---------------------------------------------------------------- RETIRED
  // 7. POST /v1/teams — CreateWorkspaceCard
  //
  // `p7.ui.workspace.created` proved that submitting the create-workspace card
  // wrote the workspace row. Both halves of that sentence are gone: the card
  // was deleted, and the route's creation body was deleted with it in
  // `f7584082` — POST /v1/teams now answers 409
  // WORKSPACE_CREATION_NOT_SELF_SERVICE unconditionally, because an additional
  // Owned Workspace is not part of any self-service plan.
  //
  // The scenario is not deleted quietly. It carries a retirement record in
  // `services/api/test/point7/scenario-manifest.ts`, where the required
  // inventory lives, naming the evidence and the two invariants that now hold
  // this ground at BOTH layers:
  //
  //   p7.pro.owned_workspace.creation_unavailable
  //   p7.free.owned_workspace.creation_unavailable
  //
  // Nothing is re-added here to make those pass. A browser test that drove a
  // control which no longer exists could only be made green by rebuilding the
  // capability the product removed.

  // =========================================================================
  // 8. POST /v1/teams/:id/closure — WorkspaceClosureCard, request leg
  //
  // STEP-UP GATED. The first attempt is answered 401 STEP_UP_REQUIRED with
  // the methods this account can prove itself by; the card renders the shared
  // `StepUpVerify` panel and retries with the proof. "Exactly one request" is
  // the wrong invariant on such a surface — a challenge is not a write — so
  // the driver counts SUCCESSFUL MUTATIONS instead, which is what
  // `resolveStepUp` switches it to.
  // =========================================================================

  test("p7.ui.workspace.closure_requested", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "ws-closure" });
    // A PAIR: the authorized pass consumes the first, the injected-500 pass
    // needs a workspace that still offers the request form.
    const a = await seedOwnedWorkspace({
      label: "closure-a",
      ownerUserId: fixture.owner.userId,
    });
    const b = await seedOwnedWorkspace({
      label: "closure-b",
      ownerUserId: fixture.owner.userId,
    });
    const { probe } = await signInAsOwner(page, fixture);

    const subjects = [a.workspaceId, b.workspaceId];
    let target = a.workspaceId;

    const OPEN_STATUSES = ["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED", "PROCESSING"];

    const open = async () => {
      // Whichever subject has no open request yet is the one whose form the
      // product will render. Read from the database rather than guessed, so
      // the pass order can never silently drift.
      const rows = await sql<{ team_id: string }>(
        `SELECT team_id FROM workspace_closure_requests
          WHERE team_id = ANY($1::uuid[]) AND status = ANY($2::text[])`,
        [subjects, OPEN_STATUSES],
      );
      const taken = new Set(rows.map((r) => r.team_id));
      const next = subjects.find((id) => !taken.has(id));
      expect(
        next,
        "both subject workspaces already carry an open closure request — the " +
          "fixture can no longer offer the control under test",
      ).toBeTruthy();
      target = next!;

      await page.goto(`/teams/${target}`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, WORKSPACE_ADMIN_ROUTE_ID);
      await waitForSurface(page, "[data-workspace-closure-card]");
      const reveal = page.locator('[data-action="open-workspace-closure"]');
      await expect(reveal).toBeVisible({ timeout: 30_000 });
      await reveal.click();
      await waitForSurface(page, "[data-workspace-closure-form]");
    };

    // The phrase is validated SERVER-side; the card additionally keeps the
    // control disabled until it matches, so typing it is what ARMS the form.
    const arm = async () => {
      await page.locator("#workspace-closure-confirm").fill(CLOSURE_PHRASE);
      await expect(page.locator('[data-action="request-workspace-closure"]')).toBeEnabled({
        timeout: 15_000,
      });
    };

    const submit = () => page.locator('[data-action="request-workspace-closure"]');

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.workspace.closure_requested",
        pageUrl: "/teams/{id}",
        control: '[data-action="request-workspace-closure"] — “Request closure”',
        method: "POST",
        apiPath: "POST /v1/teams/:id/closure",
        // Narrow enough to exclude the cancel leg, which nests under the
        // same path segment.
        pathFragment: "/closure",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(submit(), keyboard);
        else await activateOnce(submit(), keyboard);
      },
      submitControl: submit,
      /**
       * PHASE 13 (SPEC CORRECTION) — the live region LANDED; this names it.
       *
       * The previous comment here read "the closure card has no live region
       * today… so it binds to the fix when it lands". The fix landed (NEW-048):
       * `WorkspaceClosureCard.tsx` renders
       * `[data-workspace-closure-notice]` with `role="status"` and
       * `aria-live="polite"`, deliberately OUTSIDE the open/closed branch so a
       * cancellation cannot unmount it. Naming the attribute instead of
       * `[role="status"]`.first() removes a selector that silently depended on
       * DOM order between two regions.
       *
       * `successCopy` moves with it, for the same reason. The card announces the
       * outcome in plain language — "Closure requested. The cancellation window
       * is now open." — and the old `/Scheduled/i` was reading for the internal
       * STATUS LABEL, which is a different element
       * (`[data-workspace-closure-status]`, not a live region). Rewriting the
       * product's announcement to contain the word "Scheduled" to satisfy a
       * regex would make the copy worse, not the product more correct.
       *
       * Nothing is relaxed: the schedule claim the regex was reaching for is now
       * asserted DIRECTLY in `expectRefreshed`, against the persisted status the
       * card re-read — which is a stronger statement than a word in a sentence.
       */
      statusRegion: () =>
        page.locator('[data-workspace-closure-card] [data-workspace-closure-notice]'),
      /**
       * Failure is announced in the card's `role="alert"` region, not its status
       * region: `requestClosure` clears `closureNotice` before it starts, so on
       * the error path the status region is unmounted (it renders conditionally)
       * and the message goes to `[data-workspace-closure-error]`. Same split, and
       * same reason, as the cancellation leg below.
       */
      errorStatusRegion: () =>
        page.locator('[data-workspace-closure-card] [data-workspace-closure-error]'),
      countHere: () =>
        countRows("workspace_closure_requests", "team_id = ANY($1::uuid[])", [subjects]),
      countThere: () =>
        countRows("workspace_closure_requests", "team_id = $1", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Closure requested/i,
      expectStatus: 201,
      resolveStepUp: stepUpWithPassword(page, fixture.owner.password),
      expectRefreshed: async () => {
        await expect(
          page.locator("[data-workspace-closure-status]"),
          "the card must re-read its own closure state without a page reload",
        ).toBeVisible({ timeout: 20_000 });
        /**
         * The schedule claim, asserted against the state the card re-read
         * rather than against a word in the announcement. `data-workspace-
         * closure-status` carries the PERSISTED status, so this fails if the
         * request landed in any state that is not an open cancellation window.
         */
        await expect(
          page.locator("[data-workspace-closure-status]"),
          "a requested closure must be re-read in an OPEN state, so the " +
            "cancellation window the announcement promises actually exists",
        ).toHaveAttribute(
          "data-workspace-closure-status",
          /^(REQUESTED|COOLING_OFF|SCHEDULED)$/,
          { timeout: 20_000 },
        );
        await expect(
          page.locator('[data-action="cancel-workspace-closure"]'),
          "an open request must offer the cancellation window it promised",
        ).toBeVisible({ timeout: 20_000 });
      },
    });

    proven("p7.ui.workspace.closure_requested");

    // The SERVER refuses a caller who does not own the workspace, from inside
    // that caller's own authenticated page. A hidden card proves only that
    // the client declined to render one.
    await page.context().clearCookies();
    await login(page, fixture.member);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.workspace.closure_requested",
      pageUrl: "/teams/{id}",
      control: '[data-action="request-workspace-closure"]',
      method: "POST",
      apiPath: "POST /v1/teams/:id/closure",
      requestPath: `/v1/teams/${b.workspaceId}/closure`,
      body: { confirmation: CLOSURE_PHRASE },
      tenantWorkspaceId: fixture.tenant.workspaceId,
      countRowsNow: () =>
        countRows("workspace_closure_requests", "team_id = $1", [b.workspaceId]),
    });
  });

  // =========================================================================
  // 9. POST /v1/teams/:id/closure/:requestId/cancel — cancellation leg
  //
  // The open requests are SEEDED here. The request leg is capability eight
  // and is driven through the browser there; what it cannot produce is a
  // SECOND open request for the error pass, because a workspace may hold at
  // most one (`closure_request_active`). Cancellation is not step-up gated —
  // undoing a destructive intent is not itself destructive.
  // =========================================================================

  test("p7.ui.workspace.closure_cancelled", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "ws-cancel" });
    const c = await seedOwnedWorkspace({
      label: "cancel-c",
      ownerUserId: fixture.owner.userId,
    });
    const d = await seedOwnedWorkspace({
      label: "cancel-d",
      ownerUserId: fixture.owner.userId,
    });
    for (const ws of [c, d]) {
      await seedWorkspaceClosureRequest({
        teamId: ws.workspaceId,
        requestedByUserId: fixture.owner.userId,
        status: "COOLING_OFF",
      });
    }
    const { probe } = await signInAsOwner(page, fixture);

    const subjects = [c.workspaceId, d.workspaceId];
    let target = c.workspaceId;
    let targetRequestId = "";

    const open = async () => {
      const rows = await sql<{ team_id: string; id: string }>(
        `SELECT team_id, id FROM workspace_closure_requests
          WHERE team_id = ANY($1::uuid[]) AND status = 'COOLING_OFF'
          ORDER BY requested_at_utc ASC`,
        [subjects],
      );
      expect(
        rows.length,
        "no cancellable closure request remains — the fixture can no longer " +
          "offer the control under test",
      ).toBeGreaterThan(0);
      target = rows[0]!.team_id;
      targetRequestId = rows[0]!.id;

      await page.goto(`/teams/${target}`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, WORKSPACE_ADMIN_ROUTE_ID);
      await waitForSurface(page, "[data-workspace-closure-card]");
      await expect(
        page.locator('[data-action="cancel-workspace-closure"]'),
      ).toBeEnabled({ timeout: 30_000 });
    };

    const submit = () => page.locator('[data-action="cancel-workspace-closure"]');

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.workspace.closure_cancelled",
        pageUrl: "/teams/{id}",
        control: '[data-action="cancel-workspace-closure"] — “Cancel closure request”',
        method: "POST",
        apiPath: "POST /v1/teams/:id/closure/:requestId/cancel",
        pathFragment: "/cancel",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      // Nothing to fill: the control acts on the request the card is already
      // showing, and the request id travels in the URL rather than a field.
      arm: async () => {},
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(submit(), keyboard);
        else await activateOnce(submit(), keyboard);
      },
      submitControl: submit,
      /**
       * PHASE 13 (SPEC CORRECTION) — the confirmation LANDED, and success and
       * failure are announced in two DIFFERENT regions.
       *
       * The previous comment here read "Cancellation currently renders NO
       * confirmation of any kind; the card returns to its initial state and says
       * nothing." NEW-048 fixed exactly that: `WorkspaceClosureCard` now renders
       * `[data-workspace-closure-notice]` (`role="status"`, `aria-live="polite"`)
       * OUTSIDE the open/closed branch, specifically so a cancellation can be
       * announced at all.
       *
       * A FAILURE is not announced there, and cannot be: `cancelClosure` clears
       * `closureNotice` before it starts, so on the error path that region is
       * unmounted (it renders conditionally) and the message goes to the card's
       * `role="alert"` region, `[data-workspace-closure-error]`. Reading the
       * error out of `[role="status"]`.first() therefore found nothing at all.
       *
       * Naming both regions is what `errorStatusRegion` exists for — the driver's
       * own docblock describes this shape. It also removes a `.first()` that
       * silently depended on DOM order between two live regions.
       */
      statusRegion: () =>
        page.locator(
          '[data-workspace-closure-card] [data-workspace-closure-notice]',
        ),
      errorStatusRegion: () =>
        page.locator(
          '[data-workspace-closure-card] [data-workspace-closure-error]',
        ),
      // The durable effect of cancellation is a STATE TRANSITION, not a new
      // row — counting CANCELLED requests is how a transition becomes a count.
      countHere: () =>
        countRows(
          "workspace_closure_requests",
          "team_id = ANY($1::uuid[]) AND status = 'CANCELLED'",
          [subjects],
        ),
      countThere: () =>
        countRows(
          "workspace_closure_requests",
          "team_id = $1 AND status = 'CANCELLED'",
          [fixture.otherTenant.workspaceId],
        ),
      successCopy: /cancelled/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        // The card re-reads and must stop offering to cancel something that
        // is no longer open.
        await expect(
          page.locator('[data-action="cancel-workspace-closure"]'),
          "a cancelled request must no longer offer cancellation",
        ).toHaveCount(0, { timeout: 20_000 });
        const row = await sql<{ status: string }>(
          `SELECT status FROM workspace_closure_requests WHERE id = $1`,
          [targetRequestId],
        );
        expect(
          row[0]?.status,
          "the cancelled request row must carry the CANCELLED status",
        ).toBe("CANCELLED");
      },
    });

    proven("p7.ui.workspace.closure_cancelled");
  });

  // =========================================================================
  // 10. POST /v1/teams/:id/reopen — the reverse leg
  //
  // COMPLETED is written ONLY by the closure worker's execution pass, so the
  // completed request is seeded: waiting for a cron in a browser test would
  // be waiting for a scheduler, not for the product. The control is what is
  // under test, and it renders only when the card's own read says the latest
  // request COMPLETED — so a single subject serves both passes, because a
  // successful reopen does not clear that state.
  // =========================================================================

  test("p7.ui.workspace.reopened", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "ws-reopen" });
    const e = await seedOwnedWorkspace({
      label: "reopen-e",
      ownerUserId: fixture.owner.userId,
    });
    await seedWorkspaceClosureRequest({
      teamId: e.workspaceId,
      requestedByUserId: fixture.owner.userId,
      status: "COMPLETED",
    });
    const { probe } = await signInAsOwner(page, fixture);

    const submit = () => page.locator('[data-action="reopen-workspace"]');

    const open = async () => {
      await page.goto(`/teams/${e.workspaceId}`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, WORKSPACE_ADMIN_ROUTE_ID);
      await waitForSurface(page, "[data-workspace-closure-card]");
      await expect(
        page.locator("[data-workspace-reopen]"),
        "the reopen control must appear for a workspace whose closure COMPLETED",
      ).toBeVisible({ timeout: 30_000 });
      await expect(submit()).toBeEnabled({ timeout: 30_000 });
    };

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.workspace.reopened",
        pageUrl: "/teams/{id}",
        control: '[data-action="reopen-workspace"] — “Reopen workspace”',
        method: "POST",
        apiPath: "POST /v1/teams/:id/reopen",
        pathFragment: "/reopen",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm: async () => {},
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(submit(), keyboard);
        else await activateOnce(submit(), keyboard);
      },
      submitControl: submit,
      statusRegion: () => page.locator("[data-workspace-reopen-status]"),
      /**
       * Reopen restores the OWNER's membership and writes one activity row in
       * the same transaction (`workspace-lifecycle.service.ts:250-270`). The
       * activity row is the durable artefact that is guaranteed to be NEW —
       * the membership update is idempotent, so counting it could be
       * satisfied by a reopen that did nothing.
       */
      countHere: () =>
        countRows(
          "team_activities",
          "team_id = $1 AND event_type = 'workspace_reopened'",
          [e.workspaceId],
        ),
      countThere: () =>
        countRows(
          "team_activities",
          "team_id = $1 AND event_type = 'workspace_reopened'",
          [fixture.otherTenant.workspaceId],
        ),
      successCopy: /Workspace reopened/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        const rows = await sql<{ status: string }>(
          `SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2`,
          [e.workspaceId, fixture.owner.userId],
        );
        expect(
          rows[0]?.status,
          "reopening must leave the owner's own membership ACTIVE",
        ).toBe("ACTIVE");
        // And the card re-read: the completed closure is still the latest
        // request, so the control stays — the surface did not go stale.
        const latest = await latestClosureRequest(e.workspaceId);
        expect(latest?.status).toBe("COMPLETED");
      },
    });

    proven("p7.ui.workspace.reopened");

    await page.context().clearCookies();
    await login(page, fixture.member);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.workspace.reopened",
      pageUrl: "/teams/{id}",
      control: '[data-action="reopen-workspace"]',
      method: "POST",
      apiPath: "POST /v1/teams/:id/reopen",
      requestPath: `/v1/teams/${e.workspaceId}/reopen`,
      body: {},
      tenantWorkspaceId: fixture.tenant.workspaceId,
      countRowsNow: () =>
        countRows(
          "team_activities",
          "team_id = $1 AND event_type = 'workspace_reopened'",
          [e.workspaceId],
        ),
    });
  });

  // =========================================================================
  // 11. POST /v1/teams/:id/transfer-ownership — WorkspaceOwnershipTransferCard
  //
  // STEP-UP GATED, and OWNED-kind only: an ORGANIZATION workspace answers 409
  // `ORG_WORKSPACE_OWNERSHIP_IS_ORG_GOVERNED`, which is why the subjects here
  // are owned workspaces with the member already an ACTIVE member — the only
  // shape the route will accept as a target.
  // =========================================================================

  test("p7.ui.workspace.ownership_transferred", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "ws-transfer" });
    const g = await seedOwnedWorkspace({
      label: "transfer-g",
      ownerUserId: fixture.owner.userId,
      memberUserId: fixture.member.userId,
    });
    const h = await seedOwnedWorkspace({
      label: "transfer-h",
      ownerUserId: fixture.owner.userId,
      memberUserId: fixture.member.userId,
    });
    const { probe } = await signInAsOwner(page, fixture);

    const subjects = [g.workspaceId, h.workspaceId];
    let target = g.workspaceId;

    const open = async () => {
      const rows = await sql<{ id: string }>(
        `SELECT id FROM teams
          WHERE id = ANY($1::uuid[]) AND owner_user_id = $2
          ORDER BY created_at ASC`,
        [subjects, fixture.owner.userId],
      );
      expect(
        rows.length,
        "no subject workspace is still owned by the actor — the fixture can " +
          "no longer offer the control under test",
      ).toBeGreaterThan(0);
      target = rows[0]!.id;

      await page.goto(`/teams/${target}`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, WORKSPACE_ADMIN_ROUTE_ID);
      await waitForSurface(page, "[data-workspace-ownership-transfer-card]");
      // The picker is fed from the workspace's own roster, so a user id is
      // never hand-typed; wait for the roster to reach it.
      await expect
        .poll(
          async () =>
            page
              .locator(
                `[data-control="workspace-transfer-target"] option[value="${fixture.member.userId}"]`,
              )
              .count(),
          {
            message: "the member roster must populate the transfer picker",
            timeout: 30_000,
          },
        )
        .toBeGreaterThan(0);
    };

    const arm = async () => {
      await page
        .locator('[data-control="workspace-transfer-target"]')
        .selectOption(fixture.member.userId);
      // Ownership moves billing with it, so the card requires an explicit
      // confirmation step before the request may leave.
      await page.locator('[data-action="open-workspace-transfer-ownership"]').click();
      await waitForSurface(page, "[data-workspace-transfer-confirm]");
    };

    const submit = () => page.locator('[data-action="transfer-workspace-ownership"]');

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.workspace.ownership_transferred",
        pageUrl: "/teams/{id}",
        control:
          '[data-control="workspace-transfer-target"] → [data-action="transfer-workspace-ownership"]',
        method: "POST",
        apiPath: "POST /v1/teams/:id/transfer-ownership",
        pathFragment: "/transfer-ownership",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(submit(), keyboard);
        else await activateOnce(submit(), keyboard);
      },
      submitControl: submit,
      /**
       * PHASE 13 (SPEC CORRECTION) — the SUCCESS region is the page's, the
       * FAILURE region is the card's, and the difference is structural.
       *
       * This assertion used to name `[data-workspace-transfer-status]`, which
       * lives INSIDE `WorkspaceOwnershipTransferCard`. That card can never hold
       * a success: a transfer demotes the actor out of the ownership the card is
       * gated on (`{isOwner && teamId ? <WorkspaceOwnershipTransferCard …>`), so
       * the refresh that follows a successful transfer unmounts it. The product
       * says so in as many words at `WorkspaceOwnershipTransferCard.tsx:100-104`
       * and NEW-049 acted on it: the outcome is handed upward through
       * `onTransferred` and announced by the PAGE, in a `role="status"` region
       * that outlives the card (`teams/[id]/page.tsx` →
       * `[data-workspace-ownership-notice]`).
       *
       * So the old locator asserted the announcement against the one element
       * guaranteed to be gone by the time there was anything to announce. Naming
       * the surviving region is not a relaxation — the claim (an
       * `aria-live`/`role=status` region carries the outcome, and the copy says
       * who now owns the workspace) is unchanged and still checked by
       * `proveMutationCapability`. The card's own region stays asserted for the
       * FAILURE path via `errorStatusRegion`, which is where a denial IS shown,
       * because the card is still mounted when a transfer is refused.
       */
      statusRegion: () => page.locator("[data-workspace-ownership-notice]"),
      errorStatusRegion: () => page.locator("[data-workspace-transfer-status]"),
      // The transition is on the team row itself: owner AND billing owner
      // move together (`workspace-lifecycle.service.ts:162-168`).
      countHere: () =>
        countRows(
          "teams",
          "id = ANY($1::uuid[]) AND owner_user_id = $2 AND billing_owner_user_id = $2",
          [subjects, fixture.member.userId],
        ),
      countThere: () =>
        countRows("teams", "id = $1 AND owner_user_id = $2", [
          fixture.otherTenant.workspaceId,
          fixture.member.userId,
        ]),
      successCopy: /now owns/i,
      expectStatus: 200,
      resolveStepUp: stepUpWithPassword(page, fixture.owner.password),
      expectRefreshed: async () => {
        // The demoted owner keeps an ADMIN membership
        // (`membership-provisioning.service.ts:1032-1043`) — the roles moved
        // as a pair rather than one of them moving.
        const rows = await sql<{ user_id: string; role: string }>(
          `SELECT user_id, role FROM team_members WHERE team_id = $1`,
          [target],
        );
        const byUser = new Map(rows.map((r) => [r.user_id, r.role]));
        expect(
          byUser.get(fixture.member.userId),
          "the new owner's membership must be promoted to OWNER",
        ).toBe("OWNER");
        expect(
          byUser.get(fixture.owner.userId),
          "the previous owner must be demoted to ADMIN, not removed",
        ).toBe("ADMIN");
      },
    });

    proven("p7.ui.workspace.ownership_transferred");
  });

  // =========================================================================
  // 12 + 13. Organization-workspace suspend and resume
  //
  // Two tests rather than one, because suspension and resumption are each
  // one-way on their subject and the injected-500 pass needs a subject still
  // in the pre-state. Both act on SIBLING workspaces of the one the operator
  // is signed into: suspension clears `users.current_workspace_id` for every
  // member of the suspended workspace, so suspending the session's own
  // workspace would eject the operator and replace the surface under test
  // with a context-recovery path.
  // =========================================================================

  test("p7.ui.org.workspace_suspended", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "org-suspend" });
    const t1 = await seedOrganizationWorkspace({
      tenant: fixture.tenant,
      label: "suspend-1",
      ownerUserId: fixture.owner.userId,
      memberUserId: fixture.member.userId,
    });
    const t2 = await seedOrganizationWorkspace({
      tenant: fixture.tenant,
      label: "suspend-2",
      ownerUserId: fixture.owner.userId,
      memberUserId: fixture.member.userId,
    });
    const { probe } = await signInAsOwner(page, fixture);

    const subjects = [t1.workspaceId, t2.workspaceId];
    let target = t1.workspaceId;
    let listReadsBeforeFire = 0;

    const open = async () => {
      const rows = await sql<{ team_id: string }>(
        `SELECT team_id FROM team_members
          WHERE team_id = ANY($1::uuid[]) AND status = 'ACTIVE'::"TeamMemberStatus"`,
        [subjects],
      );
      const live = new Set(rows.map((r) => r.team_id));
      const next = subjects.find((id) => live.has(id));
      expect(
        next,
        "every subject workspace is already suspended — the fixture can no " +
          "longer offer the control under test",
      ).toBeTruthy();
      target = next!;

      await page.goto(`/organizations/${fixture.tenant.organizationId}`, {
        waitUntil: "domcontentloaded",
      });
      await expectSurfaceRendered(page, ORGANIZATION_DETAIL_ROUTE_ID);
      await waitForSurface(page, `[data-org-workspace-lifecycle="${target}"]`);
      const reveal = page.locator(`[data-testid="workspace-suspend-${target}"]`);
      await expect(reveal).toBeEnabled({ timeout: 30_000 });
      await reveal.click();
      await waitForSurface(page, `[data-org-workspace-suspend-confirm="${target}"]`);
    };

    const arm = async () => {
      listReadsBeforeFire = probe.apiMutations(
        "GET",
        `/v1/orgs/${fixture.tenant.organizationId}/workspaces`,
      ).length;
    };

    const submit = () =>
      page.locator(`[data-testid="workspace-suspend-confirm-${target}"]`);

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.org.workspace_suspended",
        pageUrl: "/organizations/{orgId}",
        control:
          '[data-testid="workspace-suspend-{wsId}"] → [data-testid="workspace-suspend-confirm-{wsId}"]',
        method: "POST",
        apiPath: "POST /v1/orgs/:id/workspaces/:teamId/suspend",
        pathFragment: "/suspend",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(submit(), keyboard);
        else await activateOnce(submit(), keyboard);
      },
      submitControl: submit,
      statusRegion: () =>
        page.locator(`[data-org-workspace-lifecycle-status="${target}"]`),
      // Suspension moves every ACTIVE membership to SUSPENDED and stamps the
      // canonical marker reason that `resume` later matches on.
      countHere: () =>
        countRows(
          "team_members",
          `team_id = ANY($1::uuid[]) AND status = 'SUSPENDED'::"TeamMemberStatus" AND suspension_reason = $2`,
          [subjects, ORG_SUSPENSION_REASON],
        ),
      countThere: () =>
        countRows(
          "team_members",
          `team_id = $1 AND status = 'SUSPENDED'::"TeamMemberStatus"`,
          [fixture.otherTenant.workspaceId],
        ),
      successCopy: /is suspended/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        await expect
          .poll(
            async () =>
              probe.apiMutations(
                "GET",
                `/v1/orgs/${fixture.tenant.organizationId}/workspaces`,
              ).length - listReadsBeforeFire,
            {
              message:
                "the console must re-read the workspace list rather than patch it",
              timeout: 20_000,
            },
          )
          .toBeGreaterThan(0);
      },
    });

    proven("p7.ui.org.workspace_suspended");

    // A plain ORG_MEMBER is refused by the SERVER, not merely by a hidden
    // control — `checkOrgAccess(minRole: "ORG_ADMIN")`.
    await page.context().clearCookies();
    await login(page, fixture.member);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.org.workspace_suspended",
      pageUrl: "/organizations/{orgId}",
      control: '[data-testid="workspace-suspend-{wsId}"]',
      method: "POST",
      apiPath: "POST /v1/orgs/:id/workspaces/:teamId/suspend",
      requestPath: `/v1/orgs/${fixture.tenant.organizationId}/workspaces/${t2.workspaceId}/suspend`,
      body: {},
      tenantWorkspaceId: fixture.tenant.workspaceId,
      countRowsNow: () =>
        countRows(
          "team_members",
          `team_id = $1 AND status = 'SUSPENDED'::"TeamMemberStatus"`,
          [t2.workspaceId],
        ),
    });
  });

  test("p7.ui.org.workspace_resumed", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "org-resume" });
    const u1 = await seedOrganizationWorkspace({
      tenant: fixture.tenant,
      label: "resume-1",
      ownerUserId: fixture.owner.userId,
      memberUserId: fixture.member.userId,
    });
    const u2 = await seedOrganizationWorkspace({
      tenant: fixture.tenant,
      label: "resume-2",
      ownerUserId: fixture.owner.userId,
      memberUserId: fixture.member.userId,
    });
    const subjects = [u1.workspaceId, u2.workspaceId];

    // The SUSPENDED state is the precondition, not the capability — it is
    // exactly what capability twelve produces, including the marker reason
    // `resume` matches on. Seeding it here is what lets the resume leg be
    // proven on its own terms rather than as the tail of another journey.
    await sql(
      `UPDATE team_members
          SET status = 'SUSPENDED'::"TeamMemberStatus",
              suspended_at_utc = NOW(),
              suspended_by_user_id = $2,
              suspension_reason = $3
        WHERE team_id = ANY($1::uuid[])`,
      [subjects, fixture.owner.userId, ORG_SUSPENSION_REASON],
    );

    const { probe } = await signInAsOwner(page, fixture);

    let target = u1.workspaceId;
    let listReadsBeforeFire = 0;

    const open = async () => {
      const rows = await sql<{ team_id: string }>(
        `SELECT DISTINCT team_id FROM team_members
          WHERE team_id = ANY($1::uuid[])
            AND status = 'SUSPENDED'::"TeamMemberStatus"
            AND suspension_reason = $2`,
        [subjects, ORG_SUSPENSION_REASON],
      );
      const suspended = new Set(rows.map((r) => r.team_id));
      const next = subjects.find((id) => suspended.has(id));
      expect(
        next,
        "no subject workspace is still suspended — the fixture can no longer " +
          "offer the control under test",
      ).toBeTruthy();
      target = next!;

      await page.goto(`/organizations/${fixture.tenant.organizationId}`, {
        waitUntil: "domcontentloaded",
      });
      await expectSurfaceRendered(page, ORGANIZATION_DETAIL_ROUTE_ID);
      await waitForSurface(page, `[data-org-workspace-lifecycle="${target}"]`);
      await expect(
        page.locator(`[data-testid="workspace-resume-${target}"]`),
      ).toBeEnabled({ timeout: 30_000 });
    };

    const arm = async () => {
      listReadsBeforeFire = probe.apiMutations(
        "GET",
        `/v1/orgs/${fixture.tenant.organizationId}/workspaces`,
      ).length;
    };

    // Resumption is non-destructive and fires inline — there is no
    // confirmation step, and the row control IS the mutation.
    const submit = () => page.locator(`[data-testid="workspace-resume-${target}"]`);

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.org.workspace_resumed",
        pageUrl: "/organizations/{orgId}",
        control: '[data-testid="workspace-resume-{wsId}"] — “Resume”',
        method: "POST",
        apiPath: "POST /v1/orgs/:id/workspaces/:teamId/resume",
        pathFragment: "/resume",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(submit(), keyboard);
        else await activateOnce(submit(), keyboard);
      },
      submitControl: submit,
      statusRegion: () =>
        page.locator(`[data-org-workspace-lifecycle-status="${target}"]`),
      countHere: () =>
        countRows(
          "team_members",
          `team_id = ANY($1::uuid[]) AND status = 'ACTIVE'::"TeamMemberStatus"`,
          [subjects],
        ),
      countThere: () =>
        countRows(
          "team_members",
          `team_id = $1 AND status = 'ACTIVE'::"TeamMemberStatus"`,
          [fixture.otherTenant.workspaceId],
        ),
      successCopy: /is active again/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        await expect
          .poll(
            async () =>
              probe.apiMutations(
                "GET",
                `/v1/orgs/${fixture.tenant.organizationId}/workspaces`,
              ).length - listReadsBeforeFire,
            {
              message:
                "the console must re-read the workspace list rather than patch it",
              timeout: 20_000,
            },
          )
          .toBeGreaterThan(0);
      },
    });

    proven("p7.ui.org.workspace_resumed");

    await page.context().clearCookies();
    await login(page, fixture.member);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.org.workspace_resumed",
      pageUrl: "/organizations/{orgId}",
      control: '[data-testid="workspace-resume-{wsId}"]',
      method: "POST",
      apiPath: "POST /v1/orgs/:id/workspaces/:teamId/resume",
      requestPath: `/v1/orgs/${fixture.tenant.organizationId}/workspaces/${u2.workspaceId}/resume`,
      body: {},
      tenantWorkspaceId: fixture.tenant.workspaceId,
      countRowsNow: () =>
        countRows(
          "team_members",
          `team_id = $1 AND status = 'ACTIVE'::"TeamMemberStatus"`,
          [u2.workspaceId],
        ),
    });
  });
});
