/**
 * AUD-0062 — the case breadcrumb names the workspace that owns the case.
 *
 * The simple case view rendered the header's default, "Personal Space", for
 * every case, so an organization case read "Personal Space / Cases / …". Both
 * case views now resolve the label from `case.teamId` against the
 * server-authorized context options.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveCaseScopeLabel } from "../components/cases-experience/case-scope-label";

const HERE = dirname(fileURLToPath(import.meta.url));

const context = {
  personalSpace: { id: "ps-1" },
  contextOptions: {
    personalSpace: { workspaceId: "ps-1" },
    ownedWorkspaces: [{ workspaceId: "own-1", name: "Harbour Workspace" }],
    sharedWorkspaces: [{ workspaceId: "shared-1", name: "Dana's workspace" }],
    organizations: [
      { organizationId: "org-1", organizationName: "Northwind", workspaces: [{ workspaceId: "nw-1", workspaceName: "Northwind Legal" }] },
    ],
  },
  workspace: null,
} as never;

test("each case names the workspace that owns it", () => {
  assert.equal(resolveCaseScopeLabel("ps-1", context), "Personal Space");
  assert.equal(resolveCaseScopeLabel("nw-1", context), "Northwind Legal");
  assert.equal(resolveCaseScopeLabel("own-1", context), "Harbour Workspace");
  assert.equal(resolveCaseScopeLabel("shared-1", context), "Dana's workspace");
  // Unknown or loading never claims "Personal Space".
  assert.equal(resolveCaseScopeLabel("other", context), "Workspace");
  assert.equal(resolveCaseScopeLabel("nw-1", null), "Workspace");
});

test("the simple case view passes the resolved label; the header has no Personal Space default", () => {
  const src = readFileSync(
    resolve(HERE, "../components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx"),
    "utf8",
  );
  assert.match(src, /const scopeLabel = resolveCaseScopeLabel\(caseDetail\.teamId \?\? null, platformEnvelope\);/);
  assert.match(src, /scopeLabel=\{scopeLabel\}/);
  assert.doesNotMatch(src, /scopeLabel = "Personal Space"/);
});
