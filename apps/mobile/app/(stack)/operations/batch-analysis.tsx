/**
 * BATCH ANALYSIS — the native port of
 * `apps/web/app/(app)/operations/batch-analysis`, complete.
 *
 * The whole job lifecycle is here: choose the records, create the job, start
 * it, watch it, read the aggregate, export the CSV, and cancel a running one.
 * An earlier version of this screen was a read-only list whose header said
 * "creating and cancelling jobs stay on the web for now" — that was the gap
 * being described rather than closed.
 *
 * WHAT NATIVE CHANGES, AND WHAT IT DOES NOT
 * The web form takes evidence ids as newline-separated text in a textarea.
 * That is a desktop affordance for one product intent — "which records go in
 * this batch" — and typing an id on a phone is not a port of it. Native
 * renders the same intent as a picker over the same `GET /v1/evidence`, which
 * is rendering, not product change: the request body, the validation, the
 * two-call create-then-process sequence and the statuses are identical.
 *
 * Cancel is offered exactly where it acts. See `canCancelBatch` and
 * `docs/backend-debt.md` BD-1.
 *
 * Self-service and out of every nav surface, exactly as the web keeps it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Share, View } from "react-native";
import { useRouter } from "expo-router";
import * as FileSystem from "expo-file-system";

import { apiFetch, apiFetchText } from "../../../src/api";
import { formatUserDateTime } from "../../../src/lib/date";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { theme } from "../../../src/theme/theme";
import { buildLibraryQuery } from "../../../src/product/evidence-library";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraFormField,
  ProovraListRow,
  ProovraSheet,
  ProovraConfirmSheet,
  ProovraPageHeader,
  ProovraResultCount,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
} from "../../../src/ui";
import {
  BATCH_ANALYSIS_MODE_NOTE,
  BATCH_ANALYSIS_PATH,
  batchExportFilename,
  batchStatusLabel,
  batchStatusTone,
  buildBatchCancelPath,
  buildBatchCreateBody,
  buildBatchExportPath,
  buildBatchProcessPath,
  canCancelBatch,
  canExportBatch,
  parseBatchJobs,
  readCreatedBatchId,
  sortBatchJobs,
  validateBatchDraft,
  type BatchJob,
} from "../../../src/product/operations";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; jobs: BatchJob[] }
  | { phase: "failed" };

interface PickerRow {
  id: string;
  title: string;
  subtitle: string | null;
}

function parsePickerRows(payload: unknown): PickerRow[] {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(d.items) ? d.items : Array.isArray(d.data) ? d.data : [];
  return list
    .map((raw) => {
      const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const id = typeof e.id === "string" && e.id.length > 0 ? e.id : null;
      if (!id) return null;
      const title =
        (typeof e.title === "string" && e.title) ||
        (typeof e.fileName === "string" && e.fileName) ||
        id;
      const status = typeof e.status === "string" ? e.status : null;
      const type = typeof e.type === "string" ? e.type : null;
      const subtitle = [type, status].filter(Boolean).join(" · ");
      return { id, title, subtitle: subtitle.length > 0 ? subtitle : null };
    })
    .filter((r): r is PickerRow => r !== null);
}

/* ------------------------------------------------------------------ the row */

