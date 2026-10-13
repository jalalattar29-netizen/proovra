/**
 * BASIC PUBLIC VERIFICATION — native (Decision B, 2026-09-29).
 *
 * Parity with the web `BasicVerificationView`. Rendered when the server
 * answers `tier: "BASIC"`: what the checks established about the original
 * evidence, the real chronology, and whether a report / package has been
 * ISSUED. No title, file name, case, person, preview or download.
 *
 * 2026-10-08: when the reply carries `verificationMatrix`, it leads — one row
 * per signal with its status, the bounded summary as the headline and the
 * fixed limitation. No score, no weighted point, no overall verdict.
 */
import React from "react";
import { View } from "react-native";
import {
  storedBytesVerificationRow,
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  VERIFICATION_STATUS_LABELS,
  type BasicVerification,
  type ComponentVerificationState,
  type VerificationStatus,
} from "@proovra/shared";

import { useOptionalLocale } from "../locale-context";
import { otsBadgeLabel, otsCard } from "../product/ots-anchoring";

import type { VerifyMatrixView, VerifyWebTone } from "../product/public-verify";
import { ProovraBadge, ProovraCard, ProovraSection, ProovraText } from "./index";

const MATRIX_TONE: Record<VerifyWebTone, "verified" | "pending" | "risk" | "info" | "neutral"> = {
  success: "verified",
  warning: "pending",
  danger: "risk",
  info: "info",
  neutral: "neutral",
};

