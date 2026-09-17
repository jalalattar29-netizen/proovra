/**
 * UC-1 — Direct Web Capture browser acceptance (Chrome + Edge).
 *
 * Loads the unpacked extension, seeds a short-lived API token into the
 * extension's session storage (standing in for the interactive OAuth flow),
 * captures a deterministic fixture page through the real extension pipeline,
 * then traces the SAME Evidence id through the canonical PROOVRA surfaces and
 * asserts the acquisition statement is consistent across all of them.
 *
 * REQUIRED ENV (see README.md):
 *   PROOVRA_API_ORIGIN   the running API origin (e.g. http://localhost:4000)
 *   PROOVRA_E2E_TOKEN    a valid bearer token for a seeded user
 *   PROOVRA_E2E_TEAM_ID  a workspace the user may capture into (paid plan)
 *   EXTENSION_DIST       absolute path to apps/extension/dist (built)
 *   FIXTURE_ORIGIN       the fixture server origin (default http://127.0.0.1:4599)
 */
import { test, expect, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXTENSION_DIST ?? join(HERE, "..", "dist");
const API = process.env.PROOVRA_API_ORIGIN ?? "http://localhost:4000";
const TOKEN = process.env.PROOVRA_E2E_TOKEN ?? "";
const TEAM = process.env.PROOVRA_E2E_TEAM_ID ?? "";
const FIXTURES = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:4599";

async function api(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function serviceWorker(ctx: BrowserContext): Promise<Worker> {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  return sw;
}

test.beforeAll(() => {
  expect(TOKEN, "PROOVRA_E2E_TOKEN must be set").not.toBe("");
  expect(TEAM, "PROOVRA_E2E_TEAM_ID must be set").not.toBe("");
});

for (const fixture of ["static", "long", "spa", "mutating"]) {
  test(`captures ${fixture} and traces the record across every surface`, async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "proovra-ext-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    try {
      const sw = await serviceWorker(context);
      // Seed the session token the popup/background would obtain via OAuth.
      await sw.evaluate(async (token: string) => {
        await chrome.storage.session.set({
          "proovra.session.token": { accessToken: token, expiresAtMs: Date.now() + 3600_000, account: "e2e" },
        });
      }, TOKEN);

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
        { tabId: tabInfo.tabId!, windowId: tabInfo.windowId!, teamId: TEAM, mode: fixture === "static" ? "VIEWPORT" : "FULL_PAGE" },
      )) as { ok: boolean; evidenceId?: string; error?: string };

      expect(result.ok, result.error).toBe(true);
      const evidenceId = result.evidenceId!;

      // The acquisition truth is consistent across every canonical surface.
      const detail = (await api(`/v1/evidence/${evidenceId}/review-workspace`)) as {
        evidence?: { sourceContext?: { acquisition?: { mode?: string } } };
      };
      const publicVerify = (await api(`/v1/evidence/${evidenceId}/public-overview`)) as {
        acquisition?: { acquisition?: { mode?: string; label?: string } };
      };
      const list = (await api(`/v1/evidence?scope=all&acquisition=DIRECT_WEB_CAPTURE&limit=50`)) as {
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
