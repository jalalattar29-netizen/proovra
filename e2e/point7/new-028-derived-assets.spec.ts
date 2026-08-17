/**
 * PHASE 13 §C — NEW-028: derived-asset rendering, proven in a browser.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * `GET /v1/evidence/:evidenceId/derived-assets` projects `bytesUrl` as a
 * RELATIVE path (services/api/src/routes/media-intelligence.routes.ts:1278),
 * and `useDerivedAssets` handed it verbatim to two `<img src>` elements. The
 * API is a different origin, so every thumbnail resolved against the Next
 * origin and 404'd.
 *
 * What made this defect durable is that the panel HANDLED it. Each image has
 * an `onError` that swaps in a "… unavailable" placeholder
 * (apps/web/components/media-intelligence/MediaIntelligencePanel.tsx:290,370),
 * so a broken URL and a genuinely missing derived asset produced the identical
 * screen. Operators read it as "no previews were generated". Every server-side
 * test of the bytes route passed, because the route was never wrong — nothing
 * ever called it.
 *
 * WHY "THE REQUEST HAPPENED" IS NOT THE ASSERTION
 * ---------------------------------------------------------------------------
 * A 200 that fails to decode still renders the placeholder, and a spec that
 * stopped at the network event would pass against a route that served an HTML
 * error page with an image content type, or against bytes truncated in
 * transit. The load-bearing assertion is `naturalWidth > 0` on the element the
 * user is looking at: the browser parsed the response INTO an image. The
 * fixture's PNG is generated from the format specification with a real CRC, so
 * that assertion cannot be satisfied by anything but decodable image bytes.
 *
 * ON "EXPIRED ACCESS"
 * ---------------------------------------------------------------------------
 * This route has no expiry concept of its own. It is a server-side proxy: no
 * signed URL, no pre-signed expiry, no time-boxed grant — the client is given
 * a workspace-internal path and the API resolves storage itself
 * (…media-intelligence.routes.ts:1363-1400). There is therefore nothing that
 * "expires" for the resource. The nearest REAL denial the product implements
 * is session invalidation, which `requireAuth` consults on every request via
 * the revocation registry, and that is what is proven below — stated plainly
 * rather than dressed up as an expiring grant.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page, type Response } from "@playwright/test";

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
  revokeAllSessionsForUser,
  seedCompletedDerivedAsset,
  setActiveWorkspace,
  type DerivedAssetFixture,
} from "./_binary-fixtures";

const SUITE = "e2e/point7/new-028-derived-assets.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

/**
 * Patterns that would mean a storage credential escaped the server.
 *
 * The bytes route exists so the client NEVER holds one. Anything matching
 * these in a projected URL, a console line, or the API log is the failure
 * this route was built to prevent — a URL a screenshot or a log shipper could
 * carry out of the tenant.
 */
const SIGNED_URL_PATTERNS = [
  /X-Amz-Signature/i,
  /X-Amz-Credential/i,
  /X-Amz-Security-Token/i,
  /AWSAccessKeyId=/i,
  /[?&]Signature=/i,
  /[?&]Expires=\d{9,}/i,
];

type Journey = {
  userId: string;
  workspaceId: string;
  evidenceId: string;
  asset: DerivedAssetFixture;
  bytesPath: string;
};

/**
 * Seed the state the journey starts from.
 *
 * The workspace is an ENTERPRISE organization because the Technical Appendix
 * reaches `MediaIntelligencePanel` only through the enterprise projection;
 * the evidence record is created through the product's own create route so
 * every column the page reads is stamped the way production stamps it; only
 * the derived asset — the worker's output, which no browser action produces —
 * is seeded.
 */
async function seedJourney(page: Page, label: string): Promise<Journey> {
  const account = await createAccount({ label, plan: "FREE" });
  const ws = await provisionEnterpriseWorkspace({ ownerUserId: account.userId });
  await setActiveWorkspace(account.userId, ws.workspaceId);
  await login(page, account);

  const created = await directApiCall(page, {
    method: "POST",
    path: "/v1/evidence",
    body: {
      title: `p7 NEW-028 ${label}`,
      type: "PHOTO",
      teamId: ws.workspaceId,
      mimeType: "image/png",
    },
  });
  expect(created.status, created.body).toBe(201);
  const evidenceId = (JSON.parse(created.body) as { id: string }).id;

  const asset = await seedCompletedDerivedAsset({
    evidenceId,
    teamId: ws.workspaceId,
  });

  return {
    userId: account.userId,
    workspaceId: ws.workspaceId,
    evidenceId,
    asset,
    bytesPath:
      `/v1/evidence/${evidenceId}/derived-assets/${asset.derivedAssetId}/bytes` +
      `?teamId=${ws.workspaceId}`,
  };
}

