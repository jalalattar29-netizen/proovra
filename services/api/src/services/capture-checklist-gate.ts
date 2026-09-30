/**
 * Phase CAPTURE-HARDENING — pure-logic validator for the server-side
 * required-checklist gate. Kept in its own module so the unit tests
 * can import it without dragging the full evidence-complete service
 * (and the bag of side-effecting Prisma / queue / signer imports the
 * service module pulls in).
 *
 * The Capture frontend disables the "Review & Sign" button whenever
 * a required checklist step is unmapped, but a scripted client could
 * still POST `/v1/evidence/:id/complete` directly and bypass that
 * gate. This validator is the server's authoritative answer to
 * "would a finalize satisfy the intake plan the user committed to?".
 *
 * Inputs:
 *  - `intakePlanJson` — the JSONB column written at evidence creation
 *    (apps/web/.../useCaptureSessionOrchestration.ts:602-640).
 *    Shape: `{ mode: "CHECKLIST_REQUIRED" | "FLEXIBLE", requiredSteps: [{id,title,...}], optionalSteps: [...], ... }`.
 *  - `parts`   — the EvidencePart rows for this evidence; each
 *    carries `checklistStepId` (apps/web/.../page.tsx adds it via
 *    POST /v1/evidence/:id/parts body.checklistStepId).
 *
 * Returns `{ enforced, missing }`:
 *  - `enforced=false` for FLEXIBLE / legacy / malformed plans — the
 *    caller must NOT block in those cases.
 *  - `enforced=true, missing=[]` for CHECKLIST_REQUIRED with every
 *    required step mapped to at least one part.
 *  - `enforced=true, missing=[{stepId,label}]` for the rejection
 *    path — caller throws `AppError(VALIDATION_ERROR)` with the same
 *    details so the route returns HTTP 400 and Sentry sees only a
 *    warn-level business-validation event.
 *
 * Purely a read — never mutates state, never logs to Sentry, never
 * changes the evidence chain.
 */

type ChecklistStepHandle = { id: unknown; title?: unknown };
export type ChecklistMissingStep = { stepId: string; label: string };

function readChecklistSteps(value: unknown): ChecklistStepHandle[] {
  if (!Array.isArray(value)) return [];
  const out: ChecklistStepHandle[] = [];
  for (const item of value) {
    if (item && typeof item === "object") {
      out.push(item as ChecklistStepHandle);
    }
  }
  return out;
}

export function validateRequiredChecklistMapping(args: {
  intakePlanJson: unknown;
  parts: Array<{ checklistStepId: string | null }>;
}): { missing: ChecklistMissingStep[]; enforced: boolean } {
  const plan = args.intakePlanJson;
  if (!plan || typeof plan !== "object") {
    return { missing: [], enforced: false };
  }
  const mode = (plan as Record<string, unknown>).mode;
  if (mode !== "CHECKLIST_REQUIRED") {
    return { missing: [], enforced: false };
  }
  const requiredSteps = readChecklistSteps(
    (plan as Record<string, unknown>).requiredSteps,
  );
  if (requiredSteps.length === 0) {
    return { missing: [], enforced: true };
  }
  const mappedIds = new Set<string>();
  for (const part of args.parts) {
    if (typeof part.checklistStepId === "string" && part.checklistStepId.trim()) {
      mappedIds.add(part.checklistStepId.trim());
    }
  }
  const missing: ChecklistMissingStep[] = [];
  for (const step of requiredSteps) {
    const id = typeof step.id === "string" ? step.id.trim() : "";
    if (!id || mappedIds.has(id)) continue;
    const title =
      typeof step.title === "string" && step.title.trim()
        ? step.title.trim()
        : id;
    missing.push({ stepId: id, label: title });
  }
  return { missing, enforced: true };
}

/**
 * ET-ACQ-05 — THE checklist plan the server enforces. The client wrote
 * `intakePlanJson`, so a raw API caller could omit it (skipping the gate) or
 * rewrite its required steps. When the record came from a server-issued
 * capture session that chose CHECKLIST_REQUIRED against a known template, the
 * required steps are the TEMPLATE's own; a client-supplied plan can only add
 * requirements, never remove them. Pure: the caller loads the session's plan
 * mode and the template.
 */
export function effectiveChecklistPlan(args: {
  clientPlan: unknown;
  serverSession: { planMode: string | null } | null;
  serverTemplate: { steps: Array<{ id: string; title: string; required: boolean }> } | null;
}): unknown {
  if (args.serverSession?.planMode !== "CHECKLIST_REQUIRED" || !args.serverTemplate) {
    return args.clientPlan;
  }
  const serverRequired = args.serverTemplate.steps
    .filter((s) => s.required)
    .map((s) => ({ id: s.id, title: s.title }));
  const client =
    args.clientPlan && typeof args.clientPlan === "object"
      ? (args.clientPlan as Record<string, unknown>)
      : null;
  const clientRequired =
    client?.mode === "CHECKLIST_REQUIRED" ? readChecklistSteps(client.requiredSteps) : [];
  const seen = new Set(serverRequired.map((s) => s.id));
  const extra = clientRequired.filter(
    (s) => typeof s.id === "string" && !seen.has(s.id),
  );
  return { mode: "CHECKLIST_REQUIRED", requiredSteps: [...serverRequired, ...extra] };
}
