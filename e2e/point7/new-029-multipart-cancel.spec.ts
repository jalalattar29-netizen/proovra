/**
 * PHASE 13 §C — NEW-029: multipart upload cancellation, proven against real
 * S3-compatible storage.
 *
 * THE DEFECT THIS LAYER EXISTS TO CLOSE
 * ---------------------------------------------------------------------------
 * `MultipartUploader.cancel()` set three local flags and returned. The server
 * was never told. So the `evidence_upload_sessions` row stayed open, and —
 * once `multipart/initiate` had run — the S3 multipart upload was abandoned
 * mid-flight with its uploaded parts still stored and still billed. Two
 * registered routes existed for exactly this, `…/abort` and
 * `…/multipart/abort`, and nothing in the product called either.
 *
 * WHY A UNIT TEST COULD NOT HAVE PROVEN THE FIX
 * ---------------------------------------------------------------------------
 * The whole defect lives at a boundary that unit tests replace: a fake S3
 * happily "forgets" an upload nobody aborted, and a fake API happily reports
 * the session closed. The only assertion that distinguishes fixed from broken
 * is `ListMultipartUploads` against real storage — so this suite drives a real
 * Chromium, uploads real bytes through a real presigned PUT to a real MinIO,
 * and then asks MinIO whether the upload is gone.
 *
 * WHAT THE SOURCE ACTUALLY DOES ON CANCEL (read before asserting)
 * ---------------------------------------------------------------------------
 * `abortServerSide()` (`apps/web/lib/uploads/multipart-uploader.ts:236`) does
 * the local transition FIRST and unconditionally, then issues TWO legs when
 * multipart was initiated: `…/multipart/abort` and then `…/abort`. It is NOT
 * one request. And the second leg is expected to be REFUSED: the multipart leg
 * has already moved the row to ABORTED, and `abortUploadSession`'s guarded
 * UPDATE excludes ABORTED (`upload-session.service.ts:884`), so the session leg
 * answers 409 `session_already_terminal`. The user never sees it, which is the
 * point of the fix — cancelling is not allowed to fail in front of the
 * operator. These scenarios assert that real shape rather than a tidier one.
 *
 * INTERCEPTION, AND ITS LIMITS
 * ---------------------------------------------------------------------------
 * Two of the harness's four sanctioned uses appear here and nothing else:
 * DELAYING real presigned-part responses so the upload is genuinely in flight
 * when Cancel is pressed (the response is MinIO's; only its timing is ours),
 * and FAILING one abort request once to prove the local cancelled state holds
 * whatever the network does. No product module is substituted.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect, type Page, type Route } from "@playwright/test";

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
  P7_STORAGE_ORIGIN,
  UPLOAD_NOT_FOUND_BODY,
  buildResumableSizedFile,
  countUploadedParts,
  forceAbortMultipart,
  listOpenMultipartUploadIds,
  probeMultipartParts,
  resetDisposableMultipartUploads,
  provisionEnterpriseOrganization,
  readUploadSession,
  setCurrentWorkspace,
  waitForLiveMultipartSession,
} from "./_org-upload-fixtures";

const SUITE = "e2e/point7/new-029-multipart-cancel.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

/**
 * Just over the resumable threshold.
 *
 * `LARGE_FILE_THRESHOLD_BYTES` is 100 MiB and is deliberately a compile-time
 * constant ("changing it requires a code review, not an env flip"), so the
 * fixture has to clear it rather than configure around it. 104 MiB with the
 * default 8 MiB chunk gives 13 parts — enough that parts are still in flight
 * while one has already landed, which is the state a cancel has to survive.
 */
const RESUMABLE_FILE_BYTES = 104 * 1024 * 1024;

/** Where the fixture file lands. `.p7tmp` is the run's own scratch area. */
const SCRATCH_DIR = ".p7tmp/new029";

/**
 * Materialise the fixture on disk and hand Playwright the PATH.
 *
 * Deliberately not an in-memory `filePayload`: a hundred megabytes through the
 * DevTools protocol is slow and has bitten other suites, and the browser reads
 * a real file the way a real operator's picker does.
 */
