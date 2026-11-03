/**
 * NO ROUTE FILE NAMES A RECORD WITHOUT SAYING WHO DECIDES (RC-CASE-REACH).
 *
 * The finding's root cause was that reach is opt-in. Every route file that
 * serves `:evidenceId` or `/evidence/:id` must install the guard, or be listed
 * here with the authority it uses, or the suite fails. New files cannot
 * quietly fall back to workspace scope.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { registrationsByOperation } from "./_canonical-facts.js";

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
  let registrations: Map<string, string[]>;

  // The inventory parses every route file in the service: seconds of AST work,
  // more on a shared CI runner, where it exceeded the 5s test default. It runs
  // once here with the budget phase-r9-duplicate-route-guard gives the same
  // parse; the assertions below keep the default.
  beforeAll(() => {
    registrations = registrationsByOperation();
  }, 60_000);

  it("every file serving a record installs the guard or names its authority", () => {
    const files = new Set<string>();
    for (const [operation, registeringFiles] of registrations) {
      if (!/:evidenceId\b|\/evidence\/:id\b/.test(operation)) continue;
      for (const registering of registeringFiles) files.add(registering);
    }
    expect(files.size).toBeGreaterThan(10);
    const missing: string[] = [];
    for (const registering of files) {
      const file = basename(registering);
      const src = readFileSync(resolve(routesDir, file), "utf8");
      if (/installRecordReachGuard\(app\)/.test(src)) continue;
      if (OWN_AUTHORITY[file]?.test(src)) continue;
      if (TOKEN_SCOPED.has(file)) continue;
      missing.push(file);
    }
    expect(missing).toEqual([]);
  });

  it("every redaction route keyed by a record row is listed with the row it names", () => {
    const registry = readFileSync(
      resolve(routesDir, "../services/redaction/redaction-record-reach.service.ts"),
      "utf8",
    );
    const keyed = [...registrations.keys()].filter((operation) =>
      /^[A-Z]+ \/v1\/redaction\/(?:projects|versions|regions|detections|derivatives|video-tracks)\/:id/.test(operation),
    );
    expect(keyed.length).toBeGreaterThan(15);
    const unlisted = keyed.filter((route) => !registry.includes(`"${route}"`));
    expect(unlisted).toEqual([]);
  });
});
