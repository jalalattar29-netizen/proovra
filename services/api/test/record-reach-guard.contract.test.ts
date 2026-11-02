/**
 * NO ROUTE FILE NAMES A RECORD WITHOUT SAYING WHO DECIDES (RC-CASE-REACH).
 *
 * The finding's root cause was that reach is opt-in. Every route file that
 * serves `:evidenceId` or `/evidence/:id` must install the guard, or be listed
 * here with the authority it uses, or the suite fails. New files cannot
 * quietly fall back to workspace scope.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const routesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/routes");

/** Files with their own per-route authority, and what it is. */
const OWN_AUTHORITY: Record<string, RegExp> = {
  "evidence.routes.ts": /getEvidenceWithReadAccess|resolveEvidenceRecordAccess/,
  "evidence-retention-verification.routes.ts": /resolveEvidenceOperationAccess/,
  "verification-share.routes.ts": /resolveEvidenceOperationAccess/,
  "ai-evidence.routes.ts": /evidenceClosedTo/,
  "cases.routes.ts": /authorizeCaseEvidenceLink/,
  "case-workspace.routes.ts": /authorizeCaseEvidenceLink|gateCaseMutation/,
  "reviewer-workspace.routes.ts": /viewerUserId: ctx\.userId/,
  "search.routes.ts": /actorUserId: actor\.userId|evidenceClosedTo/,
  "graph.routes.ts": /resolveGraphReach/,
  "review-operations.routes.ts": /recordOpen\(/,
  "integrations-api.routes.ts": /evidenceClosedTo\(id, null\)/,
};

/** Public or token-scoped: no signed-in member, so a token authority decides. */
const TOKEN_SCOPED = new Set(["external-review.routes.ts", "public-verify.routes.ts"]);

describe("record routes", () => {
  it("every file serving a record installs the guard or names its authority", () => {
    const missing: string[] = [];
    for (const file of readdirSync(routesDir)) {
      if (!file.endsWith(".ts")) continue;
      const src = readFileSync(resolve(routesDir, file), "utf8");
      const names = /app\.(get|post|put|patch|delete)\(\s*"[^"]*(:evidenceId\b|\/evidence\/:id\b)/.test(src);
      if (!names) continue;
      if (/installRecordReachGuard\(app\)/.test(src)) continue;
      if (OWN_AUTHORITY[file]?.test(src)) continue;
      if (TOKEN_SCOPED.has(file)) continue;
      missing.push(file);
    }
    expect(missing).toEqual([]);
  });

  it("every redaction route keyed by a record row is listed with the row it names", () => {
    const src = readFileSync(resolve(routesDir, "redaction.routes.ts"), "utf8");
    const registry = readFileSync(
      resolve(routesDir, "../services/redaction/redaction-record-reach.service.ts"),
      "utf8",
    );
    const keyed = [...src.matchAll(/app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*"(\/v1\/redaction\/(?:projects|versions|regions|detections|derivatives|video-tracks)\/:id[^"]*)"/g)];
    expect(keyed.length).toBeGreaterThan(15);
    const unlisted = keyed
      .map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)
      .filter((route) => !registry.includes(`"${route}"`));
    expect(unlisted).toEqual([]);
  });
});
