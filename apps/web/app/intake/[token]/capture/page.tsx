"use client";

/**
 * Phase 1B Closure — Citizen PWA capture page.
 *
 * Browser-first capture flow that produces a Class B TrustEnvelope:
 *
 *   1. Open a citizen session — generates a session-ephemeral
 *      Ed25519 key in the browser, registers the public key with
 *      the workspace via the intake link.
 *   2. Capture or upload a file.
 *   3. SHA-256 + canonical-JSON + Ed25519 sign in-browser.
 *   4. POST to the citizen ingest route.
 *   5. Surface bounded trust outcome.
 *
 * Hard rules:
 *   * Session-ephemeral key NEVER persisted (memory only).
 *   * Citizen captures clamped to Class B server-side.
 *   * PROOVRA language only — never asserts authenticity.
 */

import { use, useCallback, useEffect, useMemo, useState } from "react";

import {
  captureAndSubmit,
  openCitizenSession,
  type CitizenSession,
} from "../../../../lib/citizen-capture/citizen-capture-client";

type StatusKind =
  | { kind: "OPENING" }
  | { kind: "READY"; session: CitizenSession }
  | { kind: "DENIED"; reason: string }
  | { kind: "SUBMITTING" }
  | {
      kind: "RESULT";
      session: CitizenSession;
      result: {
        provenanceClass: "B" | "C";
        signatureVerdict: string;
        assetHash: string;
      };
    };

export default function CitizenCapturePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [status, setStatus] = useState<StatusKind>({ kind: "OPENING" });
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await openCitizenSession(token);
        if (cancelled) return;
        setStatus({ kind: "READY", session });
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const denial = (err as any)?.denial?.denial ?? "OPEN_FAILED";
        setStatus({ kind: "DENIED", reason: denial });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const onSubmit = useCallback(async () => {
    if (status.kind !== "READY" || !file) return;
    const sess = status.session;
    setStatus({ kind: "SUBMITTING" });
    const result = await captureAndSubmit({ session: sess, file });
    if (result.kind === "OK") {
      setStatus({
        kind: "RESULT",
        session: sess,
        result: {
          provenanceClass: result.provenanceClass,
          signatureVerdict: result.signatureVerdict,
          assetHash: result.assetHash,
        },
      });
    } else {
      setStatus({ kind: "DENIED", reason: result.reason });
    }
  }, [status, file]);

  const expiryLabel = useMemo(() => {
    if (status.kind === "READY" || status.kind === "RESULT") {
      const ts = new Date(status.session.descriptor.expiresAtUtc);
      return ts.toLocaleString();
    }
    return null;
  }, [status]);

  return (
    <main
      data-citizen-capture-page
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "28px 20px",
        color: "#0f172a",
        lineHeight: 1.55,
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Submit verified capture</h1>
        <p style={{ margin: "6px 0 0", color: "#475569", fontSize: 13 }}>
          We record integrity primitives at the moment of capture — a hash
          chained to a session-bound signature. Browser captures are recorded
          as <strong>Class B (browser captured)</strong>. PROOVRA does not
          assert truth or admissibility about the content.
        </p>
      </header>

      {status.kind === "OPENING" ? (
        <p>Opening secure session…</p>
      ) : null}

      {status.kind === "DENIED" ? (
        <div
          role="alert"
          data-citizen-capture-denied
          style={{
            padding: "12px 14px",
            borderRadius: 10,
            background: "rgba(239, 68, 68, 0.08)",
            border: "1px solid rgba(239, 68, 68, 0.35)",
            color: "#7f1d1d",
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            Capture refused
          </strong>
          <code>{status.reason}</code>
        </div>
      ) : null}

      {status.kind === "READY" || status.kind === "SUBMITTING" ? (
        <section
          data-citizen-capture-ready
          style={{
            padding: "14px 16px",
            borderRadius: 12,
            background: "rgba(15, 23, 42, 0.04)",
            border: "1px solid rgba(15, 23, 42, 0.08)",
          }}
        >
          <p style={{ margin: 0, fontSize: 13 }}>
            Session opens until <strong>{expiryLabel}</strong>. The
            session-ephemeral key never leaves your browser.
          </p>
          <label
            htmlFor="citizen-file"
            style={{ display: "block", marginTop: 12, fontSize: 13, fontWeight: 600 }}
          >
            Choose a photo, video, or document
          </label>
          <input
            id="citizen-file"
            data-citizen-capture-file
            type="file"
            accept="image/*,video/*,.pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={status.kind === "SUBMITTING"}
            style={{ display: "block", marginTop: 6 }}
          />
          <button
            type="button"
            disabled={!file || status.kind === "SUBMITTING"}
            onClick={onSubmit}
            data-citizen-capture-submit
            style={{
              marginTop: 14,
              padding: "9px 16px",
              borderRadius: 10,
              border: "1px solid #1e293b",
              background: "#0f172a",
              color: "#fafafa",
              fontWeight: 600,
              cursor: file ? "pointer" : "not-allowed",
              opacity: file ? 1 : 0.6,
            }}
          >
            {status.kind === "SUBMITTING"
              ? "Signing and submitting…"
              : "Sign and submit"}
          </button>
        </section>
      ) : null}

      {status.kind === "RESULT" ? (
        <section
          data-citizen-capture-result
          style={{
            marginTop: 16,
            padding: "14px 16px",
            borderRadius: 12,
            background: "rgba(34, 197, 94, 0.08)",
            border: "1px solid rgba(34, 197, 94, 0.4)",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: 16 }}>
            Capture accepted
          </h2>
          <dl style={{ margin: 0, fontSize: 13 }}>
            <Row label="Provenance class" value={`Class ${status.result.provenanceClass}`} />
            <Row label="Signature verdict" value={status.result.signatureVerdict} />
            <Row label="Asset hash (SHA-256)" value={status.result.assetHash} mono />
          </dl>
          <p style={{ marginTop: 8, fontSize: 12, color: "#475569" }}>
            Independent verification is possible — the workspace operator can
            share a verify link that anyone can check using the offline
            verifier.
          </p>
        </section>
      ) : null}
    </main>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "3px 0" }}>
      <dt style={{ flex: "0 0 130px", color: "#475569" }}>{label}</dt>
      <dd
        style={{
          margin: 0,
          fontFamily: mono
            ? "ui-monospace, SFMono-Regular, Consolas, monospace"
            : undefined,
          wordBreak: "break-all",
        }}
      >
        {value}
      </dd>
    </div>
  );
}
