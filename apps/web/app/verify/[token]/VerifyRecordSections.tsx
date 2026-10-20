"use client";

/**
 * PUBLIC VERIFY CONVERGENCE (2026-10-18) — the record-level sections of the
 * rich Public Verify page.
 *
 * Every section here PRINTS what the API returned: the matrix rows, their
 * qualifiers, recordFacts, the disclosure decision, the package seal check,
 * trustDecisionConsistency, verificationSnapshot / liveAnchoring and the
 * aggregated access activity. Nothing re-derives a status, nothing decides
 * what to show from a policy (the API's projection already withheld what the
 * record's disclosure policy withholds), and every status is an icon AND a
 * word — never colour alone.
 */
import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import {
  isAdministrativeCustodyEventType,
  OTS_STATE_WORDS,
  OTS_VERIFICATION_WORDS,
  parseOtsState,
  parseOtsVerificationKey,
  parseVerificationQualifiers,
  readStoredTrustDecision,
  VERIFICATION_DISCLOSURE_MODE_LABELS,
  VERIFICATION_QUALIFIER_LABELS,
  VERIFICATION_STATUS_LABELS,
  type VerificationMatrixRow,
  type VerificationStatus,
} from "@proovra/shared";

import { formatDateTime } from "../../../components/verify-v2/_helpers";
import { VERIFY_BRAND, VERIFY_TYPO } from "./_verify-theme";
import type {
  ToastFn,
  VerificationPackageIntegrity,
  VerifyConsistencyReason,
  VerifyDisclosure,
  VerifyEvidenceAsset,
  VerifyLiveAnchoring,
  VerifyRecordFacts,
  VerifySnapshotSection,
  VerifyStatusCode,
  VerifyVersioning,
} from "./_verify-types";

// ---------------------------------------------------------------------------
// Status: icon + word, never colour alone
// ---------------------------------------------------------------------------

const STATUS_ICON: Readonly<Record<VerificationStatus, string>> = {
  VERIFIED: "✓",
  FAILED: "✕",
  NOT_CHECKED: "○",
  NOT_APPLICABLE: "–",
  UNAVAILABLE: "?",
};

export function statusColor(status: VerificationStatus): string {
  switch (status) {
    case "VERIFIED":
      return VERIFY_BRAND.success;
    case "FAILED":
      return VERIFY_BRAND.danger;
    // AUD-47 (2026-10-20) — NOT_CHECKED is neutral on every surface (THE shared VERIFICATION_STATUS_TONES): not checked is not a warning.
    default:
      return VERIFY_BRAND.accent;
  }
}

function isStatus(value: unknown): value is VerificationStatus {
  return typeof value === "string" && value in VERIFICATION_STATUS_LABELS;
}

/** One status, stated as an icon and its word (the server's statusLabel when it sent one). */
export function StatusMark({
  status,
  label,
  testId,
}: {
  status: VerifyStatusCode | VerificationStatus | null | undefined;
  label?: string | null;
  testId?: string;
}) {
  const s: VerificationStatus = isStatus(status) ? status : "UNAVAILABLE";
  return (
    <span
      data-testid={testId}
      data-status={s}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: statusColor(s),
        fontSize: 12,
        fontWeight: 900,
        letterSpacing: "0.02em",
        overflowWrap: "anywhere",
      }}
    >
      <span aria-hidden="true">{STATUS_ICON[s]}</span>
      <span>{label || VERIFICATION_STATUS_LABELS[s]}</span>
    </span>
  );
}

/** The qualifiers a row carries, in their shared words (they never change a status). */
export function QualifierList({ qualifiers }: { qualifiers: unknown }) {
  const list = parseVerificationQualifiers(qualifiers);
  if (list.length === 0) return null;
  return (
    <div data-verify-qualifiers style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {list.map((q) => (
        <span
          key={q}
          data-qualifier={q}
          style={{
            border: `1px solid ${VERIFY_BRAND.softLine}`,
            borderRadius: 999,
            padding: "3px 8px",
            fontSize: 11,
            fontWeight: 700,
            color: VERIFY_BRAND.ink,
          }}
        >
          {VERIFICATION_QUALIFIER_LABELS[q]}
        </span>
      ))}
    </div>
  );
}

const TONE_ICON = { danger: "✕", warning: "!", info: "i", neutral: "i" } as const;

// ---------------------------------------------------------------------------
// Hashes: wrap or truncate, always with a copy action
// ---------------------------------------------------------------------------

