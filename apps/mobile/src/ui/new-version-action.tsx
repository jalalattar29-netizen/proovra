/**
 * CREATE A NEW VERSION (native) — the one flow for every surface that offers
 * it, the same as the web's NewVersionMenu.
 *
 * Optional and secondary (D2): behind a "⋯" sheet, shown only when the
 * server's `outputs.newVersion.action` is CREATE_NEW_VERSION. The confirmation
 * states the current and next version, what is rebuilt, that older versions
 * are kept, the server's storage ESTIMATE with the workspace allowance, and
 * that no evidence credit is charged (D6).
 *
 * IDEMPOTENCY. A key is minted per confirmation and kept only while that
 * request is unanswered (no response, or a server fault), so confirming again
 * is answered with the first request (REPLAYED) instead of a second version.
 */
import React, { useRef, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { NEW_VERSION_ACTION } from "@proovra/shared";
import {
  NEW_VERSION_LABEL,
  buildNewVersionBody,
  buildRegeneratePath,
  formatEstimatedBytes,
  makeClientRequestKey,
  newVersionConsequence,
  outputUnavailableReasonCopy,
  readGenerationOutcome,
  requestWasAnswered,
} from "../product/evidence-detail";
import { projectNewVersionOffer, type NewVersionOfferView } from "../product/evidence-record";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraText } from "./index";
import { ProovraConfirmSheet, ProovraSheet } from "./patterns";

/** The confirmation's body, one sentence per line. */
export function newVersionConfirmText(offer: NewVersionOfferView): string {
  const lines = [
    "Nothing needs recovering: this record's report and verification package are complete. A new version is optional.",
    ...newVersionConsequence({
      currentVersion: offer.currentVersion,
      nextVersion: offer.nextVersion,
      estimate: offer.estimate,
    }),
  ];
  const used = formatEstimatedBytes(offer.estimate?.storageBytesUsed ?? null);
  const limit = formatEstimatedBytes(offer.estimate?.storageBytesLimit ?? null);
  if (used && limit) lines.push(`Workspace storage now: ${used} used of ${limit}.`);
  lines.push("New versions are limited per record and per person each hour.");
  return lines.join("\n");
}

export function NewVersionAction({
  evidenceId,
  displayTitle,
  offer,
  readCurrentOffer = false,
  onRequested,
}: {
  evidenceId: string;
  displayTitle: string;
  offer: NewVersionOfferView | null;
  /** Dense rows carry the decision only; read versions and estimate on open. */
  readCurrentOffer?: boolean;
  onRequested?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<NewVersionOfferView | null>(null);
  const [withdrawn, setWithdrawn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const pendingKey = useRef<string | null>(null);

  if (!offer || offer.action !== NEW_VERSION_ACTION) return null;

  const openConfirm = async () => {
    setMenuOpen(false);
    let current: NewVersionOfferView | null = offer;
    if (readCurrentOffer) {
      try {
        const st = (await apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/artifacts/status`)) as {
          outputs?: { newVersion?: unknown };
        } | null;
        current = projectNewVersionOffer(st?.outputs?.newVersion);
      } catch {
        current = null;
      }
    }
    if (!current || current.action !== NEW_VERSION_ACTION) {
      setWithdrawn(
        outputUnavailableReasonCopy(current?.reason as never) ??
          "This record's state changed. Open the record to see what it offers now.",
      );
      return;
    }
    setConfirming(current);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    pendingKey.current ??= makeClientRequestKey();
    try {
      const read = readGenerationOutcome(
        await apiFetch(buildRegeneratePath(evidenceId), {
          method: "POST",
          body: buildNewVersionBody(pendingKey.current),
        }),
      );
      pendingKey.current = null;
      setNotice({ text: read.message, error: read.tone === "error" });
    } catch (err) {
      if (requestWasAnswered(err)) pendingKey.current = null;
      setNotice({ text: toSafeUserError(err, { message: "Could not request a new version." }).message, error: true });
    } finally {
      setBusy(false);
      setConfirming(null);
      onRequested?.();
    }
  };

  return (
    <View style={{ gap: 4 }} testID={`new-version-action-${evidenceId}`}>
      <ProovraButton
        label="⋯"
        accessibilityLabel={`More actions: ${displayTitle}`}
        variant="secondary"
        fullWidth={false}
        disabled={busy}
        onPress={() => setMenuOpen(true)}
      />
      {notice ? (
        <ProovraText variant="label" color={notice.error ? theme.color.status.risk.fg : theme.color.ink.secondary}>
          {notice.text}
        </ProovraText>
      ) : null}
      <ProovraSheet visible={menuOpen} title="More actions" onClose={() => setMenuOpen(false)}>
        <ProovraButton
          label={`${NEW_VERSION_LABEL}…`}
          accessibilityLabel={`${NEW_VERSION_LABEL}: ${displayTitle}`}
          variant="secondary"
          onPress={() => void openConfirm()}
        />
      </ProovraSheet>
      <ProovraConfirmSheet
        visible={confirming !== null}
        title={confirming?.nextVersion != null ? `Create version ${confirming.nextVersion}?` : "Create a new version?"}
        consequence={confirming ? newVersionConfirmText(confirming) : undefined}
        confirmLabel={NEW_VERSION_LABEL}
        busy={busy}
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(null)}
      />
      <ProovraConfirmSheet
        visible={withdrawn !== null}
        title="A new version can't be created right now"
        consequence={withdrawn ?? undefined}
        confirmLabel="OK"
        onConfirm={() => setWithdrawn(null)}
        onCancel={() => setWithdrawn(null)}
      />
    </View>
  );
}
