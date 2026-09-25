/**
 * CAPTURE PLAN — and a drift guard against the web source.
 *
 * `captureReadiness.ts` armours itself against one bug class, in its own
 * words: "Duplicating the predicate is the bug class this file is now armoured
 * against." Native cannot import from apps/web at runtime, so the guard is
 * here instead: these tests READ the web source and assert the native module
 * agrees with it. A change on either side fails a test rather than quietly
 * producing a different answer on the phone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/product/capture-plan.ts"), "utf8");
const js = ts.transpileModule(SRC, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const P = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const WEB = resolve(HERE, "../../../apps/web/app/(app)/capture/_lib");
const readinessSrc = readFileSync(resolve(WEB, "captureReadiness.ts"), "utf8");
const stagesSrc = readFileSync(resolve(WEB, "captureIntakeStages.ts"), "utf8");
const suggestionsSrc = readFileSync(resolve(WEB, "captureSuggestions.ts"), "utf8");

const item = (over = {}) => ({
  checklistStepId: null,
  role: null,
  privateNote: null,
  sourceLabel: null,
  locationIncluded: false,
  duplicateStatus: null,
  ...over,
});

/* ------------------------------------------------------------ drift guards */

test("the primary-step predicate is the web's, character for character", () => {
  // The web source carries `/^primary[_-]/i`. A native regex that drifted
  // would answer differently for the same step id.
  assert.match(readinessSrc, /\/\^primary\[_-\]\/i/);
  assert.match(SRC, /\/\^primary\[_-\]\/i/);
});

test("the supporting prefixes are the web's three", () => {
  for (const prefix of ["supporting_", "context_", "witness_"]) {
    assert.ok(readinessSrc.includes(`"${prefix}"`), `web lost ${prefix}`);
    assert.ok(SRC.includes(`"${prefix}"`), `native lost ${prefix}`);
  }
});

test("the canonical criteria are the web's three, and no more", () => {
  const after = readinessSrc.slice(readinessSrc.indexOf("CANONICAL_CRITERION_IDS"));
  // From the assignment, not the first bracket — the declaration reads
  // `: string[] = [`, and the type bracket is not the array.
  const start = after.indexOf("= [") + 2;
  const literal = after.slice(start, after.indexOf("]", start) + 1);
  const webIds = [...literal.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...P.CANONICAL_CRITERION_IDS], webIds);
  // A criterion invented natively would be a demand the web does not make.
  assert.equal(P.CANONICAL_CRITERION_IDS.length, 3);
});

test("the readiness thresholds are the web's", () => {
  assert.match(readinessSrc, /ratio >= 0\.99/);
  assert.match(readinessSrc, /ratio >= 0\.5/);
  assert.match(SRC, /ratio >= 0\.99/);
  assert.match(SRC, /ratio >= 0\.5/);
});

test("the five stage ids and labels are the web's", () => {
  for (const [id, label] of [
    ["select_template", "Select template"],
    ["add_materials", "Add materials"],
    ["map_context", "Add context"],
    ["review_readiness", "Review readiness"],
    ["finish", "Finish & sign"],
  ]) {
    assert.ok(stagesSrc.includes(`"${label}"`), `web lost ${label}`);
    assert.ok(SRC.includes(`"${label}"`), `native lost ${label}`);
    assert.ok(SRC.includes(id), `native lost ${id}`);
  }
});

test("the suggestion catalogue is keyed on the criteria, as the web keys it", () => {
  assert.match(suggestionsSrc, /Suggestions are NEVER blocking/);
  for (const id of P.CANONICAL_CRITERION_IDS) {
    assert.ok(suggestionsSrc.includes(`${id}: {`), `web lost the ${id} suggestion`);
  }
});

/* ------------------------------------------------------------- the module */

test("no native seed catalogue exists", () => {
  // The server is the source of truth. A second catalogue on the device would
  // be a second authority, and a stale copy shown as current is worse than
  // saying the catalogue could not be read.
  assert.doesNotMatch(SRC, /COLLECTION_PLAN_TEMPLATES/);
  assert.equal(P.INTAKE_TEMPLATES_PATH, "/v1/capture/intake-templates");
});

test("the server's template shape is projected, version included", () => {
  const [t] = P.parseIntakeTemplates({
    templates: [
      {
        templateId: "insurance-claim",
        templateVersion: 3,
        templateName: "Insurance Claim",
        description: "d",
        locationRequirement: "recommended",
        steps: [
          {
            id: "primary_overview_media",
            title: "Overview",
            description: "d",
            purposeLabel: "Overview",
            required: true,
            acceptedKinds: ["PHOTO", "VIDEO", "NOT_A_KIND"],
          },
          { title: "no id" },
        ],
      },
      { templateName: "no id" },
    ],
  });
  assert.equal(t.id, "insurance-claim");
  assert.equal(t.version, 3);
  assert.equal(t.steps.length, 1);
  // An unknown kind is dropped rather than carried into an accepted-kinds gate.
  assert.deepEqual(t.steps[0].acceptedKinds, ["PHOTO", "VIDEO"]);
});

