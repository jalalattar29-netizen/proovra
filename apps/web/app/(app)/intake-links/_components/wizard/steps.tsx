"use client";

/**
 * Intake links wizard — the four steps.
 *
 * Each step is a pure render over the shared `WizardState` plus an `onPatch`
 * callback. No step fetches, no step mutates, and no step owns a copy of the
 * form — which is what makes Back/Continue lossless.
 */

import * as React from "react";
import { CUSTOMER_ID_MAX_LENGTH } from "@proovra/shared";

import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { AppStatusBadge } from "../../../../../components/app-primitives/AppStatusBadge";
import { INTAKE_LINK_LOCATION_POLICY_OPTIONS } from "@proovra/shared";
import type { IntakeLinkLocationPolicy } from "@proovra/shared";

import {
  ACCEPTED_KIND_OPTIONS,
  CONSENT_TEXT_MAX,
  DELIVERY_CHANNELS,
  EXPIRY_HOURS_MAX,
  EXPIRY_HOURS_MIN,
  EXPIRY_PRESETS,
  MAX_FILES_MAX,
  MAX_FILES_MIN,
  RECIPIENT_EMAIL_MAX,
  RECIPIENT_LABEL_MAX,
  RECIPIENT_PHONE_MAX,
  REQUEST_PURPOSES,
  SENDER_NAME_MAX,
  expiryFromHours,
  findRequestPurpose,
  requiredRecipientField,
  type AcceptedKind,
  type DeliveryChannelWire,
} from "../../../../../lib/intake-links/catalog";
import {
  INTAKE_MODE_VOCABULARY,
  channelLabel,
  intakeModeLabel,
  type IntakeModeWireValue,
} from "../../../../../lib/intake-links/vocabulary";
import { formatUserDateTime } from "../../../../../lib/date";
import type { SenderTransportInfo, WorkflowTemplateRow } from "../../_lib/types";
import {
  channelUnavailableReason,
  eligibleIntakeModes,
  type WizardErrors,
  type WizardState,
} from "../../_lib/wizardState";
import {
  AcceptedKindIcon,
  DeliveryChannelIcon,
  RequestPurposeGlyph,
} from "../icons";
import { ChoiceCards, Field, KindChips } from "./fields";
import { MessagePreview, type PreviewChannel } from "./MessagePreview";

/** Same bound the API enforces, imported so the two cannot drift. */
const CUSTOMER_ID_MAX = CUSTOMER_ID_MAX_LENGTH;

export const FIELD_IDS = {
  purpose: "ilk-f-purpose",
  recipientLabel: "ilk-f-recipient-label",
  customerId: "ilk-f-customer-id",
  recipientEmail: "ilk-f-email",
  recipientPhone: "ilk-f-phone",
  senderName: "ilk-f-sender-name",
  expiry: "ilk-f-expiry",
  expiryHours: "ilk-f-expiry-hours",
  maxFiles: "ilk-f-max-files",
  consent: "ilk-f-consent",
} as const;

export type StepProps = {
  state: WizardState;
  errors: WizardErrors;
  onPatch: (patch: Partial<WizardState>) => void;
  templates: ReadonlyArray<WorkflowTemplateRow>;
  transport: SenderTransportInfo | null;
  workspaceName: string;
};

// ===========================================================================
// Step 1 — Request
// ===========================================================================

