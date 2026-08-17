/**
 * PHASE 13 §C — NEW-027: the SIU export download, proven in a browser.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * The export-history row rendered its Download control as
 * `<a href={"/v1/cases/…/siu-exports/…/download"} download>`. That path is
 * RELATIVE, so the browser resolved it against the Next origin. The web app
 * and the API are different origins and `next.config` declares no `/v1`
 * rewrite, so every click produced a 404 from Next, carried no session and no
 * bearer token, and never reached the API at all.
 *
 * It survived review because nothing observable said otherwise: the anchor was
 * present, it was enabled, clicking it threw nothing, and the SIU service and
 * download route were themselves correct and unit-tested. A test that asserted
 * "the download control renders for a generated export" passed against the
 * defect, and so did every server-layer test of the route it never called.
 *
 * WHAT THIS SPEC ASSERTS THAT THOSE COULD NOT
 * ---------------------------------------------------------------------------
 * The ORIGIN of the request the browser actually emitted, the CREDENTIAL it
 * carried (proven by a 200 where a credential-less request gets 401), the
 * BYTES that came back (a real archive, asserted structurally), the DOWNLOAD
 * the page then handed the user, and the negative that makes the whole thing
 * meaningful — that no `/v1/*` request was made against the WEB origin during
 * the entire journey. The fix is not "an absolute URL is used somewhere in the
 * source"; the fix is that the bytes arrive.
 *
 * WHY THE DOWNLOAD IS OBSERVED VIA `URL.createObjectURL` RATHER THAN
 * `page.waitForEvent("download")`
 * ---------------------------------------------------------------------------
 * The fix does NOT navigate an anchor to a server URL. It fetches the bytes
 * itself, wraps them in a Blob, creates an object URL, clicks a synthesized
 * anchor and then calls `URL.revokeObjectURL(url)` on the very next line
 * (apps/web/app/(app)/cases/components/SiuPanel.tsx:366-372). A synchronous
 * revoke races the browser's own handling of the click, so whether a
 * `download` event is ever surfaced is a timing property of Chromium, not a
 * property of the product. Asserting on it would make this spec flaky in one
 * direction and, worse, silently weak in the other — a run where the event
 * never fires would be indistinguishable from a run where the fix regressed.
 *
 * So the blob lifecycle itself is instrumented, before any navigation: the
 * spec records every `createObjectURL` / `revokeObjectURL` call and every
 * programmatic anchor click with the `download` attribute the product set.
 * That is strictly MORE than the download event would have told us — it
 * carries the blob's size and MIME type and the exact filename offered — and
 * it is deterministic.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  API_BASE,
  WEB_BASE,
  blockThirdParties,
  createAccount,
  directApiCall,
  login,
  provenBrowserScenario,
  recordRequests,
  sql,
} from "./_harness";
import {
  provisionEnterpriseWorkspace,
  seedCompletedSiuExport,
  setActiveWorkspace,
} from "./_binary-fixtures";

const SUITE = "e2e/point7/new-027-siu-export.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

/** One recorded step of the product's own blob-download idiom. */
type BlobDownloadRecord = {
  phase: "created" | "clicked" | "revoked";
  url: string;
  blobSize: number | null;
  blobType: string | null;
  filename: string | null;
  /** First four bytes of the blob — the file's structural signature (NEW-080). */
  magic: number[] | null;
};

declare global {
  interface Window {
    __p7BlobDownloads?: BlobDownloadRecord[];
  }
}

/**
 * Instrument the blob-download primitives BEFORE the page has any script.
 *
 * `addInitScript` runs in every document this page loads, ahead of the
 * application bundle, so the wrappers are already installed by the time React
 * hydrates. The originals are always called: this observes the product, it
 * does not substitute for it. A wrapper that swallowed the click would prove
 * that the wrapper works.
 */
