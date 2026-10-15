"use client";

/**
 * ARCHIVED EVIDENCE — the Retention Archive (owner decision 2026-10-14).
 *
 * Records that left the 90-day Trash while PROOVRA must still preserve them.
 * They are not active (read-only, not in the library or Trash), they are not
 * deleted (their preserved versions still exist), and they come back only
 * through the verified restore: every required stored version and digest is
 * checked before the record becomes active again, with the same identity.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RETENTION_ARCHIVE_EXPLAINER_COPY } from "@proovra/shared";

import { AppStatusBadge } from "../../../../components/app-primitives";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageSection } from "../../../../components/ui/PageShell";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Button } from "../../../../components/ui/Button";
import { useToast } from "../../../../components/ui";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { notifyApiError } from "../../../../lib/feedback/notify";
import { formatUserDate, formatUserDateTime } from "../../../../lib/date";
import {
  ARCHIVE_RESTORE_FAILURE_LABEL,
  RETENTION_BARRIER_LABEL,
  getArchiveRestoreStatus,
  listRetentionArchive,
  requestArchiveRestore,
  type RetentionArchiveItem,
} from "../../../../lib/api/retention-archive";

function newRequestKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

// Gated with the Evidence library's own route: the archive is part of it, and
// the API enforces evidence.archive.view per record.
export default function RetentionArchivePage() {
  return (
    <PageRouteGate routeId="workspace.evidence">
      <RetentionArchivePageInner />
    </PageRouteGate>
  );
}

function RetentionArchivePageInner() {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const [items, setItems] = useState<RetentionArchiveItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (after: string | null = null) => {
    try {
      const page = await listRetentionArchive(after);
      setItems((prev) => (after ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setState("ready");
    } catch {
      setState("unavailable");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A restore in progress is verified by the worker; poll each one's own
  // request until it settles, then refresh the list (a completed record
  // leaves the archive; a failed one stays with its reason).
  useEffect(() => {
    const pending = items.filter((i) => i.restore.inProgress).map((i) => i.id);
    if (pending.length === 0) return;
    const timer = setInterval(() => {
      void (async () => {
        for (const id of pending) {
          try {
            const { request } = await getArchiveRestoreStatus(id);
            if (request && (request.status === "COMPLETED" || request.status === "FAILED")) {
              if (request.status === "COMPLETED") addToast("Record restored to your Evidence library", "success");
              await load();
              return;
            }
          } catch {
            /* the next tick asks again */
          }
        }
      })();
    }, 5000);
    return () => clearInterval(timer);
  }, [items, load, addToast]);

  const restore = async (item: RetentionArchiveItem) => {
    const ok = await confirm({
      title: "Restore this record from the retention archive?",
      description:
        "PROOVRA first verifies every stored version of the evidence and its reports and packages. If everything checks out, the record returns to your Evidence library with the same identity, history and verification page. If anything is missing or does not match, the record stays archived and nothing is changed. Restoring uses no evidence allowance.",
      confirmLabel: "Request restore",
      testId: "archive-restore-confirm",
    });
    if (!ok) return;
    setBusy(item.id);
    try {
      const res = await requestArchiveRestore(item.id, newRequestKey());
      addToast(
        res.deduplicated ? "A restore is already in progress for this record" : "Restore requested — verification has started",
        "success",
      );
      await load();
    } catch (err) {
      notifyApiError(addToast, err, { message: "The restore could not be requested." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageShell
      title="Archived evidence"
      subtitle={RETENTION_ARCHIVE_EXPLAINER_COPY}
    >
      <PageSection>
        {state === "loading" ? <p className="app-field__help">Loading archived evidence…</p> : null}
        {state === "unavailable" ? (
          <EmptyState
            title="Archived evidence is temporarily unavailable"
            purpose="The list could not be loaded right now. Nothing has changed with your records."
            action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>}
            data-archive-state="unavailable"
          />
        ) : null}
        {state === "ready" && items.length === 0 ? (
          <EmptyState
            title="No archived evidence"
            purpose="Records appear here when they leave the 90-day Trash while their retention protection still applies."
            action={<Link href="/evidence">Back to Evidence</Link>}
            data-archive-state="empty"
          />
        ) : null}
        {state === "ready" && items.length > 0 ? (
          <ul className="evidence-detail-link-list" data-archive-list>
            {items.map((item) => {
              const failure = item.restore.lastRequest?.status === "FAILED" ? item.restore.lastRequest : null;
              return (
                <li key={item.id} className="evidence-detail-link-row" data-archive-item={item.id}>
                  <div className="evidence-detail-link-row__main">
                    <strong>{item.title ?? "Untitled record"}</strong>
                    <AppStatusBadge tone="amber">Archived — retained</AppStatusBadge>
                    {item.restore.inProgress ? <AppStatusBadge tone="slate">Restore in progress</AppStatusBadge> : null}
                  </div>
                  <dl className="evidence-detail-sharing-grid">
                    <div className="evidence-detail-sharing-fact">
                      <dt className="evidence-detail-sharing-fact__label">Archived</dt>
                      <dd className="evidence-detail-sharing-fact__value">{formatUserDateTime(item.archivedAtUtc) ?? "—"}</dd>
                    </div>
                    <div className="evidence-detail-sharing-fact">
                      <dt className="evidence-detail-sharing-fact__label">Reason</dt>
                      <dd className="evidence-detail-sharing-fact__value">
                        Retention — {RETENTION_BARRIER_LABEL[item.retentionBarrier ?? ""] ?? "Retention protection"}
                      </dd>
                    </div>
                    <div className="evidence-detail-sharing-fact">
                      <dt className="evidence-detail-sharing-fact__label">Earliest possible permanent deletion</dt>
                      <dd className="evidence-detail-sharing-fact__value" data-archive-earliest-purge>
                        {item.earliestPurgeAtUtc ? formatUserDate(item.earliestPurgeAtUtc) : "Not before retention is confirmed"}
                      </dd>
                    </div>
                    {item.legalHold !== null ? (
                      <div className="evidence-detail-sharing-fact">
                        <dt className="evidence-detail-sharing-fact__label">Legal hold</dt>
                        <dd className="evidence-detail-sharing-fact__value">{item.legalHold ? "Active" : "None"}</dd>
                      </div>
                    ) : null}
                    {item.verificationReference ? (
                      <div className="evidence-detail-sharing-fact">
                        <dt className="evidence-detail-sharing-fact__label">Verification reference</dt>
                        <dd className="evidence-detail-sharing-fact__value">
                          <code>{item.verificationReference}</code>
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  {failure ? (
                    <p className="app-field__help" role="status" data-archive-restore-failed>
                      The last restore stopped: {ARCHIVE_RESTORE_FAILURE_LABEL[failure.failureCode ?? ""] ?? "verification did not complete."}{" "}
                      The record stays archived and nothing was changed.
                    </p>
                  ) : null}
                  <div className="evidence-detail-link-row__actions">
                    {item.restore.available ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busy === item.id}
                        onClick={() => void restore(item)}
                        data-archive-action="restore"
                      >
                        Restore
                      </Button>
                    ) : item.restore.inProgress ? (
                      <span className="app-field__help">Verification in progress — this updates automatically.</span>
                    ) : (
                      <span className="app-field__help">Restoring needs an owner or administrator.</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {state === "ready" && cursor ? (
          <Button variant="secondary" onClick={() => void load(cursor)}>
            Load more
          </Button>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