function MatrixSection({ matrix }: { matrix: VerifyMatrixView }) {
  const rtl = useOptionalLocale() === "ar";
  return (
    <ProovraSection title="Verification matrix">
      <ProovraCard testID="basic-verification-matrix">
        <ProovraText variant="bodySm" weight="semibold" testID="basic-verification-headline">{matrix.summary}</ProovraText>
        {matrix.rows.map((r) => (
          <View key={r.key} style={{ paddingVertical: 10, gap: 6 }} accessibilityLabel={`${r.label}: ${r.statusLabel ?? VERIFICATION_STATUS_LABELS[r.status as VerificationStatus] ?? r.status}. ${r.statement}`}>
            <View style={{ flexDirection: rtl ? "row-reverse" : "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <ProovraText weight="semibold">{r.label}</ProovraText>
              <ProovraBadge label={r.statusLabel ?? VERIFICATION_STATUS_LABELS[r.status as VerificationStatus] ?? r.status} tone={MATRIX_TONE[r.tone]} />
            </View>
            {r.statement ? <ProovraText variant="bodySm">{r.statement}</ProovraText> : null}
          </View>
        ))}
        {matrix.summary.includes(matrix.limitation) ? null : <ProovraText variant="label">{matrix.limitation}</ProovraText>}
      </ProovraCard>
    </ProovraSection>
  );
}

const LABEL: Record<ComponentVerificationState, string> = {
  verified: "Verified",
  pending: "Pending",
  failed: "Failed",
  not_issued: "Not issued",
  not_checked: "Not checked",
};
const TONE: Record<ComponentVerificationState, "verified" | "pending" | "risk" | "neutral"> = {
  verified: "verified",
  pending: "pending",
  failed: "risk",
  not_issued: "neutral",
  not_checked: "neutral",
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function Row({
  label,
  state,
  detail,
  badge,
  tone,
  testID,
  children,
}: {
  label: string;
  state: ComponentVerificationState;
  detail: string;
  badge?: string;
  tone?: "verified" | "pending" | "risk" | "neutral";
  testID?: string;
  children?: React.ReactNode;
}) {
  // Arabic reads right to left: the label leads from the right edge.
  const rtl = useOptionalLocale() === "ar";
  return (
    <View testID={testID} style={{ paddingVertical: 10, gap: 6 }} accessibilityLabel={`${label}: ${badge ?? LABEL[state]}. ${detail}`}>
      <View style={{ flexDirection: rtl ? "row-reverse" : "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <ProovraText weight="semibold">{label}</ProovraText>
        <ProovraBadge label={badge ?? LABEL[state]} tone={tone ?? TONE[state]} />
      </View>
      <ProovraText variant="bodySm">{detail}</ProovraText>
      {children}
    </View>
  );
}

/**
 * THE BITCOIN ANCHORING CARD (2026-10-13) — the state the server resolved
 * (`anchoring.otsState`), in the active locale's words. A reply without it
 * reads as Unavailable; nothing here re-derives the state.
 */
function AnchoringRow({ anchoring }: { anchoring: BasicVerification["anchoring"] }) {
  const locale = useOptionalLocale();
  const card = otsCard({ ...anchoring, state: (anchoring as { otsState?: unknown }).otsState }, locale, fmt);
  const shown = card.facts.filter((f) => f.key === "blockHeight" || f.key === "txid" || f.key === "anchoredAt");
  return (
    <Row label={card.title} state={anchoring.state} detail={card.sentence} badge={otsBadgeLabel(card)} tone={card.badgeTone} testID={`basic-verification-ots-${card.state}`}>
      {shown.map((f) => (
        <ProovraText key={f.key} variant="label" mono={f.mono} selectable>{`${f.label}: ${f.value}`}</ProovraText>
      ))}
    </Row>
  );
}

/**
 * ET-PKG-02: a seal key found only inside a package vouches for nothing, so the
 * sentence names what PROOVRA recorded for the package it issued — or says that
 * nothing was recorded. Older API payloads lack the fields (undefined).
 */
function packageCheck(p: {
  sealed: boolean;
  packageSha256?: string | null;
  sealKeyFingerprint?: string | null;
}): string {
  const digest = p.packageSha256
    ? ` The package file PROOVRA issued has SHA-256 ${p.packageSha256}.`
    : "";
  if (!p.sealed) return digest;
  return p.sealKeyFingerprint
    ? `${digest} It is sealed: every file, including the report, is bound by one signature, made by the key whose fingerprint is ${p.sealKeyFingerprint} — compare it with signingKeyFingerprint in the package's package-seal.sig.`
    : `${digest} It is sealed by a key carried inside the package; PROOVRA did not record that key for this package, so the seal alone does not show the package came from PROOVRA.`;
}

export function BasicVerificationView({ data, matrix = null }: { data: BasicVerification; matrix?: VerifyMatrixView | null }) {
  const o = data.original;
  return (
    <View style={{ gap: 12 }}>
      {matrix ? <MatrixSection matrix={matrix} /> : null}
      <ProovraSection title="Original evidence">
        <ProovraCard>
          {/* UC-TRUST-005 — the headline incorporates the stored bytes. */}
          {data.verdict ? <ProovraText variant="bodySm">{data.verdict.label}</ProovraText> : null}
          <Row
            label="Integrity"
            state={o.state}
            detail={
              o.state === "verified"
                ? "The signed fingerprint matches the recorded digest, the signature is valid, and the custody chain is intact."
                : o.state === "failed"
                  ? data.storedBytes && (data.storedBytes.checkStatus === "MISMATCH" || data.storedBytes.state === "failed")
                    ? "The stored original does not match the digest in the signed fingerprint, or it is no longer available at its recorded version."
                    : "At least one integrity check did not pass."
                  : "The integrity checks could not all be performed."
            }
          />
          {/* ET-SM-07 — the stored file is a separate statement, with its own date. */}
          {data.storedBytes ? <Row {...storedBytesVerificationRow(data.storedBytes)} /> : null}
          <Row
            label="Trusted timestamp (RFC 3161)"
            state={data.timestamp.state}
            detail={
              data.timestamp.state === "verified"
                ? `A trusted timestamp was issued (${fmt(data.timestamp.tokenTimeUtc)}). PROOVRA validated the authority's signature and certificate chain when it was issued, and the token certifies the recorded digest. ${TSA_VALIDATED_QUALIFICATION_STATEMENT}`
                : data.timestamp.state === "not_checked" && data.timestamp.basis === "TOKEN_RECORDED_NOT_VALIDATED"
                  ? `A timestamp token was recorded (${fmt(data.timestamp.tokenTimeUtc)}) before PROOVRA validated timestamp tokens, and it has not been validated since. It is not presented as a trusted timestamp.`
                  : data.timestamp.state === "not_checked"
                ? data.timestamp.basis === "TOKEN_RECORDED_IMPRINT_NOT_COMPARED"
                  ? `A timestamp token was issued (${fmt(data.timestamp.tokenTimeUtc)}). Its imprint was not stored with this record, so it could not be compared here — this is not a mismatch. The authority's signature on the token is not validated here.`
                  : `A timestamp token was issued (${fmt(data.timestamp.tokenTimeUtc)}) and its imprint matches the recorded digest. The authority's signature on the token is not validated here.`
                : data.timestamp.state === "failed"
                  ? "The trusted timestamp did not validate: either none was obtained when this record was finalized, or its imprint does not match the recorded digest."
                  : data.timestamp.state === "pending"
                    ? "The timestamp has not been completed yet."
                    : "No trusted timestamp was issued for this record."
            }
          />
          <AnchoringRow anchoring={data.anchoring} />
          {/* UC-PROV-001 — the server clock at record creation is never a device-declared capture time. */}
          <ProovraText variant="bodySm">Server received at (PROOVRA server clock): {fmt(o.serverReceivedAtUtc ?? o.capturedAtUtcDeclared)}</ProovraText>
          <ProovraText variant="bodySm">
            {o.deviceDeclaredCaptureAtUtc
              ? `Device-declared capture time (reported by the capture client, not proven): ${fmt(o.deviceDeclaredCaptureAtUtc)}`
              : "Capture time not available"}
          </ProovraText>
          <ProovraText variant="bodySm">Finalized and signed (server): {fmt(o.finalizedAtUtc)}</ProovraText>
          <ProovraText variant="bodySm" mono selectable>
            SHA-256: {o.fileSha256 ?? "—"}
          </ProovraText>
        </ProovraCard>
      </ProovraSection>
      <ProovraSection title="Issued materials">
        <ProovraCard>
          <Row
            label="Report"
            state={data.report.issued ? "verified" : "not_issued"}
            badge={data.report.issued ? "Issued" : undefined}
            detail={
              data.report.issued
                ? `Version ${data.report.latestVersion} issued ${fmt(data.report.issuedAtUtc)}.`
                : "No report has been issued for this record."
            }
          />
          <Row
            label="Verification package"
            state={data.package.issued ? "verified" : "not_issued"}
            badge={data.package.issued ? "Issued" : undefined}
            detail={
              data.package.issued
                ? `Certifies report version ${data.package.certifiesReportVersion}; assembled ${fmt(data.package.assembledAtUtc)}.${packageCheck(data.package)}`
                : data.package.latestReportLacksPackage
                  ? "The latest report has no verification package yet."
                  : "No verification package has been issued for this record."
            }
          />
          <ProovraText variant="bodySm">
            “Issued” means the document exists and its digest is recorded. Its contents are available only to people the owner authorizes.
          </ProovraText>
        </ProovraCard>
      </ProovraSection>
    </View>
  );
}
