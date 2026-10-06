/**
 * GENERATE AN UPDATED REPORT (native) — the same contract as the web dialog.
 *
 * A DIRECT action (no overflow sheet), shown only when the server's
 * `outputs.newVersion.action` is CREATE_NEW_VERSION. Opening it re-reads
 * `/artifacts/status` and holds the SIGNED offer revision; Confirm sends that
 * revision, and the server re-derives every bound fact (versions, TSA, OTS, the
 * decisions, the active request, permission, eligibility, credit and storage)
 * before it creates anything. A stale confirmation is answered in place: the
 * sheet says what changed, keeps the reason, re-reads the offer and asks for a
 * NEW confirmation. Nothing about staleness is decided on the device.
 *
 * REASON (RGA-03): the shared validator — the same bounds and normalization the
 * API enforces — with a live counter and an inline, announced error; Confirm is
 * disabled until it is valid.
 *
 * IDEMPOTENCY: a key per confirmation, reused only while unanswered (lost
 * response → REPLAYED), replaced after a stale refusal (a new confirmation).
 */
import React, { useRef, useState } from "react";
import { View } from "react-native";

import {
  NEW_VERSION_ACTION,
  NEW_VERSION_REASON_MAX,
  newVersionReasonError,
  normalizeNewVersionReason,
  outputOperationError,
  outputOperationErrorForReason,
  reportFreshnessChangeCopy,
  resolveOutputOperationError,
  validateNewVersionReason,
  type ReportFreshness,
} from "@proovra/shared";

import { apiFetch } from "../api";
import {
  NEW_VERSION_LABEL,
  buildNewVersionBody,
  buildRegeneratePath,
  formatEstimatedBytes,
  makeClientRequestKey,
  newVersionConsequence,
  readGenerationOutcome,
  requestWasAnswered,
} from "../product/evidence-detail";
import { projectNewVersionOffer, type NewVersionOfferView } from "../product/evidence-record";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraInput, ProovraText } from "./index";
import { ProovraConfirmSheet } from "./patterns";

type Current = { offer: NewVersionOfferView; revision: string | null; freshness: ReportFreshness | null };

/** The confirmation's body, one sentence per line. */
export function newVersionConfirmText(offer: NewVersionOfferView, freshness?: ReportFreshness | null): string {
  const lines = [
    "An updated report documents this record's current verification facts as a new, separate version. It does not replace or alter any earlier version.",
  ];
  if (freshness?.hasNewerFacts) {
    for (const c of freshness.changes) lines.push(reportFreshnessChangeCopy(c, freshness.reportVersion));
  }
  lines.push(
    ...newVersionConsequence({
      currentVersion: offer.currentVersion,
      nextVersion: offer.nextVersion,
      estimate: offer.estimate,
    }),
  );
  const used = formatEstimatedBytes(offer.estimate?.storageBytesUsed ?? null);
  const limit = formatEstimatedBytes(offer.estimate?.storageBytesLimit ?? null);
  if (used && limit) lines.push(`Workspace storage now: ${used} used of ${limit}.`);
  if (offer.nextVersion != null) {
    lines.push(`A matching verification package v${offer.nextVersion} will certify report v${offer.nextVersion}.`);
  }
  lines.push("No evidence credit is used. The original evidence and its recorded timestamps are not modified.");
  return lines.join("\n");
}

/** A stale-offer refusal's change sentences, from the error body. */
function staleChanges(err: unknown): string[] | null {
  const e = err as { code?: unknown; body?: { changeMessages?: unknown } } | null;
  if (e?.code !== "OUTPUT_OFFER_STALE" && e?.code !== "OUTPUT_OFFER_REQUIRED") return null;
  const raw = e.body?.changeMessages;
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string") : [];
}

