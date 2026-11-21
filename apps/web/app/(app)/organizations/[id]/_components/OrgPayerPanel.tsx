"use client";

/**
 * Closure 2 ("sem" item 2) — WHO PAYS FOR THIS ORGANIZATION, said explicitly.
 *
 * Decision E keeps the payer through an ownership transfer. This panel reads
 * `GET /v1/orgs/:id/payer` (owner, administrator, billing administrator, or a
 * member who pays here) and states, in product words:
 *   - who the payer is and where they stand now (owner / member / left);
 *   - which provider agreements bill the organization's workspaces, and whom;
 *   - what the viewer can do: the payer cancels from their OWN Billing; an
 *     owner who is not the payer cannot cancel it; a handover is arranged with
 *     the account manager; closure waits until the agreements have ended.
 * A viewer the API refuses (403 / 404, or an older API) sees nothing. Nothing
 * here writes, and no price or plan is shown.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDate } from "../../../../../lib/date";

type PayerProjection = {
  billingOwner: { userId: string; displayName: string | null; membership: "OWNER" | "MEMBER" | "SUSPENDED" | "LEFT" } | null;
  contractOwnerUserId: string | null;
  viewerIsPayer: boolean;
  state: "PAYER_IS_OWNER" | "PAYER_IS_MEMBER_NOT_OWNER" | "PAYER_LEFT_ORGANIZATION" | "NO_PAYER";
  agreements: Array<{
    kind: "SUBSCRIPTION" | "STORAGE_ADDON" | "CHECKOUT_ATTEMPT";
    id: string;
    state: "RENEWING" | "STOPPING";
    endsAtUtc: string | null;
    payerUserId: string | null;
    payerDisplayName: string | null;
    payerIsViewer: boolean;
  }>;
  closure: { renewing: number; stopping: number; blockedByAgreements: boolean };
  guidance: string[];
};

const STATE_COPY: Record<PayerProjection["state"], string> = {
  PAYER_IS_OWNER: "The organization's owner pays for it.",
  PAYER_IS_MEMBER_NOT_OWNER:
    "The person who pays for this organization is no longer its owner. Transferring ownership does not move who pays.",
  PAYER_LEFT_ORGANIZATION:
    "The person who pays for this organization has left it. They are still billed until they cancel or a handover is arranged.",
  NO_PAYER: "No billing owner is recorded for this organization. Contact your account manager.",
};

const GUIDANCE_COPY: Record<string, string> = {
  PAYER_CANCELS_IN_OWN_BILLING:
    "A subscription is cancelled only by the person it bills, from their own Billing page.",
  HANDOVER_VIA_ACCOUNT_MANAGER:
    "To hand payment over to someone else, contact your account manager. There is no self-service handover.",
  VIEWER_CANNOT_CANCEL_PAYER_AGREEMENT:
    "You cannot cancel a subscription that bills someone else, and you are not billed for it.",
  VIEWER_REMAINS_LIABLE_UNTIL_CANCELLED:
    "You are still billed for this organization until you cancel in your Billing or a handover is arranged.",
  CLOSURE_WAITS_FOR_AGREEMENTS_TO_END:
    "The organization can be closed only after these subscriptions have ended.",
};

function payerName(name: string | null, isViewer: boolean): string {
  if (isViewer) return "You";
  return name ?? "Another person";
}

export function OrgPayerPanel({
  orgId,
  viewerUserId,
  refreshKey = 0,
}: {
  orgId: string;
  viewerUserId: string | null;
  refreshKey?: number;
}) {
  const [payer, setPayer] = useState<PayerProjection | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/v1/orgs/${encodeURIComponent(orgId)}/payer`, { method: "GET" })
      .then((res: unknown) => {
        if (cancelled) return;
        setPayer(((res as { payer?: PayerProjection } | null)?.payer ?? null) as PayerProjection | null);
      })
      .catch(() => {
        // 403 / 404 / an older API: this viewer is not shown the payer.
        if (!cancelled) setPayer(null);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, refreshKey]);

  if (!payer) return null;
  const owner = payer.billingOwner;
  return (
    <section data-org-payer-panel data-org-payer-state={payer.state} aria-labelledby="org-payer-title">
      <h3 id="org-payer-title" style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 650 }}>
        Payment agreement
      </h3>
      <p data-org-payer-state-copy style={{ margin: "0 0 6px", fontSize: 13 }}>
        {STATE_COPY[payer.state]}
      </p>
      {owner ? (
        <p data-org-payer-billing-owner style={{ margin: "0 0 6px", fontSize: 13 }}>
          Billing owner: {payerName(owner.displayName, viewerUserId !== null && owner.userId === viewerUserId)}
          {owner.membership === "LEFT" ? " (has left the organization)" : owner.membership === "OWNER" ? " (owner)" : ""}
        </p>
      ) : null}
      {payer.agreements.length > 0 ? (
        <ul data-org-payer-agreements style={{ margin: "0 0 6px", paddingLeft: 18, fontSize: 13 }}>
          {payer.agreements.map((a) => (
            <li key={a.id} data-org-payer-agreement={a.id} data-org-payer-agreement-state={a.state}>
              {a.kind === "STORAGE_ADDON" ? "Storage add-on" : "Subscription"} billed to{" "}
              {payerName(a.payerDisplayName, a.payerIsViewer)}
              {a.state === "STOPPING"
                ? a.endsAtUtc
                  ? ` — ends ${formatUserDate(a.endsAtUtc)}`
                  : " — ending"
                : a.endsAtUtc
                  ? ` — renews ${formatUserDate(a.endsAtUtc)}`
                  : " — renewing"}
            </li>
          ))}
        </ul>
      ) : null}
      {payer.guidance
        .filter((g) => GUIDANCE_COPY[g])
        .map((g) => (
          <p key={g} data-org-payer-guidance={g} style={{ margin: "0 0 4px", fontSize: 12.5, color: "var(--ink-secondary, #475569)" }}>
            {GUIDANCE_COPY[g]}
          </p>
        ))}
      {payer.viewerIsPayer && payer.closure.renewing > 0 ? (
        <Link href="/billing" data-org-payer-billing-link>
          Open your Billing
        </Link>
      ) : null}
    </section>
  );
}

export default OrgPayerPanel;
