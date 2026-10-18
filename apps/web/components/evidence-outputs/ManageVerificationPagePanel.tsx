"use client";

/**
 * MANAGE VERIFICATION PAGE — the ONE owner control for the record's permanent
 * verification page (disclosure model 2026-10-18).
 *
 * Every finalized record has a permanent `pvr_` verification page. Nothing
 * publishes it and nothing un-publishes it; the owner decides only what it
 * DISCLOSES to anonymous visitors:
 *
 *   Verification only  (default) the complete verification result, nothing
 *                      about the content;
 *   Content preview    title, description, item names and previews too —
 *                      and, only then, optionally the recorded location.
 *
 * What visitors see is decided and described by the SERVER
 * (`disclosure.visitorPreview`); this panel prints it and never computes it.
 * A change is saved with compare-and-swap (`expectedVersion`): a 409
 * DISCLOSURE_VERSION_CONFLICT re-reads the current setting and lets the owner
 * retry. A change that shows more answers 401 STEP_UP_REQUIRED, which the
 * shared step-up flow handles. Withdrawal (a legal / privacy / security
 * action) is a separate access axis and keeps its own controls here.
 */
import { QRCodeSVG } from "qrcode.react";
import { Ban, CheckCircle2, Clock, Eye, EyeOff, PauseCircle, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { AppListbox, AppStatusBadge, type AppTone } from "../app-primitives";
import { StepUpModal, useStepUpAction } from "../identity-security/StepUpModal";
import { useToast } from "../ui";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { notifyApiError } from "../../lib/feedback/notify";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../lib/date";
import {
  absoluteVerifyUrl,
  changeVerificationDisclosure,
  getVerificationAccess,
  reinstateVerificationAccess,
  withdrawVerificationAccess,
  type CanonicalVerificationStatus,
  type VerificationAccess,
  type VerificationDisclosureMode,
  type VerificationWithdrawalReason,
} from "../../lib/api/verification-links";

export const VERIFICATION_ACCESS_STATUS_LABEL: Record<CanonicalVerificationStatus, string> = {
  NOT_ISSUED: "Issued at finalization",
  AVAILABLE: "Available",
  WITHDRAWN: "Withdrawn",
  RETAINED: "Retained",
  PURGED: "Purged",
  TEMPORARILY_UNAVAILABLE: "Suspended",
};

const STATUS_TONE: Record<CanonicalVerificationStatus, AppTone> = {
  NOT_ISSUED: "slate",
  AVAILABLE: "green",
  WITHDRAWN: "red",
  RETAINED: "amber",
  PURGED: "slate",
  TEMPORARILY_UNAVAILABLE: "amber",
};

const STATUS_ICON: Record<CanonicalVerificationStatus, ReactNode> = {
  NOT_ISSUED: <Clock size={14} aria-hidden="true" />,
  AVAILABLE: <CheckCircle2 size={14} aria-hidden="true" />,
  WITHDRAWN: <Ban size={14} aria-hidden="true" />,
  RETAINED: <Clock size={14} aria-hidden="true" />,
  PURGED: <Ban size={14} aria-hidden="true" />,
  TEMPORARILY_UNAVAILABLE: <PauseCircle size={14} aria-hidden="true" />,
};

const STATUS_DETAIL: Record<CanonicalVerificationStatus, string> = {
  NOT_ISSUED:
    "The verification page is created automatically when this record is finalized. Its reference never changes after that.",
  AVAILABLE: "Anyone with the reference, a link to it or the report's QR code can open it without logging in.",
  WITHDRAWN:
    "The page was withdrawn following a legal, privacy or security action. It now says so to anyone who opens it; the reference is kept and never points to another record.",
  RETAINED:
    "This record is in Trash or in the retention archive. The page says it is retained and no longer shows it as an active record.",
  PURGED: "The record has been permanently deleted. The page shows only a minimal record that it existed.",
  TEMPORARILY_UNAVAILABLE: "The page is suspended. It answers that it is temporarily unavailable until it is restored.",
};

const WITHDRAW_REASONS: ReadonlyArray<{ value: VerificationWithdrawalReason; label: string }> = [
  { value: "LEGAL_REQUEST", label: "Legal request" },
  { value: "PRIVACY_REQUEST", label: "Privacy request" },
  { value: "SECURITY_INCIDENT", label: "Security incident" },
];

export const DISCLOSURE_MODE_OPTIONS: ReadonlyArray<{
  value: VerificationDisclosureMode;
  label: string;
  description: string;
}> = [
  {
    value: "VERIFICATION_ONLY",
    label: "Verification only",
    description: "The complete verification result. Nothing about what the record contains.",
  },
  {
    value: "CONTENT_PREVIEW",
    label: "Content preview",
    description: "The verification result plus the title, description, item names and previews.",
  },
];

/** Contextual copy for the disclosure refusals (see error-code-registry). */
const DISCLOSURE_ERROR_COPY: Record<string, string> = {
  DISCLOSURE_CHANGE_NOT_PERMITTED:
    "Changing what the verification page discloses needs a role with the publish permission in this workspace.",
  DISCLOSURE_LOCATION_REQUIRES_CONTENT_PREVIEW:
    "The recorded location can be shown only when the page shows a content preview.",
  DISCLOSURE_RECORD_NOT_CHANGEABLE:
    "This record is no longer in a state whose verification page can change. Nothing was changed.",
  DISCLOSURE_POLICY_INVALID: "Choose what the page shows, then save again.",
};

type ErrLike = { code?: string; statusCode?: number; details?: Record<string, unknown> };

function modeLabel(mode: VerificationDisclosureMode): string {
  return DISCLOSURE_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
}

function policySentence(mode: VerificationDisclosureMode, showRecordedLocation: boolean): string {
  return mode === "CONTENT_PREVIEW"
    ? `Content preview, ${showRecordedLocation ? "with" : "without"} the recorded location`
    : "Verification only";
}

export function ManageVerificationPagePanel({
  evidenceId,
  teamId,
  onChanged,
}: {
  evidenceId: string;
  /** The record's workspace — the step-up challenge is bound to it. */
  teamId: string | null;
  /** Called after a change the record page summarises (disclosure, access). */
  onChanged?: () => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });
  const ids = useId();
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [access, setAccess] = useState<VerificationAccess | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [showQr, setShowQr] = useState(false);
  const [busy, setBusy] = useState<null | "access" | "disclosure">(null);
  const [reason, setReason] = useState<VerificationWithdrawalReason>("LEGAL_REQUEST");
  const [draftMode, setDraftMode] = useState<VerificationDisclosureMode>("VERIFICATION_ONLY");
  const [draftLocation, setDraftLocation] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const load = useCallback(
    async (opts: { keepDraft?: boolean } = {}) => {
      try {
        const next = await getVerificationAccess(evidenceId);
        setAccess(next);
        if (!opts.keepDraft && next.disclosure) {
          setDraftMode(next.disclosure.mode);
          setDraftLocation(next.disclosure.mode === "CONTENT_PREVIEW" && next.disclosure.showRecordedLocation);
        }
        setLoadState("ready");
        return next;
      } catch {
        setLoadState("error");
        return null;
      }
    },
    [evidenceId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const url = access?.verifyPath ? absoluteVerifyUrl(access.verifyPath) : null;
  const saved = access?.disclosure ?? null;
  const canChange = Boolean(access?.canChangeDisclosure && saved);
  const effectiveLocation = draftMode === "CONTENT_PREVIEW" && draftLocation;
  const dirty = Boolean(saved && (saved.mode !== draftMode || saved.showRecordedLocation !== effectiveLocation));
  // Copy only: the SERVER decides whether a change needs a step-up.
  const showsMore = Boolean(
    saved &&
      ((saved.mode === "VERIFICATION_ONLY" && draftMode === "CONTENT_PREVIEW") ||
        (!saved.showRecordedLocation && effectiveLocation)),
  );

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      addToast(`${what} copied`, "success");
    } catch {
      addToast(`The ${what.toLowerCase()} could not be copied. Select it and copy it manually.`, "error");
    }
  };

  const chooseMode = (mode: VerificationDisclosureMode) => {
    if (!canChange || busy) return;
    setDraftMode(mode);
    if (mode === "VERIFICATION_ONLY") setDraftLocation(false);
    setNotice(null);
    setProblem(null);
  };

  const onRadioKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = DISCLOSURE_MODE_OPTIONS.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    chooseMode(DISCLOSURE_MODE_OPTIONS[next]!.value);
    radioRefs.current[next]?.focus();
  };

  const save = async () => {
    if (!saved || !canChange || !dirty || busy) return;
    setBusy("disclosure");
    setNotice(null);
    setProblem(null);
    setConflict(null);
    const change = { mode: draftMode, showRecordedLocation: effectiveLocation, expectedVersion: saved.version };
    try {
      const result = await stepUp.runStepUpAction((headers) =>
        changeVerificationDisclosure(evidenceId, change, headers),
      );
      setAccess((prev) =>
        prev
          ? {
              ...prev,
              disclosure: {
                ...result.disclosure,
                changedAtUtc: result.disclosure.changedAtUtc ?? prev.disclosure?.changedAtUtc ?? null,
              },
            }
          : prev,
      );
      setNotice(
        result.changed
          ? `Saved. The verification page now shows: ${policySentence(result.disclosure.mode, result.disclosure.showRecordedLocation)}.`
          : "Nothing to change — the page already shows this.",
      );
      onChanged?.();
    } catch (err) {
      const e = err as ErrLike | null;
      if (e?.code === "STEP_UP_CANCEL") {
        setProblem("Not saved. Showing more on the verification page needs you to confirm your identity.");
      } else if (e?.code === "DISCLOSURE_VERSION_CONFLICT") {
        // Someone else changed it. Show what is current now; keep the owner's
        // choice so they can retry against the new version.
        const current = await load({ keepDraft: true });
        const now = current?.disclosure;
        setConflict(
          now
            ? `This page's disclosure was changed elsewhere. It now shows: ${policySentence(now.mode, now.showRecordedLocation)}. Review it, then save again if you still want your change.`
            : "This page's disclosure was changed elsewhere. Reload it, then save again if you still want your change.",
        );
      } else if (e?.code && DISCLOSURE_ERROR_COPY[e.code]) {
        setProblem(DISCLOSURE_ERROR_COPY[e.code]!);
        if (e.code === "DISCLOSURE_CHANGE_NOT_PERMITTED") void load();
      } else {
        // Bounded copy, inline beside the control it is about — the raw error
        // body never reaches the page.
        setProblem(
          toSafeUserError(err, { message: "The verification page's disclosure could not be changed. Try again." }).message,
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async () => {
    const ok = await confirm({
      title: "Withdraw the verification page?",
      description:
        "Use this only for a legal, privacy or security reason. Anyone opening the page — including from a printed report — will see that it was withdrawn. The reference is kept, never reused, and you can reinstate the page later. This is recorded in the record's custody history.",
      confirmLabel: "Withdraw page",
      tone: "danger",
      testId: "verification-access-withdraw",
    });
    if (!ok) return;
    setBusy("access");
    try {
      await withdrawVerificationAccess(evidenceId, reason);
      await load({ keepDraft: true });
      onChanged?.();
      addToast("Verification page withdrawn", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "The verification page could not be withdrawn." });
    } finally {
      setBusy(null);
    }
  };

  const reinstate = async () => {
    setBusy("access");
    try {
      await reinstateVerificationAccess(evidenceId);
      await load({ keepDraft: true });
      onChanged?.();
      addToast("Verification page reinstated", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "The verification page could not be reinstated." });
    } finally {
      setBusy(null);
    }
  };

  const titleId = `${ids}-title`;
  const modeLabelId = `${ids}-mode-label`;
  const locationId = `${ids}-location`;
  const locationHelpId = `${ids}-location-help`;
  const permissionId = `${ids}-permission`;

  return (
    <section
      id="verification-page"
      className="evidence-detail-links-panel"
      data-evidence-section="verification-page"
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="evidence-detail-verify-card__title">
        Manage verification page
      </h2>
      <p className="app-field__help" data-verification-page-explainer>
        Every finalized record has one permanent verification page. You choose what it discloses; it never offers the
        original files.
      </p>

      {loadState === "loading" ? <p className="app-field__help">Loading the verification page…</p> : null}
      {loadState === "error" ? (
        <p className="app-field__help" role="alert" data-verification-page-unavailable>
          The verification page could not be loaded right now.{" "}
          <button type="button" className="evidence-detail-inline-link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}

      {loadState === "ready" && access ? (
        <div className="evidence-detail-verification-page" data-verification-access-status={access.status}>
          {/* ---- The permanent reference -------------------------------- */}
          <div className="evidence-detail-link-row__main">
            <strong>Access</strong>
            <AppStatusBadge tone={STATUS_TONE[access.status]} data-verification-access-badge={access.status}>
              <span className="evidence-detail-status-icon">{STATUS_ICON[access.status]}</span>
              {VERIFICATION_ACCESS_STATUS_LABEL[access.status]}
            </AppStatusBadge>
          </div>
          <p className="app-field__help">{STATUS_DETAIL[access.status]}</p>
          {access.withdrawal?.changedAtUtc ? (
            <p className="app-field__help">Changed {formatUserDateTime(access.withdrawal.changedAtUtc)}.</p>
          ) : null}

          {url && access.reference ? (
            <>
              <p className="app-field__help">
                Verification reference: <code data-verification-access-reference>{access.reference}</code>
              </p>
              <input
                className="app-input"
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Verification page link"
                data-verification-access-url
              />
              <div className="evidence-detail-link-row__actions">
                <button
                  type="button"
                  className="app-secondary-action"
                  onClick={() => void copy(url, "Verification link")}
                  data-verification-access-action="copy-link"
                >
                  Copy link
                </button>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="app-secondary-action"
                  data-verification-access-action="open"
                >
                  Open page
                </a>
                <button
                  type="button"
                  className="app-secondary-action"
                  onClick={() => void copy(access.reference!, "Verification reference")}
                  data-verification-access-action="copy-reference"
                >
                  Copy reference
                </button>
                <button
                  type="button"
                  className="evidence-detail-inline-link"
                  aria-expanded={showQr}
                  onClick={() => setShowQr((v) => !v)}
                  data-verification-access-action="qr"
                >
                  {showQr ? "Hide QR code" : "Show QR code"}
                </button>
              </div>
              {showQr ? (
                <div data-verification-access-qr>
                  <QRCodeSVG value={url} size={148} />
                </div>
              ) : null}
            </>
          ) : null}

          {/* ---- What the page discloses -------------------------------- */}
          {saved ? (
            <div className="evidence-detail-disclosure" data-verification-disclosure={saved.mode}>
              <h3 className="evidence-detail-disclosure__heading" id={modeLabelId}>
                What the page discloses
              </h3>
              <div
                role="radiogroup"
                aria-labelledby={modeLabelId}
                aria-describedby={!canChange ? permissionId : undefined}
                aria-disabled={!canChange || busy !== null ? true : undefined}
                className="evidence-detail-segmented"
                data-verification-disclosure-modes
              >
                {DISCLOSURE_MODE_OPTIONS.map((option, index) => {
                  const checked = draftMode === option.value;
                  return (
                    <button
                      key={option.value}
                      ref={(el) => {
                        radioRefs.current[index] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={checked ? 0 : -1}
                      disabled={!canChange || busy !== null}
                      className="evidence-detail-segmented__option"
                      data-checked={checked ? "true" : "false"}
                      data-verification-disclosure-mode={option.value}
                      onClick={() => chooseMode(option.value)}
                      onKeyDown={(e) => onRadioKey(e, index)}
                    >
                      <span className="evidence-detail-segmented__label">
                        {option.value === "CONTENT_PREVIEW" ? (
                          <Eye size={14} aria-hidden="true" />
                        ) : (
                          <EyeOff size={14} aria-hidden="true" />
                        )}
                        {option.label}
                      </span>
                      <span className="evidence-detail-segmented__hint">{option.description}</span>
                    </button>
                  );
                })}
              </div>

              <div className="evidence-detail-disclosure__location">
                <label className="evidence-detail-switch" htmlFor={locationId}>
                  <input
                    id={locationId}
                    type="checkbox"
                    role="switch"
                    checked={effectiveLocation}
                    disabled={!canChange || draftMode !== "CONTENT_PREVIEW" || busy !== null}
                    aria-describedby={locationHelpId}
                    onChange={(e) => {
                      setDraftLocation(e.target.checked);
                      setNotice(null);
                      setProblem(null);
                    }}
                    data-verification-disclosure-location
                  />
                  <span>Show recorded location</span>
                </label>
                <p className="app-field__help" id={locationHelpId} data-verification-disclosure-location-help>
                  {draftMode === "CONTENT_PREVIEW"
                    ? "Adds where the record was captured, when a location was recorded."
                    : "Available only with Content preview. Verification only never shows the recorded location."}
                </p>
              </div>

              <div className="app-alert app-alert--warn" role="note" data-verification-disclosure-warning>
                <ShieldAlert size={16} aria-hidden="true" />{" "}
                Anyone holding the permanent verification reference — including from a printed report or its QR code —
                can view the information this page discloses.
              </div>

              {!canChange ? (
                <p className="app-field__help" id={permissionId} data-verification-disclosure-forbidden>
                  Changing what the page discloses needs a role with the publish permission in this workspace.
                </p>
              ) : null}

              {conflict ? (
                <div className="app-alert app-alert--warn" role="alert" data-verification-disclosure-conflict>
                  {conflict}
                </div>
              ) : null}
              {problem ? (
                <p className="app-field-error" role="alert" data-verification-disclosure-problem>
                  {problem}
                </p>
              ) : null}
              <p className="app-field__help" role="status" aria-live="polite" data-verification-disclosure-notice>
                {notice ?? ""}
              </p>

              {canChange ? (
                <div className="evidence-detail-link-row__actions">
                  <button
                    type="button"
                    className="app-primary-action"
                    disabled={!dirty || busy !== null}
                    onClick={() => void save()}
                    data-verification-disclosure-action="save"
                  >
                    {busy === "disclosure" ? "Saving…" : "Save disclosure"}
                  </button>
                  {dirty ? (
                    <button
                      type="button"
                      className="app-secondary-action"
                      disabled={busy !== null}
                      onClick={() => {
                        setDraftMode(saved.mode);
                        setDraftLocation(saved.showRecordedLocation);
                        setConflict(null);
                        setProblem(null);
                      }}
                      data-verification-disclosure-action="reset"
                    >
                      Keep current setting
                    </button>
                  ) : null}
                </div>
              ) : null}
              {dirty && showsMore ? (
                <p className="app-field__help" data-verification-disclosure-step-up-hint>
                  Showing more on the verification page asks you to confirm your identity first.
                </p>
              ) : null}

              {/* ---- What anonymous visitors see — printed from the server ---- */}
              <div className="evidence-detail-visitor-preview" data-verification-visitor-preview>
                <h3 className="evidence-detail-disclosure__heading">What anonymous visitors see</h3>
                <p className="app-field__help" data-verification-visitor-preview-basis>
                  {dirty
                    ? `This describes the saved setting (${modeLabel(saved.mode)}). Save to apply your change.`
                    : `Currently: ${policySentence(saved.mode, saved.showRecordedLocation)}${
                        saved.changedAtUtc ? ` · changed ${formatUserDateTime(saved.changedAtUtc)}` : ""
                      }.`}
                </p>
                <PreviewList title="Shown" kind="shown" items={saved.visitorPreview.shown} />
                <PreviewList title="Withheld by the disclosure policy" kind="withheld" items={saved.visitorPreview.withheld} />
                <PreviewList title="Never shown" kind="never" items={saved.visitorPreview.never} />
              </div>
            </div>
          ) : (
            <p className="app-field__help" data-verification-disclosure-unavailable>
              What the page discloses can be chosen once its verification page is issued.
            </p>
          )}

          {/* ---- Withdraw / reinstate (access) --------------------------- */}
          {access.canWithdraw && access.reference && access.status !== "PURGED" ? (
            <details className="evidence-detail-advanced" data-verification-access-withdrawal>
              <summary>Withdraw or reinstate (legal, privacy or security)</summary>
              {access.status === "WITHDRAWN" ? (
                <button
                  type="button"
                  className="app-secondary-action"
                  disabled={busy !== null}
                  onClick={() => void reinstate()}
                  data-verification-access-action="reinstate"
                >
                  Reinstate verification page
                </button>
              ) : (
                <div className="evidence-detail-link-form">
                  <label className="app-field-label" htmlFor={`${ids}-reason`}>
                    Reason
                  </label>
                  <AppListbox
                    id={`${ids}-reason`}
                    ariaLabel="Reason"
                    value={reason}
                    options={WITHDRAW_REASONS}
                    onChange={setReason}
                  />
                  <button
                    type="button"
                    className="app-secondary-action evidence-detail-destructive-action"
                    disabled={busy !== null}
                    onClick={() => void withdraw()}
                    data-verification-access-action="withdraw"
                  >
                    Withdraw verification page
                  </button>
                </div>
              )}
            </details>
          ) : null}
        </div>
      ) : null}
      <StepUpModal control={stepUp} />
    </section>
  );
}

function PreviewList({ title, kind, items }: { title: string; kind: "shown" | "withheld" | "never"; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="evidence-detail-visitor-preview__group" data-verification-visitor-preview-group={kind}>
      <h4 className="evidence-detail-visitor-preview__title">
        {kind === "shown" ? (
          <CheckCircle2 size={14} aria-hidden="true" />
        ) : kind === "withheld" ? (
          <EyeOff size={14} aria-hidden="true" />
        ) : (
          <Ban size={14} aria-hidden="true" />
        )}{" "}
        {title}
      </h4>
      <ul className="evidence-detail-visitor-preview__list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
