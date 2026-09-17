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
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { colors, spacing, typography } from "@proovra/ui";

import { Button } from "../../components/ui";
import { useToast } from "../../src/toast-context";
import { usePersonalSpaceAllowed } from "../../src/usePersonalSpaceAllowed";
import {
  beginContinuousSession,
  finalizeContinuousCapture,
  uploadContinuousSegment,
  type DeclaredSegment,
} from "../../src/continuous-capture";
import type { DirectCaptureSession } from "../../src/direct-capture";
import {
  INITIAL_CONTINUOUS_FLOW,
  continuousFlowReducer,
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
  const supported = Platform.OS === "android" && isScreenContinuousSupported();

  // The ONE canonical session + evidence for the whole recording, and the segments
  // declared so far. Refs, not state, so the segment listener always sees the
  // latest without re-subscribing. `pending` tracks in-flight uploads so Stop can
  // drain them before the continuity manifest is built.
  const sessionRef = useRef<SessionRef | null>(null);
  const declaredRef = useRef<DeclaredSegment[]>([]);
  const pendingRef = useRef<Promise<void>[]>([]);
  const resultRef = useRef<ScreenContinuousResult | null>(null);

  const uploadSegment = useCallback(
    (seg: ScreenSegment) => {
      const active = sessionRef.current;
      if (!active) return;
      dispatch({ type: "SEGMENT_CAPTURED", captured: seg.sequence + 1 });
      const task = uploadContinuousSegment(active.session, active.evidenceId, seg)
        .then((declared) => {
          declaredRef.current = [...declaredRef.current, declared];
          dispatch({ type: "SEGMENT_UPLOADED", uploaded: declaredRef.current.length });
        })
        .catch((err) => {
          // A single lost segment must not silently pass as continuous. Surface it;
          // the manifest's contiguous-sequence check will also refuse a gap.
          toast.addToast(
            err instanceof Error ? err.message : "A screen segment could not be uploaded.",
            "error",
          );
        });
      pendingRef.current = [...pendingRef.current, task];
    },
    [toast],
  );

  // Live segment stream + stop events, and reconnect to an in-flight session when
  // the user returns to PROOVRA after stopping from the notification.
  useEffect(() => {
    const segSub = addScreenSegmentListener(uploadSegment);
    const stopSub = addContinuousStoppedListener((r: ScreenContinuousResult) => {
      resultRef.current = r;
    });
    return () => {
      segSub.remove();
      stopSub.remove();
    };
  }, [uploadSegment]);

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

  const start = useCallback(async () => {
    setBusy(true);
    try {
      // Open the canonical session FIRST so segments can stream while recording.
      sessionRef.current = await beginContinuousSession();
      declaredRef.current = [];
      pendingRef.current = [];
      resultRef.current = null;
      await startContinuousCapture({ segmentMs: 6000, maxSegments: 600 });
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
  }, []);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      const result = await stopContinuousCapture();
      resultRef.current = result;
      // Drain in-flight segment uploads before showing the review summary.
      await Promise.allSettled(pendingRef.current);
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
  }, []);

  const finalize = useCallback(async () => {
    const active = sessionRef.current;
    const result = resultRef.current;
    if (!active || !result) {
      dispatch({ type: "FAIL", message: "The capture session was lost. Please start again." });
      return;
    }
    dispatch({ type: "FINALIZE" });
    try {
      // Belt-and-braces: ensure every upload has settled before the manifest.
      await Promise.allSettled(pendingRef.current);
      const sealed = await finalizeContinuousCapture(
        active.session,
        active.evidenceId,
        result,
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
  }, [toast]);

  const reset = useCallback(() => {
    sessionRef.current = null;
    declaredRef.current = [];
    pendingRef.current = [];
    resultRef.current = null;
    dispatch({ type: "RESET" });
  }, []);

  if (personalSpace.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!personalSpace.allowed) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Not available here</Text>
        <Text style={styles.body}>Continuous Screen Capture is available in your Personal Space on this device.</Text>
        <Button label="Back" variant="secondary" onPress={() => router.back()} />
      </View>
    );
  }
  if (!supported) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Android only</Text>
        <Text style={styles.body}>Continuous Screen Capture uses Android's screen-capture system and is not available on this device.</Text>
        <Button label="Back" variant="secondary" onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Continuous Screen Capture</Text>

      {state.phase === "intro" && (
        <>
          <Text style={styles.body}>
            PROOVRA will record what is shown on your screen as a continuous session, using Android's own
            screen-capture permission. Before it starts:
          </Text>
          <Text style={styles.bullet}>• Android will ask you to allow screen capture.</Text>
          <Text style={styles.bullet}>• Recording continues until you stop it — anything visible can become evidence, including sensitive information.</Text>
          <Text style={styles.bullet}>• The session is split into short segments that upload as they are recorded.</Text>
          <Text style={styles.bullet}>• Protected content may be unavailable because of Android restrictions.</Text>
          <Text style={styles.bullet}>• You control it: stop the recording at any time from the capture notification.</Text>
          <Text style={styles.caveat}>
            A screen recording captures what your device displayed. It does not establish that the content is true,
            who authored it, that an app or account shown is genuine, or that the session is free of gaps.
          </Text>
          <Button label={busy ? "Starting…" : "Start Continuous Capture"} onPress={busy ? undefined : start} />
          <Button label="Cancel" variant="secondary" onPress={() => router.back()} />
        </>
      )}

      {state.phase === "active" && (
        <>
          <Text style={styles.active}>Continuous Screen Capture Active</Text>
          <Text style={styles.body}>
            {state.captured} segment(s) recorded · {state.uploaded} uploaded.
          </Text>
          <Text style={styles.caveat}>
            Leave PROOVRA and open what you want to record. Segments upload in the background. Tap Stop from the
            notification, or here, when you are done.
          </Text>
          <Button label={busy ? "Stopping…" : "Stop & Review"} onPress={busy ? undefined : stop} />
        </>
      )}

      {state.phase === "review" && (
        <>
          <Text style={styles.body}>
            {state.captured} segment(s) recorded, {state.uploaded} uploaded and ready to seal.
          </Text>
          <Text style={styles.body}>
            Session status:{" "}
            {state.completeness === "COMPLETE_SESSION"
              ? "Complete — no known interruption."
              : "Interrupted — the recording ended before a clean stop."}
          </Text>
          <Text style={styles.caveat}>
            Finalize to seal these segments into one evidence record. PROOVRA verifies every segment's integrity on
            the server and records whether the session was complete or interrupted. It does not claim continuity
            across any known gap.
          </Text>
          <Button label="Finalize Evidence" onPress={finalize} />
          <Button label="Discard" variant="secondary" onPress={reset} />
        </>
      )}

      {state.phase === "finalizing" && (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.body}>Finalizing evidence — sealing {state.captured} segment(s) and verifying integrity…</Text>
        </View>
      )}

      {state.phase === "success" && (
        <>
          <Text style={styles.success}>
            Evidence saved ({state.segmentCount} segment(s),{" "}
            {state.completeness === "COMPLETE_SESSION" ? "complete session" : "interrupted session"}).
          </Text>
          <Button label="View Evidence" onPress={() => router.replace(`/evidence/${state.evidenceId}`)} />
          <Button label="Capture Another" variant="secondary" onPress={reset} />
          <Button label="Done" variant="secondary" onPress={() => router.back()} />
        </>
      )}

      {state.phase === "error" && (
        <>
          <Text style={styles.error}>{state.message}</Text>
          {state.recoverable && <Button label="Try Again" onPress={reset} />}
          <Button label="Back to Capture" variant="secondary" onPress={() => router.back()} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.md },
  center: { flex: 1, padding: spacing.lg, gap: spacing.md, alignItems: "center", justifyContent: "center" },
  title: { fontSize: typography.size.h2, color: colors.textDark, fontWeight: "700" },
  active: { fontSize: typography.size.h3, color: colors.greenValid, fontWeight: "700" },
  body: { fontSize: typography.size.body, color: colors.textDark },
  bullet: { fontSize: typography.size.body, color: colors.textDark },
  caveat: { fontSize: typography.size.label, color: colors.muted },
  success: { fontSize: typography.size.body, color: colors.greenValid },
  error: { fontSize: typography.size.body, color: colors.red },
});
