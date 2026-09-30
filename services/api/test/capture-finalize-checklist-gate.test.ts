/**
 * Phase CAPTURE-HARDENING — server-side required-checklist enforcement.
 *
 * Locks the contract added in evidence-complete.service.ts:
 * `validateRequiredChecklistMapping`. The validator is the single
 * source of truth for "would a finalize be allowed to proceed?",
 * so testing it directly proves the gate without spinning the full
 * Prisma transaction.
 *
 * Behaviour locked:
 *   1. CHECKLIST_REQUIRED + every required step mapped     → no missing
 *   2. CHECKLIST_REQUIRED + a required step missing        → missing list
 *   3. CHECKLIST_REQUIRED + only optional step missing     → no missing
 *      (the validator does not even inspect optionalSteps)
 *   4. FLEXIBLE mode                                       → enforced=false
 *   5. legacy / missing intakePlanJson                     → enforced=false
 *   6. CHECKLIST_REQUIRED but no required steps declared   → enforced=true,
 *      no missing (degenerate but safe)
 */

import { describe, expect, it } from "vitest";

import { validateRequiredChecklistMapping } from "../src/services/capture-checklist-gate.js";

describe("validateRequiredChecklistMapping", () => {
  const requiredSteps = [
    { id: "primary_evidence", title: "Primary evidence file" },
    { id: "context_photo", title: "Context photo" },
  ];

  it("CHECKLIST_REQUIRED + every required step mapped → no missing", () => {
    const verdict = validateRequiredChecklistMapping({
      intakePlanJson: { mode: "CHECKLIST_REQUIRED", requiredSteps },
      parts: [
        { checklistStepId: "primary_evidence" },
        { checklistStepId: "context_photo" },
        { checklistStepId: null },
      ],
    });
    expect(verdict.enforced).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it("CHECKLIST_REQUIRED + missing required step → surfaces stepId + label", () => {
    const verdict = validateRequiredChecklistMapping({
      intakePlanJson: { mode: "CHECKLIST_REQUIRED", requiredSteps },
      parts: [{ checklistStepId: "primary_evidence" }],
    });
    expect(verdict.enforced).toBe(true);
    expect(verdict.missing).toEqual([
      { stepId: "context_photo", label: "Context photo" },
    ]);
  });

  it("CHECKLIST_REQUIRED + multiple missing required steps → all surfaced", () => {
    const verdict = validateRequiredChecklistMapping({
      intakePlanJson: {
        mode: "CHECKLIST_REQUIRED",
        requiredSteps: [
          { id: "a", title: "Step A" },
          { id: "b", title: "Step B" },
          { id: "c", title: "Step C" },
        ],
      },
      parts: [{ checklistStepId: "a" }],
    });
    expect(verdict.missing.map((m) => m.stepId)).toEqual(["b", "c"]);
  });

  it("CHECKLIST_REQUIRED + only optional step missing → does not block", () => {
    // The validator NEVER reads optionalSteps; mapping an optional
    // step is the user's prerogative, not a finalize blocker.
    const verdict = validateRequiredChecklistMapping({
      intakePlanJson: {
        mode: "CHECKLIST_REQUIRED",
        requiredSteps: [{ id: "primary_evidence", title: "Primary" }],
        optionalSteps: [{ id: "supporting_doc", title: "Supporting" }],
      },
      parts: [{ checklistStepId: "primary_evidence" }],
    });
    expect(verdict.enforced).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it("FLEXIBLE mode → enforced=false (no gating, even with no parts mapped)", () => {
    const verdict = validateRequiredChecklistMapping({
      intakePlanJson: { mode: "FLEXIBLE", requiredSteps },
      parts: [{ checklistStepId: null }, { checklistStepId: null }],
    });
    expect(verdict.enforced).toBe(false);
    expect(verdict.missing).toEqual([]);
  });

  it("legacy evidence with no intakePlanJson → enforced=false (back-compat)", () => {
    // Older rows captured before this feature must still finalize.
    expect(
      validateRequiredChecklistMapping({ intakePlanJson: null, parts: [] }).enforced,
    ).toBe(false);
    expect(
      validateRequiredChecklistMapping({ intakePlanJson: undefined, parts: [] })
        .enforced,
    ).toBe(false);
    expect(
      validateRequiredChecklistMapping({ intakePlanJson: "not-an-object", parts: [] })
        .enforced,
    ).toBe(false);
  });

  it("CHECKLIST_REQUIRED with no required steps declared → enforced=true, no missing", () => {
    const verdict = validateRequiredChecklistMapping({
      intakePlanJson: { mode: "CHECKLIST_REQUIRED" },
      parts: [{ checklistStepId: null }],
    });
    expect(verdict.enforced).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it("trims whitespace on checklistStepId before matching", () => {
    const verdict = validateRequiredChecklistMapping({
      intakePlanJson: { mode: "CHECKLIST_REQUIRED", requiredSteps: [{ id: "a", title: "A" }] },
      parts: [{ checklistStepId: "  a  " }],
    });
    expect(verdict.missing).toEqual([]);
  });

  it("ignores requiredSteps entries with no id", () => {
    // A malformed plan whose entry has no `id` cannot be enforced
    // (we have nothing to match against), so it must be SKIPPED
    // rather than reported as missing — otherwise we'd produce an
    // unactionable 400.
    const verdict = validateRequiredChecklistMapping({
      intakePlanJson: {
        mode: "CHECKLIST_REQUIRED",
        requiredSteps: [{ id: 42 as unknown as string, title: "Bad step" }],
      },
      parts: [],
    });
    expect(verdict.missing).toEqual([]);
  });
});

// ---- ET-ACQ-05 — the server's plan, not only the client's --------------------
import { effectiveChecklistPlan } from "../src/services/capture-checklist-gate.js";

describe("ET-ACQ-05 — effectiveChecklistPlan", () => {
  const template = {
    steps: [
      { id: "a", title: "A", required: true },
      { id: "b", title: "B", required: false },
    ],
  };

  it("a CHECKLIST_REQUIRED session with a known template enforces the template's required steps when the client sent no plan", () => {
    const plan = effectiveChecklistPlan({ clientPlan: null, serverSession: { planMode: "CHECKLIST_REQUIRED" }, serverTemplate: template });
    expect(validateRequiredChecklistMapping({ intakePlanJson: plan, parts: [] })).toEqual({
      enforced: true,
      missing: [{ stepId: "a", label: "A" }],
    });
  });

  it("a client plan can add requirements but not remove the template's", () => {
    const plan = effectiveChecklistPlan({
      clientPlan: { mode: "FLEXIBLE", requiredSteps: [] },
      serverSession: { planMode: "CHECKLIST_REQUIRED" },
      serverTemplate: template,
    });
    expect(validateRequiredChecklistMapping({ intakePlanJson: plan, parts: [] }).missing.map((m) => m.stepId)).toEqual(["a"]);
    const stricter = effectiveChecklistPlan({
      clientPlan: { mode: "CHECKLIST_REQUIRED", requiredSteps: [{ id: "x", title: "X" }] },
      serverSession: { planMode: "CHECKLIST_REQUIRED" },
      serverTemplate: template,
    });
    expect(validateRequiredChecklistMapping({ intakePlanJson: stricter, parts: [] }).missing.map((m) => m.stepId)).toEqual(["a", "x"]);
  });

  it("with no server plan (FLEXIBLE session, no session, unknown template) the client plan stands, as before", () => {
    const clientPlan = { mode: "CHECKLIST_REQUIRED", requiredSteps: [{ id: "c", title: "C" }] };
    expect(effectiveChecklistPlan({ clientPlan, serverSession: { planMode: "FLEXIBLE" }, serverTemplate: template })).toBe(clientPlan);
    expect(effectiveChecklistPlan({ clientPlan, serverSession: null, serverTemplate: null })).toBe(clientPlan);
    expect(effectiveChecklistPlan({ clientPlan, serverSession: { planMode: "CHECKLIST_REQUIRED" }, serverTemplate: null })).toBe(clientPlan);
  });
});
