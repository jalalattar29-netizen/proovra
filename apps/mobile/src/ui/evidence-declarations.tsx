/**
 * DECLARATIONS PANEL (T-12 / RC-13) — the native port of
 * `EvidenceCertificationsPanel.tsx`: list, request, sign and revoke/withdraw.
 *
 * The panel owns its read, as the web's does, so a failed read is SAID
 * ("could not be loaded") instead of the section silently disappearing. Every
 * write is followed by a reread; success is announced only when the reread
 * shows the expected state. The server decides who may write
 * (`evidence.generate_report` record access) — a refusal is reported through
 * the safe-error projection, never pre-empted client-side.
 *
 * Touch adaptations: the web's type listbox becomes two type buttons (an
 * unavailable type stays visible, disabled, with the web's reason); the
 * web's `confirm()` modal becomes ProovraConfirmSheet with the same copy.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import { projectCertifications, type CertificationView } from "../product/evidence-detail";
import {
  DECLARATION_TYPES,
  DECLARATION_TYPE_LABEL,
  DECLARATIONS_COPY,
  EXPECTED_STATUS,
  STATEMENT_MAX_LENGTH,
  attestBody,
  attestReason,
  buildDeclarationActionPath,
  buildDeclarationsPath,
  confirmCopy,
  declarationStatusLabel,
  isOpenDeclaration,
  latestByType,
  lockedReason as computeLocked,
  requestBody,
  requestReason as computeRequestReason,
  requestableTypes,
  revokeBody,
  successCopy,
  type AttestFields,
  type DeclarationType,
} from "../product/declarations";
import { ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraText } from "./index";
import { ProovraConfirmSheet, ProovraDetailRows } from "./patterns";

type Load = { status: "loading" } | { status: "ready"; items: CertificationView[] } | { status: "failed"; message: string };
type Form = { kind: "attest" | "revoke"; type: DeclarationType };
type Pending = { action: "request" | "attest" | "revoke"; type: DeclarationType; body: Record<string, unknown>; withdrawing: boolean };

const EMPTY_FIELDS: AttestFields & { reason: string } = { name: "", title: "", email: "", organization: "", signature: "", reason: "" };

function when(iso: string | null): string {
  return iso ? formatUserDateTime(iso) : "Not recorded";
}

export function EvidenceDeclarationsPanel({ evidenceId }: { evidenceId: string }) {
  const [list, setList] = useState<Load>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [requestType, setRequestType] = useState<DeclarationType | null>(null);
  const [statementDraft, setStatementDraft] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const listPath = buildDeclarationsPath(evidenceId);

  useEffect(() => {
    let current = true;
    setList({ status: "loading" });
    apiFetch(listPath)
      .then((value) => {
        if (!current) return;
        setList({ status: "ready", items: projectCertifications(value) });
        setUnconfirmed(false);
      })
      .catch((err) => {
        if (current) setList({ status: "failed", message: toSafeUserError(err, { message: DECLARATIONS_COPY.loadFailed }).message });
      });
    return () => {
      current = false;
    };
  }, [listPath, revision]);

  const byType = useMemo(() => (list.status === "ready" ? latestByType(list.items) : new Map()), [list]);
  const requestable = requestableTypes(byType);
  const locked = computeLocked({ ready: list.status === "ready", unconfirmed });
  const requestBlocked = computeRequestReason({ locked, requestable, type: requestType, statement: statementDraft });

  const current = form ? byType.get(form.type)?.latest ?? null : null;
  const statement = current?.statementMarkdown?.trim() || null;
  const attestBlocked = form?.kind === "attest" ? attestReason(statement, fields) : null;
  const revokeBlocked = form?.kind === "revoke" && !fields.reason.trim() ? "Enter the reason for revoking." : null;
  const formBlocked = locked ?? attestBlocked ?? revokeBlocked;

  const setField = (key: keyof typeof EMPTY_FIELDS) => (value: string) => setFields((prev) => ({ ...prev, [key]: value }));

  function openForm(next: Form) {
    if (form && form.kind === next.kind && form.type === next.type) {
      setForm(null);
      return;
    }
    setForm(next);
    setFields(EMPTY_FIELDS);
    setNotice("");
    setMutationError("");
  }

  /** Write, then reread and check the saved state before announcing anything. */
  const mutate = useCallback(
    async (p: Pending) => {
      setBusy(true);
      setNotice("");
      setMutationError("");
      let written = false;
      try {
        await apiFetch(buildDeclarationActionPath(evidenceId, p.action), { method: "POST", body: JSON.stringify(p.body) });
        written = true;
        const items = projectCertifications(await apiFetch(listPath));
        if (!alive.current) return;
        setList({ status: "ready", items });
        const latest = latestByType(items).get(p.type)?.latest;
        if (latest?.status === EXPECTED_STATUS[p.action]) setNotice(successCopy(p.action, p.type, p.withdrawing));
        else setMutationError(DECLARATIONS_COPY.notConfirmed);
        setForm(null);
        if (p.action === "request") {
          setRequestType(null);
          setStatementDraft("");
        }
      } catch (err) {
        if (!alive.current) return;
        if (written) {
          setUnconfirmed(true);
          setForm(null);
          setMutationError(DECLARATIONS_COPY.rereadFailed);
        } else {
          setMutationError(toSafeUserError(err, { message: DECLARATIONS_COPY.mutationFailed }).message);
        }
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [evidenceId, listPath],
  );

  function askRequest() {
    if (busy || requestBlocked || !requestType) return;
    setPending({ action: "request", type: requestType, body: requestBody(requestType, statementDraft), withdrawing: false });
  }
  function askForm() {
    if (!form || busy || formBlocked) return;
    if (form.kind === "attest") {
      if (!statement) return;
      setPending({ action: "attest", type: form.type, body: attestBody(form.type, statement, fields), withdrawing: false });
    } else {
      setPending({ action: "revoke", type: form.type, body: revokeBody(form.type, fields.reason), withdrawing: current?.status === "REQUESTED" });
    }
  }

  const confirm = pending ? confirmCopy(pending.action, pending.type, pending.withdrawing) : null;

  return (
    <ProovraCard>
      <View style={{ gap: theme.space.s3 }} testID="evidence-declarations">
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
          {DECLARATIONS_COPY.title}
        </ProovraText>
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {DECLARATIONS_COPY.description}
        </ProovraText>
        <ProovraButton
          label="Refresh declarations"
          variant="ghost"
          fullWidth={false}
          disabled={list.status === "loading"}
          onPress={() => {
            setNotice("");
            setMutationError("");
            setRevision((v) => v + 1);
          }}
        />

        {list.status === "loading" ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>Loading declarations…</ProovraText>
        ) : list.status === "failed" ? (
          <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
            {list.message}
          </ProovraText>
        ) : byType.size === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{DECLARATIONS_COPY.empty}</ProovraText>
        ) : (
          DECLARATION_TYPES.filter((t) => byType.has(t)).map((type) => {
            const { latest, earlier } = byType.get(type)!;
            const rows = [
              { label: "Status", value: declarationStatusLabel(latest.status) },
              { label: "Version", value: `${latest.version}${earlier > 0 ? ` (${earlier} earlier)` : ""}` },
              { label: "Requested", value: when(latest.requestedAtUtc) },
              ...(latest.attestedAtUtc
                ? [
                    { label: "Signed", value: when(latest.attestedAtUtc) },
                    {
                      label: "Signer",
                      value: [latest.attestorName, latest.attestorTitle, latest.attestorOrganization].filter(Boolean).join(", ") || "Not recorded",
                    },
                  ]
                : []),
              ...(latest.revokedAtUtc
                ? [
                    { label: "Revoked", value: when(latest.revokedAtUtc) },
                    { label: "Revocation reason", value: latest.revokeReason ?? "No reason recorded" },
                  ]
                : []),
              ...(latest.certificationHash ? [{ label: "Declaration hash", value: latest.certificationHash, mono: true }] : []),
            ];
            return (
              <View key={type} style={{ gap: theme.space.s2 }} testID={`declaration-${type}`}>
                <ProovraText variant="bodySm" weight="semibold">{DECLARATION_TYPE_LABEL[type]}</ProovraText>
                <ProovraDetailRows rows={rows} />
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                  {latest.status === "REQUESTED" ? (
                    <ProovraButton
                      label="Sign declaration"
                      variant="secondary"
                      fullWidth={false}
                      disabled={!!locked || busy}
                      accessibilityLabel={`Sign ${DECLARATION_TYPE_LABEL[type].toLowerCase()}`}
                      onPress={() => openForm({ kind: "attest", type })}
                    />
                  ) : null}
                  {isOpenDeclaration(latest.status) ? (
                    <ProovraButton
                      label={latest.status === "REQUESTED" ? "Withdraw request" : "Revoke declaration"}
                      variant="danger"
                      fullWidth={false}
                      disabled={!!locked || busy}
                      accessibilityLabel={`${latest.status === "REQUESTED" ? "Withdraw request for" : "Revoke"} ${DECLARATION_TYPE_LABEL[type].toLowerCase()}`}
                      onPress={() => openForm({ kind: "revoke", type })}
                    />
                  ) : null}
                </View>
              </View>
            );
          })
        )}

        {form ? (
          <View style={{ gap: theme.space.s2 }} testID={`declaration-form-${form.kind}`}>
            {form.kind === "attest" ? (
              <>
                <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Statement to be signed</ProovraText>
                {statement ? (
                  <ProovraText variant="bodySm" selectable testID="declaration-statement">{statement}</ProovraText>
                ) : (
                  <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{DECLARATIONS_COPY.statementMissing}</ProovraText>
                )}
                {(
                  [
                    ["name", "Signer full name"],
                    ["title", "Signer title or role"],
                    ["email", "Signer email"],
                    ["organization", "Signer organization (optional)"],
                    ["signature", "Typed signature"],
                  ] as const
                ).map(([key, label]) => (
                  <ProovraFormField key={key} label={label}>
                    <ProovraInput
                      value={fields[key]}
                      onChangeText={setField(key)}
                      editable={!busy && !!statement}
                      autoCapitalize={key === "email" ? "none" : "words"}
                      autoComplete={key === "email" ? "email" : "off"}
                      keyboardType={key === "email" ? "email-address" : undefined}
                    />
                  </ProovraFormField>
                ))}
              </>
            ) : (
              <ProovraFormField label="Reason (required, recorded in custody history)">
                <ProovraInput value={fields.reason} onChangeText={setField("reason")} editable={!busy} multiline autoCapitalize="sentences" />
              </ProovraFormField>
            )}
            {formBlocked ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>{formBlocked}</ProovraText>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
              <ProovraButton
                label={
                  busy
                    ? "Saving…"
                    : form.kind === "attest"
                      ? "Sign declaration"
                      : current?.status === "REQUESTED"
                        ? "Withdraw request"
                        : "Revoke declaration"
                }
                accessibilityLabel={form.kind === "attest" ? "Submit signature" : "Submit revocation"}
                variant={form.kind === "attest" ? "primary" : "danger"}
                fullWidth={false}
                disabled={!!formBlocked || busy}
                onPress={askForm}
              />
              <ProovraButton label="Cancel" variant="ghost" fullWidth={false} disabled={busy} onPress={() => setForm(null)} />
            </View>
          </View>
        ) : null}

        <View style={{ gap: theme.space.s2 }}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Request a declaration</ProovraText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
            {DECLARATION_TYPES.map((type) => {
              const available = requestable.includes(type);
              return (
                <ProovraButton
                  key={type}
                  label={DECLARATION_TYPE_LABEL[type]}
                  variant={requestType === type ? "primary" : "secondary"}
                  fullWidth={false}
                  disabled={busy || list.status !== "ready" || !available}
                  accessibilityLabel={`Declaration type: ${DECLARATION_TYPE_LABEL[type]}${available ? "" : ", already requested or signed"}`}
                  onPress={() => setRequestType(type)}
                />
              );
            })}
          </View>
          <ProovraFormField label="Declaration statement (the signer signs exactly this text)">
            <ProovraInput
              value={statementDraft}
              onChangeText={(v) => setStatementDraft(v.slice(0, STATEMENT_MAX_LENGTH))}
              editable={!busy && list.status === "ready"}
              multiline
              autoCapitalize="sentences"
            />
          </ProovraFormField>
          {requestBlocked ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>{requestBlocked}</ProovraText>
          ) : null}
          <ProovraButton
            label="Request declaration"
            variant="secondary"
            fullWidth={false}
            loading={busy && !form && !!pending}
            disabled={!!requestBlocked || busy}
            onPress={askRequest}
          />
        </View>

        {notice ? (
          <ProovraText variant="bodySm" color={theme.color.status.verified.fg}>{notice}</ProovraText>
        ) : null}
        {mutationError ? (
          <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{mutationError}</ProovraText>
        ) : null}
      </View>

      <ProovraConfirmSheet
        visible={!!pending && !!confirm}
        title={confirm?.title ?? ""}
        consequence={confirm?.consequence}
        confirmLabel={confirm?.confirmLabel}
        tone={confirm?.tone}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const p = pending;
          if (!p) return;
          void mutate(p).finally(() => {
            if (alive.current) setPending(null);
          });
        }}
      />
    </ProovraCard>
  );
}
