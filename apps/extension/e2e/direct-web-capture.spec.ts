/**
 * UC-1 — Direct Web Capture browser acceptance (Chrome + Edge).
 *
 * For each deterministic fixture page (static, long/full-page, SPA, mutating),
 * this:
 *   1. obtains the extension's access token through the REAL first-party OAuth
 *      journey (Authorization Code + PKCE S256 against the running API), then
 *   2. captures the page through the real extension pipeline (CaptureSession ->
 *      upload -> server digest verification -> Evidence), then
 *   3. traces that ONE Evidence id through EVERY closure-required surface and
 *      asserts the acquisition statement is consistent and the artifacts are
 *      real: Library -> Detail -> Case -> Search -> Report -> Verification
 *      Package -> Package Validator (integrity) -> Public Verify.
 *
 * WHY NOT launchWebAuthFlow directly: the interactive consent window that
 * chrome.identity.launchWebAuthFlow opens cannot be driven headlessly/reliably in
 * CI. So the test performs the SAME protocol the extension performs — it computes
 * a PKCE verifier/challenge, calls the real /authorize endpoint carrying the
 * user's session, receives the real 302 redirect with a single-use code, and
 * exchanges it at the real /token endpoint. Nothing is mocked and no static token
 * is seeded.
 *
 * REQUIRED ENV (see README.md):
 *   PROOVRA_API_ORIGIN         the running API origin (e.g. http://localhost:4000)
 *   PROOVRA_E2E_SESSION_BEARER a bearer proving the logged-in user session (stands
 *                              in for the browser proovra_session cookie that
 *                              /authorize runs behind); NEVER a production token
 *   PROOVRA_E2E_TEAM_ID        a workspace the user may capture into (paid plan)
 *   PROOVRA_E2E_REDIRECT_URI   the extension OAuth redirect (its chromiumapp.org
 *                              callback, or an allowlisted dev redirect)
 *   EXTENSION_DIST             absolute path to apps/extension/dist (built)
 *   FIXTURE_ORIGIN             the fixture server origin (default http://127.0.0.1:4599)
 */
