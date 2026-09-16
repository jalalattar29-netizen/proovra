"use client";

/**
 * Declarations attached to this evidence record — custodian and
 * qualified-person certifications (`/v1/evidence/:id/certifications`).
 *
 * Lifecycle: request -> attest -> revoke, each recorded as a custody event by
 * the server. Every change is confirmed by rereading the declaration list
 * before success is announced.
 *
 * STATEMENT AUTHORITY. The statement a signer attests is the statement stored
 * on the declaration record. This surface never writes or edits legal wording:
 * when a requested declaration carries no stored statement, signing is
 * unavailable and the reason is stated.
 *
 * A declaration is separate from the recorded integrity state; it does not
 * change what was preserved about this evidence.
 */

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../../../../lib/date";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { AppListbox } from "../../../../../components/app-primitives";
import { ReasonedActionButton } from "./ReasonedActionButton";

type DeclarationType = "CUSTODIAN" | "QUALIFIED_PERSON";
type DeclarationStatus = "DRAFT" | "REQUESTED" | "ATTESTED" | "REVOKED";

export type Certification = {
  id: string;
  declarationType: DeclarationType;
  status: DeclarationStatus;
  version: number;
  requestedAtUtc: string | null;
  attestedAtUtc: string | null;
  attestorName: string | null;
  attestorTitle: string | null;
  attestorOrganization: string | null;
  statementMarkdown: string | null;
  certificationHash: string | null;
  revokedAtUtc: string | null;
  revokeReason: string | null;
};

type Load =
  | { status: "loading" }
  | { status: "ready"; items: Certification[] }
  | { status: "failed"; message: string };

const TYPES: DeclarationType[] = ["CUSTODIAN", "QUALIFIED_PERSON"];

const TYPE_LABEL: Record<DeclarationType, string> = {
  CUSTODIAN: "Custodian declaration",
  QUALIFIED_PERSON: "Qualified-person certification",
};

