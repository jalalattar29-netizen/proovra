"use client";

/**
 * F-12 (Free-user audit 2026-11-13) — read the PERSONAL account's billing
 * projection once per active Personal space, so Capture can say before any
 * upload what the creation and storage gates will decide (see
 * ../_lib/capture-allowance.ts). Only for the Personal space: a team
 * workspace's allowance belongs to its own billing account and is still
 * refused, as before, by the server. While loading, on any error, or when the
 * viewer has no visible Personal account, it yields null and Capture shows
 * nothing — never a fabricated figure.
 */
import { useEffect, useState } from "react";

import { listBillingAccounts, readBillingAccount } from "../../../../lib/api/billing-accounts";
import { allowanceFactsFromProjection, type CaptureAllowanceFacts } from "../_lib/capture-allowance";

export function useCaptureAllowance(personalSpaceId: string | null): CaptureAllowanceFacts | null {
  const [facts, setFacts] = useState<CaptureAllowanceFacts | null>(null);

  useEffect(() => {
    let alive = true;
    setFacts(null);
    if (!personalSpaceId) return undefined;
    (async () => {
      const accounts = await listBillingAccounts();
      const personal = accounts.find((account) => account.type === "PERSONAL");
      if (!personal) return;
      const projection = await readBillingAccount({ type: personal.type, id: personal.id });
      if (alive) setFacts(allowanceFactsFromProjection(projection));
    })().catch(() => {
      /* best-effort: the server still decides at Finish & Sign */
    });
    return () => {
      alive = false;
    };
  }, [personalSpaceId]);

  return facts;
}
