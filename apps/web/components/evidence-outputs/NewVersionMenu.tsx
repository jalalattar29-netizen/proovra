"use client";

/**
 * CREATE A NEW VERSION — the one web workflow, for every surface that offers it.
 *
 * Optional and secondary (D2): it lives behind an overflow menu, because a
 * record whose report and verification package are complete needs nothing,
 * and a new version is never the default next step. It is shown only when the
 * server's `outputs.newVersion.action` is CREATE_NEW_VERSION.
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
import { MoreHorizontal } from "lucide-react";
import {
  formatEstimatedBytes,
  makeClientRequestKey,
  NEW_VERSION_ACTION,
  NEW_VERSION_LABEL,
  newVersionConsequence,
  outputUnavailableReasonCopy,
  type NewVersionAction,
  type OutputActionUnavailableReason,
} from "@proovra/shared";
import { AppRowMenu } from "../app-primitives/AppRowMenu";
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
  request: (clientRequestKey: string) => Promise<NewVersionRequestResult>;
  /** Accessible name for the trigger; names the record, not merely "Actions". */
  menuLabel: string;
  dataPrefix: string;
  testId?: string;
}) {
  const { confirm } = useConfirmAction();
  const pendingKey = useRef<string | null>(null);
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
          ? `Create version ${offer.nextVersion}?`
          : "Create a new version?",
      description: (
        <div data-new-version-consequence>
          <p style={{ marginBlockStart: 0 }}>
            Nothing needs recovering: this record&apos;s report and verification
            package are complete. A new version is optional.
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
      confirmLabel: NEW_VERSION_LABEL,
      testId: testId ? `${testId}-confirm` : "new-version-confirm",
    });
    if (!ok) return;
    pendingKey.current ??= makeClientRequestKey();
    const result = await request(pendingKey.current);
    if (result === "answered") pendingKey.current = null;
  };

  return (
    <AppRowMenu
      actions={[
        {
          key: "create-new-version",
          label: `${NEW_VERSION_LABEL}…`,
          onSelect: () => void open(),
          disabled: busy,
          pending: busy,
        },
      ]}
      label={menuLabel}
      dataPrefix={dataPrefix}
      testId={testId}
      triggerLabel="More"
      icon={<MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />}
    />
  );
}
