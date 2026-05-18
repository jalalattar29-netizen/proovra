/**
 * Apps/web adapter for the Phase 1+2 Workflow Engine.
 *
 * Phase 3 contract: this module exposes pure helpers that the capture page
 * uses to bridge between the canonical Phase 1 `WorkflowTemplate` shape (as
 * returned by `/v1/workflow/templates`) and the existing client-side
 * `CollectionPlanTemplate` shape (as expected by every capture-v2 component
 * today).
 *
 * Nothing here has side effects: no DOM, no fetch, no React. The capture
 * hook composes these with `useIntakeTemplates` to perform the fallback dance.
 *
 * Safety contract:
 *   - All converters are total — if input is malformed they return `null` or
 *     a safe empty value, never throw. Capture must not crash on a bad
 *     server payload.
 *   - The `CollectionPlanTemplate` shape produced by the adapter is byte-
 *     equivalent (modulo identifiers) to what the existing seed templates
 *     produce. The `selectedCollectionPlan` flow stays the same.
 */

import {
  resolveWorkflowContext,
  safeParseWorkflowTemplate,
  safeParseWorkflowTemplateList,
} from "@proovra/shared";
import type {
  ResolveWorkflowContextInput,
  ResolveWorkflowContextResult,
  WorkflowContext,
  WorkflowTemplate,
} from "@proovra/shared";

import type {
  ChecklistStep,
  CollectionPlanTemplate,
  EvidenceType,
} from "./types";

const ACCEPTED_KINDS: ReadonlyArray<EvidenceType> = [
  "PHOTO",
  "VIDEO",
  "AUDIO",
  "DOCUMENT",
];

function narrowAcceptedKinds(kinds: ReadonlyArray<string>): EvidenceType[] {
  const out: EvidenceType[] = [];
  for (const kind of kinds) {
    if (ACCEPTED_KINDS.includes(kind as EvidenceType)) {
      out.push(kind as EvidenceType);
    }
  }
  return out;
}

/**
 * Convert a validated WorkflowTemplate (Phase 1 shape) into the client-side
 * `CollectionPlanTemplate` that the existing capture UI consumes. Lossy on
 * purpose: workflow-only fields (rules, policies, intakeModes, allowedRoles)
 * are dropped here because the legacy UI does not read them. Future phases
 * will route those through `WorkflowContext` rather than through the
 * CollectionPlanTemplate.
 */
export function workflowTemplateToCollectionPlanTemplate(
  template: WorkflowTemplate,
): CollectionPlanTemplate {
  const steps: ChecklistStep[] = template.steps.map((step) => ({
    id: step.id,
    title: step.title,
    description: step.description,
    purposeLabel: step.purposeLabel,
    required: step.required,
    acceptedKinds: narrowAcceptedKinds(step.acceptedKinds),
  }));

  return {
    id: template.slug,
    name: template.name,
    description: template.description,
    locationRequirement: template.locationRequirement,
    steps,
  };
}

/**
 * Defensive entry point used by the hook. Accepts the raw `templates` array
 * from `/v1/workflow/templates` and returns the subset that:
 *   - validates against Phase 1 schemas, and
 *   - converts to a CollectionPlanTemplate the legacy UI can render.
 *
 * Invalid entries are dropped and counted; the hook surfaces the count for
 * telemetry but never throws.
 */
export type WorkflowTemplatesAdaptResult = {
  templates: CollectionPlanTemplate[];
  workflowTemplates: WorkflowTemplate[];
  invalidCount: number;
};

export function adaptWorkflowTemplatesListForCapture(
  rawList: unknown,
): WorkflowTemplatesAdaptResult {
  const parsed = safeParseWorkflowTemplateList(rawList);

  const templates: CollectionPlanTemplate[] = [];
  for (const wf of parsed.templates) {
    const client = workflowTemplateToCollectionPlanTemplate(wf);
    if (client.steps.length === 0) continue; // unsalvageable
    templates.push(client);
  }

  return {
    templates,
    workflowTemplates: parsed.templates,
    invalidCount: parsed.invalidCount,
  };
}

/**
 * Resolve the active WorkflowContext for a given capture session.
 *
 * Returns null if there is not enough information to build a context. The
 * capture page never depends on a non-null result — it is purely additive
 * metadata for future phases. Treat null as "no workflow context active —
 * use legacy behavior."
 */
export type BuildCaptureWorkflowContextInput = ResolveWorkflowContextInput;

export function buildCaptureWorkflowContext(
  input: BuildCaptureWorkflowContextInput,
): ResolveWorkflowContextResult {
  return resolveWorkflowContext(input);
}

// Re-export safeParseWorkflowTemplate so consumers can validate a single
// payload without pulling another import path.
export { safeParseWorkflowTemplate };
export type { WorkflowContext };
