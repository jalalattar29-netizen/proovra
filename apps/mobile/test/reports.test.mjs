/**
 * Reports & artifacts projections — behavioural.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/reports.ts"), "utf8").replace(
  /^import type .*$/m,
  "",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const R = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const envelope = (over = {}) => ({
  sections: {
    summary: {
      status: "ok",
      data: {
        reportsReady: 12,
        reportsPending: 2,
        packagesReady: 3,
        packagesPending: 1,
        packagesBlocked: 0,
        totalEvidenceWithArtifacts: 15,
      },
    },
    artifacts: { status: "ok", items: [], nextCursor: null, total: 0 },
    ...over,
  },
});

/* ------------------------------------------------------------ display title */

test("the display title follows the canonical cascade", () => {
  // Reading `title` alone is what filled the web page with "Untitled evidence".
  assert.equal(R.resolveDisplayTitle({ title: "Roof damage" }), "Roof damage");
  assert.equal(R.resolveDisplayTitle({ title: null, displayFileName: "IMG_0042.jpg" }), "IMG_0042.jpg");
  assert.equal(
    R.resolveDisplayTitle({ title: null, displayFileName: null, originalFileName: "scan.pdf" }),
    "scan.pdf",
  );
  assert.equal(R.resolveDisplayTitle({}), "Untitled evidence");
});

test("a whitespace-only title falls through rather than rendering blank", () => {
  assert.equal(R.resolveDisplayTitle({ title: "   ", displayFileName: "real.jpg" }), "real.jpg");
});

/* ----------------------------------------------------------------- summary */

test("the six canonical counters are projected in the web's order", () => {
  assert.deepEqual(
    R.REPORTS_METRICS.map((m) => m.label),
    [
      "Reports generated",
      "Reports pending",
      "Packages ready",
      "Packages pending",
      "Packages blocked",
      "Evidence with artifacts",
    ],
  );
  const s = R.parseReportsSummary(envelope());
  assert.equal(s.reportsReady, 12);
  assert.equal(s.packagesBlocked, 0, "a real zero is a zero");
});

test("an unavailable summary section yields null, not zeroes", () => {
  // Rendering six zeroes for a section that failed to load is a lie.
  assert.equal(R.parseReportsSummary(envelope({ summary: { status: "unavailable", data: null } })), null);
  assert.equal(R.parseReportsSummary({}), null);
  assert.equal(R.parseReportsSummary(null), null);
});

/* --------------------------------------------------------------- artifacts */

test("artifact rows carry a resolved title and the linked case", () => {
  const page = R.parseArtifacts(
    envelope({
      artifacts: {
        status: "ok",
        total: 42,
        nextCursor: "cur-2",
        items: [
          {
            evidenceId: "ev-1",
            title: null,
            displayFileName: "IMG_0042.jpg",
            type: "PHOTO",
            status: "SIGNED",
            caseId: "c-1",
            caseTitle: "Leaking roof",
            reportState: "READY",
          },
        ],
      },
    }),
  );
  assert.equal(page.items[0].displayTitle, "IMG_0042.jpg");
  assert.equal(page.items[0].caseTitle, "Leaking roof");
  assert.equal(page.nextCursor, "cur-2");
  assert.equal(page.total, 42, "total is the workspace count for the query, not this page");
});

test("an unavailable list is distinguished from an empty one", () => {
  // "Nothing here" and "this failed to load" are different facts.
  const dead = R.parseArtifacts(envelope({ artifacts: { status: "unavailable", items: [], total: null } }));
  assert.equal(dead.unavailable, true);
  assert.equal(dead.total, null);

  const empty = R.parseArtifacts(envelope());
  assert.equal(empty.unavailable, false);
  assert.equal(empty.total, 0);
});

test("a malformed envelope degrades instead of throwing", () => {
  assert.deepEqual(R.parseArtifacts(null).items, []);
  assert.deepEqual(R.parseArtifacts({ sections: { artifacts: { items: "nope" } } }).items, []);
});

/* -------------------------------------------------------------- row state */

const row = (over) => ({ evidenceId: "e", displayTitle: "t", type: "PHOTO", status: "SIGNED", verificationStatus: null, caseId: null, caseTitle: null, reportState: null, packageState: null, ...over });

test("a blocked package is the fact worth surfacing, above any ready report", () => {
  assert.deepEqual(R.artifactRowState(row({ packageState: "BLOCKED", reportState: "READY" })), {
    label: "Package blocked",
    tone: "risk",
  });
});

test("a failed report outranks a pending package", () => {
  assert.equal(R.artifactRowState(row({ reportState: "FAILED", packageState: "PENDING" })).tone, "risk");
});

test("ready states read as verified; pending reads as pending", () => {
  assert.equal(R.artifactRowState(row({ packageState: "READY" })).label, "Package ready");
  assert.equal(R.artifactRowState(row({ reportState: "GENERATED" })).label, "Report ready");
  assert.equal(R.artifactRowState(row({ reportState: "PENDING" })).tone, "pending");
});

test("a row with no artifact state says so rather than implying progress", () => {
  assert.deepEqual(R.artifactRowState(row({})), { label: "No artifact yet", tone: "neutral" });
});

/* ----------------------------------------------------------------- query */

test("no workspace means no request", () => {
  assert.equal(R.buildReportsPath({ teamId: null }), null);
});

test("the lifecycle filter narrows the query; 'all' sends nothing", () => {
  const all = R.buildReportsPath({ teamId: "t1", filter: "all" });
  assert.equal(all.includes("lifecycle="), false);
  const one = R.buildReportsPath({ teamId: "t1", filter: "package_blocked" });
  assert.ok(one.includes("lifecycle=package_blocked"));
});

test("the cursor is sent only when paging", () => {
  assert.equal(R.buildReportsPath({ teamId: "t1" }).includes("cursor="), false);
  assert.ok(R.buildReportsPath({ teamId: "t1", cursor: "c2" }).includes("cursor=c2"));
});

test("the filter list matches the canonical lifecycle vocabulary", () => {
  assert.deepEqual(
    R.REPORTS_FILTERS.map((f) => f.value),
    ["all", "report_ready", "report_pending", "report_failed", "package_ready", "package_pending", "package_blocked"],
  );
});
