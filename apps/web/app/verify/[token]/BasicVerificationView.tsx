"use client";

/**
 * BASIC PUBLIC VERIFICATION (Decision B, 2026-09-29).
 *
 * Rendered when the server answers `tier: "BASIC"` — the owner's subscription
 * does not currently include the rich view, or never did. It states exactly
 * what the checks established and nothing more: no title, file name, case,
 * person, preview or download. Every component reads one vocabulary
 * (verified / pending / failed / not issued / not checked), and a report or
 * package is described as issued or not issued — never as verified when it
 * does not exist.
 */
import {
  storedBytesVerificationRow,
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  type BasicVerification,
} from "@proovra/shared";

import { Row, fmt } from "../_shared/verify-ui";

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

/**
 * ET-SM-07 — the stored-file recheck as a standalone notice (the rich view
 * shows it above its verdicts). Same row, same words, as the basic view.
 */
export function StoredBytesNotice({ integrity }: { integrity: NonNullable<BasicVerification["storedBytes"]> }) {
  return (
    <div
      data-verify-stored-bytes={integrity.state}
      style={{
        background: "#fff",
        borderRadius: 16,
        padding: "0 20px",
        marginBottom: 16,
        border: "1px solid rgba(15,23,42,0.08)",
      }}
    >
      <Row {...storedBytesVerificationRow(integrity)} />
    </div>
  );
}

/** What the Verify answer says about the link that was used (ET-PKG-07). */
export type VerifyLinkInfo = { kind: "SHARE_TOKEN" | "LEGACY_RECORD_ID"; expiresAtUtc: string | null };

/**
 * ET-PKG-07 — a LEGACY record-id link says when it stops working, so whoever
 * holds it can ask the owner for a share link before it does. A share link
 * that expires says when, too. Nothing is shown for a link with no end date.
 */
export function VerifyLinkNotice({ link }: { link: VerifyLinkInfo | null | undefined }) {
  if (!link || !link.expiresAtUtc) return null;
  const until = fmt(link.expiresAtUtc);
  return (
    <p
      data-verify-link-kind={link.kind}
      style={{
        margin: "0 0 16px",
        padding: "10px 14px",
        borderRadius: 12,
        fontSize: 14,
        color: "#7a5a12",
        background: "rgba(138,106,47,0.10)",
      }}
    >
      {link.kind === "LEGACY_RECORD_ID"
        ? `This is an older link that uses the record's ID. It stops working on ${until}. Ask the record's owner for a new verification link before then.`
        : `This verification link stops working on ${until}.`}
    </p>
  );
}

