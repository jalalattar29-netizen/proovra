"use client";

/**
 * Intake links — the creation wizard.
 *
 * Replaces the single 700-line scrolling form. Four steps inside ONE accessible
 * dialog: a fixed head with the stepper, a body that is the only scrolling
 * region, and a fixed footer whose actions are always reachable. On a phone the
 * dialog owns the viewport, because a four-step form inside a floating card
 * leaves no body between a fixed head and foot.
 *
 * Guarantees, all of them behavioural rather than cosmetic:
 *   - moving between steps validates the CURRENT step only, and never creates
 *     or sends anything;
 *   - a failed step focuses its first invalid field;
 *   - Back/Continue never discards entered state — the whole form is one object
 *     owned here, and the steps are pure renders over it;
 *   - dismissing with entered data asks first;
 *   - Create is guarded at the handler, not by a disabled attribute alone, so a
 *     double-click cannot produce two links; the same idempotency nonce is
 *     re-sent so the dispatcher dedupes the delivery too.
 */

import * as React from "react";

import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { apiFetch } from "../../../../../lib/api";
import {
  findRequestPurpose,
  requiredRecipientField,
} from "../../../../../lib/intake-links/catalog";
import type { CreatedIntakeLink, SenderTransportInfo, WorkflowTemplateRow } from "../../_lib/types";
import {
  WIZARD_STEPS,
  WIZARD_STEP_LABEL,
  buildCreateBody,
  channelUnavailableReason,
  eligibleIntakeModes,
  firstInvalidField,
  friendlyCreateError,
  initialWizardState,
  isWizardDirty,
  validateStep,
  type WizardErrors,
  type WizardField,
  type WizardState,
  type WizardStep,
} from "../../_lib/wizardState";
import { IconClose, IconSpinner } from "../icons";
import { FIELD_IDS, StepDelivery, StepRequest, StepReview, StepRules } from "./steps";

