/**
 * BATCH ANALYSIS — the native port of
 * `apps/web/app/(app)/operations/batch-analysis`, over `GET /v1/batch-analysis`.
 *
 * Read-only, matching the web surface's primary job: see the jobs and their
 * progress. Creating and cancelling jobs stay on the web for now; that gap is
 * recorded in the ledger rather than stubbed with a button that does nothing.
 *
 * Self-service and out of every nav surface, exactly as the web keeps it.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { formatUserDateTime } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraPageHeader,
  ProovraResultCount,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
} from "../../../src/ui";
import {
  BATCH_ANALYSIS_PATH,
  batchStatusLabel,
  batchStatusTone,
  parseBatchJobs,
  sortBatchJobs,
  type BatchJob,
} from "../../../src/product/operations";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; jobs: BatchJob[] }
  | { phase: "failed" };

function JobRow({ job }: { job: BatchJob }) {
  const tone = batchStatusTone(job.status);
  const palette = theme.color.status[tone];

  return (
    <View style={{ gap: theme.space.s2 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.space.s2 }}>
        <View style={{ flex: 1 }}>
          <ProovraText variant="body" weight="semibold" numberOfLines={2}>
            {job.name}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {`${job.processedItems} processed · ${job.failedItems} failed · ${job.totalItems} total`}
          </ProovraText>
        </View>
        <ProovraBadge label={batchStatusLabel(job.status)} tone={tone} />
      </View>

      {job.progress === null ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          This job declares no items, so it has no progress to report.
        </ProovraText>
      ) : (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={`${job.name}: ${job.progress}% complete`}
          style={{
            height: 8,
            borderRadius: 4,
            backgroundColor: theme.color.surface.muted,
            overflow: "hidden",
          }}
        >
          <View style={{ width: `${job.progress}%`, height: "100%", backgroundColor: palette.solid }} />
        </View>
      )}

      <ProovraText variant="label" color={theme.color.ink.muted}>
        {job.completedAtIso
          ? `Completed ${formatUserDateTime(job.completedAtIso)}`
          : job.createdAtIso
            ? `Started ${formatUserDateTime(job.createdAtIso)}`
            : ""}
      </ProovraText>
    </View>
  );
}

export default function BatchAnalysisScreen() {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const data = await apiFetch(BATCH_ANALYSIS_PATH);
      setState({ phase: "loaded", jobs: sortBatchJobs(parseBatchJobs(data)) });
    } catch {
      setState({ phase: "failed" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProovraScreen testID="operations-batch-analysis">
      <ProovraPageHeader
        title="Batch analysis"
        eyebrow="Operations"
        subtitle="Batch processing jobs and queue status."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {state.phase === "loading" ? <ProovraLoadingState label="Loading jobs" /> : null}

      {state.phase === "failed" ? (
        <ProovraErrorState message="Batch jobs could not be loaded." onRetry={() => void load()} />
      ) : null}

      {state.phase === "loaded" && state.jobs.length === 0 ? (
        <ProovraEmpty
          presence="page"
          title="No batch jobs"
          purpose="Batch jobs you start appear here with their progress."
        />
      ) : null}

      {state.phase === "loaded" && state.jobs.length > 0 ? (
        <>
          <ProovraResultCount count={state.jobs.length} noun="job" />
          <ProovraCard>
            <View style={{ gap: theme.space.s5 }}>
              {state.jobs.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </View>
          </ProovraCard>
        </>
      ) : null}
    </ProovraScreen>
  );
}
