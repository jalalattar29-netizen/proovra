/**
 * EXTERNAL INTAKE — the native port of `apps/web/app/intake/[token]`.
 *
 * A generic contributor surface for ANY workspace category, driven entirely by
 * the workflow template snapshot the public validation endpoint returns. There
 * is no branch per industry here, exactly as there is none on the web.
 *
 * The contributor is not a PROOVRA user. Every call goes through
 * `publicFetch`, so the app's own session is never attached — an upload must
 * be attributed to the intake token, not to whichever account happens to be
 * signed in on this device.
 *
 * The flow is the web's: validate → identity (where the link allows it) →
 * consent → capture → submit. Consent is an explicit recorded act, because an
 * intake that captured evidence without recording what the person agreed to is
 * the kind of gap that matters years later in front of somebody who was not
 * there.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { publicFetch } from "../../../src/api";
import { formatUserDateTime } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraFormField,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraLoadingState,
  ProovraEmpty,
} from "../../../src/ui";
import {
  buildIntakeConsentBody,
  buildIntakeConsentPath,
  buildIntakeIdentityBody,
  buildIntakeIdentityPath,
  buildIntakeValidatePath,
  classifyIntakeFailure,
  identityFieldsFor,
  intakeFailureMessage,
  parseValidatedIntake,
  type IntakeFailure,
  type ValidatedIntake,
} from "../../../src/product/external-intake";

type Phase =
  | { kind: "validating" }
  | { kind: "identity"; intake: ValidatedIntake }
  | { kind: "consent"; intake: ValidatedIntake }
  | { kind: "ready"; intake: ValidatedIntake }
  | { kind: "failed"; failure: IntakeFailure };

export default function IntakeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;

  const [phase, setPhase] = useState<Phase>({ kind: "validating" });
  const [pseudonym, setPseudonym] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const validate = useCallback(async () => {
    if (!token) {
      setPhase({ kind: "failed", failure: "INVALID" });
      return;
    }
    try {
      const intake = parseValidatedIntake(
        await publicFetch(buildIntakeValidatePath(token), { method: "GET" }),
      );
      if (!intake) {
        setPhase({ kind: "failed", failure: "INVALID" });
        return;
      }
      // An anonymous link still offers a pseudonym; a named one asks for a
      // name. Either way identity comes before consent, because consent is
      // recorded against whoever is giving it.
      setPhase({ kind: "identity", intake });
    } catch (err) {
      setPhase({ kind: "failed", failure: classifyIntakeFailure(err) });
    }
  }, [token]);

  useEffect(() => {
    void validate();
  }, [validate]);

  const submitIdentity = useCallback(async () => {
    if (phase.kind !== "identity" || !token || !phase.intake.session) return;
    setBusy(true);
    try {
      await publicFetch(buildIntakeIdentityPath(token, phase.intake.session.id), {
        method: "POST",
        body: JSON.stringify(
          buildIntakeIdentityBody({
            pseudonym,
            submitterDisplayName: displayName,
            submitterEmail: email,
          }),
        ),
      });
      setPhase({ kind: "consent", intake: phase.intake });
    } catch (err) {
      setPhase({ kind: "failed", failure: classifyIntakeFailure(err) });
    } finally {
      setBusy(false);
    }
  }, [phase, token, pseudonym, displayName, email]);

  const acceptConsent = useCallback(async () => {
    if (phase.kind !== "consent" || !token || !phase.intake.session) return;
    setBusy(true);
    try {
      await publicFetch(buildIntakeConsentPath(token, phase.intake.session.id), {
        method: "POST",
        body: JSON.stringify(buildIntakeConsentBody({ accepted: true })),
      });
      setPhase({ kind: "ready", intake: phase.intake });
    } catch (err) {
      setPhase({ kind: "failed", failure: classifyIntakeFailure(err) });
    } finally {
      setBusy(false);
    }
  }, [phase, token]);

  const intake = phase.kind === "failed" || phase.kind === "validating" ? null : phase.intake;
  const fields = intake ? identityFieldsFor(intake.template) : null;

  return (
    <ProovraScreen testID="external-intake">
      <ProovraPageHeader
        title={intake?.template.name ?? "Evidence request"}
        eyebrow="Secure intake"
        subtitle={intake?.template.description ?? undefined}
      />

      {phase.kind === "validating" ? <ProovraLoadingState label="Opening your link" /> : null}

      {phase.kind === "failed" ? (
        <ProovraEmpty
          presence="page"
          title="This link is not open"
          purpose={intakeFailureMessage(phase.failure)}
        />
      ) : null}

      {intake?.request ? (
        <ProovraCard>
          <ProovraText variant="body" weight="semibold">
            {intake.request.title ?? "What has been asked for"}
          </ProovraText>
          {intake.request.deliverables.map((d, i) => (
            <ProovraText key={i} variant="label" color={theme.color.ink.secondary}>
              {`• ${d}`}
            </ProovraText>
          ))}
          {intake.request.dueAtIso ? (
            <ProovraBadge label={`Due ${formatUserDateTime(intake.request.dueAtIso)}`} tone="pending" />
          ) : null}
        </ProovraCard>
      ) : null}

      {phase.kind === "identity" && fields ? (
        <ProovraPageSection title="About you">
          <ProovraCard>
            {/*
              Only the fields this link's intake mode permits. Offering an
              email box on an anonymous link would invite a contributor to type
              an address that is then discarded — worse than not asking.
            */}
            {fields.pseudonym ? (
              <ProovraFormField label="A name to be known by (optional)">
                <ProovraInput
                  value={pseudonym}
                  onChangeText={setPseudonym}
                  placeholder="You can stay anonymous"
                  accessibilityLabel="A name to be known by"
                />
              </ProovraFormField>
            ) : null}
            {fields.displayName ? (
              <ProovraFormField label="Your name">
                <ProovraInput
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder="Your name"
                  autoCapitalize="words"
                  accessibilityLabel="Your name"
                />
              </ProovraFormField>
            ) : null}
            {fields.email ? (
              <ProovraFormField label="Your email">
                <ProovraInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  keyboardType="email-address"
                  accessibilityLabel="Your email"
                />
              </ProovraFormField>
            ) : null}
            <ProovraButton label="Continue" loading={busy} onPress={() => void submitIdentity()} />
          </ProovraCard>
        </ProovraPageSection>
      ) : null}

      {phase.kind === "consent" ? (
        <ProovraPageSection title="Before you send anything">
          <ProovraCard>
            {/*
              Consent is an explicit recorded act, not a checkbox nobody kept.
              An intake that captured evidence without recording what the
              person agreed to is the kind of gap that matters years later, in
              front of somebody who was not there.
            */}
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              What you send is preserved as evidence by the organization that sent you this link.
              Its integrity is recorded so it can be checked later. PROOVRA does not decide whether
              what you send is true, who created it, or whether it is admissible anywhere.
            </ProovraText>
            <ProovraButton
              label="I understand — continue"
              loading={busy}
              onPress={() => void acceptConsent()}
            />
            <ProovraButton label="Not now" variant="ghost" onPress={() => router.replace("/")} />
          </ProovraCard>
        </ProovraPageSection>
      ) : null}

      {phase.kind === "ready" && phase.intake.session ? (
        <ProovraPageSection title="What to send">
          <ProovraCard>
            {phase.intake.template.steps.length === 0 ? (
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Add the files you were asked for.
              </ProovraText>
            ) : (
              <View style={{ gap: theme.space.s2 }}>
                {phase.intake.template.steps.map((s) => (
                  <View key={s.id} style={{ gap: 2 }}>
                    <ProovraText variant="bodySm" weight="semibold">
                      {s.label}
                      {s.required ? " (required)" : ""}
                    </ProovraText>
                    {s.description ? (
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {s.description}
                      </ProovraText>
                    ) : null}
                  </View>
                ))}
              </View>
            )}
            <ProovraButton
              label="Add files"
              onPress={() =>
                router.push(
                  `/intake/capture?token=${encodeURIComponent(token ?? "")}` +
                    `&sid=${encodeURIComponent(phase.intake.session!.id)}`,
                )
              }
            />
          </ProovraCard>
        </ProovraPageSection>
      ) : null}
    </ProovraScreen>
  );
}
