"use client";

/**
 * PROOVRA'S PUBLIC PACKAGE RECORD — /verify/package/<packageId>.
 *
 * The verification package README sends a recipient here to bind the package
 * they hold to PROOVRA from OUTSIDE it: the package id, the SHA-256 of the
 * exact ZIP PROOVRA issued, the seal digest, and the seal key's fingerprint,
 * status and validity from PROOVRA's signing-key registry. A file can be
 * checked in the browser (hashed locally; nothing is uploaded).
 *
 * Reads GET /public/verification-packages/:packageId. It shows no evidence
 * content and does not publish the evidence record. If the record cannot be
 * read, the page says that external key binding is unavailable — never that
 * the package is genuine.
 */

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { apiFetch } from "../../../../lib/api";

type PackageRecord = {
  packageId: string;
  packageIdRecordedInPackage: boolean;
  disclosureProfile: "FULL_FORENSIC" | "EXTERNAL_DISCLOSURE" | "LEGACY";
  completeForensicPackage: boolean;
  sourceFullPackageId: string | null;
  externalDisclosurePackageId: string | null;
  reportVersion: number;
  issuedAtUtc: string;
  packageSha256: string | null;
  packageFormatVersion: number | null;
  sealSha256: string | null;
  sealKeyFingerprintSha256: string | null;
  sealKey: {
    keyId: string;
    version: number;
    algorithm: string;
    status: "ACTIVE" | "SUPERSEDED" | "REVOKED";
    validFromUtc: string;
    validUntilUtc: string | null;
    revokedAtUtc: string | null;
  } | null;
  keyBinding: "BOUND" | "BOUND_KEY_REVOKED" | "KEY_NOT_PUBLISHED" | "NOT_SEALED";
  supersedes: { packageId: string; reportVersion: number } | null;
  supersededBy: { packageId: string; reportVersion: number } | null;
  statement: string;
};

const PROFILE_LABEL: Record<PackageRecord["disclosureProfile"], string> = {
  FULL_FORENSIC: "Full forensic package",
  EXTERNAL_DISCLOSURE: "External disclosure package (not the complete forensic package)",
  LEGACY: "Full package (issued before disclosure profiles)",
};

