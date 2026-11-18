/**
 * A1-02 (Free-user audit, 2026-11-14) — the batch-completion email links to a
 * page the web actually serves.
 *
 * It linked `${APP_URL}/batch/<id>`; the web has no `/batch` route (and no
 * redirect for it), so every completion email led to a 404. The link is now
 * the batch console, `/operations/batch-analysis`, which lists the finished
 * job. Checked against the web's own app directory, so a later move of the
 * console that forgets the email fails here.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { batchCompletionEmailLink } from "../src/routes/enterprise.routes.js";

const WEB_APP = resolve(__dirname, "../../../apps/web/app");
const ROUTES = resolve(__dirname, "../src/routes/enterprise.routes.ts");

/** The page file a web path is served from, through the `(app)` route group. */
function webPageFor(path: string): string {
  return resolve(WEB_APP, "(app)", `.${path}`, "page.tsx");
}

describe("A1-02 — batch-completion email link", () => {
  it("points at the batch console the web serves, on the configured app origin", () => {
    const link = batchCompletionEmailLink("https://app.example.test/");
    expect(link).toBe("https://app.example.test/operations/batch-analysis");
    const path = new URL(link).pathname;
    expect(existsSync(webPageFor(path)), `${path} has a web page`).toBe(true);
  });

  it("falls back to the production origin when APP_URL is unset", () => {
    expect(batchCompletionEmailLink(undefined)).toBe("https://app.proovra.com/operations/batch-analysis");
  });

  it("the completion email is built with that link, not a /batch/<id> path the web never had", () => {
    const src = readFileSync(ROUTES, "utf8");
    // PRO-PW-04 — the link base is THE app-host authority, not APP_URL (read nowhere else).
    expect(src).toMatch(/sendBatchComplete\([\s\S]{0,500}batchCompletionEmailLink\(getEmailAppBaseUrl\(\)\)/);
    expect(src).not.toMatch(/\/batch\/\$\{/);
    expect(existsSync(resolve(WEB_APP, "(app)", "batch"))).toBe(false);
  });
});