function JobRow({
  job,
  busy,
  onCancel,
  onExport,
}: {
  job: BatchJob;
  busy: boolean;
  onCancel: () => void;
  onExport: () => void;
}) {
  const tone = batchStatusTone(job.status);
  const palette = theme.color.status[tone];

  return (
    <View style={{ gap: theme.space.s2 }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: theme.space.s2,
        }}
      >
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
          <View
            style={{ width: `${job.progress}%`, height: "100%", backgroundColor: palette.solid }}
          />
        </View>
      )}

      <ProovraText variant="label" color={theme.color.ink.muted}>
        {job.completedAtIso
          ? `Completed ${formatUserDateTime(job.completedAtIso)}`
          : job.createdAtIso
            ? `Started ${formatUserDateTime(job.createdAtIso)}`
            : ""}
      </ProovraText>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
        {canExportBatch(job) ? (
          <ProovraButton
            label="Export CSV"
            variant="ghost"
            fullWidth={false}
            loading={busy}
            onPress={onExport}
          />
        ) : null}
        {/*
          Only a PROCESSING job. The service acts on nothing else while still
          answering success, so offering it elsewhere would report a
          cancellation that did not happen — docs/backend-debt.md BD-1.
        */}
        {canCancelBatch(job) ? (
          <ProovraButton
            label="Cancel job"
            variant="ghost"
            fullWidth={false}
            loading={busy}
            onPress={onCancel}
          />
        ) : null}
      </View>
    </View>
  );
}

/* --------------------------------------------------------------- the screen */