async function instrumentBlobDownloads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const records: BlobDownloadRecord[] = [];
    window.__p7BlobDownloads = records;

    const originalCreate = URL.createObjectURL.bind(URL);
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource): string => {
      const url = originalCreate(obj);
      const blob = obj instanceof Blob ? obj : null;
      const record: BlobDownloadRecord = {
        phase: "created",
        url,
        blobSize: blob ? blob.size : null,
        blobType: blob ? blob.type : null,
        filename: null,
        magic: null,
      };
      records.push(record);
      /**
       * PHASE 13 (NEW-080) — CAPTURE THE LEADING BYTES OF WHAT THE PRODUCT
       * ACTUALLY HANDED THE USER.
       *
       * The structural check (`PK\x03\x04`, a ZIP local file header) used to be
       * made against Playwright's `Response.body()`. That is not available for
       * this response: the route answers `content-disposition: attachment`, and
       * for an attachment Chromium routes the bytes into the download pipeline,
       * so the trace records `bodySize=503` on the wire and `content.size=0`
       * buffered. The assertion was reading an empty buffer and calling the
       * export empty.
       *
       * The Blob the product built from its own `fetch(...).blob()` is a
       * STRICTLY BETTER source for a content claim: it is the exact object the
       * user is handed, one step further down the path than the wire. Read
       * asynchronously so the wrapper never delays `createObjectURL`, and
       * recorded onto the same entry the size and type already live on.
       */
      if (blob) {
        void blob
          .slice(0, 4)
          .arrayBuffer()
          .then((buf) => {
            record.magic = Array.from(new Uint8Array(buf));
          })
          .catch(() => {
            record.magic = null;
          });
      }
      return url;
    };
    URL.revokeObjectURL = (url: string): void => {
      records.push({
        phase: "revoked",
        url,
        blobSize: null,
        blobType: null,
        filename: null,
        magic: null,
      });
      originalRevoke(url);
    };

    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedClick(this: HTMLAnchorElement) {
      records.push({
        phase: "clicked",
        url: this.href,
        blobSize: null,
        blobType: null,
        filename: this.download || null,
        magic: null,
      });
      return originalClick.call(this);
    };
  });
}

async function readBlobDownloads(page: Page): Promise<BlobDownloadRecord[]> {
  return page.evaluate(() => window.__p7BlobDownloads ?? []);
}

/**
 * Every `/v1/*` request this page made against the WEB origin.
 *
 * The single most important negative in this file. The defect was ONLY
 * observable here: a relative `/v1/…` fetch is a well-formed request to a
 * server that has no such route, and every other assertion in a naive spec
 * still passes while it happens.
 */
function webOriginApiRequests(urls: ReadonlyArray<string>): string[] {
  return urls.filter((url) => {
    if (!url.startsWith(WEB_BASE)) return false;
    try {
      return new URL(url).pathname.startsWith("/v1");
    } catch {
      return false;
    }
  });
}

/**
 * Bring an account to the state the journey starts from: an ENTERPRISE
 * organization workspace (the SIU panel exists only on the enterprise case
 * surface), a real Case created through the product, and one completed export
 * whose bytes are really in the disposable object store.
 */
async function seedJourney(
  page: Page,
  label: string,
): Promise<{
  ownerUserId: string;
  workspaceId: string;
  caseId: string;
  exportId: string;
  artifactSizeBytes: number;
}> {
  const owner = await createAccount({ label, plan: "FREE" });
  const ws = await provisionEnterpriseWorkspace({ ownerUserId: owner.userId });
  await setActiveWorkspace(owner.userId, ws.workspaceId);
  await instrumentBlobDownloads(page);
  await login(page, owner);

  const created = await directApiCall(page, {
    method: "POST",
    path: "/v1/cases",
    body: { name: `p7 NEW-027 ${label}`, teamId: ws.workspaceId },
  });
  expect(created.status, created.body).toBe(201);
  const caseId = (JSON.parse(created.body) as { id: string }).id;

  const fixture = await seedCompletedSiuExport({
    caseId,
    teamId: ws.workspaceId,
    generatedByUserId: owner.userId,
  });

  return {
    ownerUserId: owner.userId,
    workspaceId: ws.workspaceId,
    caseId,
    exportId: fixture.exportId,
    artifactSizeBytes: fixture.artifactSizeBytes,
  };
}

