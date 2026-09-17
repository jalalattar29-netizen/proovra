/**
 * UC-2 — Android Direct Screen Capture screen.
 *
 * User-initiated only. It explains what Android will ask and what PROOVRA can and
 * cannot establish BEFORE capture, runs the bounded native capture (Android's own
 * consent dialog + a visible foreground-service notification), then seals the
 * frames into ONE Evidence record through the canonical direct-capture pipeline.
 * Android-only; respects the Personal-Space capture gate.
 */
import { useCallback, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { colors, spacing, typography } from "@proovra/ui";

import { Button } from "../../components/ui";
import { useToast } from "../../src/toast-context";
import { usePersonalSpaceAllowed } from "../../src/usePersonalSpaceAllowed";
import { captureScreenToEvidence } from "../../src/screen-capture";
import { isScreenCaptureSupported } from "../../modules/proovra-screen-capture";

type Phase = "intro" | "capturing" | "done" | "error";

export default function ScreenCaptureScreen() {
  const router = useRouter();
  const toast = useToast();
  const personalSpace = usePersonalSpaceAllowed();
  const [phase, setPhase] = useState<Phase>("intro");
  const [message, setMessage] = useState<string>("");
  const supported = Platform.OS === "android" && isScreenCaptureSupported();

  const start = useCallback(async () => {
    setPhase("capturing");
    setMessage("Android will ask for permission. When capture is active, use the notification's Stop action to end it.");
    try {
      const result = await captureScreenToEvidence({ maxFrames: 8, intervalMs: 750 });
      setPhase("done");
      setMessage(`Preserved ${result.frameCount} screen frame(s) into your PROOVRA workspace.`);
      toast.addToast("Screen capture preserved.", "success");
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "Screen capture could not be completed.");
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
        <Text style={styles.body}>
          Direct Screen Capture is available in your Personal Space on this device.
        </Text>
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

      {phase === "intro" && (
        <>
          <Text style={styles.body}>
            PROOVRA will capture what is shown on your screen, using Android's own screen-capture
            permission. Before it starts:
          </Text>
          <Text style={styles.bullet}>• Android will ask you to allow screen capture.</Text>
          <Text style={styles.bullet}>• Anything visible on screen during the capture can become evidence — including sensitive information.</Text>
          <Text style={styles.bullet}>• You control it: stop any time from the capture notification.</Text>
          <Text style={styles.caveat}>
            A screen capture records what your device displayed. It does not establish that the
            content is true, who authored it, or that an app or account shown is genuine.
          </Text>
          <Button label="Start screen capture" onPress={start} />
          <Button label="Cancel" variant="secondary" onPress={() => router.back()} />
        </>
      )}

      {phase === "capturing" && (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.body}>{message}</Text>
        </View>
      )}

      {(phase === "done" || phase === "error") && (
        <>
          <Text style={phase === "done" ? styles.success : styles.error}>{message}</Text>
          <Button label="Done" onPress={() => router.back()} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.md },
  center: { flex: 1, padding: spacing.lg, gap: spacing.md, alignItems: "center", justifyContent: "center" },
  title: { fontSize: typography.size.h2, color: colors.textDark, fontWeight: "700" },
  body: { fontSize: typography.size.body, color: colors.textDark },
  bullet: { fontSize: typography.size.body, color: colors.textDark },
  caveat: { fontSize: typography.size.label, color: colors.muted },
  success: { fontSize: typography.size.body, color: colors.greenValid },
  error: { fontSize: typography.size.body, color: colors.red },
});
