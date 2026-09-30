/**
 * UC-1 — Direct Web Capture browser acceptance (REAL Chrome + REAL Edge).
 *
 * For each deterministic fixture page (static, long/full-page, SPA, mutating),
 * this drives the EXTENSION ITSELF, through surfaces Chrome actually delivers:
 *   1. SIGN-IN — the popup's own "Sign in" button. The background runs the
 *      extension's real `chrome.identity.launchWebAuthFlow` against the real
 *      /v1/oauth/extension/authorize (the browser carries the seeded user's
 *      proovra_session cookie, as a signed-in web session would), receives the
 *      302 to its chromiumapp.org redirect and exchanges the PKCE-bound code at
 *      /v1/oauth/extension/token. Nothing is injected into extension storage.
 *   2. CAPTURE — the popup lists the workspace from the real platform context
 *      (UC-EXT-001), the case picker lists the seeded case (UC-EXT-010), and the
 *      popup's Capture button starts the capture in the background, which owns
 *      its status (UC-EXT-005). The popup runs in its own window, pointed at the
 *      fixture tab with `?targetTabId=`.
 *   3. TRACE — the sealed record is followed through Library -> Detail -> Case ->
 *      Search -> Report -> Verification Package -> public Verify with the user's
 *      WEB session (the extension token is capture-scoped and may not read them).
 *
 * WHY THE TEST BUILD (UC-TQ-008): Chrome grants `activeTab` only on a real
 * toolbar click, which automation cannot perform, and `runtime.sendMessage` from
 * the service worker to itself is never delivered. The E2E build
 * (`build.mjs --e2e`, dist-e2e/) therefore carries `<all_urls>` host access and
 * a fixed key (known id, so its OAuth redirect is allow-listed before the API
 * boots). The release manifest never carries either (scripts/manifest-plan.mjs).
 *
 * WHY CDP LOADING (UC-TQ-002): branded Chrome (>= 137) ignores --load-extension.
 * Both projects launch their REAL channel (`chrome` / `msedge`) and load the
 * unpacked extension with `Extensions.loadUnpacked` over the browser's own CDP
 * pipe (--enable-unsafe-extension-debugging). Each test asserts the launched
 * browser's identity (Edge must say `Edg/`, Chrome must not) and prints it.
 *
 * Every step is bounded by its own stage timeout and prints PASS/FAIL.
 *
 * REQUIRED ENV (set by scripts/uc1-acceptance-windows.mjs):
 *   PROOVRA_API_ORIGIN          the running API origin (http://localhost:4000)
 *   PROOVRA_E2E_SESSION_BEARER  the seeded user's WEB session (disposable DB only)
 *   PROOVRA_E2E_TEAM_ID         the seeded paid workspace
 *   PROOVRA_E2E_CASE_ID         the seeded open case in that workspace
 *   PROOVRA_E2E_EXTENSION_ID    the E2E build's fixed id
 *   EXTENSION_DIST              absolute path to apps/extension/dist-e2e
 *   FIXTURE_ORIGIN              the fixture server origin (http://127.0.0.1:4599)
 */
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXTENSION_DIST ?? join(HERE, "..", "dist-e2e");
const API = process.env.PROOVRA_API_ORIGIN ?? "http://localhost:4000";
const SESSION_BEARER = process.env.PROOVRA_E2E_SESSION_BEARER ?? "";
const TEAM = process.env.PROOVRA_E2E_TEAM_ID ?? "";
const CASE_ID = process.env.PROOVRA_E2E_CASE_ID ?? "";
const EXTENSION_ID = process.env.PROOVRA_E2E_EXTENSION_ID ?? "";
const FIXTURES = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:4599";

const ACQ_MODE = "DIRECT_WEB_CAPTURE_EXTENSION";

