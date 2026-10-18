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
  OTS_ANCHORING_COPY,
  readOtsAnchoringView,
  storedBytesVerificationRow,
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  VERIFICATION_STATUS_LABELS,
  type BasicVerification,
  type ComponentVerificationState,
  type VerificationMatrix,
  type VerificationStatus,
} from "@proovra/shared";

import { Row, fmt } from "../_shared/verify-ui";
import { otsMatrixRowPresentation } from "./VerifyMatrixPanels";

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

/** The row tone for a matrix status; the badge always states the status word. */
const MATRIX_ROW_STATE: Record<VerificationStatus, ComponentVerificationState> = {
  VERIFIED: "verified",
  FAILED: "failed",
  NOT_CHECKED: "not_checked",
  NOT_APPLICABLE: "not_issued",
  UNAVAILABLE: "not_issued",
};

/**
 * THE verification matrix (2026-10-08): the bounded summary, one row per
 * signal with its one status word, and the fixed limitation. Rendered only
 * when the API sent a matrix (an API deployed before it did not).
 */
export function VerificationMatrixSection({ matrix }: { matrix: VerificationMatrix }) {
  const limitation = matrix.limitation.trim();
  const summary = matrix.summary.trim();
  const sentence = limitation && summary.endsWith(limitation) ? summary.slice(0, summary.length - limitation.length).trim() : summary;
  return (
    <section
      aria-labelledby="verify-matrix"
      data-testid="verify-matrix"
      style={{ marginBottom: 16, background: "#fff", borderRadius: 16, padding: "8px 20px 16px", border: "1px solid rgba(15,23,42,0.08)" }}
    >
      <h2 id="verify-matrix" style={{ fontSize: 17, margin: "14px 0 4px" }}>Verification matrix</h2>
      <p data-testid="verify-matrix-summary" style={{ margin: "6px 0 10px", fontWeight: 600, color: "#0f172a" }}>
        {sentence}
      </p>
      {matrix.rows.map((row) => {
        const ots = otsMatrixRowPresentation(row);
        return (
          <Row
            key={row.key}
            testId={`verify-matrix-row-${row.key}`}
            label={row.label}
            state={MATRIX_ROW_STATE[row.status]}
            badge={ots ? ots.badge : (row.statusLabel ?? VERIFICATION_STATUS_LABELS[row.status])}
            tone={ots?.tone}
            detail={row.statement}
          />
        );
      })}
      <p data-testid="verify-matrix-limitation" style={{ fontSize: 13, color: "#64748b", margin: "12px 0 0" }}>
        {matrix.limitation}
      </p>
    </section>
  );
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
export type VerifyLinkInfo = { kind: "SHARE_TOKEN" | "LEGACY_RECORD_ID" | "CANONICAL"; expiresAtUtc: string | null };

/**
 * CANONICAL VERIFICATION (owner decision 2026-10-14) — the verification-safe
 * facts the canonical page adds: the permanent reference, the signing key
 * reference, the preservation state and the page's stated limitations.
 */
export type CanonicalVerificationFacts = {
  reference: string | null;
  status: "AVAILABLE";
  issuedAtUtc: string | null;
  signature: { keyId: string | null; keyVersion: number | null; keyFingerprintSha256: string | null };
  preservation: { objectLockMode: string | null; retainUntilUtc: string | null };
  lastUpdatedAtUtc: string | null;
  limitations: string[];
  /** When this page was checked (the API's request time). */
  checkedAtUtc?: string | null;
  /** The disclosure decision the API applied (2026-10-18: the record's disclosure policy). */
  disclosure?: {
    mode?: "VERIFICATION_ONLY" | "CONTENT_PREVIEW" | null;
    recordedLocation?: boolean | null;
    source?: string | null;
    originalDownload?: boolean | null;
    withheldStatement?: string | null;
  } | null;
};

/** A canonical reference the page cannot show as an active record — said truthfully. */
export type CanonicalVerificationState =
  | "PURGED"
  | "WITHDRAWN"
  | "TEMPORARILY_UNAVAILABLE"
  | "RETAINED"
  | "LEGACY_LINK_RETIRED";

const CANONICAL_STATE_COPY: Record<CanonicalVerificationState, { title: string; body: string }> = {
  PURGED: {
    title: "Record permanently deleted",
    body: "This record was permanently deleted after its retention ended. This page remains as a minimal record that it existed; the evidence and its artifacts are no longer held, so they cannot be verified here.",
  },
  WITHDRAWN: {
    title: "Verification page withdrawn",
    body: "This verification page was withdrawn following a legal, privacy or security action. Its reference is preserved and will never point to another record.",
  },
  TEMPORARILY_UNAVAILABLE: {
    title: "Temporarily unavailable",
    body: "This verification page is temporarily unavailable. Try again later.",
  },
  RETAINED: {
    title: "Record retained",
    body: "The record's owner has removed it from active use. It remains preserved under its retention protection and is no longer shown as an active record.",
  },
  LEGACY_LINK_RETIRED: {
    title: "This link format has been retired",
    body: "Use the verification reference (pvr_…) or the QR code printed in the current report, or ask the record's owner for its verification link.",
  },
};

export function CanonicalVerificationStateView({ state }: { state: CanonicalVerificationState }) {
  const copy = CANONICAL_STATE_COPY[state];
  return (
    <main
      className="page verify-enterprise-font"
      style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px 64px" }}
      data-verify-canonical-state={state}
    >
      <h1 style={{ fontSize: 26, lineHeight: 1.25, margin: "0 0 8px" }}>{copy.title}</h1>
      <p style={{ color: "#475569", margin: "0 0 20px" }}>{copy.body}</p>
    </main>
  );
}

function CanonicalFactsSection({ canonical }: { canonical: CanonicalVerificationFacts }) {
  return (
    <section
      aria-labelledby="verify-canonical"
      data-verify-canonical
      style={{ marginTop: 16, background: "#fff", borderRadius: 16, padding: "8px 20px 16px", border: "1px solid rgba(15,23,42,0.08)" }}
    >
      <h2 id="verify-canonical" style={{ fontSize: 17, margin: "14px 0 4px" }}>Verification reference</h2>
      <div style={{ fontSize: 14, color: "#334155", overflowWrap: "anywhere" }}>
        {canonical.reference ? (
          <div>
            Reference: <code data-verify-canonical-reference>{canonical.reference}</code>
          </div>
        ) : null}
        {canonical.issuedAtUtc ? <div>Issued: {fmt(canonical.issuedAtUtc)}</div> : null}
        {canonical.lastUpdatedAtUtc ? <div>Latest report issued: {fmt(canonical.lastUpdatedAtUtc)}</div> : null}
        {canonical.signature.keyId ? (
          <div>
            Record signing key: <code>{canonical.signature.keyId}</code>
            {canonical.signature.keyVersion != null ? " (version " + canonical.signature.keyVersion + ")" : ""}
          </div>
        ) : null}
        {canonical.signature.keyFingerprintSha256 ? (
          <div>
            Signing key fingerprint (SHA-256): <code>{canonical.signature.keyFingerprintSha256}</code>
          </div>
        ) : null}
        <div data-verify-canonical-preservation>
          Storage protection:{" "}
          {canonical.preservation.objectLockMode
            ? `Object Lock (${canonical.preservation.objectLockMode.toLowerCase()})${canonical.preservation.retainUntilUtc ? ` until ${fmt(canonical.preservation.retainUntilUtc)}` : ""}`
            : "Not recorded for this record"}
        </div>
      </div>
      <ul style={{ margin: "12px 0 0", paddingLeft: 18, fontSize: 13, color: "#475569" }} data-verify-canonical-limitations>
        {canonical.limitations.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

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
        ? `This is an older link that uses the record's ID. It stops working on ${until}. Use the record's verification reference on this page, or ask its owner for a new link, before then.`
        : `This verification link stops working on ${until}.`}
    </p>
  );
}

export default function BasicVerificationView({
  data,
  link,
  matrix,
  canonical,
}: {
  data: BasicVerification;
  link?: VerifyLinkInfo | null;
  /** THE verification matrix from the API; null/absent from an older API. */
  matrix?: VerificationMatrix | null;
  /** The canonical page's extra verification-safe facts, when opened by reference. */
  canonical?: CanonicalVerificationFacts | null;
}) {
  const packageSealCheck = matrix?.rows.find((r) => r.key === "package_signature")?.status ?? null;
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
      : data.timestamp.state === "not_checked" && data.timestamp.basis === "TOKEN_OBTAINED_NOT_VALIDATED"
        ? "A timestamp token was obtained, but it could not be validated because no timestamp trust anchor was available. It is not presented as a trusted timestamp."
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
  // (2026-10-13) Bitcoin anchoring: the server's state (`otsState`), read —
  // never derived — and stated in the one vocabulary with one sentence.
  // The verification key is the server's (`otsVerification`); a CHAIN_* key is
  // believed only with its coherent chain fact. Only CHAIN_VERIFIED is green.
  const ots = readOtsAnchoringView({
    ...data.anchoring,
    state: data.anchoring.otsState,
    verification: data.anchoring.otsVerification,
  });
  const otsFacts = OTS_ANCHORING_COPY.en.facts;
  const otsDetail = (
    <>
      {ots.secondaryStatus ? (
        <span data-verify-ots-secondary style={{ display: "block", fontWeight: 600 }}>
          {ots.secondaryStatus}
        </span>
      ) : null}
      {ots.sentence}
      {ots.failureLabel ? <> {ots.failureLabel}</> : null}
      {ots.state === "ANCHORED" && ots.bitcoinBlockHeight != null ? (
        <span data-verify-ots-fact="block-height" style={{ display: "block" }}>
          {otsFacts.blockHeight}: {ots.bitcoinBlockHeight}
        </span>
      ) : null}
      {ots.bitcoinTxid ? (
        <span data-verify-ots-fact="txid" style={{ display: "block" }}>
          {otsFacts.txid}: <code>{ots.bitcoinTxid}</code>
        </span>
      ) : null}
      {ots.anchoredAtUtc ? (
        <span data-verify-ots-fact="anchored-at" style={{ display: "block" }}>
          {otsFacts.anchoredAt}: {fmt(ots.anchoredAtUtc)}
        </span>
      ) : null}
      {ots.chain?.blockHash ? (
        <span data-verify-ots-fact="block-hash" style={{ display: "block" }}>
          {otsFacts.blockHash}: <code>{ots.chain.blockHash}</code>
        </span>
      ) : null}
      {ots.chain?.confirmations != null ? (
        <span data-verify-ots-fact="confirmations" style={{ display: "block" }}>
          {otsFacts.confirmations}: {ots.chain.confirmations}
          {ots.chain.minConfirmations != null ? ` (minimum ${ots.chain.minConfirmations})` : ""}
        </span>
      ) : null}
      {ots.chain?.checkedAtUtc ? (
        <span data-verify-ots-fact="checked-at" style={{ display: "block" }}>
          {otsFacts.checkedAt}: {fmt(ots.chain.checkedAtUtc)}
        </span>
      ) : null}
    </>
  );

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

      {matrix ? <VerificationMatrixSection matrix={matrix} /> : null}

      {canonical ? <CanonicalFactsSection canonical={canonical} /> : null}

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
        <div data-verify-ots-state={ots.state} data-verify-ots-verification={ots.verification} data-verify-ots-tone={ots.tone}>
          <Row
            label={ots.title}
            state={data.anchoring.state}
            detail={otsDetail}
            badge={ots.tone === "success" ? `✓ ${ots.status}` : ots.status}
            tone={ots.tone}
          />
        </div>
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
          // ONE SEAL AUTHORITY: the matrix's package_signature row. An issued
          // package whose seal PROOVRA did not check is never shown as verified.
          state={data.package.issued ? (packageSealCheck === "NOT_CHECKED" ? "not_checked" : "verified") : "not_issued"}
          badge={data.package.issued ? "Issued" : undefined}
          detail={
            data.package.issued
              ? `Certifies report version ${data.package.certifiesReportVersion}; assembled ${fmt(data.package.assembledAtUtc)}.${packageCheck(data.package)}${packageSealCheck === "NOT_CHECKED" ? " PROOVRA did not check this seal against a registered PROOVRA key; check it with the package's README." : ""}`
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
