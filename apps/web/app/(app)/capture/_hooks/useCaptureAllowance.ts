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

/**
 * B4-F-302 — `refreshKey` re-reads the facts: Capture bumps it after a
 * record is sealed or a capture discarded on this page, so a notice (e.g.
 * "No record left on your plan" after sealing the third record) appears
 * without a reload.
 */
export function useCaptureAllowance(personalSpaceId: string | null, refreshKey = 0): CaptureAllowanceFacts | null {
  const [facts, setFacts] = useState<CaptureAllowanceFacts | null>(null);

  useEffect(() => {
    let alive = true;
    // A refresh keeps the facts shown until the new ones arrive; a change of
    // space clears them (they belong to another account).
    if (!personalSpaceId) {
      setFacts(null);
      return undefined;
    }
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
  }, [personalSpaceId, refreshKey]);

  return facts;
}
