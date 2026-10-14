/**
 * ARCHIVED EVIDENCE — native (owner decision 2026-10-14). The Retention
 * Archive: records that left the 90-day Trash while a retention barrier still
 * applies. Read-only; restorable only through the verified archive restore.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import {
  ARCHIVE_EXPLAINER_COPY,
  ARCHIVE_RESTORE_CONFIRM_COPY,
  ARCHIVE_RESTORE_FAILED_COPY,
  RETENTION_BARRIER_COPY,
  buildRetentionArchivePath,
  buildArchiveRestorePath,
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
  const [items, setItems] = useState<NativeArchiveItem[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      setItems(parseRetentionArchive(await apiFetch(buildRetentionArchivePath())).items);
      setPhase("ready");
    } catch (err) {
      setError(toSafeUserError(err));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = useCallback(
    (item: NativeArchiveItem) => {
      Alert.alert("Restore from the retention archive?", ARCHIVE_RESTORE_CONFIRM_COPY, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Request restore",
          onPress: () => {
            void (async () => {
              setBusy(item.id);
              try {
                await apiFetch(buildArchiveRestorePath(item.id), {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ clientRequestKey: requestKey() }),
                });
                await load();
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
    [load],
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
          <ProovraErrorState message={error.message} onRetry={load} />
        ) : items.length === 0 ? (
          <ProovraEmptyState title="No archived evidence" message={ARCHIVE_EXPLAINER_COPY} />
        ) : (
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
                ]
                  .filter(Boolean)
                  .join(" · ")}
                trailing={
                  item.restoreInProgress ? (
                    <ProovraBadge tone="neutral" label="Restoring" />
                  ) : item.restoreAvailable ? (
                    <ProovraButton
                      label={busy === item.id ? "Requesting…" : "Restore"}
                      variant="secondary"
                      fullWidth={false}
                      onPress={() => restore(item)}
                    />
                  ) : (
                    <ProovraBadge tone="governance" label="Retained" />
                  )
                }
              />
            ))}
          </ProovraCard>
        )}
      </ProovraSection>
    </ProovraScreen>
  );
}
