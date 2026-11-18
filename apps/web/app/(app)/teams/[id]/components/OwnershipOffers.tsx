"use client";

/**
 * PRO-T1-06 / DEC-18 — ownership offers addressed to the signed-in person.
 *
 * Ownership of a (legacy) Owned Workspace no longer moves on the owner's
 * unilateral act: the owner offers, and the named recipient accepts (with their
 * own account step-up) or declines here. `GET /v1/teams` lists the pending
 * offers as `ownershipOffers`; an older API omits it and this renders nothing.
 */
import { useCallback, useEffect, useState } from "react";

import { Button } from "../../../../../components/ui/Button";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDate } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import {
  StepUpVerify,
  extractStepUp,
  type StepUpMethods,
  type StepUpProof,
} from "../../../security-center/components/PersonalSecuritySections";

type Offer = { id: string; teamId: string; teamName: string | null; expiresAtUtc: string | null };

export function OwnershipOffers({ onAccepted }: { onAccepted?: () => void | Promise<void> }) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<{ offer: Offer; methods: StepUpMethods; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = (await apiFetch("/v1/teams")) as { ownershipOffers?: unknown };
      const list = Array.isArray(res.ownershipOffers) ? (res.ownershipOffers as Offer[]) : [];
      setOffers(list.filter((o) => typeof o?.id === "string" && typeof o?.teamId === "string"));
    } catch {
      setOffers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = useCallback(
    async (offer: Offer, proof?: StepUpProof) => {
      setBusyId(offer.id);
      setMessage(null);
      try {
        await apiFetch(`/v1/teams/${offer.teamId}/ownership-offer/${offer.id}/accept`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof ? { stepUp: proof } : {}),
        });
        setStepUp(null);
        setMessage(`You now own ${offer.teamName ?? "the workspace"}, including its billing responsibility.`);
        await load();
        await onAccepted?.();
      } catch (err) {
        const su = extractStepUp(err);
        if (su) {
          setStepUp({ offer, methods: su.methods, message: su.message });
          return;
        }
        setStepUp(null);
        setMessage(toSafeUserError(err, { message: "The offer could not be accepted. Nothing changed." }).message);
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load, onAccepted],
  );

  const decline = useCallback(
    async (offer: Offer) => {
      setBusyId(offer.id);
      setMessage(null);
      try {
        await apiFetch(`/v1/teams/${offer.teamId}/ownership-offer/${offer.id}/decline`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        setMessage("Offer declined. Ownership did not change.");
      } catch (err) {
        setMessage(toSafeUserError(err, { message: "The offer could not be declined." }).message);
      } finally {
        setBusyId(null);
        await load();
      }
    },
    [load],
  );

  if (offers.length === 0 && !message) return null;
  return (
    <div className="app-panel" data-ownership-offers>
      <div className="app-panel__head">
        <h3 className="app-panel__title">Ownership offers</h3>
      </div>
      <div className="app-panel__body">
        {offers.map((offer) => (
          <div key={offer.id} data-ownership-offer={offer.id} style={{ marginBottom: 12 }}>
            <p className="app-table__muted" style={{ margin: "0 0 6px" }}>
              You have been offered ownership of <strong>{offer.teamName ?? "a workspace"}</strong>
              {offer.expiresAtUtc ? ` (open until ${formatUserDate(offer.expiresAtUtc)})` : ""}. Accepting
              makes you its owner and billing owner, including any obligations it carries.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void accept(offer)}
                loading={busyId === offer.id}
                disabled={busyId !== null}
                data-action="accept-ownership-offer"
              >
                Accept ownership
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void decline(offer)}
                disabled={busyId !== null}
                data-action="decline-ownership-offer"
              >
                Decline
              </Button>
            </div>
          </div>
        ))}
        {message ? (
          <p role="status" aria-live="polite" className="app-table__muted" data-ownership-offer-status>
            {message}
          </p>
        ) : null}
      </div>
      {stepUp ? (
        <StepUpVerify
          title="Confirm accepting ownership of this workspace."
          methods={stepUp.methods}
          initialError={stepUp.message}
          busy={busyId !== null}
          onSubmit={(proof) => void accept(stepUp.offer, proof)}
          onCancel={() => setStepUp(null)}
        />
      ) : null}
    </div>
  );
}
