/**
 * REVIEW INVITATION ACCEPTANCE — the native port of
 * `apps/web/app/portal/accept/[grantId]`.
 *
 * `portal-invitation-email.service.ts` mints this as
 * `${WEB_BASE_URL}/portal/accept/<grantId>?token=…`. The grant id names the
 * invitation; the token proves it. Both halves are required and a link missing
 * either is ignored rather than half-attempted — posting an empty token would
 * burn an acceptance attempt on an otherwise valid grant.
 *
 * Accepting moves the grant to ACTIVE and hands the reviewer straight into
 * their portal with the same token, so they do not have to find a second email.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";

import { publicFetch } from "../../../../src/api";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraPageHeader,
  ProovraLoadingState,
  ProovraEmpty,
} from "../../../../src/ui";
import {
  buildGrantAcceptPath,
  classifyPortalDenial,
  parseGrantAcceptLink,
  portalCredential,
  portalDenialMessage,
  type PortalDenial,
} from "../../../../src/product/portal";
import { setPortalToken } from "../../../../src/portal/portal-session";

type Phase =
  | { kind: "accepting" }
  | { kind: "accepted"; token: string }
  | { kind: "denied"; denial: PortalDenial };

export default function PortalAcceptScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    grantId?: string | string[];
    token?: string | string[];
  }>();
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const [phase, setPhase] = useState<Phase>({ kind: "accepting" });
  const started = useRef(false);

  const accept = useCallback(async () => {
    // The acceptance is single-use; a double-invoke would spend it and then
    // report the user's own valid link as already handled.
    if (started.current) return;
    started.current = true;

    const link = parseGrantAcceptLink({
      grantId: one(params.grantId),
      token: one(params.token),
    });
    if (!link) {
      setPhase({ kind: "denied", denial: "NOT_FOUND" });
      return;
    }

    try {
      await publicFetch(
        buildGrantAcceptPath(link.token),
        { method: "POST", body: JSON.stringify({ grantId: link.grantId }) },
        portalCredential(link.token, null),
      );
      setPortalToken(link.token);
      setPhase({ kind: "accepted", token: link.token });
    } catch (err) {
      const denial = classifyPortalDenial(err);
      // An MFA invitation is refused here (403 portal_mfa_required): this route
      // has no emailed-code step. The portal exchange does, and accepts the
      // invitation once the code is verified.
      if (denial === "MFA") {
        router.replace(`/portal/${encodeURIComponent(link.token)}`);
        return;
      }
      setPhase({ kind: "denied", denial });
    }
  }, [params.grantId, params.token, router]);

  useEffect(() => {
    void accept();
  }, [accept]);

  return (
    <ProovraScreen testID="portal-accept">
      <ProovraPageHeader title="Review invitation" eyebrow="External review" />

      {phase.kind === "accepting" ? (
        <ProovraLoadingState label="Opening your invitation" />
      ) : null}

      {phase.kind === "denied" ? (
        <ProovraEmpty
          presence="page"
          title="This invitation is not open"
          purpose={portalDenialMessage(phase.denial)}
        />
      ) : null}

      {phase.kind === "accepted" ? (
        <ProovraCard>
          <ProovraText variant="body">
            Your review access is active. You can open the reviews assigned to you now.
          </ProovraText>
          <ProovraButton
            label="Open my reviews"
            // Straight through with the same token, so the reviewer does not
            // have to go back and find a second email.
            onPress={() => router.replace(`/portal/${encodeURIComponent(phase.token)}`)}
          />
        </ProovraCard>
      ) : null}
    </ProovraScreen>
  );
}