// BOUNDED, STAGE-SPECIFIC timeouts — never one opaque multi-minute wait.
const STAGE_TIMEOUT = {
  LAUNCH: 60_000,
  AUTH: 60_000,
  POPUP: 30_000,
  CAPTURE: 150_000, // paced full-page tiles + upload + server digest verify + seal
  LIBRARY: 20_000,
  DETAIL: 20_000,
  CASE: 30_000,
  SEARCH: 30_000,
  REPORT: 150_000, // worker-generated, async
  PACKAGE: 150_000, // worker-generated, async
  PUBLIC_VERIFY: 30_000,
} as const;

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Run one stage with a bounded timeout, printing a PASS/FAIL line. */
async function stage<T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let timer: NodeJS.Timeout;
  const bound = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${name} TIMEOUT after ${secs(timeoutMs)}`)), timeoutMs);
  });
  try {
    const out = await Promise.race([Promise.resolve().then(fn), bound]);
    clearTimeout(timer!);
    // eslint-disable-next-line no-console
    console.log(`  ${name.padEnd(18)} PASS   (${secs(Date.now() - start)})`);
    return out as T;
  } catch (err) {
    clearTimeout(timer!);
    // eslint-disable-next-line no-console
    console.log(`  ${name.padEnd(18)} FAIL   (${secs(Date.now() - start)})   ${(err as Error).message}`);
    throw err;
  }
}

// --- API helpers ------------------------------------------------------------

async function apiGet<T = any>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function apiGetStatus(path: string, token: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON (e.g. a 404 while pending) */
  }
  return { status: res.status, json };
}

async function apiPost<T = any>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// The public verify surface is UNAUTHENTICATED: a third party opens exactly
// this URL, with no Authorization header. ET-PKG-07 — what they hold is a
// share token (see `mintVerifyLink`); the evidence id opens nothing.
async function apiPublicGet(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

/**
 * A public verification link for the captured record (ET-PKG-07). A record is
 * private by default and the route that creates a link needs a step-up proof
 * this harness does not hold, so the link is minted by the API package's
 * local-only script against the disposable database (DATABASE_URL, which the
 * script refuses unless its host is local).
 */
function mintVerifyLink(evidenceId: string): string {
  const apiDir = join(HERE, "..", "..", "..", "services", "api");
  const run = spawnSync(
    process.execPath,
    [join(apiDir, "scripts", "e2e-verify-link.mjs"), `--evidence=${evidenceId}`],
    { cwd: apiDir, encoding: "utf8" },
  );
  if (run.status !== 0 || !/^pvs_[A-Za-z0-9_-]{43}$/.test(run.stdout.trim())) {
    throw new Error(`mintVerifyLink failed (exit ${run.status}): ${(run.stderr || run.stdout).trim()}`);
  }
  return run.stdout.trim();
}

/**
 * Poll the artifact-status surface until `pick(status)` is available, printing
 * bounded progress (stage, evidence id, endpoint, elapsed, last HTTP status,
 * last state) on every tick — no secrets. Throws with a named diagnostic on
 * timeout so the exact stuck artifact + its last state is visible.
 */
async function pollArtifact(
  name: string,
  evidenceId: string,
  token: string,
  timeoutMs: number,
  pick: (s: any) => { available?: boolean; state?: string },
): Promise<void> {
  const endpoint = `/v1/evidence/${evidenceId}/artifacts/status`;
  const start = Date.now();
  let last = { status: 0, state: "?" };
  while (Date.now() - start < timeoutMs) {
    const { status, json } = await apiGetStatus(endpoint, token);
    const projected = json ? pick(json) : {};
    const stateFromOutputs =
      name === "REPORT" ? json?.outputs?.report?.state : json?.outputs?.verificationPackage?.state;
    last = { status, state: String(projected.state ?? stateFromOutputs ?? "?") };
    if (projected.available === true) return;
    // eslint-disable-next-line no-console
    console.log(
      `    … ${name} evidence=${evidenceId} ${endpoint} elapsed=${secs(Date.now() - start)} ` +
        `httpStatus=${status} state=${last.state}`,
    );
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(
    `${name} not available in ${secs(timeoutMs)} (last httpStatus=${last.status} state=${last.state})`,
  );
}

/**
 * Trace ONE Evidence id through every closure-required UC-1 surface and assert
 * the acquisition statement + real artifacts on each. Every stage is bounded and
 * prints a PASS/FAIL line. Authenticated reads use the user's WEB session: the
 * extension token is capture-scoped (UC-1 §4.1) and is refused on these routes.
 * `filedCaseId` — the case the popup filed the capture into (UC-EXT-010), or null.
 */
async function traceEvidenceAcrossSurfaces(
  evidenceId: string,
  token: string,
  filedCaseId: string | null,
): Promise<void> {
  let verifyLink = "";
  // 1. LIBRARY — the record appears in the acquisition-filtered list.
  await stage("LIBRARY", STAGE_TIMEOUT.LIBRARY, async () => {
    const list = await apiGet<{
      items?: Array<{ id: string; acquisition?: { mode?: string } }>;
    }>(`/v1/evidence?scope=all&acquisition=DIRECT_WEB_CAPTURE&limit=50`, token);
    const found = list.items?.find((x) => x.id === evidenceId);
    expect(found, "evidence present in Library").toBeTruthy();
    expect(found!.acquisition?.mode).toBe(ACQ_MODE);
  });

  // 2. DETAIL — the review workspace states the same acquisition. `sourceContext`
  //    is a TOP-LEVEL key of the response (sibling of `evidence`), not nested.
  await stage("DETAIL", STAGE_TIMEOUT.DETAIL, async () => {
    const detail = await apiGet<{
      sourceContext?: { acquisition?: { mode?: string } };
    }>(`/v1/evidence/${evidenceId}/review-workspace`, token);
    expect(detail.sourceContext?.acquisition?.mode).toBe(ACQ_MODE);
  });

  // 3. CASE — the capture the popup filed into a case is under that case at
  //    seal (UC-EXT-010); otherwise create a case in the SAME workspace, link
  //    the evidence, and read it back.
  await stage("CASE", STAGE_TIMEOUT.CASE, async () => {
    if (filedCaseId) {
      const filed = await apiGet<{ items?: Array<{ id: string }> }>(
        `/v1/evidence?caseId=${filedCaseId}&scope=all`,
        token,
      );
      expect(filed.items?.some((x) => x.id === evidenceId), "capture filed to the chosen case at seal").toBe(true);
      return;
    }
    const createdCase = await apiPost<{ id: string }>(`/v1/cases`, token, {
      name: `UC1 E2E ${evidenceId.slice(0, 8)}`,
      teamId: TEAM,
    });
    expect(createdCase.id, "case created").toBeTruthy();
    const linked = await apiPost<{ evidence?: { id: string; caseId?: string } }>(
      `/v1/cases/${createdCase.id}/evidence`,
      token,
      { evidenceId },
    );
    expect(linked.evidence?.id).toBe(evidenceId);
    expect(linked.evidence?.caseId).toBe(createdCase.id);
    const caseEvidence = await apiGet<{ items?: Array<{ id: string }> }>(
      `/v1/evidence?caseId=${createdCase.id}&scope=all`,
      token,
    );
    expect(caseEvidence.items?.some((x) => x.id === evidenceId), "evidence linked to case").toBe(true);
  });

  // 4. SEARCH — reindex (synchronous projection) then confirm the evidence is
  //    findable in the workspace search. The display title is a generic default
  //    ("Digital Evidence Record"), so a title-derived term is unreliable; the
  //    fresh acceptance workspace holds only this run's captures, so the
  //    workspace search listing must contain the just-indexed evidence.
  await stage("SEARCH", STAGE_TIMEOUT.SEARCH, async () => {
    const reindex = await apiPost<{ documentId?: string }>(
      `/v1/search/reindex/evidence/${evidenceId}`,
      token,
      { teamId: TEAM },
    );
    expect(reindex.documentId, "evidence indexed for search").toBeTruthy();
    const search = await apiGet<{ rows?: Array<{ evidenceId?: string }> }>(
      `/v1/search?teamId=${encodeURIComponent(TEAM)}&limit=50`,
      token,
    );
    expect(
      search.rows?.some((r) => r.evidenceId === evidenceId),
      "workspace search lists the indexed evidence",
    ).toBe(true);
  });

  // 5. REPORT — worker-generated. Poll status, then fetch and assert.
  await stage("REPORT", STAGE_TIMEOUT.REPORT, async () => {
    await pollArtifact("REPORT", evidenceId, token, STAGE_TIMEOUT.REPORT, (s) => ({
      available: s?.report?.available,
      state: s?.outputs?.report?.state,
    }));
    const report = await apiGet<{ evidenceId?: string; snapshots?: { acquisitionMode?: string } }>(
      `/v1/evidence/${evidenceId}/report/latest`,
      token,
    );
    expect(report.evidenceId).toBe(evidenceId);
    // The report was SEALED with the acquisition snapshot — not re-derived.
    expect(report.snapshots?.acquisitionMode).toBe(ACQ_MODE);
  });

  // 6. VERIFICATION PACKAGE — worker-generated. Poll status, then fetch and assert.
  await stage("PACKAGE", STAGE_TIMEOUT.PACKAGE, async () => {
    await pollArtifact("PACKAGE", evidenceId, token, STAGE_TIMEOUT.PACKAGE, (s) => ({
      available: s?.verificationPackage?.available,
      state: s?.outputs?.verificationPackage?.state,
    }));
    const pkg = await apiGet<{ evidenceId?: string; version?: number }>(
      `/v1/evidence/${evidenceId}/verification-package`,
      token,
    );
    expect(pkg.evidenceId).toBe(evidenceId);
    expect(pkg.version, "verification package has a version").toBeTruthy();
  });

  // 7. PACKAGE VALIDATOR + PUBLIC VERIFY — the unauthenticated public verify route
  //    computes the package integrity server-side. The record's id is not a
  //    link (ET-PKG-07): the record is published and a share link minted.
  await stage("PACKAGE_VALIDATOR", STAGE_TIMEOUT.PUBLIC_VERIFY, async () => {
    const byId = await apiPublicGet(`/public/verify/${evidenceId}`);
    expect(byId.status, "a record id is not a public link").toBe(404);
    verifyLink = mintVerifyLink(evidenceId);
    const pub = await apiPublicGet(`/public/verify/${verifyLink}`);
    expect(pub.status, "public verify reachable").toBe(200);
    // Validator: the signed manifest + checksum index prove the package is intact.
    const integrity = pub.json?.verificationPackageIntegrity;
    expect(integrity?.available, "public verify sees the package").toBe(true);
    expect(integrity?.signedManifestPresent, "package manifest is signed").toBe(true);
    expect(integrity?.checksumIndexPresent, "package checksum index present").toBe(true);
  });

  await stage("PUBLIC_VERIFY", STAGE_TIMEOUT.PUBLIC_VERIFY, async () => {
    const pub = await apiPublicGet(`/public/verify/${verifyLink}`);
    expect(pub.status, "public verify reachable").toBe(200);
    // Public acquisition is domain-only / neutral, same mode.
    expect(pub.json?.acquisition?.acquisition?.mode).toBe(ACQ_MODE);
  });
}

/**
 * Launch the project's REAL browser channel and load the unpacked E2E build over
 * CDP. Returns the context, the extension service worker and the version string.
 */
async function launchWithExtension(channel: string): Promise<{
  context: BrowserContext;
  sw: Worker;
  userDataDir: string;
  version: string;
}> {
  const userDataDir = mkdtempSync(join(tmpdir(), "proovra-ext-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel,
    headless: false,
    // Playwright disables extensions by default; the E2E build must run.
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  });
  const browser = context.browser();
  if (!browser) throw new Error("no browser handle for the persistent context");
  const swSeen = context.waitForEvent("serviceworker", {
    predicate: (w) => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`),
    timeout: 30_000,
  });
  const cdp = await browser.newBrowserCDPSession();
  const loaded = (await cdp.send("Extensions.loadUnpacked" as never, { path: EXT } as never)) as { id: string };
  if (loaded.id !== EXTENSION_ID) {
    throw new Error(`loaded extension id ${loaded.id} is not the E2E build id ${EXTENSION_ID} (wrong dist?)`);
  }
  const existing = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`));
  const sw = existing ?? (await swSeen);
  return { context, sw, userDataDir, version: browser.version() };
}

/** UC-TQ-002 — refuse to report a project whose browser is not the one it names. */
function assertBrowserIdentity(project: string, channel: string, userAgent: string): void {
  if (channel === "msedge") {
    expect(userAgent, `${project} must be Microsoft Edge`).toMatch(/\bEdg\/\d+/);
  } else if (channel === "chrome") {
    expect(userAgent, `${project} must be Google Chrome`).toMatch(/\bChrome\/\d+/);
    expect(userAgent, `${project} must not be Edge`).not.toMatch(/\bEdg\//);
  } else {
    throw new Error(`project ${project} declares channel '${channel}', which this acceptance does not accept`);
  }
}

async function openPopupFor(context: BrowserContext, sw: Worker, targetTabId: number): Promise<Page> {
  const url = `chrome-extension://${EXTENSION_ID}/popup.html?targetTabId=${targetTabId}`;
  await sw.evaluate(async (u: string) => {
    await chrome.windows.create({ url: u, type: "popup", width: 420, height: 720, focused: true });
  }, url);
  // The page event fires while the new window is still about:blank, so find the
  // popup by its committed URL (bounded by the POPUP stage).
  const deadline = Date.now() + STAGE_TIMEOUT.POPUP;
  while (Date.now() < deadline) {
    const popup = context.pages().find((p) => p.url().startsWith(url));
    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: STAGE_TIMEOUT.POPUP });
      return popup;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`popup page ${url} never opened`);
}

