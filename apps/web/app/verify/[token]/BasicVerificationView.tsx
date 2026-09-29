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
import type { BasicVerification, ComponentVerificationState } from "@proovra/shared";

const STATE_LABEL: Record<ComponentVerificationState, string> = {
  verified: "Verified",
  pending: "Pending",
  failed: "Failed",
  not_issued: "Not issued",
  not_checked: "Not checked",
};

const STATE_TONE: Record<ComponentVerificationState, { fg: string; bg: string }> = {
  verified: { fg: "#0b5d3b", bg: "rgba(11,93,59,0.08)" },
  pending: { fg: "#7a5a12", bg: "rgba(138,106,47,0.10)" },
  failed: { fg: "#9b1c1c", bg: "rgba(155,28,28,0.08)" },
  not_issued: { fg: "#4b5563", bg: "rgba(75,85,99,0.08)" },
  not_checked: { fg: "#4b5563", bg: "rgba(75,85,99,0.08)" },
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function Row(props: { label: string; state: ComponentVerificationState; detail: string; badge?: string }) {
  const tone = STATE_TONE[props.state];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 12,
        padding: "14px 0",
        borderTop: "1px solid rgba(15,23,42,0.08)",
        alignItems: "start",
      }}
    >
      <div>
        <div style={{ fontWeight: 600 }}>{props.label}</div>
        <div style={{ fontSize: 14, color: "#475569", marginTop: 4, overflowWrap: "anywhere" }}>{props.detail}</div>
      </div>
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: tone.fg,
          background: tone.bg,
          borderRadius: 999,
          padding: "4px 10px",
          whiteSpace: "nowrap",
        }}
        aria-label={`${props.label}: ${props.badge ?? STATE_LABEL[props.state]}`}
      >
        {props.badge ?? STATE_LABEL[props.state]}
      </span>
    </div>
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

export default function BasicVerificationView({ data }: { data: BasicVerification }) {
  const o = data.original;
  const originalDetail =
    o.state === "verified"
      ? "The signed fingerprint matches the recorded digest, the signature is valid, and the custody chain is intact."
      : o.state === "failed"
        ? "At least one integrity check did not pass."
        : "The integrity checks could not all be performed.";
  // (2026-09-29) Each "not checked" names the check that was not performed.
  const tsaDetail =
    data.timestamp.state === "verified"
      ? `A trusted timestamp was issued (${fmt(data.timestamp.tokenTimeUtc)}). PROOVRA validated the authority's signature and certificate chain when it was issued, and the token certifies the recorded digest.`
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

      <section aria-labelledby="verify-original" style={{ background: "#fff", borderRadius: 16, padding: "8px 20px 16px", border: "1px solid rgba(15,23,42,0.08)" }}>
        <h2 id="verify-original" style={{ fontSize: 17, margin: "14px 0 4px" }}>Original evidence</h2>
        <Row label="Integrity" state={o.state} detail={originalDetail} />
        <Row label="Trusted timestamp (RFC 3161)" state={data.timestamp.state} detail={tsaDetail} />
        <Row label="Bitcoin anchoring (OpenTimestamps)" state={data.anchoring.state} detail={otsDetail} />
        <div style={{ paddingTop: 14, borderTop: "1px solid rgba(15,23,42,0.08)", fontSize: 14, color: "#334155" }}>
          <div>Captured (declared by the capturing device): {fmt(o.capturedAtUtcDeclared)}</div>
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
