/**
 * UC-3 — Android Continuous (streaming) Screen Capture screen.
 *
 * User-initiated only. It discloses what Android will ask and what PROOVRA can and
 * cannot establish BEFORE recording, opens ONE canonical direct-capture session,
 * starts the bounded native recording (Android's own consent dialog + a
 * foreground-service notification with a Stop action), then STREAMS each finalized
 * ORIGINAL segment to the server WHILE recording continues — nothing is buffered as
 * a giant in-memory recording. The user can leave PROOVRA, walk through the target
 * content, and Stop from the notification without returning. On Stop it reviews the
 * session summary and seals ONE Evidence record (N segments + a continuity
 * manifest) through the canonical pipeline; the server recomputes every segment
 * digest. Android-only; respects the Personal-Space capture gate; reconnects to an
 * in-flight session on return so a new CaptureSession is never created.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Platform, View, StyleSheet } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SCREEN_CONTINUOUS_STREAM_BOUNDS } from "@proovra/shared";

import { theme } from "../../src/theme/theme";
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
import {
  beginContinuousSession,
  cleanupContinuousTempFiles,
  finalizeContinuousCapture,
  uploadContinuousSegment,
  type DeclaredSegment,
} from "../../src/continuous-capture";
import type { DirectCaptureSession } from "../../src/direct-capture";
import {
  INITIAL_CONTINUOUS_FLOW,
  continuousFlowReducer,
  shouldStopForBackpressure,
} from "../../src/continuous-capture-flow";
import {
  addContinuousStoppedListener,
  addScreenSegmentListener,
  getScreenContinuousState,
  isScreenContinuousSupported,
  startContinuousCapture,
  stopContinuousCapture,
  type ScreenContinuousResult,
  type ScreenSegment,
} from "../../modules/proovra-screen-capture";

type SessionRef = { session: DirectCaptureSession; evidenceId: string };

export default function ContinuousCaptureScreen() {
  const router = useRouter();
  const toast = useToast();
  const personalSpace = usePersonalSpaceAllowed();
  const [state, dispatch] = useReducer(continuousFlowReducer, INITIAL_CONTINUOUS_FLOW);
  const [busy, setBusy] = useState(false);
  const isIOS = Platform.OS === "ios";
  const supported =
    (Platform.OS === "android" || isIOS) && isScreenContinuousSupported();

  // The ONE canonical session + evidence for the whole recording, and the segments
  // declared so far. Refs, not state, so the segment listener always sees the
  // latest without re-subscribing.
  const sessionRef = useRef<SessionRef | null>(null);
  const declaredRef = useRef<DeclaredSegment[]>([]);
  const resultRef = useRef<ScreenContinuousResult | null>(null);

  // BOUNDED STREAMING: recorded segments enter a queue drained by a fixed number of
  // upload workers (concurrency bound), so in-flight uploads — and the transient
  // per-segment hashing memory — can never grow without limit. `pending` (recorded
  // minus uploaded) is the backlog; when it reaches the bound the client triggers a
  // CONTROLLED stop rather than letting RAM/disk grow or silently dropping segments.
  const queueRef = useRef<ScreenSegment[]>([]);
  const workersRef = useRef(0);
  const capturedRef = useRef(0);
  const uploadedBytesRef = useRef(0);
  const seenRef = useRef<ScreenSegment[]>([]);
  const clientLimitationsRef = useRef<Set<string>>(new Set());
  const stopRequestedRef = useRef(false);

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
      workersRef.current += 1;
      uploadContinuousSegment(active.session, active.evidenceId, seg)
        .then((declared) => {
          declaredRef.current = [...declaredRef.current, declared];
          uploadedBytesRef.current += declared.sizeBytes;
          dispatch({ type: "SEGMENT_UPLOADED", uploaded: declaredRef.current.length });
          // Whole-session byte ceiling: keep the sealed Evidence under the canonical
          // MAX_EVIDENCE_SIZE_MB completion cap so it always seals and stays fully
          // packageable/reportable/destroyable. Controlled stop — nothing dropped.
          if (uploadedBytesRef.current >= SCREEN_CONTINUOUS_STREAM_BOUNDS.maxSessionBytes) {
            requestControlledStop(
              "SESSION_BOUNDS_REACHED",
              "The recording reached its size limit and stopped. Tap Stop & Review to save it.",
            );
          }
        })
        .catch((err) => {
          // A single lost segment must not silently pass as continuous. Surface it;
          // the manifest's contiguous-sequence check refuses a gap at finalize.
          toast.addToast(
            err instanceof Error ? err.message : "A screen segment could not be uploaded.",
            "error",
          );
        })
        .finally(() => {
          workersRef.current -= 1;
          pump();
        });
    }
  }, [toast, requestControlledStop]);

  const onSegment = useCallback(
    (seg: ScreenSegment) => {
      if (!sessionRef.current) return;
      capturedRef.current = Math.max(capturedRef.current, seg.sequence + 1);
      seenRef.current = [...seenRef.current, seg];
      dispatch({ type: "SEGMENT_CAPTURED", captured: capturedRef.current });
      queueRef.current = [...queueRef.current, seg];
      // Backpressure: too many recorded-but-unuploaded segments → controlled stop.
      if (
        shouldStopForBackpressure(
          capturedRef.current,
          declaredRef.current.length,
          SCREEN_CONTINUOUS_STREAM_BOUNDS.maxPendingSegments,
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

  // Live segment stream + stop events, and reconnect to an in-flight session when
  // the user returns to PROOVRA after stopping from the notification.
  useEffect(() => {
    const segSub = addScreenSegmentListener(onSegment);
    const stopSub = addContinuousStoppedListener((r: ScreenContinuousResult) => {
      resultRef.current = r;
    });
    return () => {
      segSub.remove();
      stopSub.remove();
    };
  }, [onSegment]);

  useFocusEffect(
    useCallback(() => {
      const s = getScreenContinuousState();
      if (s.active && sessionRef.current) {
        // Reconnect the UI to the SAME active native session (never start a new one).
        dispatch({ type: "STARTED" });
        if (s.segmentCount > 0) dispatch({ type: "SEGMENT_CAPTURED", captured: s.segmentCount });
      }
    }, []),
  );

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
  }, []);

  // Wait until the bounded upload queue is fully drained (queue empty and no worker
  // in flight), so Stop/Finalize never race an unfinished segment upload.
  const drainUploads = useCallback(async () => {
    while (queueRef.current.length > 0 || workersRef.current > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      resetStreamRefs();
      // Open the canonical session FIRST so segments can stream while recording.
      sessionRef.current = await beginContinuousSession();
      await startContinuousCapture();
      dispatch({ type: "STARTED" });
    } catch (err) {
      sessionRef.current = null;
      dispatch({
        type: "FAIL",
        message: err instanceof Error ? err.message : "Screen capture consent was not granted.",
        recoverable: true,
      });
    } finally {
      setBusy(false);
    }
  }, [resetStreamRefs]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      stopRequestedRef.current = true;
      const result = await stopContinuousCapture();
      resultRef.current = result;
      // Drain the bounded upload queue before showing the review summary.
      await drainUploads();
      dispatch({
        type: "STOPPED",
        captured: result.segmentCount,
        uploaded: declaredRef.current.length,
        completeness: result.sessionCompleteness,
        stopReason: result.terminationReason,
      });
    } catch (err) {
      dispatch({ type: "FAIL", message: err instanceof Error ? err.message : "Could not stop capture." });
    } finally {
      setBusy(false);
    }
  }, [drainUploads]);

  const finalize = useCallback(async () => {
    const active = sessionRef.current;
    const result = resultRef.current;
    if (!active || !result) {
      dispatch({ type: "FAIL", message: "The capture session was lost. Please start again." });
      return;
    }
    dispatch({ type: "FINALIZE" });
    try {
      // Belt-and-braces: ensure every queued upload has settled before the manifest.
      await drainUploads();
      // Record any client-detected limitations (upload backpressure, session-bytes
      // ceiling) truthfully in the manifest. Continuity still holds — the recorded
      // segments are contiguous and uploaded; the stop was controlled, nothing dropped.
      const resultForManifest: ScreenContinuousResult =
        clientLimitationsRef.current.size > 0
          ? {
              ...result,
              limitations: Array.from(new Set([...(result.limitations ?? []), ...clientLimitationsRef.current])),
            }
          : result;
      const sealed = await finalizeContinuousCapture(
        active.session,
        active.evidenceId,
        resultForManifest,
        declaredRef.current,
      );
      sessionRef.current = null;
      dispatch({
        type: "FINALIZED",
        evidenceId: sealed.evidenceId,
        segmentCount: sealed.segmentCount,
        completeness: sealed.sessionCompleteness,
      });
      toast.addToast("Evidence saved.", "success");
    } catch (err) {
      dispatch({ type: "FAIL", message: err instanceof Error ? err.message : "Could not finalize the evidence." });
    }
  }, [drainUploads, toast]);

  const reset = useCallback(() => {
    // Discard is PRE-finalize cleanup: any un-uploaded local segment files for this
    // session are removed (uploaded ones were already deleted after their PUT). This
    // is distinct from post-seal destruction.
    void cleanupContinuousTempFiles(seenRef.current);
    sessionRef.current = null;
    resetStreamRefs();
    dispatch({ type: "RESET" });
  }, [resetStreamRefs]);

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
        {state.phase === "intro" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" color={theme.color.ink.secondary}>
              PROOVRA will record what is shown on your screen as a continuous session, using the device's own screen-capture permission. Before it starts:
            </ProovraText>
            <Bullet text={isIOS
              ? "Apple will show its system broadcast picker — tap Start Broadcast to begin, and stop it from the same control or the status bar."
              : "Android will ask you to allow screen capture."} />
            <Bullet text="Recording continues until you stop it — anything visible can become evidence, including sensitive information." />
            <Bullet text="The session is split into short segments that upload as they are recorded." />
            <Bullet text="Protected content may be unavailable because of Android restrictions." />
            <Bullet text="You control it: stop the recording at any time from the capture notification." />
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              A screen recording captures what your device displayed. It does not establish that the content is true, who authored it, that an app or account shown is genuine, or that the session is free of gaps.
            </ProovraText>
            <ProovraButton label="Start Continuous Capture" loading={busy} onPress={start} />
            <ProovraButton label="Cancel" variant="ghost" onPress={() => router.back()} />
          </ProovraCard>
        )}

        {state.phase === "active" && (
          <ProovraCard style={styles.card}>
            <ProovraBadge tone="pending" label="Continuous capture active" />
            <ProovraText variant="body" weight="semibold">{state.captured} segment(s) recorded · {state.uploaded} uploaded.</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              Leave PROOVRA and open what you want to record. Segments upload in the background. Tap Stop from the notification, or here, when you are done.
            </ProovraText>
            <ProovraButton label="Stop &amp; Review" loading={busy} onPress={stop} />
          </ProovraCard>
        )}

        {state.phase === "review" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" weight="semibold">{state.captured} segment(s) recorded, {state.uploaded} uploaded and ready to seal.</ProovraText>
            <ProovraBadge
              tone={state.completeness === "COMPLETE_SESSION" ? "verified" : "pending"}
              label={state.completeness === "COMPLETE_SESSION" ? "Complete — no known interruption" : "Interrupted — ended before a clean stop"}
            />
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              Finalize to seal these segments into one evidence record. PROOVRA verifies every segment's integrity on the server and records whether the session was complete or interrupted. It does not claim continuity across any known gap.
            </ProovraText>
            <ProovraButton label="Finalize Evidence" onPress={finalize} />
            <ProovraButton label="Discard" variant="ghost" onPress={reset} />
          </ProovraCard>
        )}

        {state.phase === "finalizing" && (
          <ProovraLoadingState label={`Finalizing — sealing ${state.captured} segment(s) and verifying integrity`} />
        )}

        {state.phase === "success" && (
          <ProovraCard style={styles.card}>
            <ProovraBadge tone="verified" label={`Evidence saved (${state.segmentCount} segment(s), ${state.completeness === "COMPLETE_SESSION" ? "complete" : "interrupted"})`} />
            <ProovraButton label="View Evidence" onPress={() => router.replace(`/evidence/${state.evidenceId}`)} />
            <ProovraButton label="Capture Another" variant="secondary" onPress={reset} />
            <ProovraButton label="Done" variant="ghost" onPress={() => router.back()} />
          </ProovraCard>
        )}

        {state.phase === "error" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" color={theme.color.status.risk.fg}>{state.message}</ProovraText>
            {state.recoverable && <ProovraButton label="Try Again" onPress={reset} />}
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
