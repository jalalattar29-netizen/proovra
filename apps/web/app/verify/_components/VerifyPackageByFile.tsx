"use client";

/**
 * B5B-F-503 — "Check a package by file" on /verify.
 *
 * A recipient holding a PROOVRA verification package ZIP — including a legacy
 * package issued before package IDs were sealed inside packages, which has no
 * ID to type — checks whether PROOVRA issued exactly that file. The ZIP is
 * hashed in this browser, in slices (lib/uploads/streaming-sha256.ts; Web
 * Crypto's digest is one-shot and would hold the whole file in memory), and
 * ONLY the SHA-256 goes to the existing public lookup
 * `GET /public/verification-packages/by-sha256/:sha256` — a GET with no body,
 * no session credential, nothing of the file but its digest.
 *
 * The answer follows the route's own disclosure rules: a registered match
 * states the package's identity and links to its package record page (by the
 * package ID, never a token); a withdrawn / purged / retained /
 * temporarily-unavailable record states only that state; an unknown digest is
 * the route's one 404. A match says the FILE is a package PROOVRA issued — it
 * is not a verification of the evidence inside it, and the copy says so.
 */
import { useId, useState } from "react";
import { DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES, DISCLOSURE_PROFILE_LABELS, type PublicPackageRecord } from "@proovra/shared";

import { apiFetch } from "../../../lib/api";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { sha256Base64OfBlob } from "../../../lib/uploads/streaming-sha256";
import {
  CANONICAL_STATE_COPY,
  canonicalVerificationStateFromCode,
  type CanonicalVerificationState,
} from "../[token]/BasicVerificationView";
import { fmt } from "../_shared/verify-ui";
import { SECTION_BORDER } from "./shared";

/**
 * The largest file this check reads: the product's single-file upload cap
 * (`DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES`, @proovra/shared reliability). A
 * package is bounded by the evidence ceiling plus its reports, so a larger
 * file cannot be a PROOVRA package and is refused before it is read.
 */
export const PACKAGE_FILE_CHECK_MAX_BYTES = DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES;

/** The lookup path for one digest (lower-case hex, 64 chars). */
export function packageBySha256Path(sha256Hex: string): string {
  return `/public/verification-packages/by-sha256/${encodeURIComponent(sha256Hex)}`;
}

async function sha256HexOfFile(file: Blob): Promise<string> {
  const b64 = await sha256Base64OfBlob(file);
  let hex = "";
  for (const ch of atob(b64)) hex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  return hex;
}

/** A ZIP archive starts with a local-file header (PK\3\4) or, when empty, the end record (PK\5\6). */
async function looksLikeZip(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6));
}

type Outcome =
  | { kind: "idle" }
  | { kind: "hashing" }
  | { kind: "looking_up"; sha256: string }
  | { kind: "registered"; sha256: string; record: PublicPackageRecord }
  | { kind: "not_found"; sha256: string }
  | { kind: "state"; sha256: string; state: CanonicalVerificationState }
  | { kind: "invalid"; reason: "empty" | "not_zip" | "unreadable" }
  | { kind: "oversized" }
  | { kind: "error"; message: string };

const INVALID_COPY: Record<"empty" | "not_zip" | "unreadable", string> = {
  empty: "This file is empty, so it cannot be a verification package. Nothing was sent.",
  not_zip: "This file is not a ZIP archive, so it cannot be a PROOVRA verification package. Nothing was sent.",
  unreadable: "This file could not be read in this browser, so nothing was checked or sent. Choose the package ZIP again, or try another browser.",
};