/** Open the evidence record and select the tab hosting the panel. */
async function openTechnicalAppendix(page: Page, evidenceId: string): Promise<void> {
  await page.goto(`${WEB_BASE}/evidence/${evidenceId}`, {
    waitUntil: "domcontentloaded",
  });
  const tab = page.locator('[data-evidence-tab="technical"]');
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click();
  await expect(
    page.locator('section[aria-label="Media intelligence"]'),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("NEW-028 — derived-asset rendering", () => {
  test("p7.new028.thumbnail.renders_from_the_api_origin", async ({ page }) => {
    const log = recordRequests(page);
    const consoleLines: string[] = [];
    page.on("console", (m) => consoleLines.push(m.text()));
    const byteResponses: Response[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/derived-assets/") && r.url().includes("/bytes")) {
        byteResponses.push(r);
      }
    });

    const journey = await seedJourney(page, "n28-ok");

    // (9) The canonical consumer facts already classify this route as
    // product-connected. Asserted here, against the generated map rather than
    // against a restatement of it, so a run that proves the bytes flow and a
    // map that says the route is orphaned cannot both stand. Read-only.
    const map = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "docs/architecture/current-runtime-capability-map.json"),
        "utf8",
      ),
    ) as {
      routes: Array<{ routeId: string; primaryDisposition: string }>;
    };
    const mapped = map.routes.find(
      (r) =>
        r.routeId ===
        "GET /v1/evidence/:evidenceId/derived-assets/:assetId/bytes",
    );
    expect(mapped, "the bytes route is absent from the capability map").toBeTruthy();
    expect(mapped!.primaryDisposition).toBe("PRODUCT_CONSUMED");

    // (8, first half) The URL the server hands the client carries no
    // credential — checked on the PROJECTION, before any browser touches it.
    const listed = await directApiCall(page, {
      method: "GET",
      path: `/v1/evidence/${journey.evidenceId}/derived-assets?teamId=${journey.workspaceId}`,
    });
    expect(listed.status).toBe(200);
    const projected = (
      JSON.parse(listed.body) as { assets: Array<{ id: string; bytesUrl: string | null }> }
    ).assets.find((a) => a.id === journey.asset.derivedAssetId);
    expect(projected?.bytesUrl, "the completed asset was projected without a bytesUrl").toBeTruthy();
    for (const pattern of SIGNED_URL_PATTERNS) {
      expect(projected!.bytesUrl!).not.toMatch(pattern);
    }
    // Storage internals never reach the client either.
    expect(projected!.bytesUrl!).not.toContain(journey.asset.storageKey);
    // The projection stays RELATIVE — the origin fix lives in the client hook,
    // not in the wire format. If the server ever starts sending an absolute
    // URL this assertion is the thing that says the fix moved.
    expect(projected!.bytesUrl!.startsWith("/v1/")).toBe(true);

    await openTechnicalAppendix(page, journey.evidenceId);

    // (1)+(2) The element the user sees, and the origin it points at. The
    // selector is anchored on the API origin on purpose: if the hook
    // regressed to the relative URL there would be no matching element and
    // the failure would name the origin rather than a missing image.
    const expectedSrcPrefix = `${API_BASE}/v1/evidence/${journey.evidenceId}/derived-assets/${journey.asset.derivedAssetId}/bytes`;
    const apiOriginImages = page.locator(`img[src^="${expectedSrcPrefix}"]`);
    // Counted on the UNFILTERED locator: `.first()` can only ever be 0 or 1,
    // so counting it would assert nothing about there being exactly one
    // thumbnail for the one seeded asset.
    await expect(apiOriginImages).toHaveCount(1, { timeout: 30_000 });
    const thumbnail = apiOriginImages.first();
    // The strip sits far down the appendix and the thumbnail is lazy; bring
    // it into view so the browser is asked for the bytes for the same reason
    // a reader would ask for them.
    await page
      .locator('[aria-label="Open Image preview preview"]')
      .first()
      .scrollIntoViewIfNeeded();

    // The bytes route is authenticated and cross-origin, so the element must
    // opt into credentialed CORS or the browser sends no cookie and the image
    // 401s. This is half of the fix and invisible in a network assertion.
    await expect(thumbnail).toHaveAttribute("crossorigin", "use-credentials");

    // (4) It RENDERED. `naturalWidth` is non-zero only after the browser
    // decoded the response into an image of known dimensions.
    await expect
      .poll(
        async () => thumbnail.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 30_000 },
      )
      .toBe(journey.asset.widthPx);
    expect(
      await thumbnail.evaluate((el) => (el as HTMLImageElement).naturalHeight),
    ).toBe(journey.asset.heightPx);
    expect(await thumbnail.evaluate((el) => (el as HTMLImageElement).complete)).toBe(
      true,
    );

    // The panel is in its LOADED state, not its bounded failure state — the
    // exact screen the defect used to produce.
    await expect(page.getByText("Image preview unavailable")).toHaveCount(0);

    // (3) The response itself: served, and served as an image.
    const byteResponse = byteResponses.find((r) =>
      r.url().startsWith(expectedSrcPrefix),
    );
    expect(byteResponse, "no response was observed for the bytes URL").toBeTruthy();
    expect(byteResponse!.status()).toBe(200);
    expect(
      (byteResponse!.headers()["content-type"] ?? "").toLowerCase(),
    ).toContain("image/png");
    expect(byteResponse!.url().startsWith(WEB_BASE)).toBe(false);

    // The second `<img>` the fix touched: the preview modal. Same route, same
    // credentialed CORS, opened the way an operator opens it.
    await page.locator('[aria-label="Open Image preview preview"]').first().click();
    const modalImage = page
      .locator('[role="dialog"][aria-label="Derived preview"] img')
      .first();
    await expect(modalImage).toHaveAttribute("crossorigin", "use-credentials");
    await expect(modalImage).toHaveAttribute("src", new RegExp(`^${API_BASE}/v1/`));
    await expect
      .poll(
        async () => modalImage.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 30_000 },
      )
      .toBe(journey.asset.widthPx);
    await expect(page.getByText("Preview unavailable")).toHaveCount(0);

    // (5) No WEB-origin request for the asset — and, more broadly, no
    // WEB-origin `/v1` request at all during the journey. This is the
    // assertion the defect could not have survived.
    const webOriginApi = log.urls().filter((url) => {
      if (!url.startsWith(WEB_BASE)) return false;
      try {
        return new URL(url).pathname.startsWith("/v1");
      } catch {
        return false;
      }
    });
    expect(webOriginApi).toEqual([]);

    // (8, second half) Nothing credential-shaped, and no storage internal,
    // reached the browser console or the API's log during this journey.
    const consoleText = consoleLines.join("\n");
    for (const pattern of SIGNED_URL_PATTERNS) {
      expect(consoleText).not.toMatch(pattern);
    }
    expect(consoleText).not.toContain(journey.asset.storageKey);

    const apiLogPath = resolve(process.cwd(), ".p7tmp/api.log");
    if (existsSync(apiLogPath)) {
      const apiLog = readFileSync(apiLogPath, "utf8");
      for (const pattern of SIGNED_URL_PATTERNS) {
        expect(apiLog).not.toMatch(pattern);
      }
      // The storage key is this journey's own secret; if it is in the log,
      // the leak is this route's.
      expect(apiLog).not.toContain(journey.asset.storageKey);
      expect(apiLog).not.toContain(journey.asset.derivedSha256);
    }

    proven("p7.new028.thumbnail.renders_from_the_api_origin");
  });

  test("p7.new028.bytes.unauthorized_reads_refused", async ({ page, browser }) => {
    const journey = await seedJourney(page, "n28-victim");

    // (6a) Signed out. A fresh context so the absence of a session is the
    // only thing that differs, issued from the WEB origin so the request
    // looks exactly like the one the thumbnail makes.
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    try {
      await blockThirdParties(anonPage);
      await anonPage.goto(`${WEB_BASE}/login`, { waitUntil: "domcontentloaded" });
      const anon = await directApiCall(anonPage, {
        method: "GET",
        path: journey.bytesPath,
      });
      expect(anon.status).toBe(401);
      expect(anon.body).not.toContain(journey.asset.storageKey);
    } finally {
      await anonContext.close();
    }

    // (6b) A legitimate operator of a DIFFERENT tenant, in their own browser.
    const outsiderContext = await browser.newContext();
    const outsiderPage = await outsiderContext.newPage();
    try {
      const outsider = await createAccount({ label: "n28-outsider", plan: "FREE" });
      const outsiderWs = await provisionEnterpriseWorkspace({
        ownerUserId: outsider.userId,
      });
      await setActiveWorkspace(outsider.userId, outsiderWs.workspaceId);
      await login(outsiderPage, outsider);

      // Asking with the victim's workspace id — refused at the workspace gate.
      const withVictimTeam = await directApiCall(outsiderPage, {
        method: "GET",
        path: journey.bytesPath,
      });
      expect(withVictimTeam.status).toBe(404);

      // Asking with their OWN workspace id — refused because the evidence
      // does not belong to it. Both answers are the same shape, so neither
      // tells the caller which of the two facts was the reason.
      const withOwnTeam = await directApiCall(outsiderPage, {
        method: "GET",
        path:
          `/v1/evidence/${journey.evidenceId}/derived-assets/` +
          `${journey.asset.derivedAssetId}/bytes?teamId=${outsiderWs.workspaceId}`,
      });
      expect(withOwnTeam.status).toBe(404);
      expect(withOwnTeam.body).toBe(withVictimTeam.body);
      expect(withVictimTeam.body).not.toContain(journey.asset.storageKey);
      expect(withVictimTeam.body).not.toContain(journey.asset.derivedSha256);

      // The SURFACE stays bounded: the outsider opening the record gets a
      // refusal in product language, not a raw payload, and no derived
      // preview strip appears.
      await outsiderPage.goto(`${WEB_BASE}/evidence/${journey.evidenceId}`, {
        waitUntil: "domcontentloaded",
      });
      const bodyText = (await outsiderPage.locator("body").innerText()).toLowerCase();
      expect(bodyText).not.toContain(journey.asset.storageKey.toLowerCase());
      expect(bodyText).not.toContain('{"error"');
      expect(bodyText).not.toContain("not_found");
      await expect(
        outsiderPage.locator(`img[src*="${journey.asset.derivedAssetId}"]`),
      ).toHaveCount(0);
    } finally {
      await outsiderContext.close();
    }

    proven("p7.new028.bytes.unauthorized_reads_refused");
  });

  test("p7.new028.bytes.invalidated_session_refused", async ({ page }) => {
    // (7) There is no expiring grant to test — see the file docblock. What
    // exists is session invalidation, and this proves the route honours it
    // for a browser that is still holding a cookie that used to work.
    const journey = await seedJourney(page, "n28-revoked");

    const before = await directApiCall(page, {
      method: "GET",
      path: journey.bytesPath,
    });
    expect(
      before.status,
      "the bytes must be readable BEFORE revocation, or the refusal after it proves nothing",
    ).toBe(200);

    await revokeAllSessionsForUser(journey.userId);

    const after = await directApiCall(page, {
      method: "GET",
      path: journey.bytesPath,
    });
    expect(after.status).toBe(401);
    expect(after.body).not.toContain(journey.asset.storageKey);

    // The refusal belongs to the SESSION, not to the resource. A route that
    // reacted to a revoked caller by tearing down the asset would also
    // produce a 401 here, and the difference matters: one is authentication
    // working, the other is data loss.
    const stillThere = (
      await sql<{ status: string; storage_key: string | null }>(
        `SELECT "status", "storage_key" FROM evidence_part_derived_assets WHERE id = $1`,
        [journey.asset.derivedAssetId],
      )
    )[0]!;
    expect(stillThere.status).toBe("COMPLETED");
    expect(stillThere.storage_key).toBe(journey.asset.storageKey);

    proven("p7.new028.bytes.invalidated_session_refused");
  });
});