import { test, expect, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXTENSION_DIST ?? join(HERE, "..", "dist");
const API = process.env.PROOVRA_API_ORIGIN ?? "http://localhost:4000";
const SESSION_BEARER = process.env.PROOVRA_E2E_SESSION_BEARER ?? "";
const TEAM = process.env.PROOVRA_E2E_TEAM_ID ?? "";
const REDIRECT_URI =
  process.env.PROOVRA_E2E_REDIRECT_URI ??
  "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/oauth";
const CLIENT_ID = process.env.PROOVRA_OAUTH_CLIENT_ID ?? "proovra-extension";
const FIXTURES = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:4599";

const ACQ_MODE = "DIRECT_WEB_CAPTURE_EXTENSION";
// Report + verification package are generated asynchronously by the worker after
// the capture is sealed; give the poll room without being flaky.
const ARTIFACT_TIMEOUT_MS = 240_000;

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Run the REAL OAuth Authorization Code + PKCE (S256) journey against the running
 * API and return the freshly-issued extension access token. This exercises the
 * authorize endpoint, PKCE binding, the single-use code, and the code exchange —
 * exactly the server-side journey the extension's launchWebAuthFlow triggers.
 */
async function obtainExtensionAccessToken(): Promise<string> {
  const { verifier, challenge } = pkce();
  const state = base64Url(randomBytes(9));

  const authorizeUrl =
    `${API}/v1/oauth/extension/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=S256&scope=capture.direct&state=${encodeURIComponent(state)}`;
  const authz = await fetch(authorizeUrl, {
    headers: { authorization: `Bearer ${SESSION_BEARER}` },
    redirect: "manual",
  });
  if (authz.status !== 302) {
    throw new Error(`authorize expected 302, got ${authz.status}: ${await authz.text()}`);
  }
  const loc = new URL(String(authz.headers.get("location")));
  if (loc.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
  const code = loc.searchParams.get("code");
  if (!code) throw new Error("authorize returned no code");

  const tok = await fetch(`${API}/v1/oauth/extension/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!tok.ok) throw new Error(`token exchange failed ${tok.status}: ${await tok.text()}`);
  const body = (await tok.json()) as { access_token?: string; token_type?: string };
  if (body.token_type !== "Bearer" || !body.access_token) {
    throw new Error("token exchange returned no usable bearer");
  }
  return body.access_token;
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

// The public verify surface is UNAUTHENTICATED — the evidence id is the token,
// and a third party opens exactly this URL. No Authorization header.
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

/** A stable search token drawn from the evidence's own indexed title. */
function searchTokenFrom(title: string | undefined): string {
  const tokens = String(title ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t.length >= 4);
  // Longest token → most selective, and it is guaranteed to be a substring of
  // the indexed title (search matches title/subtitle/searchableText by ILIKE).
  return tokens.sort((a, b) => b.length - a.length)[0] ?? "PROOVRA";
}

/**
 * Trace ONE Evidence id through every closure-required UC-1 surface and assert
 * the acquisition statement + real artifacts on each. All authenticated reads use
 * the OAuth-issued bearer (proving the minted token is accepted downstream).
 */
async function traceEvidenceAcrossSurfaces(evidenceId: string, token: string): Promise<void> {
  // 1. LIBRARY — the record appears in the acquisition-filtered list.
  const list = await apiGet<{ items?: Array<{ id: string; title?: string; acquisition?: { mode?: string } }> }>(
    `/v1/evidence?scope=all&acquisition=DIRECT_WEB_CAPTURE&limit=50`,
    token,
  );
  const item = list.items?.find((x) => x.id === evidenceId);
  expect(item, "evidence present in Library").toBeTruthy();
  expect(item!.acquisition?.mode).toBe(ACQ_MODE);

  // 2. DETAIL — the review workspace states the same acquisition.
  const detail = await apiGet<{ evidence?: { sourceContext?: { acquisition?: { mode?: string } } } }>(
    `/v1/evidence/${evidenceId}/review-workspace`,
    token,
  );
  expect(detail.evidence?.sourceContext?.acquisition?.mode).toBe(ACQ_MODE);

  // 3. CASE — create a case in the SAME workspace, link the evidence, read it back.
  const createdCase = await apiPost<{ id: string }>(
    `/v1/cases`,
    token,
    { name: `UC1 E2E ${evidenceId.slice(0, 8)}`, teamId: TEAM },
  );
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

  // 4. SEARCH — reindex (synchronous projection) then find the evidence by a term
  //    from its own indexed title.
  const reindex = await apiPost<{ documentId?: string }>(
    `/v1/search/reindex/evidence/${evidenceId}`,
    token,
    { teamId: TEAM },
  );
  expect(reindex.documentId, "evidence indexed for search").toBeTruthy();
  const term = searchTokenFrom(item!.title);
  const search = await apiGet<{ rows?: Array<{ evidenceId?: string }> }>(
    `/v1/search?teamId=${encodeURIComponent(TEAM)}&q=${encodeURIComponent(term)}&limit=50`,
    token,
  );
  expect(
    search.rows?.some((r) => r.evidenceId === evidenceId),
    `search q="${term}" finds the evidence`,
  ).toBe(true);

  // 5 + 6. REPORT and VERIFICATION PACKAGE are generated asynchronously by the
  //    worker after the capture is sealed. Poll the single status surface until
  //    both are available, then fetch and assert each is for THIS evidence.
  await expect
    .poll(
      async () => {
        const s = await apiGet<{
          report?: { available?: boolean };
          verificationPackage?: { available?: boolean };
        }>(`/v1/evidence/${evidenceId}/artifacts/status`, token);
        return Boolean(s.report?.available && s.verificationPackage?.available);
      },
      { timeout: ARTIFACT_TIMEOUT_MS, intervals: [2000] },
    )
    .toBe(true);

  const report = await apiGet<{ evidenceId?: string; snapshots?: { acquisitionMode?: string } }>(
    `/v1/evidence/${evidenceId}/report/latest`,
    token,
  );
  expect(report.evidenceId).toBe(evidenceId);
  // The report was SEALED with the acquisition snapshot — not re-derived.
  expect(report.snapshots?.acquisitionMode).toBe(ACQ_MODE);

  const pkg = await apiGet<{ evidenceId?: string; version?: number }>(
    `/v1/evidence/${evidenceId}/verification-package`,
    token,
  );
  expect(pkg.evidenceId).toBe(evidenceId);
  expect(pkg.version, "verification package has a version").toBeTruthy();

  // 7. PACKAGE VALIDATOR + PUBLIC VERIFY — the unauthenticated public verify route
  //    (evidence id is the token) computes the package integrity server-side.
  const pub = await apiPublicGet(`/public/verify/${evidenceId}`);
  expect(pub.status, "public verify reachable").toBe(200);
  // Public acquisition is domain-only / neutral, same mode.
  expect(pub.json?.acquisition?.acquisition?.mode).toBe(ACQ_MODE);
  // Validator: the signed manifest + checksum index prove the package is intact.
  const integrity = pub.json?.verificationPackageIntegrity;
  expect(integrity?.available, "public verify sees the package").toBe(true);
  expect(integrity?.signedManifestPresent, "package manifest is signed").toBe(true);
  expect(integrity?.checksumIndexPresent, "package checksum index present").toBe(true);
}

async function serviceWorker(ctx: BrowserContext): Promise<Worker> {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  return sw;
}

test.beforeAll(() => {
  expect(SESSION_BEARER, "PROOVRA_E2E_SESSION_BEARER must be set").not.toBe("");
  expect(TEAM, "PROOVRA_E2E_TEAM_ID must be set").not.toBe("");
});

for (const fixture of ["static", "long", "spa", "mutating"]) {
  test(`captures ${fixture} and traces the record across every surface`, async () => {
    // The full lifecycle includes async report + package generation.
    test.setTimeout(ARTIFACT_TIMEOUT_MS + 120_000);

    // REAL OAuth: exercises authorize + PKCE + single-use code + token exchange.
    const accessToken = await obtainExtensionAccessToken();

    const userDataDir = mkdtempSync(join(tmpdir(), "proovra-ext-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    try {
      const sw = await serviceWorker(context);
      // Store the OAuth-issued token exactly where the background's real OAuth
      // completion writes it — the ONLY difference from a hand-driven consent
      // window is the skipped interactive click, not the protocol.
      await sw.evaluate(async (token: string) => {
        await chrome.storage.session.set({
          "proovra.session.token": {
            accessToken: token,
            expiresAtMs: Date.now() + 3600_000,
            account: "e2e",
          },
        });
      }, accessToken);

      const page = await context.newPage();
      await page.goto(`${FIXTURES}/${fixture}`);
      await page.waitForTimeout(300);

      const tabInfo = await sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return { tabId: tab.id, windowId: tab.windowId };
      });

      // Drive the real background pipeline exactly as the popup does.
      const result = (await sw.evaluate(
        async (arg: { tabId: number; windowId: number; teamId: string; mode: string }) => {
          return chrome.runtime.sendMessage({
            kind: "PRESERVE",
            mode: arg.mode,
            teamId: arg.teamId,
            tabId: arg.tabId,
            windowId: arg.windowId,
            evidenceType: "PHOTO",
          });
        },
        {
          tabId: tabInfo.tabId!,
          windowId: tabInfo.windowId!,
          teamId: TEAM,
          mode: fixture === "static" ? "VIEWPORT" : "FULL_PAGE",
        },
      )) as { ok: boolean; evidenceId?: string; error?: string };

      expect(result.ok, result.error).toBe(true);
      const evidenceId = result.evidenceId!;

      // The SAME Evidence id, proven consistent through every closure surface.
      await traceEvidenceAcrossSurfaces(evidenceId, accessToken);
    } finally {
      await context.close();
    }
  });
}
