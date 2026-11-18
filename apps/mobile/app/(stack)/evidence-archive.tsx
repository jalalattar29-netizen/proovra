/**
 * ARCHIVED EVIDENCE — native (owner decision 2026-10-14). The Retention
 * Archive: records that left the 90-day Trash while a retention barrier still
 * applies. Read-only; restorable only through the verified archive restore.
 *
 * The list is account-wide (the route reads the caller's personal records and
 * every workspace whose role may view the archive, per record), so a workspace
 * switch does not change it. Free audit 0ea0 (SN-0040) brought it level with
 * the web page: every page is reachable (NAT-ARC-01), Restore is one request
 * (NAT-ARC-02), a restore in progress updates itself (NAT-ARC-03), and a record
 * the caller cannot restore says who can (NAT-ARC-04).
 */
import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { useToast } from "../../src/toast-context";
import {
  ARCHIVE_EXPLAINER_COPY,
  ARCHIVE_RESTORE_COMPLETED_COPY,
  ARCHIVE_RESTORE_CONFIRM_COPY,
  ARCHIVE_RESTORE_DEDUPLICATED_COPY,
  ARCHIVE_RESTORE_FAILED_COPY,
  ARCHIVE_RESTORE_IN_PROGRESS_COPY,
  ARCHIVE_RESTORE_NOT_PERMITTED_COPY,
  ARCHIVE_RESTORE_POLL_MS,
  ARCHIVE_RESTORE_REQUESTED_COPY,
  RETENTION_BARRIER_COPY,
  buildRetentionArchivePagePath,
  buildArchiveRestorePath,
  isArchiveRestoreSettled,
  parseArchiveRestoreRequested,
  parseArchiveRestoreStatus,
  parseRetentionArchive,
  type NativeArchiveItem,
} from "../../src/product/retention-archive";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../src/ui";

type Phase = "loading" | "ready" | "error";

function requestKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export default function EvidenceArchiveScreen() {
  const router = useRouter();
  const { addToast } = useToast();
  const [items, setItems] = useState<NativeArchiveItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  /**
   * The first page. `quiet` keeps the list on screen while it is re-read
   * (after a restore request, or when a polled restore settles).
   */
  const load = useCallback(async (opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) {
      setPhase("loading");
      setError(null);
    }
    try {
      const page = parseRetentionArchive(await apiFetch(buildRetentionArchivePagePath(null)));
      setItems(page.items);
      setCursor(page.nextCursor);
      setPhase("ready");
    } catch (err) {
      if (opts.quiet) return; // the list on screen stays; the next refresh asks again
      setError(toSafeUserError(err));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // NAT-ARC-01 — the next page, appended (web: "Load more").
  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = parseRetentionArchive(await apiFetch(buildRetentionArchivePagePath(cursor)));
      setItems((prev) => [...prev, ...page.items.filter((i) => !prev.some((p) => p.id === i.id))]);
      setCursor(page.nextCursor);
    } catch (err) {
      Alert.alert("Could not load more archived evidence", toSafeUserError(err).message);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor]);

  // NAT-ARC-03 — a restore in progress is verified by the worker; ask about
  // each one's own request until it settles, then re-read the list (a
  // completed record leaves the archive; a failed one stays with its reason).
  const pending = items.filter((i) => i.restoreInProgress).map((i) => i.id).join(",");
  useEffect(() => {
    if (!pending) return;
    const ids = pending.split(",");
    let disposed = false;
    const timer = setInterval(() => {
      void (async () => {
        for (const id of ids) {
          try {
            const latest = parseArchiveRestoreStatus(await apiFetch(buildArchiveRestorePath(id)));
            if (disposed) return;
            if (latest && isArchiveRestoreSettled(latest.status)) {
              if (latest.status === "COMPLETED") addToast(ARCHIVE_RESTORE_COMPLETED_COPY, "success");
              await load({ quiet: true });
              return;
            }
          } catch {
            /* the next tick asks again */
          }
        }
      })();
    }, ARCHIVE_RESTORE_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [pending, load, addToast]);

  const restore = useCallback(
    (item: NativeArchiveItem) => {
      if (busy) return;
      Alert.alert("Restore from the retention archive?", ARCHIVE_RESTORE_CONFIRM_COPY, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Request restore",
          onPress: () => {
            void (async () => {
              setBusy(item.id);
              try {
                const answer = parseArchiveRestoreRequested(
                  await apiFetch(buildArchiveRestorePath(item.id), {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ clientRequestKey: requestKey() }),
                  }),
                );
                addToast(answer.deduplicated ? ARCHIVE_RESTORE_DEDUPLICATED_COPY : ARCHIVE_RESTORE_REQUESTED_COPY, "success");
                await load({ quiet: true });
              } catch (err) {
                Alert.alert("Could not request the restore", toSafeUserError(err).message);
              } finally {
                setBusy(null);
              }
            })();
          },
        },
      ]);
    },
    [busy, load, addToast],
  );

  return (
    <ProovraScreen shell>
      <ProovraSection
        title="Archived evidence"
        action={<ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />}
      >
        {phase === "loading" ? (
          <ProovraLoadingState label="Loading archived evidence…" />
        ) : phase === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={() => void load()} />
        ) : items.length === 0 ? (
          <ProovraEmptyState title="No archived evidence" message={ARCHIVE_EXPLAINER_COPY} />
        ) : (
          <>
            <ProovraCard>
              {items.map((item) => (
                <ProovraListRow
                  key={item.id}
                  title={item.title}
                  subtitle={[
                    item.archivedAtUtc ? `Archived ${formatUserDateTime(item.archivedAtUtc)}` : null,
                    `Retention — ${RETENTION_BARRIER_COPY[item.barrier ?? ""] ?? "Retention protection"}`,
                    item.earliestPurgeAtUtc ? `Not deletable before ${formatUserDateTime(item.earliestPurgeAtUtc)}` : null,
                    item.legalHold === true ? "Legal hold active" : null,
                    item.lastFailureCode ? ARCHIVE_RESTORE_FAILED_COPY : null,
                    item.restoreInProgress
                      ? ARCHIVE_RESTORE_IN_PROGRESS_COPY
                      : item.restoreAvailable
                        ? null
                        : ARCHIVE_RESTORE_NOT_PERMITTED_COPY,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  trailing={
                    item.restoreInProgress ? (
                      <ProovraBadge tone="neutral" label="Restoring" />
                    ) : item.restoreAvailable ? (
                      <ProovraButton
                        label="Restore"
                        variant="secondary"
                        fullWidth={false}
                        loading={busy === item.id}
                        disabled={busy !== null}
                        testID={`archive-restore-${item.id}`}
                        onPress={() => restore(item)}
                      />
                    ) : (
                      <ProovraBadge tone="governance" label="Retained" />
                    )
                  }
                />
              ))}
            </ProovraCard>
            {cursor ? (
              <ProovraButton label="Load more" variant="secondary" loading={loadingMore} onPress={() => void loadMore()} />
            ) : null}
          </>
        )}
      </ProovraSection>
    </ProovraScreen>
  );
}
