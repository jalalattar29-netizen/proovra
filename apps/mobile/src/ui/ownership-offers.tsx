/**
 * PRO-T1-06 / DEC-18 — ownership offers addressed to the signed-in person
 * (native parity of web `OwnershipOffers`). Accepting asks for the account
 * step-up and moves owner + billing owner; declining changes nothing. An
 * older API lists no offers and this renders nothing.
 */
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDate } from "../lib/date";
import { theme } from "../theme/theme";
import { withStepUp } from "../product/step-up";
import {
  buildOwnershipOfferActionPath,
  parseOwnershipOffersForMe,
  type OwnershipOffer,
} from "../product/workspace-people";
import { ProovraButton, ProovraCard, ProovraText } from "./index";
import { StepUpSheet, useStepUp } from "./step-up-sheet";

export function OwnershipOffers({ onAccepted }: { onAccepted?: () => void | Promise<void> }) {
  const [offers, setOffers] = useState<OwnershipOffer[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const stepUp = useStepUp();

  const load = useCallback(async () => {
    try {
      setOffers(parseOwnershipOffersForMe(await apiFetch("/v1/teams")));
    } catch {
      setOffers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fail = useCallback(
    (err: unknown) => {
      setMessage(toSafeUserError(err, { message: "The offer could not be accepted. Nothing changed." }).message);
      void load();
    },
    [load],
  );

  const accept = useCallback(
    async (offer: OwnershipOffer) => {
      setBusyId(offer.id);
      setMessage(null);
      await stepUp.start(async (proof) => {
        await apiFetch(buildOwnershipOfferActionPath(offer.teamId, offer.id, "accept"), {
          method: "POST",
          body: JSON.stringify(withStepUp({}, proof)),
        });
        setMessage(`You now own ${offer.teamName ?? "the workspace"}, including its billing responsibility.`);
        await load();
        await onAccepted?.();
      }, fail);
      setBusyId(null);
    },
    [stepUp, load, onAccepted, fail],
  );

  const decline = useCallback(
    async (offer: OwnershipOffer) => {
      setBusyId(offer.id);
      setMessage(null);
      try {
        await apiFetch(buildOwnershipOfferActionPath(offer.teamId, offer.id, "decline"), {
          method: "POST",
          body: JSON.stringify({}),
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
    <ProovraCard testID="ownership-offers">
      <ProovraText variant="h3" weight="semibold">
        Ownership offers
      </ProovraText>
      {offers.map((offer) => (
        <View key={offer.id} style={{ gap: theme.space.s1 }} testID={`ownership-offer-${offer.id}`}>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            {`You have been offered ownership of ${offer.teamName ?? "a workspace"}${
              offer.expiresAtIso ? ` (open until ${formatUserDate(offer.expiresAtIso)})` : ""
            }. Accepting makes you its owner and billing owner, including any obligations it carries.`}
          </ProovraText>
          <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }}>
            <ProovraButton
              label="Accept ownership"
              variant="secondary"
              fullWidth={false}
              loading={busyId === offer.id}
              disabled={busyId !== null}
              onPress={() => void accept(offer)}
            />
            <ProovraButton
              label="Decline"
              variant="ghost"
              fullWidth={false}
              disabled={busyId !== null}
              onPress={() => void decline(offer)}
            />
          </View>
        </View>
      ))}
      {message ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {message}
        </ProovraText>
      ) : null}
      <StepUpSheet
        challenge={stepUp.challenge}
        title="Confirm accepting ownership of this workspace."
        busy={busyId !== null}
        onSubmit={(proof) => {
          void stepUp.retry(proof, fail);
        }}
        onCancel={stepUp.dismiss}
      />
    </ProovraCard>
  );
}