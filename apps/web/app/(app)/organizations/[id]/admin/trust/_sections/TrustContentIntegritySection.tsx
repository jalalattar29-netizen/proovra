"use client";

/**
 * PHASE 12 VERTICAL C — Trust content integrity.
 *
 * The operator answer to "is what we PUBLISH about ourselves still true?".
 * Backed by three canonical operations, none of which had a product
 * consumer before this pass:
 *
 *   GET  /v1/trust/drift/stale        — articles whose cited implementation
 *                                       references no longer resolve.
 *   POST /v1/trust/drift/scan         — re-run the reference scan.
 *   POST /v1/trust/articles/seed      — restore the canonical platform
 *                                       articles.
 *
 * Publication safety: the re-seed defaults to DRAFT. Publishing the seed is
 * a separate, deliberate action that the SERVER gates on
 * `governance.policy.manage` plus a fresh target-bound step-up — the browser
 * decides nothing, it only offers the choice and carries the challenge
 * header through `useStepUpAction`.
 *
 * The stale list contains INTERNAL repository paths. They are operator
 * diagnostics and never leave this authenticated surface.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../../../lib/api";
import { formatUserDateTime } from "../../../../../../../lib/date";
import { useTenantGuard } from "../../../../../../../lib/platform-context";
import { Button } from "../../../../../../../components/ui/Button";
import { Card } from "../../../../../../../components/ui/Card";
import { Badge } from "../../../../../../../components/ui/Badge";
import { EmptyState } from "../../../../../../../components/ui/EmptyState";
import { useConfirmAction } from "../../../../../../../components/ui/ConfirmActionModal";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../../../components/identity-security/StepUpModal";
import {
  classifyTrustPhase,
  isStepUpCancel,
  mutedStyle,
  type TrustFailure,
} from "./_shared";

type StaleArticle = {
  id: string;
  kind: string;
  slug: string;
  title: string;
  missingReferences: string[];
  lastReferenceCheckAtUtc: string | null;
};

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; articles: StaleArticle[] }
  | TrustFailure;

type ActionNote =
  | { tone: "ok"; text: string }
  | { tone: "warn"; text: string }
  | null;

export function TrustContentIntegritySection({
  teamId,
}: {
  teamId: string | null;
}) {
  const { stamp, isStale } = useTenantGuard();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [busy, setBusy] = useState<"scan" | "seed" | "publish" | null>(null);
  const [note, setNote] = useState<ActionNote>(null);

  const load = useCallback(async () => {
    const captured = stamp();
    setPhase({ kind: "loading" });
    try {
      const res = (await apiFetch("/v1/trust/drift/stale", {
        method: "GET",
      })) as { articles?: StaleArticle[] };
      if (isStale(captured)) return;
      setPhase({ kind: "ready", articles: res.articles ?? [] });
    } catch (err) {
      if (isStale(captured)) return;
      setPhase(
        classifyTrustPhase(err, {
          deniedTitle: "You can't review trust content integrity",
          deniedDetail:
            "Your role in this workspace does not allow reading trust-content drift. Nothing was loaded and nothing was changed.",
          errorMessage: "Could not load trust-content drift.",
        }),
      );
    }
  }, [stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const runScan = useCallback(async () => {
    const captured = stamp();
    setBusy("scan");
    setNote(null);
    try {
      const res = (await apiFetch("/v1/trust/drift/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })) as {
        result?: { scanned: number; stale: number; missingReferenceCount: number };
      };
      if (isStale(captured)) return;
      const r = res.result;
      setNote({
        tone: r && r.stale > 0 ? "warn" : "ok",
        text: r
          ? `Checked ${r.scanned} article${r.scanned === 1 ? "" : "s"}. ${r.stale} now need attention (${r.missingReferenceCount} reference${r.missingReferenceCount === 1 ? "" : "s"} no longer resolve).`
          : "Scan finished.",
      });
      // Always re-read the SERVER projection after a mutation — the list
      // below is never patched in the browser.
      await load();
    } catch (err) {
      if (isStale(captured)) return;
      const failure = classifyTrustPhase(err, {
        deniedTitle: "You can't run a drift scan",
        deniedDetail:
          "Running a drift scan requires trust-governance management in this workspace.",
        errorMessage: "Could not run the drift scan.",
      });
      setNote({
        tone: "warn",
        text: failure.kind === "denied" ? failure.detail : failure.detail,
      });
    } finally {
      setBusy(null);
    }
  }, [stamp, isStale, load]);

  const runSeed = useCallback(
    async (publish: boolean) => {
      const ok = await confirm(
        publish
          ? {
              title: "Publish the canonical trust articles?",
              description:
                "This replaces the platform trust articles in this workspace AND publishes them to the Trust Center immediately. You will be asked to re-verify before it runs.",
              confirmLabel: "Publish trust articles",
              tone: "warning",
              testId: "trust-seed-publish",
            }
          : {
              title: "Restore the canonical trust articles as drafts?",
              description:
                "The platform trust articles are restored in DRAFT. Nothing becomes visible on the Trust Center until someone reviews and publishes it.",
              confirmLabel: "Restore as drafts",
              tone: "neutral",
              testId: "trust-seed-draft",
            },
      );
      if (!ok) return;
      const captured = stamp();
      setBusy(publish ? "publish" : "seed");
      setNote(null);
      try {
        const res = (await stepUp.runStepUpAction(async (headers) =>
          apiFetch("/v1/trust/articles/seed", {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({ publish }),
          }),
        )) as { created?: number; updated?: number; published?: boolean };
        if (isStale(captured)) return;
        setNote({
          tone: "ok",
          text: `${res.created ?? 0} article${res.created === 1 ? "" : "s"} added, ${res.updated ?? 0} refreshed — ${res.published ? "published to the Trust Center" : "saved as drafts for review"}.`,
        });
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        if (isStepUpCancel(err)) {
          setNote({ tone: "warn", text: "Verification cancelled. Nothing changed." });
          return;
        }
        const failure = classifyTrustPhase(err, {
          deniedTitle: "You can't restore trust articles",
          deniedDetail:
            "Restoring published trust articles requires trust-governance management in this workspace.",
          errorMessage: "Could not restore the trust articles.",
        });
        setNote({ tone: "warn", text: failure.detail });
      } finally {
        setBusy(null);
      }
    },
    [confirm, stamp, isStale, stepUp, load],
  );

  return (
    <>
      <Card
        variant="admin"
        padding="comfortable"
        title="Trust content integrity"
        data-testid="trust-content-integrity"
      >
        <p style={{ ...mutedStyle, marginTop: 0, maxWidth: 720 }}>
          Every trust article cites the parts of the platform that make its
          claim true. This check re-resolves those citations and flags any
          article whose evidence has moved or disappeared, so nothing stays
          published that the product no longer backs.
        </p>

        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            margin: "12px 0",
          }}
        >
          <Button
            variant="primary"
            size="sm"
            disabled={busy !== null}
            loading={busy === "scan"}
            onClick={() => void runScan()}
            data-testid="trust-drift-scan"
          >
            Re-check citations
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            loading={busy === "seed"}
            onClick={() => void runSeed(false)}
            data-testid="trust-seed-draft-button"
          >
            Restore articles as drafts
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            loading={busy === "publish"}
            onClick={() => void runSeed(true)}
            data-testid="trust-seed-publish-button"
          >
            Restore and publish
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void load()}
          >
            Refresh
          </Button>
        </div>

        {note ? (
          <p
            data-testid="trust-content-integrity-note"
            data-tone={note.tone}
            style={{
              ...mutedStyle,
              color: note.tone === "warn" ? "#92400e" : "#166534",
              margin: "0 0 12px",
            }}
          >
            {note.text}
          </p>
        ) : null}

        {phase.kind === "loading" ? (
          <p style={mutedStyle} data-testid="trust-content-integrity-loading">
            Re-reading trust content…
          </p>
        ) : null}

        {phase.kind === "denied" ? (
          <Card
            variant="status"
            tone="risk"
            padding="comfortable"
            data-testid="trust-content-integrity-denied"
          >
            <strong style={{ fontSize: 14 }}>{phase.title}</strong>
            <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 0, maxWidth: 620 }}>
              {phase.detail}
            </p>
          </Card>
        ) : null}

        {phase.kind === "error" ? (
          <Card
            variant="status"
            tone="risk"
            padding="comfortable"
            data-testid="trust-content-integrity-error"
          >
            <strong style={{ fontSize: 14 }}>That didn&apos;t load</strong>
            <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 10 }}>
              {phase.detail}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </Card>
        ) : null}

        {phase.kind === "ready" && phase.articles.length === 0 ? (
          <EmptyState
            compact
            framed
            title="Every trust article still checks out"
            purpose="No published article cites anything that has gone missing. Re-check after a release to keep this honest."
          />
        ) : null}

        {phase.kind === "ready" && phase.articles.length > 0 ? (
          <ul
            style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}
            data-testid="trust-stale-articles"
          >
            {phase.articles.map((a) => (
              <li
                key={a.id}
                data-stale-article={a.slug}
                style={{
                  border: "1px solid rgba(15, 23, 42, 0.10)",
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                <div
                  style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                >
                  <strong style={{ fontSize: 13 }}>{a.title}</strong>
                  <Badge tone="risk" subtle>
                    Needs attention
                  </Badge>
                  <span style={mutedStyle}>{a.kind.toLowerCase().replace(/_/g, " ")}</span>
                </div>
                <p style={{ ...mutedStyle, margin: "6px 0 0" }}>
                  {a.missingReferences.length} citation
                  {a.missingReferences.length === 1 ? "" : "s"} no longer resolve
                  {a.lastReferenceCheckAtUtc
                    ? ` · last checked ${formatUserDateTime(a.lastReferenceCheckAtUtc)}`
                    : ""}
                </p>
                {a.missingReferences.length > 0 ? (
                  <ul style={{ ...mutedStyle, margin: "6px 0 0", paddingLeft: 18 }}>
                    {a.missingReferences.slice(0, 6).map((ref) => (
                      <li key={ref}>
                        <code style={{ fontSize: 11 }}>{ref}</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      <StepUpModal control={stepUp} />
    </>
  );
}