const BINDING_TEXT: Record<PackageRecord["keyBinding"], { title: string; body: string; tone: "ok" | "warn" }> = {
  BOUND: {
    title: "Seal key published by PROOVRA",
    body: "The key that sealed this package is in PROOVRA's signing-key registry. Compare its fingerprint with signingKeyFingerprint in package-seal.sig.",
    tone: "ok",
  },
  BOUND_KEY_REVOKED: {
    title: "Seal key published by PROOVRA — now revoked",
    body: "The key that sealed this package is in PROOVRA's registry and has since been revoked. The package was issued while the key was valid only if its issue time is before the revocation time below.",
    tone: "warn",
  },
  KEY_NOT_PUBLISHED: {
    title: "External key binding unavailable",
    body: "PROOVRA issued this package, but its seal key is not in the published registry. The seal shows the package is internally consistent; its attribution to PROOVRA cannot be confirmed from outside it.",
    tone: "warn",
  },
  NOT_SEALED: {
    title: "Package not sealed",
    body: "This package was issued before sealed packages. Its files can be checked against package-checksums.json, but no seal binds them.",
    tone: "warn",
  },
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-slate-200 py-3 sm:grid-cols-[14rem_1fr]">
      <dt className="text-sm font-semibold text-slate-600">{label}</dt>
      <dd className="min-w-0 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

function Mono({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-500">Not recorded</span>;
  return (
    <code dir="ltr" className="break-all font-mono text-[13px] text-slate-900">
      {value}
    </code>
  );
}

async function sha256OfFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function PackageRecordPage() {
  const params = useParams<{ packageId: string }>();
  const packageId = params?.packageId ?? "";
  const [record, setRecord] = useState<PackageRecord | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not_found" | "unavailable">("loading");
  const [fileCheck, setFileCheck] = useState<{ name: string; sha256: string } | null>(null);
  const [hashing, setHashing] = useState(false);

  useEffect(() => {
    if (!packageId) return;
    let cancelled = false;
    setState("loading");
    apiFetch(`/public/verification-packages/${encodeURIComponent(packageId)}`)
      .then((data) => {
        if (cancelled) return;
        setRecord(data as PackageRecord);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { statusCode?: number } | null)?.statusCode;
        setState(status === 404 ? "not_found" : "unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [packageId]);

  const binding = record ? BINDING_TEXT[record.keyBinding] : null;
  const match =
    fileCheck && record?.packageSha256 ? fileCheck.sha256 === record.packageSha256.toLowerCase() : null;

  return (
    <main className="min-h-screen bg-white px-4 py-10 text-slate-900" data-testid="package-record-root">
      <div className="mx-auto max-w-3xl">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">PROOVRA package record</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">Check a verification package with PROOVRA</h1>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          This page states what PROOVRA issued. It does not show or publish the evidence record, and it describes the
          package as issued, not the record&apos;s current state.
        </p>

        {state === "loading" ? (
          <p className="mt-8 text-sm text-slate-600" role="status">
            Reading PROOVRA&apos;s package record…
          </p>
        ) : null}

        {state === "not_found" ? (
          <section className="mt-8 rounded-lg border border-amber-300 bg-amber-50 p-4" role="alert" data-testid="package-record-not-found">
            <h2 className="text-base font-semibold text-amber-900">No PROOVRA package record matches</h2>
            <p className="mt-1 text-sm text-amber-900">
              PROOVRA has no package with this ID. External key binding is unavailable: do not treat the package as
              issued by PROOVRA on the strength of its own contents.
            </p>
          </section>
        ) : null}

        {state === "unavailable" ? (
          <section className="mt-8 rounded-lg border border-amber-300 bg-amber-50 p-4" role="alert" data-testid="package-record-unavailable">
            <h2 className="text-base font-semibold text-amber-900">The package record could not be read</h2>
            <p className="mt-1 text-sm text-amber-900">
              External key binding is unavailable right now. Try again later; until then the package&apos;s attribution
              to PROOVRA cannot be confirmed from outside it.
            </p>
          </section>
        ) : null}

        {state === "ready" && record && binding ? (
          <>
            <section
              className={`mt-8 rounded-lg border p-4 ${binding.tone === "ok" ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}
              data-testid="package-record-binding"
              data-key-binding={record.keyBinding}
            >
              <h2 className={`text-base font-semibold ${binding.tone === "ok" ? "text-emerald-900" : "text-amber-900"}`}>{binding.title}</h2>
              <p className={`mt-1 text-sm ${binding.tone === "ok" ? "text-emerald-900" : "text-amber-900"}`}>{binding.body}</p>
            </section>

            <dl className="mt-6" data-testid="package-record-facts">
              <Row label="Package ID">
                <Mono value={record.packageId} />
                {!record.packageIdRecordedInPackage ? (
                  <p className="mt-1 text-xs text-slate-600">This package was issued before package IDs were written into packages.</p>
                ) : null}
              </Row>
              <Row label="Disclosure profile">{PROFILE_LABEL[record.disclosureProfile]}</Row>
              <Row label="Certifies report version">v{record.reportVersion}</Row>
              <Row label="Issued">
                <time dateTime={record.issuedAtUtc}>{new Date(record.issuedAtUtc).toUTCString()}</time>
              </Row>
              <Row label="Package SHA-256">
                <Mono value={record.packageSha256} />
              </Row>
              <Row label="Seal SHA-256">
                <Mono value={record.sealSha256} />
              </Row>
              <Row label="Seal key fingerprint">
                <Mono value={record.sealKeyFingerprintSha256} />
              </Row>
              {record.sealKey ? (
                <Row label="Seal key">
                  {record.sealKey.keyId} v{record.sealKey.version} · {record.sealKey.algorithm} ·{" "}
                  <span data-testid="package-record-key-status">{record.sealKey.status.toLowerCase()}</span>
                  <p className="mt-1 text-xs text-slate-600">
                    Valid from {new Date(record.sealKey.validFromUtc).toUTCString()}
                    {record.sealKey.validUntilUtc ? ` until ${new Date(record.sealKey.validUntilUtc).toUTCString()}` : ""}
                    {record.sealKey.revokedAtUtc ? ` · revoked ${new Date(record.sealKey.revokedAtUtc).toUTCString()}` : ""}
                  </p>
                </Row>
              ) : null}
              {record.supersedes ? (
                <Row label="Supersedes">
                  <a className="text-violet-700 underline" href={`/verify/package/${record.supersedes.packageId}`}>
                    Package for report v{record.supersedes.reportVersion}
                  </a>{" "}
                  (unchanged; still valid for what it stated when issued)
                </Row>
              ) : null}
              {record.supersededBy ? (
                <Row label="Superseded by">
                  <a className="text-violet-700 underline" href={`/verify/package/${record.supersededBy.packageId}`}>
                    Package for report v{record.supersededBy.reportVersion}
                  </a>
                </Row>
              ) : null}
            </dl>

            <section className="mt-8" aria-labelledby="file-check-title">
              <h2 id="file-check-title" className="text-base font-semibold text-slate-900">
                Check the file you hold
              </h2>
              <p className="mt-1 text-sm text-slate-700">
                Choose the package ZIP. Its SHA-256 is computed in this browser; the file is not uploaded.
              </p>
              <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 focus-within:outline focus-within:outline-2 focus-within:outline-violet-600">
                <input
                  type="file"
                  accept=".zip,application/zip"
                  className="app-visually-hidden"
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
                Choose package ZIP
              </label>
              <div aria-live="polite" className="mt-3 text-sm">
                {hashing ? <p className="text-slate-600">Computing SHA-256…</p> : null}
                {fileCheck && !hashing ? (
                  <p
                    className={match ? "text-emerald-800" : "text-amber-900"}
                    data-testid="package-record-file-result"
                    data-match={match ? "true" : "false"}
                  >
                    {match
                      ? `${fileCheck.name} is byte-for-byte the package PROOVRA issued.`
                      : `${fileCheck.name} does not match the package PROOVRA issued (SHA-256 ${fileCheck.sha256}).`}
                  </p>
                ) : null}
              </div>
            </section>

            <p className="mt-8 text-xs leading-5 text-slate-600">{record.statement}</p>
          </>
        ) : null}
      </div>
    </main>
  );
}