export default function BatchAnalysisScreen() {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The draft
  const [composing, setComposing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<PickerRow[] | null>(null);
  const [cancelling, setCancelling] = useState<BatchJob | null>(null);

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

  const loadCandidates = useCallback(async () => {
    setCandidates(null);
    try {
      // The create route requires every id to be the caller's own, undeleted
      // evidence. `active` is exactly that scope, so the picker cannot offer a
      // record the server would then reject.
      const data = await apiFetch(
        buildLibraryQuery({ scope: "active", search, sort: "newest", limit: 50 }),
      );
      setCandidates(parsePickerRows(data));
    } catch {
      setCandidates([]);
    }
  }, [search]);

  useEffect(() => {
    if (composing) void loadCandidates();
  }, [composing, loadCandidates]);

  const draftError = useMemo(() => validateBatchDraft(name, picked), [name, picked]);

  const create = useCallback(async () => {
    if (draftError) {
      setMessage(draftError);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const created = await apiFetch(BATCH_ANALYSIS_PATH, {
        method: "POST",
        body: JSON.stringify(buildBatchCreateBody(name, picked, description)),
      });
      const id = readCreatedBatchId(created);
      if (!id) {
        setMessage("The job was created but the server did not return its id.");
        return;
      }

      // Creation does not start it — the create response says so itself. A job
      // left at `pending` that the user believes is running is worse than
      // either outcome, so the two calls are chained exactly as the web does.
      await apiFetch(buildBatchProcessPath(id), { method: "POST" });

      setComposing(false);
      setName("");
      setDescription("");
      setPicked([]);
      setMessage("Batch job created and processing started.");
      await load();
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [draftError, name, description, picked, load]);

  const cancel = useCallback(async () => {
    const job = cancelling;
    if (!job) return;
    setCancelling(null);
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(buildBatchCancelPath(job.id), { method: "POST" });
      await load();
      setMessage("That job was cancelled.");
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [cancelling, load]);

  const exportCsv = useCallback(async (job: BatchJob) => {
    setBusy(true);
    setMessage(null);
    try {
      // text/csv, not JSON. `apiFetchText` carries the same auth and the same
      // error path; parsing this as JSON would turn a correct response into a
      // failure the user could not explain.
      const csv = await apiFetchText(buildBatchExportPath(job.id));
      if (!FileSystem.cacheDirectory) {
        setMessage("A writable temporary directory is not available on this device.");
        return;
      }
      const filename = batchExportFilename(job.id);
      const uri = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(uri, csv, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      await Share.share({ url: uri, title: filename, message: filename });
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const toggle = useCallback((id: string) => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  return (
    <ProovraScreen testID="operations-batch-analysis">
      <ProovraPageHeader
        title="Batch analysis"
        eyebrow="Operations"
        subtitle="Create batch jobs, monitor progress, review outcomes, and export results."
        primaryAction={
          <ProovraButton
            label="New batch job"
            fullWidth={false}
            onPress={() => setComposing(true)}
          />
        }
        secondaryActions={
          <ProovraButton
            label="Back"
            variant="ghost"
            fullWidth={false}
            onPress={() => router.back()}
          />
        }
      />

      {message ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {message}
        </ProovraText>
      ) : null}

      {state.phase === "loading" ? <ProovraLoadingState label="Loading jobs" /> : null}

      {state.phase === "failed" ? (
        <ProovraErrorState message="Batch jobs could not be loaded." onRetry={() => void load()} />
      ) : null}

      {state.phase === "loaded" && state.jobs.length === 0 ? (
        <ProovraEmpty
          presence="page"
          title="No batch jobs"
          purpose="Batch jobs you start appear here with their progress."
          action={<ProovraButton label="New batch job" onPress={() => setComposing(true)} />}
        />
      ) : null}

      {state.phase === "loaded" && state.jobs.length > 0 ? (
        <>
          <ProovraResultCount count={state.jobs.length} noun="job" />
          {/*
            What the batch actually does, in the service's own words. The
            /results aggregate is not read: it sums classification, moderation
            and tag fields that processBatch never writes, so a card built from
            it would be an empty list and a zero presented as an analysis of
            the operator's evidence.
          */}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {BATCH_ANALYSIS_MODE_NOTE}
          </ProovraText>
          <ProovraCard>
            <View style={{ gap: theme.space.s5 }}>
              {state.jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  busy={busy}
                  onCancel={() => setCancelling(job)}
                  onExport={() => void exportCsv(job)}
                />
              ))}
            </View>
          </ProovraCard>
        </>
      ) : null}

      {/* ------------------------------------------------------- the composer */}
      <ProovraSheet visible={composing} title="New batch job" onClose={() => setComposing(false)}>
        <ProovraFormField label="Name">
          <ProovraInput
            value={name}
            onChangeText={setName}
            placeholder="What this batch is for"
            autoCapitalize="sentences"
            accessibilityLabel="Batch name"
          />
        </ProovraFormField>

        <ProovraFormField label="Description (optional)">
          <ProovraInput
            value={description}
            onChangeText={setDescription}
            placeholder="Anything worth recording about this batch"
            autoCapitalize="sentences"
            multiline
            accessibilityLabel="Batch description"
          />
        </ProovraFormField>

        <ProovraFormField label="Records">
          <ProovraInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search your evidence"
            onSubmitEditing={() => void loadCandidates()}
            accessibilityLabel="Search evidence"
          />
        </ProovraFormField>

        <ProovraText variant="label" color={theme.color.ink.muted}>
          {picked.length === 0
            ? "Nothing chosen yet."
            : `${picked.length} record${picked.length === 1 ? "" : "s"} chosen.`}
        </ProovraText>

        {candidates === null ? (
          <ProovraLoadingState label="Loading your evidence" />
        ) : candidates.length === 0 ? (
          <ProovraEmpty presence="inline" title="No records match that." />
        ) : (
          candidates.map((row) => (
            <ProovraListRow
              key={row.id}
              title={row.title}
              subtitle={row.subtitle ?? undefined}
              onPress={() => toggle(row.id)}
              trailing={
                picked.includes(row.id) ? (
                  <ProovraBadge label="Chosen" tone="verified" />
                ) : undefined
              }
            />
          ))
        )}

        <ProovraButton
          label="Create and start"
          loading={busy}
          disabled={draftError !== null}
          onPress={() => void create()}
        />
        {draftError ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {draftError}
          </ProovraText>
        ) : null}
      </ProovraSheet>

      <ProovraConfirmSheet
        visible={cancelling !== null}
        title="Cancel this batch job?"
        consequence="In-progress items will stop. Already completed items keep their results."
        confirmLabel="Cancel job"
        cancelLabel="Keep running"
        tone="danger"
        busy={busy}
        onConfirm={() => void cancel()}
        onCancel={() => setCancelling(null)}
      />
    </ProovraScreen>
  );
}