/** Where "focus the first invalid field" sends focus, per field. */
const FIELD_FOCUS_SELECTOR: Record<WizardField, string> = {
  purposeSlug: `#${FIELD_IDS.purpose}`,
  intakeMode: '[data-intake-link-choice-group="intake-mode"] input:not(:disabled)',
  channel: '[data-intake-link-choice-group="delivery-channel"] input:not(:disabled)',
  recipientEmail: `#${FIELD_IDS.recipientEmail}`,
  recipientPhone: `#${FIELD_IDS.recipientPhone}`,
  senderName: `#${FIELD_IDS.senderName}`,
  expiresInHours: `#${FIELD_IDS.expiry}`,
  maxFiles: `#${FIELD_IDS.maxFiles}`,
  acceptedKinds: "[data-intake-link-accepted-kinds] input",
  consentText: `#${FIELD_IDS.consent}`,
};

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function CreateLinkWizard({
  team,
  templates,
  initialSlug,
  onClose,
  onCreated,
}: {
  team: { id: string; name: string };
  templates: ReadonlyArray<WorkflowTemplateRow>;
  initialSlug?: string;
  onClose: () => void;
  onCreated: (created: CreatedIntakeLink) => void;
}) {
  const { confirm } = useConfirmAction();
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();

  const initial = React.useMemo(
    () => initialWizardState({ initialSlug, workspaceName: team.name }),
    [initialSlug, team.name],
  );
  const [state, setState] = React.useState<WizardState>(initial);
  const [step, setStep] = React.useState<WizardStep>("request");
  const [errors, setErrors] = React.useState<WizardErrors>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const submittingRef = React.useRef(false);
  const [transport, setTransport] = React.useState<SenderTransportInfo | null>(
    null,
  );

  // One nonce per mount. A double-click re-sends the SAME value so the
  // dispatcher dedupes the provider call; reopening the wizard gets a fresh one.
  const idempotencyKey = React.useMemo(() => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `create:${crypto.randomUUID()}`;
    }
    return `create:${Math.random().toString(36).slice(2)}${Date.now()}`;
  }, []);

  const onPatch = React.useCallback((patch: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
    // Clearing the errors for the touched keys keeps a stale message from
    // outliving its cause while the operator is still typing.
    setErrors((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(patch)) delete next[key as WizardField];
      // A change can also invalidate the reason a NEIGHBOURING field failed:
      // switching channel retires the recipient error the old channel raised.
      if ("channel" in patch) {
        delete next.recipientEmail;
        delete next.recipientPhone;
      }
      if ("purposeSlug" in patch) delete next.intakeMode;
      if ("expiryChoice" in patch) delete next.expiresInHours;
      if ("senderMode" in patch) delete next.senderName;
      return next;
    });
  }, []);

  // ---- Sender transport (server fact about which channels can deliver) ----
  React.useEffect(() => {
    let cancelled = false;
    apiFetch(
      `/v1/workflow/intake-links/sender-identity?teamId=${encodeURIComponent(team.id)}`,
      { method: "GET" },
    )
      .then((res) => {
        if (!cancelled) setTransport(res as SenderTransportInfo);
      })
      .catch(() => {
        if (!cancelled) setTransport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [team.id]);

  // Config-aware default: SMS → Email → WhatsApp → Copy link, stepping down to
  // the first channel this deployment can actually deliver on. Stops entirely
  // once the operator has made a choice of their own.
  React.useEffect(() => {
    if (state.channelTouched || !transport) return;
    const next = transport.sms?.configured
      ? "SMS"
      : transport.email?.configured
        ? "EMAIL"
        : transport.whatsapp?.configured
          ? "WHATSAPP"
          : "MANUAL";
    if (next !== state.channel) {
      setState((prev) => ({ ...prev, channel: next }));
    }
  }, [transport, state.channelTouched, state.channel]);

  // A request type that does not advertise the selected link type auto-corrects
  // rather than letting the create call fail mid-flight.
  const purposeSlug = state.purposeSlug;
  const intakeMode = state.intakeMode;
  React.useEffect(() => {
    const eligible = eligibleIntakeModes(purposeSlug, templates);
    if (eligible.includes(intakeMode)) return;
    const preferred = eligible.includes("EXTERNAL_ONE_TIME")
      ? "EXTERNAL_ONE_TIME"
      : eligible[0];
    if (preferred) setState((prev) => ({ ...prev, intakeMode: preferred }));
  }, [purposeSlug, intakeMode, templates]);

  // ---- Dialog behaviour: focus in, focus out, Escape, Tab trap -------------
  React.useEffect(() => {
    restoreRef.current =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    dialogRef.current?.focus();
    return () => {
      restoreRef.current?.focus?.();
    };
  }, []);

  const requestClose = React.useCallback(async () => {
    if (busy) return;
    if (!isWizardDirty(state, initial)) {
      onClose();
      return;
    }
    const ok = await confirm({
      title: "Discard this intake link?",
      description:
        "You've entered details that haven't been used yet. Closing now discards them — nothing has been created or sent.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      tone: "danger",
      testId: "intake-link-discard",
    });
    if (ok) onClose();
  }, [busy, state, initial, confirm, onClose]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        void requestClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const nodes = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === root);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [requestClose]);

  // ---- Step navigation ----------------------------------------------------
  const stepIndex = WIZARD_STEPS.indexOf(step);
  const isLast = stepIndex === WIZARD_STEPS.length - 1;

  const focusField = React.useCallback((field: WizardField) => {
    const el = document.querySelector<HTMLElement>(FIELD_FOCUS_SELECTOR[field]);
    el?.focus();
    // Focus alone can leave the field off-screen inside the scrolling body.
    // Guarded: `scrollIntoView` is absent in some non-browser DOM runtimes, and
    // a missing convenience must never break the validation it accompanies.
    if (typeof el?.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center" });
    }
  }, []);

  const goNext = React.useCallback(() => {
    const found = validateStep(step, state, { templates, transport });
    setErrors(found);
    const invalid = firstInvalidField(step, found);
    if (invalid) {
      focusField(invalid);
      return;
    }
    const next = WIZARD_STEPS[stepIndex + 1];
    if (next) setStep(next);
  }, [step, state, templates, transport, stepIndex, focusField]);

  const goBack = React.useCallback(() => {
    const prev = WIZARD_STEPS[stepIndex - 1];
    // No validation on the way back — a half-finished field must not trap the
    // operator on the step they are trying to leave.
    if (prev) setStep(prev);
  }, [stepIndex]);

  // ---- Create -------------------------------------------------------------
  const submit = React.useCallback(async () => {
    // Guarded at the HANDLER. A disabled attribute alone loses the race
    // between the click that starts the request and the re-render.
    if (submittingRef.current) return;

    // Re-run every step's gate: a bad value entered on step 2 must not slip
    // through because the operator navigated forward before the fetch of the
    // transport envelope resolved.
    for (const s of WIZARD_STEPS) {
      const found = validateStep(s, state, { templates, transport });
      const invalid = firstInvalidField(s, found);
      if (invalid) {
        setStep(s);
        setErrors(found);
        window.setTimeout(() => focusField(invalid), 0);
        return;
      }
    }

    submittingRef.current = true;
    setBusy(true);
    setSubmitError(null);
    try {
      const intakeUrlBase =
        typeof window !== "undefined" && window.location
          ? `${window.location.protocol}//${window.location.host}`
          : undefined;
      const body = buildCreateBody(state, {
        teamId: team.id,
        intakeUrlBase,
        idempotencyKey,
      });
      const created = (await apiFetch("/v1/workflow/intake-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })) as CreatedIntakeLink;
      onCreated(created);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // Every entered value survives — the operator can correct and retry.
      setSubmitError(friendlyCreateError(e?.code, e?.message));
      submittingRef.current = false;
      setBusy(false);
    }
  }, [state, templates, transport, team.id, idempotencyKey, onCreated, focusField]);

  const stepProps = {
    state,
    errors,
    onPatch,
    templates,
    transport,
    workspaceName: team.name,
  };

  const purposeLabel =
    findRequestPurpose(state.purposeSlug)?.label ??
    templates.find((t) => t.slug === state.purposeSlug)?.name ??
    state.purposeSlug;

  const channelWarning = channelUnavailableReason(state.channel, transport);

  return (
    <div
      className="app-dialog-overlay ilk-wizard-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void requestClose();
      }}
      data-intake-link-wizard-overlay
    >
      <div
        ref={dialogRef}
        className="app-dialog ilk-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="intake-link-create-wizard"
        data-intake-link-wizard-step={step}
      >
        <header className="app-dialog__head">
          <div>
            <h2 className="app-dialog__title" id={titleId}>
              New intake link
            </h2>
            <p className="app-dialog__subtitle">
              {purposeLabel} · step {stepIndex + 1} of {WIZARD_STEPS.length}
            </p>
          </div>
          <button
            type="button"
            className="app-ghost-action"
            onClick={() => void requestClose()}
            disabled={busy}
            aria-label="Close new intake link"
          >
            <IconClose size={16} />
          </button>
        </header>

        <ol className="ilk-stepper" data-intake-link-stepper>
          {WIZARD_STEPS.map((s, i) => {
            const status =
              s === step ? "current" : i < stepIndex ? "done" : "todo";
            return (
              <React.Fragment key={s}>
                {i > 0 ? <li className="ilk-stepper__rule" aria-hidden /> : null}
                <li
                  className="ilk-stepper__item"
                  data-state={status}
                  data-intake-link-step={s}
                  aria-current={s === step ? "step" : undefined}
                >
                  <span className="ilk-stepper__dot" aria-hidden>
                    {i + 1}
                  </span>
                  <span className="ilk-stepper__label">
                    {WIZARD_STEP_LABEL[s]}
                  </span>
                  <span className="app-visually-hidden">
                    {`Step ${i + 1}: ${WIZARD_STEP_LABEL[s]}${
                      status === "current" ? " (current)" : ""
                    }`}
                  </span>
                </li>
              </React.Fragment>
            );
          })}
        </ol>

        <div className="app-dialog__body" data-intake-link-wizard-body>
          {submitError ? (
            <p
              className="app-alert app-alert--danger"
              role="alert"
              data-intake-link-create-error
            >
              {submitError}
            </p>
          ) : null}

          {channelWarning && step !== "request" ? (
            <p className="app-alert app-alert--warn" role="status">
              {channelWarning}
            </p>
          ) : null}

          {step === "request" ? <StepRequest {...stepProps} /> : null}
          {step === "delivery" ? <StepDelivery {...stepProps} /> : null}
          {step === "rules" ? <StepRules {...stepProps} /> : null}
          {step === "review" ? <StepReview {...stepProps} /> : null}
        </div>

        <footer className="app-dialog__footer">
          <button
            type="button"
            className="app-secondary-action"
            onClick={stepIndex === 0 ? () => void requestClose() : goBack}
            disabled={busy}
            data-intake-link-wizard-back
          >
            {stepIndex === 0 ? "Cancel" : "Back"}
          </button>
          {isLast ? (
            <button
              type="button"
              className="app-primary-action"
              onClick={() => void submit()}
              disabled={busy}
              aria-busy={busy || undefined}
              data-intake-link-submit
            >
              {busy ? <IconSpinner size={14} /> : null}
              <span>
                {busy
                  ? "Creating…"
                  : requiredRecipientField(state.channel) === "none"
                    ? "Create secure link"
                    : "Create and send"}
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="app-primary-action"
              onClick={goNext}
              data-intake-link-wizard-next
            >
              Continue
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

export default CreateLinkWizard;
