/**
 * React hook over src/product/active-space-billing.ts (kept apart so the pure
 * rules load in node tests without the API client).
 */
import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { BILLING_ACCOUNTS_PATH, parseBillingAccounts } from "./billing";
import { usePlatformContext } from "./platform-context";
import { notPayerCopy, resolveActiveSpacePayer, viewerManagesActiveBilling, type ActiveSpacePayer } from "./active-space-billing";

/**
 * B3A-F-004 — whether the viewer can act on the ACTIVE workspace's billing.
 * `canManage: null` while unknown (an organization's account list loading).
 */
export function useActiveSpaceBillingAuthority(): { canManage: boolean | null; payer: ActiveSpacePayer; askCopy: string } {
  const envelope = usePlatformContext().envelope ?? null;
  const payer = resolveActiveSpacePayer(envelope);
  const orgId = payer.kind === "ORGANIZATION" ? payer.organizationId : null;
  const [accounts, setAccounts] = useState<{ orgId: string; list: Array<{ type: string; id: string }> } | null>(null);
  useEffect(() => {
    if (!orgId) return undefined;
    let alive = true;
    apiFetch(BILLING_ACCOUNTS_PATH)
      .then((data) => {
        if (alive) setAccounts({ orgId, list: parseBillingAccounts(data) });
      })
      .catch(() => {
        if (alive) setAccounts({ orgId, list: [] });
      });
    return () => {
      alive = false;
    };
  }, [orgId]);
  const list = accounts && accounts.orgId === orgId ? accounts.list : null;
  return { canManage: viewerManagesActiveBilling(payer, list), payer, askCopy: notPayerCopy(payer) };
}
