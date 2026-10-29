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
import { AppState, Platform, Switch, View, StyleSheet } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { requestRecordingPermissionsAsync } from "expo-audio";
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
  confirmContinuousSegment,
  continuousRecoveryDeps,
  releaseStagedContinuousSpool,
  reconcileContinuousUploads,
  undeclaredSegments,
  uploadContinuousSegment,
  continuousSessionBytes,
  BROADCAST_START_TIMEOUT_MS,
  CONTINUOUS_COMPLETENESS_LABEL,
  CONTINUOUS_PLATFORM_COPY,
  CONTINUOUS_REVIEW_COPY,
  CONTINUOUS_SESSION_GONE,
  CONTINUOUS_STAGE_FAILURE,
  releaseSingleFileRecording,
  stageSingleFileRecording,
  type DeclaredSegment,
} from "../../src/continuous-capture";
import {
  audioTracksLabel,
  formatSingleFileLimits,
  readSingleFileRecording,
  singleFileName,
  singleFileOutcome,
  type SingleFileRecording,
} from "../../src/continuous-single-file";
import {
  acquireLocationWithChoice,
  locationOutcomeMessage,
  locationParam,
  reservationLocationFields,
  type CarriedLocation,
} from "../../src/capture/device-location";
import { registerLinkedRecord } from "../../src/capture/capture-links";
import { discardDirectCaptureSession, type DirectCaptureSession } from "../../src/direct-capture";
import { captureRecordKey, findCaptureSession, saveCaptureSession } from "../../src/capture/capture-session-store";
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
  CONTINUOUS_DRAIN_DEADLINE_MS,
  INITIAL_CONTINUOUS_FLOW,
  continuousFlowReducer,
  drainUploadQueue,
  shouldStopForBackpressure,
} from "../../src/continuous-capture-flow";
import {
  acceptsBroadcastStart,
  decideIosReattach,
  segmentBelongsToRecording,
} from "../../src/capture/ios-broadcast-binding";
import {
  executeContinuousRecovery,
  planContinuousRecovery,
  recoverOnce,
} from "../../src/capture/continuous-recovery";
import {
  addContinuousStartedListener,
  addContinuousStoppedListener,
  addScreenSegmentListener,
  bindContinuousSession,
  discardContinuousSpool,
  getContinuousLedger,
  getContinuousSegments,
  getScreenContinuousState,
  isScreenContinuousSupported,
  listContinuousRecordings,
  startContinuousCapture,
  stopContinuousCapture,
  type ScreenContinuousResult,
  type ScreenSegment,
} from "../../modules/proovra-screen-capture";

type SessionRef = { session: DirectCaptureSession; evidenceId: string };