export function HashValue({
  value,
  label,
  addToast,
  truncate = false,
}: {
  value: string;
  label: string;
  addToast: ToastFn;
  truncate?: boolean;
}) {
  const shown = truncate && value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" }}>
      <code
        title={value}
        style={{ ...VERIFY_TYPO.hash, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", minWidth: 0 }}
      >
        {shown}
      </code>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        data-print-hide
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          addToast(`${label} copied`, "success");
        }}
        style={{
          border: `1px solid ${VERIFY_BRAND.line}`,
          background: "rgba(255,255,255,0.62)",
          color: VERIFY_BRAND.accent,
          borderRadius: 999,
          padding: "4px 10px",
          fontSize: 11,
          fontWeight: 900,
          cursor: "pointer",
        }}
      >
        Copy
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Card shell
// ---------------------------------------------------------------------------

const CARD: CSSProperties = {
  border: `1px solid ${VERIFY_BRAND.line}`,
  background: "linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(250,251,249,0.92) 100%)",
  borderRadius: 22,
  padding: "clamp(16px, 4vw, 24px)",
  display: "grid",
  gap: 14,
  minWidth: 0,
};

export function VerifyCard({
  kicker,
  title,
  children,
  testId,
  labelledBy,
  extra,
}: {
  kicker: string;
  title?: string;
  children: ReactNode;
  testId?: string;
  labelledBy?: string;
  extra?: Record<string, string | boolean | undefined>;
}) {
  const fallbackId = useId();
  const headingId = labelledBy ?? `verify-card-${fallbackId.replace(/:/g, "")}`;
  return (
    <section aria-labelledby={headingId} data-testid={testId} data-verify-card style={CARD} {...extra}>
      <div>
        <div style={{ ...VERIFY_TYPO.kicker, fontSize: 11, marginBottom: title ? 6 : 0 }} id={title ? undefined : headingId}>
          {kicker}
        </div>
        {title ? (
          <h2 id={headingId} style={{ ...VERIFY_TYPO.h3, fontSize: 20, margin: 0 }}>
            {title}
          </h2>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      style={{
        border: `1px solid ${VERIFY_BRAND.softLine}`,
        borderRadius: 16,
        padding: 14,
        display: "grid",
        gap: 6,
        minWidth: 0,
        breakInside: "avoid",
      }}
    >
      <div data-verify-label style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>
        {label}
      </div>
      <div style={{ ...VERIFY_TYPO.value, fontSize: 14, overflowWrap: "anywhere", minWidth: 0 }}>{children}</div>
    </div>
  );
}

const FACT_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
  gap: 12,
};

// ---------------------------------------------------------------------------
// Record facts (recordFacts) + the canonical reference
// ---------------------------------------------------------------------------

export function RecordFactsCard({
  facts,
  canonicalIssuedAtUtc,
  addToast,
}: {
  facts: VerifyRecordFacts;
  canonicalIssuedAtUtc: string | null;
  addToast: ToastFn;
}) {
  const identity = facts.identity ?? null;
  const withheld = identity?.disclosure === "WITHHELD";
  const withheldStatement = identity?.statement ?? null;
  const capture = identity?.captureTime ?? null;
  const atReport = identity?.atReportTime ?? null;
  const notShown = (value: string | null | undefined) =>
    value ? value : withheld && withheldStatement ? withheldStatement : "Not recorded";

  return (
    <VerifyCard kicker="Record" title="This record’s verification facts" testId="verify-record-facts">
      <div style={FACT_GRID}>
        {facts.verificationReference ? (
          <Fact label="Verification reference" testId="verify-reference">
            <span data-verify-canonical>
              <code data-verify-canonical-reference style={{ ...VERIFY_TYPO.hash, fontSize: 13 }}>
                {facts.verificationReference}
              </code>
            </span>{" "}
            <HashValue value={facts.verificationReference} label="Verification reference" addToast={addToast} truncate />
          </Fact>
        ) : null}
        {facts.recordKindLabel ? <Fact label="Record">{facts.recordKindLabel}</Fact> : null}
        <Fact label="Report issued" testId="verify-report-issued">
          {facts.reportIssuedAtUtc
            ? `${formatDateTime(facts.reportIssuedAtUtc)}${facts.reportVersion != null ? ` (v${facts.reportVersion})` : ""}`
            : "No report issued"}
        </Fact>
        <Fact label="Stored file last rechecked" testId="verify-stored-file-rechecked">
          <span style={{ display: "grid", gap: 4 }}>
            <span>{facts.storedFileLastRecheckedAtUtc ? formatDateTime(facts.storedFileLastRecheckedAtUtc) : "Not recorded"}</span>
            {facts.storedFileRecheck ? <StatusMark status={facts.storedFileRecheck} /> : null}
          </span>
        </Fact>
        {canonicalIssuedAtUtc ? <Fact label="Reference issued">{formatDateTime(canonicalIssuedAtUtc)}</Fact> : null}
        {facts.checkedAtUtc ? <Fact label="This page checked">{formatDateTime(facts.checkedAtUtc)}</Fact> : null}
      </div>

      {identity ? (
        <div data-verify-identity={identity.disclosure ?? "UNKNOWN"} style={{ display: "grid", gap: 10 }}>
          <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>Submitter identity</div>
          {withheld && withheldStatement ? (
            <div data-verify-identity-withheld style={{ ...VERIFY_TYPO.value, fontSize: 14 }}>
              {withheldStatement}
            </div>
          ) : null}
          <div style={FACT_GRID}>
            {capture ? (
              <Fact label="Identity at capture">
                <span style={{ display: "grid", gap: 4, fontWeight: 600 }}>
                  {capture.basisLabel ? <span>{capture.basisLabel}</span> : null}
                  {capture.accountLabel ? <span>{capture.accountLabel}</span> : null}
                  {capture.workspaceTypeLabel ? <span>{capture.workspaceTypeLabel}</span> : null}
                  {capture.organizationVerificationLabel ? (
                    <span>Organization verification: {capture.organizationVerificationLabel}</span>
                  ) : null}
                </span>
              </Fact>
            ) : null}
            {atReport ? (
              <Fact label={`Identity at report time${atReport.reportVersion != null ? ` (v${atReport.reportVersion})` : ""}`}>
                <span style={{ display: "grid", gap: 4, fontWeight: 600 }}>
                  <span>Identity level: {notShown(atReport.identityLevel)}</span>
                  <span>Sign-in method: {notShown(atReport.authProvider)}</span>
                </span>
              </Fact>
            ) : null}
          </div>
        </div>
      ) : null}
    </VerifyCard>
  );
}

// ---------------------------------------------------------------------------
// Disclosure notice
// ---------------------------------------------------------------------------

export function DisclosureNotice({ disclosure }: { disclosure: VerifyDisclosure }) {
  const mode = disclosure.mode === "CONTENT_PREVIEW" || disclosure.mode === "VERIFICATION_ONLY" ? disclosure.mode : null;
  if (!mode) return null;
  const withheld = disclosure.withheldStatement ?? null;
  return (
    <section
      aria-label="Disclosure"
      data-verify-disclosure={mode}
      style={{
        border: `1px solid ${VERIFY_BRAND.line}`,
        borderLeft: `5px solid ${VERIFY_BRAND.accent}`,
        background: "rgba(255,255,255,0.72)",
        borderRadius: 18,
        padding: 16,
        display: "grid",
        gap: 6,
        ...VERIFY_TYPO.small,
        fontSize: 13,
        color: VERIFY_BRAND.ink,
      }}
    >
      <div>
        <strong>Disclosure: {VERIFICATION_DISCLOSURE_MODE_LABELS[mode]}.</strong>{" "}
        {mode === "VERIFICATION_ONLY"
          ? "Every verification check is shown."
          : "Item names, roles and safe previews are shown with every verification check."}
      </div>
      {mode === "VERIFICATION_ONLY" && withheld ? (
        <div data-verify-disclosure-notice>
          Title, item names, previews, capture details and location: {withheld}
        </div>
      ) : null}
      {mode === "CONTENT_PREVIEW" && disclosure.recordedLocation !== true && withheld ? (
        <div>Recorded location: {withheld}</div>
      ) : null}
      {disclosure.originalDownload === true ? null : (
        <div>Original files are not offered on this page.</div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Safe item inventory (a VERIFICATION_ONLY answer)
// ---------------------------------------------------------------------------

function kindWord(kind: string | null | undefined): string {
  switch (kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "text":
      return "Text";
    default:
      return "Other";
  }
}

export function ItemInventoryTable({ items, addToast }: { items: VerifyEvidenceAsset[]; addToast: ToastFn }) {
  const cell: CSSProperties = {
    padding: "10px 8px",
    borderBottom: `1px solid ${VERIFY_BRAND.softLine}`,
    textAlign: "left",
    verticalAlign: "top",
    ...VERIFY_TYPO.small,
    fontSize: 13,
    color: VERIFY_BRAND.ink,
  };
  return (
    <VerifyCard kicker="Items" title="Item inventory" testId="verify-item-inventory">
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <caption style={{ ...VERIFY_TYPO.small, textAlign: "left", marginBottom: 8 }}>
            Each preserved item, by position. Item content and names are withheld; the SHA-256 lets you compare a copy you hold.
          </caption>
          <thead>
            <tr>
              <th scope="col" style={{ ...cell, width: "22%" }}>Item</th>
              <th scope="col" style={{ ...cell, width: "18%" }}>Kind</th>
              <th scope="col" style={{ ...cell, width: "20%" }}>Approx. size</th>
              <th scope="col" style={cell}>SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.id} data-verify-item={item.id}>
                <th scope="row" style={{ ...cell, fontWeight: 800 }}>
                  {item.label || `Item ${index + 1}`}
                </th>
                <td style={cell}>{kindWord(item.kind)}</td>
                <td style={cell}>{item.displaySizeLabel ?? "Not recorded"}</td>
                <td style={{ ...cell, minWidth: 0 }}>
                  {item.sha256 ? (
                    <HashValue value={item.sha256} label={`SHA-256 of ${item.label || `item ${index + 1}`}`} addToast={addToast} truncate />
                  ) : (
                    "Not recorded"
                  )}
                  {item.viewUrl ? (
                    <div>
                      <a href={item.viewUrl} target="_blank" rel="noreferrer" style={{ color: VERIFY_BRAND.accent, fontWeight: 800 }}>
                        Open preserved item
                      </a>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </VerifyCard>
  );
}

// ---------------------------------------------------------------------------
// Package integrity — the server's seal check, verbatim
// ---------------------------------------------------------------------------

export function PackageIntegrityCard({ integrity }: { integrity: Partial<VerificationPackageIntegrity> | null }) {
  const presence: Array<[string, boolean | undefined]> = integrity?.available
    ? [
        ["Package manifest", integrity.manifestPresent],
        ["Manifest signature", integrity.signedManifestPresent],
        ["Manifest digest", integrity.manifestDigestPresent],
        ["Checksum index", integrity.checksumIndexPresent],
        ["Audit export", integrity.auditExportIncluded],
        ["Custody export", integrity.custodyExportIncluded],
        ["Access export", integrity.accessExportIncluded],
      ]
    : [];
  return (
    <section
      aria-labelledby="verify-package-integrity"
      data-print-avoid-break
      data-testid="verify-package-integrity"
      style={{ ...CARD, borderLeft: `6px solid ${statusColor(isStatus(integrity?.sealCheck) ? integrity!.sealCheck! : "UNAVAILABLE")}` }}
    >
      <div>
        <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5, marginBottom: 6 }}>Verification package</div>
        <h3 id="verify-package-integrity" style={{ ...VERIFY_TYPO.h3, fontSize: 20, margin: 0 }}>
          Verification Package Integrity
        </h3>
      </div>
      {!integrity ? (
        <div style={{ ...VERIFY_TYPO.small, fontSize: 13 }}>Package integrity unavailable in this response.</div>
      ) : (
        <>
          <div style={FACT_GRID}>
            <Fact label="Package seal" testId="verify-package-seal">
              <span style={{ display: "grid", gap: 6 }}>
                <StatusMark status={integrity.sealCheck} testId="verify-package-seal-status" />
                {integrity.sealStatement ? <span style={{ fontWeight: 600 }}>{integrity.sealStatement}</span> : null}
                <QualifierList qualifiers={integrity.sealQualifiers} />
              </span>
            </Fact>
            <Fact label="Package completeness" testId="verify-package-completeness">
              <span style={{ display: "grid", gap: 6 }}>
                <StatusMark status={integrity.completenessCheck} testId="verify-package-completeness-status" />
                {integrity.completenessStatement ? <span style={{ fontWeight: 600 }}>{integrity.completenessStatement}</span> : null}
              </span>
            </Fact>
            {integrity.available && integrity.version != null ? (
              <Fact label="Package version">
                v{String(integrity.version)}
                {integrity.packageFormatVersion != null ? ` (format ${integrity.packageFormatVersion})` : ""}
              </Fact>
            ) : null}
            {integrity.generatedAtUtc ? <Fact label="Package issued">{formatDateTime(integrity.generatedAtUtc)}</Fact> : null}
          </div>
          {presence.length > 0 ? (
            <ul aria-label="Package contents" style={{ listStyle: "none", margin: 0, padding: 0, ...FACT_GRID }}>
              {presence.map(([label, present]) => (
                <li key={label} style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
                  <span aria-hidden="true">{present ? "✓" : "–"}</span> {label}: {present ? "Present" : "Not present"}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Consistency with the issued artifact (trustDecisionConsistency.reasons)
// ---------------------------------------------------------------------------

export function ConsistencyReasons({ reasons }: { reasons: VerifyConsistencyReason[] }) {
  if (reasons.length === 0) return null;
  const danger = reasons.some((r) => r.tone === "danger");
  const warning = reasons.some((r) => r.tone === "warning");
  const rail = danger ? VERIFY_BRAND.danger : warning ? VERIFY_BRAND.warning : VERIFY_BRAND.accent;
  return (
    <section
      role="status"
      aria-label="Since the issued artifact"
      data-verify-consistency={danger ? "danger" : warning ? "warning" : "info"}
      style={{
        border: `1px solid ${VERIFY_BRAND.line}`,
        borderLeft: `5px solid ${rail}`,
        background: danger ? VERIFY_BRAND.dangerSoft : warning ? VERIFY_BRAND.warningSoft : "rgba(255,255,255,0.72)",
        borderRadius: 18,
        padding: 16,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5, color: rail }}>
        {danger ? "Review required since the issued artifact" : "Since the issued artifact"}
      </div>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 8 }}>
        {reasons.map((reason, index) => {
          const tone = reason.tone === "danger" || reason.tone === "warning" ? reason.tone : "info";
          return (
            <li
              key={`${reason.code ?? "reason"}-${index}`}
              data-reason-code={reason.code ?? undefined}
              data-tone={tone}
              style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink, display: "flex", gap: 8 }}
            >
              <span aria-hidden="true" style={{ fontWeight: 900 }}>
                {TONE_ICON[tone]}
              </span>
              <span>
                <strong>
                  {tone === "danger" ? "Failed: " : tone === "warning" ? "Attention: " : "Information: "}
                  {reason.label ?? "Changed since the issued artifact"}.
                </strong>{" "}
                {reason.detail ?? ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bitcoin anchoring — ONE card: now (matrix row + ots facts), at issue, advance
// ---------------------------------------------------------------------------

export type OtsFacts = {
  bitcoinBlockHeight: number | null;
  anchoredAtUtc: string | null;
  bitcoinTxid: string | null;
  proofSha256: string | null;
  chain: { blockHash?: string | null; confirmations?: number | null; minConfirmations?: number | null; checkedAtUtc?: string | null } | null;
  sentence: string | null;
  failureLabel: string | null;
  boundary: string | null;
  statusWord: string;
};

export const ADVANCE_SENTENCES: Readonly<Record<string, string>> = {
  CHAIN_VERIFIED_SINCE_ISSUE: "Independently verified since the report was issued",
  ATTESTATION_RECORDED_SINCE_ISSUE: "Bitcoin attestation recorded since the report was issued",
  PENDING_SINCE_ISSUE: "Submitted for OpenTimestamps anchoring since the report was issued",
};

/** The anchoring stated by an issued artifact, in the shared words. */
export function anchoringAtIssueWord(snapshot: VerifySnapshotSection): string | null {
  if (!snapshot) return null;
  const key = parseOtsVerificationKey(snapshot.otsVerificationAtGeneration);
  if (key) return OTS_VERIFICATION_WORDS[key];
  return snapshot.otsStatusAtGeneration ? OTS_STATE_WORDS[parseOtsState(snapshot.otsStatusAtGeneration)] : null;
}

function snapshotIsIssued(snapshot: VerifySnapshotSection): boolean {
  return snapshot?.source === "REPORT_SNAPSHOT" || snapshot?.source === "VERIFICATION_PACKAGE_SNAPSHOT";
}

export function OtsAnchoringCard({
  row,
  facts,
  snapshot,
  liveAnchoring,
  addToast,
}: {
  row: VerificationMatrixRow | null;
  facts: OtsFacts;
  snapshot: VerifySnapshotSection;
  liveAnchoring: VerifyLiveAnchoring;
  addToast: ToastFn;
}) {
  const advance = liveAnchoring?.advance && liveAnchoring.advance !== "NONE" ? liveAnchoring.advance : null;
  const atIssue = snapshotIsIssued(snapshot) ? anchoringAtIssueWord(snapshot) : null;
  const artifact =
    snapshot?.source === "VERIFICATION_PACKAGE_SNAPSHOT"
      ? `package${snapshot.packageVersion != null ? ` v${snapshot.packageVersion}` : ""}`
      : `report${snapshot?.reportVersion != null ? ` v${snapshot.reportVersion}` : ""}`;
  return (
    <VerifyCard kicker="Bitcoin anchoring (OpenTimestamps)" title="Bitcoin anchoring" testId="verify-ots-card">
      <div style={{ display: "grid", gap: 6 }}>
        <div data-verify-ots-now>
          <span style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>Now: </span>
          {row ? <StatusMark status={row.status} label={row.statusLabel ?? null} /> : <strong>{facts.statusWord}</strong>}
        </div>
        {row ? <QualifierList qualifiers={(row as { qualifiers?: unknown }).qualifiers} /> : null}
        <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
          {row?.statement ?? facts.sentence}
          {facts.failureLabel ? ` ${facts.failureLabel}` : null}
        </div>
        {atIssue ? (
          <div data-verify-ots-at-issue style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
            At issue ({artifact}
            {snapshot?.generatedAtUtc ? `, ${formatDateTime(snapshot.generatedAtUtc)}` : ""}): {atIssue}. The issued artifact keeps what it stated.
          </div>
        ) : null}
        {advance && ADVANCE_SENTENCES[advance] ? (
          <div data-verify-ots-advance={advance} style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
            <span aria-hidden="true">i </span>
            {ADVANCE_SENTENCES[advance]}.
          </div>
        ) : null}
      </div>
      <div style={FACT_GRID}>
        {facts.bitcoinBlockHeight != null ? <Fact label="Bitcoin block height">{String(facts.bitcoinBlockHeight)}</Fact> : null}
        {facts.anchoredAtUtc ? <Fact label="Attestation recorded by PROOVRA">{formatDateTime(facts.anchoredAtUtc)}</Fact> : null}
        {facts.chain?.blockHash ? (
          <Fact label="Block hash">
            <HashValue value={facts.chain.blockHash} label="Block hash" addToast={addToast} truncate />
          </Fact>
        ) : null}
        {facts.chain?.confirmations != null ? (
          <Fact label="Confirmations">
            {facts.chain.minConfirmations != null
              ? `${facts.chain.confirmations} (minimum ${facts.chain.minConfirmations})`
              : String(facts.chain.confirmations)}
          </Fact>
        ) : null}
        {facts.chain?.checkedAtUtc ? <Fact label="Checked against Bitcoin">{formatDateTime(facts.chain.checkedAtUtc)}</Fact> : null}
        {facts.bitcoinTxid ? (
          <Fact label="Bitcoin transaction">
            <HashValue value={facts.bitcoinTxid} label="Transaction ID" addToast={addToast} truncate />
          </Fact>
        ) : null}
        {facts.proofSha256 ? (
          <Fact label="OTS proof SHA-256">
            <HashValue value={facts.proofSha256} label="OTS proof SHA-256" addToast={addToast} truncate />
          </Fact>
        ) : null}
      </div>
      {facts.boundary ? (
        <div data-verify-ots-boundary style={{ ...VERIFY_TYPO.small, fontSize: 12.5, color: VERIFY_BRAND.ink }}>
          {facts.boundary}
        </div>
      ) : null}
    </VerifyCard>
  );
}

// ---------------------------------------------------------------------------
// Report / package version history — each artifact is an issue-time snapshot
// ---------------------------------------------------------------------------

type HistoryEvent = { eventType?: string | null; atUtc?: string | null };

function after(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
}

export function ArtifactHistory({
  versioning,
  snapshot,
  liveAnchoring,
  tsaRow,
  canonicalIssuedAtUtc,
  forensicEvents,
  consistencyReasons = [],
}: {
  versioning: VerifyVersioning | null;
  snapshot: VerifySnapshotSection;
  liveAnchoring: VerifyLiveAnchoring;
  tsaRow: VerificationMatrixRow | null;
  canonicalIssuedAtUtc: string | null;
  forensicEvents: HistoryEvent[];
  /** AUD-48 — the record's consistency reasons; regressions are noted beside the artifact they contradict. */
  consistencyReasons?: ReadonlyArray<VerifyConsistencyReason>;
}) {
  const artifacts: Array<{ kind: "report" | "package"; version: number; issuedAtUtc: string | null }> = [];
  // AUD-48 (2026-10-20) — EVERY issued report and package, when the API sends
  // the history; the latest-only pair is the fallback for an older response.
  const history = (versioning?.history ?? []).filter(
    (h): h is { kind: "report" | "package"; version: number; issuedAtUtc?: string | null } =>
      (h?.kind === "report" || h?.kind === "package") && typeof h?.version === "number",
  );
  if (history.length > 0) {
    for (const h of history) artifacts.push({ kind: h.kind, version: h.version, issuedAtUtc: h.issuedAtUtc ?? null });
  } else if (typeof versioning?.latestReportVersion === "number") {
    artifacts.push({ kind: "report", version: versioning.latestReportVersion, issuedAtUtc: versioning.latestReportGeneratedAtUtc ?? null });
  }
  if (history.length === 0 && typeof versioning?.verificationPackageVersion === "number") {
    artifacts.push({
      kind: "package",
      version: versioning.verificationPackageVersion,
      issuedAtUtc: versioning.verificationPackageGeneratedAtUtc ?? null,
    });
  }
  const advance = liveAnchoring?.advance && liveAnchoring.advance !== "NONE" ? liveAnchoring.advance : null;
  const tsaValidatedLater =
    tsaRow && parseVerificationQualifiers((tsaRow as { qualifiers?: unknown }).qualifiers).includes("VALIDATED_FROM_RETAINED_TOKEN")
      ? tsaRow.measuredAtUtc ?? null
      : null;
  // AUD-48 (2026-10-20) — what the SNAPSHOT artifact itself stated about the
  // timestamp (its stored trust decision), never inferred from times. Other
  // artifacts' contents are not on this page, so nothing is said about them.
  const snapshotTimestampState =
    readStoredTrustDecision(snapshot?.trustDecisionSnapshot)?.signals.find((s) => s.key === "trusted_timestamp")?.state ?? null;
  const regressions = consistencyReasons.filter(
    (r) => r?.code === "VERIFICATION_REGRESSED" || (r?.code === "CORE_INTEGRITY_SIGNALS_CHANGED" && (r.tone === "danger" || r.tone === "warning")),
  );
  const referenceIssues = [
    ...(canonicalIssuedAtUtc ? [canonicalIssuedAtUtc] : []),
    ...forensicEvents.filter((e) => String(e.eventType ?? "").toUpperCase() === "VERIFICATION_REFERENCE_ISSUED").map((e) => e.atUtc ?? null),
  ].filter((t): t is string => Boolean(t));

  return (
    <VerifyCard kicker="Issued artifacts" title="Report and package history" testId="verify-artifact-history">
      <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
        Each report or package states what was true when it was issued, and is never rewritten. Legitimate changes since
        then are noted beside it.
      </div>
      {artifacts.length === 0 ? (
        <div style={{ ...VERIFY_TYPO.small, fontSize: 13 }}>No report or verification package has been issued for this record.</div>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 10 }}>
          {artifacts.map((a) => {
            const isSnapshot =
              (a.kind === "report" && snapshot?.source === "REPORT_SNAPSHOT" && snapshot.reportVersion === a.version) ||
              (a.kind === "package" && snapshot?.source === "VERIFICATION_PACKAGE_SNAPSHOT" && snapshot.packageVersion === a.version);
            const name = `${a.kind === "report" ? "Report" : "Verification package"} v${a.version}`;
            const notes: string[] = [];
            if (isSnapshot && advance === "CHAIN_VERIFIED_SINCE_ISSUE") {
              notes.push("The Bitcoin attestation was checked against the Bitcoin main chain after this artifact was issued.");
            }
            if (isSnapshot && advance === "ATTESTATION_RECORDED_SINCE_ISSUE") {
              notes.push("A Bitcoin attestation was recorded after this artifact was issued.");
            }
            if (
              isSnapshot &&
              tsaValidatedLater &&
              snapshotTimestampState !== null &&
              snapshotTimestampState !== "PASSED"
            ) {
              notes.push(
                `${name} states the trusted timestamp as not validated; it was validated on ${formatDateTime(tsaValidatedLater)} from the timestamp token retained at intake.`,
              );
            }
            if (isSnapshot) {
              for (const r of regressions) {
                if (r.label) notes.push(`${r.label}.`);
              }
            }
            if (referenceIssues.some((t) => after(t, a.issuedAtUtc))) {
              notes.push("The verification reference was issued after this artifact. That is an administrative event; it does not change what the artifact states.");
            }
            const atIssue = isSnapshot ? anchoringAtIssueWord(snapshot) : null;
            return (
              <li
                key={`${a.kind}-${a.version}`}
                data-verify-artifact={`${a.kind}-v${a.version}`}
                style={{ border: `1px solid ${VERIFY_BRAND.softLine}`, borderRadius: 16, padding: 14, display: "grid", gap: 6 }}
              >
                <div style={{ ...VERIFY_TYPO.value, fontSize: 14 }}>
                  {name} — issued {a.issuedAtUtc ? formatDateTime(a.issuedAtUtc) : "(time not recorded)"}
                </div>
                {atIssue ? (
                  <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
                    Stated at issue — Bitcoin anchoring: {atIssue}.
                  </div>
                ) : null}
                {notes.length > 0 ? (
                  <ul aria-label={`Changes since ${name} was issued`} style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
                    {notes.map((n) => (
                      <li key={n} style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
                        {n}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {liveAnchoring?.newerReportAvailable ? (
        <div style={{ ...VERIFY_TYPO.small, fontSize: 13 }}>A newer report is available from the record’s owner.</div>
      ) : null}
      {liveAnchoring?.newerPackageAvailable ? (
        <div style={{ ...VERIFY_TYPO.small, fontSize: 13 }}>A newer verification package is available from the record’s owner.</div>
      ) : null}
    </VerifyCard>
  );
}

// ---------------------------------------------------------------------------
// Custody: the forensic chain (grouped, paginated) and aggregated access activity
// ---------------------------------------------------------------------------

export const FORENSIC_PAGE_SIZE = 20;

export function usePaged<T>(items: readonly T[], pageSize = FORENSIC_PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages - 1);
  const slice = useMemo(() => items.slice(current * pageSize, current * pageSize + pageSize), [items, current, pageSize]);
  return { page: current, pages, slice, setPage };
}

export function Pager({
  page,
  pages,
  total,
  onPage,
  label,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (p: number) => void;
  label: string;
}) {
  if (pages <= 1) return null;
  const btn: CSSProperties = {
    border: `1px solid ${VERIFY_BRAND.line}`,
    background: "rgba(255,255,255,0.62)",
    color: VERIFY_BRAND.accent,
    borderRadius: 999,
    padding: "8px 14px",
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
  };
  return (
    <nav aria-label={`${label} pages`} data-print-hide style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <button type="button" style={btn} disabled={page === 0} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span aria-live="polite" style={{ ...VERIFY_TYPO.small, fontSize: 12.5, color: VERIFY_BRAND.ink }}>
        Page {page + 1} of {pages} ({total} events)
      </span>
      <button type="button" style={btn} disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </nav>
  );
}

/** Splits a forensic chain into integrity events and administrative events (shared classification). */
export function groupForensicEvents<T extends { eventType?: string | null }>(events: readonly T[]): { integrity: T[]; administrative: T[] } {
  const integrity: T[] = [];
  const administrative: T[] = [];
  for (const e of events) (isAdministrativeCustodyEventType(e.eventType) ? administrative : integrity).push(e);
  return { integrity, administrative };
}

export function AccessActivitySummary({
  activity,
}: {
  activity: { count?: number | null; latestAtUtc?: string | null } | null | undefined;
}) {
  const count = typeof activity?.count === "number" ? activity.count : null;
  return (
    <section aria-labelledby="verify-access-activity" data-testid="verify-access-activity" style={{ display: "grid", gap: 10 }}>
      <h3 id="verify-access-activity" style={{ ...VERIFY_TYPO.h3, margin: 0 }}>
        Access activity
      </h3>
      <div style={FACT_GRID}>
        <Fact label="Recorded access events" testId="verify-access-count">
          {count != null ? String(count) : "Not recorded"}
        </Fact>
        <Fact label="Latest access" testId="verify-access-latest">
          {activity?.latestAtUtc ? formatDateTime(activity.latestAtUtc) : count === 0 ? "None recorded" : "Not recorded"}
        </Fact>
      </div>
      <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
        Access activity (page views, downloads, verification requests) is stated as a count and its latest occurrence.
        It is not part of the forensic chain and does not change any verification status.
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Accessible tabs
// ---------------------------------------------------------------------------

export function VerifyTabs<Id extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: ReadonlyArray<{ id: Id; label: string }>;
  active: Id;
  onChange: (id: Id) => void;
  label: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} data-print-hide style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {tabs.map((tab, index) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`verify-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`verify-tabpanel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            style={{
              padding: "10px 14px",
              borderRadius: 14,
              border: selected ? `2px solid ${VERIFY_BRAND.accent}` : `1px solid ${VERIFY_BRAND.line}`,
              background: selected ? "rgba(11,46,39,0.10)" : "rgba(255,255,255,0.54)",
              color: VERIFY_BRAND.ink,
              fontSize: 13,
              fontWeight: selected ? 900 : 700,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function VerifyTabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`verify-tabpanel-${id}`} aria-labelledby={`verify-tab-${id}`} tabIndex={0} style={{ display: "grid", gap: 14, minWidth: 0 }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print + responsive stylesheet
// ---------------------------------------------------------------------------

/** Keeps cards whole and labels apart in print; nothing wider than the viewport on a phone. */
export const VERIFY_PAGE_CSS = `
.verify-page-root, .verify-page-root * { box-sizing: border-box; }
.verify-page-root img, .verify-page-root video, .verify-page-root iframe { max-width: 100%; }
.verify-page-root code { overflow-wrap: anywhere; word-break: break-all; }
@media print {
  .verify-page-root { background: #fff !important; }
  .verify-page-root * { box-shadow: none !important; backdrop-filter: none !important; overflow: visible !important; }
  .verify-page-root [data-print-hide] { display: none !important; }
  .verify-page-root [data-print-avoid-break],
  .verify-page-root [data-verify-card],
  .verify-page-root section { break-inside: avoid; page-break-inside: avoid; }
  .verify-page-root [data-verify-label] { display: block; white-space: normal; position: static; margin-bottom: 4px; }
  .verify-page-root [data-print-avoid-break] * { position: static !important; }
}
`;
