/**
 * WHO PAYS FOR THE ACTIVE WORKSPACE (native) — the web's
 * `apps/web/lib/billing/active-space-billing.ts`, same rules, same copy
 * (Free-user audit 0ea0: B2A-F-01, B2A-F-03, B3A-F-004).
 *
 * `/v1/billing/overview` and the Billing screen describe the VIEWER's own
 * accounts. In a workspace somebody else pays for, those figures are the wrong
 * subject and "Upgrade" would send a Free member to buy a plan for an account
 * that does not hold the workspace's limit.
 *
 *   - own Personal Space (`activeSpace.type === "PERSONAL"`, not `shared`) → SELF
 *   - Owned Workspace (`contextOptions.activeContext.kind === "OWNED"`) → SELF
 *     only for its OWNER
 *   - organization → the organization pays; the viewer acts on it only when
 *     `/v1/billing/accounts` lists that ORGANIZATION account
 *   - anything else → somebody else pays
 */
import { parseBillingProjection } from "./billing-account";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function isOwnPersonalActiveSpace(envelope: unknown): boolean {
  const space = obj(obj(envelope).activeSpace);
  return space.type === "PERSONAL" && space.shared !== true;
}

export type ActiveSpacePayer =
  | { kind: "SELF" }
  | { kind: "ORGANIZATION"; organizationId: string | null }
  | { kind: "OTHER" }
  | { kind: "UNKNOWN" };

export function resolveActiveSpacePayer(envelope: unknown): ActiveSpacePayer {
  const env = obj(envelope);
  if (!env.activeSpace || typeof env.activeSpace !== "object") return { kind: "UNKNOWN" };
  const space = obj(env.activeSpace);
  if (space.type === "PERSONAL") return space.shared === true ? { kind: "OTHER" } : { kind: "SELF" };
  const active = obj(obj(env.contextOptions).activeContext);
  if (active.kind === "OWNED") {
    return String(space.roleLabel ?? "").toUpperCase() === "OWNER" ? { kind: "SELF" } : { kind: "OTHER" };
  }
  if (active.kind === "ORGANIZATION") return { kind: "ORGANIZATION", organizationId: strOrNull(active.organizationId) };
  return { kind: "OTHER" };
}

export function viewerManagesActiveBilling(
  payer: ActiveSpacePayer,
  accounts: ReadonlyArray<{ type: string; id: string }> | null,
): boolean | null {
  if (payer.kind === "SELF") return true;
  if (payer.kind === "OTHER") return false;
  if (payer.kind === "UNKNOWN") return null;
  if (!payer.organizationId) return false;
  if (accounts === null) return null;
  return accounts.some((a) => a.type === "ORGANIZATION" && a.id === payer.organizationId);
}

export const ASK_WORKSPACE_OWNER_COPY =
  "Billing for this workspace is managed by its owner. Ask them to change the plan.";
export const ASK_ORGANIZATION_BILLING_COPY =
  "Billing for this organization is managed by its billing administrators. Ask them to change the plan.";

export function notPayerCopy(payer: ActiveSpacePayer): string {
  return payer.kind === "ORGANIZATION" ? ASK_ORGANIZATION_BILLING_COPY : ASK_WORKSPACE_OWNER_COPY;
}

/** B2A-F-03 — the record allowance from the PERSONAL account projection. */
export interface HomeRecordAllowance {
  held: number;
  cap: number | null;
  nextAllowed: boolean;
}

export function recordAllowanceFromProjection(payload: unknown): HomeRecordAllowance | null {
  if (!payload || typeof payload !== "object") return null;
  const adm = parseBillingProjection(payload).evidenceAdmission;
  if (!adm) return null;
  return { held: adm.recordsHeld, cap: adm.effectiveLifetimeCap, nextAllowed: adm.next.allowed };
}

/** "2 of 3 records" — only where the plan caps records. */
export function recordAllowanceLabel(a: HomeRecordAllowance | null): string | null {
  if (!a || a.cap === null) return null;
  return `${a.held} of ${a.cap} record${a.cap === 1 ? "" : "s"}`;
}
