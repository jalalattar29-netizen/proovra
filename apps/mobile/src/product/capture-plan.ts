/**
 * CAPTURE PLAN — templates, readiness, suggestions and the intake stages.
 *
 * Ports `apps/web/app/(app)/capture/_lib/{templates,captureReadiness,
 * captureSuggestions,captureIntakeStages}.ts`.
 *
 * ===========================================================================
 * TEMPLATES COME FROM THE SERVER. THERE IS NO NATIVE SEED LIST.
 * ===========================================================================
 * `GET /v1/capture/intake-templates` is the versioned, snapshot-able
 * authority, and the web hook says so: "The server is the source of truth
 * (versioned, snapshot-able)." The web keeps an in-bundle seed as an offline
 * fallback; Native does NOT copy it. A second catalogue on the device would be
 * a second authority that drifts, and a template is guidance rather than a
 * gate — when the catalogue cannot be read, capture proceeds without one and
 * says so, which is honest, where showing a stale copy as if it were current
 * would not be.
 *
 * ===========================================================================
 * READINESS IS OPERATIONAL COMPLETENESS, AND NOTHING ELSE
 * ===========================================================================
 * The web file's own rules carry over verbatim: read-only, bounded vocabulary,
 * and NO legal or forensic overclaim. "Ready" here means the operator has
 * assembled what an intake usually needs. It is not an assertion about
 * admissibility or authenticity, and nothing in this module says otherwise.
 *
 * Suggestions are never blocking, and the stage rail never prevents
 * finalisation — both are informational, exactly as the web states.
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const INTAKE_TEMPLATES_PATH = "/v1/capture/intake-templates";

export type CaptureItemKind = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

export interface ChecklistStep {
  id: string;
  title: string;
  description: string;
  purposeLabel: string;
  required: boolean;
  acceptedKinds: CaptureItemKind[];
}

export interface CollectionPlanTemplate {
  id: string;
  /** The server's version for this template, snapshotted on finalisation. */
  version: number | null;
  name: string;
  description: string;
  locationRequirement: "required" | "recommended" | "optional";
  steps: ChecklistStep[];
}

const KINDS: readonly string[] = ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"];

export function parseIntakeTemplates(payload: unknown): CollectionPlanTemplate[] {
  return rows(obj(payload).templates)
    .map((raw) => {
      const t = obj(raw);
      const id = str(t.templateId) ?? str(t.id);
      if (!id) return null;
      const requirement = str(t.locationRequirement);
      return {
        id,
        version: typeof t.templateVersion === "number" ? t.templateVersion : null,
        name: str(t.templateName) ?? str(t.name) ?? id,
        description: str(t.description) ?? "",
        locationRequirement:
          requirement === "required" || requirement === "optional"
            ? requirement
            : "recommended",
        steps: rows(t.steps)
          .map((rawStep) => {
            const s = obj(rawStep);
            const stepId = str(s.id);
            if (!stepId) return null;
            return {
              id: stepId,
              title: str(s.title) ?? stepId,
              description: str(s.description) ?? "",
              purposeLabel: str(s.purposeLabel) ?? str(s.title) ?? stepId,
              required: s.required === true,
              acceptedKinds: rows(s.acceptedKinds).filter(
                (k): k is CaptureItemKind => typeof k === "string" && KINDS.includes(k),
              ),
            };
          })
          .filter((s): s is ChecklistStep => s !== null),
      };
    })
    .filter((t): t is CollectionPlanTemplate => t !== null);
}

/**
 * The item roles and notes a template needs in order to mean anything.
 *
 * A template without these fields on the staged items is a list of headings:
 * readiness reads `checklistStepId`, `role`, `privateNote`, `sourceLabel` and
 * the location signal, and every one of them is something the operator sets.
 */
export interface PlannedItem {
  checklistStepId: string | null;
  role: string | null;
  privateNote: string | null;
  sourceLabel: string | null;
  locationIncluded: boolean;
  duplicateStatus: string | null;
}

// ---------------------------------------------------------------------------
// The canonical primary / supporting predicates
// ---------------------------------------------------------------------------
//
// The web file armours itself against exactly one bug class, in its own words:
// "Duplicating the predicate is the bug class this file is now armoured
// against." It could not be imported here, so `test/capture-plan.test.mjs`
// reads the WEB source and pins these against it — a drift fails a test rather
// than quietly producing a different answer on the phone.

export function isPrimaryChecklistStepId(checklistStepId: string | null | undefined): boolean {
  if (!checklistStepId) return false;
  return /^primary[_-]/i.test(checklistStepId.trim());
}

