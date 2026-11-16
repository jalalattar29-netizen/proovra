"use client";

/**
 * WHO PAYS FOR THE ACTIVE WORKSPACE — and therefore what a billing figure or
 * an "Upgrade" button may say there (Free-user audit 0ea0: B2A-F-01, B2A-F-02,
 * B2A-F-03, B3A-F-004, B2A-F-23).
 *
 * `/billing` and `GET /v1/billing/overview` describe the VIEWER's own billing
 * accounts. Inside a workspace somebody else pays for — a personal workspace
 * the viewer joined, an Owned Workspace they do not own, or an organization
 * whose billing they do not administer — those figures and that page are the
 * wrong subject: a Free member would read their own 250 MB meter as the
 * workspace's, or be sent to buy a plan for an account that does not hold the
 * workspace's limit.
 *
 * This module decides nothing commercial. It reads the server envelope:
 *   - own Personal Space (`activeSpace.type === "PERSONAL"`, not `shared`)
 *     -> the viewer is the payer, and the personal billing figures describe
 *        this space;
 *   - an Owned Workspace (`contextOptions.activeContext.kind === "OWNED"`)
 *     where the viewer is OWNER -> the viewer's own account pays (TEAM is a
 *     tier of their account), but the PERSONAL storage meter is not this
 *     workspace's;
 *   - an organization -> the payer is the organization; the viewer can act on
 *     it only when `/v1/billing/accounts` lists that ORGANIZATION account
 *     (the same list `/billing` selects from);
 *   - anything else -> somebody else pays.
 */
import { useEffect, useState } from "react";

import { inFlightGet } from "../inFlightGet";
import { listBillingAccounts, type BillingAccountRef } from "../api/billing-accounts";
import { useOptionalPlatformContext } from "../platform-context/PlatformContextProvider";
import type { PlatformContextEnvelope } from "../platform-context/types";

type EnvelopeLike = Pick<PlatformContextEnvelope, "activeSpace"> & {
  contextOptions?: Partial<Pick<PlatformContextEnvelope["contextOptions"], "activeContext">> | null;
};

/** True only in the viewer's OWN Personal Space. */
export function isOwnPersonalActiveSpace(envelope: EnvelopeLike | null | undefined): boolean {
  const space = envelope?.activeSpace ?? null;
  return space?.type === "PERSONAL" && space.shared !== true;
}

export type ActiveSpacePayer =
  | { kind: "SELF" }
  | { kind: "ORGANIZATION"; organizationId: string | null }
  | { kind: "OTHER" }
  | { kind: "UNKNOWN" };

/** The payer of the active workspace, from the envelope alone. */
export function resolveActiveSpacePayer(envelope: EnvelopeLike | null | undefined): ActiveSpacePayer {
  const space = envelope?.activeSpace ?? null;
  if (!space) return { kind: "UNKNOWN" };
  if (space.type === "PERSONAL") return space.shared === true ? { kind: "OTHER" } : { kind: "SELF" };
  const active = envelope?.contextOptions?.activeContext ?? null;
  if (active?.kind === "OWNED") {
    const role = String(space.roleLabel ?? "").toUpperCase();
    return role === "OWNER" ? { kind: "SELF" } : { kind: "OTHER" };
  }
  if (active?.kind === "ORGANIZATION") {
    return { kind: "ORGANIZATION", organizationId: active.organizationId ?? null };
  }
  // An organization-typed space with no context options (older API): its
  // payer cannot be named, so no billing claim is made for it.
  return { kind: "OTHER" };
}

/**
 * Whether the viewer can act on the active workspace's billing, given the
 * billing accounts `/v1/billing/accounts` lists for them. `null` = not known.
 */
export function viewerManagesActiveBilling(
  payer: ActiveSpacePayer,
  accounts: ReadonlyArray<Pick<BillingAccountRef, "type" | "id">> | null,
): boolean | null {
  if (payer.kind === "SELF") return true;
  if (payer.kind === "OTHER") return false;
  if (payer.kind === "UNKNOWN") return null;
  if (!payer.organizationId) return false;
  if (accounts === null) return null;
  return accounts.some((a) => a.type === "ORGANIZATION" && a.id === payer.organizationId);
}

/** Who to ask, when the viewer is not the payer. */
export const ASK_WORKSPACE_OWNER_COPY =
  "Billing for this workspace is managed by its owner. Ask them to change the plan.";
export const ASK_ORGANIZATION_BILLING_COPY =
  "Billing for this organization is managed by its billing administrators. Ask them to change the plan.";

export function notPayerCopy(payer: ActiveSpacePayer): string {
  return payer.kind === "ORGANIZATION" ? ASK_ORGANIZATION_BILLING_COPY : ASK_WORKSPACE_OWNER_COPY;
}

export type ActiveSpaceBillingAuthority = {
  /** `true` payer, `false` somebody else pays, `null` still deciding. */
  canManage: boolean | null;
  payer: ActiveSpacePayer;
  /** What to say instead of an upgrade link when `canManage === false`. */
  askCopy: string;
};

/**
 * React hook over the rules above. Reads `/v1/billing/accounts` only for an
 * organization workspace (shared with any concurrent reader).
 */
export function useActiveSpaceBillingAuthority(): ActiveSpaceBillingAuthority {
  const ctx = useOptionalPlatformContext();
  const envelope = ctx?.envelope ?? null;
  const payer = resolveActiveSpacePayer(envelope);
  const orgId = payer.kind === "ORGANIZATION" ? payer.organizationId : null;
  const [accounts, setAccounts] = useState<{ orgId: string; list: BillingAccountRef[] } | null>(null);

  useEffect(() => {
    if (!orgId) return undefined;
    let alive = true;
    inFlightGet("/v1/billing/accounts", () => listBillingAccounts())
      .then((list) => {
        if (alive) setAccounts({ orgId, list });
      })
      .catch(() => {
        if (alive) setAccounts({ orgId, list: [] });
      });
    return () => {
      alive = false;
    };
  }, [orgId]);

  const list = accounts && accounts.orgId === orgId ? accounts.list : null;
  return {
    canManage: viewerManagesActiveBilling(payer, list),
    payer,
    askCopy: notPayerCopy(payer),
  };
}