function writeFixtureFile(label: string): { path: string; name: string } {
  const dir = resolve(process.cwd(), SCRATCH_DIR);
  mkdirSync(dir, { recursive: true });
  const name = `p13-new029-${label}-${Date.now().toString(36)}.mp4`;
  const path = resolve(dir, name);
  writeFileSync(path, buildResumableSizedFile(RESUMABLE_FILE_BYTES));
  return { path, name };
}

/** True for anything addressed to the disposable MinIO. */
const isStorageUrl = (url: URL): boolean =>
  `${url.protocol}//${url.host}` === P7_STORAGE_ORIGIN;

/**
 * Hold every presigned part PUT except the first.
 *
 * Registered AFTER `login()` so it takes precedence over the harness's
 * catch-all outbound guard — Playwright resolves the most recently registered
 * matching route first. The held requests are still made, to the real MinIO,
 * with the real presigned URL; only the moment they leave is ours. Without
 * this the thirteen parts finish over loopback faster than a click, and
 * "cancel an upload that is in flight" would silently become "cancel an upload
 * that already finished" — a different and much weaker statement.
 */
async function holdPartUploads(page: Page, holdMs: number): Promise<void> {
  let seen = 0;
  // A predicate rather than a glob: presigned URLs are mostly query string,
  // and Playwright's glob syntax gives `?` and `*` meaning. An exact origin
  // test cannot be surprised by a signature that happens to contain one.
  await page.route(isStorageUrl, async (route: Route) => {
    // `fallback()` rather than `continue()` throughout: continuing would issue
    // the request from HERE and skip the harness's outbound guard, so the
    // run's browser-network ledger would quietly stop recording these
    // destinations. Falling back keeps the guard in the path.
    if (route.request().method() !== "PUT") return route.fallback();
    seen += 1;
    if (seen === 1) return route.fallback();
    await new Promise((r) => setTimeout(r, holdMs));
    try {
      await route.fallback();
    } catch {
      // The page may already be navigating or closed by the time the hold
      // expires; a held request that never lands is the intended outcome of a
      // cancel, not a failure of it.
    }
  });
}

/**
 * A tenant that can capture: an ENTERPRISE workspace inside a CUSTOMER
 * Organization, with the account's restored workspace pointed at it.
 *
 * Not a Personal Space: `assertPersonalUploadMutationAllowed`
 * (`upload-sessions.routes.ts:279`) runs an extra managed-identity gate on
 * personal workspaces, and a scenario about cancellation should not be able to
 * fail for a reason about personal-space policy.
 */
async function buildUploadTenant(label: string) {
  const account = await createAccount({ label: `${label}-cap`, plan: "ENTERPRISE" });
  const org = await provisionEnterpriseOrganization({
    ownerUserId: account.userId,
    label,
  });
  await setCurrentWorkspace(account.userId, org.workspaceId);
  return { account, ...org };
}

/**
 * Drive the REAL capture surface until an S3 multipart upload is live with at
 * least one part genuinely stored.
 *
 * `/capture` is the surface that hosts the uploader — it is the only consumer
 * of `useResumableUploads`, which is the only consumer of `MultipartUploader`
 * (`apps/web/app/(app)/capture/page.tsx:223,536`). The operations panel with
 * the Cancel control renders only once there is an upload to show.
 */
async function startLiveUpload(input: {
  page: Page;
  teamId: string;
  label: string;
}): Promise<{ sessionId: string; uploadId: string; storageKey: string; filePath: string }> {
  const { page, teamId, label } = input;
  const fixture = writeFixtureFile(label);

  await page.goto(`${WEB_BASE}/capture`, { waitUntil: "domcontentloaded" });
  await page
    .locator('input[aria-label="Upload evidence files"]')
    .setInputFiles(fixture.path);

  // The finalize control is what starts the upload; staging a file does not.
  const finalize = page.locator("button.capture-finish-button");
  await expect(finalize).toBeEnabled({ timeout: 30_000 });
  await finalize.click();

  const session = await waitForLiveMultipartSession({ teamId, timeoutMs: 45_000 });
  expect(session.multipart_upload_id, "session has a live S3 multipart").toBeTruthy();
  expect(session.storage_key).toBeTruthy();

  // At least one REAL part, proven by the server's own part bookkeeping: the
  // ETag column is only written after the client reported an ETag that MinIO
  // returned from a real presigned PUT.
  await expect
    .poll(() => countUploadedParts(session.id), { timeout: 45_000 })
    .toBeGreaterThanOrEqual(1);

  return {
    sessionId: session.id,
    uploadId: session.multipart_upload_id!,
    storageKey: session.storage_key!,
    filePath: fixture.path,
  };
}