export function StepRequest({
  state,
  errors,
  onPatch,
  templates,
}: StepProps) {
  const builtInSlugs = new Set(REQUEST_PURPOSES.map((p) => p.slug));
  const workspaceTemplates = templates.filter((t) => !builtInSlugs.has(t.slug));

  const options = [
    ...REQUEST_PURPOSES.map((p) => ({
      value: p.slug,
      label: p.label,
      description: p.description,
    })),
    ...workspaceTemplates.map((t) => ({
      value: t.slug,
      label: t.name,
      description: "Template configured for this workspace",
    })),
  ];

  const selectedPurpose = findRequestPurpose(state.purposeSlug);
  const selectedTemplate = templates.find((t) => t.slug === state.purposeSlug);
  const purposeDescription =
    selectedPurpose?.description ??
    selectedTemplate?.description ??
    "A workspace template. Its collection rules follow the settings below.";

  const eligible = eligibleIntakeModes(state.purposeSlug, templates);

  return (
    <>
      <Field
        label="What are you asking for?"
        htmlFor={FIELD_IDS.purpose}
        help={purposeDescription}
        error={errors.purposeSlug ?? null}
      >
        <AppListbox
          id={FIELD_IDS.purpose}
          value={state.purposeSlug}
          options={options}
          onChange={(slug) => {
            const purpose = findRequestPurpose(slug);
            onPatch({
              purposeSlug: slug,
              // A purpose change re-seeds the recommended file types ONLY
              // while the operator has not deliberately chosen a set. Once
              // they have, their choice survives — silently overwriting it is
              // how a "documents only" request ends up accepting video.
              ...(purpose && !state.kindsTouched
                ? { acceptedKinds: [...purpose.recommendedKinds] }
                : {}),
            });
          }}
          ariaLabel="What are you asking for?"
        />
      </Field>

      {selectedPurpose ? (
        <p className="ilk-note" data-intake-link-purpose-glyph>
          <span className="ilk-choice__icon">
            <RequestPurposeGlyph icon={selectedPurpose.icon} size={16} />
          </span>{" "}
          Suggested file types:{" "}
          {selectedPurpose.recommendedKinds
            .map(
              (k) =>
                ACCEPTED_KIND_OPTIONS.find((o) => o.value === k)?.label ?? k,
            )
            .join(", ")}
          . You can change them in step 3.
        </p>
      ) : null}

      <ChoiceCards<IntakeModeWireValue>
        name="intake-mode"
        testAttr="intake-link-mode"
        legend="How should the link work?"
        columns={2}
        value={state.intakeMode}
        onChange={(intakeMode) => onPatch({ intakeMode })}
        error={errors.intakeMode ?? null}
        help="Reuse and contributor identity are one setting in PROOVRA — each option below states both."
        options={(
          [
            "EXTERNAL_ONE_TIME",
            "EXTERNAL_REUSABLE",
            "EXTERNAL_ANONYMOUS",
            "EXTERNAL_PSEUDONYMOUS",
          ] as IntakeModeWireValue[]
        ).map((mode) => ({
          value: mode,
          title: INTAKE_MODE_VOCABULARY[mode].label,
          description: INTAKE_MODE_VOCABULARY[mode].description,
          disabled: !eligible.includes(mode),
          disabledReason: "This request type doesn't support this link type.",
        }))}
      />
    </>
  );
}

// ===========================================================================
// Step 2 — Delivery and sender
// ===========================================================================