const STATUS_LABEL: Record<DeclarationStatus, string> = {
  DRAFT: "Draft",
  REQUESTED: "Requested — awaiting signature",
  ATTESTED: "Signed",
  REVOKED: "Revoked",
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function when(iso: string | null): string {
  return iso ? formatUserDateTime(iso) : "Not recorded";
}

function latestByType(items: Certification[]): Map<DeclarationType, { latest: Certification; earlier: number }> {
  const out = new Map<DeclarationType, { latest: Certification; earlier: number }>();
  for (const type of TYPES) {
    const rows = items.filter((c) => c.declarationType === type).sort((a, b) => b.version - a.version);
    if (rows.length > 0) out.set(type, { latest: rows[0]!, earlier: rows.length - 1 });
  }
  return out;
}

function isOpen(status: DeclarationStatus): boolean {
  return status === "REQUESTED" || status === "ATTESTED";
}

type Form =
  | { kind: "attest"; type: DeclarationType }
  | { kind: "revoke"; type: DeclarationType };

export function EvidenceCertificationsPanel({ evidenceId }: { evidenceId: string }) {
  const { confirm } = useConfirmAction();
  const baseId = useId();
  const [list, setList] = useState<Load>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [requestType, setRequestType] = useState<DeclarationType | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [fields, setFields] = useState({ name: "", title: "", email: "", organization: "", signature: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const alive = useRef(true);
  const toggles = useRef<Record<string, HTMLButtonElement | null>>({});
  const firstField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const feedback = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const listUrl = `/v1/evidence/${encodeURIComponent(evidenceId)}/certifications`;

  useEffect(() => {
    let current = true;
    setList({ status: "loading" });
    void apiFetch(listUrl)
      .then((value) => {
        if (!current) return;
        setList({ status: "ready", items: (value as { certifications: Certification[] }).certifications ?? [] });
        setUnconfirmed(false);
      })
      .catch((error) => {
        if (current) {
          setList({
            status: "failed",
            message: toSafeUserError(error, { message: "Declarations for this record could not be loaded." }).message,
          });
        }
      });
    return () => {
      current = false;
    };
  }, [listUrl, revision]);

  useEffect(() => {
    if (form) firstField.current?.focus();
  }, [form]);

  const byType: ReturnType<typeof latestByType> =
    list.status === "ready" ? latestByType(list.items) : new Map();
  const requestable = TYPES.filter((type) => {
    const entry = byType.get(type);
    return !entry || !isOpen(entry.latest.status);
  });
  const lockedReason = unconfirmed
    ? "Refresh the declarations to confirm the last change before making another."
    : list.status !== "ready"
      ? "The declarations must load before one can be requested or changed."
      : null;
  const requestReason =
    lockedReason ??
    (requestable.length === 0
      ? "Both declaration types already have an open request or a signature. Revoke one before requesting it again."
      : !requestType || !requestable.includes(requestType)
        ? "Choose the declaration type to request."
        : null);

  function setField(key: keyof typeof fields, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function openForm(next: Form) {
    setForm(next);
    setFields({ name: "", title: "", email: "", organization: "", signature: "", reason: "" });
    setNotice("");
    setMutationError("");
  }

  function closeForm() {
    const key = form ? `${form.kind}:${form.type}` : null;
    setForm(null);
    if (key) toggles.current[key]?.focus();
  }

  /**
   * Write, then reread the list and check the saved state before announcing
   * anything.
   */
  const mutate = useCallback(
    async (
      path: "request" | "attest" | "revoke",
      body: Record<string, unknown>,
      type: DeclarationType,
      expected: DeclarationStatus,
      success: string,
    ) => {
      setBusy(true);
      setNotice("");
      setMutationError("");
      let written = false;
      try {
        await apiFetch(`${listUrl}/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        written = true;
        const reread = (await apiFetch(listUrl)) as { certifications: Certification[] };
        if (!alive.current) return;
        const items = reread.certifications ?? [];
        setList({ status: "ready", items });
        const latest = latestByType(items).get(type)?.latest;
        if (latest?.status === expected) setNotice(success);
        else {
          setMutationError(
            "The request was accepted, but the reloaded declarations do not show the change. Refresh before trying again.",
          );
        }
        setForm(null);
        if (path === "request") setRequestType(null);
        feedback.current?.focus();
      } catch (error) {
        if (!alive.current) return;
        if (written) {
          setUnconfirmed(true);
          setForm(null);
          setMutationError(
            "The change was sent, but the declarations could not be reloaded to confirm it. Refresh before making another change.",
          );
          feedback.current?.focus();
        } else {
          setMutationError(
            toSafeUserError(error, { message: "The declaration could not be updated." }).message,
          );
        }
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [listUrl],
  );

  async function requestDeclaration() {
    if (busy || requestReason || !requestType) return;
    const type = requestType;
    setBusy(true);
    const ok = await confirm({
      title: `Request a ${TYPE_LABEL[type].toLowerCase()}?`,
      description:
        "A signature request is recorded in this evidence record's custody history. It does not change the recorded integrity state.",
      confirmLabel: "Request declaration",
    });
    if (!alive.current) return;
    if (!ok) {
      setBusy(false);
      return;
    }
    await mutate("request", { declarationType: type }, type, "REQUESTED", `${TYPE_LABEL[type]} requested. The saved declarations were reloaded.`);
  }

  const current = form ? byType.get(form.type)?.latest ?? null : null;
  const statement = current?.statementMarkdown?.trim() || null;
  const attestReason =
    form?.kind !== "attest"
      ? null
      : !statement
        ? "No declaration statement is recorded for this request, so it cannot be signed here."
        : !fields.name.trim()
          ? "Enter the signer's full name."
          : !fields.title.trim()
            ? "Enter the signer's title or role."
            : !EMAIL.test(fields.email.trim())
              ? "Enter a valid email address for the signer."
              : !fields.signature.trim()
                ? "Type the signature to sign the statement."
                : null;
  const revokeReason = form?.kind === "revoke" && !fields.reason.trim() ? "Enter the reason for revoking." : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form || busy || lockedReason) return;
    const type = form.type;
    if (form.kind === "attest") {
      if (attestReason || !statement) return;
      setBusy(true);
      const ok = await confirm({
        title: "Sign this declaration?",
        description:
          "This signs the statement shown and records the signature in this evidence record's custody history. A signed declaration can later be revoked, but not edited.",
        confirmLabel: "Sign declaration",
        tone: "warning",
      });
      if (!alive.current) return;
      if (!ok) {
        setBusy(false);
        return;
      }
      await mutate(
        "attest",
        {
          declarationType: type,
          attestorName: fields.name.trim(),
          attestorTitle: fields.title.trim(),
          attestorEmail: fields.email.trim(),
          attestorOrganization: fields.organization.trim() || null,
          statementMarkdown: statement,
          signatureText: fields.signature.trim(),
        },
        type,
        "ATTESTED",
        `${TYPE_LABEL[type]} signed. The saved declarations were reloaded.`,
      );
      return;
    }
    if (revokeReason) return;
    const withdrawing = current?.status === "REQUESTED";
    setBusy(true);
    const ok = await confirm({
      title: withdrawing ? "Withdraw this signature request?" : "Revoke this signed declaration?",
      description:
        "The declaration is marked revoked with your reason and the revocation is recorded in custody history. Reports generated afterwards show it as revoked. This cannot be undone.",
      confirmLabel: withdrawing ? "Withdraw request" : "Revoke declaration",
      tone: "danger",
    });
    if (!alive.current) return;
    if (!ok) {
      setBusy(false);
      return;
    }
    await mutate(
      "revoke",
      { declarationType: type, reason: fields.reason.trim() },
      type,
      "REVOKED",
      `${TYPE_LABEL[type]} ${withdrawing ? "request withdrawn" : "revoked"}. The saved declarations were reloaded.`,
    );
  }

  return (
    <div className="evidence-lifecycle" data-evidence-certifications>
      <div className="evidence-lifecycle__actions">
        <button
          type="button"
          className="app-ghost-action"
          disabled={list.status === "loading"}
          onClick={() => {
            setNotice("");
            setMutationError("");
            setRevision((value) => value + 1);
          }}
        >
          Refresh declarations
        </button>
      </div>

      {list.status === "loading" ? (
        <p className="app-hint" role="status">
          Loading declarations…
        </p>
      ) : list.status === "failed" ? (
        <p className="app-field-error" role="alert" data-evidence-certifications-error>
          {list.message}
        </p>
      ) : byType.size === 0 ? (
        <p className="app-hint" data-evidence-certifications-empty>
          No declaration is attached to this record.
        </p>
      ) : (
        <ul className="evidence-lifecycle" aria-label="Declarations">
          {TYPES.filter((type) => byType.has(type)).map((type) => {
            const { latest, earlier } = byType.get(type)!;
            const attestKey = `attest:${type}`;
            const revokeKey = `revoke:${type}`;
            return (
              <li key={type} className="evidence-lifecycle__row" data-evidence-certification={type} data-certification-status={latest.status}>
                <strong>{TYPE_LABEL[type]}</strong>
                <dl className="evidence-lifecycle__facts">
                  <div><dt>Status</dt><dd>{STATUS_LABEL[latest.status] ?? "Unrecognised state"}</dd></div>
                  <div><dt>Version</dt><dd>{latest.version}{earlier > 0 ? ` (${earlier} earlier)` : ""}</dd></div>
                  <div><dt>Requested</dt><dd>{when(latest.requestedAtUtc)}</dd></div>
                  {latest.attestedAtUtc ? (
                    <>
                      <div><dt>Signed</dt><dd>{when(latest.attestedAtUtc)}</dd></div>
                      <div>
                        <dt>Signer</dt>
                        <dd>
                          {[latest.attestorName, latest.attestorTitle, latest.attestorOrganization].filter(Boolean).join(", ") || "Not recorded"}
                        </dd>
                      </div>
                    </>
                  ) : null}
                  {latest.revokedAtUtc ? (
                    <>
                      <div><dt>Revoked</dt><dd>{when(latest.revokedAtUtc)}</dd></div>
                      <div><dt>Revocation reason</dt><dd data-certification-revoke-reason>{latest.revokeReason ?? "No reason recorded"}</dd></div>
                    </>
                  ) : null}
                  {latest.certificationHash ? (
                    <div>
                      <dt>Declaration hash</dt>
                      <dd><code data-identifier>{latest.certificationHash}</code></dd>
                    </div>
                  ) : null}
                </dl>
                <div className="evidence-lifecycle__actions">
                  {latest.status === "REQUESTED" ? (
                    <ReasonedActionButton
                      className="app-secondary-action"
                      aria-expanded={form?.kind === "attest" && form.type === type}
                      aria-controls={`${baseId}-form`}
                      disabled={Boolean(lockedReason) || busy}
                      disabledReason={lockedReason}
                      onClick={(event) => {
                        toggles.current[attestKey] = event.currentTarget;
                        if (form?.kind === "attest" && form.type === type) closeForm();
                        else openForm({ kind: "attest", type });
                      }}
                    >
                      Sign declaration
                    </ReasonedActionButton>
                  ) : null}
                  {isOpen(latest.status) ? (
                    <ReasonedActionButton
                      className="app-danger-action"
                      aria-expanded={form?.kind === "revoke" && form.type === type}
                      aria-controls={`${baseId}-form`}
                      disabled={Boolean(lockedReason) || busy}
                      disabledReason={lockedReason}
                      onClick={(event) => {
                        toggles.current[revokeKey] = event.currentTarget;
                        if (form?.kind === "revoke" && form.type === type) closeForm();
                        else openForm({ kind: "revoke", type });
                      }}
                    >
                      {latest.status === "REQUESTED" ? "Withdraw request" : "Revoke declaration"}
                    </ReasonedActionButton>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {form ? (
        <form
          id={`${baseId}-form`}
          className="evidence-lifecycle__form"
          onSubmit={submit}
          aria-label={form.kind === "attest" ? `Sign ${TYPE_LABEL[form.type].toLowerCase()}` : `Revoke ${TYPE_LABEL[form.type].toLowerCase()}`}
          data-evidence-certification-form={form.kind}
        >
          {form.kind === "attest" ? (
            <>
              <div className="evidence-lifecycle__field">
                <span className="evidence-detail-dialog-field__label">Statement to be signed</span>
                {statement ? (
                  <blockquote className="app-hint" data-certification-statement>
                    {statement}
                  </blockquote>
                ) : (
                  <p className="app-field-error" data-certification-statement-missing>
                    No declaration statement is recorded for this request. Signing
                    is unavailable until an approved statement is attached.
                  </p>
                )}
              </div>
              {(
                [
                  ["name", "Signer full name", "text", "name"],
                  ["title", "Signer title or role", "text", "organization-title"],
                  ["email", "Signer email", "email", "email"],
                  ["organization", "Signer organization (optional)", "text", "organization"],
                  ["signature", "Typed signature", "text", "off"],
                ] as const
              ).map(([key, label, type, autoComplete], index) => (
                <div className="evidence-lifecycle__field" key={key}>
                  <label className="evidence-detail-dialog-field__label" htmlFor={`${baseId}-${key}`}>
                    {label}
                  </label>
                  <input
                    id={`${baseId}-${key}`}
                    ref={index === 0 ? (el) => { firstField.current = el; } : undefined}
                    className="app-form-input"
                    type={type}
                    autoComplete={autoComplete}
                    maxLength={key === "email" ? 320 : key === "signature" ? 512 : key === "organization" ? 180 : 160}
                    value={fields[key]}
                    disabled={busy || !statement}
                    onChange={(event) => setField(key, event.target.value)}
                  />
                </div>
              ))}
            </>
          ) : (
            <div className="evidence-lifecycle__field">
              <label className="evidence-detail-dialog-field__label" htmlFor={`${baseId}-reason`}>
                Reason (required, recorded in custody history)
              </label>
              <textarea
                id={`${baseId}-reason`}
                ref={(el) => { firstField.current = el; }}
                className="app-form-input"
                rows={3}
                maxLength={500}
                value={fields.reason}
                disabled={busy}
                onChange={(event) => setField("reason", event.target.value)}
              />
            </div>
          )}
          <div className="evidence-lifecycle__actions">
            <ReasonedActionButton
              type="submit"
              className={form.kind === "attest" ? "app-primary-action" : "app-danger-action"}
              busy={busy}
              disabled={Boolean(lockedReason || attestReason || revokeReason)}
              disabledReason={lockedReason ?? attestReason ?? revokeReason}
            >
              {busy
                ? "Saving…"
                : form.kind === "attest"
                  ? "Sign declaration"
                  : current?.status === "REQUESTED"
                    ? "Withdraw request"
                    : "Revoke declaration"}
            </ReasonedActionButton>
            <button type="button" className="app-secondary-action" onClick={closeForm} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div className="evidence-lifecycle__field">
        <span id={`${baseId}-type`} className="evidence-detail-dialog-field__label">
          Request a declaration
        </span>
        <div className="evidence-lifecycle__actions">
          <AppListbox
            ariaLabelledby={`${baseId}-type`}
            value={requestType}
            placeholder="Choose declaration type"
            disabled={busy || list.status !== "ready"}
            options={TYPES.map((type) => ({
              value: type,
              label: TYPE_LABEL[type],
              disabled: !requestable.includes(type),
              description: requestable.includes(type) ? undefined : "Already requested or signed",
            }))}
            onChange={(value) => setRequestType(value)}
          />
          <ReasonedActionButton
            className="app-secondary-action"
            busy={busy && !form}
            disabled={Boolean(requestReason)}
            disabledReason={requestReason}
            onClick={() => void requestDeclaration()}
          >
            Request declaration
          </ReasonedActionButton>
        </div>
      </div>

      <div ref={feedback} tabIndex={-1} className="evidence-lifecycle__feedback">
        {notice ? (
          <p className="app-alert app-alert--ok" role="status" data-evidence-certifications-notice>
            {notice}
          </p>
        ) : null}
        {mutationError ? (
          <p className="app-alert app-alert--danger" role="alert" data-evidence-certifications-mutation-error>
            {mutationError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
