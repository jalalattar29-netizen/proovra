"use client";

/**
 * Phase 2.2 — Authenticated in-app verify workspace at `/inspect`.
 *
 * NOTE: Originally placed at `/(app)/verify/page.tsx`. Next.js route
 * groups do not affect URL, so that path collided with the existing
 * public `/verify/page.tsx`. Phase 2.3 moves it to `/inspect`.
 *
 * The public /verify surface (token-input + read-only render) was the
 * only verify path for signed-in operators too. They had to leave the
 * app to inspect a record's verification state, which the read-only
 * audit flagged as a P0 operator-UX gap.
 *
 * This page closes that gap WITHOUT weakening public verify:
 *
 *   - It uses the AUTHENTICATED `/v1/evidence/:id/review-workspace`
 *     endpoint (workspace-scoped, full trust + custody data), not the
 *     public endpoint. The data it shows is what the OPERATOR sees,
 *     not what the public sees.
 *   - It surfaces an explicit "Open public verify" button so the
 *     operator can preview EXACTLY what an external viewer would see.
 *   - It NEVER displays content the public endpoint redacts (we use
 *     the authenticated endpoint's projection, which intentionally
 *     does not include `submittedByEmail`, `workspaceName`, or
 *     `organizationName` on the public preview line — we mirror the
 *     `overview.publicVerify` shape).
 *   - It surfaces the publication state explicitly ("Published" vs
 *     "Unpublished — public verify would return 404").
 *   - Legal boundary copy is reused verbatim from the workspace
 *     envelope's `legalBoundary` field so the wording matches the
 *     server's authority.
 *
 * Hard rules:
 *   - No new backend endpoints introduced.
 *   - No PII surfaced that public verify redacts (Phase 1).
 *   - No trust overclaiming (no "verified", "authentic", "admissible").
 *   - No fake placeholders — fields that aren't applicable show "—"
 *     and explain why.
 */