export function StepDelivery({
  state,
  errors,
  onPatch,
  transport,
  workspaceName,
}: StepProps) {
  const requires = requiredRecipientField(state.channel);

  const senderOptions = [
    {
      value: "PROOVRA" as const,
      title: "PROOVRA",
      description: "A neutral sender name. Best when the request should not name you.",
    },
    ...(workspaceName
      ? [
          {
            value: "WORKSPACE" as const,
            title: "Workspace name",
            description: `Shows “${workspaceName} via PROOVRA”.`,
          },
        ]
      : []),
    {
      value: "CUSTOM" as const,
      title: "Custom name",
      description: "Show a company, case, or sender name of your choosing.",
    },
  ];

  return (
    <>
      <ChoiceCards<DeliveryChannelWire>
        name="delivery-channel"
        testAttr="intake-link-delivery-method"
        legend="How should the link reach them?"
        columns={2}
        value={state.channel}
        onChange={(channel) => onPatch({ channel, channelTouched: true })}
        error={errors.channel ?? null}
        help="Only the channel you pick is used. PROOVRA never sends on two channels at once."
        options={DELIVERY_CHANNELS.map((c) => {
          const unavailable = channelUnavailableReason(c.value, transport);
          return {
            value: c.value,
            title: c.label,
            description: c.description,
            icon: <DeliveryChannelIcon icon={c.icon} size={16} />,
            disabled: Boolean(unavailable),
            disabledReason: "Not configured on this deployment.",
          };
        })}
      />

      <Field
        label="Recipient label"
        htmlFor={FIELD_IDS.recipientLabel}
        help="Optional. Only you see this — for example “John Smith — claim 4842”."
      >
        <input
          id={FIELD_IDS.recipientLabel}
          className="app-form-input"
          type="text"
          value={state.recipientLabel}
          maxLength={RECIPIENT_LABEL_MAX}
          onChange={(e) =>
            onPatch({
              recipientLabel: e.target.value.slice(0, RECIPIENT_LABEL_MAX),
            })
          }
          data-intake-link-recipient-label
        />
      </Field>

      {/*
        CUSTOMER ID — optional, and always shown, because it belongs to the
        organization's own bookkeeping rather than to the delivery channel.
        One line of help; the semantics are not over-explained here.
      */}
      <Field
        label="Customer ID (optional)"
        htmlFor={FIELD_IDS.customerId}
        help="Your organization's identifier for this customer."
        error={errors.customerId ?? null}
      >
        <input
          id={FIELD_IDS.customerId}
          className="app-form-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          placeholder="CUST-849271"
          value={state.customerId}
          maxLength={CUSTOMER_ID_MAX}
          aria-invalid={Boolean(errors.customerId)}
          aria-describedby={
            errors.customerId ? `${FIELD_IDS.customerId}-error` : undefined
          }
          onChange={(e) =>
            onPatch({ customerId: e.target.value.slice(0, CUSTOMER_ID_MAX) })
          }
          data-intake-link-customer-id
        />
      </Field>

      {requires === "email" ? (
        <Field
          label="Recipient email"
          htmlFor={FIELD_IDS.recipientEmail}
          required
          error={errors.recipientEmail ?? null}
        >
          <input
            id={FIELD_IDS.recipientEmail}
            className="app-form-input"
            type="email"
            autoComplete="email"
            value={state.recipientEmail}
            maxLength={RECIPIENT_EMAIL_MAX}
            aria-invalid={Boolean(errors.recipientEmail)}
            aria-describedby={
              errors.recipientEmail ? `${FIELD_IDS.recipientEmail}-error` : undefined
            }
            onChange={(e) =>
              onPatch({
                recipientEmail: e.target.value.slice(0, RECIPIENT_EMAIL_MAX),
              })
            }
            data-intake-link-email
          />
        </Field>
      ) : null}

      {requires === "phone" ? (
        <Field
          label="Recipient phone"
          htmlFor={FIELD_IDS.recipientPhone}
          required
          help="International format with country code, for example +14155550123."
          error={errors.recipientPhone ?? null}
        >
          <input
            id={FIELD_IDS.recipientPhone}
            className="app-form-input ilk-ltr"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+14155550123"
            value={state.recipientPhone}
            maxLength={RECIPIENT_PHONE_MAX}
            aria-invalid={Boolean(errors.recipientPhone)}
            aria-describedby={
              errors.recipientPhone ? `${FIELD_IDS.recipientPhone}-error` : undefined
            }
            onChange={(e) =>
              onPatch({
                recipientPhone: e.target.value.slice(0, RECIPIENT_PHONE_MAX),
              })
            }
            data-intake-link-phone
          />
        </Field>
      ) : null}

      {requires === "none" ? (
        <p className="app-alert" data-intake-link-manual-note>
          Nothing is sent for a copy-link request. You&apos;ll get the secure
          link once, right after it is created, to share however you want.
        </p>
      ) : null}

      <ChoiceCards
        name="sender-display-mode"
        testAttr="intake-link-sender-card"
        legend="Request appears from"
        value={state.senderMode}
        onChange={(senderMode) => onPatch({ senderMode })}
        help="“via PROOVRA” is always appended so the recipient can verify who sent it."
        options={senderOptions}
      />

      {state.senderMode === "CUSTOM" ? (
        <Field
          label="Display name"
          htmlFor={FIELD_IDS.senderName}
          required
          help="Shown in the request before “via PROOVRA”."
          error={errors.senderName ?? null}
        >
          <input
            id={FIELD_IDS.senderName}
            className="app-form-input"
            type="text"
            placeholder="Smith &amp; Partners"
            value={state.senderName}
            maxLength={SENDER_NAME_MAX}
            aria-invalid={Boolean(errors.senderName)}
            aria-describedby={
              errors.senderName ? `${FIELD_IDS.senderName}-error` : undefined
            }
            onChange={(e) => onPatch({ senderName: e.target.value })}
            data-intake-link-sender-custom-name="true"
          />
        </Field>
      ) : null}
    </>
  );
}

