/**
 * NEW INTAKE LINK (T-16 / RC-20) — the native port of the web wizard
 * (`intake-links/_components/wizard/CreateLinkWizard.tsx` + `LinkCreatedDialog.tsx`).
 *
 * Decisions and copy live in `src/product/intake-create.ts`. Touch adaptations
 * only: listboxes are chip rows or option cards; the one-time "Copy link" is
 * the platform Share sheet (no clipboard module ships in this build) plus the
 * link as selectable text.
 *
 * The raw token exists in THIS screen's memory only, exactly as on the web:
 * leaving the result view drops it, and the list never has it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "../../src/ui/copy-button";
import { Pressable, Share, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import {
  renderIntakeEmailMessage,
  renderIntakeSmsMessage,
  resolveIntakeSenderDisplay,
} from "@proovra/shared";

import { apiFetch } from "../../src/api";
import { toSafeUserError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { usePlatformContext } from "../../src/product/platform-context";
import {
  ACCEPTED_KINDS,
  CHANNELS,
  CHANNEL_LABEL,
  CREATE_COPY,
  CREATE_INTAKE_LINK_PATH,
  EXPIRY_OPTIONS,
  INTAKE_MODES,
  LOCATION_OPTIONS,
  STEPS,
  STEP_LABEL,
  buildCreateBody,
  buildSenderIdentityPath,
  buildWorkflowTemplatesPath,
  channelConfigured,
  createdFailedLine,
  createdSentLine,
  defaultChannel,
  expiresAtFor,
  firstInvalidStep,
  friendlyCreateError,
  friendlySendError,
  initialWizardState,
  intakeUrlFor,
  modeEligible,
  parseCreatedIntakeLink,
  parsePurposes,
  parseSenderIdentity,
  suggestedKindsNote,
  validateStep,
  webOrigin,
  BUILT_IN_PURPOSES,
  type AcceptedKind,
  type Channel,
  type CreatedIntakeLink,
  type IntakePurpose,
  type SenderIdentity,
  type SenderMode,
  type StepId,
  type WizardErrors,
  type WizardState,
} from "../../src/product/intake-create";
import { buildIntakeSendBody, buildIntakeSendPath } from "../../src/product/intake-links";
import { theme } from "../../src/theme/theme";
import {
  ProovraBadge,
  ProovraButton,
  ProovraCard,
  ProovraConfirmSheet,
  ProovraDetailRows,
  ProovraFilterChips,
  ProovraFormField,
  ProovraInput,
  ProovraPageHeader,
  ProovraScreen,
  ProovraSection,
  ProovraText,
} from "../../src/ui";

const PLACEHOLDER_INTAKE_URL = "https://app.proovra.com/intake/[secure-link]";

export default function NewIntakeLinkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ purpose?: string }>();
  const { context } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;
  const workspaceName = context?.displayName ?? null;

  const [transport, setTransport] = useState<SenderIdentity | null>(null);
  const [purposes, setPurposes] = useState<IntakePurpose[]>([...BUILT_IN_PURPOSES]);
  const [state, setState] = useState<WizardState>(() =>
    initialWizardState({ workspaceName, channel: "SMS", initialSlug: typeof params.purpose === "string" ? params.purpose : null }),
  );
  const [channelTouched, setChannelTouched] = useState(false);
  const [kindsTouched, setKindsTouched] = useState(false);
  const [step, setStep] = useState<StepId>("request");
  const [errors, setErrors] = useState<WizardErrors>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [created, setCreated] = useState<CreatedIntakeLink | null>(null);
  // One idempotency key per wizard, reused on retry (CreateLinkWizard.tsx:104-109).
  const idempotencyKey = useRef(`create:${Crypto.randomUUID()}`);
  const submitting = useRef(false);

  useEffect(() => {
    if (!teamId) return;
    apiFetch(buildSenderIdentityPath(teamId))
      .then((d) => setTransport(parseSenderIdentity(d)))
      .catch(() => setTransport(null));
    apiFetch(buildWorkflowTemplatesPath(teamId))
      .then((d) => setPurposes(parsePurposes(d)))
      .catch(() => setPurposes([...BUILT_IN_PURPOSES]));
  }, [teamId]);

  // Default channel follows what this deployment can send, until chosen.
  useEffect(() => {
    if (!channelTouched) setState((s) => ({ ...s, channel: defaultChannel(transport) }));
  }, [transport, channelTouched]);

  const purpose = purposes.find((p) => p.slug === state.purposeSlug);

  // A request type that does not support the chosen link type moves it to
  // one it does (CreateLinkWizard.tsx:168-175).
  useEffect(() => {
    if (purpose && !modeEligible(purpose, state.intakeMode)) {
      const next = modeEligible(purpose, "EXTERNAL_ONE_TIME")
        ? "EXTERNAL_ONE_TIME"
        : INTAKE_MODES.find((m) => modeEligible(purpose, m.value))?.value;
      if (next) setState((s) => ({ ...s, intakeMode: next }));
    }
  }, [purpose, state.intakeMode]);

  const patch = useCallback((p: Partial<WizardState>) => {
    setState((s) => ({ ...s, ...p }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(p)) delete next[k as keyof WizardState];
      if ("channel" in p) {
        delete next.recipientEmail;
        delete next.recipientPhone;
      }
      if ("expiryChoice" in p) delete next.expiresInHours;
      if ("senderMode" in p) delete next.senderName;
      return next;
    });
  }, []);

  const dirty = useMemo(() => {
    const init = initialWizardState({ workspaceName, channel: state.channel, initialSlug: state.purposeSlug });
    return JSON.stringify({ ...state, acceptedKinds: [...state.acceptedKinds].sort() }) !== JSON.stringify({ ...init, acceptedKinds: [...init.acceptedKinds].sort() });
  }, [state, workspaceName]);

  const stepIndex = STEPS.indexOf(step);
  const origin = webOrigin();

  const next = () => {
    const e = validateStep(step, state, purposes, transport);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setStep(STEPS[stepIndex + 1]!);
  };

  const submit = async () => {
    if (!teamId || submitting.current) return;
    const bad = firstInvalidStep(state, purposes, transport);
    if (bad) {
      setStep(bad);
      setErrors(validateStep(bad, state, purposes, transport));
      return;
    }
    if (!origin) {
      setSubmitError(CREATE_COPY.noOrigin);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await apiFetch(CREATE_INTAKE_LINK_PATH, {
        method: "POST",
        body: JSON.stringify(buildCreateBody(state, { teamId, origin, idempotencyKey: idempotencyKey.current })),
      });
      const parsed = parseCreatedIntakeLink(res);
      if (!parsed) throw new Error("Couldn't create the intake link.");
      setCreated(parsed);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      setSubmitError(friendlyCreateError(e?.code && e.code !== "API_ERROR" ? e.code : null, toSafeUserError(err).message || null));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  if (created && origin) {
    return <CreatedView created={created} url={intakeUrlFor(origin, created.rawToken)} onDone={() => router.replace("/intake-links")} />;
  }

  const purposeLabel = purpose?.label ?? state.purposeSlug;

  return (
    <ProovraScreen shell testID="intake-link-create">
      <ProovraPageHeader
        title={CREATE_COPY.title}
        subtitle={`${purposeLabel} · step ${stepIndex + 1} of 4`}
        contextStrip={
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {STEPS.map((s) => (s === step ? `● ${STEP_LABEL[s]}` : STEP_LABEL[s])).join("  ·  ")}
          </ProovraText>
        }
      />

      {submitError ? (
        <ProovraCard>
          <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
            {submitError}
          </ProovraText>
        </ProovraCard>
      ) : null}
      {step !== "request" && !channelConfigured(transport, state.channel) ? (
        <ProovraText variant="label" color={theme.color.status.pending.fg}>
          This deployment can't send on that channel yet. Choose another, or copy the link and share it yourself.
        </ProovraText>
      ) : null}

      {step === "request" ? (
        <ProovraSection title={STEP_LABEL.request}>
          <ProovraFilterChips
            label={CREATE_COPY.purposeField}
            value={state.purposeSlug}
            disabled={busy}
            onChange={(slug) => {
              const p = purposes.find((x) => x.slug === slug);
              patch({ purposeSlug: slug, ...(kindsTouched || !p ? {} : { acceptedKinds: [...p.recommendedKinds] }) });
            }}
            options={purposes.map((p) => ({ value: p.slug, label: p.label }))}
          />
          {purpose ? <Help text={purpose.description} /> : null}
          {purpose && suggestedKindsNote(purpose) ? <Help text={suggestedKindsNote(purpose)!} /> : null}
          <FieldError text={errors.purposeSlug} />

          <OptionCards
            label={CREATE_COPY.modeField}
            help={CREATE_COPY.modeHelp}
            value={state.intakeMode}
            onChange={(v) => patch({ intakeMode: v as WizardState["intakeMode"] })}
            options={INTAKE_MODES.map((m) => {
              const ok = modeEligible(purpose, m.value);
              return { value: m.value, title: m.title, description: ok ? m.description : CREATE_COPY.modeIneligible, disabled: !ok };
            })}
          />
          <FieldError text={errors.intakeMode} />
        </ProovraSection>
      ) : null}

      {step === "delivery" ? (
        <ProovraSection title={STEP_LABEL.delivery}>
          <OptionCards
            label={CREATE_COPY.channelField}
            help={CREATE_COPY.channelHelp}
            value={state.channel}
            onChange={(v) => {
              setChannelTouched(true);
              patch({ channel: v as Channel });
            }}
            options={CHANNELS.map((c) => {
              const ok = channelConfigured(transport, c.value);
              return { value: c.value, title: c.title, description: ok ? c.description : CREATE_COPY.channelUnconfigured, disabled: !ok };
            })}
          />
          <FieldError text={errors.channel} />
          <ProovraFormField label={CREATE_COPY.recipientLabel}>
            <ProovraInput value={state.recipientLabel} onChangeText={(t) => patch({ recipientLabel: t.slice(0, 180) })} accessibilityLabel={CREATE_COPY.recipientLabel} />
          </ProovraFormField>
          <Help text={CREATE_COPY.recipientLabelHelp} />
          <ProovraFormField label={CREATE_COPY.customerId}>
            <ProovraInput value={state.customerId} onChangeText={(t) => patch({ customerId: t.slice(0, 120) })} placeholder="CUST-849271" autoCapitalize="none" accessibilityLabel={CREATE_COPY.customerId} />
          </ProovraFormField>
          <Help text={CREATE_COPY.customerIdHelp} />
          {state.channel === "EMAIL" ? (
            <ProovraFormField label={`${CREATE_COPY.recipientEmail} (required)`} error={errors.recipientEmail ?? null}>
              {/* Never autofilled: the operator's own address must not be offered for the recipient. */}
              <ProovraInput value={state.recipientEmail} onChangeText={(t) => patch({ recipientEmail: t.slice(0, 320) })} keyboardType="email-address" autoComplete="off" accessibilityLabel={CREATE_COPY.recipientEmail} />
            </ProovraFormField>
          ) : null}
          {state.channel === "SMS" ? (
            <>
              <ProovraFormField label={`${CREATE_COPY.recipientPhone} (required)`} error={errors.recipientPhone ?? null}>
                <ProovraInput value={state.recipientPhone} onChangeText={(t) => patch({ recipientPhone: t.slice(0, 32) })} placeholder="+14155550123" keyboardType="phone-pad" autoComplete="off" accessibilityLabel={CREATE_COPY.recipientPhone} />
              </ProovraFormField>
              <Help text={CREATE_COPY.recipientPhoneHelp} />
            </>
          ) : null}
          {state.channel === "MANUAL" ? <Help text={CREATE_COPY.manualNote} /> : null}
          {state.channel !== "EMAIL" && errors.recipientEmail ? <FieldError text={errors.recipientEmail} /> : null}
          {state.channel !== "SMS" && errors.recipientPhone ? <FieldError text={errors.recipientPhone} /> : null}

          <OptionCards
            label={CREATE_COPY.senderField}
            help={CREATE_COPY.senderHelp}
            value={state.senderMode}
            onChange={(v) => patch({ senderMode: v as SenderMode })}
            options={[
              { value: "PROOVRA", title: "PROOVRA", description: "A neutral sender name. Best when the request should not name you." },
              ...(workspaceName ? [{ value: "WORKSPACE", title: "Workspace name", description: `Shows “${workspaceName} via PROOVRA”.` }] : []),
              { value: "CUSTOM", title: "Custom name", description: "Show a company, case, or sender name of your choosing." },
            ]}
          />
          {state.senderMode === "CUSTOM" ? (
            <>
              <ProovraFormField label={`${CREATE_COPY.senderName} (required)`} error={errors.senderName ?? null}>
                <ProovraInput value={state.senderName} onChangeText={(t) => patch({ senderName: t.slice(0, 80) })} placeholder="Smith & Partners" accessibilityLabel={CREATE_COPY.senderName} />
              </ProovraFormField>
              <Help text={CREATE_COPY.senderNameHelp} />
            </>
          ) : null}
        </ProovraSection>
      ) : null}

      {step === "rules" ? (
        <ProovraSection title={STEP_LABEL.rules}>
          <OptionCards
            label={CREATE_COPY.locationField}
            help={CREATE_COPY.locationHelp}
            value={state.locationPolicy}
            onChange={(v) => patch({ locationPolicy: v as WizardState["locationPolicy"] })}
            options={LOCATION_OPTIONS.map((o) => ({ value: o.value, title: o.value === "OPTIONAL" ? `${o.title} · Recommended` : o.title, description: o.description }))}
          />
          <ProovraFilterChips
            label={CREATE_COPY.expiryField}
            value={state.expiryChoice}
            onChange={(v) => (v === "custom" ? patch({ expiryChoice: v }) : patch({ expiryChoice: v, expiresInHours: v }))}
            options={EXPIRY_OPTIONS}
          />
          {Number.isFinite(Number(state.expiresInHours)) ? (
            <Help text={`Expires ${formatUserDateTime(expiresAtFor(Number(state.expiresInHours)))} in your local time. Stored and sent as UTC.`} />
          ) : null}
          {state.expiryChoice === "custom" ? (
            <>
              <ProovraFormField label={CREATE_COPY.customHours} error={errors.expiresInHours ?? null}>
                <ProovraInput value={state.expiresInHours} onChangeText={(t) => patch({ expiresInHours: t.replace(/[^\d]/g, "") })} keyboardType="number-pad" accessibilityLabel={CREATE_COPY.customHours} />
              </ProovraFormField>
              <Help text={CREATE_COPY.customHoursHelp} />
            </>
          ) : null}
          <ProovraFormField label={CREATE_COPY.maxFiles} error={errors.maxFiles ?? null}>
            <ProovraInput value={state.maxFiles} onChangeText={(t) => patch({ maxFiles: t.replace(/[^\d]/g, "") })} keyboardType="number-pad" accessibilityLabel={CREATE_COPY.maxFiles} />
          </ProovraFormField>
          <Help text={CREATE_COPY.maxFilesHelp} />
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
            {CREATE_COPY.kindsField}
          </ProovraText>
          <Help text={CREATE_COPY.kindsHelp} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
            {ACCEPTED_KINDS.map((k) => {
              const on = state.acceptedKinds.includes(k.value);
              return (
                <Pressable
                  key={k.value}
                  onPress={() => {
                    setKindsTouched(true);
                    patch({ acceptedKinds: on ? state.acceptedKinds.filter((x) => x !== k.value) : [...state.acceptedKinds, k.value as AcceptedKind] });
                  }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${k.label} (${k.hint})`}
                  style={{
                    paddingHorizontal: theme.space.s3,
                    paddingVertical: theme.space.s2,
                    borderRadius: theme.radius.pill,
                    borderWidth: 1,
                    borderColor: on ? theme.color.accent.a500 : theme.color.border.default,
                    backgroundColor: on ? theme.color.surface.card : "transparent",
                  }}
                >
                  <ProovraText variant="label" weight="semibold" color={on ? theme.color.accent.a600 : theme.color.ink.secondary}>
                    {`${on ? "✓ " : ""}${k.label}`}
                  </ProovraText>
                </Pressable>
              );
            })}
          </View>
          <FieldError text={errors.acceptedKinds} />
          <ProovraFormField label={CREATE_COPY.consentField} error={errors.consentText ?? null}>
            <ProovraInput value={state.consentText} onChangeText={(t) => patch({ consentText: t })} multiline accessibilityLabel={CREATE_COPY.consentField} />
          </ProovraFormField>
          <Help text={CREATE_COPY.consentHelp} />
        </ProovraSection>
      ) : null}

      {step === "review" ? <Review state={state} purpose={purpose} workspaceName={workspaceName} transport={transport} /> : null}

      <View style={{ gap: theme.space.s2, marginTop: theme.space.s4 }}>
        {step === "review" ? (
          <ProovraButton
            label={busy ? "Creating…" : state.channel === "MANUAL" ? "Create secure link" : "Create and send"}
            disabled={busy}
            onPress={() => void submit()}
            testID="intake-create-submit"
          />
        ) : (
          <ProovraButton label="Continue" onPress={next} testID="intake-continue" />
        )}
        <ProovraButton
          label={stepIndex === 0 ? "Cancel" : "Back"}
          variant="ghost"
          disabled={busy}
          onPress={() => {
            if (stepIndex > 0) setStep(STEPS[stepIndex - 1]!);
            else if (dirty) setDiscarding(true);
            else router.back();
          }}
        />
      </View>

      <ProovraConfirmSheet
        visible={discarding}
        title={CREATE_COPY.discardTitle}
        consequence={CREATE_COPY.discardBody}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        tone="danger"
        onConfirm={() => {
          setDiscarding(false);
          router.back();
        }}
        onCancel={() => setDiscarding(false)}
      />
    </ProovraScreen>
  );
}

function Help({ text }: { text: string }) {
  return (
    <ProovraText variant="label" color={theme.color.ink.muted}>
      {text}
    </ProovraText>
  );
}

function FieldError({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <ProovraText variant="label" color={theme.color.status.risk.fg}>
      {text}
    </ProovraText>
  );
}

/** Radio cards: title + description, per-option disabled (chips cannot express either). */
function OptionCards({
  label,
  help,
  value,
  onChange,
  options,
}: {
  label: string;
  help?: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; title: string; description: string; disabled?: boolean }>;
}) {
  return (
    <View style={{ gap: theme.space.s2 }} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
        {label}
      </ProovraText>
      {help ? <Help text={help} /> : null}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => !o.disabled && onChange(o.value)}
            disabled={o.disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected: on, disabled: !!o.disabled }}
            accessibilityLabel={`${label}: ${o.title}`}
            style={{
              padding: theme.space.s3,
              borderRadius: theme.radius.md,
              borderWidth: on ? 2 : 1,
              borderColor: on ? theme.color.accent.a500 : theme.color.border.default,
              opacity: o.disabled ? 0.5 : 1,
              gap: 2,
            }}
          >
            <ProovraText variant="bodySm" weight="semibold">
              {o.title}
            </ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {o.description}
            </ProovraText>
          </Pressable>
        );
      })}
    </View>
  );
}

function Review({
  state: s,
  purpose,
  workspaceName,
  transport,
}: {
  state: WizardState;
  purpose: IntakePurpose | undefined;
  workspaceName: string | null;
  transport: SenderIdentity | null;
}) {
  const expires = expiresAtFor(Number(s.expiresInHours));
  const appearsFrom =
    s.senderMode === "CUSTOM" ? `${s.senderName.trim()} via PROOVRA` : s.senderMode === "WORKSPACE" && workspaceName ? `${workspaceName} via PROOVRA` : "PROOVRA";
  const preview = useMemo(() => {
    if (s.channel === "MANUAL") return null;
    let senderDisplay = "PROOVRA secure intake";
    try {
      senderDisplay = resolveIntakeSenderDisplay({
        mode: s.senderMode,
        workspaceName,
        customName: s.senderMode === "CUSTOM" ? s.senderName.trim() || "Your business" : null,
      }).display;
    } catch {
      senderDisplay = resolveIntakeSenderDisplay({ mode: "PROOVRA" }).display;
    }
    const input = {
      senderDisplay,
      requestTypeSlug: s.purposeSlug,
      recipientLabel: s.recipientLabel.trim() || null,
      intakeUrl: PLACEHOLDER_INTAKE_URL,
      expiresAtUtc: expires,
      channel: s.channel as "EMAIL" | "SMS",
      locale: "en" as const,
    };
    if (s.channel === "EMAIL") {
      const r = renderIntakeEmailMessage(input);
      return { subject: r.subject, body: r.text };
    }
    return { subject: null, body: renderIntakeSmsMessage(input) };
  }, [s, workspaceName, expires]);

  const sentVia =
    s.channel === "EMAIL"
      ? transport
        ? transport.email.configured
          ? `${transport.email.fromName ?? "PROOVRA"} <${transport.email.fromAddressPreview ?? "no-reply@proovra.com"}>`
          : "Not configured on this deployment"
        : "Checking provider…"
      : s.channel === "SMS"
        ? transport
          ? transport.sms.configured
            ? transport.sms.fromNumberPreview
              ? `PROOVRA via ${transport.sms.fromNumberPreview}`
              : "PROOVRA"
            : "Not configured on this deployment"
          : "Checking provider…"
        : null;

  return (
    <ProovraSection title={STEP_LABEL.review}>
      <ProovraText variant="label" weight="semibold">Request</ProovraText>
      <ProovraDetailRows
        rows={[
          { label: "Asking for", value: purpose?.label ?? s.purposeSlug },
          { label: "Link type", value: INTAKE_MODES.find((m) => m.value === s.intakeMode)?.title ?? s.intakeMode },
          { label: "Recipient label", value: s.recipientLabel.trim() || "— none —" },
        ]}
      />
      <ProovraText variant="label" weight="semibold">Delivery</ProovraText>
      <ProovraDetailRows
        rows={[
          { label: "Channel", value: CHANNEL_LABEL[s.channel] },
          { label: "Goes to", value: s.channel === "EMAIL" ? s.recipientEmail.trim() : s.channel === "SMS" ? s.recipientPhone.trim() : "You share the link yourself" },
          { label: "Appears from", value: appearsFrom },
        ]}
      />
      <ProovraText variant="label" weight="semibold">Collection rules</ProovraText>
      <ProovraDetailRows
        rows={[
          { label: "Expires", value: formatUserDateTime(expires) },
          { label: "Maximum files", value: s.maxFiles.trim() || "No per-submission cap" },
          { label: "Accepted types", value: ACCEPTED_KINDS.filter((k) => s.acceptedKinds.includes(k.value)).map((k) => k.label).join(", ") },
          { label: "Location", value: LOCATION_OPTIONS.find((o) => o.value === s.locationPolicy)?.title ?? s.locationPolicy },
          { label: "Consent text", value: s.consentText.trim() || "— none —" },
        ]}
      />
      {s.channel === "MANUAL" ? (
        <Help text={CREATE_COPY.reviewManual} />
      ) : preview ? (
        <ProovraCard>
          <ProovraText variant="label" weight="semibold">Message preview</ProovraText>
          <ProovraDetailRows
            rows={[
              { label: "Appears from", value: appearsFrom },
              ...(sentVia ? [{ label: "Sent via", value: sentVia }] : []),
              { label: "Goes to", value: (s.channel === "EMAIL" ? s.recipientEmail : s.recipientPhone).trim() || "—" },
              { label: "Channel", value: CHANNEL_LABEL[s.channel] },
              { label: "Expires", value: formatUserDateTime(expires) },
              ...(preview.subject ? [{ label: "Subject", value: preview.subject }] : []),
            ]}
          />
          <ProovraText variant="bodySm" selectable>
            {preview.body}
          </ProovraText>
          <Help text="Preview only. Nothing is sent until you create the link, and the secure link shown as [secure-link] is generated at that moment." />
          <Help
            text={`No account is required to upload. Ask the recipient not to forward the link.${s.channel === "SMS" ? " Carrier rules add the STOP opt-out line to SMS." : ""}`}
          />
        </ProovraCard>
      ) : null}
    </ProovraSection>
  );
}

function CreatedView({ created, url, onDone }: { created: CreatedIntakeLink; url: string; onDone: () => void }) {
  const [sending, setSending] = useState<"EMAIL" | "SMS" | null>(null);
  const [sendMessage, setSendMessage] = useState<string | null>(null);

  const send = async (channel: "EMAIL" | "SMS") => {
    setSending(channel);
    setSendMessage(null);
    try {
      await apiFetch(buildIntakeSendPath(created.linkId), {
        method: "POST",
        // Native sends an idempotency key on this call; the web does not (spec).
        body: JSON.stringify(buildIntakeSendBody({ channel, rawToken: created.rawToken, intakeUrl: url, idempotencyKey: `send:${Crypto.randomUUID()}` })),
      });
      setSendMessage(`Queued for ${CHANNEL_LABEL[channel]} delivery. Track it under Delivery history.`);
    } catch (err) {
      const code = (err as { code?: string })?.code ?? null;
      setSendMessage(friendlySendError(code) ?? (toSafeUserError(err).message || "Couldn't send the link."));
    } finally {
      setSending(null);
    }
  };

  const d = created.delivery;
  return (
    <ProovraScreen shell testID="intake-link-created">
      <ProovraPageHeader title={CREATE_COPY.createdTitle} subtitle={CREATE_COPY.createdSubtitle} />
      <ProovraCard>
        {d.status === "sent" ? (
          <View style={{ gap: theme.space.s2 }}>
            <ProovraBadge label="Sent" tone="verified" />
            <ProovraText variant="bodySm">{createdSentLine(d.method)}</ProovraText>
          </View>
        ) : d.status === "failed" ? (
          <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
            {createdFailedLine(d.method, d.reason)}
          </ProovraText>
        ) : (
          <ProovraText variant="bodySm">{CREATE_COPY.createdSkipped}</ProovraText>
        )}
      </ProovraCard>
      <ProovraSection title="Secure link">
        <ProovraText variant="bodySm" selectable>
          {url}
        </ProovraText>
        {/* LinkCreatedDialog.tsx:212 — Copy link, and the device share sheet beside it. */}
        <CopyButton value={url} label="Copy link" variant="secondary" testID="intake-copy" />
        <ProovraButton
          label="Share link"
          onPress={() => void Share.share({ message: url })}
          testID="intake-share"
        />
        <Help text={CREATE_COPY.createdLinkHelp} />
      </ProovraSection>
      {created.hasRecipientEmail || created.hasRecipientPhone ? (
        <View style={{ gap: theme.space.s2 }}>
          {created.hasRecipientEmail ? (
            <ProovraButton label={sending === "EMAIL" ? "Sending…" : "Send by email"} variant="secondary" disabled={sending !== null} onPress={() => void send("EMAIL")} />
          ) : null}
          {created.hasRecipientPhone ? (
            <ProovraButton label={sending === "SMS" ? "Sending…" : "Send by SMS"} variant="secondary" disabled={sending !== null} onPress={() => void send("SMS")} />
          ) : null}
          {sendMessage ? <ProovraText variant="bodySm">{sendMessage}</ProovraText> : null}
        </View>
      ) : null}
      <ProovraButton label="Done" variant="ghost" onPress={onDone} />
    </ProovraScreen>
  );
}
