/**
 * proovra://step-up/complete — where a system-browser step-up returns
 * (2026-10-28).
 *
 * A passkey or an Organization sign-in that confirms a sensitive action runs
 * in the system browser the app opens (`expo-web-browser`'s auth session),
 * which normally closes itself on this URL and hands control back to the
 * waiting sheet. When a platform opens the URL as a deep link instead, this
 * screen is what the person sees: the result in plain words, and the way back
 * to the action — which re-reads the challenge from the server, the only
 * authority on whether it was approved.
 */
import { useLocalSearchParams, useRouter } from "expo-router";

import { ProovraButton, ProovraCard, ProovraPageHeader, ProovraScreen, ProovraText } from "../../../src/ui";
import { describeStepUpReturn } from "../../../src/product/challenge-step-up";

export default function StepUpCompleteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ result?: string; reason?: string }>();
  const copy = describeStepUpReturn(params.result ?? null);
  return (
    <ProovraScreen testID="step-up-complete">
      <ProovraPageHeader title={copy.title} eyebrow="Confirm it's you" />
      <ProovraCard>
        <ProovraText variant="bodySm">{copy.body}</ProovraText>
      </ProovraCard>
      <ProovraButton
        label="Return to what you were doing"
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      />
    </ProovraScreen>
  );
}
