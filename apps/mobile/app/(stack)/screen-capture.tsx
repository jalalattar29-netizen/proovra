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
 *
 * Phase 10: presentation converged onto the canonical kit. The native module,
 * flow reducer, listeners, reconnect and sealing pipeline are UNCHANGED.
 */
import { useCallback, useEffect, useReducer, useState } from "react";
import { Platform, View, StyleSheet } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";

import { useToast } from "../../src/toast-context";
import { usePersonalSpaceAllowed } from "../../src/usePersonalSpaceAllowed";
import { stageScreenCapture } from "../../src/screen-capture";
import { saveCaptureSession } from "../../src/capture/capture-session-store";
import { toScreenDraftItem } from "../../src/capture/screen-acquisition";
import { openCaptureDraft } from "../../src/capture/capture-draft";
import { setCaptureActive } from "../../src/capture/active-capture";
import { INITIAL_SCREEN_FLOW, screenFlowReducer } from "../../src/screen-capture-flow";
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

export default function ScreenCaptureScreen() {
  const router = useRouter();
  const toast = useToast();
  const personalSpace = usePersonalSpaceAllowed();
  const [state, dispatch] = useReducer(screenFlowReducer, INITIAL_SCREEN_FLOW);
  const [busy, setBusy] = useState(false);
  const supported = Platform.OS === "android" && isScreenCaptureSupported();

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
        dispatch({ type: "STARTED" });
        if (s.frameCount > 0) dispatch({ type: "FRAME", frameCount: s.frameCount });
      }
    }, []),
  );

  useEffect(() => {
    const inFlight = state.phase === "active" || state.phase === "review" || state.phase === "uploading";
    setCaptureActive(inFlight);
    return () => setCaptureActive(false);
  }, [state.phase]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      await startScreenCapture({ maxFrames: 20 });
      dispatch({ type: "STARTED" });
    } catch (err) {
      dispatch({ type: "FAIL", message: toSafeUserError(err, { message: "Screen capture consent was not granted." }).message, recoverable: true });
    } finally {
      setBusy(false);
    }
  }, []);

  const captureFrame = useCallback(async () => {
    setBusy(true);
    try {
      await captureScreenFrame();
    } catch (err) {
      toast.addToast(toSafeUserError(err, { message: "Could not capture a frame." }).message, "error");
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
      dispatch({ type: "FAIL", message: toSafeUserError(err, { message: "Could not stop capture." }).message });
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Hand the recording to the canonical Capture lifecycle.
   *
   * This screen used to seal here and produce Evidence, which is what made the
   * product have two endings. It now STAGES: the frames and manifest upload,
   * a canonical draft records what is in the session, and the operator
   * reviews and finishes it in Capture like everything else they capture.
   *
   * Nothing is signed by this button. A discard in Capture releases the
   * reservation and commits nothing.
   */
  const stageForReview = useCallback(async () => {
    dispatch({ type: "FINALIZE" });
    try {
      const result = await stopScreenCapture();
      const staged = await stageScreenCapture(result);

      // The canonical draft — the product's record of what this session holds.
      const item = toScreenDraftItem({
        mode: "DIRECT_SCREEN_CAPTURE_ANDROID",
        clientItemId: staged.session.captureSessionId,
        partCount: staged.frameCount,
        sizeBytes: staged.sizeBytes,
      });
      await openCaptureDraft({ items: [item] }).catch(() => undefined);

      // The durable record the canonical surface resumes. Its parts are
      // already uploaded, so finalize seals without re-uploading them.
      await saveCaptureSession({
        captureSessionId: staged.session.captureSessionId,
        expiresAtUtc: staged.session.expiresAtUtc,
        evidenceId: staged.evidenceId,
        type: "PHOTO",
        items: [
          {
            id: staged.session.captureSessionId,
            uri: "",
            mimeType: item.mimeType,
            partIndex: 0,
            originalFilename: item.fileName,
            source: "SCREEN_FRAME",
            sizeBytes: staged.sizeBytes,
            uploaded: true,
          },
        ],
        acquisition: {
          mode: "DIRECT_SCREEN_CAPTURE_ANDROID",
          manifestJson: staged.manifestJson,
        },
      });

      dispatch({ type: "FINALIZED", evidenceId: staged.evidenceId });
      toast.addToast("Screen capture staged — review and finish in Capture", "success");
      router.replace("/capture");
    } catch (err) {
      dispatch({ type: "FAIL", message: toSafeUserError(err, { message: "Could not stage the capture." }).message });
    }
  }, [toast]);

  if (personalSpace.loading) return <ProovraScreen scroll={false}><ProovraLoadingState /></ProovraScreen>;
  if (!personalSpace.allowed) {
    return (
      <ProovraScreen scroll={false}>
        <ProovraEmptyState title="Not available here" message="Direct Screen Capture is available in your Personal Space on this device." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} />
      </ProovraScreen>
    );
  }
  if (!supported) {
    return (
      <ProovraScreen scroll={false}>
        <ProovraEmptyState title="Android only" message="Direct Screen Capture uses Android's screen-capture system and is not available on this device." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} />
      </ProovraScreen>
    );
  }

  return (
    <ProovraScreen>
      <ProovraSection title="Direct Screen Capture">
        {state.phase === "intro" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" color={theme.color.ink.secondary}>
              PROOVRA will capture what is shown on your screen, using Android's own screen-capture permission. Before it starts:
            </ProovraText>
            <Bullet text="Android will ask you to allow screen capture." />
            <Bullet text="Anything visible on screen can become evidence — including sensitive information." />
            <Bullet text="Protected content may be unavailable because of Android restrictions." />
            <Bullet text="You control it: capture each frame and stop from the capture notification." />
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              A screen capture records what your device displayed. It does not establish that the content is true, who authored it, or that an app or account shown is genuine.
            </ProovraText>
            <ProovraButton label="Start Screen Capture" loading={busy} onPress={start} />
            <ProovraButton label="Cancel" variant="ghost" onPress={() => router.back()} />
          </ProovraCard>
        )}

        {state.phase === "active" && (
          <ProovraCard style={styles.card}>
            <ProovraBadge tone="pending" label="Screen capture active" />
            <ProovraText variant="body" weight="semibold">Captured {state.frameCount} frame(s).</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              Leave PROOVRA and open the app you want to capture, then tap Capture Frame from the notification. You can also capture PROOVRA's own screen here.
            </ProovraText>
            <ProovraButton label="Capture Frame" loading={busy} onPress={captureFrame} />
            <ProovraButton label="Stop &amp; Review" variant="secondary" onPress={stop} />
          </ProovraCard>
        )}

        {state.phase === "review" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" weight="semibold">{state.frameCount} frame(s) captured.</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              The frames are on this device. Adding them to your capture session uploads them and verifies each frame&apos;s integrity on the server. You review and finish the session in Capture, and nothing is signed until you do.
            </ProovraText>
            <ProovraButton label="Add to capture session" onPress={stageForReview} />
            <ProovraButton label="Discard" variant="ghost" onPress={() => dispatch({ type: "RESET" })} />
          </ProovraCard>
        )}

        {state.phase === "uploading" && (
          <ProovraLoadingState label={`Uploading ${state.frameCount} frame(s) and verifying integrity`} />
        )}

        {state.phase === "success" && (
          <ProovraCard style={styles.card}>
            <ProovraBadge tone="pending" label={`Staged (${state.frameCount} frame(s))`} />
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.caveat}>
              Review and finish this session in Capture. It is not evidence until you do.
            </ProovraText>
            <ProovraButton label="Go to Capture" onPress={() => router.replace("/capture")} />
            <ProovraButton label="Capture Another" variant="secondary" onPress={() => dispatch({ type: "RESET" })} />
          </ProovraCard>
        )}

        {state.phase === "error" && (
          <ProovraCard style={styles.card}>
            <ProovraText variant="body" color={theme.color.status.risk.fg}>{state.message}</ProovraText>
            {state.recoverable && <ProovraButton label="Try Again" onPress={() => dispatch({ type: "RESET" })} />}
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