test("an unrecognised location requirement reads as recommended", () => {
  const [t] = P.parseIntakeTemplates({
    templates: [{ templateId: "x", locationRequirement: "sometimes" }],
  });
  assert.equal(t.locationRequirement, "recommended");
});

test("the ROLE string satisfies primary, which is the load-bearing branch", () => {
  // A template whose server step ids do not follow primary_* — Insurance
  // Claim ships overview_media, Incident ships scene_overview — defeats the
  // prefix test, and the surface would keep asking for a primary item the
  // operator had already marked.
  assert.equal(P.hasPrimaryEvidence([item({ role: "Primary evidence" })]), true);
  assert.equal(
    P.hasPrimaryEvidence([item({ checklistStepId: "overview_media", role: "Primary evidence" })]),
    true,
  );
  assert.equal(P.hasPrimaryEvidence([item({ checklistStepId: "primary_media" })]), true);
  assert.equal(P.hasPrimaryEvidence([item({ role: "Supporting evidence" })]), false);
  assert.equal(P.hasPrimaryEvidence([]), false);
});

test("a step's role falls back to required when it follows no convention", () => {
  const step = (over) => ({
    id: "x",
    title: "t",
    description: "",
    purposeLabel: "t",
    required: false,
    acceptedKinds: [],
    ...over,
  });
  assert.equal(P.roleFromChecklistStep(step({ id: "primary_media" })), "Primary");
  assert.equal(P.roleFromChecklistStep(step({ id: "context_statement" })), "Supporting");
  assert.equal(P.roleFromChecklistStep(step({ id: "overview_media", required: true })), "Primary");
  assert.equal(P.roleFromChecklistStep(step({ id: "overview_media" })), "Supporting");
  assert.equal(P.roleForStep(step({ id: "primary_media" })), "Primary evidence");
});

test("readiness counts the three criteria and levels on the ratio", () => {
  const empty = P.computeCaptureReadiness([]);
  // An empty session already satisfies "no duplicate warnings" — vacuously,
  // and that is the web's arithmetic too.
  assert.equal(empty.score.total, 3);
  assert.equal(empty.level, "draft");

  const developing = P.computeCaptureReadiness([item({ role: "Primary evidence" })]);
  assert.equal(developing.score.satisfied, 2);
  assert.equal(developing.level, "developing");

  const ready = P.computeCaptureReadiness([
    item({ role: "Primary evidence", privateNote: "Taken at the scene" }),
  ]);
  assert.equal(ready.level, "ready");
});

test("a duplicate-flagged item blocks that criterion and nothing else", () => {
  const r = P.computeCaptureReadiness([
    item({ role: "Primary evidence", privateNote: "n", duplicateStatus: "duplicate" }),
  ]);
  assert.equal(r.criteria.find((c) => c.id === "no_duplicate_warnings").satisfied, false);
  assert.equal(r.criteria.find((c) => c.id === "has_primary").satisfied, true);
  assert.equal(r.level, "developing");
});

test("readiness says what it is not", () => {
  // Operational completeness, never an admissibility or authenticity claim.
  assert.match(P.READINESS_BOUNDARY, /not a statement about/i);
  assert.match(P.READINESS_BOUNDARY, /admissibility/i);
  assert.doesNotMatch(P.readinessLabel("ready"), /verified|authentic|admissible/i);
});

test("a satisfied criterion produces no suggestion, and the cap holds", () => {
  const none = P.computeCaptureSuggestions(
    P.computeCaptureReadiness([item({ role: "Primary evidence", privateNote: "n" })]),
  );
  assert.equal(none.length, 0);

  const all = P.computeCaptureSuggestions(P.computeCaptureReadiness([]));
  assert.equal(all.length, 2);
  assert.equal(P.computeCaptureSuggestions(P.computeCaptureReadiness([]), 1).length, 1);
});

test("the stage rail always returns five, in order, and never completes finish", () => {
  const stages = P.computeIntakeStages({
    items: [],
    templateSelected: false,
    readiness: P.computeCaptureReadiness([]),
  });
  assert.equal(stages.length, 5);
  assert.deepEqual(stages.map((s) => s.id), [
    "select_template",
    "add_materials",
    "map_context",
    "review_readiness",
    "finish",
  ]);
  assert.equal(stages[0].status, "active");
  // The operator finalises through the capture controls; the rail must never
  // be the thing that decides whether they may.
  assert.equal(stages[4].status, "pending");
});

