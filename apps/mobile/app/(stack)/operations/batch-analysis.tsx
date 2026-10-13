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
 * Cancel is offered exactly where it acts. See `canCancelBatch`.
 *
 * Self-service and out of every nav surface, exactly as the web keeps it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shareFile } from "../../../src/lib/share-file";
import { View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import * as FileSystem from "expo-file-system";

import { apiFetch, apiFetchText } from "../../../src/api";
import { formatUserDateTime } from "../../../src/lib/date";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { theme } from "../../../src/theme/theme";
import { useOptionalLocale } from "../../../src/locale-context";
import { fillOpsCopy, formatOpsCount, opsCopyFor } from "../../../src/product/ops-copy";
import { useOpsRowDirection } from "../../../src/ui/ops-surfaces";
import { useAuth } from "../../../src/auth-context";
import { usePlatformContext } from "../../../src/product/platform-context";
import {
  buildLibraryQuery,
  parseEvidencePickerRows,
  type EvidencePickerRow,
} from "../../../src/product/evidence-library";
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
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
  ProovraKpiGrid,
} from "../../../src/ui";
import {
  BATCH_ANALYSIS_PATH,
  BATCH_POLL_INTERVAL_MS,
  batchExportFilename,
  batchStatusLabel,
  batchStatusTone,
  buildBatchCancelPath,
  buildBatchCreateBody,
  buildBatchExportPath,
  buildBatchProcessPath,
  canCancelBatch,
  canExportBatch,
  hasRunningBatch,
  parseBatchJobs,
  readCreatedBatchId,
  selectBatchCandidateItems,
  sortBatchJobs,
  validateBatchDraft,
  type BatchJob,
} from "../../../src/product/operations";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; jobs: BatchJob[] }
  | { phase: "failed" };



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
  const locale = useOptionalLocale();
  const t = opsCopyFor(locale);
  const rowDir = useOpsRowDirection();
  const n = (v: number) => formatOpsCount(v, locale);
  const tone = batchStatusTone(job.status);
  const palette = theme.color.status[tone];
  const pending = Math.max(0, job.totalItems - job.processedItems - job.failedItems);

  return (
    <View style={{ gap: theme.space.s2 }}>
      <View
        testID={`batch-head-${job.id}`}
        style={{
          flexDirection: rowDir,
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
            {fillOpsCopy(t.batchJobCounts, { processed: n(job.processedItems), failed: n(job.failedItems), total: n(job.totalItems) })}
          </ProovraText>
          {job.createdAtIso ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {formatUserDateTime(job.createdAtIso)}
            </ProovraText>
          ) : null}
        </View>
        <ProovraBadge label={batchStatusLabel(job.status, t)} tone={tone} />
      </View>

      {job.progress === null ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {t.batchNoItems}
        </ProovraText>
      ) : (
        <>
        <View style={{ flexDirection: rowDir, justifyContent: "space-between" }}>
          <ProovraText variant="label" color={theme.color.ink.muted}>{t.batchProgress}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`${n(job.processedItems + job.failedItems)} / ${n(job.totalItems)}`}
          </ProovraText>
        </View>
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={fillOpsCopy(t.batchProgressA11y, { name: job.name, percent: n(job.progress) })}
          style={{
            // The fill grows from the reading edge: right in Arabic.
            flexDirection: rowDir,
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
        </>
      )}

      {/* The web's Processed / Failed / Pending tiles. */}
      <View style={{ flexDirection: rowDir, gap: theme.space.s2 }} testID={`batch-counters-${job.id}`}>
        {(
          [
            ["processed", t.batchTileProcessed, job.processedItems],
            ["failed", t.batchTileFailed, job.failedItems],
            ["pending", t.batchTilePending, pending],
          ] as const
        ).map(([key, label, value]) => (
          <View
            key={key}
            style={{ flex: 1, padding: theme.space.s2, borderRadius: theme.radius.md, backgroundColor: theme.color.surface.muted }}
          >
            <ProovraText variant="label" color={theme.color.ink.muted}>{label}</ProovraText>
            <ProovraText variant="body" weight="bold">{n(value)}</ProovraText>
          </View>
        ))}
      </View>

      <ProovraText variant="label" color={theme.color.ink.muted}>
        {job.completedAtIso
          ? fillOpsCopy(t.batchCompletedAt, { at: formatUserDateTime(job.completedAtIso) })
          : job.createdAtIso
            ? fillOpsCopy(t.batchStartedAt, { at: formatUserDateTime(job.createdAtIso) })
            : ""}
      </ProovraText>

      <View style={{ flexDirection: rowDir, flexWrap: "wrap", gap: theme.space.s2 }}>
        {canExportBatch(job) ? (
          <ProovraButton
            label={t.batchExport}
            variant="ghost"
            fullWidth={false}
            loading={busy}
            onPress={onExport}
          />
        ) : null}
        {/*
          Cancel is offered on PENDING and PROCESSING, the states the service
          acts on; offering it elsewhere would report a cancellation that did
          not happen.
        */}
        {canCancelBatch(job) ? (
          <ProovraButton
            label={t.batchCancelJob}
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
  const locale = useOptionalLocale();
  const t = opsCopyFor(locale);
  const n = (v: number) => formatOpsCount(v, locale);
  const { user } = useAuth();
  const platform = usePlatformContext();
  const teamId = platform.context?.activeTeamId ?? null;
  const platformLoading = platform.loading;
  const userId = user?.id ?? null;
  const [state, setState] = useState<State>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The draft
  const [composing, setComposing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<EvidencePickerRow[] | null>(null);
  const [cancelling, setCancelling] = useState<BatchJob | null>(null);

  // Every list read takes a ticket; only the newest ticket may write state, so
  // a slow poll that lands after an action's re-read cannot overwrite it with
  // older jobs. `inFlight` counts reads still outstanding, so a poll tick never
  // starts a read while another one (poll or action) is running.
  const readSeq = useRef(0);
  const inFlight = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const readJobs = useCallback(async (silent: boolean) => {
    const ticket = ++readSeq.current;
    inFlight.current += 1;
    if (!silent) setState({ phase: "loading" });
    try {
      const data = await apiFetch(BATCH_ANALYSIS_PATH);
      if (mounted.current && ticket === readSeq.current) {
        setState({ phase: "loaded", jobs: sortBatchJobs(parseBatchJobs(data)) });
      }
    } catch {
      // A failed POLL keeps the list the user is reading, as the web's
      // loadJobs does (it only logs). A failed explicit read says so.
      if (!silent && mounted.current && ticket === readSeq.current) {
        setState({ phase: "failed" });
      }
    } finally {
      inFlight.current -= 1;
    }
  }, []);

  const load = useCallback(() => readJobs(false), [readJobs]);

  useEffect(() => {
    void load();
  }, [load]);

  // POLLING — the web re-reads the list every 4 s (BATCH_POLL_INTERVAL_MS).
  // Here it runs only while this screen is focused AND a job is still
  // pending/processing; blur, unmount, or the last job finishing stops it.
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const running = state.phase === "loaded" && hasRunningBatch(state.jobs);

  useEffect(() => {
    if (!focused || !running) return undefined;
    const interval = setInterval(() => {
      if (inFlight.current > 0) return;
      void readJobs(true);
    }, BATCH_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [focused, running, readJobs]);

  const loadCandidates = useCallback(async () => {
    setCandidates(null);
    // The create route requires every id to be the caller's OWN undeleted
    // evidence, all from ONE workspace. `active` alone is neither: it lists
    // team-mates' records and every workspace the caller belongs to. So the
    // read is pinned to the active workspace and narrowed to the caller's own,
    // and the picker cannot offer a record the server would then reject.
    if (!teamId) {
      setCandidates(platformLoading ? null : []);
      return;
    }
    try {
      const data = await apiFetch(
        `${buildLibraryQuery({ scope: "active", search, sort: "newest", limit: 50 })}&teamId=${encodeURIComponent(teamId)}`,
      );
      setCandidates(parseEvidencePickerRows(selectBatchCandidateItems(data, userId)));
    } catch {
      setCandidates([]);
    }
  }, [search, teamId, platformLoading, userId]);

  useEffect(() => {
    if (composing) void loadCandidates();
  }, [composing, loadCandidates]);

  const draftError = useMemo(() => validateBatchDraft(name, picked, t), [name, picked, t]);

  // D11 — A JOB CREATED BUT NOT STARTED. Create and process are two calls; when
  // the second fails, the job EXISTS (pending). It is remembered against the
  // draft it was made from, so "try again" starts THAT job rather than
  // creating a duplicate. `creating` holds across a double tap.
  const createdNotStarted = useRef<{ signature: string; id: string } | null>(null);
  const creating = useRef(false);

  const create = useCallback(async () => {
    if (draftError) {
      setMessage(draftError);
      return;
    }
    if (creating.current) return;
    creating.current = true;
    const signature = JSON.stringify([name.trim(), description.trim(), [...picked].sort()]);
    setBusy(true);
    setMessage(null);
    let id: string | null = createdNotStarted.current?.signature === signature ? createdNotStarted.current.id : null;
    try {
      if (!id) {
        const created = await apiFetch(BATCH_ANALYSIS_PATH, {
          method: "POST",
          body: JSON.stringify(buildBatchCreateBody(name, picked, description)),
        });
        id = readCreatedBatchId(created);
        if (!id) {
          setMessage(t.batchNoId);
          await load();
          return;
        }
        createdNotStarted.current = { signature, id };
      }

      // Creation does not start it — the create response says so itself. A job
      // left at `pending` that the user believes is running is worse than
      // either outcome, so the two calls are chained exactly as the web does.
      try {
        await apiFetch(buildBatchProcessPath(id), { method: "POST" });
      } catch (err) {
        // The job exists and is NOT running. Say exactly that, show it in the
        // list, and keep the draft so a retry starts this same job.
        setMessage(`${t.batchCreatedNotStarted} ${toSafeUserError(err).message}`);
        await load();
        return;
      }

      createdNotStarted.current = null;
      setComposing(false);
      setName("");
      setDescription("");
      setPicked([]);
      setMessage(t.batchCreatedStarted);
      await load();
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      creating.current = false;
      setBusy(false);
    }
  }, [draftError, name, description, picked, load, t]);

  const cancel = useCallback(async () => {
    const job = cancelling;
    if (!job) return;
    setCancelling(null);
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(buildBatchCancelPath(job.id), { method: "POST" });
      await load();
      setMessage(t.batchCancelledDone);
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [cancelling, load, t]);

  const exportCsv = useCallback(async (job: BatchJob) => {
    setBusy(true);
    setMessage(null);
    try {
      // text/csv, not JSON. `apiFetchText` carries the same auth and the same
      // error path; parsing this as JSON would turn a correct response into a
      // failure the user could not explain.
      const csv = await apiFetchText(buildBatchExportPath(job.id));
      if (!FileSystem.cacheDirectory) {
        setMessage(t.batchNoTempDir);
        return;
      }
      const filename = batchExportFilename(job.id);
      const uri = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(uri, csv, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      await shareFile(uri, { mimeType: "text/csv", dialogTitle: filename, uti: "public.comma-separated-values-text" });
    } catch (err) {
      // A write or share that fails on the device is not a transport failure;
      // without this sentence it would read "Check your connection".
      setMessage(
        toSafeUserError(err, { message: t.batchExportDeviceFailed }).message,
      );
    } finally {
      setBusy(false);
    }
  }, [t]);

  // A fresh draft starts without the previous outcome's message in the sheet.
  const openComposer = useCallback(() => {
    setMessage(null);
    setComposing(true);
  }, []);

  const toggle = useCallback((id: string) => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  return (
    <ProovraScreen shell testID="operations-batch-analysis">
      <ProovraPageHeader
        title={t.batchTitle}
        eyebrow={t.batchEyebrow}
        subtitle={t.batchSubtitle}
        primaryAction={
          <ProovraButton
            label={t.batchNew}
            fullWidth={false}
            onPress={openComposer}
          />
        }
        secondaryActions={
          <ProovraButton
            label={t.back}
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

      {state.phase === "loading" ? <ProovraLoadingState label={t.batchLoading} /> : null}

      {state.phase === "failed" ? (
        <ProovraErrorState message={t.batchLoadFailed} onRetry={() => void load()} />
      ) : null}

      {state.phase === "loaded" ? (
        <ProovraKpiGrid
          items={[
            { key: "total", label: t.batchKpiTotal, value: n(state.jobs.length), caption: t.batchKpiTotalCaption },
            {
              key: "active",
              label: t.batchKpiActive,
              value: n(state.jobs.filter((j) => ["pending", "processing"].includes(j.status.toLowerCase())).length),
              caption: t.batchKpiActiveCaption,
            },
          ]}
        />
      ) : null}

      {state.phase === "loaded" && state.jobs.length === 0 ? (
        <ProovraEmpty
          presence="page"
          title={t.batchEmptyTitle}
          purpose={t.batchEmptyBody}
          action={<ProovraButton label={t.batchCreate} onPress={openComposer} />}
        />
      ) : null}

      {state.phase === "loaded" && state.jobs.length > 0 ? (
        <>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            {state.jobs.length === 1 ? t.batchCountOne : fillOpsCopy(t.batchCountMany, { n: n(state.jobs.length) })}
          </ProovraText>
          {/*
            What the batch actually does, in the service's own words. The
            /results aggregate is not read: it sums classification, moderation
            and tag fields that processBatch never writes, so a card built from
            it would be an empty list and a zero presented as an analysis of
            the operator's evidence.
          */}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {t.batchModeNote}
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
      <ProovraSheet visible={composing} title={t.batchComposerTitle} closeLabel={t.close} onClose={() => setComposing(false)}>
        <ProovraFormField label={t.batchNameLabel}>
          <ProovraInput
            value={name}
            onChangeText={setName}
            placeholder={t.batchNamePlaceholder}
            autoCapitalize="sentences"
            accessibilityLabel={t.batchNameA11y}
          />
        </ProovraFormField>

        <ProovraFormField label={t.batchDescLabel}>
          <ProovraInput
            value={description}
            onChangeText={setDescription}
            placeholder={t.batchDescPlaceholder}
            autoCapitalize="sentences"
            multiline
            accessibilityLabel={t.batchDescA11y}
          />
        </ProovraFormField>

        <ProovraFormField label={t.batchRecordsLabel}>
          <ProovraInput
            value={search}
            onChangeText={setSearch}
            placeholder={t.batchSearchPlaceholder}
            onSubmitEditing={() => void loadCandidates()}
            accessibilityLabel={t.batchSearchA11y}
          />
        </ProovraFormField>

        <ProovraText variant="label" color={theme.color.ink.muted}>
          {picked.length === 0
            ? t.batchPickedNone
            : picked.length === 1
              ? t.batchPickedOne
              : fillOpsCopy(t.batchPickedMany, { n: n(picked.length) })}
        </ProovraText>

        {candidates === null ? (
          <ProovraLoadingState label={t.batchLoadingEvidence} />
        ) : candidates.length === 0 ? (
          <ProovraEmpty presence="inline" title={t.batchNoMatch} />
        ) : (
          candidates.map((row) => (
            <ProovraListRow
              key={row.id}
              title={row.title}
              subtitle={row.subtitle ?? undefined}
              onPress={() => toggle(row.id)}
              trailing={
                picked.includes(row.id) ? (
                  <ProovraBadge label={t.batchChosen} tone="verified" />
                ) : undefined
              }
            />
          ))
        )}

        <ProovraButton
          label={t.batchCreateStart}
          loading={busy}
          disabled={draftError !== null}
          onPress={() => void create()}
        />
        {draftError ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {draftError}
          </ProovraText>
        ) : null}
        {/*
          The sheet is a Modal: the page-level message sits BEHIND it, so a
          refused create was invisible while the user was still looking here.
        */}
        {message ? (
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {message}
          </ProovraText>
        ) : null}
      </ProovraSheet>

      <ProovraConfirmSheet
        visible={cancelling !== null}
        title={t.batchCancelTitle}
        consequence={t.batchCancelConsequence}
        confirmLabel={t.batchCancelJob}
        cancelLabel={t.batchKeepRunning}
        tone="danger"
        busy={busy}
        onConfirm={() => void cancel()}
        onCancel={() => setCancelling(null)}
      />
    </ProovraScreen>
  );
}
