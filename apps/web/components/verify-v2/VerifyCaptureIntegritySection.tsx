/**
 * Verify token page — "How this record was acquired" (UC-0).
 *
 * Renders `PublicVerifyAcquisition` (@proovra/shared) — the ONE typed shape
 * `GET /public/verify/:id` emits as `acquisition`. It replaced a capture-trust
 * block that read a nested `chain.*` path the API never sent, so every record
 * rendered MISSING / NOT_ATTEMPTED / false regardless of what was recorded.
 *
 * Presentation rules:
 *   * Acquisition is a neutral FACT. Nothing here uses success styling or a
 *     check mark; green is reserved for cryptographic checks that passed,
 *     which are shown in the preservation sections above.
 *   * A record whose acquisition was never recorded reads "Not recorded" —
 *     absence is not a failure.
 *   * Device signature / attestation lines appear only when applicable and
 *     only as what was recorded; attestation is never called verified unless
 *     the projection says a cryptographic verifier established it.
 *   * No session id, device id, IP, URL path, nonce or digest is rendered —
 *     the projection does not carry them.
 */

import type { CSSProperties } from "react";
import {
  PUBLIC_ACQUISITION_SCHEMA_VERSION,
  type PublicVerifyAcquisition,
} from "@proovra/shared";

import { formatUserDateTime } from "../../lib/date";

/**
 * Accept the API field only when it is the contract this component renders.
 * Anything else (an older API, a malformed body) renders nothing rather than a
 * guessed state.
 */
export function readPublicVerifyAcquisition(
  data: unknown,
): PublicVerifyAcquisition | null {
  const value = (data as { acquisition?: unknown } | null)?.acquisition;
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<PublicVerifyAcquisition>;
  if (v.schemaVersion !== PUBLIC_ACQUISITION_SCHEMA_VERSION) return null;
  if (!v.acquisition || typeof v.acquisition.label !== "string") return null;
  return value as PublicVerifyAcquisition;
}

const SIGNATURE_TEXT: Record<string, string> = {
  VALID:
    "The submitting app's registered device key signed the declared file digest for this session.",
  INVALID_SIGNATURE: "A device signature was supplied but did not verify.",
  INVALID_HASH: "A device signature was supplied for different bytes.",
  INVALID_CANONICAL_JSON: "A device signature was supplied in an invalid form.",
  UNKNOWN_DEVICE: "A device signature was supplied by an unregistered device.",
  ALGORITHM_UNSUPPORTED: "A device signature used an unsupported algorithm.",
};

export function VerifyCaptureIntegritySection({
  acquisition,
  typo,
  brand,
}: {
  acquisition: PublicVerifyAcquisition | null;
  typo: Record<string, CSSProperties>;
  brand: Record<string, string>;
}) {
  if (!acquisition) return null;
  const a = acquisition.acquisition;
  const session = acquisition.captureSession;
  const counts = acquisition.artifacts;

  return (
    <section
      data-testid="verify-acquisition"
      data-acquisition-mode={a.mode}
      data-acquisition-recorded={a.recorded ? "true" : "false"}
      style={{
        border: "1px solid rgba(11,46,39,0.14)",
        background: "rgba(11,46,39,0.03)",
        borderRadius: 18,
        padding: 18,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ ...typo.kicker, fontSize: 10.5, color: brand.ink, opacity: 0.75 }}>
        How this record was acquired
      </div>
      <div data-testid="verify-acquisition-label" style={{ ...typo.small, fontWeight: 600, color: brand.ink }}>
        {a.label}
      </div>
      <div data-testid="verify-acquisition-statement" style={typo.small}>
        {a.statement}
      </div>
      {a.recordedBy === "BACKFILL_INTAKE_SESSION_LINK" ? (
        <div data-testid="verify-acquisition-backfill" style={{ ...typo.small, fontSize: 12 }}>
          Recorded later from this record&apos;s secure intake session, not at the moment it was
          created.
        </div>
      ) : null}
      {session ? (
        <div data-testid="verify-acquisition-session" style={typo.small}>
          Submitted in a server-issued capture session
          {session.startedAtUtc ? ` opened ${formatUserDateTime(session.startedAtUtc)}` : ""}
          {session.endedAtUtc ? ` and completed ${formatUserDateTime(session.endedAtUtc)}` : ""}.
          {session.digestsConfirmed > 0
            ? ` ${session.digestsConfirmed} file digest${session.digestsConfirmed === 1 ? "" : "s"} declared by the app matched what PROOVRA received.`
            : ""}
        </div>
      ) : null}
      {acquisition.deviceSignature.applicable ? (
        <div data-testid="verify-acquisition-signature" style={typo.small}>
          {SIGNATURE_TEXT[acquisition.deviceSignature.verdict] ??
            "A device signature was supplied."}
        </div>
      ) : null}
      {acquisition.deviceAttestation.applicable ? (
        <div data-testid="verify-acquisition-attestation" style={typo.small}>
          {acquisition.deviceAttestation.verified
            ? "The platform's device attestation was verified by PROOVRA."
            : "Device integrity was not independently verified."}
        </div>
      ) : null}
      {acquisition.integrity.establishedAtUtc ? (
        <div data-testid="verify-acquisition-integrity" style={typo.small}>
          PROOVRA established integrity on its server at{" "}
          {formatUserDateTime(acquisition.integrity.establishedAtUtc)}.
        </div>
      ) : null}
      <div data-testid="verify-acquisition-artifacts" style={{ ...typo.small, fontSize: 12 }}>
        {counts.original} original file{counts.original === 1 ? "" : "s"}
        {counts.captureRecord > 0 ? ` · ${counts.captureRecord} capture record${counts.captureRecord === 1 ? "" : "s"}` : ""}
        {counts.derived > 0
          ? ` · ${counts.derived} derived review item${counts.derived === 1 ? "" : "s"} (generated by PROOVRA, not originals)`
          : ""}
      </div>
      {acquisition.limitations.length > 0 ? (
        <ul
          data-testid="verify-acquisition-limitations"
          style={{ ...typo.small, fontSize: 12, margin: 0, paddingLeft: 18 }}
        >
          {acquisition.limitations.map((l) => (
            <li key={l.code}>{l.text}</li>
          ))}
        </ul>
      ) : null}
      <div style={{ ...typo.small, fontSize: 11.5, opacity: 0.75 }}>{acquisition.qualifier}</div>
    </section>
  );
}
