/**
 * NEW-RG-26-4 / owner decision E — the organization ownership offer, on the
 * phone (native parity of web `organizations/[id]/_components/OrgOwnershipOffer.tsx`).
 *
 * The recipient accepts (with their own account step-up — the server asks for
 * it, the sheet answers it and the SAME request is sent again) or declines;
 * the offerer may withdraw. The billing owner stays, and the copy says so
 * before acceptance. A refusal is the server's, in the web's words.
 *
 * When the server can only ask this account to re-authenticate (no password,
 * no authenticator: `reauth`), the phone cannot take that proof; the panel
 * then hands off to the web app's page for the SAME organization, where the
 * offer is shown again to the same account.
 *
 * `linkedOfferId` is the offer an ownership-offer link named. When the signed-in
 * account is not a party to it (a shared phone, a settled offer), the panel says
 * so instead of rendering nothing.
 */
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDate } from "../lib/date";
import { theme } from "../theme/theme";
import { stepUpMethodFor, withStepUp } from "../product/step-up";
import { webOrigin } from "../product/intake-create";
import {
  buildOrgOwnershipOfferActionPath,
  buildOrgOwnershipOfferPath,
  linkedOfferNotice,
  orgOwnershipAcceptedCopy,
  orgOwnershipOfferRefusal,
  orgOwnershipOfferSide,
  orgOwnershipOfferWebUrl,
  parseOrgOwnershipOffer,
  ORG_OWNERSHIP_DECLINED_COPY,
  ORG_OWNERSHIP_STEP_UP_TITLE,
  ORG_OWNERSHIP_WITHDRAWN_COPY,
  type OrgOwnershipOfferState,
} from "../product/org-ownership-offer";
import { ProovraButton, ProovraCard, ProovraText } from "./index";
import { StepUpSheet, useStepUp } from "./step-up-sheet";

type Person = { userId: string | null; displayName?: string | null; email?: string | null };

export const ORG_OWNERSHIP_WEB_HANDOFF_COPY =
  "This account has no password or authenticator, so accepting cannot be confirmed in the app. Continue in the PROOVRA web app, signed in as this same account: the offer is shown there for this organization.";