import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { useCallback, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../lib/api";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";

type VerifyLookupState =
  | { status: "idle" }
  | { status: "loading"; evidenceId: string }
  | { status: "ready"; evidenceId: string; data: WorkspaceShape }
  | { status: "not_found"; evidenceId: string }
  | { status: "forbidden"; evidenceId: string }
  | { status: "error"; evidenceId: string; message: string };

/**
 * Subset of `/v1/evidence/:id/review-workspace` we actually render.
 * We intentionally do NOT consume `evidence.submittedByEmail` etc. —
 * the public verify view redacts those, and the in-app view stays
 * consistent so an operator never sees fields they then claim are
 * "in the public response".
 */
type WorkspaceShape = {
  evidence: {
    id: string;
    title: string | null;
    displayFileName: string | null;
    status: string;
    verificationStatus: string | null;
    publicVerifyState?: string | null;
  };
  preservationMatrix?: {
    trustDecision?: {
      verdict?: string;
      verdictLabel?: string;
      score?: number;
      maxScore?: number;
      shortLabel?: string;
      summary?: string;
      signals?: Array<{
        key: string;
        label: string;
        status: string;
        tone: string;
        summary?: string;
      }>;
    } | null;
    latestReport?: {
      available: boolean;
      version: number | null;
      generatedAtUtc: string | null;
    };
    latestVerificationPackage?: {
      available: boolean;
      version: number | null;
      generatedAtUtc: string | null;
    };
  };
  legalBoundary?: string;
};

function VerifyWorkspaceInner() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<VerifyLookupState>({ status: "idle" });
  const [copied, setCopied] = useState(false);

  const lookup = useCallback(async (raw: string) => {
    const id = raw.trim();
    if (!id) {
      setState({ status: "idle" });
      return;
    }
    // Server validates the UUID; surface a friendly client check too.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      setState({
        status: "error",
        evidenceId: id,
        message: "That doesn't look like a valid evidence ID.",
      });
      return;
    }
    setState({ status: "loading", evidenceId: id });
    try {
      const data = (await apiFetch(
        `/v1/evidence/${id}/review-workspace`,
      )) as WorkspaceShape;
      setState({ status: "ready", evidenceId: id, data });
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 404) {
        setState({ status: "not_found", evidenceId: id });
      } else if (e.statusCode === 403) {
        setState({ status: "forbidden", evidenceId: id });
      } else if (e.statusCode === 503) {
        setState({
          status: "error",
          evidenceId: id,
          message:
            "Verification is temporarily unavailable. Operations have been notified.",
        });
      } else {
        setState({
          status: "error",
          evidenceId: id,
          message: toSafeUserError(e, { message: "Lookup failed." }).message,
        });
      }
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void lookup(query);
  };

  const publicVerifyUrl =
    state.status === "ready"
      ? `${typeof window !== "undefined" ? window.location.origin : ""}/verify/${state.evidenceId}`
      : null;

  const copyPublicLink = async () => {
    if (!publicVerifyUrl) return;
    try {
      await navigator.clipboard.writeText(publicVerifyUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fall through silently — Chrome restricts clipboard in some
      // contexts; the user can still open the link manually.
    }
  };

  return (
    <main
      className="cc-page"
      data-verify-workspace
    >
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Trust workspace</div>
          <h1 className="cc-title">Verify evidence</h1>
          <p className="cc-subtitle">
            Inspect verification state inside the app. Paste an evidence
            ID to view trust, integrity, custody, and the public verify
            preview — without leaving the workspace.
          </p>
        </div>
        <div className="cc-meta">
          <Link href="/evidence" className="btn-secondary" data-verify-browse>
            Browse evidence
          </Link>
        </div>
      </header>

      <section className="cc-section" data-verify-search>
        <form onSubmit={handleSubmit}>
          <label
            htmlFor="verify-evidence-id"
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 600,
              opacity: 0.85,
              marginBottom: 6,
            }}
          >
            Evidence ID
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              id="verify-evidence-id"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. 4e173c66-6ae6-4d15-b1aa-7c61b2ac7502"
              data-verify-input
              style={{
                flex: "1 1 360px",
                padding: "10px 12px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 8,
                color: "inherit",
                fontFamily: "monospace",
                fontSize: 13,
              }}
            />
            <button
              type="submit"
              className="btn-primary"
              data-verify-submit
              disabled={state.status === "loading" || !query.trim()}
            >
              {state.status === "loading" ? "Looking up…" : "Verify"}
            </button>
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 12, opacity: 0.6 }}>
            Authenticated lookup. Workspace policy + role permissions
            apply — you can only verify evidence you have access to in
            this workspace.
          </p>
        </form>
      </section>

      {state.status === "idle" ? (
        <section className="cc-section" data-verify-empty>
          <p
            style={{
              margin: 0,
              fontSize: 14,
              opacity: 0.75,
            }}
          >
            Paste an evidence ID above to inspect its verification state.
            Public verify links you've shared with external reviewers
            contain the same ID at the end of the URL.
          </p>
        </section>
      ) : null}

      {state.status === "loading" ? (
        <section className="cc-section" data-verify-loading>
          <p>Looking up verification state…</p>
        </section>
      ) : null}

      {state.status === "not_found" ? (
        <section className="cc-section" data-verify-not-found>
          <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>
            Evidence not found
          </h2>
          <p style={{ margin: 0, opacity: 0.85 }}>
            We could not find an evidence record with that ID in this
            workspace. Check the ID, or browse the evidence library to
            find the record you're looking for.
          </p>
        </section>
      ) : null}

      {state.status === "forbidden" ? (
        <section className="cc-section" data-verify-forbidden>
          <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>
            Permission required
          </h2>
          <p style={{ margin: 0, opacity: 0.85 }}>
            That evidence record exists, but your role doesn't include
            access to it. Ask the workspace admin or the record's owner
            to grant you access, or browse the records you can already
            see in the evidence library.
          </p>
        </section>
      ) : null}

      {state.status === "error" ? (
        <section className="cc-section" data-verify-error>
          <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>
            Verification lookup failed
          </h2>
          <p style={{ margin: 0, opacity: 0.85 }}>{state.message}</p>
        </section>
      ) : null}

      {state.status === "ready" ? (
        <VerifyResult
          evidenceId={state.evidenceId}
          data={state.data}
          publicVerifyUrl={publicVerifyUrl}
          copied={copied}
          onCopyPublicLink={() => void copyPublicLink()}
        />
      ) : null}
    </main>
  );
}

