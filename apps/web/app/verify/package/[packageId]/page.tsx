"use client";

/**
 * PROOVRA'S PUBLIC PACKAGE RECORD — a Public Verify page.
 *
 * Someone holding a verification package (often outside any workspace) checks
 * it against PROOVRA's record: the package id, its SHA-256, and the binding of
 * the key that sealed it (registered for PACKAGE SEALING, valid, rotated or
 * revoked). The answer is `PublicPackageRecord` (@proovra/shared), read from
 * the Public Verify API family, and rendered with the Public Verify vocabulary
 * shared with the record page (../../_shared/verify-ui). The package file is
 * hashed in the browser and never uploaded.
 */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import {
  DISCLOSURE_PROFILE_LABELS,
  PUBLIC_PACKAGE_KEY_BINDING_TEXT,
  type ComponentVerificationState,
  type PublicPackageKeyBinding,
  type PublicPackageRecord,
} from "@proovra/shared";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { Row, VerifyCard, VerifyMain, fmt } from "../../_shared/verify-ui";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The binding, in the Public Verify state vocabulary. */
const BINDING_STATE: Record<PublicPackageKeyBinding, ComponentVerificationState> = {
  BOUND: "verified",
  BOUND_KEY_REVOKED: "failed",
  KEY_NOT_PUBLISHED: "not_checked",
  NOT_SEALED: "not_issued",
};
const BINDING_BADGE: Record<PublicPackageKeyBinding, string> = {
  BOUND: "Bound to PROOVRA",
  BOUND_KEY_REVOKED: "Key revoked",
  KEY_NOT_PUBLISHED: "Key not registered",
  NOT_SEALED: "Not sealed",
};

function recordHref(packageId: string): string {
  return `/verify/package/${encodeURIComponent(packageId)}`;
}