// ===========================================================================
// Step 3 — Collection rules
// ===========================================================================

export function StepRules({ state, errors, onPatch }: StepProps) {
  const expiryOptions = [
    ...EXPIRY_PRESETS.map((p) => ({
      value: String(p.hours),
      label: p.label,
    })),
    { value: "custom", label: "Custom…" },
  ];

  return (
    <>
      <ChoiceCards<IntakeLinkLocationPolicy>
        name="location-policy"
        testAttr="intake-link-location-card"
        legend="Location collection"
        value={state.locationPolicy}
        onChange={(locationPolicy) => onPatch({ locationPolicy })}
        help="Location comes from the contributor's own browser, only after they tap Share. It is stored on the submitted evidence and labelled “Contributor browser permission” — it records what their device reported, not proof of where they were."
        options={INTAKE_LINK_LOCATION_POLICY_OPTIONS.map((opt) => ({
          value: opt.value,
          title: opt.title,
          description:
            opt.value === "REQUIRED"
              ? "Contributors must share location before submitting. If their device cannot provide it, they can still submit and the submission records that location was unavailable."
              : opt.description,
          note: opt.value === "OPTIONAL" ? "Recommended" : undefined,
        }))}
      />

      <div className="ilk-field-row">
        <Field
          label="Link expires in"
          htmlFor={FIELD_IDS.expiry}
          help={`Expires ${formatUserDateTime(expiryFromHours(state.expiresInHours))} in your local time. Stored and sent as UTC.`}
          error={errors.expiresInHours ?? null}
        >
          <AppListbox
            id={FIELD_IDS.expiry}
            value={
              state.expiryChoice === "custom"
                ? "custom"
                : String(state.expiryChoice)
            }
            options={expiryOptions}
            ariaLabel="Link expires in"
            onChange={(v) => {
              if (v === "custom") {
                onPatch({ expiryChoice: "custom" });
                return;
              }
              const hours = Number(v);
              onPatch({ expiryChoice: hours, expiresInHours: hours });
            }}
          />
        </Field>

        <Field
          label="Maximum files per submission"
          htmlFor={FIELD_IDS.maxFiles}
          help={`Between ${MAX_FILES_MIN} and ${MAX_FILES_MAX}. Leave blank for no per-submission cap.`}
          error={errors.maxFiles ?? null}
        >
          <input
            id={FIELD_IDS.maxFiles}
            className="app-form-input"
            type="number"
            inputMode="numeric"
            min={MAX_FILES_MIN}
            max={MAX_FILES_MAX}
            step={1}
            value={state.maxFiles}
            aria-invalid={Boolean(errors.maxFiles)}
            aria-describedby={
              errors.maxFiles ? `${FIELD_IDS.maxFiles}-error` : undefined
            }
            onChange={(e) => {
              const raw = e.target.value;
              onPatch({ maxFiles: raw === "" ? "" : Number(raw) });
            }}
            data-intake-link-max-files
          />
        </Field>
      </div>

      {state.expiryChoice === "custom" ? (
        <Field
          label="Expires in (hours)"
          htmlFor={FIELD_IDS.expiryHours}
          help={`Between ${EXPIRY_HOURS_MIN} and ${EXPIRY_HOURS_MAX} hours.`}
          error={errors.expiresInHours ?? null}
        >
          <input
            id={FIELD_IDS.expiryHours}
            className="app-form-input"
            type="number"
            inputMode="numeric"
            min={EXPIRY_HOURS_MIN}
            max={EXPIRY_HOURS_MAX}
            step={1}
            value={state.expiresInHours}
            aria-invalid={Boolean(errors.expiresInHours)}
            onChange={(e) =>
              onPatch({ expiresInHours: Number(e.target.value) })
            }
            data-intake-link-expiry-hours
          />
        </Field>
      ) : null}

      <KindChips<AcceptedKind>
        legend="Accepted file types"
        selected={state.acceptedKinds}
        error={errors.acceptedKinds ?? null}
        help="Contributors can only upload the types you allow."
        onToggle={(value, next) => {
          const set = new Set(state.acceptedKinds);
          if (next) set.add(value);
          else set.delete(value);
          onPatch({
            acceptedKinds: ACCEPTED_KIND_OPTIONS.map((o) => o.value).filter((v) =>
              set.has(v),
            ),
            kindsTouched: true,
          });
        }}
        options={ACCEPTED_KIND_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
          hint: o.hint,
          icon: <AcceptedKindIcon icon={o.icon} size={18} />,
        }))}
      />

      <Field
        label="Consent or disclosure text"
        htmlFor={FIELD_IDS.consent}
        help="Optional. Shown to the contributor before they upload."
        error={errors.consentText ?? null}
      >
        <textarea
          id={FIELD_IDS.consent}
          className="app-form-input"
          rows={3}
          value={state.consentText}
          maxLength={CONSENT_TEXT_MAX}
          onChange={(e) =>
            onPatch({ consentText: e.target.value.slice(0, CONSENT_TEXT_MAX) })
          }
          data-intake-link-consent
        />
      </Field>
    </>
  );
}