export function isSupportingChecklistStepId(
  checklistStepId: string | null | undefined,
): boolean {
  if (!checklistStepId) return false;
  const s = checklistStepId.trim().toLowerCase();
  return s.startsWith("supporting_") || s.startsWith("context_") || s.startsWith("witness_");
}

/**
 * THE primary-evidence detector, in three branches, for the three shapes the
 * product can produce.
 *
 * The ROLE string is the load-bearing one: a template whose server-issued step
 * ids do not follow the `primary_*` convention (Insurance Claim ships
 * `overview_media`; Incident ships `scene_overview`) defeats the prefix test
 * entirely, and the surface would keep asking for a primary item the operator
 * had already marked.
 */
export function hasPrimaryEvidence(items: ReadonlyArray<PlannedItem>): boolean {
  return items.some((i) => {
    const role = (i.role ?? "").trim().toLowerCase();
    if (role.startsWith("primary")) return true;
    return isPrimaryChecklistStepId(i.checklistStepId);
  });
}

/** The role label a step carries, from the same definition the readiness uses. */
export function roleFromChecklistStep(step: ChecklistStep): "Primary" | "Supporting" {
  if (isPrimaryChecklistStepId(step.id)) return "Primary";
  if (isSupportingChecklistStepId(step.id)) return "Supporting";
  return step.required ? "Primary" : "Supporting";
}