async function sha256OfFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function PackageRecordPage() {
  const params = useParams<{ packageId: string }>();
  const packageId = params?.packageId ?? "";
  const [record, setRecord] = useState<PublicPackageRecord | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not_found" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fileCheck, setFileCheck] = useState<{ name: string; sha256: string } | null>(null);
  const [hashing, setHashing] = useState(false);

  useEffect(() => {
    if (!packageId) return;
    // Same answer as the API for a malformed id, without spending a request.
    if (!UUID.test(packageId)) {
      setState("not_found");
      return;
    }
    let cancelled = false;
    setState("loading");
    apiFetch(`/public/verification-packages/${encodeURIComponent(packageId)}`)
      .then((data) => {
        if (cancelled) return;
        setRecord(data as PublicPackageRecord);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if ((err as { statusCode?: number } | null)?.statusCode === 404) {
          setState("not_found");
          return;
        }
        setErrorMessage(toSafeUserError(err, { message: "The package record could not be loaded." }).message);
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [packageId]);

  const match = fileCheck && record?.packageSha256 ? fileCheck.sha256 === record.packageSha256.toLowerCase() : null;

  return (
    <VerifyMain testId="package-record-root" tier="package">
      <h1 style={{ fontSize: 26, lineHeight: 1.25, margin: "0 0 8px" }}>Check a verification package with PROOVRA</h1>
      <p style={{ color: "#475569", margin: "0 0 20px" }}>
        A key found only inside a package vouches for nothing: anyone can reseal an altered package with their own
        key. This page states what PROOVRA recorded about the package it issued, so you can bind your copy to PROOVRA.
      </p>

      {state === "loading" ? (
        <p role="status" aria-live="polite" style={{ color: "#475569" }}>
          Loading the package record…
        </p>
      ) : null}
      {state === "not_found" ? (
        <p role="alert" data-testid="package-record-not-found" style={{ color: "#9b1c1c", fontWeight: 600 }}>
          No PROOVRA package record matches this package ID. Check the ID in the package&apos;s README.
        </p>
      ) : null}
      {state === "error" ? (
        <p role="alert" data-testid="package-record-unavailable" style={{ color: "#9b1c1c", fontWeight: 600 }}>
          {errorMessage}
        </p>
      ) : null}

      {state === "ready" && record ? (
        <>
          <VerifyCard id="package-identity" title="Package">
            <Row
              testId="package-record-profile"
              label="Disclosure profile"
              state={record.disclosureProfile === "LEGACY" ? "not_checked" : "verified"}
              badge={DISCLOSURE_PROFILE_LABELS[record.disclosureProfile]}
              detail={
                <>
                  Package ID <code dir="ltr" data-testid="package-record-id">{record.packageId}</code>, certifying report
                  version {record.reportVersion}, issued {fmt(record.issuedAtUtc)}.
                  {record.packageIdRecordedInPackage ? "" : " This package was issued before package IDs were sealed inside packages."}
                </>
              }
            />
            <Row
              label="Package file SHA-256"
              state={record.packageSha256 ? "verified" : "not_issued"}
              badge={record.packageSha256 ? "Recorded" : undefined}
              detail={
                record.packageSha256 ? (
                  <code dir="ltr" data-testid="package-record-sha256">{record.packageSha256}</code>
                ) : (
                  "PROOVRA did not record a digest for this package."
                )
              }
            />
            <Row
              testId="package-record-binding"
              label="Seal key"
              state={BINDING_STATE[record.keyBinding]}
              badge={BINDING_BADGE[record.keyBinding]}
              detail={
                <>
                  <span data-testid="package-record-binding-text">{PUBLIC_PACKAGE_KEY_BINDING_TEXT[record.keyBinding]}</span>
                  {record.sealKey ? (
                    <span style={{ display: "block", marginTop: 6 }} data-testid="package-record-seal-key">
                      Purpose: package seal · {record.sealKey.algorithm} · key {record.sealKey.keyId} version{" "}
                      {record.sealKey.version} · fingerprint <code dir="ltr">{record.sealKey.fingerprintSha256}</code> ·
                      valid from {fmt(record.sealKey.validFromUtc)}
                      {record.sealKey.validUntilUtc ? ` until ${fmt(record.sealKey.validUntilUtc)}` : ""}
                      {record.sealKey.status === "SUPERSEDED" && record.sealKey.supersededByVersion != null
                        ? ` · rotated to version ${record.sealKey.supersededByVersion}`
                        : ""}
                      {record.sealKey.revokedAtUtc ? ` · revoked ${fmt(record.sealKey.revokedAtUtc)}` : ""}.
                    </span>
                  ) : record.sealKeyFingerprintSha256 ? (
                    <span style={{ display: "block", marginTop: 6 }}>
                      The package records a seal key with fingerprint{" "}
                      <code dir="ltr">{record.sealKeyFingerprintSha256}</code>.
                    </span>
                  ) : null}
                </>
              }
            />
          </VerifyCard>

          <VerifyCard id="package-file" title="Check your copy" style={{ marginTop: 16 }}>
            <p style={{ fontSize: 14, color: "#475569", margin: "8px 0" }}>
              Choose the package ZIP you hold. It is hashed in this browser and is not uploaded.
            </p>
            <label style={{ display: "inline-block", fontWeight: 600 }}>
              <span>Package ZIP</span>{" "}
              <input
                type="file"
                accept=".zip,application/zip"
                data-testid="package-record-file"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setHashing(true);
                  try {
                    setFileCheck({ name: file.name, sha256: await sha256OfFile(file) });
                  } finally {
                    setHashing(false);
                  }
                }}
              />
            </label>
            <div aria-live="polite" role="status" style={{ marginTop: 10 }}>
              {hashing ? "Computing SHA-256…" : null}
              {fileCheck && !hashing ? (
                <Row
                  testId="package-record-file-result"
                  label={fileCheck.name}
                  state={match === true ? "verified" : match === false ? "failed" : "not_checked"}
                  badge={match === true ? "Matches" : match === false ? "Does not match" : undefined}
                  detail={
                    <>
                      SHA-256 <code dir="ltr">{fileCheck.sha256}</code>.{" "}
                      {match === true
                        ? "Your copy is byte-for-byte the package PROOVRA issued. Check its seal with the commands in its README."
                        : match === false
                          ? "Your copy is not the package PROOVRA issued under this ID."
                          : "PROOVRA recorded no digest to compare with."}
                    </>
                  }
                />
              ) : null}
            </div>
          </VerifyCard>

          <VerifyCard id="package-related" title="Related packages" style={{ marginTop: 16 }}>
            <Row
              label="Issued with"
              state={record.issuedWith.length ? "verified" : "not_issued"}
              badge={record.issuedWith.length ? `${record.issuedWith.length}` : "None"}
              detail={
                record.issuedWith.length ? (
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {record.issuedWith.map((p) => (
                      <li key={p.packageId}>
                        {DISCLOSURE_PROFILE_LABELS[p.disclosureProfile]}:{" "}
                        <a href={recordHref(p.packageId)}>
                          <code dir="ltr">{p.packageId}</code>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  "No other package was issued with this one."
                )
              }
            />
            <Row
              label="Supersedes"
              state={record.supersedes ? "verified" : "not_issued"}
              badge={record.supersedes ? `Report v${record.supersedes.reportVersion}` : "None"}
              detail={
                record.supersedes ? (
                  <a href={recordHref(record.supersedes.packageId)}>
                    <code dir="ltr">{record.supersedes.packageId}</code>
                  </a>
                ) : (
                  "This is the first package of its profile for the record."
                )
              }
            />
            <Row
              testId="package-record-superseded-by"
              label="Superseded by"
              state={record.supersededBy ? "pending" : "not_issued"}
              badge={record.supersededBy ? `Report v${record.supersededBy.reportVersion}` : "Current"}
              detail={
                record.supersededBy ? (
                  <>
                    A later package of the same profile was issued:{" "}
                    <a href={recordHref(record.supersededBy.packageId)}>
                      <code dir="ltr">{record.supersededBy.packageId}</code>
                    </a>
                    . This package is unchanged and still verifies.
                  </>
                ) : (
                  "No later package of this profile has been issued."
                )
              }
            />
          </VerifyCard>

          <p style={{ fontSize: 13, color: "#475569", marginTop: 16 }} data-testid="package-record-statement">
            {record.statement}
          </p>
        </>
      ) : null}
    </VerifyMain>
  );
}
