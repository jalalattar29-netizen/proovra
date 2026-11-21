"use client";

/**
 * NEW-RG-26-4 / owner decision E (DEC-18) — the organization ownership offer.
 *
 * Ownership of an organization no longer moves on the owner's unilateral act:
 * the owner offers, and the named member accepts (with their own account
 * step-up) or declines here; the owner may withdraw a pending offer. The API
 * shows the offer only to its two parties (`GET /v1/orgs/:id/ownership-offer`
 * answers `{ offer: null }` to everyone else, and an older API 404s, which
 * renders nothing).
 *
 * The payer does not move with ownership: the billing owner the organization
 * names today stays its billing owner, and the copy says so before acceptance.
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

type Offer = {
  id: string;
  organizationId: string;
  fromUserId: string;
  toUserId: string;
  status: string;
  expiresAtUtc: string | null;
};

type OfferResponse = {
  offer: Offer | null;
  billingOwnerStays?: boolean;
  billingOwnerUserId?: string | null;
};

type Person = { userId: string | null; displayName?: string | null; email?: string | null };

const OFFER_REFUSAL_COPY: Record<string, string> = {
  ownership_offer_not_found: "This offer is no longer open to you. Nothing changed.",
  ownership_offer_not_pending: "This offer is no longer open. Nothing changed.",
  ownership_offer_expired: "This offer has expired. Ask the owner to make a new one.",
  ownership_offer_offerer_not_owner:
    "The person who made this offer no longer owns the organization, so it was withdrawn. Nothing changed.",
  OWNER_TARGET_NOT_ACTIVE: "Only an active member can become the owner. Nothing changed.",
  closure_in_progress: "A closure request for this organization is open. Ownership cannot change until it is cancelled.",
  WORKSPACE_SEAT_LIMIT_REACHED:
    "A workspace of this organization has no seat for this change, or you are suspended there. Nothing was transferred.",
};

function refusalCode(err: unknown): string | null {
  const e = err as { code?: unknown; body?: { error?: { code?: unknown } } };
  const code = e?.body?.error?.code ?? e?.code;
  return typeof code === "string" ? code : null;
}

export function OrgOwnershipOffer({
  orgId,
  orgName,
  viewerUserId,
  people,
  refreshKey,
  onAccepted,
}: {
  orgId: string;
  orgName: string;
  viewerUserId: string | null;
  people: Person[];
  /** Changes when the owner has just made an offer, so the panel re-reads. */
  refreshKey?: number;
  onAccepted?: () => void | Promise<void>;
}) {
  const [state, setState] = useState<OfferResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<{ methods: StepUpMethods; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = (await apiFetch(`/v1/orgs/${orgId}/ownership-offer`)) as OfferResponse;
      setState(res && typeof res === "object" ? res : { offer: null });
    } catch {
      setState({ offer: null });
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const nameOf = (userId: string | null | undefined): string => {
    if (!userId) return "no one";
    if (userId === viewerUserId) return "you";
    const p = people.find((m) => m.userId === userId);
    return p?.displayName ?? p?.email ?? "another member";
  };

  const offer = state?.offer ?? null;

  const act = useCallback(
    async (kind: "accept" | "decline" | "cancel", proof?: StepUpProof) => {
      if (!offer) return;
      setBusy(true);
      setMessage(null);
      try {
        await apiFetch(`/v1/orgs/${orgId}/ownership-offer/${offer.id}/${kind}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(kind === "accept" && proof ? { stepUp: proof } : {}),
        });
        setStepUp(null);
        if (kind === "accept") {
          setMessage(
            `You now own ${orgName || "this organization"}. Billing ownership did not change: the organization's billing owner is still ${nameOf(state?.billingOwnerUserId)}.`,
          );
          await onAccepted?.();
        } else if (kind === "decline") {
          setMessage("Offer declined. Ownership did not change.");
        } else {
          setMessage("Offer withdrawn. Ownership did not change.");
        }
      } catch (err) {
        const su = kind === "accept" ? extractStepUp(err) : null;
        if (su) {
          setStepUp({ methods: su.methods, message: su.message });
          return;
        }
        setStepUp(null);
        const code = refusalCode(err);
        setMessage(
          (code && OFFER_REFUSAL_COPY[code]) ??
            toSafeUserError(err, { message: "The offer could not be updated. Nothing changed." }).message,
        );
      } finally {
        setBusy(false);
        await load();
      }
    },
    // nameOf reads props only; listing them keeps the copy current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [offer, orgId, orgName, state?.billingOwnerUserId, load, onAccepted, people, viewerUserId],
  );

  if (!offer && !message) return null;
  const isRecipient = offer !== null && offer.toUserId === viewerUserId;
  const isOfferer = offer !== null && offer.fromUserId === viewerUserId;

  return (
    <div data-org-ownership-offer={offer?.id ?? ""} style={{ display: "grid", gap: 8, fontSize: 13 }}>
      {offer && isRecipient ? (
        <>
          <p style={{ margin: 0 }}>
            {nameOf(offer.fromUserId)} has offered you ownership of <strong>{orgName || "this organization"}</strong>
            {offer.expiresAtUtc ? ` (open until ${formatUserDate(offer.expiresAtUtc)})` : ""}. Accepting makes you the
            organization owner and the owner of the organization&apos;s workspaces they own; they become an admin.
          </p>
          <p style={{ margin: 0, color: "var(--ink-secondary, #475569)" }} data-org-ownership-offer-billing>
            Billing does not move with ownership: the organization&apos;s billing owner stays{" "}
            {nameOf(state?.billingOwnerUserId)}.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void act("accept")}
              loading={busy}
              disabled={busy}
              data-action="accept-org-ownership-offer"
            >
              Accept ownership
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void act("decline")}
              disabled={busy}
              data-action="decline-org-ownership-offer"
            >
              Decline
            </Button>
          </div>
        </>
      ) : null}
      {offer && isOfferer ? (
        <>
          <p style={{ margin: 0 }}>
            You offered ownership to {nameOf(offer.toUserId)}
            {offer.expiresAtUtc ? ` (open until ${formatUserDate(offer.expiresAtUtc)})` : ""}. Nothing changes until they
            accept.
          </p>
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void act("cancel")}
              disabled={busy}
              data-action="cancel-org-ownership-offer"
            >
              Withdraw offer
            </Button>
          </div>
        </>
      ) : null}
      {message ? (
        <p role="status" aria-live="polite" style={{ margin: 0 }} data-org-ownership-offer-status>
          {message}
        </p>
      ) : null}
      {stepUp ? (
        <StepUpVerify
          title="Confirm accepting ownership of this organization."
          methods={stepUp.methods}
          initialError={stepUp.message}
          busy={busy}
          onSubmit={(proof) => void act("accept", proof)}
          onCancel={() => setStepUp(null)}
        />
      ) : null}
    </div>
  );
}
