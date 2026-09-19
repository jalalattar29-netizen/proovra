/**
 * GUARD — native case-workspace projection (Master Program §6, Cases). Parses the
 * matter-workspace envelope's notes (sections.notes.caseComments) + active
 * assignments defensively, and resolves member names from case access[]. Pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/case-workspace.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const envelope = {
  sections: {
    notes: {
      caseComments: [
        { id: "n1", authorUserId: "u1", body: "First note", visibility: "ALL_MEMBERS", resolvedAtUtc: null, createdAt: "2026-09-19T10:00:00Z" },
        { id: "n2", authorUserId: "u2", body: "Resolved one", resolvedAtUtc: "2026-09-19T11:00:00Z", createdAt: "2026-09-19T09:00:00Z" },
        { id: 3, body: "bad id" }, // dropped
      ],
    },
  },
  assignments: [
    { id: "a1", assignedToUserId: "u2", role: "INVESTIGATOR", status: "ACTIVE", removedAtUtc: null, note: "lead" },
    { id: "a2", assignedToUserId: "u3", role: "REVIEWER", status: "ACTIVE", removedAtUtc: "2026-09-19T12:00:00Z", note: null }, // removed → dropped
  ],
};

test("parseCaseNotes reads caseComments, marks resolved, drops malformed", () => {
  const notes = mod.parseCaseNotes(envelope);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].body, "First note");
  assert.equal(notes[0].resolved, false);
  assert.equal(notes[1].resolved, true);
});

test("parseCaseAssignments returns only active (not removed) assignments", () => {
  const a = mod.parseCaseAssignments(envelope);
  assert.equal(a.length, 1);
  assert.equal(a[0].role, "INVESTIGATOR");
});

test("degraded / absent sections fail safe to empty", () => {
  assert.deepEqual(mod.parseCaseNotes(null), []);
  assert.deepEqual(mod.parseCaseNotes({ sections: {} }), []);
  assert.deepEqual(mod.parseCaseAssignments({}), []);
});

test("member names resolve from access[], else a short id", () => {
  const map = mod.buildMemberNameMap([
    { user: { id: "u1", displayName: "Alice" } },
    { user: { id: "u2", email: "bob@example.com" } },
  ]);
  assert.equal(mod.resolveMemberName(map, "u1"), "Alice");
  assert.equal(mod.resolveMemberName(map, "u2"), "bob@example.com");
  assert.match(mod.resolveMemberName(map, "u9-unknown-long-id"), /^u9-unkno…$/);
});
