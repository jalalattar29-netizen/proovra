/**
 * UC-1 — Direct Web Capture browser acceptance (Chrome + Edge).
 *
 * Loads the unpacked extension, obtains the extension's access token through the
 * REAL first-party OAuth journey (Authorization Code + PKCE S256 against the
 * running API: authorize -> single-use code -> token exchange), injects ONLY that
 * freshly-minted token, captures a deterministic fixture page through the real
 * extension pipeline, then traces the SAME Evidence id through the canonical
 * PROOVRA surfaces and asserts the acquisition statement is consistent across all
 * of them.
 *
 * WHY NOT launchWebAuthFlow directly: the interactive consent window that
 * chrome.identity.launchWebAuthFlow opens cannot be driven headlessly/reliably in
 * CI. So the test performs the SAME protocol the extension performs — it computes
 * a PKCE verifier/challenge, calls the real /authorize endpoint carrying the
 * user's session (the cookie the logged-in web app would send, supplied here as a
 * bearer), receives the real 302 redirect with a single-use code, and exchanges it
 * at the real /token endpoint. Nothing is mocked away and no static token is
 * seeded: the token the extension uses is the one the OAuth server issued.
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

  // /authorize runs behind requireAuth. The logged-in web session is a cookie in
  // the real browser; here we present it as a bearer. `redirect: manual` so we can
  // read the 302 Location (the code) instead of following it to chromiumapp.org.
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

async function api(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
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
    // REAL OAuth: this call exercises authorize + PKCE + single-use code + token
    // exchange, and yields the token the extension will actually carry.
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
      // window is that we skipped the interactive click, not the protocol.
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

      // The acquisition truth is consistent across every canonical surface, read
      // with the SAME OAuth-issued token (proving the minted bearer is accepted by
      // the canonical requireAuth on every downstream route).
      const detail = (await api(`/v1/evidence/${evidenceId}/review-workspace`, accessToken)) as {
        evidence?: { sourceContext?: { acquisition?: { mode?: string } } };
      };
      const publicVerify = (await api(
        `/v1/evidence/${evidenceId}/public-overview`,
        accessToken,
      )) as {
        acquisition?: { acquisition?: { mode?: string; label?: string } };
      };
      const list = (await api(
        `/v1/evidence?scope=all&acquisition=DIRECT_WEB_CAPTURE&limit=50`,
        accessToken,
      )) as {
        items?: Array<{ id: string; acquisition?: { mode?: string } }>;
      };
      const inLibrary = list.items?.find((x) => x.id === evidenceId);

      expect(inLibrary?.acquisition?.mode).toBe("DIRECT_WEB_CAPTURE_EXTENSION");
      expect(detail.evidence?.sourceContext?.acquisition?.mode).toBe("DIRECT_WEB_CAPTURE_EXTENSION");
      // Public Verify shows the acquisition (domain-only; the label is the neutral one).
      expect(publicVerify.acquisition?.acquisition?.mode).toBe("DIRECT_WEB_CAPTURE_EXTENSION");
    } finally {
      await context.close();
    }
  });
}
