/**
 * SPACES — which tenant the user is in, and how they move.
 *
 * The envelope's own type warns that its legacy `organizations` array is named
 * after organizations but holds every non-personal WORKSPACE, with workspace
 * ids and workspace member counts. These tests hold the projection to the
 * CANONICAL block, where the distinction is structural.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/product/spaces.ts"), "utf8");
const js = ts.transpileModule(SRC, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const S = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const envelope = {
  activeSpace: { id: "w-personal" },
  canonical: {
    personalSpace: { workspaceId: "w-personal", name: "My space", plan: "PRO" },
    ownedWorkspaces: [{ workspaceId: "w-owned", name: "Field team", memberCount: 4 }],
    organizations: [{ organizationId: "org-1", name: "Acme Legal" }],
    organizationWorkspaces: [
      { workspaceId: "w-org", name: "Intake", organizationId: "org-1", memberCount: 12 },
    ],
  },
};

test("the three kinds of space are read from the canonical block", () => {
  const v = S.projectSpaces(envelope);
  assert.equal(v.personal.id, "w-personal");
  assert.equal(v.owned.length, 1);
  assert.equal(v.organization.length, 1);
  assert.equal(v.activeWorkspaceId, "w-personal");
});

test("an organization workspace carries its organization, as a separate id", () => {
  // The envelope's history records workspace ids sitting in a field named
  // after organizations and being handed to organization endpoints.
  const [org] = S.projectSpaces(envelope).organization;
  assert.equal(org.id, "w-org");
  assert.equal(org.organizationId, "org-1");
  assert.equal(org.organizationName, "Acme Legal");
});

test("a workspace with no id is dropped rather than rendered", () => {
  const v = S.projectSpaces({
    canonical: { ownedWorkspaces: [{ name: "no id" }, { workspaceId: "w1" }] },
  });
  assert.equal(v.owned.length, 1);
});

test("an absent Personal Space is absent, never substituted", () => {
  // An ENTERPRISE identity under a noPersonalSpace policy has none. Inventing
  // one would offer a space the server would refuse to switch to.
  const v = S.projectSpaces({ canonical: { personalSpace: null, ownedWorkspaces: [] } });
  assert.equal(v.personal, null);
  assert.equal(v.personalSpaceAbsent, true);
});

test("an empty envelope is not read as a missing Personal Space", () => {
  // Loading and "your policy gives you none" are different statements.
  const v = S.projectSpaces({});
  assert.equal(v.personal, null);
  assert.equal(v.personalSpaceAbsent, false);
});

test("the active space is not offered a switch", () => {
  const v = S.projectSpaces(envelope);
  assert.equal(S.isActiveSpace(v.personal, v), true);
  assert.equal(S.canSwitchTo(v.personal, v), false);
  assert.equal(S.canSwitchTo(v.owned[0], v), true);
});

test("the switch sends the WORKSPACE id to the canonical pointer", () => {
  assert.equal(S.SWITCH_WORKSPACE_PATH, "/v1/platform/context/switch-workspace");
  assert.deepEqual(S.buildSwitchWorkspaceBody("w-org"), { workspaceId: "w-org" });
});

test("a Personal Space is never labelled as a team or an organization", () => {
  assert.equal(S.spaceKindLabel("PERSONAL"), "Personal Space");
  assert.doesNotMatch(S.spaceKindLabel("PERSONAL"), /team|organization/i);
});

test("a Personal Space does not announce its one member", () => {
  const v = S.projectSpaces(envelope);
  assert.equal(S.spaceSummaryLine(v.personal), "PRO");
  assert.match(S.spaceSummaryLine(v.owned[0]), /4 members/);
});

test("an absent member count is absent, not zero members", () => {
  const [w] = S.projectSpaces({
    canonical: { ownedWorkspaces: [{ workspaceId: "w1", name: "x" }] },
  }).owned;
  assert.equal(w.memberCount, null);
  assert.equal(S.spaceSummaryLine(w), null);
});

test("spaces read in the order a person reads them", () => {
  assert.deepEqual(
    S.allSpaces(S.projectSpaces(envelope)).map((s) => s.id),
    ["w-personal", "w-owned", "w-org"],
  );
});

test("no create path exists, because POST /v1/teams always refuses", () => {
  // The route is a COMPATIBILITY_TOMBSTONE: its handler returns
  // 409 WORKSPACE_CREATION_NOT_SELF_SERVICE on every path. A control that can
  // only fail teaches the user the app is broken when the server is doing
  // exactly what it was asked to do.
  assert.equal(S.CREATE_WORKSPACE_PATH, undefined);
  assert.equal(S.buildCreateWorkspaceBody, undefined);
  assert.equal(S.validateNewWorkspaceName, undefined);
});

test("the surface says where a workspace does come from", () => {
  assert.match(S.WORKSPACE_CREATION_NOTE, /administrator|account contact/i);
});
