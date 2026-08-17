/**
 * PHASE 13 — POINT 7: JOURNEY S, the Security Center write surfaces.
 *
 * Three registered routes had no product surface at all:
 *
 *   GET  /v1/capture/devices?includeRevoked=true
 *   POST /v1/capture/devices/:id/revoke
 *   POST /v1/identity/mfa-admin/recovery-requests
 *
 * The consequences were not cosmetic. The Security Center's "Trusted
 * devices" table manages the identity-security STEP-UP registry; the CAPTURE
 * trust registry — the signing keys behind at-source evidence — was a
 * different set of rows entirely and nothing in the product addressed it, so
 * a lost or stolen capture device could never be revoked by the people who
 * owned it. And the MFA lost-factor recovery flow had a verify leg and an
 * admin approve/reject leg wired, with no way for a user to FILE the request
 * those legs act on: a complete review pipeline over an empty queue.
 *
 * WHY THE LISTING CAPABILITY IS ASSERTED DIFFERENTLY
 * ---------------------------------------------------------------------------
 * `proveMutationCapability` is a driver for WRITES; it hangs everything off
 * "one request, one row". Capability fourteen is a READ, and the honest claim
 * about a read is a different one: that the browser issued it to the API
 * origin, that what came back is THIS workspace's registry and not another
 * tenant's, and that a caller in a different tenant is refused the write the
 * listing exposes. So it is written out longhand rather than forced through a
 * driver whose central assertion does not apply — and it is recorded in the
 * same ledger, so it is counted rather than quietly skipped.
 *
 * ONE THING THIS SUITE FOUND AND DOES NOT PRETEND OTHERWISE
 * ---------------------------------------------------------------------------
 * Capture-device revocation is gated on `evidence.read`
 * (`capture-trust.routes.ts:507-546` — `resolveTeamIdOrDeny` applies the same
 * permission to reading the registry and to burning a signing key). An
 * ordinary MEMBER therefore holds it, so "a member is refused" is not a claim
 * that could be made truthfully here. The refusal that IS real, and the one
 * that matters for a signing registry, is the TENANT boundary: an operator in
 * another organization is refused, and that is what is proven.
 */

import { test, expect, type Page } from "@playwright/test";

import { API_BASE, countRows, login, provenBrowserScenario } from "./_harness";
import {
  activateOnce,
  activateTwice,
  attachUiProbe,
  buildEnterpriseFixture,
  expectSurfaceRendered,
  proveMutationCapability,
  proveServerRefusal,
  recordUiCapability,
  seedCaptureDevice,
  waitForSurface,
  type UiEnterpriseFixture,
  type UiProbe,
} from "./_ui-fixtures";

const SUITE = "e2e/point7/ui-capabilities-security.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

const SECURITY_CENTER_ROUTE_ID = "workspace.security_center";

/**
 * The Security Center resolves its own workspace with `useTeamId()`
 * (security-center/page.tsx:120), which is null in personal mode — and both
 * capture routes resolve the workspace SERVER-side from
 * `users.current_workspace_id` and answer 403 `WORKSPACE_NOT_FOUND` for a
 * PERSONAL space. The shared fixture restores both actors into the
 * ORGANIZATION workspace, which is what makes this surface addressable at all.
 */
type SecuritySession = {
  page: Page;
  probe: UiProbe;
  fixture: UiEnterpriseFixture;
};

async function signInAsOwner(
  page: Page,
  fixture: UiEnterpriseFixture,
): Promise<SecuritySession> {
  const probe = await attachUiProbe(page);
  await login(page, fixture.owner);
  return { page, probe, fixture };
}

/** The first row the registry still offers a revoke control on. */
const activeDeviceRow = (page: Page) =>
  page
    .locator('[data-cc-capture-device-row][data-cc-capture-device-status="ACTIVE"]')
    .first();