export function NewVersionAction({
  evidenceId,
  displayTitle,
  offer,
  emphasize = false,
  onRequested,
}: {
  evidenceId: string;
  displayTitle: string;
  offer: NewVersionOfferView | null;
  /** Primary only when newer verification facts exist. */
  emphasize?: boolean;
  onRequested?: () => void;
}) {
  const [current, setCurrent] = useState<Current | null>(null);
  const [withdrawn, setWithdrawn] = useState<{ title: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [changes, setChanges] = useState<string[] | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const pendingKey = useRef<string | null>(null);

  if (!offer || offer.action !== NEW_VERSION_ACTION) return null;

  /** Re-read the authoritative offer. */
  const readCurrent = async (): Promise<Current | null> => {
    try {
      const st = (await apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/artifacts/status`)) as {
        outputs?: { newVersion?: unknown; offer?: { revision?: unknown }; freshness?: unknown };
      } | null;
      const nv = projectNewVersionOffer(st?.outputs?.newVersion);
      if (!nv) return null;
      const f = st?.outputs?.freshness as ReportFreshness | undefined;
      return {
        offer: nv,
        revision: typeof st?.outputs?.offer?.revision === "string" ? st.outputs.offer.revision : null,
        freshness: f && typeof f.hasNewerFacts === "boolean" ? f : null,
      };
    } catch {
      return null;
    }
  };

  const showWithdrawnOrConfirm = (next: Current | null) => {
    if (!next) {
      const e = outputOperationError("OFFER_LOAD_FAILED");
      setCurrent(null);
      setWithdrawn({ title: e.title, text: e.description });
      return;
    }
    if (next.offer.action !== NEW_VERSION_ACTION) {
      const e = outputOperationErrorForReason(next.offer.reason) ?? outputOperationError("OFFER_STALE");
      setCurrent(null);
      setWithdrawn({ title: e.title, text: e.description });
      return;
    }
    setCurrent(next);
  };

  const openConfirm = async () => {
    setNotice(null);
    setChanges(null);
    setInlineError(null);
    showWithdrawnOrConfirm(await readCurrent());
  };

  const check = validateNewVersionReason(reason);
  const count = normalizeNewVersionReason(reason).length;

  const submit = async () => {
    setTouched(true);
    if (busy || !current || !check.ok) return;
    setBusy(true);
    setInlineError(null);
    pendingKey.current ??= makeClientRequestKey();
    try {
      const read = readGenerationOutcome(
        await apiFetch(buildRegeneratePath(evidenceId), {
          method: "POST",
          body: buildNewVersionBody(pendingKey.current, check.value, current.revision),
        }),
      );
      pendingKey.current = null;
      setCurrent(null);
      setReason("");
      setTouched(false);
      setNotice({ text: read.message, error: read.tone === "error" });
      onRequested?.();
    } catch (err) {
      const stale = staleChanges(err);
      if (stale) {
        // A NEW confirmation follows: new key, re-read offer, reason kept.
        pendingKey.current = null;
        setChanges(stale.length ? stale : [outputOperationError("OFFER_STALE").description]);
        showWithdrawnOrConfirm(await readCurrent());
        return;
      }
      if (requestWasAnswered(err)) pendingKey.current = null;
      const e = err as { statusCode?: number; code?: string; body?: { reason?: unknown } } | null;
      const typed = resolveOutputOperationError({
        status: e?.statusCode ?? null,
        code: e?.code ?? null,
        reason: typeof e?.body?.reason === "string" ? e.body.reason : null,
        network: e?.statusCode == null || e?.statusCode === 0,
      });
      setInlineError(`${typed.title}. ${typed.description}`);
    } finally {
      setBusy(false);
    }
  };

  const target = current?.offer.nextVersion ?? null;
  return (
    <View style={{ gap: 4 }} testID={`new-version-action-${evidenceId}`}>
      <ProovraButton
        label="Generate updated report"
        accessibilityLabel={`Generate updated report: ${displayTitle}`}
        variant={emphasize ? "primary" : "secondary"}
        fullWidth={false}
        disabled={busy}
        onPress={() => void openConfirm()}
        testID="new-version-open"
      />
      {notice ? (
        <View accessibilityLiveRegion="polite">
          <ProovraText variant="label" color={notice.error ? theme.color.status.risk.fg : theme.color.ink.secondary}>
            {notice.text}
          </ProovraText>
        </View>
      ) : null}
      <ProovraConfirmSheet
        visible={current !== null}
        title={target != null ? `Generate report v${target}` : "Generate an updated report"}
        consequence={current ? newVersionConfirmText(current.offer, current.freshness) : undefined}
        confirmLabel={busy ? "Submitting…" : changes ? (target != null ? `Confirm report v${target}` : "Confirm again") : target != null ? `Generate report v${target}` : NEW_VERSION_LABEL}
        busy={busy}
        confirmDisabled={busy || !check.ok}
        onConfirm={() => void submit()}
        onCancel={() => {
          if (!busy) setCurrent(null);
        }}
      >
        {changes ? (
          <View testID="new-version-stale" accessibilityLiveRegion="assertive" style={{ gap: 2 }}>
            <ProovraText variant="label" weight="semibold">This record changed while this was open</ProovraText>
            {changes.map((c) => (
              <ProovraText key={c} variant="label">{`• ${c}`}</ProovraText>
            ))}
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              Review the current details and confirm again. Your reason has been kept.
            </ProovraText>
          </View>
        ) : null}
        <ProovraText variant="label" weight="semibold">Reason for the updated report (required)</ProovraText>
        <ProovraInput
          value={reason}
          onChangeText={(t) => {
            setReason(t);
            if (t.length > 0) setTouched(true);
          }}
          placeholder="Which later facts should it document?"
          multiline
          accessibilityLabel="Reason for the updated report, required"
          testID="new-version-reason"
        />
        <ProovraText variant="label" color={theme.color.ink.secondary} testID="new-version-count">
          {`${count}/${NEW_VERSION_REASON_MAX}`}
        </ProovraText>
        {touched && !check.ok ? (
          <View accessibilityLiveRegion="polite">
            <ProovraText variant="label" color={theme.color.status.risk.fg} testID="new-version-reason-error">
              {newVersionReasonError(check.reason)}
            </ProovraText>
          </View>
        ) : null}
        {inlineError ? (
          <View accessibilityLiveRegion="assertive">
            <ProovraText variant="label" color={theme.color.status.risk.fg} testID="new-version-error">
              {inlineError}
            </ProovraText>
          </View>
        ) : null}
      </ProovraConfirmSheet>
      <ProovraConfirmSheet
        visible={withdrawn !== null}
        title={withdrawn?.title ?? "An updated report can't be created right now"}
        consequence={withdrawn?.text}
        confirmLabel="OK"
        onConfirm={() => setWithdrawn(null)}
        onCancel={() => setWithdrawn(null)}
      />
    </View>
  );
}