export function VerifyPackageByFile() {
  const inputId = useId();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [fileName, setFileName] = useState<string | null>(null);
  const busy = outcome.kind === "hashing" || outcome.kind === "looking_up";

  async function check(file: File) {
    setFileName(file.name);
    if (file.size === 0) return setOutcome({ kind: "invalid", reason: "empty" });
    if (file.size > PACKAGE_FILE_CHECK_MAX_BYTES) return setOutcome({ kind: "oversized" });
    setOutcome({ kind: "hashing" });
    let sha256: string;
    try {
      if (!(await looksLikeZip(file))) return setOutcome({ kind: "invalid", reason: "not_zip" });
      sha256 = await sha256HexOfFile(file);
    } catch {
      return setOutcome({ kind: "invalid", reason: "unreadable" });
    }
    setOutcome({ kind: "looking_up", sha256 });
    try {
      // Anonymous by design: the digest is the only thing sent (no body).
      const data = (await apiFetch(packageBySha256Path(sha256), { method: "GET" }, { auth: false, retryAuthOnce: false, anonymous: true })) as
        | (PublicPackageRecord & { code?: unknown })
        | null;
      // A retained record answers 200 with its canonical state, not a record.
      const stateOfBody = canonicalVerificationStateFromCode(data?.code);
      if (stateOfBody) return setOutcome({ kind: "state", sha256, state: stateOfBody });
      if (!data || typeof data.packageId !== "string" || !Array.isArray(data.issuedWith)) {
        return setOutcome({ kind: "error", message: "The package record could not be loaded." });
      }
      setOutcome({ kind: "registered", sha256, record: data });
    } catch (err) {
      const e = err as { code?: unknown; statusCode?: number } | null;
      const stateOfError = canonicalVerificationStateFromCode(e?.code);
      if (stateOfError) return setOutcome({ kind: "state", sha256, state: stateOfError });
      if (e?.statusCode === 404) return setOutcome({ kind: "not_found", sha256 });
      setOutcome({ kind: "error", message: toSafeUserError(err, { message: "The package record could not be loaded." }).message });
    }
  }

  return (
    <section
      id="package-by-file"
      data-testid="verify-package-by-file"
      aria-labelledby={`${inputId}-title`}
      className="rounded-[20px] border bg-white px-5 py-5 md:px-6"
      style={{ borderColor: SECTION_BORDER, boxShadow: "0 18px 40px rgba(15, 23, 42, 0.08)" }}
    >
      <h2 id={`${inputId}-title`} className="text-[16px] font-semibold text-[#07142F]">
        Check a package by file
      </h2>
      <p className="mt-1 text-[13px] leading-[1.55] text-[#526176]">
        Hold a PROOVRA verification package ZIP with no package ID to type, such as an older package? Choose it here.
        It is hashed in this browser; only its SHA-256 is sent to PROOVRA, never the file.
      </p>
      <label htmlFor={inputId} className="mt-3 block text-[12px] font-semibold uppercase tracking-[0.12em] text-[#475569]">
        Package ZIP
      </label>
      <input
        id={inputId}
        type="file"
        accept=".zip,application/zip"
        data-testid="verify-package-file"
        disabled={busy}
        className="mt-2 block w-full text-[13px]"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void check(file);
        }}
      />
      <div role="status" aria-live="polite" className="mt-3 text-[13px] leading-[1.55]" data-testid="verify-package-by-file-result" data-outcome={outcome.kind}>
        {outcome.kind === "hashing" ? <p className="text-[#526176]">Computing SHA-256…</p> : null}
        {outcome.kind === "looking_up" ? <p className="text-[#526176]">Looking up this SHA-256…</p> : null}
        {outcome.kind === "invalid" ? <p className="text-[#B91C1C]">{INVALID_COPY[outcome.reason]}</p> : null}
        {outcome.kind === "oversized" ? (
          <p className="text-[#B91C1C]">
            This file is larger than any PROOVRA verification package can be, so it was not read and nothing was sent.
          </p>
        ) : null}
        {outcome.kind === "error" ? <p className="text-[#B91C1C]">{outcome.message}</p> : null}
        {outcome.kind === "not_found" ? (
          <>
            <p className="font-semibold text-[#B91C1C]">No PROOVRA package record matches this file.</p>
            <p className="text-[#526176]">
              The file may have been changed after it was issued, or it is not a package PROOVRA issued. SHA-256{" "}
              <code dir="ltr">{outcome.sha256}</code>.
            </p>
          </>
        ) : null}
        {outcome.kind === "state" ? (
          <>
            <p className="font-semibold text-[#07142F]">{CANONICAL_STATE_COPY[outcome.state].title}</p>
            <p className="text-[#526176]">{CANONICAL_STATE_COPY[outcome.state].body}</p>
          </>
        ) : null}
        {outcome.kind === "registered" ? (
          <div data-testid="verify-package-registered">
            <p className="font-semibold text-[#047857]">Registered PROOVRA package</p>
            <p className="text-[#0F172A]">
              {fileName ? <>{fileName} </> : null}is byte-for-byte a verification package PROOVRA issued: package ID{" "}
              <code dir="ltr" data-testid="verify-package-registered-id">{outcome.record.packageId}</code>,{" "}
              {DISCLOSURE_PROFILE_LABELS[outcome.record.disclosureProfile]}, issued{" "}
              {outcome.record.issuedAtUtc ? fmt(outcome.record.issuedAtUtc) : "at a time that was not recorded"}.
            </p>
            <p className="mt-1 text-[#526176]">
              This identifies the package file only. It is not a verification of the evidence inside it: open the
              package record to see its seal key, then check the package with the commands in its README.
            </p>
            <a
              href={`/verify/package/${encodeURIComponent(outcome.record.packageId)}`}
              className="mt-2 inline-block font-semibold text-[#2563EB] underline"
              data-testid="verify-package-record-link"
            >
              Open the package record
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}