test.describe("JOURNEY S — Security Center write surfaces", () => {
  // =========================================================================
  // 14. GET /v1/capture/devices?includeRevoked=true — CaptureDevicesSection
  // =========================================================================

  test("p7.ui.security.capture_devices_listed", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "sec-devices" });

    const mineLabel = `P7 UI capture device ${Date.now().toString(36)}`;
    const theirsLabel = `P7 UI OTHER TENANT device ${Date.now().toString(36)}`;
    const mine = await seedCaptureDevice({
      teamId: fixture.tenant.workspaceId,
      ownerUserId: fixture.owner.userId,
      label: mineLabel,
    });
    // A device belonging to a DIFFERENT organization. Without it, "the list
    // showed my device" is compatible with a list that shows everybody's.
    await seedCaptureDevice({
      teamId: fixture.otherTenant.workspaceId,
      ownerUserId: fixture.outsider.userId,
      label: theirsLabel,
    });

    const { probe } = await signInAsOwner(page, fixture);

    /**
     * PHASE 13 (SPEC CORRECTION) — BASELINE THE CONSOLE AT THE SURFACE, the way
     * `proveMutationCapability` already does (`_ui-fixtures.ts`:
     * `const consoleBaseline = probe.consoleErrors.length` … `.slice(
     * consoleBaseline)`).
     *
     * The assertion below says "the REGISTRY SURFACE must produce no console
     * errors" and was reading the whole session, which necessarily includes the
     * `/login` document the probe is attached to. Six entries came from there and
     * not one is about this surface:
     *
     *   2 × ERR_FAILED  — the harness's OWN outbound guard aborting the Google
     *                     and Apple sign-in widget scripts (`blockThirdParties`).
     *   2 × 401 /v1/users/me  } the login page's "am I already signed in?"
     *   2 × 401 /v1/auth/me   } probes, which correctly refuse an anonymous
     *                           caller. Chromium logs a console error for any
     *                           401 resource load, so this is unavoidable and
     *                           correct behaviour, not a defect.
     *
     * Confirmed from the API log by ORDERING, not by assumption: all four 401s
     * precede `POST /v1/auth/email/login`, and both endpoints answer 200 once the
     * session exists. Nothing is relaxed — the surface is still required to be
     * console-clean, which is what the message claims and what this scenario is
     * about. Widening the window to cover a page the harness deliberately
     * perturbs made the claim unprovable rather than stronger.
     */
    const consoleBaseline = probe.consoleErrors.length;

    await page.goto(`/security-center`, { waitUntil: "domcontentloaded" });
    await expectSurfaceRendered(page, SECURITY_CENTER_ROUTE_ID);
    await waitForSurface(page, "[data-cc-capture-devices-card]");

    // The read is real, it went to the API origin, and it asked for revoked
    // rows too — a registry that hides revoked devices cannot be audited.
    const listReads = await (async () => {
      await expect
        .poll(
          () => probe.apiMutations("GET", "/v1/capture/devices").length,
          {
            message:
              "the section must load the capture registry from the API origin",
            timeout: 30_000,
          },
        )
        .toBeGreaterThan(0);
      return probe.apiMutations("GET", "/v1/capture/devices");
    })();
    const read = listReads.at(-1)!;
    expect(
      read.url().startsWith(API_BASE),
      "the registry read must address the API origin, not the web origin",
    ).toBe(true);
    expect(
      read.url(),
      "the section must request revoked rows so a revocation stays auditable",
    ).toContain("includeRevoked=true");

    // Neither denied nor failed: the section rendered the registry itself.
    await expect(
      page.locator("[data-cc-capture-devices-denied]"),
      "an authorized operator in a non-personal workspace must not be denied",
    ).toHaveCount(0);
    await expect(
      page.locator("[data-cc-capture-devices-failed]"),
      "the registry read must not fail",
    ).toHaveCount(0);

    const card = page.locator("[data-cc-capture-devices-card]");
    await expect(card, "this workspace's device must be listed").toContainText(
      mineLabel,
      { timeout: 20_000 },
    );
    expect(
      await card.innerText(),
      "CROSS-TENANT LEAK — another organization's capture device was listed",
    ).not.toContain(theirsLabel);
    // Privacy posture: the signing key's fingerprint is deliberately not
    // rendered, and a registry that leaked it would be worse than no registry.
    const fingerprints = await page
      .locator("[data-cc-capture-devices-card]")
      .innerText();
    expect(
      fingerprints,
      "the public key fingerprint must never reach the DOM",
    ).not.toMatch(/p7uifp[0-9a-f]{8}/);

    expect(
      probe.consoleErrors.slice(consoleBaseline),
      "the registry surface must produce no console errors",
    ).toEqual([]);
    expect(probe.pageErrors, "the registry surface must not throw").toEqual([]);
    expect(
      await probe.cspViolations(),
      "the registry surface must produce no CSP violations",
    ).toEqual([]);
    expect(
      probe.wrongOriginV1().map((r) => r.url()),
      "no /v1/* request may be issued to the WEB origin",
    ).toEqual([]);

    recordUiCapability({
      capabilityId: "p7.ui.security.capture_devices_listed",
      pageUrl: "/security-center",
      control: "[data-cc-capture-devices-card] — section load",
      method: "GET",
      apiPath: "GET /v1/capture/devices?includeRevoked=true",
      requestObserved: true,
      responseStatus: 200,
      tenantWorkspaceId: fixture.tenant.workspaceId,
      resultingUiState: `listed ${mineLabel}`,
      dimension: "authorized_positive",
    });

    // The SERVER refuses a caller from another tenant the write this listing
    // exposes — asserted from inside that caller's own authenticated page.
    await page.context().clearCookies();
    await login(page, fixture.outsider);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.security.capture_devices_listed",
      pageUrl: "/security-center",
      control: "[data-cc-capture-devices-card]",
      method: "POST",
      apiPath: "POST /v1/capture/devices/:id/revoke",
      requestPath: `/v1/capture/devices/${mine}/revoke`,
      body: { reason: "OPERATOR_REQUESTED" },
      tenantWorkspaceId: fixture.tenant.workspaceId,
      countRowsNow: () =>
        countRows("devices", "team_id = $1 AND revoked_at_utc IS NOT NULL", [
          fixture.tenant.workspaceId,
        ]),
    });

    proven("p7.ui.security.capture_devices_listed");
  });

  // =========================================================================
  // 15. POST /v1/capture/devices/:id/revoke — irreversible, typed-confirm
  // =========================================================================

  test("p7.ui.security.capture_device_revoked", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "sec-revoke" });
    // TWO devices. Revocation is irreversible — a revoked row can never
    // return to ACTIVE — so the authorized pass consumes one and the
    // injected-500 pass needs a second that still offers the control.
    for (const n of [1, 2]) {
      await seedCaptureDevice({
        teamId: fixture.tenant.workspaceId,
        ownerUserId: fixture.owner.userId,
        label: `P7 UI revocable device ${n}`,
      });
    }
    await seedCaptureDevice({
      teamId: fixture.otherTenant.workspaceId,
      ownerUserId: fixture.outsider.userId,
      label: "P7 UI other-tenant device",
    });

    const { probe } = await signInAsOwner(page, fixture);

    const open = async () => {
      await page.goto(`/security-center`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, SECURITY_CENTER_ROUTE_ID);
      await waitForSurface(page, "[data-cc-capture-devices-card]");
      await expect(
        activeDeviceRow(page),
        "an ACTIVE capture device must still be offered for revocation",
      ).toBeVisible({ timeout: 30_000 });
    };

    // The reason is a required enum, validated before the confirm dialog is
    // allowed to open — so choosing it is what ARMS the control.
    const arm = async () => {
      await activeDeviceRow(page)
        .locator("[data-cc-capture-device-reason]")
        .selectOption("COMPROMISED");
    };

    const submit = () =>
      activeDeviceRow(page).getByRole("button", { name: "Revoke" });

    const dialogSubmit = () =>
      page
        .locator('[data-confirm-action-modal="capture-device-revoke"]')
        .locator('[data-confirm-action-submit="true"]');

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.security.capture_device_revoked",
        pageUrl: "/security-center",
        control:
          '[data-cc-capture-device-row] Revoke → [data-confirm-action-modal="capture-device-revoke"]',
        method: "POST",
        apiPath: "POST /v1/capture/devices/:id/revoke",
        pathFragment: "/revoke",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm,
      /**
       * Revocation is irreversible, so the mutation is issued by the DIALOG's
       * submit after the operator has typed REVOKE — not by the row control.
       * The double activation therefore targets the dialog, while the row
       * control is what must be observed disabling itself in flight.
       */
      fire: async ({ double, keyboard }) => {
        await activateOnce(submit(), keyboard);
        const modal = page.locator(
          '[data-confirm-action-modal="capture-device-revoke"]',
        );
        await expect(modal).toBeVisible({ timeout: 15_000 });
        await modal.locator("[data-confirm-action-typed-input]").fill("REVOKE");
        await expect(dialogSubmit()).toBeEnabled({ timeout: 10_000 });
        if (double) await activateTwice(dialogSubmit(), keyboard);
        else await activateOnce(dialogSubmit(), keyboard);
      },
      submitControl: submit,
      statusRegion: () => page.locator("[data-cc-capture-devices-status]"),
      countHere: () =>
        countRows("devices", "team_id = $1 AND revoked_at_utc IS NOT NULL", [
          fixture.tenant.workspaceId,
        ]),
      countThere: () =>
        countRows("devices", "team_id = $1 AND revoked_at_utc IS NOT NULL", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /is revoked/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        // The list re-reads: a revoked device must show as REVOKED and must
        // stop offering a control that can no longer do anything.
        await expect
          .poll(
            async () =>
              page
                .locator(
                  '[data-cc-capture-device-row][data-cc-capture-device-status="REVOKED"]',
                )
                .count(),
            {
              message: "the registry must re-read and show the revoked state",
              timeout: 20_000,
            },
          )
          .toBeGreaterThan(0);
      },
    });

    proven("p7.ui.security.capture_device_revoked");
  });

  // =========================================================================
  // 16. POST /v1/identity/mfa-admin/recovery-requests — the CREATE leg
  //
  // Answers 200, not 201 (`mfa-admin.routes.ts:632` returns the body without
  // setting a code). The route is throttled to three requests per account per
  // 24 hours, which is why this journey performs exactly one real write: the
  // injected-500 pass is fulfilled in the browser and never reaches the API.
  // =========================================================================

  test("p7.ui.security.mfa_recovery_requested", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "sec-mfa" });
    const { probe } = await signInAsOwner(page, fixture);

    const reason =
      "My authenticator phone was replaced and the printed recovery codes were lost with it.";

    const open = async () => {
      await page.goto(`/security-center`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, SECURITY_CENTER_ROUTE_ID);
      await waitForSurface(page, "[data-cc-mfa-recovery-request-panel]");
      // The panel resolves its own eligibility rather than rendering a
      // control that would 401; waiting for ELIGIBLE is what makes the later
      // "it was enabled for an authorized caller" assertion mean something.
      await expect(
        page.locator("[data-cc-mfa-recovery-request-panel]"),
      ).toHaveAttribute("data-cc-mfa-recovery-eligibility", "eligible", {
        timeout: 30_000,
      });
      await expect(
        page.locator("[data-cc-mfa-recovery-request-submit]"),
      ).toBeEnabled({ timeout: 30_000 });
    };

    const arm = async () => {
      await page.locator("[data-cc-mfa-recovery-request-reason]").fill(reason);
    };

    const submit = () => page.locator("[data-cc-mfa-recovery-request-submit]");

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.security.mfa_recovery_requested",
        pageUrl: "/security-center",
        control: "[data-cc-mfa-recovery-request-submit] — “File recovery request”",
        method: "POST",
        apiPath: "POST /v1/identity/mfa-admin/recovery-requests",
        pathFragment: "/v1/identity/mfa-admin/recovery-requests",
        tenantWorkspaceId: fixture.tenant.workspaceId,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(submit(), keyboard);
        else await activateOnce(submit(), keyboard);
      },
      submitControl: submit,
      statusRegion: () => page.locator("[data-cc-mfa-recovery-request-status]"),
      countHere: () =>
        countRows("mfa_recovery_requests", "team_id = $1 AND user_id = $2", [
          fixture.tenant.workspaceId,
          fixture.owner.userId,
        ]),
      countThere: () =>
        countRows("mfa_recovery_requests", "team_id = $1", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Request filed/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        // The form clears the description it just filed, so a second request
        // cannot be sent by pressing the same button twice on stale input.
        await expect(
          page.locator("[data-cc-mfa-recovery-request-reason]"),
        ).toHaveValue("", { timeout: 20_000 });
        // And the row the queue will act on carries the pre-verification
        // status the server sets — not an already-approvable one.
        // The physical enum is `mfa_recovery_request_status` (snake case), not
        // the Prisma type name — raw SQL must use the DATABASE's identifier,
        // and the mismatch is exactly the kind of drift a Prisma-mediated
        // read-back would have hidden.
        const rows = await countRows(
          "mfa_recovery_requests",
          "team_id = $1 AND user_id = $2 AND status = 'EMAIL_VERIFICATION_PENDING'::mfa_recovery_request_status",
          [fixture.tenant.workspaceId, fixture.owner.userId],
        );
        expect(
          rows,
          "a filed request must start behind email verification, never in the admin queue",
        ).toBe(1);
      },
    });

    proven("p7.ui.security.mfa_recovery_requested");

    // A caller who is not an ACTIVE member of the workspace is refused by the
    // SERVER (`mfa-recovery-request.service.ts` → 403 `not_member`).
    await page.context().clearCookies();
    await login(page, fixture.outsider);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.security.mfa_recovery_requested",
      pageUrl: "/security-center",
      control: "[data-cc-mfa-recovery-request-submit]",
      method: "POST",
      apiPath: "POST /v1/identity/mfa-admin/recovery-requests",
      requestPath: "/v1/identity/mfa-admin/recovery-requests",
      body: { teamId: fixture.tenant.workspaceId, reason },
      tenantWorkspaceId: fixture.tenant.workspaceId,
      countRowsNow: () =>
        countRows("mfa_recovery_requests", "team_id = $1", [
          fixture.tenant.workspaceId,
        ]),
    });
  });
});