/** The operations panel's Cancel control, by its accessible name. */
function cancelControl(page: Page) {
  return page.locator('button[aria-label="Cancel upload"]');
}

// ===========================================================================
// 1 — cancel reaches storage
// ===========================================================================

test.describe("NEW-029 cancel", () => {
  /**
   * PHASE 13 (NEW-077) — ESTABLISH THE PRECONDITION, DO NOT INHERIT IT.
   *
   * Both scenarios below state their precondition over the WHOLE bucket
   * ("storage really is holding an open multipart") and their postcondition the
   * same way ("no live upload remains"). Open multiparts survive a failed run by
   * design — that IS the leak this suite detects — so the bucket accumulated
   * them until `listOpenMultipartUploadIds()` returned four ids from previous
   * runs and the precondition failed on residue that had nothing to do with the
   * product.
   *
   * The reset is loopback-and-disposable-bucket-only — see
   * `assertDisposableStorageTarget` — and touches multipart uploads exclusively,
   * never completed objects. It runs BEFORE each scenario and never between the
   * product's cleanup and the assertion about it; placing it there would
   * manufacture the postcondition instead of measuring it.
   */
  test.beforeEach(async () => {
    await resetDisposableMultipartUploads();
    expect(
      await listOpenMultipartUploadIds(),
      "the disposable bucket must hold no open multipart upload before a " +
        "scenario that asserts over the bucket",
    ).toEqual([]);
  });
  test("p7.new029.cancel_aborts_storage_and_session", async ({ page, browser }) => {
    const tenant = await buildUploadTenant("new029-main");
    await login(page, tenant.account);
    await holdPartUploads(page, 12_000);
    const log = recordRequests(page);

    const live = await startLiveUpload({
      page,
      teamId: tenant.workspaceId,
      label: "main",
    });

    // Storage really is holding an open multipart with real parts. Everything
    // below is a claim about removing THIS, and it has to exist first.
    expect(await listOpenMultipartUploadIds()).toContain(live.uploadId);
    const before = await probeMultipartParts({
      key: live.storageKey,
      uploadId: live.uploadId,
    });
    expect(before.kind).toBe("present");
    if (before.kind === "present") {
      expect(before.partCount).toBeGreaterThanOrEqual(1);
    }

    // ---------------------------------------------------------------------
    // Cross-tenant refusal, asserted while the session is LIVE.
    //
    // Asserted here rather than in its own scenario because the meaningful
    // version of the question is "can a stranger kill somebody's upload in
    // progress?", and a second hundred-megabyte upload would prove the same
    // thing more slowly. The refusal must be NON-DISCLOSING: `sendDenial`
    // collapses every 404 to one bounded body so "not yours" and "no such
    // session" are the same answer.
    // ---------------------------------------------------------------------
    const outsiderCtx = await browser.newContext();
    try {
      const outsiderPage = await outsiderCtx.newPage();
      const outsiderTenant = await buildUploadTenant("new029-outsider");
      await login(outsiderPage, outsiderTenant.account);

      const absentSessionId = "00000000-0000-4000-8000-000000000000";
      const crossMultipart = await directApiCall(outsiderPage, {
        method: "POST",
        path: `/v1/uploads/sessions/${live.sessionId}/multipart/abort`,
        body: { teamId: outsiderTenant.workspaceId, reason: "cross-tenant" },
      });
      const absentMultipart = await directApiCall(outsiderPage, {
        method: "POST",
        path: `/v1/uploads/sessions/${absentSessionId}/multipart/abort`,
        body: { teamId: outsiderTenant.workspaceId, reason: "cross-tenant" },
      });
      expect(crossMultipart.status).toBe(absentMultipart.status);
      expect(crossMultipart.body).toBe(absentMultipart.body);
      expect(crossMultipart.status).toBe(404);
      expect(crossMultipart.body).toBe(UPLOAD_NOT_FOUND_BODY);

      const crossSession = await directApiCall(outsiderPage, {
        method: "POST",
        path: `/v1/uploads/sessions/${live.sessionId}/abort`,
        body: { teamId: outsiderTenant.workspaceId, reason: "cross-tenant" },
      });
      expect(crossSession.status).toBe(404);
      expect(crossSession.body).toBe(UPLOAD_NOT_FOUND_BODY);

      // CrossTenantUploadAbort — the victim's session is untouched and its
      // multipart upload is still open.
      const untouched = await readUploadSession(live.sessionId);
      expect(untouched?.state).toBe("UPLOADING");
      expect(untouched?.aborted_at_utc).toBeNull();
      expect(await listOpenMultipartUploadIds()).toContain(live.uploadId);
    } finally {
      await outsiderCtx.close();
    }

    // ---------------------------------------------------------------------
    // The cancel itself.
    // ---------------------------------------------------------------------
    const multipartAbortUrl = `${API_BASE}/v1/uploads/sessions/${live.sessionId}/multipart/abort`;
    const sessionAbortUrl = `${API_BASE}/v1/uploads/sessions/${live.sessionId}/abort`;

    const multipartAbortResponse = page.waitForResponse(
      (r) => r.url() === multipartAbortUrl && r.request().method() === "POST",
      { timeout: 30_000 },
    );
    const sessionAbortResponse = page.waitForResponse(
      (r) => r.url() === sessionAbortUrl && r.request().method() === "POST",
      { timeout: 30_000 },
    );

    await expect(cancelControl(page)).toBeVisible({ timeout: 30_000 });
    await cancelControl(page).click();

    const mpRes = await multipartAbortResponse;
    const sessRes = await sessionAbortResponse;

    // 6 — exactly one of each leg, and the legs the source says should fire.
    const mpPosts = log
      .all.filter((r) => r.url() === multipartAbortUrl && r.method() === "POST");
    const sessPosts = log
      .all.filter((r) => r.url() === sessionAbortUrl && r.method() === "POST");
    expect(mpPosts.length, "one multipart abort").toBe(1);
    expect(sessPosts.length, "one session abort").toBe(1);

    // The multipart leg is the one that carries the storage effect; it must
    // succeed. The session leg is then a no-op that the server REFUSES —
    // `abortUploadSession` excludes ABORTED rows — and the operator is
    // deliberately never told, because cancelling must not fail in front of
    // them. Asserting the tidy "both 200" would be asserting a product that
    // does not exist.
    expect(mpRes.status(), await mpRes.text().catch(() => "")).toBe(200);
    expect(sessRes.status()).toBe(409);
    expect(await sessRes.text()).toContain("session_already_terminal");

    // 7 — the durable state, read with raw SQL against the real enum value
    // (`ABORTED` on `evidence_upload_sessions.state`, NOT the unrelated
    // `upload_sessions.status` model).
    const aborted = await readUploadSession(live.sessionId);
    expect(aborted?.state).toBe("ABORTED");
    expect(aborted?.aborted_at_utc).not.toBeNull();
    expect(aborted?.aborted_by_user_id).toBe(tenant.account.userId);
    expect(aborted?.abort_reason).toBe("cancelled_by_user");
    expect(aborted?.aborted_at_storage_utc).not.toBeNull();

    // 8 — OrphanMultipartUploads. The question storage answers and the
    // database cannot: is PROOVRA still holding (and paying for) this upload?
    await expect
      .poll(() => listOpenMultipartUploadIds(), { timeout: 20_000 })
      .not.toContain(live.uploadId);

    // 9 — and nothing is left chargeable under it. `NoSuchUpload` is a
    // stronger answer than an empty part list, which an upload that merely
    // received no parts would also give.
    const after = await probeMultipartParts({
      key: live.storageKey,
      uploadId: live.uploadId,
    });
    expect(after.kind).toBe("absent");
    if (after.kind === "absent") {
      expect(after.errorName).toContain("NoSuchUpload");
    }

    // The operator sees it stopped.
    await expect(
      page.locator('.proovra-upload-operations__row[data-state="CANCELLED"]'),
    ).toBeVisible({ timeout: 15_000 });

    // ---------------------------------------------------------------------
    // 10 — idempotence. DuplicateAbortEffects.
    // ---------------------------------------------------------------------
    // The UI withdraws the affordance, so a second cancel cannot be produced
    // by clicking: `canCancel()` admits UPLOADING / PAUSED / FAILED_RETRYABLE
    // / STAGED and not CANCELLED. That is the first half of "no duplicate".
    await expect(cancelControl(page)).toHaveCount(0);

    // The second half is the one that matters: re-issuing the canonical abort
    // — with the page's own credentials, exactly as a retry would — produces
    // no second durable effect. The abort columns use COALESCE precisely so a
    // repeat cannot re-stamp who cancelled or when.
    const repeat = await directApiCall(page, {
      method: "POST",
      path: `/v1/uploads/sessions/${live.sessionId}/multipart/abort`,
      body: { teamId: tenant.workspaceId, reason: "cancelled_by_user" },
    });
    expect(repeat.status, repeat.body).toBe(200);

    const afterRepeat = await readUploadSession(live.sessionId);
    expect(afterRepeat?.state).toBe("ABORTED");
    expect(afterRepeat?.aborted_at_utc).toEqual(aborted?.aborted_at_utc);
    expect(afterRepeat?.aborted_by_user_id).toEqual(aborted?.aborted_by_user_id);
    expect(afterRepeat?.abort_reason).toEqual(aborted?.abort_reason);

    // No error was surfaced to the operator by the repeat: the row still reads
    // CANCELLED and carries no failure reason. Scoped to the operations panel
    // deliberately — a page-wide alert count would fold in every unrelated
    // banner the capture surface may legitimately raise.
    const panel = page.locator('section[aria-label="Upload operations"]');
    await expect(
      panel.locator('.proovra-upload-operations__row[data-state="CANCELLED"]'),
    ).toBeVisible();
    await expect(panel.locator('[aria-label="failure reason"]')).toHaveCount(0);

    // ---------------------------------------------------------------------
    // 12 — CancelledSessionResumed. A reload must not restart it.
    // ---------------------------------------------------------------------
    const afterReloadLog = recordRequests(page);
    await page.reload({ waitUntil: "domcontentloaded" });

    // The boot recovery scan asks the SERVER what happened to the persisted
    // session and classifies it from the answer, so this is the product's own
    // judgement, not the test's.
    const recoveryRow = page.locator(
      '.proovra-upload-operations__recovery li[data-classification="aborted"]',
    );
    await expect(recoveryRow).toBeVisible({ timeout: 30_000 });
    await expect(recoveryRow.getByRole("button", { name: "Resume" })).toHaveCount(0);

    const restarted = afterReloadLog.all.filter(
      (r) =>
        r.url().includes(`/v1/uploads/sessions/${live.sessionId}/parts/`) ||
        (r.url().startsWith(P7_STORAGE_ORIGIN) && r.method() === "PUT"),
    );
    expect(restarted.length, "CancelledSessionResumed").toBe(0);

    const stillAborted = await readUploadSession(live.sessionId);
    expect(stillAborted?.state).toBe("ABORTED");
    expect(await listOpenMultipartUploadIds()).not.toContain(live.uploadId);

    rmSync(live.filePath, { force: true });
    proven("p7.new029.cancel_aborts_storage_and_session");
  });

  /**
   * 11 — the cancel has to hold when the network does not.
   *
   * The whole point of doing the local transition FIRST and unconditionally is
   * that a user who presses Cancel sees it stop regardless of what happens on
   * the wire. Here the multipart leg is failed exactly ONCE — the uploader does
   * not retry aborts, so that leg is simply lost — and three things are then
   * true at the same time: the operator sees CANCELLED, the session leg still
   * lands (this is the path that writes the `upload_session_aborted` security
   * event, because it is the leg that performs the real state transition), and
   * storage is still holding the multipart, which is the honest consequence and
   * is recoverable by re-issuing the leg that failed.
   */
  test("p7.new029.cancel_survives_abort_network_failure", async ({ page }) => {
    const tenant = await buildUploadTenant("new029-netfail");
    await login(page, tenant.account);
    await holdPartUploads(page, 12_000);

    const live = await startLiveUpload({
      page,
      teamId: tenant.workspaceId,
      label: "netfail",
    });
    const multipartAbortUrl = `${API_BASE}/v1/uploads/sessions/${live.sessionId}/multipart/abort`;

    let failedOnce = false;
    await page.route((url) => url.href === multipartAbortUrl, async (route) => {
      if (!failedOnce) {
        failedOnce = true;
        return route.abort("failed");
      }
      return route.fallback();
    });

    const sessionAbortResponse = page.waitForResponse(
      (r) =>
        r.url() === `${API_BASE}/v1/uploads/sessions/${live.sessionId}/abort` &&
        r.request().method() === "POST",
      { timeout: 30_000 },
    );

    await expect(cancelControl(page)).toBeVisible({ timeout: 30_000 });
    await cancelControl(page).click();

    // The local cancelled state holds — asserted first, because it is the
    // guarantee the fix is about.
    await expect(
      page.locator('.proovra-upload-operations__row[data-state="CANCELLED"]'),
    ).toBeVisible({ timeout: 15_000 });
    expect(failedOnce, "the abort leg really was failed once").toBe(true);

    // The surviving leg still closed the session, and — because it is the leg
    // that performed the transition — recorded it.
    const sessRes = await sessionAbortResponse;
    expect(sessRes.status(), await sessRes.text().catch(() => "")).toBe(200);

    const row = await readUploadSession(live.sessionId);
    expect(row?.state).toBe("ABORTED");
    expect(row?.aborted_by_user_id).toBe(tenant.account.userId);
    expect(row?.abort_reason).toBe("cancelled_by_user");

    // 14 — the audit record. `security_events` is the table the upload
    // lifecycle writes to (`safeEmitSecurityEvent` → `securityEvent.create` →
    // `metadataJson`); the row names the workspace and the session.
    await expect
      .poll(
        async () => {
          const rows = await sql<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM security_events
              WHERE "eventType" = 'upload_session_aborted'
                AND "teamId" = $1
                AND "metadataJson"->>'sessionId' = $2`,
            [tenant.workspaceId, live.sessionId],
          );
          return Number(rows[0]!.n);
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);

    /**
     * PHASE 13 (SPEC CORRECTION) — THE LOST LEG NO LONGER LEAKS, AND THAT IS THE
     * WHOLE POINT OF §4.
     *
     * This asserted `toContain(live.uploadId)` — "the honest consequence of the
     * lost leg: storage still holds it" — and invited exactly this update: "a
     * future change that makes the client retry the abort has to update this
     * scenario deliberately." The change that landed is better than a client
     * retry: `abortUploadSession` now cancels the storage multipart ITSELF when
     * the session row records an upload id that has not been settled, because
     * "a server-side lifecycle must not depend on a client remembering the order
     * of its own requests" (PHASE 13 §4, `upload-session.service.ts`).
     *
     * So the surviving leg is now sufficient on its own, and the assertion is
     * inverted to the STRONGER property: losing the multipart leg entirely leaves
     * NO open multipart upload and nothing chargeable behind. Asserting the old
     * leak here would pin the very defect §4 removed.
     */
    expect(
      await listOpenMultipartUploadIds(),
      "the surviving session-abort leg must settle storage on its own — a " +
        "session marked ABORTED over a live multipart is the orphan §4 removed",
    ).not.toContain(live.uploadId);

    // Recoverable: the same canonical route, re-issued, clears it. That is
    // what makes the lost leg an inconvenience rather than a leak.
    const recovery = await directApiCall(page, {
      method: "POST",
      path: `/v1/uploads/sessions/${live.sessionId}/multipart/abort`,
      body: { teamId: tenant.workspaceId, reason: "cancelled_by_user" },
    });
    expect(recovery.status, recovery.body).toBe(200);
    await expect
      .poll(() => listOpenMultipartUploadIds(), { timeout: 20_000 })
      .not.toContain(live.uploadId);

    // Belt and braces: whatever happened above, this run leaves no paid
    // resource behind for the next scenario's orphan count to inherit.
    await forceAbortMultipart({ key: live.storageKey, uploadId: live.uploadId });

    rmSync(live.filePath, { force: true });
    proven("p7.new029.cancel_survives_abort_network_failure");
  });
});
