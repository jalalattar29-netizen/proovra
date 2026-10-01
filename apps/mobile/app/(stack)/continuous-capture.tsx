/**
 * UC-3 / UC-5 — Continuous (streaming) Screen Capture screen: Android
 * MediaProjection and Apple's user-authorised system broadcast.
 *
 * User-initiated only. It discloses what the OS will ask and what PROOVRA can and
 * cannot establish BEFORE recording, starts the bounded native recording (the OS's
 * own consent UI; on Android a foreground-service notification with a Stop
 * action, for which it first asks Android 13+'s notification permission), and
 * only once the OS has actually started recording opens ONE canonical
 * direct-capture session — so a refused consent or a cancelled iOS picker leaves
 * no server session and no reserved record behind. Each finalized ORIGINAL
 * segment then STREAMS to the server while recording continues.
 *
 * DURABILITY. The server session, the reserved record and every declared segment
 * are persisted the moment they exist (continuous-session-store), so a recreated
 * UI — swiped away, killed, relaunched while the recorder kept going — reattaches
 * to the SAME session and resumes uploading from the recorder's on-disk
 * segments, or offers an explicit recover/discard. It never opens a second
 * session over a live recording.
 *
 * HONESTY. On Stop the client reconciles what was RECORDED with what was
 * DECLARED: missing segments are retried from disk and, if still missing, the
 * session is staged as INTERRUPTED with SEGMENT_UPLOAD_LOST — never as
 * "Complete". Completeness shown here is the device's own report, never styled
 * as a verification. Staging hands ONE manifest to Capture, where Finish & Sign
 * seals it; a staging failure keeps the session for a retry. Every other exit
 * from an opened session (Discard, Try Again, a start failure) releases it.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AppState, Platform, View, StyleSheet } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SCREEN_CONTINUOUS_STREAM_BOUNDS } from "@proovra/shared";

import { theme } from "../../src/theme/theme";
import { toSafeUserError } from "../../src/errors/safe-error";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraEmptyState,
  ProovraLoadingState,
} from "../../src/ui";
import { useToast } from "../../src/toast-context";
import { usePersonalSpaceAllowed } from "../../src/usePersonalSpaceAllowed";
import { usePlatformContext } from "../../src/product/platform-context";
import { useAuth } from "../../src/auth-context";
import {
  beginContinuousSession,
  cleanupContinuousTempFiles,
  reconcileContinuousUploads,
  stageContinuousCapture,
  undeclaredSegments,
  uploadContinuousSegment,
  continuousSessionBytes,
  BROADCAST_START_TIMEOUT_MS,
  CONTINUOUS_COMPLETENESS_LABEL,
  CONTINUOUS_PLATFORM_COPY,
  CONTINUOUS_REVIEW_COPY,
  CONTINUOUS_STAGE_FAILURE,
  type DeclaredSegment,
} from "../../src/continuous-capture";
import { discardDirectCaptureSession, type DirectCaptureSession } from "../../src/direct-capture";
import { saveCaptureSession } from "../../src/capture/capture-session-store";
import {
  clearLiveContinuousSession,
  loadLiveContinuousSession,
  saveLiveContinuousSession,
} from "../../src/capture/continuous-session-store";
import {
  ensureCaptureNotificationPermission,
  NOTIFICATION_DENIED_COPY,
} from "../../src/capture/notification-permission";
import { openCaptureDraft } from "../../src/capture/capture-draft";
import {
  toScreenDraftItem,
  type ScreenAcquisitionMode,
} from "../../src/capture/screen-acquisition";
import { setCaptureActive } from "../../src/capture/active-capture";
import {
  INITIAL_CONTINUOUS_FLOW,
  continuousFlowReducer,
  shouldStopForBackpressure,
} from "../../src/continuous-capture-flow";
import {
  addContinuousStartedListener,
  addContinuousStoppedListener,
  addScreenSegmentListener,
  discardContinuousSpool,
  getContinuousSegments,
  getScreenContinuousState,
  isScreenContinuousSupported,
  startContinuousCapture,
  stopContinuousCapture,
  type ScreenContinuousResult,
  type ScreenSegment,
} from "../../modules/proovra-screen-capture";

type SessionRef = { session: DirectCaptureSession; evidenceId: string };

type Recovery = null | { kind: "ended" } | { kind: "orphan" } | { kind: "leftover" };

export default function ContinuousCaptureScreen() {
  const router = useRouter();
  const toast = useToast();
  const personalSpace = usePersonalSpaceAllowed();
  // ET-DC-08 — the capture belongs to the ACTIVE workspace, as on /capture.
  const teamId = usePlatformContext().context?.activeTeamId ?? null;
  // The durable records are per user (UC-AND-006): reattach once the user is known.
  const userId = useAuth().user?.id ?? null;
  const [state, dispatch] = useReducer(continuousFlowReducer, INITIAL_CONTINUOUS_FLOW);
  const [busy, setBusy] = useState(false);
  const [notificationDenied, setNotificationDenied] = useState(false);
  const [recovery, setRecovery] = useState<Recovery>(null);
  const isIOS = Platform.OS === "ios";
  const copy = isIOS ? CONTINUOUS_PLATFORM_COPY.ios : CONTINUOUS_PLATFORM_COPY.android;
  const supported =
    (Platform.OS === "android" || isIOS) && isScreenContinuousSupported();

  // The ONE canonical session + evidence for the whole recording, and the segments
  // declared so far. Refs, not state, so the segment listener always sees the
  // latest without re-subscribing; persisted as they change (durability).
  const sessionRef = useRef<SessionRef | null>(null);
  const declaredRef = useRef<DeclaredSegment[]>([]);
  const resultRef = useRef<ScreenContinuousResult | null>(null);
  const openingRef = useRef(false);
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // BOUNDED STREAMING: recorded segments enter a queue drained by a fixed number of
  // upload workers (concurrency bound). On Android, a backlog that reaches the
  // bound triggers a CONTROLLED stop; on iOS the container is the spool.
  const queueRef = useRef<ScreenSegment[]>([]);
  const workersRef = useRef(0);
  const capturedRef = useRef(0);
  const uploadedBytesRef = useRef(0);
  const seenRef = useRef<ScreenSegment[]>([]);
  const clientLimitationsRef = useRef<Set<string>>(new Set());
  const stopRequestedRef = useRef(false);

  const persistLive = useCallback(() => {
    const active = sessionRef.current;
    if (!active) return;
    void saveLiveContinuousSession({
      captureSessionId: active.session.captureSessionId,
      evidenceId: active.evidenceId,
      expiresAtUtc: active.session.expiresAtUtc,
      platform: isIOS ? "ios" : "android",
      declared: declaredRef.current,
      clientLimitations: Array.from(clientLimitationsRef.current),
      openedAtIso: new Date().toISOString(),
    });
  }, [isIOS]);

  const requestControlledStop = useCallback(
    (limitation: string | null, message: string | null) => {
      if (limitation) clientLimitationsRef.current.add(limitation);
      if (stopRequestedRef.current) return;
      stopRequestedRef.current = true;
      if (message) toast.addToast(message, "info");
      // Fire-and-forget: native stops emitting new segments; the queue keeps draining.
      void stopContinuousCapture().catch(() => {});
    },
    [toast],
  );

  const pump = useCallback(() => {
    const active = sessionRef.current;
    if (!active) return;
    while (workersRef.current < SCREEN_CONTINUOUS_STREAM_BOUNDS.uploadConcurrency && queueRef.current.length > 0) {
      const seg = queueRef.current.shift() as ScreenSegment;
      if (declaredRef.current.some((d) => d.sequence === seg.sequence)) continue;
      workersRef.current += 1;
      uploadContinuousSegment(active.session, active.evidenceId, seg)
        .then((declared) => {
          declaredRef.current = [...declaredRef.current.filter((d) => d.sequence !== declared.sequence), declared];
          uploadedBytesRef.current += declared.sizeBytes;
          persistLive();
          dispatch({ type: "SEGMENT_UPLOADED", uploaded: declaredRef.current.length });
          // Whole-session byte ceiling: keep the sealed Evidence under the canonical
          // completion cap. Controlled stop — nothing dropped.
          if (uploadedBytesRef.current >= SCREEN_CONTINUOUS_STREAM_BOUNDS.maxSessionBytes) {
            requestControlledStop(
              "SESSION_BOUNDS_REACHED",
              "The recording reached its size limit and stopped. Tap Stop & Review to save it.",
            );
          }
        })
        .catch((err) => {
          // A lost segment is retried from disk at finalize and, if still
          // missing, stated as SEGMENT_UPLOAD_LOST — never sealed over.
          toast.addToast(
            toSafeUserError(err, { message: "A screen segment could not be uploaded. PROOVRA will retry it before staging." }).message,
            "error",
          );
        })
        .finally(() => {
          workersRef.current -= 1;
          pump();
        });
    }
  }, [toast, requestControlledStop, persistLive]);

  const onSegment = useCallback(
    (seg: ScreenSegment) => {
      if (seenRef.current.some((s) => s.sequence === seg.sequence)) return;
      capturedRef.current = Math.max(capturedRef.current, seg.sequence + 1);
      seenRef.current = [...seenRef.current, seg];
      dispatch({ type: "SEGMENT_CAPTURED", captured: capturedRef.current });
      queueRef.current = [...queueRef.current, seg];
      // Backpressure (Android only — UC-IOS-003).
      if (
        shouldStopForBackpressure(
          capturedRef.current,
          declaredRef.current.length,
          SCREEN_CONTINUOUS_STREAM_BOUNDS.maxPendingSegments,
          Platform.OS,
        )
      ) {
        requestControlledStop(
          "SEGMENT_UPLOAD_BACKPRESSURE",
          "Uploads fell behind, so recording stopped. Tap Stop & Review to save what was captured.",
        );
      }
      pump();
    },
    [pump, requestControlledStop],
  );

  /** Pick up every finalized segment the recorder holds that this UI has not seen. */
  const syncFromNative = useCallback(() => {
    for (const seg of getContinuousSegments()) onSegment(seg);
  }, [onSegment]);

  const clearStartTimer = useCallback(() => {
    if (startTimerRef.current) clearTimeout(startTimerRef.current);
    startTimerRef.current = null;
  }, []);

  const resetStreamRefs = useCallback(() => {
    queueRef.current = [];
    workersRef.current = 0;
    capturedRef.current = 0;
    uploadedBytesRef.current = 0;
    seenRef.current = [];
    declaredRef.current = [];
    clientLimitationsRef.current = new Set();
    stopRequestedRef.current = false;
    resultRef.current = null;
    openingRef.current = false;
  }, []);

  /** Release an opened-but-unstaged session: server, native recorder, local files, durable record. */
  const releaseSession = useCallback(async () => {
    const active = sessionRef.current;
    sessionRef.current = null;
    clearStartTimer();
    if (getScreenContinuousState().active) await stopContinuousCapture().catch(() => undefined);
    await cleanupContinuousTempFiles(seenRef.current);
    await discardContinuousSpool().catch(() => undefined);
    await clearLiveContinuousSession();
    if (active) await discardDirectCaptureSession(active.session).catch(() => undefined);
  }, [clearStartTimer]);

  /**
   * Open the server session once the OS is actually recording. A failure here
   * stops the recorder and releases whatever was opened.
   */
  const openServerSession = useCallback(async () => {
    if (sessionRef.current || openingRef.current) return;
    openingRef.current = true;
    clearStartTimer();
    try {
      sessionRef.current = await beginContinuousSession({ teamId });
      persistLive();
      dispatch({ type: "STARTED" });
      syncFromNative();
      pump();
    } catch (err) {
      await releaseSession();
      dispatch({
        type: "FAIL",
        message: toSafeUserError(err, { message: "PROOVRA could not open a capture session, so the recording was stopped." }).message,
        recoverable: true,
      });
    } finally {
      openingRef.current = false;
    }
  }, [teamId, persistLive, syncFromNative, pump, releaseSession, clearStartTimer]);

  // Live segment stream + start/stop events.
  useEffect(() => {
    const segSub = addScreenSegmentListener(onSegment);
    const stopSub = addContinuousStoppedListener((r: ScreenContinuousResult) => {
      resultRef.current = r;
    });
    const startSub = addContinuousStartedListener(() => {
      void openServerSession();
    });
    return () => {
      segSub.remove();
      stopSub.remove();
      startSub.remove();
    };
  }, [onSegment, openServerSession]);

  // UC-IOS-003 — iOS delivers the backlog when PROOVRA returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: string) => {
      if (next === "active" && sessionRef.current) {
        syncFromNative();
        pump();
      }
    });
    return () => sub.remove();
  }, [syncFromNative, pump]);

  // UC-AND-004 / UC-IOS-010 — reattach to a live recording after the UI was
  // recreated, or offer an explicit recover/discard. Never a second session.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!userId) return undefined;
      void (async () => {
        const native = getScreenContinuousState();
        if (sessionRef.current) {
          if (native.active) {
            dispatch({ type: "STARTED" });
            syncFromNative();
          }
          return;
        }
        const live = await loadLiveContinuousSession();
        if (cancelled) return;
        if (live) {
          sessionRef.current = {
            session: { captureSessionId: live.captureSessionId, expiresAtUtc: live.expiresAtUtc },
            evidenceId: live.evidenceId,
          };
          declaredRef.current = live.declared;
          clientLimitationsRef.current = new Set(live.clientLimitations);
          if (native.active && !native.stale) {
            dispatch({ type: "STARTED" });
            dispatch({ type: "SEGMENT_UPLOADED", uploaded: live.declared.length });
            syncFromNative();
            pump();
          } else {
            setRecovery({ kind: "ended" });
          }
        } else if (native.active) {
          setRecovery({ kind: "orphan" });
        } else if (getContinuousSegments().length > 0) {
          // UC-IOS-010 — segments on disk that no session holds (the app was
          // killed before a session opened, or a broadcast was started from
          // Control Center): never wiped silently, never offered as uploadable.
          setRecovery({ kind: "leftover" });
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [syncFromNative, pump, userId]),
  );

  useEffect(() => {
    const inFlight =
      state.phase === "awaiting" || state.phase === "active" || state.phase === "review" || state.phase === "finalizing";
    setCaptureActive(inFlight);
    return () => setCaptureActive(false);
  }, [state.phase]);

  // Wait until the bounded upload queue is fully drained (queue empty and no worker
  // in flight), so Stop/Finalize never race an unfinished segment upload.
  const drainUploads = useCallback(async () => {
    pump();
    while (queueRef.current.length > 0 || workersRef.current > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }, [pump]);

  const start = useCallback(
    async (opts: { notificationAcknowledged?: boolean } = {}) => {
      setBusy(true);
      try {
        resetStreamRefs();
        // UC-AND-003 — Android 13+: ask for the notification that carries Stop.
        if (Platform.OS === "android" && !opts.notificationAcknowledged) {
          const permission = await ensureCaptureNotificationPermission();
          if (permission === "denied") {
            setNotificationDenied(true);
            return;
          }
        }
        // The OS consent comes FIRST; no server session exists until the OS records.
        const started = await startContinuousCapture();
        if (started.awaitingSystemStart) {
          dispatch({ type: "AWAITING_SYSTEM_START" });
          clearStartTimer();
          startTimerRef.current = setTimeout(() => {
            if (sessionRef.current) return;
            void stopContinuousCapture().catch(() => undefined);
            dispatch({
              type: "FAIL",
              message: "The broadcast did not start. Nothing was recorded — start again and tap Start Broadcast in Apple's picker.",
              recoverable: true,
            });
          }, BROADCAST_START_TIMEOUT_MS);
          return;
        }
        await openServerSession();
      } catch (err) {
        if ((err as { code?: string } | null)?.code === "PENDING_RECORDING") {
          setRecovery({ kind: "leftover" });
          return;
        }
        await releaseSession();
        dispatch({
          type: "FAIL",
          message: toSafeUserError(err, { message: "Screen capture consent was not granted." }).message,
          recoverable: true,
        });
      } finally {
        setBusy(false);
      }
    },
    [resetStreamRefs, openServerSession, releaseSession, clearStartTimer],
  );

  /** Stop (or adopt an already-ended recording) and show the reconciled summary. */
  const stop = useCallback(async () => {
    setBusy(true);
    try {
      stopRequestedRef.current = true;
      const result = await stopContinuousCapture();
      resultRef.current = result;
      syncFromNative();
      await drainUploads();
      const reconciled = reconcileContinuousUploads(
        result,
        declaredRef.current,
        Array.from(clientLimitationsRef.current),
      );
      dispatch({
        type: "STOPPED",
        captured: reconciled.recordedSegmentCount,
        uploaded: declaredRef.current.length,
        completeness: reconciled.sessionCompleteness,
        stopReason: result.terminationReason,
      });
    } catch (err) {
      dispatch({ type: "FAIL", message: toSafeUserError(err, { message: "Could not stop capture." }).message });
    } finally {
      setBusy(false);
    }
  }, [drainUploads, syncFromNative]);

  const recoverEnded = useCallback(async () => {
    setRecovery(null);
    dispatch({ type: "STARTED" });
    await stop();
  }, [stop]);

  const finalize = useCallback(async () => {
    const active = sessionRef.current;
    const result = resultRef.current;
    if (!active || !result) {
      dispatch({ type: "FAIL", message: "The capture session was lost. Please start again." });
      return;
    }
    dispatch({ type: "FINALIZE" });
    // T-18 — which step failed decides what the user is told and offered.
    let step: "drain" | "stage" | "handoff" = "drain";
    try {
      await drainUploads();
      // UC-STR-002 — retry every recorded-but-undeclared segment from disk.
      for (const seg of undeclaredSegments(seenRef.current, declaredRef.current)) {
        try {
          const declared = await uploadContinuousSegment(active.session, active.evidenceId, seg);
          declaredRef.current = [...declaredRef.current, declared];
          persistLive();
        } catch {
          // Still missing: stated as SEGMENT_UPLOAD_LOST by the manifest.
        }
      }
      step = "stage";
      const staged = await stageContinuousCapture(
        active.session,
        active.evidenceId,
        result,
        declaredRef.current,
        Array.from(clientLimitationsRef.current),
      );

      // The canonical draft, and the durable record the Capture surface
      // resumes. The segments are already at storage, so finalize seals
      // without re-uploading them.
      step = "handoff";
      const mode: ScreenAcquisitionMode =
        Platform.OS === "ios"
          ? "DIRECT_SCREEN_CAPTURE_IOS"
          : "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS";
      const item = toScreenDraftItem({
        mode,
        clientItemId: active.session.captureSessionId,
        partCount: staged.segmentCount,
        sizeBytes: continuousSessionBytes(declaredRef.current),
      });
      // Its id travels with the durable record, so Capture closes THIS draft at
      // finalize instead of leaving it listed as unfinished.
      const draft = await openCaptureDraft({ items: [item] }).catch(() => null);
      await saveCaptureSession({
        draftId: draft?.id ?? null,
        captureSessionId: active.session.captureSessionId,
        // UC-STR-003 — the server's slid expiry (carried forward by every
        // declaration), not the value the session was opened with.
        expiresAtUtc: active.session.expiresAtUtc,
        evidenceId: active.evidenceId,
        type: "VIDEO",
        items: [
          {
            id: active.session.captureSessionId,
            uri: "",
            mimeType: item.mimeType,
            partIndex: 0,
            originalFilename: item.fileName,
            source: "SCREEN_SEGMENT",
            uploaded: true,
          },
        ],
        acquisition: { mode, manifestJson: staged.manifestJson },
      });
      await clearLiveContinuousSession();
      // The segments are at storage: the device spool is no longer needed.
      await discardContinuousSpool().catch(() => undefined);

      sessionRef.current = null;
      dispatch({
        type: "FINALIZED",
        evidenceId: active.evidenceId,
        segmentCount: staged.segmentCount,
        completeness: staged.sessionCompleteness,
      });
      toast.addToast("Recording staged — review and finish in Capture", "success");
      router.replace("/capture");
    } catch (err) {
      // UC-STR-001 — the session is KEPT: its segments are at storage and
      // declared. Continue retries staging; Discard releases it.
      const detail = toSafeUserError(err, { message: "" }).message;
      dispatch({
        type: "STAGE_FAILED",
        message: detail ? `${CONTINUOUS_STAGE_FAILURE[step]} (${detail})` : CONTINUOUS_STAGE_FAILURE[step],
      });
    }
  }, [drainUploads, toast, persistLive, router]);

  const reset = useCallback(async () => {
    // Discard / Try Again / a new recording: an opened-but-unstaged session is
    // RELEASED on the server (UC-STR-004), the recorder stopped, local segment
    // files and the durable record removed.
    await releaseSession();
    resetStreamRefs();
    setRecovery(null);
    setNotificationDenied(false);
    dispatch({ type: "RESET" });
  }, [releaseSession, resetStreamRefs]);

  const stopOrphan = useCallback(async () => {
    const segs = getContinuousSegments();
    await stopContinuousCapture().catch(() => undefined);
    await cleanupContinuousTempFiles(segs);
    await discardContinuousSpool().catch(() => undefined);
    setRecovery(null);
  }, []);

  if (personalSpace.loading) return <ProovraScreen scroll={false}><ProovraLoadingState /></ProovraScreen>;
  if (!personalSpace.allowed) {
    return (
      <ProovraScreen scroll={false}>
        <ProovraEmptyState title="Not available here" message="Continuous Screen Capture is available in your Personal Space on this device." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} />
      </ProovraScreen>
    );
  }
  if (!supported) {
    return (
      <ProovraScreen scroll={false}>
        <ProovraEmptyState title="Not available on this device" message="Continuous Screen Capture uses the device's system screen-capture and is not available on this device." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} />
      </ProovraScreen>
    );
  }

  return (
    <ProovraScreen>
      <ProovraSection title="Continuous Screen Capture">
        {recovery?.kind === "ended" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" weight="semibold">A recording ended while PROOVRA was closed.</ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              Its capture session is still open. Recover it to upload the segments still on this device and review it, or discard it.
            </ProovraText>
            <ProovraButton label="Recover recording" loading={busy} onPress={() => void recoverEnded()} />
            <ProovraButton label="Discard recording" variant="ghost" onPress={() => void reset()} />
          </ProovraCard>
        )}

        {recovery?.kind === "leftover" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" weight="semibold">An earlier recording is still on this device.</ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              No capture session holds it, so it cannot be uploaded or sealed. Discard it to start a new recording.
            </ProovraText>
            <ProovraButton label="Discard earlier recording" onPress={() => void stopOrphan()} />
          </ProovraCard>
        )}

        {recovery?.kind === "orphan" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" weight="semibold">A screen recording is still running.</ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              It belongs to a capture session this device no longer holds, so it cannot be uploaded. Stop it before starting a new one.
            </ProovraText>
            <ProovraButton label="Stop recording" onPress={() => void stopOrphan()} />
          </ProovraCard>
        )}

        {!recovery && state.phase === "intro" && notificationDenied && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" weight="semibold">Notifications are off</ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{NOTIFICATION_DENIED_COPY.continuous}</ProovraText>
            <ProovraButton label="Continue without the notification" loading={busy} onPress={() => void start({ notificationAcknowledged: true })} />
            <ProovraButton label="Cancel" variant="ghost" onPress={() => setNotificationDenied(false)} />
          </ProovraCard>
        )}

        {!recovery && state.phase === "intro" && !notificationDenied && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" color={theme.color.ink.secondary}>
              PROOVRA will record what is shown on your screen as a continuous session, using the device's own screen-capture permission. Before it starts:
            </ProovraText>
            <Bullet text={copy.consent} />
            <Bullet text="Recording continues until you stop it — anything visible can become evidence, including sensitive information." />
            <Bullet text="The session is split into short segments that are uploaded to PROOVRA." />
            <Bullet text={copy.protectedContent} />
            <Bullet text={copy.control} />
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              A screen recording captures what your device displayed. It does not establish that the content is true, who authored it, that an app or account shown is genuine, or that the session is free of gaps.
            </ProovraText>
            {/* UC-LCH-001 — the canonical screen-capture disclosure. */}
            <ProovraText variant="label" color={theme.color.accent.a600} accessibilityRole="link" accessibilityLabel="How screen capture works" onPress={() => router.push("/legal/screen-capture")}>
              How screen capture works
            </ProovraText>
            <ProovraButton label="Start Continuous Capture" loading={busy} onPress={() => void start()} />
            <ProovraButton label="Cancel" variant="ghost" onPress={() => router.back()} />
          </ProovraCard>
        )}

        {state.phase === "awaiting" && (
          <ProovraCard style={styles.card}>
            <ProovraBadge tone="pending" label="Waiting for Start Broadcast" />
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              Tap Start Broadcast in Apple's picker. Nothing is recorded until you do; if you close the picker, nothing is saved.
            </ProovraText>
            <ProovraButton label="Cancel" variant="ghost" onPress={() => void reset()} />
          </ProovraCard>
        )}

        {state.phase === "active" && (
          <ProovraCard style={styles.card}>
            <ProovraBadge tone="pending" label="Continuous capture active" />
            <ProovraText variant="body" weight="semibold">{state.captured} segment(s) recorded · {state.uploaded} uploaded.</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              {notificationDenied && !isIOS
                ? "Leave PROOVRA and open what you want to record. Segments upload in the background. The notification is off, so return to PROOVRA and tap Stop here when you are done."
                : copy.active}
            </ProovraText>
            <ProovraButton label="Stop &amp; Review" loading={busy} onPress={() => void stop()} />
          </ProovraCard>
        )}

        {state.phase === "review" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" weight="semibold">{state.captured} segment(s) recorded, {state.uploaded} uploaded and ready to seal.</ProovraText>
            {state.completeness ? (
              <ProovraBadge
                tone="neutral"
                label={
                  state.completeness === "COMPLETE_SESSION"
                    ? CONTINUOUS_COMPLETENESS_LABEL.complete
                    : CONTINUOUS_COMPLETENESS_LABEL.interrupted
                }
              />
            ) : null}
            {state.notice ? (
              <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{state.notice}</ProovraText>
            ) : null}
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              {CONTINUOUS_REVIEW_COPY.explainer}
            </ProovraText>
            <ProovraButton label={CONTINUOUS_REVIEW_COPY.action} onPress={() => void finalize()} />
            <ProovraButton label="Discard" variant="ghost" onPress={() => void reset()} />
          </ProovraCard>
        )}

        {state.phase === "finalizing" && (
          <ProovraLoadingState label={CONTINUOUS_REVIEW_COPY.staging(state.captured)} />
        )}

        {state.phase === "success" && (
          <ProovraCard style={styles.card}>
            <ProovraBadge tone="pending" label={`${CONTINUOUS_REVIEW_COPY.staged} (${state.segmentCount} segment(s), ${state.completeness === "COMPLETE_SESSION" ? "reported complete" : "interrupted"})`} />
            <ProovraButton label="Go to Capture" onPress={() => router.replace("/capture")} />
            <ProovraButton label="Capture Another" variant="secondary" onPress={() => void reset()} />
            <ProovraButton label="Done" variant="ghost" onPress={() => router.back()} />
          </ProovraCard>
        )}

        {state.phase === "error" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" color={theme.color.status.risk.fg}>{state.message}</ProovraText>
            {state.recoverable ? (
              <ProovraButton label="Try Again" onPress={() => void reset()} />
            ) : (
              <ProovraButton label="Start a new recording" onPress={() => void reset()} />
            )}
            <ProovraButton label="Back to Capture" variant="ghost" onPress={() => router.back()} />
          </ProovraCard>
        )}
      </ProovraSection>
    </ProovraScreen>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bulletRow}>
      <ProovraText variant="body" color={theme.color.accent.a500}>•</ProovraText>
      <ProovraText variant="bodySm" style={styles.bulletText}>{text}</ProovraText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: theme.space.s3 },
  caveat: { marginTop: theme.space.s1 },
  bulletRow: { flexDirection: "row", gap: theme.space.s2 },
  bulletText: { flex: 1 },
});
