"use client";

/**
 * CREATE A NEW VERSION — the one web workflow, for every surface that offers it.
 *
 * It is a DIRECT, visible action (Phase 5.2) — not hidden in a one-item overflow
 * menu — because the updated report is the only lifecycle step a complete record
 * can still take. It is shown only when the server's `outputs.newVersion.action`
 * is CREATE_NEW_VERSION, so it never appears on a record that needs nothing.
 *
 * The confirmation states, before anything happens (D6): the current and next
 * version, what is rebuilt, that older versions are kept, the server's storage
 * ESTIMATE (labelled as one) with the workspace allowance, and that no evidence
 * credit is charged.
 *
 * IDEMPOTENCY. A key is minted per confirmation and kept only while that
 * request is unanswered (network loss, server fault). Confirming again then
 * reuses it, so a request that did land is answered with the first request
 * (REPLAYED) instead of creating a second version. Any server answer clears it.
 */

import { useRef } from "react";
import {
  formatEstimatedBytes,
  makeClientRequestKey,
  NEW_VERSION_ACTION,
  NEW_VERSION_LABEL,
  NEW_VERSION_REASON_MAX,
  newVersionConsequence,
  normalizeNewVersionReason,
  validateNewVersionReason,
  newVersionReasonError,
  outputUnavailableReasonCopy,
  type NewVersionAction,
  type OutputActionUnavailableReason,
} from "@proovra/shared";
import { useConfirmAction } from "../ui/ConfirmActionModal";

export type NewVersionOffer = {
  action: NewVersionAction;
  reason: OutputActionUnavailableReason | null;
  currentVersion?: number | null;
  nextVersion?: number | null;
  estimate?: {
    estimatedBytes: string;
    basis: "PREVIOUS_PAIR" | "ORIGINAL_EVIDENCE";
    storageBytesUsed?: string | null;
    storageBytesLimit?: string | null;
  } | null;
};

/** "answered": the server decided. "unanswered": it may have landed — keep the key. */
export type NewVersionRequestResult = "answered" | "unanswered";

