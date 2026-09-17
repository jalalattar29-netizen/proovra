/**
 * UC-2 — Android Direct Screen Capture screen.
 *
 * User-initiated only. It explains what Android will ask and what PROOVRA can and
 * cannot establish BEFORE capture, starts the bounded native session (Android's
 * own consent dialog + a foreground-service notification with Capture Frame /
 * Stop actions), lets the user leave PROOVRA to show the target content and
 * trigger frames from the notification (or the in-app button), then — on Stop —
 * reviews and seals the frames into ONE Evidence record through the canonical
 * pipeline. Android-only; respects the Personal-Space capture gate. Reconnects to
 * an in-flight session on return so a new CaptureSession is never created.
 */
import { useCallback, useEffect, useReducer, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { colors, spacing, typography } from "@proovra/ui";

import { Button } from "../../components/ui";
import { useToast } from "../../src/toast-context";
import { usePersonalSpaceAllowed } from "../../src/usePersonalSpaceAllowed";
import { finalizeScreenCapture } from "../../src/screen-capture";
import {
  INITIAL_SCREEN_FLOW,
  screenFlowReducer,
} from "../../src/screen-capture-flow";
import {
  addScreenFrameListener,
  addScreenStoppedListener,
  captureScreenFrame,
  getScreenCaptureState,
  isScreenCaptureSupported,
  startScreenCapture,
  stopScreenCapture,
  type ScreenCaptureResult,
} from "../../modules/proovra-screen-capture";

export default function ScreenCaptureScreen() {
  const router = useRouter();
  const toast = useToast();
  const personalSpace = usePersonalSpaceAllowed();
  const [state, dispatch] = useReducer(screenFlowReducer, INITIAL_SCREEN_FLOW);
  const [busy, setBusy] = useState(false);
  const supported = Platform.OS === "android" && isScreenCaptureSupported();

  // Live frame count + stop events, and reconnect to an in-flight session when
  // the user returns to PROOVRA after capturing from the notification.
  useEffect(() => {
    const frameSub = addScreenFrameListener((e) => dispatch({ type: "FRAME", frameCount: e.frameCount }));
    const stopSub = addScreenStoppedListener((e: ScreenCaptureResult) =>
      dispatch({ type: "STOPPED", frameCount: e.frames.length, stopReason: e.stopReason }),
    );
    return () => {
      frameSub.remove();
      stopSub.remove();
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const s = getScreenCaptureState();
      if (s.active) {
        // Reconnect the UI to the SAME active native session (never start a new one).
        dispatch({ type: "STARTED" });
        if (s.frameCount > 0) dispatch({ type: "FRAME", frameCount: s.frameCount });
      }
    }, []),
  );

  const start = useCallback(async () => {
    setBusy(true);
    try {
      await startScreenCapture({ maxFrames: 20 });
      dispatch({ type: "STARTED" });
    } catch (err) {
      dispatch({
        type: "FAIL",
        message: err instanceof Error ? err.message : "Screen capture consent was not granted.",
        recoverable: true,
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const captureFrame = useCallback(async () => {
    setBusy(true);
    try {
      await captureScreenFrame();
    } catch (err) {
      toast.addToast(err instanceof Error ? err.message : "Could not capture a frame.", "error");
    } finally {
      setBusy(false);
    }
  }, [toast]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      const result = await stopScreenCapture();
      dispatch({ type: "STOPPED", frameCount: result.frames.length, stopReason: result.stopReason });
    } catch (err) {
      dispatch({ type: "FAIL", message: err instanceof Error ? err.message : "Could not stop capture." });
    } finally {
      setBusy(false);
    }
  }, []);

  const finalize = useCallback(async () => {
    dispatch({ type: "FINALIZE" });
    try {
      const result = await stopScreenCapture(); // idempotent; returns the final set
      const sealed = await finalizeScreenCapture(result);
      dispatch({ type: "FINALIZED", evidenceId: sealed.evidenceId });
      toast.addToast("Evidence saved.", "success");
    } catch (err) {
      dispatch({ type: "FAIL", message: err instanceof Error ? err.message : "Could not finalize the evidence." });
    }
  }, [toast]);

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
        <Text style={styles.body}>Direct Screen Capture is available in your Personal Space on this device.</Text>
        <Button label="Back" variant="secondary" onPress={() => router.back()} />
      </View>
    );
  }
  if (!supported) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Android only</Text>
        <Text style={styles.body}>Direct Screen Capture uses Android's screen-capture system and is not available on this device.</Text>
        <Button label="Back" variant="secondary" onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Direct Screen Capture</Text>

      {state.phase === "intro" && (
        <>
          <Text style={styles.body}>
            PROOVRA will capture what is shown on your screen, using Android's own screen-capture permission.
            Before it starts:
          </Text>
          <Text style={styles.bullet}>• Android will ask you to allow screen capture.</Text>
          <Text style={styles.bullet}>• Anything visible on screen can become evidence — including sensitive information.</Text>
          <Text style={styles.bullet}>• Protected content may be unavailable because of Android restrictions.</Text>
          <Text style={styles.bullet}>• You control it: capture each frame and stop from the capture notification.</Text>
          <Text style={styles.caveat}>
            A screen capture records what your device displayed. It does not establish that the content is true,
            who authored it, or that an app or account shown is genuine.
          </Text>
          <Button label={busy ? "Starting…" : "Start Screen Capture"} onPress={busy ? undefined : start} />
          <Button label="Cancel" variant="secondary" onPress={() => router.back()} />
        </>
      )}

      {state.phase === "active" && (
        <>
          <Text style={styles.active}>Screen Capture Active</Text>
          <Text style={styles.body}>Captured {state.frameCount} frame(s).</Text>
          <Text style={styles.caveat}>
            Leave PROOVRA and open the app you want to capture, then tap Capture Frame from the notification.
            You can also capture PROOVRA's own screen here.
          </Text>
          <Button label={busy ? "Capturing…" : "Capture Frame"} onPress={busy ? undefined : captureFrame} />
          <Button label="Stop & Review" variant="secondary" onPress={busy ? undefined : stop} />
        </>
      )}

      {state.phase === "review" && (
        <>
          <Text style={styles.body}>{state.frameCount} frame(s) captured and ready to save.</Text>
          <Text style={styles.caveat}>
            The frames are on this device. Finalize to upload them; PROOVRA verifies each frame's integrity on
            the server before the record is sealed.
          </Text>
          <Button label="Finalize Evidence" onPress={finalize} />
          <Button label="Discard" variant="secondary" onPress={() => dispatch({ type: "RESET" })} />
        </>
      )}

      {state.phase === "uploading" && (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.body}>Finalizing evidence — uploading {state.frameCount} frame(s) and verifying integrity…</Text>
        </View>
      )}

      {state.phase === "success" && (
        <>
          <Text style={styles.success}>Evidence saved ({state.frameCount} frame(s)).</Text>
          <Button label="View Evidence" onPress={() => router.replace(`/evidence/${state.evidenceId}`)} />
          <Button label="Capture Another" variant="secondary" onPress={() => dispatch({ type: "RESET" })} />
          <Button label="Done" variant="secondary" onPress={() => router.back()} />
        </>
      )}

      {state.phase === "error" && (
        <>
          <Text style={styles.error}>{state.message}</Text>
          {state.recoverable && <Button label="Try Again" onPress={() => dispatch({ type: "RESET" })} />}
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