type Recovery = null | { kind: "ended" } | { kind: "orphan" } | { kind: "leftover" } | { kind: "mismatch" };

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

  // Decision 2 — the Location choice made in Capture, shown and changeable
  // HERE, and read BEFORE the recording starts (never after).
  const params = useLocalSearchParams<{ useLocation?: string; locationRequired?: string; linkGroup?: string }>();
  const [useLocation, setUseLocation] = useState(() => locationParam(params.useLocation));
  const locationRequired = locationParam(params.locationRequired);
  const linkGroup = typeof params.linkGroup === "string" && params.linkGroup ? params.linkGroup : null;
  const [locationNote, setLocationNote] = useState<string | null>(null);
  /** The reservation's location fields, fixed before the OS consent / picker. */
  const locationRef = useRef<ReturnType<typeof reservationLocationFields> | null>(null);
  const carriedLocationRef = useRef<CarriedLocation | null>(null);
  // Optional microphone (Android: an explicit in-app choice + RECORD_AUDIO;
  // iOS: Apple's picker carries the microphone button and IS the consent).
  const [microphone, setMicrophone] = useState(false);
  const [microphoneNote, setMicrophoneNote] = useState<string | null>(null);
  // Contract B — the ONE recording file a new native build hands back.
  const singleRef = useRef<SingleFileRecording | null>(null);
  const [single, setSingle] = useState<SingleFileRecording | null>(null);

  // The ONE canonical session + evidence for the whole recording, and the segments
  // declared so far. Refs, not state, so the segment listener always sees the
  // latest without re-subscribing; persisted as they change (durability).
  const sessionRef = useRef<SessionRef | null>(null);
  const declaredRef = useRef<DeclaredSegment[]>([]);
  const resultRef = useRef<ScreenContinuousResult | null>(null);
  const openingRef = useRef(false);
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // AUD-006 — iOS: the broadcast recording this screen bound before Apple's
  // picker. Only that recording opens, feeds and is stopped for the session.
  const recordingIdRef = useRef<string | null>(null);

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
  // AUD-004 — the continuity manifest once FIXED (persisted before its first
  // upload): a retry or a restart during finalization stages exactly it again.
  const stagedManifestRef = useRef<{ manifestJson: string; manifestPartIndex: number } | null>(null);

  const persistLive = useCallback(() => {
    const active = sessionRef.current;
    if (!active) return Promise.resolve();
    return saveLiveContinuousSession({
      captureSessionId: active.session.captureSessionId,
      evidenceId: active.evidenceId,
      expiresAtUtc: active.session.expiresAtUtc,
      platform: isIOS ? "ios" : "android",
      recordingId: recordingIdRef.current,
      declared: declaredRef.current,
      clientLimitations: Array.from(clientLimitationsRef.current),
      openedAtIso: new Date().toISOString(),
      stagedManifest: stagedManifestRef.current,
    });
  }, [isIOS]);

  const requestControlledStop = useCallback(
    (limitation: string | null, message: string | null) => {
      if (limitation) clientLimitationsRef.current.add(limitation);
      if (stopRequestedRef.current) return;
      stopRequestedRef.current = true;
      if (message) toast.addToast(message, "info");
      // Fire-and-forget: native stops emitting new segments; the queue keeps draining.
      void stopContinuousCapture(recordingIdRef.current).catch(() => {});
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
        .then(async (declared) => {
          // AUD-004 — the native ledger records the confirmation first, then
          // releases the local copy (never before PROOVRA holds the bytes).
          await confirmContinuousSegment(active.session, seg, declared);
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
      // AUD-006 — another recording's segment is never uploaded into this session.
      if (!segmentBelongsToRecording(Platform.OS, recordingIdRef.current, seg)) return;
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
    for (const seg of getContinuousSegments(recordingIdRef.current)) onSegment(seg);
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
    stagedManifestRef.current = null;
    recordingIdRef.current = null;
    singleRef.current = null;
    setSingle(null);
  }, []);

  /** Release an opened-but-unstaged session: server, native recorder, local files, durable record. */
  const releaseSession = useCallback(async () => {
    const active = sessionRef.current;
    const recordingId = recordingIdRef.current;
    sessionRef.current = null;
    clearStartTimer();
    if (getScreenContinuousState(recordingId).active) await stopContinuousCapture(recordingId).catch(() => undefined);
    await cleanupContinuousTempFiles(seenRef.current);
    await discardContinuousSpool(recordingId).catch(() => undefined);
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
      // The location was read BEFORE the recording started (start()); it goes
      // into the reservation as it was then.
      const opened = await beginContinuousSession({
        teamId,
        location: locationRef.current ?? reservationLocationFields({ useLocation: false, result: null }),
      });
      // Held at once, so a failure below releases it on the server.
      sessionRef.current = opened;
      // Bound to THIS session before anything uploads. AUD-004 (Android): the
      // durable native ledger, so a recovery can never merge the recording into
      // another one. AUD-006 (iOS): the broadcast recording records which
      // session holds it (refused for a recording PROOVRA did not request).
      await bindContinuousSession({
        captureSessionId: opened.session.captureSessionId,
        evidenceId: opened.evidenceId,
        ownerUserId: userId,
        recordingId: recordingIdRef.current,
      });
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
  }, [teamId, userId, persistLive, syncFromNative, pump, releaseSession, clearStartTimer]);

  // Live segment stream + start/stop events.
  useEffect(() => {
    const segSub = addScreenSegmentListener(onSegment);
    const stopSub = addContinuousStoppedListener((r: ScreenContinuousResult) => {
      resultRef.current = r;
    });
    const startSub = addContinuousStartedListener((e) => {
      // AUD-006 — only the broadcast that adopted THIS screen's binding opens a
      // session; one started from Control Center (UNBOUND) never does.
      if (!acceptsBroadcastStart(Platform.OS, recordingIdRef.current, e)) return;
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
        const native = getScreenContinuousState(recordingIdRef.current);
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
          // AUD-006 — iOS: reattach only to the recording this session bound;
          // any other recording is refused, never attached or uploaded.
          const decision = isIOS ? decideIosReattach(live, getScreenContinuousState(live.recordingId)) : null;
          if (decision?.kind === "refuse") {
            setRecovery({ kind: "mismatch" });
            return;
          }
          if (decision && live.recordingId) {
            const bound = await bindContinuousSession({
              captureSessionId: live.captureSessionId,
              evidenceId: live.evidenceId,
              ownerUserId: userId,
              recordingId: live.recordingId,
            }).catch(() => false);
            if (cancelled) return;
            if (!bound) {
              setRecovery({ kind: "mismatch" });
              return;
            }
          }
          sessionRef.current = {
            session: { captureSessionId: live.captureSessionId, expiresAtUtc: live.expiresAtUtc },
            evidenceId: live.evidenceId,
          };
          recordingIdRef.current = live.recordingId;
          declaredRef.current = live.declared;
          clientLimitationsRef.current = new Set(live.clientLimitations);
          if (decision ? decision.kind === "reattach" : native.active && !native.stale) {
            dispatch({ type: "STARTED" });
            dispatch({ type: "SEGMENT_UPLOADED", uploaded: live.declared.length });
            syncFromNative();
            pump();
          } else {
            setRecovery({ kind: "ended" });
          }
        } else if (native.active) {
          setRecovery({ kind: "orphan" });
        } else if (planContinuousRecovery(getContinuousLedger(), null, userId).kind === "RECOVER") {
          // AUD-004 — the JS record was lost but the durable ledger proves a
          // recording bound to THIS user's session: recoverable, not leftover.
          // (No ledger on iOS: the plan is NONE there.)
          setRecovery({ kind: "ended" });
        } else if (
          isIOS
            ? listContinuousRecordings().some((r) => !r.active && (r.segmentCount > 0 || (r as { layout?: string }).layout === "SINGLE_FILE"))
            : getContinuousSegments().length > 0 ||
              // Contract B — an interrupted SINGLE_FILE ledger has no segments
              // but blocks a new start (PENDING_RECORDING) until discarded.
              (getContinuousLedger()?.layout === "SINGLE_FILE" && getContinuousLedger()?.active === false)
        ) {
          // UC-IOS-010 — segments on disk that no session holds (the app was
          // killed before a session opened, or a broadcast was started from
          // Control Center): never wiped silently, never offered as uploadable.
          setRecovery({ kind: "leftover" });
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [syncFromNative, pump, userId, isIOS]),
  );

  useEffect(() => {
    const inFlight =
      state.phase === "awaiting" || state.phase === "active" || state.phase === "review" || state.phase === "finalizing";
    setCaptureActive(inFlight);
    return () => setCaptureActive(false);
  }, [state.phase]);

  // Wait until the bounded upload queue is drained (queue empty and no worker
  // in flight), so Stop/Finalize never race an unfinished segment upload —
  // BOUNDED (drainUploadQueue): it ends when the session is gone or the
  // deadline passes; whatever is still pending stays on disk in the ledger.
  const drainUploads = useCallback(
    () =>
      drainUploadQueue({
        pending: () => queueRef.current.length,
        inFlight: () => workersRef.current,
        hasSession: () => sessionRef.current !== null,
        pump,
        deadlineMs: CONTINUOUS_DRAIN_DEADLINE_MS,
      }),
    [pump],
  );

  const start = useCallback(
    async (opts: { notificationAcknowledged?: boolean } = {}) => {
      setBusy(true);
      try {
        resetStreamRefs();
        // Decision 2 — LOCATION FIRST: read before Apple's picker / Android's
        // consent, so the location recorded is where the device was when the
        // recording started. A failure is the person's call (Retry, record
        // without location unless the plan requires it, or Cancel).
        if (!locationRef.current) {
          if (!useLocation) {
            locationRef.current = reservationLocationFields({ useLocation: false, result: null });
            carriedLocationRef.current = { useLocation: false, outcome: null, recordedAtStart: true };
          } else {
            setLocationNote("Checking location…");
            const decision = await acquireLocationWithChoice({
              required: locationRequired,
              proceedLabel: "Record without location",
            });
            if (decision.kind === "cancel") {
              setLocationNote(decision.result ? locationOutcomeMessage(decision.result.outcome) : null);
              return;
            }
            setLocationNote(
              decision.kind === "acquired"
                ? "Location recorded for the start of this recording."
                : `${locationOutcomeMessage(decision.result.outcome)} Recording without location.`,
            );
            locationRef.current = reservationLocationFields({ useLocation: true, result: decision.result });
            carriedLocationRef.current = { useLocation: true, outcome: decision.result.outcome, recordedAtStart: true };
          }
        }
        // Optional microphone (Android): the in-app choice, then RECORD_AUDIO.
        let withMicrophone = false;
        if (!isIOS && microphone) {
          const mic = await requestRecordingPermissionsAsync().catch(() => ({ granted: false }));
          if (!mic.granted) {
            setMicrophoneNote(
              "Microphone permission was not granted, so nothing was started. Turn microphone audio off to record the screen without it, or allow the microphone in Settings.",
            );
            return;
          }
          withMicrophone = true;
        }
        // UC-AND-003 — Android 13+: ask for the notification that carries Stop.
        if (Platform.OS === "android" && !opts.notificationAcknowledged) {
          const permission = await ensureCaptureNotificationPermission();
          if (permission === "denied") {
            setNotificationDenied(true);
            return;
          }
        }
        // The OS consent comes FIRST; no server session exists until the OS records.
        const started = await startContinuousCapture(
          (withMicrophone ? { microphone: true } : {}) as Parameters<typeof startContinuousCapture>[0],
        );
        recordingIdRef.current = started.recordingId ?? null;
        if (started.awaitingSystemStart) {
          dispatch({ type: "AWAITING_SYSTEM_START" });
          clearStartTimer();
          startTimerRef.current = setTimeout(() => {
            if (sessionRef.current) return;
            // iOS: also withdraws the binding, so a later broadcast cannot adopt it.
            void stopContinuousCapture(recordingIdRef.current).catch(() => undefined);
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
    [resetStreamRefs, openServerSession, releaseSession, clearStartTimer, useLocation, locationRequired, microphone, isIOS],
  );

  /** Stop (or adopt an already-ended recording) and show the reconciled summary. */
  const stop = useCallback(async () => {
    setBusy(true);
    try {
      stopRequestedRef.current = true;
      const result = await stopContinuousCapture(recordingIdRef.current);
      resultRef.current = result;
      // Contract B — a new build hands back ONE file and streamed nothing.
      const rec = readSingleFileRecording(result);
      if (rec) {
        singleRef.current = rec;
        setSingle(rec);
        const outcome = singleFileOutcome(result, rec);
        dispatch({
          type: "STOPPED",
          captured: outcome.kind === "NO_FILE" ? 0 : 1,
          uploaded: 0,
          completeness: outcome.kind === "COMPLETE" || outcome.kind === "BOUNDS_REACHED" ? result.sessionCompleteness : "INTERRUPTED_SESSION",
          stopReason: result.terminationReason,
        });
        return;
      }
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

  /**
   * AUD-004 — recover a recording that ended while PROOVRA was closed, from the
   * DURABLE native ledger: every recorded segment (confirmed or not), the
   * session result (INTERRUPTED unless the recorder finished cleanly) and the
   * device block. It enters the ordinary review; Continue then uploads what
   * PROOVRA never confirmed and stages the manifest — the same finalize. A
   * platform without a ledger (iOS) adopts the recorder's own summary.
   */
  const recoverEnded = useCallback(async () => {
    setRecovery(null);
    const plan = planContinuousRecovery(getContinuousLedger(), await loadLiveContinuousSession(), userId);
    if (plan.kind === "MISMATCH" || plan.kind === "UNBOUND") {
      // The recording on this device is not bound to the session this device
      // holds: it is never merged into it. Only an explicit discard remains.
      setRecovery({ kind: "leftover" });
      return;
    }
    if (plan.kind !== "RECOVER") {
      dispatch({ type: "STARTED" });
      await stop();
      return;
    }
    sessionRef.current = { session: plan.session, evidenceId: plan.evidenceId };
    declaredRef.current = plan.declared;
    seenRef.current = plan.pending;
    clientLimitationsRef.current = new Set(plan.clientLimitations);
    stagedManifestRef.current = plan.stagedManifest;
    const result = plan.result as ScreenContinuousResult;
    resultRef.current = result;
    capturedRef.current = result.segmentCount;
    // The JS record is rebuilt from the ledger if it was lost.
    await persistLive();
    const rec = readSingleFileRecording(result);
    if (rec) {
      singleRef.current = rec;
      setSingle(rec);
      dispatch({ type: "STARTED" });
      dispatch({
        type: "STOPPED",
        captured: rec.recordingUri ? 1 : 0,
        uploaded: plan.declared.length,
        completeness: rec.finalized ? result.sessionCompleteness : "INTERRUPTED_SESSION",
        stopReason: result.terminationReason,
      });
      return;
    }
    const reconciled = reconcileContinuousUploads(result, plan.declared, plan.clientLimitations);
    dispatch({ type: "STARTED" });
    dispatch({
      type: "STOPPED",
      captured: reconciled.recordedSegmentCount,
      uploaded: plan.declared.length,
      completeness: reconciled.sessionCompleteness,
      stopReason: result.terminationReason,
    });
  }, [stop, userId, persistLive]);

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
      let staged: { manifestJson: string; segmentCount: number; sessionCompleteness: string; sizeBytes?: number };
      const rec = singleRef.current;
      if (rec) {
        // Contract A/B — ONE file: part 0 is the recording, part 1 the
        // manifest. Durable like the segmented path: part 0 is recorded once
        // at storage and a fixed manifest is re-sent byte for byte on retry.
        step = "stage";
        const at0 = declaredRef.current.find((d) => d.partIndex === 0) ?? null;
        staged = await stageSingleFileRecording(active.session, active.evidenceId, result, rec, {
          declared: at0 ? { sha256Hex: at0.sha256Hex, sizeBytes: at0.sizeBytes } : null,
          existing: stagedManifestRef.current,
          extraLimitations: Array.from(clientLimitationsRef.current),
          onDeclared: async (d) => {
            declaredRef.current = [
              {
                partIndex: 0,
                sequence: 0,
                sha256Hex: d.sha256Hex,
                sizeBytes: d.sizeBytes,
                startedAtOffsetMs: 0,
                durationMs: rec.recordingDurationMs ?? 0,
                widthPx: rec.widthPx ?? 1,
                heightPx: rec.heightPx ?? 1,
                orientation: rec.orientationTimeline[0]?.orientation ?? ((rec.widthPx ?? 0) >= (rec.heightPx ?? 1) ? "landscape" : "portrait"),
              },
            ];
            await persistLive();
          },
          onManifestFixed: async (fixed) => {
            stagedManifestRef.current = fixed;
            await persistLive();
          },
        });
      } else {
        await drainUploads();
        // UC-STR-002 / AUD-004 — retry every recorded-but-undeclared segment from
        // disk, then stage, through the ONE recovery executor (idempotent, never
        // destructive). A segment refused for good is stated SEGMENT_UPLOAD_LOST;
        // a retryable failure keeps the session for Continue.
        const deps = continuousRecoveryDeps(async (state) => {
          declaredRef.current = state.declared;
          stagedManifestRef.current = state.stagedManifest;
          await persistLive();
        });
        const outcome = await recoverOnce(active.session.captureSessionId, () =>
          executeContinuousRecovery(
            {
              kind: "RECOVER",
              session: active.session,
              evidenceId: active.evidenceId,
              declared: declaredRef.current,
              pending: undeclaredSegments(seenRef.current, declaredRef.current),
              result,
              clientLimitations: Array.from(clientLimitationsRef.current),
              stagedManifest: stagedManifestRef.current,
            },
            {
              ...deps,
              stage: (...args) => {
                step = "stage";
                return deps.stage(...args);
              },
            },
          ),
        );
        if (outcome.kind === "SESSION_GONE") {
          // The server closed the session (expired / reaped). Nothing is
          // deleted: the recording stays on this device until the user discards.
          dispatch({ type: "STAGE_FAILED", message: CONTINUOUS_SESSION_GONE });
          return;
        }
        staged = outcome.staged;
      }

      // The canonical draft, and the durable record the Capture surface
      // resumes. The segments are already at storage, so finalize seals
      // without re-uploading them.
      step = "handoff";
      const mode: ScreenAcquisitionMode =
        Platform.OS === "ios"
          ? "DIRECT_SCREEN_CAPTURE_IOS"
          : "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS";
      const baseItem = toScreenDraftItem({
        mode,
        clientItemId: active.session.captureSessionId,
        partCount: staged.segmentCount,
        sizeBytes: staged.sizeBytes ?? continuousSessionBytes(declaredRef.current),
      });
      // A single-file recording is ONE file, named as such (never "1 segment").
      const item = rec
        ? {
            ...baseItem,
            fileName: singleFileName(result.captureStartedAtUtc),
            durationMs: rec.recordingDurationMs ?? null,
          }
        : baseItem;
      const carried = carriedLocationRef.current ?? { useLocation: false, outcome: null, recordedAtStart: false };
      // Its id travels with the durable record, so Capture closes THIS draft at
      // finalize instead of leaving it listed as unfinished. AUD-004 — a
      // restart after the hand-off reuses the draft it already opened. The
      // draft carries the location CHOICE (it used to say false for every
      // recording, and resume then switched the toggle off).
      const previous = await findCaptureSession({ captureSessionId: active.session.captureSessionId }).catch(() => null);
      const draftId = previous?.draftId
        ? previous.draftId
        : ((await openCaptureDraft({ items: [item], teamId, useLocation: carried.useLocation }).catch(() => null))?.id ?? null);
      await saveCaptureSession({
        draftId,
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
            source: rec ? "SCREEN_RECORDING" : "SCREEN_SEGMENT",
            sizeBytes: item.sizeBytes,
            durationMs: item.durationMs ?? undefined,
            uploaded: true,
            // The ORIGIN the mixed-origin guard reads in Capture.
            itemSourceLabel: mode,
          },
        ],
        acquisition: { mode, manifestJson: staged.manifestJson },
        location: carried,
        linkGroupId: linkGroup,
      });
      if (linkGroup) {
        await registerLinkedRecord(linkGroup, captureRecordKey({ captureSessionId: active.session.captureSessionId, draftId })).catch(
          () => undefined,
        );
      }
      await clearLiveContinuousSession();
      // The session is staged: release the device spool (AUD-004 — through the
      // ledger, bound to exactly this session; AUD-006 — on iOS, the spool of
      // exactly this session's recording), and the one local file.
      await releaseStagedContinuousSpool(active.session.captureSessionId, recordingIdRef.current);
      await releaseSingleFileRecording(rec);

      sessionRef.current = null;
      dispatch({
        type: "FINALIZED",
        evidenceId: active.evidenceId,
        segmentCount: staged.segmentCount,
        completeness: staged.sessionCompleteness,
      });
      // Decision 3 — a review state with clear actions, not an immediate
      // redirect: "Capture another" stays reachable, and this record waits,
      // pending, in Capture.
      toast.addToast("Recording staged — review and finish it in Capture", "success");
    } catch (err) {
      // UC-STR-001 — the session is KEPT: its segments are at storage and
      // declared. Continue retries staging; Discard releases it.
      const detail = toSafeUserError(err, { message: "" }).message;
      dispatch({
        type: "STAGE_FAILED",
        message: detail ? `${CONTINUOUS_STAGE_FAILURE[step]} (${detail})` : CONTINUOUS_STAGE_FAILURE[step],
      });
    }
  }, [drainUploads, toast, persistLive, teamId, linkGroup]);

  const reset = useCallback(async () => {
    // Discard / Try Again / a new recording: an opened-but-unstaged session is
    // RELEASED on the server (UC-STR-004), the recorder stopped, local segment
    // files and the durable record removed.
    // After a successful staging the session is already handed to Capture
    // (sessionRef is null), so "Capture another" releases nothing of it: the
    // staged record stays pending there and the next recording is a NEW one.
    await releaseSession();
    await releaseSingleFileRecording(singleRef.current);
    resetStreamRefs();
    // Each recording reads its own start location.
    locationRef.current = null;
    carriedLocationRef.current = null;
    setLocationNote(null);
    setMicrophoneNote(null);
    setRecovery(null);
    setNotificationDenied(false);
    dispatch({ type: "RESET" });
  }, [releaseSession, resetStreamRefs]);

  /** Back to Capture, where the staged record is listed as pending. */
  const reviewInCapture = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/capture");
  }, [router]);

  const stopOrphan = useCallback(async () => {
    // AUD-006 — iOS: each recording is stopped and discarded by its own id (the
    // user's explicit choice); Android has one recorder.
    const ids: Array<string | null> = isIOS ? listContinuousRecordings().map((r) => r.recordingId) : [null];
    for (const id of ids) {
      const segs = getContinuousSegments(id);
      await stopContinuousCapture(id).catch(() => undefined);
      await cleanupContinuousTempFiles(segs);
      await discardContinuousSpool(id).catch(() => undefined);
    }
    setRecovery(null);
  }, [isIOS]);

  /** AUD-006 — release a saved session whose recording is not (or no longer) its own. */
  const releaseMismatched = useCallback(async () => {
    const live = await loadLiveContinuousSession();
    await clearLiveContinuousSession();
    if (live) {
      await discardDirectCaptureSession({ captureSessionId: live.captureSessionId, expiresAtUtc: live.expiresAtUtc }).catch(
        () => undefined,
      );
    }
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

        {recovery?.kind === "mismatch" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" weight="semibold">The recording on this device is not this capture session's.</ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              PROOVRA did not attach it, so nothing from it is uploaded into the saved session. Discard the saved session to continue; any recording on this device stays until you discard it.
            </ProovraText>
            <ProovraButton label="Discard saved session" onPress={() => void releaseMismatched()} />
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
            <Bullet text="One Start-to-Stop recording is kept as one video and sealed as its own evidence record." />
            {/* Product decision 1 — the limits are stated BEFORE recording. */}
            <Bullet
              text={`Limit: up to ${formatSingleFileLimits()} per recording. Reaching a limit stops the recording; it is never split or continued in a second file.`}
            />
            <Bullet text={copy.protectedContent} />
            <Bullet text={copy.control} />
            {isIOS ? (
              <Bullet text="Microphone: Apple's broadcast picker has a microphone button. It is off unless you turn it on there; PROOVRA records only what you choose." />
            ) : (
              <View style={styles.toggleRow}>
                <View style={styles.toggleText}>
                  <ProovraText variant="bodySm" weight="semibold">Record microphone audio</ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {microphone ? "Your microphone is recorded with the screen. Android will ask for microphone permission." : "Off — the recording has no microphone audio."}
                  </ProovraText>
                </View>
                <Switch
                  value={microphone}
                  onValueChange={(v) => {
                    setMicrophone(v);
                    setMicrophoneNote(null);
                  }}
                  accessibilityLabel="Record microphone audio"
                />
              </View>
            )}
            {microphoneNote ? (
              <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{microphoneNote}</ProovraText>
            ) : null}
            {/* Decision 2 — the Location choice, read BEFORE the recording starts. */}
            <View style={styles.toggleRow}>
              <View style={styles.toggleText}>
                <ProovraText variant="bodySm" weight="semibold">Location</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {useLocation
                    ? "Included — read once, before the recording starts."
                    : locationRequired
                      ? "Required by the selected plan."
                      : "Not included."}
                </ProovraText>
              </View>
              <Switch
                value={useLocation}
                onValueChange={(v) => {
                  setUseLocation(v);
                  setLocationNote(null);
                  locationRef.current = null;
                }}
                accessibilityLabel="Include location metadata"
              />
            </View>
            {locationNote ? (
              <ProovraText variant="label" color={theme.color.ink.secondary} testID="continuous-location-status">{locationNote}</ProovraText>
            ) : null}
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              A screen recording captures what your device displayed. It does not establish that the content is true, who authored it, that an app or account shown is genuine, or that the session is free of gaps.
            </ProovraText>
            {/* UC-LCH-001 — the canonical screen-capture disclosure. */}
            <ProovraText variant="label" color={theme.color.accent.a600} accessibilityRole="link" accessibilityLabel="How screen capture works" onPress={() => router.push("/legal/screen-capture")}>
              How screen capture works
            </ProovraText>
            <ProovraButton
              label="Start Continuous Capture"
              loading={busy}
              disabled={locationRequired && !useLocation}
              onPress={() => void start()}
            />
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
            <ProovraText variant="body" weight="semibold">
              {state.captured > 0
                ? `${state.captured} segment(s) recorded · ${state.uploaded} uploaded.`
                : "Recording. The recording is uploaded after you stop."}
            </ProovraText>
            {locationNote ? (
              <ProovraText variant="label" color={theme.color.ink.secondary}>{locationNote}</ProovraText>
            ) : null}
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              {notificationDenied && !isIOS
                ? "Leave PROOVRA and open what you want to record. Segments upload in the background. The notification is off, so return to PROOVRA and tap Stop here when you are done."
                : copy.active}
            </ProovraText>
            <ProovraButton label="Stop &amp; Review" loading={busy} onPress={() => void stop()} />
          </ProovraCard>
        )}

        {state.phase === "review" && single && (
          <SingleFileReview
            rec={single}
            result={resultRef.current}
            notice={state.notice ?? null}
            onContinue={() => void finalize()}
            onDiscard={() => void reset()}
          />
        )}

        {state.phase === "review" && !single && (
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
          <ProovraCard style={styles.card} testID="continuous-staged">
            <ProovraBadge
              tone="pending"
              label={
                single
                  ? `${CONTINUOUS_REVIEW_COPY.staged} (one recording, ${state.completeness === "COMPLETE_SESSION" ? "reported complete" : "interrupted"})`
                  : `${CONTINUOUS_REVIEW_COPY.staged} (${state.segmentCount} segment(s), ${state.completeness === "COMPLETE_SESSION" ? "reported complete" : "interrupted"})`
              }
            />
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              This recording is its own evidence record, pending in Capture. It is not signed until you finish it there. Capturing another starts a new, separate record — this one stays pending.
            </ProovraText>
            <ProovraButton label="Review in Capture" onPress={reviewInCapture} />
            <ProovraButton label="Capture another" variant="secondary" onPress={() => void reset()} />
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

/**
 * The review of ONE recording file (contract B): what the device says it
 * produced, in words — never "complete" for an interrupted or unfinished file.
 */
function SingleFileReview({
  rec,
  result,
  notice,
  onContinue,
  onDiscard,
}: {
  rec: SingleFileRecording;
  result: ScreenContinuousResult | null;
  notice: string | null;
  onContinue: () => void;
  onDiscard: () => void;
}) {
  const outcome = singleFileOutcome(
    { terminationReason: result?.terminationReason ?? "UNKNOWN", sessionCompleteness: result?.sessionCompleteness ?? "INTERRUPTED_SESSION" },
    rec,
  );
  const minutes = rec.recordingDurationMs !== null ? Math.floor(rec.recordingDurationMs / 60_000) : null;
  const seconds = rec.recordingDurationMs !== null ? Math.floor((rec.recordingDurationMs % 60_000) / 1000) : null;
  const facts = [
    minutes !== null && seconds !== null ? `${minutes}:${String(seconds).padStart(2, "0")} long` : null,
    rec.recordingSizeBytes !== null ? `${(rec.recordingSizeBytes / (1024 * 1024)).toFixed(1)} MB` : null,
    (rec.droppedFrameCount ?? 0) > 0 ? `${rec.droppedFrameCount} frame(s) the device could not write` : null,
    (rec.droppedAudioBufferCount ?? 0) > 0 ? `${rec.droppedAudioBufferCount} audio buffer(s) the device could not write` : null,
    rec.pauses.length > 0 ? `paused ${rec.pauses.length} time(s) — those stretches are not in the recording` : null,
  ].filter(Boolean);
  return (
    <ProovraCard style={styles.card} testID="continuous-single-review">
      <ProovraText variant="body" weight="semibold">{outcome.headline}</ProovraText>
      <ProovraBadge
        tone="neutral"
        label={outcome.kind === "COMPLETE" || outcome.kind === "BOUNDS_REACHED" ? CONTINUOUS_COMPLETENESS_LABEL.complete : CONTINUOUS_COMPLETENESS_LABEL.interrupted}
      />
      <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{outcome.detail}</ProovraText>
      {facts.length > 0 ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>{facts.join(" · ")}</ProovraText>
      ) : null}
      <ProovraText variant="label" color={theme.color.ink.secondary}>{audioTracksLabel(rec.audioTracks)}</ProovraText>
      {notice ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{notice}</ProovraText> : null}
      <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
        Continue uploads this one recording and opens it in Capture, where Finish &amp; Sign seals it as its own evidence record. PROOVRA verifies its integrity on the server.
      </ProovraText>
      {outcome.kind === "NO_FILE" ? null : <ProovraButton label={CONTINUOUS_REVIEW_COPY.action} onPress={onContinue} />}
      <ProovraButton label="Discard" variant="ghost" onPress={onDiscard} />
    </ProovraCard>
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
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s2 },
  toggleText: { flex: 1, gap: 2 },
});
