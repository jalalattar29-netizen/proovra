/**
 * BASIC PUBLIC VERIFICATION — native (Decision B, 2026-09-29).
 *
 * Parity with the web `BasicVerificationView`. Rendered when the server
 * answers `tier: "BASIC"`: what the checks established about the original
 * evidence, the real chronology, and whether a report / package has been
 * ISSUED. No title, file name, case, person, preview or download.
 */
import React from "react";
import { View } from "react-native";
import type { BasicVerification, ComponentVerificationState } from "@proovra/shared";

import { ProovraBadge, ProovraCard, ProovraSection, ProovraText } from "./index";

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

function Row({ label, state, detail, badge }: { label: string; state: ComponentVerificationState; detail: string; badge?: string }) {
  return (
    <View style={{ paddingVertical: 10, gap: 6 }} accessibilityLabel={`${label}: ${badge ?? LABEL[state]}. ${detail}`}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <ProovraText weight="semibold">{label}</ProovraText>
        <ProovraBadge label={badge ?? LABEL[state]} tone={TONE[state]} />
      </View>
      <ProovraText variant="bodySm">{detail}</ProovraText>
    </View>
  );
}

export function BasicVerificationView({ data }: { data: BasicVerification }) {
  const o = data.original;
  return (
    <View style={{ gap: 12 }}>
      <ProovraSection title="Original evidence">
        <ProovraCard>
          <Row
            label="Integrity"
            state={o.state}
            detail={
              o.state === "verified"
                ? "The signed fingerprint matches the recorded digest, the signature is valid, and the custody chain is intact."
                : o.state === "failed"
                  ? "At least one integrity check did not pass."
                  : "The integrity checks could not all be performed."
            }
          />
          <Row
            label="Trusted timestamp (RFC 3161)"
            state={data.timestamp.state}
            detail={
              data.timestamp.state === "not_checked"
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
          <Row
            label="Bitcoin anchoring (OpenTimestamps)"
            state={data.anchoring.state}
            detail={
              data.anchoring.state === "verified"
                ? `Confirmed ${fmt(data.anchoring.anchoredAtUtc)} — possibly later than any report.`
                : data.anchoring.state === "not_checked"
                  ? data.anchoring.basis === "ANCHOR_RECORDED_CHECK_NOT_RECORDED"
                    ? `Recorded as anchored (${fmt(data.anchoring.anchoredAtUtc)}) before checks were recorded. The proof is kept; neither its structure nor the Bitcoin chain has been checked here.`
                    : `The proof carries a Bitcoin block attestation for this record (${fmt(data.anchoring.anchoredAtUtc)}). The Bitcoin chain itself was not checked here.`
                : data.anchoring.state === "pending"
                  ? "Submitted; confirmation has not completed yet."
                  : data.anchoring.state === "failed"
                    ? "Anchoring did not complete."
                    : "No anchoring proof exists for this record."
            }
          />
          <ProovraText variant="bodySm">Captured (declared by device): {fmt(o.capturedAtUtcDeclared)}</ProovraText>
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
                ? `Certifies report version ${data.package.certifiesReportVersion}; assembled ${fmt(data.package.assembledAtUtc)}.`
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
