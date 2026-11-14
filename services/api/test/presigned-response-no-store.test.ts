/**
 * AUDIT D-05 (2026-11-14) — every authenticated response that carries a
 * presigned GET URL says `Cache-Control: no-store` (the URL is a bearer
 * capability for its lifetime). One helper, `noStorePresignedResponse`, is
 * called by each route that answers with such a URL; the route-level header is
 * proven over real HTTP in download-custody-truth.integration.test.ts.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PRESIGNED_RESPONSE_CACHE_CONTROL,
  noStorePresignedResponse,
} from "../src/http/presigned-response.js";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** The handler of one GET (or POST) route: from its declaration to the next one. */
function handler(src: string, path: string): string {
  const method = path.endsWith("/links") ? "post" : "get";
  // `app.get(` then whitespace, then the exact path literal.
  const decl = new RegExp(`app\\.${method}\\(\\s*"`).source;
  let at = -1;
  let from = 0;
  for (;;) {
    const m = new RegExp(decl, "g");
    m.lastIndex = from;
    const hit = m.exec(src);
    if (!hit) break;
    if (src.startsWith(`${path}"`, hit.index + hit[0].length)) {
      at = hit.index + hit[0].length + path.length + 1;
      break;
    }
    from = hit.index + hit[0].length;
  }
  expect(at, `route ${method.toUpperCase()} ${path} not found`).toBeGreaterThan(-1);
  const rest = src.slice(at);
  const next = rest.search(/\n\s*app\.(get|post|put|patch|delete)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

const ROUTES: Array<[file: string, paths: string[]]> = [
  [
    "../src/routes/evidence.routes.ts",
    [
      "/v1/evidence/:id/parts",
      "/v1/evidence/:id/report/latest",
      "/v1/evidence/:id/reports/:version",
      "/v1/evidence/:id/verification-packages/:version",
      "/v1/evidence/:id/verification-packages/:version/external-disclosure",
      "/v1/evidence/:id/original",
      "/v1/evidence/:id/verification-package",
    ],
  ],
  ["../src/routes/redaction.routes.ts", ["/v1/redaction/derivatives/:id/download-url"]],
  ["../src/routes/external-review.routes.ts", ["/v1/external-review/access/:token/verification-package"]],
  ["../src/routes/external-portal.routes.ts", ["/v1/portal/work/:workflowId/verification-package"]],
  ["../src/routes/organizations.routes.ts", ["/v1/orgs/:id/data-export/:requestId/links"]],
];

describe("D-05 — presigned download URLs are never cacheable", () => {
  it("the helper sets Cache-Control: no-store on the reply", () => {
    const headers: Record<string, string> = {};
    const reply = {
      header(name: string, value: string) {
        headers[name] = value;
        return reply;
      },
    };
    expect(noStorePresignedResponse(reply as never)).toBe(reply);
    expect(headers).toEqual({ "Cache-Control": "no-store" });
    expect(PRESIGNED_RESPONSE_CACHE_CONTROL).toBe("no-store");
  });

  for (const [file, paths] of ROUTES) {
    const src = read(file);
    for (const path of paths) {
      it(`${path} marks its 200 no-store before sending the URL`, () => {
        const body = handler(src, path);
        const marked = body.indexOf("noStorePresignedResponse(reply);");
        expect(marked, `${path} sends a presigned URL without no-store`).toBeGreaterThan(-1);
        // Set before the success body that carries the URL is sent.
        expect(body.indexOf("reply.code(200).send(", marked)).toBeGreaterThan(marked);
      });
    }
  }

  it("the combined-recording URL route keeps its own private, no-store", () => {
    expect(read("../src/routes/media-intelligence.routes.ts")).toMatch(
      /reply\.header\("cache-control", "private, no-store"\);[\s\S]{0,120}reply\.code\(200\)\.send\(\{\s*evidenceId,\s*url,/,
    );
  });
});
