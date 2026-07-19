"use client";

/**
 * Reusable Trust Center section list — 2026-07-18 canonical redesign.
 *
 * Renders the backend-published trust articles (METHODOLOGY /
 * AI_DISCLOSURE / SECURITY) inside the ONE canonical legal-document
 * shell (`LegalDocumentShell`), so authenticated trust documentation
 * uses the exact same hero family, page background, reading width, and
 * typography as the public /legal/[slug] pages. The legacy inline
 * admin-styled header/cards/raw preformatted bodies are deleted.
 *
 * Behavior preserved from Phase 4A:
 *  - 4-phase load state (loading / loaded / empty / degraded / error)
 *    with bounded vocabulary (no env names / stack traces),
 *  - drift badges + implementation-reference disclosures,
 *  - all data-* contract markers.
 */

import { useCallback, useEffect, useState } from "react";

import type {
  TrustArticleKind,
  TrustArticleProjection,
} from "@proovra/shared";

import { apiFetch } from "../../../lib/api";
import { LegalDocumentShell } from "../../../components/legal/LegalDocumentShell";
import { LEGAL_META_CLASSES } from "../../../components/legal/legalArticleStyles";
import { DriftBadge } from "./_drift-badge";

type LoadState =
  | { phase: "loading" }
  | { phase: "loaded"; articles: ReadonlyArray<TrustArticleProjection> }
  | { phase: "empty" }
  | { phase: "degraded"; reason: string }
  | { phase: "error"; message: string };

type TrustArticleListResponse = {
  articles?: ReadonlyArray<TrustArticleProjection> | null;
  degraded?: boolean;
  reason?: string | null;
};

function degradedMessage(reason: string) {
  switch (reason) {
    case "SCHEMA_NOT_READY":
      return "This Trust Center section is temporarily degraded because the required backend schema is not ready yet.";
    case "DB_UNAVAILABLE":
      return "This Trust Center section is temporarily degraded because the database is unavailable.";
    case "ARTICLE_AUTO_SEED_FAILED":
      return "This Trust Center section is temporarily degraded because the canonical seed content could not be prepared.";
    case "ARTICLE_READ_FAILED":
    default:
      return "This Trust Center section is temporarily degraded because trust content could not be loaded safely.";
  }
}

/** Article bodies are stored as plain text — render as document paragraphs. */
function BodyParagraphs({ body }: { body: string }) {
  const blocks = body
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  return (
    <>
      {blocks.map((block, i) => (
        <p key={i} style={{ whiteSpace: "pre-line" }}>
          {block}
        </p>
      ))}
    </>
  );
}

export function TrustCenterSectionList({
  kind,
  title,
  description,
  anchor,
  heroChildren,
  beforeArticles,
  relatedLinks,
}: {
  kind: TrustArticleKind;
  title: string;
  description: string;
  anchor: string;
  /** Optional canonical hero callout slot (e.g. legal-counterpart link). */
  heroChildren?: React.ReactNode;
  /** Optional content rendered above the article sections, inside the doc card. */
  beforeArticles?: React.ReactNode;
  relatedLinks?: ReadonlyArray<{ label: string; href: string }>;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setState({ phase: "loading" });
    try {
      const res = (await apiFetch(`/v1/trust/articles?kind=${kind}`, {
        method: "GET",
      })) as TrustArticleListResponse | null;
      if (res?.degraded) {
        setState({
          phase: "degraded",
          reason: String(res.reason ?? "ARTICLE_READ_FAILED"),
        });
        return;
      }
      const list = (res?.articles ?? []) as ReadonlyArray<
        TrustArticleProjection
      >;
      if (list.length === 0) {
        setState({ phase: "empty" });
      } else {
        setState({ phase: "loaded", articles: list });
      }
    } catch {
      // Bounded operator-facing message. We never expose internal
      // error codes / env names / stack traces here.
      setState({
        phase: "error",
        message:
          "Trust Center articles could not be loaded. Press Retry to try again.",
      });
    } finally {
      setBusy(false);
    }
  }, [kind]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const articles = state.phase === "loaded" ? state.articles : [];

  return (
    <div data-trust-center-page={anchor}>
      <LegalDocumentShell
        label="Trust documentation"
        title={title}
        summary={description}
        scope="ACCOUNT"
        backHref="/trust"
        backLabel="Back to Trust Center"
        heroChildren={heroChildren}
        relatedLinks={relatedLinks}
      >
        {beforeArticles}

        <div className="mb-6 flex items-center justify-between gap-3">
          <span className={LEGAL_META_CLASSES}>
            Published for the active workspace · implementation-backed
          </span>
          <button
            type="button"
            className="rounded-lg border border-[#DDE6F2] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#0F172A] hover:border-[#94A3B8] disabled:opacity-60"
            data-trust-center-page-refresh={anchor}
            onClick={() => void refresh()}
            disabled={busy}
          >
            {busy ? "Loading…" : state.phase === "error" ? "Retry" : "Refresh"}
          </button>
        </div>

        {state.phase === "loading" ? (
          <p data-trust-center-page-phase="loading" aria-live="polite">
            Loading articles…
          </p>
        ) : null}

        {state.phase === "error" ? (
          <div
            data-trust-center-page-phase="error"
            role="alert"
            className="rounded-lg border border-[rgba(185,28,28,0.20)] bg-[rgba(185,28,28,0.06)] px-4 py-3 text-[0.9rem] text-[#7f1d1d]"
          >
            {state.message}
          </div>
        ) : null}

        {state.phase === "degraded" ? (
          <div
            data-trust-center-page-phase="degraded"
            data-trust-center-page-reason={state.reason}
            className="grid gap-1.5 rounded-lg border border-[rgba(148,163,184,0.28)] bg-[rgba(148,163,184,0.10)] px-4 py-3 text-[0.9rem] text-[#334155]"
          >
            <div>{degradedMessage(state.reason)}</div>
            <div>
              Reason: <code>{state.reason}</code>
            </div>
          </div>
        ) : null}

        {state.phase === "empty" ? (
          <p data-trust-center-page-phase="empty">
            This Trust Center section is not published for the active workspace
            yet.
          </p>
        ) : null}

        {state.phase === "loaded"
          ? articles.map((a) => (
              <section
                key={a.id}
                data-trust-center-page-section={a.section}
                data-trust-article-state={a.state}
                data-trust-article-version={a.version}
              >
                <h2 id={a.section}>{a.title}</h2>
                <div className={`-mt-2 mb-4 ${LEGAL_META_CLASSES}`}>
                  <code>{a.section}</code> · Version {a.version} · {a.state}
                  {a.driftState ? <DriftBadge state={a.driftState} /> : null}
                </div>
                <p>
                  <strong>{a.summary}</strong>
                </p>
                <BodyParagraphs body={a.body} />
                {a.implementationReferences.length > 0 ? (
                  <details
                    data-trust-center-page-references={a.section}
                    className="mb-6 mt-2"
                  >
                    <summary
                      className={`cursor-pointer ${LEGAL_META_CLASSES}`}
                      style={{ fontWeight: 600 }}
                    >
                      Implementation references · {a.implementationReferences.length}
                    </summary>
                    <div className="mt-2 leading-[1.9]">
                      {a.implementationReferences.map((r) => (
                        <code key={r} className="mb-1 mr-1.5 inline-block">
                          {r}
                        </code>
                      ))}
                    </div>
                  </details>
                ) : null}
                <hr />
              </section>
            ))
          : null}
      </LegalDocumentShell>
    </div>
  );
}
