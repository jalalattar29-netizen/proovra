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

// ---------------------------------------------------------------------------
// T-14 — CaptureSessionPanel: the session readiness the web's rail and Finish
// gate read (web `_lib/session-readiness.ts` buildSessionReadiness +
// `file-utils.ts` getItemQualityStatus), ported rule-for-rule.
//
// The plan mode is the web's Intake structure choice: in FLEXIBLE a missing
// required step is progress, in CHECKLIST_REQUIRED (Guided) it is a blocker.
// Native carries no client file signals (generic MIME, duplicate), so those
// two warnings cannot arise here.
// ---------------------------------------------------------------------------

export type CapturePlanMode = "FLEXIBLE" | "CHECKLIST_REQUIRED";

export interface SessionReadinessItem {
  id: string;
  mimeType: string;
  checklistStepId: string | null;
}

export interface SessionReadinessIssue {
  code: string;
  severity: "blocker" | "warning";
  label: string;
  detail: string;
  itemId?: string;
  checklistStepId?: string;
}

export interface SessionReadiness {
  canFinalize: boolean;
  status: "empty" | "collecting" | "blocked" | "warning" | "ready";
  blockers: SessionReadinessIssue[];
  warnings: SessionReadinessIssue[];
  /** Required steps no staged item is mapped to (web `missingRequiredSteps`). */
  missingRequiredSteps: ChecklistStep[];
  mappedCount: number;
  unmappedCount: number;
  totalItems: number;
  requiredTotal: number;
  requiredCompleted: number;
  /** 0-100, the web's requiredProgressPercent (100 when the plan requires nothing). */
  requiredProgressPercent: number;
  /** The web's `aiRecommendedReview`: any warning recommends the AI review. */
  aiRecommendedReview: boolean;
}

