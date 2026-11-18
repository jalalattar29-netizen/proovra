/**
 * B7B-F06 (Free acceptance pass, 2026-11-18) — the Trust Center ARTICLE
 * authoring gate failed OPEN: it asked FEATURE_TRUST_CENTER inside a
 * try/catch that swallowed any engine failure and went on to write. Every
 * other authoring route answers through `refuseTrustAuthoring`, which lets a
 * failure surface as an error instead of a publish. Pinned at source level
 * because the failure mode is an exception inside the entitlement engine.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  resolve(__dirname, "..", "src", "routes", "trust-and-governance.routes.ts"),
  "utf8",
);

function routeBody(method: string, path: string): string {
  const start = SOURCE.indexOf(`app.${method}(\n    "${path}"`);
  expect(start, `${method.toUpperCase()} ${path} is registered`).toBeGreaterThan(-1);
  const next = SOURCE.indexOf("\n  app.", start + 10);
  return SOURCE.slice(start, next === -1 ? undefined : next);
}

describe("B7B-F06 — Trust Center article authoring never fails open", () => {
  it("POST /v1/trust/articles asks the shared refusal helper, outside any catch", () => {
    const body = routeBody("post", "/v1/trust/articles");
    expect(body).toContain("await refuseTrustAuthoring(reply, ctx)");
    expect(body).not.toMatch(/catch\s*\{[^}]*engine failure must not break route/);
  });

  it("no FEATURE_TRUST_CENTER check anywhere in the file is wrapped in a swallowing catch", () => {
    expect(SOURCE).not.toMatch(/FEATURE_TRUST_CENTER[^\n]*\n[^\n]*\n\s*\}\s*catch\s*\{\s*\/\*/);
  });
});