/** Open the case and select the tab that hosts `SiuPanel`. */
async function openSiuPanel(page: Page, caseId: string): Promise<void> {
  await page.goto(`${WEB_BASE}/cases/${caseId}`, {
    waitUntil: "domcontentloaded",
  });
  const siuTab = page.locator('[data-tab-id="siu"]');
  await expect(siuTab).toBeVisible({ timeout: 30_000 });
  await siuTab.click();
  await expect(page.locator('[data-testid="siu-panel"]')).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("NEW-027 — SIU export download", () => {
  test("p7.new027.download.streams_from_the_api_origin", async ({ page }) => {
    // Recording starts before the FIRST navigation, including the sign-in
    // that precedes the journey proper: "no `/v1` request against the WEB
    // origin" is a claim about everything this browser did, and a ledger that
    // opened after login would have missed a bootstrap request that made it.
    const log = recordRequests(page);
    const journey = await seedJourney(page, "n27-ok");

    await openSiuPanel(page, journey.caseId);

    // The history table renders only for a profile that loaded AND an export
    // whose status makes it retrievable — the same two conditions the route
    // enforces. Its presence is what makes the click below meaningful.
    const history = page.locator('[data-testid="siu-export-history"]');
    await expect(history).toBeVisible({ timeout: 30_000 });
    const downloadControl = page.locator(
      '[data-testid="siu-export-download-link"]',
    );
    await expect(downloadControl).toHaveCount(1);
    await expect(downloadControl).toHaveText("Download");

    const downloadResponse = page.waitForResponse(
      (r) =>
        r.url().startsWith(`${API_BASE}/v1/cases/${journey.caseId}/siu-exports/`) &&
        r.url().endsWith("/download"),
      { timeout: 30_000 },
    );
    await downloadControl.click();
    const response = await downloadResponse;

    // (5) The request went to the API origin. Read from the REQUEST the
    // browser emitted, not from the source: the defect was precisely that the
    // source's intent and the browser's behaviour disagreed.
    const request = response.request();
    expect(request.url().startsWith(API_BASE)).toBe(true);
    expect(request.url().startsWith(WEB_BASE)).toBe(false);
    expect(request.url()).toBe(
      `${API_BASE}/v1/cases/${journey.caseId}/siu-exports/${journey.exportId}/download`,
    );

    // (6) The session was carried. A 200 is the only honest proof: the route
    // sits behind `requireAuth` and answers 401 without a credential, so a
    // header inspection could pass while the cookie was dropped in transit.
    expect(response.status()).toBe(200);

    /**
     * (7)+(9) Real archive bytes, with the content type and disposition the
     * route declares.
     *
     * PHASE 13 (NEW-080) — THE CONTENT CLAIM MOVED ONE STEP DOWNSTREAM, TO THE
     * BLOB. IT DID NOT MOVE OFF THE BYTES.
     *
     * `await response.body()` cannot serve this response. The route answers
     * `content-disposition: attachment`, and Chromium routes an attachment into
     * the download pipeline rather than the buffered-response one — the trace
     * shows `bodySize=503` transferred on the wire and `content.size=0`
     * retained. So `body.byteLength` was 0 for a response that had in fact
     * delivered a complete archive, and the spec was reporting the product empty.
     *
     * The wire-level facts that ARE reliable here are asserted from the response
     * (status above, content type and disposition below, and that bytes were
     * transferred at all). The CONTENT — exact length and the ZIP signature — is
     * asserted against the Blob the product built from its own
     * `fetch(...).blob()`, which is the object actually handed to the user. That
     * is a stronger statement than the wire buffer would have made, not a
     * weaker one: it proves the bytes survived the client, not merely that they
     * arrived.
     */
    const contentType = (response.headers()["content-type"] ?? "").toLowerCase();
    expect(contentType).toContain("application/zip");
    expect(
      (response.headers()["content-disposition"] ?? "").toLowerCase(),
      "an export must be offered as a named attachment",
    ).toContain("attachment");
    /**
     * Bytes really crossed the wire. Read from the request's transfer sizes
     * rather than from a `Content-Length` header, because this route STREAMS the
     * archive and therefore declares no length — asserting a header the product
     * does not send would be inventing a requirement, and asserting nothing
     * would let a 200-with-no-body pass.
     */
    const transferred = (await response.request().sizes()).responseBodySize;
    expect(
      transferred,
      "the download response must actually carry the archive's bytes",
    ).toBeGreaterThanOrEqual(journey.artifactSizeBytes);

    // (8) The page handed the bytes to the user. The product's idiom is a
    // Blob + object URL + synthesized anchor, so that is what is observed —
    // see the file docblock for why the `download` event is not the signal.
    await expect
      .poll(async () => (await readBlobDownloads(page)).length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    const records = await readBlobDownloads(page);
    const created = records.find((r) => r.phase === "created");
    expect(created, "the product created no object URL for the bytes").toBeTruthy();
    expect(created!.blobSize).toBe(journey.artifactSizeBytes);
    expect(created!.blobSize!).toBeGreaterThan(64);
    expect((created!.blobType ?? "").toLowerCase()).toContain("application/zip");
    /**
     * `PK\x03\x04` — a ZIP local file header, read from the blob the product
     * handed the user (NEW-080). A 200 carrying an HTML or JSON error document
     * would satisfy every length and type check above and fail here, which is
     * the whole reason this assertion exists.
     */
    await expect
      .poll(async () => (await readBlobDownloads(page)).find((r) => r.phase === "created")?.magic,
        {
          message:
            "the exported blob's leading bytes must be readable — an export " +
            "with no structural signature is not an archive",
          timeout: 10_000,
        })
      .toEqual([0x50, 0x4b, 0x03, 0x04]);

    // (9) The filename the user is offered.
    const clicked = records.find(
      (r) => r.phase === "clicked" && r.url.startsWith("blob:"),
    );
    expect(clicked, "no anchor was clicked for the blob").toBeTruthy();
    expect(clicked!.filename).toBe(
      `siu-export-${journey.caseId}-${journey.exportId}.zip`,
    );

    // The object URL is released — a page that leaked one per download would
    // hold the whole archive in memory for the life of the tab.
    expect(records.some((r) => r.phase === "revoked")).toBe(true);

    // The panel stayed in its success state: no bounded failure copy.
    await expect(page.locator('[data-testid="siu-error"]')).toHaveCount(0);

    // The download is recorded durably — the route marks the row
    // `downloaded` and stamps the timestamp, which is the only evidence that
    // the SERVER, and not a cache, served these bytes.
    await expect
      .poll(
        async () =>
          (
            await sql<{ export_status: string; downloaded_at_utc: string | null }>(
              `SELECT export_status, downloaded_at_utc FROM case_siu_exports WHERE id = $1`,
              [journey.exportId],
            )
          )[0]?.export_status,
        { timeout: 10_000 },
      )
      .toBe("downloaded");
    const row = (
      await sql<{ downloaded_at_utc: string | null }>(
        `SELECT downloaded_at_utc FROM case_siu_exports WHERE id = $1`,
        [journey.exportId],
      )
    )[0]!;
    expect(row.downloaded_at_utc).not.toBeNull();

    // (12) The negative the defect lived in.
    expect(webOriginApiRequests(log.urls())).toEqual([]);
    proven("p7.new027.download.streams_from_the_api_origin");
  });

  test("p7.new027.download.signed_out_request_refused", async ({ browser }) => {
    // A separate context so the refusal is about the ABSENCE of a session
    // rather than about a session that was torn down mid-journey.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const owner = await createAccount({ label: "n27-anon", plan: "FREE" });
      const ws = await provisionEnterpriseWorkspace({ ownerUserId: owner.userId });
      const seededCase = (
        await sql<{ id: string }>(
          `INSERT INTO cases (name, owner_user_id, team_id, updated_at)
           VALUES ($1, $2, $3, NOW()) RETURNING id`,
          ["p7 NEW-027 anon", owner.userId, ws.workspaceId],
        )
      )[0]!;
      const fixture = await seedCompletedSiuExport({
        caseId: seededCase.id,
        teamId: ws.workspaceId,
        generatedByUserId: owner.userId,
      });

      // Issued from a real page on the WEB origin so the request carries the
      // same origin a signed-out visitor's browser would send — it simply has
      // no session cookie to attach. The outbound guard is installed first:
      // a fresh context has none, and the sign-in page embeds genuine
      // third-party widgets this run must not contact.
      await blockThirdParties(page);
      await page.goto(`${WEB_BASE}/login`, { waitUntil: "domcontentloaded" });
      const res = await directApiCall(page, {
        method: "GET",
        path: `/v1/cases/${seededCase.id}/siu-exports/${fixture.exportId}/download`,
      });
      expect(res.status).toBe(401);
      // Nothing about the export leaked into the refusal.
      expect(res.body).not.toContain(fixture.storageKey);
      expect(res.body).not.toContain(fixture.artifactSha256);

      // The refusal did not consume the export.
      const after = (
        await sql<{ export_status: string; downloaded_at_utc: string | null }>(
          `SELECT export_status, downloaded_at_utc FROM case_siu_exports WHERE id = $1`,
          [fixture.exportId],
        )
      )[0]!;
      expect(after.export_status).toBe("generated");
      expect(after.downloaded_at_utc).toBeNull();
      proven("p7.new027.download.signed_out_request_refused");
    } finally {
      await context.close();
    }
  });

  test("p7.new027.download.suspended_member_refused", async ({ page }) => {
    // An authenticated user who is a member of the workspace but whose
    // membership is not ACTIVE: authenticated, related to the tenant, and
    // still without access. The distinct arm from the cross-tenant case
    // below, and a different code path in `requireCaseActor`.
    const owner = await createAccount({ label: "n27-susp-owner", plan: "FREE" });
    const suspended = await createAccount({ label: "n27-susp", plan: "FREE" });
    const ws = await provisionEnterpriseWorkspace({
      ownerUserId: owner.userId,
      memberUserId: suspended.userId,
      memberStatus: "SUSPENDED",
    });
    const seededCase = (
      await sql<{ id: string }>(
        `INSERT INTO cases (name, owner_user_id, team_id, updated_at)
         VALUES ($1, $2, $3, NOW()) RETURNING id`,
        ["p7 NEW-027 suspended", owner.userId, ws.workspaceId],
      )
    )[0]!;
    const fixture = await seedCompletedSiuExport({
      caseId: seededCase.id,
      teamId: ws.workspaceId,
      generatedByUserId: owner.userId,
    });

    await login(page, suspended);
    const res = await directApiCall(page, {
      method: "GET",
      path: `/v1/cases/${seededCase.id}/siu-exports/${fixture.exportId}/download`,
    });
    // `requireCaseActor` refuses a non-ACTIVE member with 403 `member_inactive`
    // (services/api/src/routes/siu.routes.ts:148). The assertion allows 404 as
    // well because the session gate ahead of it may refuse a suspended
    // member's organization context first — both are the SERVER refusing, and
    // pinning the exact one would make this spec fail on a correct hardening
    // of the earlier gate. What is pinned absolutely: it is not a 200, and no
    // archive byte, storage pointer or hash reached the caller.
    expect([403, 404]).toContain(res.status);
    expect(res.body).not.toContain(fixture.storageKey);
    expect(res.body).not.toContain(fixture.artifactSha256);

    const after = (
      await sql<{ export_status: string }>(
        `SELECT export_status FROM case_siu_exports WHERE id = $1`,
        [fixture.exportId],
      )
    )[0]!;
    expect(after.export_status).toBe("generated");
    proven("p7.new027.download.suspended_member_refused");
  });

  test("p7.new027.download.cross_tenant_refusal_is_non_disclosing", async ({
    page,
  }) => {
    const owner = await createAccount({ label: "n27-victim", plan: "FREE" });
    const victimWs = await provisionEnterpriseWorkspace({
      ownerUserId: owner.userId,
    });
    const victimCase = (
      await sql<{ id: string }>(
        `INSERT INTO cases (name, owner_user_id, team_id, updated_at)
         VALUES ($1, $2, $3, NOW()) RETURNING id`,
        ["p7 NEW-027 victim", owner.userId, victimWs.workspaceId],
      )
    )[0]!;
    const fixture = await seedCompletedSiuExport({
      caseId: victimCase.id,
      teamId: victimWs.workspaceId,
      generatedByUserId: owner.userId,
    });

    // A fully legitimate operator of ANOTHER enterprise tenant.
    const outsider = await createAccount({ label: "n27-outsider", plan: "FREE" });
    const outsiderWs = await provisionEnterpriseWorkspace({
      ownerUserId: outsider.userId,
    });
    await setActiveWorkspace(outsider.userId, outsiderWs.workspaceId);
    await login(page, outsider);

    const forbidden = await directApiCall(page, {
      method: "GET",
      path: `/v1/cases/${victimCase.id}/siu-exports/${fixture.exportId}/download`,
    });

    // The control: an id of the same shape that exists nowhere.
    const absentCaseId = "00000000-0000-4000-8000-0000000000aa";
    const absentExportId = "00000000-0000-4000-8000-0000000000bb";
    const absent = await directApiCall(page, {
      method: "GET",
      path: `/v1/cases/${absentCaseId}/siu-exports/${absentExportId}/download`,
    });

    // Non-disclosure means the two answers are INDISTINGUISHABLE. Asserting
    // only "403 or 404" would accept a 403 for the real case and a 404 for
    // the imaginary one — which is a working existence oracle.
    expect(forbidden.status).toBe(absent.status);
    expect(forbidden.status).toBe(404);
    expect(forbidden.body).toBe(absent.body);
    expect(forbidden.body).not.toContain(fixture.storageKey);
    expect(forbidden.body).not.toContain(fixture.artifactSha256);
    expect(forbidden.body).not.toContain(victimWs.workspaceId);

    // Nothing was served, so nothing was consumed.
    const after = (
      await sql<{ export_status: string; downloaded_at_utc: string | null }>(
        `SELECT export_status, downloaded_at_utc FROM case_siu_exports WHERE id = $1`,
        [fixture.exportId],
      )
    )[0]!;
    expect(after.export_status).toBe("generated");
    expect(after.downloaded_at_utc).toBeNull();
    proven("p7.new027.download.cross_tenant_refusal_is_non_disclosing");
  });
});