export function OrgOwnershipOfferPanel({
  orgId,
  orgName,
  viewerUserId,
  viewerEmail,
  people,
  linkedOfferId,
  refreshKey,
  onAccepted,
}: {
  orgId: string;
  orgName: string | null;
  viewerUserId: string | null;
  viewerEmail?: string | null;
  people: Person[];
  linkedOfferId?: string | null;
  /** Changes when the owner has just made an offer, so the panel re-reads. */
  refreshKey?: number;
  onAccepted?: () => void | Promise<void>;
}) {
  const [state, setState] = useState<OrgOwnershipOfferState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [handoff, setHandoff] = useState(false);
  const stepUp = useStepUp();

  const load = useCallback(async () => {
    try {
      setState(parseOrgOwnershipOffer(await apiFetch(buildOrgOwnershipOfferPath(orgId))));
    } catch {
      // An older API (404) or a failed read shows no offer; it never invents one.
      setState({ offer: null, billingOwnerUserId: null });
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
  const side = orgOwnershipOfferSide(offer, viewerUserId);

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      setMessage(orgOwnershipOfferRefusal(err) ?? toSafeUserError(err, { message: fallback }).message);
      void load();
    },
    [load],
  );

  // A challenge this phone cannot answer is handed to the web app, not shown as a dead sheet.
  const reauthOnly = stepUp.challenge !== null && stepUpMethodFor(stepUp.challenge) === "reauth";
  const dismissStepUp = stepUp.dismiss;
  useEffect(() => {
    if (reauthOnly) {
      setHandoff(true);
      dismissStepUp();
    }
  }, [reauthOnly, dismissStepUp]);

  const accept = useCallback(async () => {
    if (!offer) return;
    const offerId = offer.id;
    const billingOwner = state?.billingOwnerUserId ?? null;
    setBusy(true);
    setMessage(null);
    setHandoff(false);
    await stepUp.start(
      async (proof) => {
        await apiFetch(buildOrgOwnershipOfferActionPath(orgId, offerId, "accept"), {
          method: "POST",
          body: JSON.stringify(withStepUp({}, proof)),
        });
        setMessage(orgOwnershipAcceptedCopy(orgName, nameOf(billingOwner)));
        await load();
        await onAccepted?.();
      },
      (err) => fail(err, "The offer could not be accepted. Nothing changed."),
    );
    setBusy(false);
    // nameOf reads props only; `people` and `viewerUserId` keep it current.
  }, [offer, state?.billingOwnerUserId, stepUp, orgId, orgName, load, onAccepted, fail, people, viewerUserId]);

  const settle = useCallback(
    async (kind: "decline" | "cancel") => {
      if (!offer) return;
      setBusy(true);
      setMessage(null);
      try {
        await apiFetch(buildOrgOwnershipOfferActionPath(orgId, offer.id, kind), {
          method: "POST",
          body: JSON.stringify({}),
        });
        setMessage(kind === "decline" ? ORG_OWNERSHIP_DECLINED_COPY : ORG_OWNERSHIP_WITHDRAWN_COPY);
        await load();
      } catch (err) {
        fail(err, "The offer could not be updated. Nothing changed.");
      } finally {
        setBusy(false);
      }
    },
    [offer, orgId, load, fail],
  );

  // Once this person has acted here, the outcome is the message; the link's offer is settled.
  const notice = message ? null : linkedOfferNotice(linkedOfferId ?? null, state, viewerUserId, viewerEmail ?? null);
  const webUrl = orgOwnershipOfferWebUrl(webOrigin(), orgId);

  if (side === "none" && !message && !notice) return null;

  return (
    <ProovraCard testID="org-ownership-offer" style={{ gap: theme.space.s2 }}>
      <ProovraText variant="h3" weight="semibold">
        Organization ownership offer
      </ProovraText>
      {notice ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary} testID="org-ownership-offer-link-notice">
          {notice}
        </ProovraText>
      ) : null}

      {offer && side === "recipient" ? (
        <View style={{ gap: theme.space.s1 }} testID={`org-ownership-offer-${offer.id}`}>
          <ProovraText variant="bodySm">
            {`${nameOf(offer.fromUserId)} has offered you ownership of ${orgName || "this organization"}${
              offer.expiresAtIso ? ` (open until ${formatUserDate(offer.expiresAtIso)})` : ""
            }. Accepting makes you the organization owner and the owner of the organization's workspaces they own; they become an admin.`}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary} testID="org-ownership-offer-billing">
            {`Billing does not move with ownership: the organization's billing owner stays ${nameOf(state?.billingOwnerUserId)}.`}
          </ProovraText>
          <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }}>
            <ProovraButton
              label="Accept ownership"
              variant="secondary"
              fullWidth={false}
              loading={busy}
              disabled={busy}
              onPress={() => void accept()}
            />
            <ProovraButton
              label="Decline"
              variant="ghost"
              fullWidth={false}
              disabled={busy}
              onPress={() => void settle("decline")}
            />
          </View>
        </View>
      ) : null}

      {offer && side === "offerer" ? (
        <View style={{ gap: theme.space.s1 }}>
          <ProovraText variant="bodySm">
            {`You offered ownership to ${nameOf(offer.toUserId)}${
              offer.expiresAtIso ? ` (open until ${formatUserDate(offer.expiresAtIso)})` : ""
            }. Nothing changes until they accept.`}
          </ProovraText>
          <ProovraButton
            label="Withdraw offer"
            variant="ghost"
            fullWidth={false}
            disabled={busy}
            onPress={() => void settle("cancel")}
          />
        </View>
      ) : null}

      {handoff && offer && side === "recipient" ? (
        <View style={{ gap: theme.space.s1 }} testID="org-ownership-offer-web-handoff">
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {ORG_OWNERSHIP_WEB_HANDOFF_COPY}
          </ProovraText>
          {webUrl ? (
            <ProovraButton
              label="Continue in the web app"
              variant="secondary"
              fullWidth={false}
              onPress={() => void WebBrowser.openBrowserAsync(webUrl)}
            />
          ) : (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              Open this organization in the PROOVRA web app to accept.
            </ProovraText>
          )}
        </View>
      ) : null}

      {message ? (
        <ProovraText variant="label" color={theme.color.ink.secondary} testID="org-ownership-offer-status">
          {message}
        </ProovraText>
      ) : null}

      <StepUpSheet
        challenge={reauthOnly ? null : stepUp.challenge}
        title={ORG_OWNERSHIP_STEP_UP_TITLE}
        busy={busy}
        onSubmit={(proof) => {
          setBusy(true);
          void stepUp
            .retry(proof, (err) => fail(err, "The offer could not be accepted. Nothing changed."))
            .finally(() => setBusy(false));
        }}
        onCancel={stepUp.dismiss}
      />
    </ProovraCard>
  );
}