function kindForMime(mime: string): CaptureItemKind {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "PHOTO";
  if (m.startsWith("video/")) return "VIDEO";
  if (m.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

const KIND_WORD: Record<CaptureItemKind, string> = { PHOTO: "Photo", VIDEO: "Video", AUDIO: "Audio", DOCUMENT: "Document" };

/** The web `formatEvidenceTypeLabel`. */
export function captureKindLabel(kind: CaptureItemKind): string {
  return KIND_WORD[kind];
}

export interface ItemQualityStatus {
  tone: "success" | "warning" | "danger";
  label: string;
  detail: string;
}

/**
 * The web `getItemQualityStatus` (file-utils.ts:153), minus the two
 * browser-only client signals (generic MIME, duplicate) a phone never raises.
 */
export function itemQualityStatus(item: { mimeType: string }, step: ChecklistStep | null): ItemQualityStatus {
  if (!step) {
    return { tone: "warning", label: "Needs mapping", detail: "This item is not mapped to a collection requirement." };
  }
  const kind = kindForMime(item.mimeType);
  if (step.acceptedKinds.length > 0 && !step.acceptedKinds.includes(kind)) {
    return { tone: "danger", label: "Invalid file type", detail: `${KIND_WORD[kind]} does not match this requirement.` };
  }
  if (step.id.includes("close_up") || step.id.includes("damage_close_up") || step.id.includes("close-up")) {
    if (!item.mimeType.startsWith("image/") && !item.mimeType.startsWith("video/")) {
      return {
        tone: "danger",
        label: "Close-up requirement not satisfied (metadata-based)",
        detail: "This metadata-based check only verifies file type. It does not visually confirm close-up quality.",
      };
    }
  }
  return {
    tone: "success",
    label: "Matches selected requirement",
    detail: "The item metadata matches the selected intake requirement. This is not a factual, visual, or legal validation.",
  };
}

function qualityCode(label: string): string {
  return `capture_item_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
}

export function buildSessionReadiness(args: {
  items: ReadonlyArray<SessionReadinessItem>;
  plan: CollectionPlanTemplate | null;
  useLocation: boolean;
  /** Web `planMode`; FLEXIBLE when omitted. */
  planMode?: CapturePlanMode;
}): SessionReadiness {
  const { items, plan, useLocation } = args;
  const planMode = args.planMode ?? "FLEXIBLE";
  const requiredSteps = plan?.steps.filter((s) => s.required) ?? [];
  const mapped = new Set(items.map((i) => i.checklistStepId).filter(Boolean) as string[]);
  const missingRequiredSteps = requiredSteps.filter((s) => !mapped.has(s.id));
  const requiredCompleted = requiredSteps.length - missingRequiredSteps.length;
  const blockers: SessionReadinessIssue[] = [];
  const warnings: SessionReadinessIssue[] = [];
  if (items.length === 0) {
    blockers.push({
      code: "capture_empty_session",
      severity: "blocker",
      label: "Add at least one material to finish.",
      detail: "Capture requires at least one staged material before Review & Sign can start.",
    });
  }
  // Guided mode: every unmapped required step is a blocker (session-readiness.ts:195).
  if (planMode === "CHECKLIST_REQUIRED") {
    for (const step of missingRequiredSteps) {
      blockers.push({
        code: "capture_required_step_missing",
        severity: "blocker",
        label: "Cannot finish yet",
        detail: `${step.title} has not been mapped to a staged material.`,
        checklistStepId: step.id,
      });
    }
  }
  if (plan?.locationRequirement === "required" && !useLocation) {
    blockers.push({
      code: "capture_required_location_missing",
      severity: "blocker",
      label: "Location metadata is required by the selected plan.",
      detail: "Enable location and grant permission before finishing this evidence session.",
    });
  }
  // The web raises BOTH "not mapped" and the quality "Needs mapping" for an
  // unmapped item, so each one counts twice. Kept, so the counts match the web.
  for (const item of items) {
    if (!item.checklistStepId) {
      warnings.push({ code: "capture_item_unmapped", severity: "warning", label: "Needs mapping", detail: "This material is not mapped to a collection requirement.", itemId: item.id });
    }
  }
  for (const item of items) {
    const step = plan?.steps.find((s) => s.id === item.checklistStepId) ?? null;
    const status = itemQualityStatus(item, step);
    if (status.tone === "success") continue;
    warnings.push({ code: qualityCode(status.label), severity: "warning", label: status.label, detail: status.detail, itemId: item.id });
  }
  if (plan?.locationRequirement === "recommended" && !useLocation) {
    warnings.push({
      code: "capture_recommended_location_missing",
      severity: "warning",
      label: "Recommended location not included",
      detail: "The selected plan recommends location metadata, but it is not included for this session.",
    });
  }
  const canFinalize = blockers.length === 0;
  const status: SessionReadiness["status"] =
    items.length === 0 ? "empty" : blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "ready";
  const mappedCount = items.filter((i) => Boolean(i.checklistStepId)).length;
  return {
    canFinalize,
    status,
    blockers,
    warnings,
    missingRequiredSteps,
    mappedCount,
    unmappedCount: items.length - mappedCount,
    totalItems: items.length,
    requiredTotal: requiredSteps.length,
    requiredCompleted,
    requiredProgressPercent: requiredSteps.length === 0 ? 100 : Math.round((requiredCompleted / requiredSteps.length) * 100),
    aiRecommendedReview: warnings.length > 0,
  };
}

/**
 * Guided-mode auto-mapping (web useCaptureSessionOrchestration.ts:340-378):
 * an incoming item takes the one still-unmapped required step it can satisfy,
 * or the only one left. FLEXIBLE never assigns.
 */
export function assignRequiredStep(args: {
  planMode: CapturePlanMode;
  plan: CollectionPlanTemplate | null;
  stagedStepIds: ReadonlyArray<string | null | undefined>;
  mimeType: string;
}): string | null {
  if (args.planMode !== "CHECKLIST_REQUIRED" || !args.plan) return null;
  const taken = new Set(args.stagedStepIds.filter(Boolean) as string[]);
  const open = args.plan.steps.filter((s) => s.required && !taken.has(s.id));
  if (open.length === 0) return null;
  const kind = kindForMime(args.mimeType);
  const compatible = open.filter((s) => s.acceptedKinds.length === 0 || s.acceptedKinds.includes(kind));
  const chosen = compatible.length === 1 ? compatible[0] : open.length === 1 ? open[0] : null;
  return chosen?.id ?? null;
}

/** Web `CANONICAL_TEMPLATE_PRIORITY` + `orderTemplatesByWorkflow`: reorders, never hides. */
export const DEFAULT_TEMPLATE_ID = "general-evidence-record";
export function orderCaptureTemplates(templates: ReadonlyArray<CollectionPlanTemplate>): CollectionPlanTemplate[] {
  const lead = templates.filter((t) => t.id === DEFAULT_TEMPLATE_ID);
  return [...lead, ...templates.filter((t) => t.id !== DEFAULT_TEMPLATE_ID)];
}

/** The web material row's role label (capture/page.tsx:112-132). */
export function roleRequirementLabel(role: string | null | undefined, step: ChecklistStep | null): string {
  if (step) return `${roleFromChecklistStep(step)} · ${step.title}`;
  const r = (role ?? "").trim().toLowerCase();
  const simple = r.startsWith("primary") ? "Primary" : r.startsWith("supporting") ? "Supporting" : "Context";
  return `${simple} · Unmapped`;
}

/** Web CaptureFinalReadiness (CaptureFinalReadiness.tsx:22-52). */
export function finalReadinessCopy(readiness: SessionReadiness, busy: boolean): {
  ready: boolean;
  title: string;
  detail: string;
  missing: string[];
} {
  const ready = !busy && readiness.canFinalize;
  if (ready) {
    const materials = `${readiness.totalItems} material${readiness.totalItems === 1 ? "" : "s"} added`;
    const mapped =
      readiness.requiredTotal > 0
        ? `${readiness.requiredCompleted}/${readiness.requiredTotal} required items mapped`
        : "No required items outstanding";
    return { ready, title: "Ready to finalize", detail: `${materials} · ${mapped}`, missing: [] };
  }
  let detail: string;
  const first = readiness.blockers[0];
  if (busy) detail = "Finishing the current operation.";
  else if (first) detail = first.detail?.trim() || first.label;
  else {
    const outstanding = readiness.requiredTotal - readiness.requiredCompleted;
    detail =
      outstanding > 0
        ? `${outstanding} required item${outstanding === 1 ? "" : "s"} still ${outstanding === 1 ? "needs" : "need"} evidence.`
        : "This session cannot be finalized yet.";
  }
  const extra = readiness.blockers.length > 1 ? readiness.blockers.length - 1 : 0;
  if (extra > 0) detail += ` (+${extra} more)`;
  return { ready, title: "Not ready to finalize", detail, missing: readiness.missingRequiredSteps.map((s) => s.title) };
}

/** Web CaptureOperationalSummary LEVEL_LABEL. */
export const OPERATIONAL_LEVEL_LABEL: Record<ReadinessLevel, string> = {
  draft: "Draft",
  developing: "Developing",
  ready: "Ready",
};

/** Web CaptureReadinessPanel LEVEL_LABEL. */
export const READINESS_PANEL_LEVEL_LABEL: Record<ReadinessLevel, string> = {
  draft: "Draft intake",
  developing: "Developing intake",
  ready: "Operationally ready",
};

/** The web's session label: `CAP-YYYY-MM-DD` of the session's local start date. */
export function formatCaptureSessionId(startedAt: Date): string {
  const y = startedAt.getFullYear();
  const m = String(startedAt.getMonth() + 1).padStart(2, "0");
  const d = String(startedAt.getDate()).padStart(2, "0");
  return `CAP-${y}-${m}-${d}`;
}

export const SESSION_STATUS_COPY: Record<SessionReadiness["status"], { label: string; detail: string }> = {
  empty: { label: "Awaiting material", detail: "Add at least one file, folder, photo, video, or audio recording to begin readiness review." },
  collecting: { label: "Collecting", detail: "Materials are staged locally. Continue mapping and reviewing before finalization." },
  blocked: { label: "Blocked", detail: "Required evidence or metadata is missing. Resolve blockers before Review & Sign." },
  warning: { label: "Ready with warnings", detail: "The session can proceed, but reviewers should inspect the warnings first." },
  ready: { label: "Ready for Review & Sign", detail: "Required evidence is mapped and no blockers are currently detected." },
};

/** The web capture formatFileSize. */
export function formatCaptureFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
