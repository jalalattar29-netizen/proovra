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

/* ----------------------------------------------------------- cases summary */

/**
 * "unavailable" and "no cases" are different answers. A workspace whose
 * summary could not be computed must not be told it has no matters with
 * evidence — that is the four-zeroes failure this parse exists to prevent.
 */
test("an unavailable summary is not four zeroes", () => {
  assert.equal(
    mod.parseCasesSummary({ sections: { summary: { status: "unavailable", data: null } } }).phase,
    "unavailable",
  );
  // A section that sends no data at all is equally unavailable.
  assert.equal(mod.parseCasesSummary({ sections: { summary: {} } }).phase, "unavailable");
  assert.equal(mod.parseCasesSummary({}).phase, "unavailable");
});

test("a real summary of zero is reported as zero", () => {
  const s = mod.parseCasesSummary({
    sections: {
      summary: {
        status: "ok",
        data: {
          totalCases: 0,
          casesWithEvidence: 0,
          casesWithActiveHolds: 0,
          casesWithPendingReview: 0,
        },
      },
    },
  });
  assert.equal(s.phase, "ok");
  assert.equal(s.summary.totalCases, 0);
});

test("the counters are read under their canonical names", () => {
  const s = mod.parseCasesSummary({
    sections: {
      summary: {
        status: "ok",
        data: {
          totalCases: 12,
          casesWithEvidence: 9,
          casesWithActiveHolds: 2,
          casesWithPendingReview: 4,
        },
      },
    },
  });
  assert.deepEqual(s.summary, {
    totalCases: 12,
    casesWithEvidence: 9,
    casesWithActiveHolds: 2,
    casesWithPendingReview: 4,
  });

  const kpis = mod.casesSummaryKpis(s.summary);
  assert.deepEqual(kpis.map((k) => k.key), ["total", "evidence", "review", "holds"]);
  assert.equal(kpis[2].value, "4");
});

test("a single-occupant workspace is told apart from a shared one", () => {
  // There is nobody to assign a matter to in a single-occupant workspace, so
  // an assignment control there is an affordance with no possible target.
  assert.equal(mod.isSharedWorkspace({ workspace: { scope: "SHARED" } }), true);
  assert.equal(mod.isSharedWorkspace({ workspace: { scope: "SINGLE_OCCUPANT" } }), false);
  assert.equal(mod.isSharedWorkspace({}), false);
});

test("the summary path is workspace-scoped", () => {
  assert.equal(mod.buildCasesSummaryPath("t1"), "/v1/cases/summary?teamId=t1");
});

/* --------------------------------------- the viewer's own case capabilities */

test("absent capability flags mean NOT allowed", () => {
  // A client that defaulted to yes would offer a destructive action to
  // someone the server would refuse.
  const v = mod.parseCaseViewer(null);
  for (const k of [
    "canManage",
    "canMutate",
    "canAssign",
    "canChangeStatus",
    "canLinkEvidence",
    "canUnlinkEvidence",
    "canComment",
    "canResolveComment",
    "canManageAccess",
  ]) {
    assert.equal(v[k], false, `${k} defaulted to true`);
  }
});

test("the flags are read, never derived", () => {
  const v = mod.parseCaseViewer({
    viewer: { canComment: true, canResolveComment: true, canManage: false },
  });
  assert.equal(v.canComment, true);
  assert.equal(v.canResolveComment, true);
  // Not inferred from canComment, which would be the client deciding.
  assert.equal(v.canManage, false);
});

test("a denial carries the server's own reason, or none", () => {
  const v = mod.parseCaseViewer({
    viewer: { disabledReasons: { changeStatus: "This case is closed.", comment: "" } },
  });
  assert.equal(mod.caseDenialReason(v, "changeStatus"), "This case is closed.");
  // An empty string is not a reason.
  assert.equal(mod.caseDenialReason(v, "comment"), null);
  assert.equal(mod.caseDenialReason(v, "linkEvidence"), null);
});

/* --------------------------------------------------------- notes and bounds */

test("the note bounds are the route's own", () => {
  assert.equal(mod.CASE_NOTE_MAX, 4000);
  assert.match(mod.validateCaseNote("   "), /Write something/);
  assert.match(mod.validateCaseNote("x".repeat(4001)), /4000/);
  assert.equal(mod.validateCaseNote("A note"), null);
});

test("the notes boundary sentence is not optional copy", () => {
  // A private note beside integrity state reads as part of the record unless
  // something says it is not.
  assert.match(mod.CASE_NOTES_BOUNDARY, /private/i);
  assert.match(mod.CASE_NOTES_BOUNDARY, /do not change/i);
});

test("the note paths are the canonical ones", () => {
  assert.equal(mod.buildCaseCommentsPath("c1"), "/v1/cases/c1/comments");
  assert.equal(mod.buildCaseCommentPath("c1", "n1"), "/v1/cases/c1/comments/n1");
  assert.equal(mod.buildCaseCommentResolvePath("c1", "n1"), "/v1/cases/c1/comments/n1/resolve");
  assert.deepEqual(mod.buildResolveCommentBody(false), { resolved: false });
});

/* ---------------------------------------------------- reports and packages */

test("deliverables are counted from the envelope's own rows", () => {
  const d = mod.summariseCaseDeliverables({
    sections: {
      evidence: {
        items: [
          { reportReady: true, packageReady: true, verificationStatus: "VERIFIED" },
          { reportReady: true, packageReady: false },
          { reportReady: false, packageReady: false, verificationStatus: "FAILED" },
          { reportReady: true, packageReady: true, verificationStatus: "REVIEW_REQUIRED" },
        ],
      },
    },
  });
  assert.equal(d.total, 4);
  assert.equal(d.reportsReady, 3);
  assert.equal(d.packagesReady, 2);
  assert.equal(d.pending, 2);
  // REVIEW_REQUIRED counts with FAILED: both mean the record cannot be
  // treated as cleanly verified.
  assert.equal(d.failed, 2);
});

test("an envelope with no evidence section counts nothing, and does not throw", () => {
  const d = mod.summariseCaseDeliverables({});
  assert.equal(d.total, 0);
  assert.equal(d.failed, 0);
});

/* ------------------------------------------------------------- case settings */

test("a rename that changes nothing is not a request worth sending", () => {
  assert.match(mod.validateCaseName("  ", "Flood"), /needs a name/i);
  assert.match(mod.validateCaseName("Flood", "Flood"), /already the name/i);
  assert.equal(mod.validateCaseName("Flood 2", "Flood"), null);
  assert.deepEqual(mod.buildCaseRenameBody("  Flood 2 "), { name: "Flood 2" });
});

test("deleting a case says what happens to the evidence", () => {
  // The route unlinks evidence; it does not delete it. The difference is
  // between deleting a case and believing you destroyed your own records.
  assert.match(mod.DELETE_CASE_CONSEQUENCE, /will not delete preserved evidence/i);
  assert.match(mod.DELETE_CASE_CONSEQUENCE, /Evidence Library/);
});