export function NewVersionMenu({
  offer,
  busy,
  request,
  loadOffer,
  menuLabel,
  dataPrefix,
  testId,
}: {
  offer: NewVersionOffer | null | undefined;
  /**
   * Dense rows carry the decision but not the estimate. When given, the
   * CURRENT offer (versions, estimate, allowance) is read from the server
   * before the confirmation is shown, and a withdrawn offer is explained
   * instead of confirmed.
   */
  loadOffer?: () => Promise<NewVersionOffer | null>;
  busy: boolean;
  /** `reason` is required: an updated report records why it was issued. */
  request: (clientRequestKey: string, reason: string) => Promise<NewVersionRequestResult>;
  /** Accessible name for the trigger; names the record, not merely "Actions". */
  menuLabel: string;
  dataPrefix: string;
  testId?: string;
}) {
  const { confirm } = useConfirmAction();
  const pendingKey = useRef<string | null>(null);
  const reasonRef = useRef("");
  if (!offer || offer.action !== NEW_VERSION_ACTION) return null;

  const open = async () => {
    let current: NewVersionOffer | null = offer;
    if (loadOffer) {
      try {
        current = await loadOffer();
      } catch {
        current = null;
      }
      if (!current || current.action !== NEW_VERSION_ACTION) {
        await confirm({
          title: "A new version can't be created right now",
          description:
            outputUnavailableReasonCopy(current?.reason) ??
            "This record's state changed. Open the record to see what it offers now.",
          noticeOnly: true,
          testId: testId ? `${testId}-withdrawn` : "new-version-withdrawn",
        });
        return;
      }
    }
    await confirmAndRequest(current);
  };

  const confirmAndRequest = async (offer: NewVersionOffer) => {
    const used = formatEstimatedBytes(offer.estimate?.storageBytesUsed ?? null);
    const limit = formatEstimatedBytes(offer.estimate?.storageBytesLimit ?? null);
    const ok = await confirm({
      title:
        offer.nextVersion != null
          ? `Generate report v${offer.nextVersion}`
          : "Generate an updated report",
      description: (
        <div data-new-version-consequence>
          <p style={{ marginBlockStart: 0 }}>
            Nothing needs recovering: this record&apos;s report and verification
            package are complete. An updated report is optional and documents
            later facts; it does not replace the earlier report.
          </p>
          <ul>
            {newVersionConsequence({
              currentVersion: offer.currentVersion ?? null,
              nextVersion: offer.nextVersion ?? null,
              estimate: offer.estimate ?? null,
            }).map((line) => (
              <li key={line}>{line}</li>
            ))}
            {used && limit ? (
              <li data-new-version-storage>
                Workspace storage now: {used} used of {limit}.
              </li>
            ) : null}
            <li>
              New versions are limited per record and per person each hour.
            </li>
          </ul>
        </div>
      ),
      // RGA-03 — the validated reason field. Live validation, counter, accessible
      // inline error, Confirm disabled until valid, using the SHARED authority so
      // the client enforces exactly the server's bounds + normalization. The valid
      // text is preserved across a confirm-time offer refresh (RGA-02).
      reasonField: {
        label: "Reason for the updated report (required)",
        placeholder:
          "For example: document the Bitcoin anchor confirmed after the first report",
        max: NEW_VERSION_REASON_MAX,
        initialValue: reasonRef.current,
        countOf: (raw) => normalizeNewVersionReason(raw).length,
        validate: (raw) => {
          const v = validateNewVersionReason(raw);
          return v.ok
            ? { ok: true, value: v.value }
            : { ok: false, value: v.value, message: newVersionReasonError(v.reason) };
        },
        onConfirmed: (value) => {
          reasonRef.current = value;
        },
      },
      confirmLabel: NEW_VERSION_LABEL,
      testId: testId ? `${testId}-confirm` : "new-version-confirm",
    });
    if (!ok) return;
    // The modal's reason field is valid (it gates Confirm); its normalized value
    // was written to reasonRef by onConfirmed.
    const reason = reasonRef.current.trim();

    // RGA-02 — REVALIDATE INSIDE THE CONFIRM PATH, not only at open(). State can
    // change while the modal is open (TSA/OTS advanced, latest version moved,
    // another user issued a version, permission/eligibility changed, a request
    // started). Re-read the canonical offer immediately before submitting and
    // compare the operation and the intended next version.
    if (loadOffer) {
      let fresh: NewVersionOffer | null = null;
      try {
        fresh = await loadOffer();
      } catch {
        fresh = null;
      }
      const stale =
        !fresh ||
        fresh.action !== NEW_VERSION_ACTION ||
        fresh.nextVersion !== offer.nextVersion;
      if (stale) {
        const canStillIssue = Boolean(fresh && fresh.action === NEW_VERSION_ACTION);
        await confirm({
          title: canStillIssue
            ? "This record changed — confirm the updated truth"
            : "A new version can't be created right now",
          description: canStillIssue
            ? `The latest report is now v${(fresh!.currentVersion ?? "?")}, so this would create v${(fresh!.nextVersion ?? "?")}. Your reason is kept; confirm again to issue it against the current state.`
            : outputUnavailableReasonCopy(fresh?.reason) ??
              "This record's state changed. Open the record to see what it offers now.",
          noticeOnly: true,
          testId: testId ? `${testId}-revalidate` : "new-version-revalidate",
        });
        // The reason stays in reasonRef. Re-offer against the fresh state if it
        // still allows an updated report; otherwise stop (nothing is submitted).
        if (canStillIssue) {
          await confirmAndRequest(fresh!);
        }
        return;
      }
    }

    pendingKey.current ??= makeClientRequestKey();
    const result = await request(pendingKey.current, reason);
    if (result === "answered") pendingKey.current = null;
  };

  // RGA / Phase 5.2 — a DIRECT, visible lifecycle action. The updated report is
  // the only thing a complete record can still do, so it must not hide inside a
  // one-item overflow menu. `menuLabel`/`dataPrefix` are retained on the props for
  // backward compatibility; the control is now a labelled button.
  void menuLabel;
  void dataPrefix;
  return (
    <button
      type="button"
      className="app-secondary-action"
      data-testid={testId}
      data-evidence-action="generate-updated-report"
      onClick={() => void open()}
      disabled={busy}
      aria-busy={busy || undefined}
    >
      {busy ? "Working…" : "Generate updated report"}
    </button>
  );
}
