/**
 * Intake Links — location collection source-contract.
 *
 * Pins the wires between schema, shared enums, public projection,
 * submit Zod body, REQUIRED-gate, Evidence storage, and source-label
 * display. Failure of any pin signals a regression that would either
 * break the public contributor flow or silently downgrade the
 * privacy / honesty guarantees on which the feature is sold.
 *
 * Invariants:
 *   1. Shared enums exist and the three policies (NONE / OPTIONAL /
 *      REQUIRED) are stable strings.
 *   2. Prisma schema carries WorkflowIntakeLink.locationPolicy (default
 *      NONE) and Evidence.locationSource.
 *   3. Create route accepts + persists locationPolicy.
 *   4. Public projection (contributor view) surfaces locationPolicy.
 *   5. Public submit route accepts the optional `location` body and
 *      passes it into submitExternalIntake.
 *   6. Orchestration emits `location_required` for REQUIRED links
 *      without GRANTED coordinates, AND writes lat/lng/accuracyMeters/
 *      locationSource = INTAKE_LINK_GEOLOCATION on success.
 *   7. Error mapper routes `location_required` to 412 LOCATION_REQUIRED
 *      with user-safe copy.
 *   8. Display layer reads `evidenceLocationSourceLabel(locationSource)`
 *      instead of the historical hard-coded CAPTURE label.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  INTAKE_LINK_LOCATION_POLICIES,
  EVIDENCE_LOCATION_SOURCES,
  INTAKE_LOCATION_CONSENT_STATES,
  evidenceLocationSourceLabel,
  isIntakeLinkLocationPolicy,
} from "@proovra/shared";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

describe("Intake Links — location collection contract", () => {
  it("shared enum values are stable", () => {
    assert.deepEqual(
      [...INTAKE_LINK_LOCATION_POLICIES],
      ["NONE", "OPTIONAL", "REQUIRED"],
    );
    assert.ok(EVIDENCE_LOCATION_SOURCES.includes("INTAKE_LINK_GEOLOCATION"));
    assert.ok(EVIDENCE_LOCATION_SOURCES.includes("CAPTURE_BROWSER_GEOLOCATION"));
    assert.deepEqual(
      [...INTAKE_LOCATION_CONSENT_STATES],
      ["NOT_REQUESTED", "GRANTED", "DENIED", "UNAVAILABLE"],
    );
    assert.equal(
      evidenceLocationSourceLabel("INTAKE_LINK_GEOLOCATION"),
      "Contributor browser permission",
    );
    assert.equal(
      evidenceLocationSourceLabel(null),
      "Location source not recorded",
      "a null source is not recorded — never a browser or secure-capture claim",
    );
    assert.ok(isIntakeLinkLocationPolicy("OPTIONAL"));
    assert.ok(!isIntakeLinkLocationPolicy("MAYBE"));
  });

  it("Prisma schema carries the new columns", () => {
    const schema = read("services/api/prisma/schema.prisma");
    assert.match(
      schema,
      /locationPolicy\s+String\s+@default\("NONE"\)\s+@map\("location_policy"\)/,
      "WorkflowIntakeLink must have locationPolicy with NONE default",
    );
    assert.match(
      schema,
      /locationSource\s+String\?\s+@map\("location_source"\)/,
      "Evidence must have nullable locationSource column",
    );
  });

  it("migration is additive + safe (default NONE + backfill)", () => {
    const mig = read(
      "services/api/prisma/migrations/20270825000000_intake_link_location_collection/migration.sql",
    );
    assert.match(mig, /ADD COLUMN IF NOT EXISTS "location_policy"/);
    assert.match(mig, /NOT NULL DEFAULT 'NONE'/);
    assert.match(mig, /ADD COLUMN IF NOT EXISTS "location_source"/);
    assert.match(mig, /UPDATE "evidence"/);
    assert.match(mig, /CAPTURE_BROWSER_GEOLOCATION/);
  });

  it("create route accepts + persists locationPolicy", () => {
    const route = read("services/api/src/routes/workflow-intake-links.routes.ts");
    assert.match(
      route,
      /locationPolicy:\s*z\.enum\(INTAKE_LINK_LOCATION_POLICIES\)\.optional\(\)/,
    );
    assert.match(route, /locationPolicy:\s*body\.locationPolicy/);

    const svc = read("services/api/src/services/workflow-intake-link.service.ts");
    assert.match(svc, /locationPolicy\?: IntakeLinkLocationPolicy/);
    assert.match(svc, /locationPolicy,/);
  });

  it("public projection surfaces locationPolicy", () => {
    const svc = read(
      "services/api/src/services/workflow-intake-session.service.ts",
    );
    assert.match(svc, /locationPolicy: string;/);
    assert.match(svc, /locationPolicy: link\.locationPolicy,/);

    const list = read(
      "services/api/src/services/intake-link-lifecycle.service.ts",
    );
    assert.match(list, /locationPolicy: string;/);
    assert.match(list, /locationPolicy: link\.locationPolicy,/);
  });

  it("submit route accepts an optional location body", () => {
    const route = read("services/api/src/routes/external-intake.routes.ts");
    assert.match(route, /const SubmitLocationBody = z/);
    assert.match(route, /const SubmitBody = z/);
    assert.ok(route.includes('"GRANTED"'));
    assert.ok(route.includes('"DENIED"'));
    assert.ok(route.includes('"UNAVAILABLE"'));
    assert.ok(route.includes('"NOT_REQUESTED"'));
    assert.match(route, /consentState:/);
    assert.match(route, /SubmitBody\.parse\(req\.body \?\? \{\}\)/);
    assert.match(
      route,
      // Pinned shape: link + session + location must always be
      // forwarded. Sibling fields (e.g. deviceTime, added in a later
      // phase) are allowed and don't invalidate this pin — the
      // contract here is "the location triplet survives", not "no
      // other fields exist".
      /submitExternalIntake\(\{[\s\S]{0,200}link,[\s\S]{0,200}session,[\s\S]{0,200}location,/,
    );
  });

  it("orchestration gates REQUIRED + writes location to Evidence", () => {
    const orch = read(
      "services/api/src/services/external-intake-orchestration.service.ts",
    );
    assert.match(
      orch,
      /"location_required"/,
      "code must exist in the error union",
    );
    assert.match(orch, /policy === "REQUIRED" && !shouldPersistLocation/);
    // F-01 (independent forward audit): the orchestration never writes the
    // location or device clock itself — a pre-seal write outside the record
    // lock let a retried submit rewrite a sealed record. It hands them to
    // completeEvidence, which writes them under the lock, while unsealed,
    // BEFORE the fingerprint is built — so the signed fingerprint carries them
    // and the report / package jobs (enqueued after that commit) read them.
    // Behaviour: test/forward/afc-intake-sealed-truth.integration.test.ts.
    // (createOrLoadExternalEvidence records the contributor's self-declared
    // email on the unsealed row; the SUBMIT writes nothing to it.)
    const submit = orch.slice(orch.indexOf("export async function submitExternalIntake("));
    assert.ok(!/client\.evidence\.update\(/.test(submit), "the submit must not write the evidence row");
    assert.match(orch, /captureContext,/, "the capture context is handed to completeEvidence");
    const complete = read("services/api/src/services/evidence-complete.service.ts");
    const sealStart = complete.indexOf("export async function completeEvidence(");
    const writeIdx = complete.indexOf("captureFacts.locationSource = intakeLinkLocationSourceFor(", sealStart);
    const deviceIdx = complete.indexOf("captureFacts.deviceTimeIso = ctx.deviceTimeIso", sealStart);
    const fingerprintIdx = complete.indexOf("buildFingerprint({", sealStart);
    assert.ok(writeIdx > 0 && deviceIdx > 0, "the seal writes the intake location and device clock");
    assert.ok(fingerprintIdx > writeIdx && fingerprintIdx > deviceIdx, "they are written before the fingerprint is built");
    assert.match(
      orch,
      /external_intake\.location\.attached/,
      "audit action for successful attach",
    );
    assert.match(
      orch,
      /accuracyBand/,
      "raw coordinates must NEVER be logged — only bucketed accuracy",
    );
  });

  it("submit route records capture environment as a fallback BEFORE submitExternalIntake", () => {
    const route = read("services/api/src/routes/external-intake.routes.ts");
    // The submit handler records capture environment when the first-part write
    // was missed, so capture-environment.json is reliably in the package. It
    // must run BEFORE submitExternalIntake (which enqueues the package job).
    assert.match(route, /ev\.captureEnvironment == null/);
    const submitIdx = route.indexOf("const result = await submitExternalIntake({");
    const fallbackIdx = route.indexOf("ev.captureEnvironment == null");
    assert.ok(submitIdx > 0 && fallbackIdx > 0, "both markers present");
    assert.ok(
      fallbackIdx < submitIdx,
      "capture-environment fallback must run before submitExternalIntake enqueues the package job",
    );
  });

  it("public submit response maps location_required → 412 LOCATION_REQUIRED", () => {
    const route = read("services/api/src/routes/external-intake.routes.ts");
    assert.match(route, /case "location_required":/);
    assert.match(route, /code:\s*"LOCATION_REQUIRED"/);
    assert.match(route, /reply\.code\(412\)/);
    assert.match(
      route,
      /case "LOCATION_REQUIRED":[\s\S]*Sharing your location is required/,
      "user-safe copy required",
    );
  });

  it("display layer reads provenance-aware source label", () => {
    const evRoute = read("services/api/src/routes/evidence.routes.ts");
    assert.match(
      evRoute,
      /evidenceLocationSourceLabel\(evidence\.locationSource\)/,
      "review-workspace projection must use the shared helper",
    );
    // verify route also reads the same helper
    const matches = evRoute.match(/evidenceLocationSourceLabel\(/g);
    assert.ok(
      matches && matches.length >= 2,
      "both review-workspace AND verify projections must read provenance-aware label",
    );
  });

  it("the map states the record's OWN source label, and never invents one", () => {
    const panel = read(
      "apps/web/components/capture-location/CaptureLocationMapPanel.tsx",
    );
    assert.match(panel, /sourceLabel\?: string \| null/, "prop is optional so legacy callers compile unchanged");
    // 2026-10-17: an omitted source is omitted; an explicit null is "not
    // recorded" — the generic capture label is no longer claimed for a record.
    assert.ok(panel.includes('props.sourceLabel === undefined ? null : (props.sourceLabel ?? "Location source not recorded")'));
    assert.ok(!panel.includes("props.sourceLabel ?? display.sourceLabel"));
  });

  it("the create wizard renders the Location collection card-radio", () => {
    // The admin surface was rebuilt as a four-step wizard: the location
    // control lives in step 3 and its default + payload live in the wizard's
    // pure state machine. The PROPERTIES pinned here are unchanged — one
    // labelled radio group driven by the shared options, defaulting to
    // OPTIONAL, with the policy carried on the create payload.
    const step = read(
      "apps/web/app/(app)/intake-links/_components/wizard/steps.tsx",
    );
    assert.match(step, /INTAKE_LINK_LOCATION_POLICY_OPTIONS/);
    assert.match(
      step,
      /name="location-policy"/,
      "the policy must be ONE labelled radio group",
    );
    assert.match(
      step,
      /testAttr="intake-link-location-card"/,
      "the stable per-option probe attribute must survive",
    );

    const state = read("apps/web/app/(app)/intake-links/_lib/wizardState.ts");
    assert.match(
      state,
      /locationPolicy: "OPTIONAL"/,
      "new links must DEFAULT to OPTIONAL in the UI",
    );
    assert.match(
      state,
      /locationPolicy: state\.locationPolicy/,
      "create payload must carry locationPolicy",
    );
  });

  it("report-v2 build-view-model is provenance-aware (no hardcoded CAPTURE label)", () => {
    const vm = read("services/worker/src/report-v2/build-view-model.ts");
    assert.match(
      vm,
      /evidenceLocationSourceLabel\(/,
      "report-v2 must read the shared helper, not hardcode CAPTURE label",
    );
    assert.ok(
      !vm.includes("sourceLabel: CAPTURE_LOCATION_SOURCE_LABEL"),
      "the hardcoded CAPTURE label assignment must be removed from build-view-model",
    );
    assert.match(
      vm,
      /isIntakeLinkLocationSource\(reportedLocationSource\)/,
      "intake-link branch must read the canonical source predicate (a browser or an app fix)",
    );
    assert.match(
      vm,
      /Upload session location/,
      "intake-link branch must use the contributor-attributed title",
    );
    // F-04 (independent forward audit): who measured the fix is stated by ONE
    // shared sentence — an app fix is never "the contributor's browser".
    assert.match(vm, /intakeLinkLocationProvenanceSentence\(reportedLocationSource\)/);
    assert.match(
      read("packages/shared/src/intake-link-location.ts"),
      /provided by the contributor\\?['’]s browser during upload/,
      "legally-careful body copy required for intake-link branch",
    );
    assert.ok(
      !vm.includes("proves where the evidence was captured"),
      "report-v2 must NOT overclaim physical-presence proof",
    );
  });

  it("processor selects + forwards locationSource into the report payload", () => {
    const proc = read("services/worker/src/processor.ts");
    assert.match(
      proc,
      /locationSource:\s*true,/,
      "Prisma select must include locationSource",
    );
    assert.match(
      proc,
      /locationSource:\s*evidence\.locationSource\s*\?\?\s*null/,
      "report payload must carry locationSource",
    );
    assert.match(
      proc,
      /locationSource:\s*\n\s*finalized\.finalizedReportEvidencePayload\.gps\s*\n\s*\.\s*locationSource\s*\?\?\s*null/,
      "verification-package metadata must carry locationSource through the finalized canonical lifecycle payload",
    );
  });

  it("verification-package also uses the shared source-label helper", () => {
    const pkg = read("services/worker/src/verification-package.ts");
    assert.match(pkg, /evidenceLocationSourceLabel\(/);
    assert.ok(
      !pkg.includes("source: CAPTURE_LOCATION_SOURCE_LABEL"),
      "hardcoded CAPTURE label assignment must be removed",
    );
  });

  it("public intake page only calls geolocation after a click", () => {
    const page = read("apps/web/app/intake/[token]/page.tsx");
    // The ONLY navigator.geolocation reference must live inside the
    // shareLocation handler (NOT inside useEffect).
    const geoCalls = page.match(/navigator\.geolocation\.getCurrentPosition/g);
    assert.ok(
      geoCalls && geoCalls.length === 1,
      "exactly one geolocation call site — must be inside the share handler, never in an effect",
    );
    assert.match(page, /function shareLocation\(\)/);
    assert.match(page, /<LocationCard/);
    // REQUIRED policy gates submit
    assert.match(page, /locationBlocksSubmit/);
    // submit body forwards optional location
    assert.match(page, /JSON\.stringify\(submitBody\)/);
    // LOCATION_REQUIRED is in the friendly catalog
    assert.match(page, /LOCATION_REQUIRED:/);
  });
});
