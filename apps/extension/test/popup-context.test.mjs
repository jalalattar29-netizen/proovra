/**
 * UC-EXT-001 / UC-EXT-002 / UC-EXT-010 — the popup parses the REAL
 * /v1/platform/context contract. It used to read `body.workspaces ?? body.teams`,
 * keys the envelope never carried, so every user saw "No workspace available";
 * and every failure (401, 5xx, offline) became that same empty list.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyCasesResponse,
  classifyContextResponse,
  parseCaptureWorkspaces,
  parseEligibleCases,
} from "./dist/popup-context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const envelope = JSON.parse(readFileSync(resolve(HERE, "fixtures/platform-context.envelope.json"), "utf8"));

test("lists the capture-eligible workspaces from availableWorkspaces and preselects activeSpace", () => {
  const { workspaces, activeId } = parseCaptureWorkspaces(envelope);
  assert.deepEqual(
    workspaces.map((w) => w.name),
    ["Personal Space", "Acme Investigations", "Workspace"],
    "a VIEWER cannot record evidence, so that workspace is not offered",
  );
  assert.equal(activeId, "5d1f2a3b-0000-4c11-8a22-000000000002");
});

test("a valid member is never shown an empty list", () => {
  const r = classifyContextResponse(200, envelope);
  assert.equal(r.kind, "ok");
  assert.ok(r.workspaces.length > 0);
});

test("401 is a sign-in state, not 'no workspace'", () => {
  assert.deepEqual(classifyContextResponse(401, { code: "UNAUTHORIZED" }), { kind: "signed_out" });
});

test("5xx and network failure are an error state, not an empty list", () => {
  assert.deepEqual(classifyContextResponse(500, null), { kind: "error", status: 500 });
  assert.deepEqual(classifyContextResponse(503, null), { kind: "error", status: 503 });
  assert.deepEqual(classifyContextResponse(null, null), { kind: "error", status: null });
});

test("an activeSpace the user cannot capture into is not preselected", () => {
  const e = { ...envelope, activeSpace: { type: "ORGANIZATION", id: "5d1f2a3b-0000-4c11-8a22-000000000003" } };
  assert.equal(parseCaptureWorkspaces(e).activeId, "5d1f2a3b-0000-4c11-8a22-000000000001");
});

test("the popup's parsed keys exist in the server's PlatformContextEnvelope type", () => {
  const types = readFileSync(
    resolve(HERE, "../../../services/api/src/services/platform-context/types.ts"),
    "utf8",
  );
  const env = types.slice(types.indexOf("export type PlatformContextEnvelope = {"));
  assert.match(env, /\n\s+availableWorkspaces: ReadonlyArray<PlatformContextAvailableWorkspace>;/);
  assert.match(env, /\n\s+activeSpace: PlatformContextActiveSpace;/);
  const aw = types.slice(types.indexOf("export type PlatformContextAvailableWorkspace = {"));
  for (const k of ["id: string;", "name: string | null;", "scope: WorkspaceScope;", "role: WorkspaceRole | null;"]) {
    assert.ok(aw.slice(0, 200).includes(k), `PlatformContextAvailableWorkspace.${k}`);
  }
});

test("the popup no longer reads the invented `workspaces` / `teams` keys", () => {
  const popup = readFileSync(resolve(HERE, "../src/popup.ts"), "utf8");
  assert.equal(/body\.workspaces|body\.teams/.test(popup), false);
});

test("cases: only the selected workspace's open cases are offered (UC-EXT-010)", () => {
  const body = {
    items: [
      { id: "c1", name: "Matter A", teamId: "t1", status: "OPEN" },
      { id: "c2", name: "Matter B", teamId: "t2", status: "OPEN" },
      { id: "c3", name: "Closed matter", teamId: "t1", status: "CLOSED" },
      { id: "c4", name: "Archived", teamId: "t1", status: "ARCHIVED" },
      { id: "c5", name: "In review", teamId: "t1", status: "IN_REVIEW" },
    ],
  };
  assert.deepEqual(parseEligibleCases(body, "t1").map((c) => c.id), ["c1", "c5"]);
  assert.deepEqual(classifyCasesResponse(401, null, "t1"), { kind: "signed_out" });
  assert.deepEqual(classifyCasesResponse(500, null, "t1"), { kind: "error", status: 500 });
});