/** What the dropdown writes onto the item when a step is chosen. */
export function roleForStep(step: ChecklistStep): string {
  return `${roleFromChecklistStep(step)} evidence`;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type ReadinessLevel = "draft" | "developing" | "ready";

export interface ReadinessCriterion {
  id: string;
  label: string;
  description: string;
  satisfied: boolean;
}

export interface CaptureReadiness {
  level: ReadinessLevel;
  score: { satisfied: number; total: number };
  criteria: ReadinessCriterion[];
}

export const CRITERION_LABEL: Readonly<
  Record<string, { label: string; description: string }>
> = {
  has_primary: {
    label: "Primary evidence captured",
    description: "At least one item is marked as the primary evidence for this record.",
  },
  has_context_note: {
    label: "Context note added",
    description: "At least one item has an operator context note explaining the capture.",
  },
  no_duplicate_warnings: {
    label: "No duplicate-content warnings",
    description:
      "No captured item is currently flagged as a duplicate of another evidence record.",
  },
};

/**
 * The three canonical criteria.
 *
 * The web's own note records that the per-workflow variants were removed with
 * the workspace-persona feature; these three are what remain, and Native does
 * not add a fourth. A criterion invented here would be a demand the web does
 * not make.
 */
export const CANONICAL_CRITERION_IDS: readonly string[] = [
  "has_primary",
  "has_context_note",
  "no_duplicate_warnings",
];

function hasAnyContextNote(items: ReadonlyArray<PlannedItem>): boolean {
  return items.some((i) => (i.privateNote ?? "").trim().length > 0);
}

function noDuplicateWarnings(items: ReadonlyArray<PlannedItem>): boolean {
  return items.every((i) => i.duplicateStatus !== "duplicate");
}

function evaluateCriterion(id: string, items: ReadonlyArray<PlannedItem>): boolean {
  switch (id) {
    case "has_primary":
      return hasPrimaryEvidence(items);
    case "has_context_note":
      return hasAnyContextNote(items);
    case "no_duplicate_warnings":
      return noDuplicateWarnings(items);
    default:
      return false;
  }
}

export function computeCaptureReadiness(items: ReadonlyArray<PlannedItem>): CaptureReadiness {
  const criteria = CANONICAL_CRITERION_IDS.map((id) => {
    const meta = CRITERION_LABEL[id] ?? { label: id, description: "" };
    return {
      id,
      label: meta.label,
      description: meta.description,
      satisfied: evaluateCriterion(id, items),
    };
  });
  const satisfied = criteria.filter((c) => c.satisfied).length;
  const total = criteria.length;

  let level: ReadinessLevel = "draft";
  if (total > 0) {
    const ratio = satisfied / total;
    if (ratio >= 0.99) level = "ready";
    else if (ratio >= 0.5) level = "developing";
  }
  return { level, score: { satisfied, total }, criteria };
}

/**
 * The word beside the progress bar.
 *
 * "Ready" is operational completeness, NOT an admissibility or authenticity
 * claim. The label is deliberately flat for that reason.
 */
export function readinessLabel(level: ReadinessLevel): string {
  switch (level) {
    case "ready":
      return "Ready to finish";
    case "developing":
      return "Coming together";
    case "draft":
      return "Draft";
  }
}

export const READINESS_BOUNDARY =
  "Readiness is about how complete this intake is. It is not a statement about " +
  "admissibility or authenticity.";

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export interface CaptureSuggestion {
  id: string;
  title: string;
  body: string;
  tone: "info" | "warning";
}

const SUGGESTIONS_BY_CRITERION: Readonly<Record<string, CaptureSuggestion>> = {
  has_primary: {
    id: "has_primary",
    title: "Mark a primary evidence item",
    body: "At least one item should be marked primary so reports and packages lead with the right record.",
    tone: "warning",
  },
  has_context_note: {
    id: "has_context_note",
    title: "Add an operator context note",
    body: "Add a short context note to at least one item — people reviewing this later rely on it.",
    tone: "warning",
  },
  no_duplicate_warnings: {
    id: "no_duplicate_warnings",
    title: "Resolve duplicate-content warnings",
    body: "At least one item is flagged as a duplicate of another evidence record. Review the warning before finishing.",
    tone: "warning",
  },
};

/**
 * Suggestions are NEVER blocking, and they come from a closed catalogue.
 *
 * A satisfied criterion produces none, and nothing is generated: no free-form
 * text, no AI claim, no legal or forensic assertion.
 */
export function computeCaptureSuggestions(
  readiness: CaptureReadiness,
  maxSuggestions = 4,
): CaptureSuggestion[] {
  const max = Math.max(1, maxSuggestions);
  const out: CaptureSuggestion[] = [];
  for (const criterion of readiness.criteria) {
    if (criterion.satisfied) continue;
    const suggestion = SUGGESTIONS_BY_CRITERION[criterion.id];
    if (!suggestion) continue;
    out.push(suggestion);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Intake stages
// ---------------------------------------------------------------------------

export type IntakeStageId =
  | "select_template"
  | "add_materials"
  | "map_context"
  | "review_readiness"
  | "finish";

export type IntakeStageStatus = "pending" | "active" | "complete";

export interface IntakeStage {
  id: IntakeStageId;
  label: string;
  status: IntakeStageStatus;
}

const STAGE_LABELS: Readonly<Record<IntakeStageId, string>> = {
  select_template: "Select template",
  add_materials: "Add materials",
  map_context: "Add context",
  review_readiness: "Review readiness",
  finish: "Finish & sign",
};

const STAGE_ORDER: readonly IntakeStageId[] = [
  "select_template",
  "add_materials",
  "map_context",
  "review_readiness",
  "finish",
];

function hasContextOnAnyItem(items: ReadonlyArray<PlannedItem>): boolean {
  return items.some(
    (i) =>
      (i.privateNote ?? "").trim().length > 0 ||
      (i.sourceLabel ?? "").trim().length > 0 ||
      i.locationIncluded === true,
  );
}

/**
 * The five stages, always all five, in the canonical order.
 *
 * The rail is INFORMATIONAL: `finish` is never marked complete here because
 * the operator finalises through the capture controls, and the rail must never
 * be the thing that decides whether they may.
 */
export function computeIntakeStages(input: {
  items: ReadonlyArray<PlannedItem>;
  templateSelected: boolean;
  readiness: CaptureReadiness;
}): IntakeStage[] {
  const complete: Record<IntakeStageId, boolean> = {
    select_template: input.templateSelected,
    add_materials: input.items.length > 0,
    map_context: hasContextOnAnyItem(input.items),
    review_readiness:
      input.readiness.level === "developing" || input.readiness.level === "ready",
    finish: false,
  };

  let activeIndex = STAGE_ORDER.findIndex((id) => !complete[id]);
  if (activeIndex < 0) activeIndex = STAGE_ORDER.length - 1;

  return STAGE_ORDER.map((id, idx) => ({
    id,
    label: STAGE_LABELS[id],
    status: idx < activeIndex ? "complete" : idx === activeIndex ? "active" : "pending",
  }));
}

export const STAGE_RAIL_BOUNDARY =
  "These steps are a guide. You can finish the record whenever you are ready.";

/** What the finalise call records about the plan that was followed. */
export function buildTemplateSnapshot(template: CollectionPlanTemplate | null) {
  if (!template) return {};
  return {
    collectionPlanTemplateId: template.id,
    ...(template.version !== null ? { collectionPlanTemplateVersion: template.version } : {}),
  };
}