function VerifyResult({
  evidenceId,
  data,
  publicVerifyUrl,
  copied,
  onCopyPublicLink,
}: {
  evidenceId: string;
  data: WorkspaceShape;
  publicVerifyUrl: string | null;
  copied: boolean;
  onCopyPublicLink: () => void;
}) {
  const ev = data.evidence;
  const matrix = data.preservationMatrix;
  const trust = matrix?.trustDecision ?? null;
  const isPublished = ev.publicVerifyState === "PUBLISHED";

  const title = ev.title ?? ev.displayFileName ?? "Evidence record";

  return (
    <>
      <section className="cc-section" data-verify-result-summary>
        <header className="cc-section-header">
          <h2 className="cc-section-title">Trust summary</h2>
        </header>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 24,
            alignItems: "flex-start",
          }}
        >
          <div style={{ flex: "1 1 300px" }}>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                opacity: 0.6,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              Evidence
            </p>
            <h3 style={{ margin: "4px 0 0", fontSize: 16 }} data-verify-title>
              {title}
            </h3>
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 12,
                fontFamily: "monospace",
                opacity: 0.7,
              }}
            >
              ID: {evidenceId}
            </p>
          </div>
          <div style={{ flex: "1 1 240px" }}>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                opacity: 0.6,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              Record status
            </p>
            <p
              style={{ margin: "4px 0 0", fontSize: 14 }}
              data-verify-record-status
            >
              {ev.status}
              {ev.verificationStatus ? (
                <span style={{ opacity: 0.7 }}>
                  {" "}
                  · {ev.verificationStatus.replace(/_/g, " ")}
                </span>
              ) : null}
            </p>
          </div>
          {trust ? (
            <div style={{ flex: "1 1 240px" }}>
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  opacity: 0.6,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Trust decision
              </p>
              <p
                style={{ margin: "4px 0 0", fontSize: 14 }}
                data-verify-trust-verdict
              >
                {trust.verdictLabel ?? trust.verdict ?? "—"}
                {typeof trust.score === "number" &&
                typeof trust.maxScore === "number" ? (
                  <span style={{ opacity: 0.7 }}>
                    {" "}
                    · {trust.score}/{trust.maxScore}
                  </span>
                ) : null}
              </p>
              {trust.summary ? (
                <p style={{ margin: "6px 0 0", fontSize: 13, opacity: 0.85 }}>
                  {trust.summary}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="cc-section" data-verify-public-link>
        <header className="cc-section-header">
          <h2 className="cc-section-title">Public verify preview</h2>
        </header>
        {isPublished ? (
          <>
            <p style={{ margin: 0, fontSize: 14, opacity: 0.85 }}>
              This record is published. Anyone with the link below can see
              the public verify response — which is intentionally
              redacted: no submitter email, no workspace name, no
              organization name (Phase 1 PII protection).
            </p>
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 12,
                flexWrap: "wrap",
              }}
            >
              {publicVerifyUrl ? (
                <a
                  href={publicVerifyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-primary"
                  data-verify-open-public
                >
                  Open public verify ↗
                </a>
              ) : null}
              <button
                type="button"
                className="btn-secondary"
                onClick={onCopyPublicLink}
                data-verify-copy-public
              >
                {copied ? "Copied!" : "Copy public link"}
              </button>
              <Link
                href={`/evidence/${evidenceId}`}
                className="btn-secondary"
                data-verify-open-evidence
              >
                Open evidence detail
              </Link>
            </div>
          </>
        ) : (
          <>
            <p
              style={{ margin: 0, fontSize: 14, opacity: 0.85 }}
              data-verify-not-published
            >
              This record is <strong>not currently published</strong> to
              public verify
              {ev.publicVerifyState ? (
                <> (state: <code>{ev.publicVerifyState}</code>)</>
              ) : null}
              . The public verify URL would return 404 — that's by
              design. Internal review can still proceed via the evidence
              detail page.
            </p>
            <div style={{ marginTop: 12 }}>
              <Link
                href={`/evidence/${evidenceId}`}
                className="btn-primary"
                data-verify-open-evidence
              >
                Open evidence detail
              </Link>
            </div>
          </>
        )}
      </section>

      {trust?.signals && trust.signals.length > 0 ? (
        <section className="cc-section" data-verify-signals>
          <header className="cc-section-header">
            <h2 className="cc-section-title">Verification signals</h2>
          </header>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: 12,
            }}
          >
            {trust.signals.map((signal) => (
              <li
                key={signal.key}
                data-verify-signal={signal.key}
                data-verify-signal-status={signal.status}
                style={{
                  padding: "10px 12px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 8,
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: 12,
                    opacity: 0.6,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  {signal.label}
                </p>
                <p style={{ margin: "4px 0 0", fontSize: 13 }}>
                  {signal.summary ?? signal.status}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="cc-section" data-verify-artifacts>
        <header className="cc-section-header">
          <h2 className="cc-section-title">Deliverables</h2>
        </header>
        <div
          style={{
            display: "flex",
            gap: 24,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: "1 1 240px" }} data-verify-report>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                opacity: 0.6,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              Latest report
            </p>
            {matrix?.latestReport?.available ? (
              <>
                <p style={{ margin: "4px 0 0", fontSize: 14 }}>
                  v{matrix.latestReport.version ?? "—"}
                </p>
                <p style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.7 }}>
                  Generated{" "}
                  {matrix.latestReport.generatedAtUtc
                    ? new Date(matrix.latestReport.generatedAtUtc).toISOString()
                    : "—"}
                </p>
              </>
            ) : (
              <p style={{ margin: "4px 0 0", fontSize: 13, opacity: 0.8 }}>
                Not yet generated.
              </p>
            )}
          </div>
          <div style={{ flex: "1 1 240px" }} data-verify-package>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                opacity: 0.6,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              Verification package
            </p>
            {matrix?.latestVerificationPackage?.available ? (
              <>
                <p style={{ margin: "4px 0 0", fontSize: 14 }}>
                  v{matrix.latestVerificationPackage.version ?? "—"}
                </p>
                <p style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.7 }}>
                  Generated{" "}
                  {matrix.latestVerificationPackage.generatedAtUtc
                    ? new Date(
                        matrix.latestVerificationPackage.generatedAtUtc,
                      ).toISOString()
                    : "—"}
                </p>
              </>
            ) : (
              <p style={{ margin: "4px 0 0", fontSize: 13, opacity: 0.8 }}>
                Not yet generated.
              </p>
            )}
          </div>
        </div>
      </section>

      {data.legalBoundary ? (
        <section className="cc-section" data-verify-legal-boundary>
          <header className="cc-section-header">
            <h2 className="cc-section-title">Legal boundary</h2>
          </header>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.85 }}>
            {data.legalBoundary}
          </p>
        </section>
      ) : null}
    </>
  );
}

export default function VerifyWorkspacePage() {
  // PageRouteGate enforces capability + workspace gating consistently
  // with every other workspace surface. EVIDENCE_VIEW is the right
  // gate — the underlying review-workspace endpoint already requires
  // read access on the specific evidence record (so this gate only
  // controls page-level discoverability).
  return (
    <PageRouteGate routeId="workspace.evidence">
      <VerifyWorkspaceInner />
    </PageRouteGate>
  );
}