// ===========================================================================
// Step 4 — Review
// ===========================================================================

function ReviewGroup({
  title,
  rows,
}: {
  title: string;
  rows: ReadonlyArray<[string, React.ReactNode]>;
}) {
  return (
    <section className="ilk-review__group">
      <h3 className="ilk-review__title">{title}</h3>
      <dl className="ilk-facts">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
}

export function StepReview({
  state,
  transport,
  workspaceName,
  templates,
}: StepProps) {
  const purpose = findRequestPurpose(state.purposeSlug);
  const template = templates.find((t) => t.slug === state.purposeSlug);
  const expiresAt = expiryFromHours(state.expiresInHours);
  const requires = requiredRecipientField(state.channel);
  const recipientTarget =
    requires === "email"
      ? state.recipientEmail.trim()
      : requires === "phone"
        ? state.recipientPhone.trim()
        : "";

  const locationOption = INTAKE_LINK_LOCATION_POLICY_OPTIONS.find(
    (o) => o.value === state.locationPolicy,
  );

  return (
    <div className="ilk-review">
      <ReviewGroup
        title="Request"
        rows={[
          ["Asking for", purpose?.label ?? template?.name ?? state.purposeSlug],
          ["Link type", intakeModeLabel(state.intakeMode)],
          [
            "Recipient label",
            state.recipientLabel.trim() || "— none —",
          ],
        ]}
      />

      <ReviewGroup
        title="Delivery"
        rows={[
          ["Channel", channelLabel(state.channel)],
          [
            "Goes to",
            <span className="ilk-ltr" key="target">
              {recipientTarget || "You share the link yourself"}
            </span>,
          ],
          [
            "Appears from",
            state.senderMode === "CUSTOM"
              ? `${state.senderName.trim()} via PROOVRA`
              : state.senderMode === "WORKSPACE"
                ? `${workspaceName} via PROOVRA`
                : "PROOVRA",
          ],
        ]}
      />

      <ReviewGroup
        title="Collection rules"
        rows={[
          [
            "Expires",
            <span className="ilk-ltr" key="exp">
              {formatUserDateTime(expiresAt)}
            </span>,
          ],
          [
            "Maximum files",
            state.maxFiles === ""
              ? "No per-submission cap"
              : String(state.maxFiles),
          ],
          [
            "Accepted types",
            <span className="app-chip-row" key="kinds">
              {state.acceptedKinds.map((k) => (
                <AppStatusBadge tone="slate" key={k}>
                  {ACCEPTED_KIND_OPTIONS.find((o) => o.value === k)?.label ?? k}
                </AppStatusBadge>
              ))}
            </span>,
          ],
          ["Location", locationOption?.title ?? state.locationPolicy],
          [
            "Consent text",
            state.consentText.trim() ? state.consentText.trim() : "— none —",
          ],
        ]}
      />

      {state.channel === "MANUAL" ? (
        <p className="app-alert" data-intake-link-preview-manual="true">
          No message is sent for a copy-link request. The secure link is shown
          once, immediately after you create it.
        </p>
      ) : (
        <MessagePreview
          channel={state.channel as PreviewChannel}
          senderMode={state.senderMode}
          senderName={state.senderName}
          workspaceName={workspaceName}
          requestTypeSlug={state.purposeSlug}
          recipientLabel={state.recipientLabel}
          recipientTarget={recipientTarget}
          expiresAt={expiresAt}
          transport={transport}
        />
      )}
    </div>
  );
}