/**
 * The OAuth endpoints answer as the API (not the web app on the wrong port),
 * and a SIGNED-OUT auth window is sent to sign in rather than shown 401 JSON
 * (UC-EXT-006) — probed live on the running stack.
 */
async function probeOAuthRoutes(): Promise<void> {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: "proovra-extension",
    redirect_uri: `https://${EXTENSION_ID}.chromiumapp.org/oauth2`,
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    state: "probe",
  });
  const authz = await fetch(`${API}/v1/oauth/extension/authorize?${q}`, {
    headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  expect(authz.status, "signed-out authorize is a redirect to sign in").toBe(302);
  expect(String(authz.headers.get("location"))).toContain("/login?next=");
  const tok = await fetch(`${API}/v1/oauth/extension/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  expect(tok.status, "the token endpoint answers as the API").toBe(400);
  expect(((await tok.json()) as { error?: string }).error).toBe("invalid_request");
}

test.beforeAll(() => {
  expect(SESSION_BEARER, "PROOVRA_E2E_SESSION_BEARER must be set").not.toBe("");
  expect(TEAM, "PROOVRA_E2E_TEAM_ID must be set").not.toBe("");
  expect(CASE_ID, "PROOVRA_E2E_CASE_ID must be set").not.toBe("");
  expect(EXTENSION_ID, "PROOVRA_E2E_EXTENSION_ID must be set").toMatch(/^[a-p]{32}$/);
});

for (const fixture of ["static", "long", "spa", "mutating"]) {
  test(`captures ${fixture} through the real popup and traces the record across every surface`, async () => {
    // The test-level cap is the SUM of the bounded stage caps plus margin — a
    // backstop, never the thing that fires first.
    test.setTimeout(Object.values(STAGE_TIMEOUT).reduce((a, b) => a + b, 0) + 60_000);
    const project = test.info().project.name;
    const channel = String((test.info().project.use as { channel?: string }).channel ?? "");
    // eslint-disable-next-line no-console
    console.log(`\n[${project}/${fixture}] ──────── UC-1 lifecycle trace ────────`);

    await stage("OAUTH_ROUTES", 25_000, probeOAuthRoutes);
    const launched = await stage("LAUNCH", STAGE_TIMEOUT.LAUNCH, () => launchWithExtension(channel));
    const { context, sw } = launched;
    try {
      const page = await context.newPage();
      await stage("FIXTURE", 30_000, async () => {
        await page.goto(`${FIXTURES}/${fixture}`, { timeout: 20_000 });
        await page.waitForTimeout(300);
      });
      const userAgent = await page.evaluate(() => navigator.userAgent);
      // eslint-disable-next-line no-console
      console.log(`  BROWSER            ${project} channel=${channel} version=${launched.version} ua="${userAgent}"`);
      assertBrowserIdentity(project, channel, userAgent);
      test.info().annotations.push({ type: "browser", description: `${channel} ${launched.version} ${userAgent}` });

      const fixtureTabId = await stage("TAB", 10_000, async () => {
        const id = await sw.evaluate(async (origin: string) => {
          const tabs = await chrome.tabs.query({ url: `${origin}/*` });
          return tabs[0]?.id ?? null;
        }, FIXTURES);
        if (typeof id !== "number") throw new Error("fixture tab not found");
        return id;
      });

      // The browser carries the signed-in WEB session, exactly as it would for a
      // user who is signed in to PROOVRA; the extension's own OAuth flow uses it.
      await context.addCookies([{ name: "proovra_session", value: SESSION_BEARER, url: API }]);

      const popup = await stage("POPUP", STAGE_TIMEOUT.POPUP, () => openPopupFor(context, sw, fixtureTabId));

      // AUTH — the extension's REAL sign-in: popup button -> background
      // launchWebAuthFlow -> authorize (302 to chromiumapp.org) -> token.
      await stage("AUTH", STAGE_TIMEOUT.AUTH, async () => {
        await popup.getByTestId("sign-out").or(popup.getByTestId("sign-in")).first().waitFor({ timeout: 10_000 });
        if (await popup.getByTestId("sign-in").isVisible()) {
          await popup.getByTestId("sign-in").click();
        }
        await popup.getByTestId("signed-in").waitFor({ state: "visible", timeout: 45_000 });
        const redirect = await sw.evaluate(() => chrome.identity.getRedirectURL("oauth2"));
        expect(redirect).toBe(`https://${EXTENSION_ID}.chromiumapp.org/oauth2`);
      });

      // UC-EXT-001 / UC-EXT-010 — the real workspace + case lists.
      await stage("WORKSPACE", 20_000, async () => {
        await expect(popup.locator(`[data-testid="workspace"] option[value="${TEAM}"]`)).toHaveCount(1, { timeout: 15_000 });
        await popup.getByTestId("workspace").selectOption(TEAM);
        await expect(popup.locator(`[data-testid="case"] option[value="${CASE_ID}"]`)).toHaveCount(1, { timeout: 15_000 });
        await expect(popup.getByTestId("capture-viewport")).toBeEnabled();
      });
      const fileToCase = fixture === "static";
      if (fileToCase) await popup.getByTestId("case").selectOption(CASE_ID);

      // CAPTURE — the popup's own button; the background owns the capture.
      const evidenceId = await stage("CAPTURE", STAGE_TIMEOUT.CAPTURE, async () => {
        await popup.getByTestId(fixture === "static" ? "capture-viewport" : "capture-full").click();
        const status = popup.getByTestId("status");
        await expect(status).toHaveAttribute("data-capture-state", /^(SUCCEEDED|FAILED)$/, {
          timeout: STAGE_TIMEOUT.CAPTURE - 10_000,
        });
        const state = await status.getAttribute("data-capture-state");
        if (state !== "SUCCEEDED") {
          const bg = await sw.evaluate(async (tabId: number) => {
            const all = (await chrome.storage.session.get("proovra.capture.status"))["proovra.capture.status"] ?? {};
            return all[String(tabId)] ?? null;
          }, fixtureTabId);
          throw new Error(`capture ${state}: ${await status.textContent()} :: ${JSON.stringify(bg)}`);
        }
        const id = await status.getAttribute("data-evidence-id");
        expect(id, "capture returned an evidence id").toBeTruthy();
        return id!;
      });
      for (const derived of ["CAPTURE_SESSION", "UPLOAD", "DIGEST", "EVIDENCE"]) {
        // eslint-disable-next-line no-console
        console.log(`  ${derived.padEnd(18)} PASS   (sealed evidence ${evidenceId})`);
      }

      await traceEvidenceAcrossSurfaces(evidenceId, SESSION_BEARER, fileToCase ? CASE_ID : null);
      // eslint-disable-next-line no-console
      console.log(`[${project}/${fixture}] ALL SURFACES PASS — evidence ${evidenceId}\n`);
    } finally {
      await context.close().catch(() => undefined);
      try {
        rmSync(launched.userDataDir, { recursive: true, force: true });
      } catch {
        /* best effort: a profile dir still locked by a closing browser */
      }
    }
  });
}