test("the rail advances with the session, and says it is only a guide", () => {
  const items = [item({ role: "Primary evidence", privateNote: "n" })];
  const stages = P.computeIntakeStages({
    items,
    templateSelected: true,
    readiness: P.computeCaptureReadiness(items),
  });
  assert.equal(stages[0].status, "complete");
  assert.equal(stages[1].status, "complete");
  assert.equal(stages[2].status, "complete");
  assert.equal(stages[3].status, "complete");
  assert.equal(stages[4].status, "active");
  assert.match(P.STAGE_RAIL_BOUNDARY, /whenever you are ready/i);
});

test("context counts a note, a source label OR location", () => {
  const readiness = P.computeCaptureReadiness([]);
  for (const over of [
    { privateNote: "n" },
    { sourceLabel: "Phone camera" },
    { locationIncluded: true },
  ]) {
    const stages = P.computeIntakeStages({
      items: [item(over)],
      templateSelected: true,
      readiness,
    });
    assert.equal(stages[2].status !== "pending", true, JSON.stringify(over));
  }
});

test("the snapshot records the template and its version, or nothing", () => {
  assert.deepEqual(P.buildTemplateSnapshot(null), {});
  assert.deepEqual(P.buildTemplateSnapshot({ id: "t1", version: 4 }), {
    collectionPlanTemplateId: "t1",
    collectionPlanTemplateVersion: 4,
  });
  // A template the server sent without a version records the id alone rather
  // than inventing a version number.
  assert.deepEqual(P.buildTemplateSnapshot({ id: "t1", version: null }), {
    collectionPlanTemplateId: "t1",
  });
});

/* ------------------------------------------- T-14 session readiness (web port) */

const PLAN = (locationRequirement) => ({
  id: "site", version: 1, name: "Site survey", description: "", locationRequirement,
  steps: [
    { id: "overview", title: "Overview", description: "", purposeLabel: "Overview", required: true, acceptedKinds: ["PHOTO"] },
    { id: "damage_close_up", title: "Close-up", description: "", purposeLabel: "Close-up", required: false, acceptedKinds: [] },
  ],
});

test("session readiness: empty is a blocker; FLEXIBLE never blocks on a missing required step", () => {
  const empty = P.buildSessionReadiness({ items: [], plan: PLAN("optional"), useLocation: false });
  assert.equal(empty.status, "empty");
  assert.equal(empty.canFinalize, false);
  const one = P.buildSessionReadiness({ items: [{ id: "a", mimeType: "application/pdf", checklistStepId: null }], plan: PLAN("optional"), useLocation: false });
  assert.equal(one.canFinalize, true, "a missing required step blocked a FLEXIBLE session");
  assert.equal(one.requiredCompleted, 0);
  assert.equal(one.requiredProgressPercent, 0);
  // Unmapped counts twice, exactly as the web counts it.
  assert.equal(one.warnings.length, 2);
  assert.equal(one.status, "warning");
});

test("session readiness: required location blocks, recommended warns; kinds and close-up are checked", () => {
  const items = [
    { id: "a", mimeType: "application/pdf", checklistStepId: "overview" },
    { id: "b", mimeType: "audio/m4a", checklistStepId: "damage_close_up" },
  ];
  const req = P.buildSessionReadiness({ items, plan: PLAN("required"), useLocation: false });
  assert.equal(req.canFinalize, false);
  assert.equal(req.blockers[0].code, "capture_required_location_missing");
  assert.deepEqual(req.warnings.map((w) => w.label), ["Invalid file type", "Close-up requirement not satisfied (metadata-based)"]);
  assert.equal(req.warnings[0].detail, "Document does not match this requirement.");
  assert.equal(req.mappedCount, 2);
  assert.equal(req.requiredProgressPercent, 100);
  assert.equal(P.buildSessionReadiness({ items, plan: PLAN("required"), useLocation: true }).canFinalize, true);
  const rec = P.buildSessionReadiness({ items: [{ id: "c", mimeType: "image/jpeg", checklistStepId: "overview" }], plan: PLAN("recommended"), useLocation: false });
  assert.deepEqual(rec.warnings.map((w) => w.code), ["capture_recommended_location_missing"]);
  const clean = P.buildSessionReadiness({ items: [{ id: "c", mimeType: "image/jpeg", checklistStepId: "overview" }], plan: PLAN("optional"), useLocation: false });
  assert.equal(clean.status, "ready");
});

test("session id and size use the web formats", () => {
  assert.equal(P.formatCaptureSessionId(new Date(2026, 8, 4)), "CAP-2026-09-04");
  assert.equal(P.formatCaptureFileSize(0), "0 B");
  assert.equal(P.formatCaptureFileSize(2048), "2.0 KB");
  assert.equal(P.formatCaptureFileSize(5 * 1024 * 1024), "5.00 MB");
});