export default function BasicVerificationView({
  data,
  link,
}: {
  data: BasicVerification;
  link?: VerifyLinkInfo | null;
}) {
  const o = data.original;
  const originalDetail =
    o.state === "verified"
      ? // ET-PKG-06 — name what was checked: PROOVRA's records, not the stored bytes.
        "PROOVRA's signed fingerprint matches the digest recorded at finalization, the signature over it is valid, and the recorded custody chain is intact. These checks are made over PROOVRA's records; the stored original is not re-read on this page — see the stored file recheck below, and compare the SHA-256 with your own copy."
      : o.state === "failed"
        ? data.storedBytes && (data.storedBytes.checkStatus === "MISMATCH" || data.storedBytes.state === "failed")
          ? "The stored original does not match the digest in the signed fingerprint, or it is no longer available at its recorded version. Do not rely on this record until it has been investigated."
          : o.checks.digestColumnsMatchSignedFingerprint === false
            ? "The digest recorded for the file does not match the digest in the signed fingerprint."
            : "At least one integrity check did not pass."
        : "The integrity checks could not all be performed.";
  // (2026-09-29) Each "not checked" names the check that was not performed.
  const tsaDetail =
    data.timestamp.state === "verified"
      ? `A trusted timestamp was issued (${fmt(data.timestamp.tokenTimeUtc)}). PROOVRA validated the authority's signature and certificate chain when it was issued, and the token certifies the recorded digest. ${TSA_VALIDATED_QUALIFICATION_STATEMENT}`
      : data.timestamp.state === "not_checked" && data.timestamp.basis === "TOKEN_RECORDED_NOT_VALIDATED"
        ? `A timestamp token was recorded (${fmt(data.timestamp.tokenTimeUtc)}) before PROOVRA validated timestamp tokens, and it has not been validated since. It is not presented as a trusted timestamp.`
        : data.timestamp.state === "not_checked"
      ? data.timestamp.basis === "TOKEN_RECORDED_IMPRINT_NOT_COMPARED"
        ? `A timestamp token was issued (${fmt(data.timestamp.tokenTimeUtc)}). Its imprint was not stored with this record, so it could not be compared here — this is not a mismatch. The authority's signature on the token is not validated by this page.`
        : `A timestamp token was issued (${fmt(data.timestamp.tokenTimeUtc)}) and its imprint matches the recorded digest. The authority's signature on the token is not validated by this page.`
      : data.timestamp.state === "failed"
        ? "The trusted timestamp did not validate: either none was obtained when this record was finalized, or its imprint does not match the recorded digest. A timestamp cannot be issued later for that moment."
        : data.timestamp.state === "pending"
          ? "The timestamp has not been completed yet."
          : "No trusted timestamp was issued for this record.";
  const otsDetail =
    data.anchoring.state === "verified"
      ? `Anchored in Bitcoin; confirmed ${fmt(data.anchoring.anchoredAtUtc)}. This confirmation may be later than any report issued for this record.`
      : data.anchoring.state === "not_checked"
        ? data.anchoring.basis === "ANCHOR_RECORDED_CHECK_NOT_RECORDED"
          ? `Recorded as anchored in Bitcoin (${fmt(data.anchoring.anchoredAtUtc)}) before this service recorded how anchors were checked. The proof is kept; neither its structure nor the Bitcoin chain has been checked here.`
          : `The OpenTimestamps proof carries a Bitcoin block attestation for this record (${fmt(data.anchoring.anchoredAtUtc)}). The Bitcoin chain itself was not checked by this service.`
      : data.anchoring.state === "pending"
        ? "Submitted for Bitcoin anchoring; confirmation has not completed yet."
        : data.anchoring.state === "failed"
          ? "Bitcoin anchoring did not complete."
          : "No Bitcoin anchoring proof exists for this record.";

  return (
    <main
      className="page verify-enterprise-font"
      style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px 64px" }}
      data-verify-tier="basic"
    >
      <h1 style={{ fontSize: 26, lineHeight: 1.25, margin: "0 0 8px" }}>Evidence verification</h1>
      <p style={{ color: "#475569", margin: "0 0 20px" }}>
        This page shows what the verification checks establish about the original evidence. It does
        not show the evidence itself or any document about it.
      </p>

      <VerifyLinkNotice link={link} />

      <section aria-labelledby="verify-original" style={{ background: "#fff", borderRadius: 16, padding: "8px 20px 16px", border: "1px solid rgba(15,23,42,0.08)" }}>
        <h2 id="verify-original" style={{ fontSize: 17, margin: "14px 0 4px" }}>Original evidence</h2>
        {/* UC-TRUST-005 — the headline incorporates the stored bytes. */}
        {data.verdict ? (
          <p data-verify-verdict={data.verdict.state} style={{ margin: "6px 0 10px", fontWeight: 600, color: data.verdict.state === "failed" ? "#b91c1c" : "#0f172a" }}>
            {data.verdict.label}
          </p>
        ) : null}
        <Row label="Integrity" state={o.state} detail={originalDetail} />
        {/* ET-SM-07 — the stored file is a separate statement, with its own date. */}
        {data.storedBytes ? (
          <div data-verify-stored-bytes={data.storedBytes.state}>
            <Row {...storedBytesVerificationRow(data.storedBytes)} />
          </div>
        ) : null}
        <Row label="Trusted timestamp (RFC 3161)" state={data.timestamp.state} detail={tsaDetail} />
        <Row label="Bitcoin anchoring (OpenTimestamps)" state={data.anchoring.state} detail={otsDetail} />
        <div style={{ paddingTop: 14, borderTop: "1px solid rgba(15,23,42,0.08)", fontSize: 14, color: "#334155" }}>
          {/* UC-PROV-001 — the server clock at record creation is never a device-declared capture time. */}
          <div data-verify-time="server-received">Server received at (PROOVRA server clock): {fmt(o.serverReceivedAtUtc ?? o.capturedAtUtcDeclared)}</div>
          <div data-verify-time="capture">
            {o.deviceDeclaredCaptureAtUtc
              ? <>Device-declared capture time (reported by the capture client, not proven): {fmt(o.deviceDeclaredCaptureAtUtc)}</>
              : <>Capture time not available</>}
          </div>
          <div>Finalized and signed (server): {fmt(o.finalizedAtUtc)}</div>
          <div style={{ marginTop: 8, overflowWrap: "anywhere" }}>
            SHA-256 of the original: <code>{o.fileSha256 ?? "—"}</code>
          </div>
          <div style={{ overflowWrap: "anywhere" }}>
            Signed fingerprint hash: <code>{o.fingerprintHash ?? "—"}</code>
          </div>
        </div>
      </section>

      <section aria-labelledby="verify-issued" style={{ marginTop: 16, background: "#fff", borderRadius: 16, padding: "8px 20px 16px", border: "1px solid rgba(15,23,42,0.08)" }}>
        <h2 id="verify-issued" style={{ fontSize: 17, margin: "14px 0 4px" }}>Issued materials</h2>
        <Row
          label="Report"
          state={data.report.issued ? "verified" : "not_issued"}
          badge={data.report.issued ? "Issued" : undefined}
          detail={
            data.report.issued
              ? `Version ${data.report.latestVersion} issued ${fmt(data.report.issuedAtUtc)}${data.report.sha256 ? `; its SHA-256 is ${data.report.sha256}, so a copy can be checked.` : "."}`
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
        <p style={{ fontSize: 13, color: "#64748b", margin: "12px 0 0" }}>
          “Issued” means the document exists and its digest is recorded. This page does not check or
          show its contents; those are available only to people the evidence owner authorizes.
        </p>
      </section>

      <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 16 }}>Checked {fmt(data.checkedAtUtc)}</p>
    </main>
  );
}
