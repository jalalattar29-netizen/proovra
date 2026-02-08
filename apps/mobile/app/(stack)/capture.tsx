import { Pressable, ScrollView, StyleSheet, Text, View, Switch } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { Badge, ListRow, Tabs } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../src/api";
import { enqueueUpload, processQueue } from "../../src/upload-queue";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";

export default function CaptureScreen() {
  const { t, fontFamilyBold } = useLocale();
  const [activeIndex, setActiveIndex] = useState(0);
  const typeMap = ["PHOTO", "VIDEO", "DOCUMENT"] as const;
  const activeType = typeMap[activeIndex];
  const [asset, setAsset] = useState<{ uri: string; mimeType: string; durationMs?: number } | null>(
    null
  );
  const [segments, setSegments] = useState<
    Array<{ uri: string; mimeType: string; durationMs?: number }>
  >([]);
  const [extendedMode, setExtendedMode] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useLocation, setUseLocation] = useState(false);
  const [recent, setRecent] = useState<
    Array<{ id: string; type: string; status: string; createdAt: string }>
  >([]);
  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const pollReport = async (evidenceId: string) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await apiFetch(`/v1/evidence/${evidenceId}/report/latest`, { method: "GET" });
        return;
      } catch {
        await sleep(2000);
      }
    }
  };
  const router = useRouter();

  const handlePick = async () => {
    setError(null);
    try {
      if (activeType === "DOCUMENT") {
        const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
        if (!result.canceled && result.assets?.[0]) {
          const file = result.assets[0];
          setAsset({
            uri: file.uri,
            mimeType: file.mimeType ?? "application/octet-stream"
          });
        }
        return;
      }
      const cam = cameraPermission?.granted ?? false;
      const mic = micPermission?.granted ?? false;
      if (!cam) {
        const res = await requestCameraPermission();
        if (!res.granted) {
          setError("Camera permission denied");
          return;
        }
      }
      if (activeType === "VIDEO" && !mic) {
        const res = await requestMicPermission();
        if (!res.granted) {
          setError("Microphone permission denied");
          return;
        }
      }
      setCameraOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open camera");
    }
  };

  const handleTakePhoto = async () => {
    if (!cameraRef.current) return;
    setError(null);
    try {
      const result = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (result?.uri) {
        setAsset({
          uri: result.uri,
          mimeType: "image/jpeg"
        });
        setCameraOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to capture photo");
    }
  };

  const handleStartRecording = async () => {
    if (!cameraRef.current) return;
    setError(null);
    setIsRecording(true);
    try {
      const startedAt = Date.now();
      const result = await cameraRef.current.recordAsync({
        maxDuration: 1800
      });
      const durationMs = Math.max(0, Date.now() - startedAt);
      if (result?.uri) {
        const next = {
          uri: result.uri,
          mimeType: "video/mp4",
          durationMs
        };
        if (extendedMode) {
          setSegments((prev) => [...prev, next]);
        } else {
          setAsset(next);
        }
        setCameraOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record video");
    } finally {
      setIsRecording(false);
    }
  };

  const handleStopRecording = () => {
    cameraRef.current?.stopRecording();
  };

  const handleCapture = async () => {
    if (activeType === "VIDEO" && extendedMode) {
      if (segments.length === 0) {
        setError("Record at least one segment.");
        return;
      }
    } else if (!asset) {
      setError("Please capture or select a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let gps: { lat: number; lng: number; accuracyMeters?: number } | undefined;
      const deviceTimeIso = new Date().toISOString();
      if (useLocation) {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!permission.granted) {
          setError("Location permission denied");
          setBusy(false);
          return;
        }
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced
        });
        gps = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy ?? undefined
        };
      }
      if (activeType === "VIDEO" && extendedMode) {
        const created = await apiFetch("/v1/evidence", {
          method: "POST",
          body: JSON.stringify({ type: activeType, mimeType: "video/mp4", deviceTimeIso, gps })
        });
        for (let i = 0; i < segments.length; i += 1) {
          const seg = segments[i];
          const part = await apiFetch(`/v1/evidence/${created.id}/parts`, {
            method: "POST",
            body: JSON.stringify({
              partIndex: i,
              mimeType: seg.mimeType,
              durationMs: seg.durationMs
            })
          });
          await FileSystem.uploadAsync(part.upload.putUrl, seg.uri, {
            httpMethod: "PUT",
            headers: { "content-type": seg.mimeType },
            uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT
          });
        }
        await apiFetch(`/v1/evidence/${created.id}/complete`, {
          method: "POST",
          body: "{}"
        });
        await pollReport(created.id);
        router.push(`/evidence/${created.id}`);
      } else {
        enqueueUpload({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: activeType,
          uri: asset!.uri,
          mimeType: asset!.mimeType,
          deviceTimeIso,
          gpsLat: gps?.lat ?? null,
          gpsLng: gps?.lng ?? null,
          gpsAccuracyMeters: gps?.accuracyMeters ?? null
        });
        await processQueue();
        router.push("/(tabs)");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const totalDuration = useMemo(() => {
    if (segments.length === 0) return 0;
    return segments.reduce((sum, seg) => sum + (seg.durationMs ?? 0), 0);
  }, [segments]);

  useEffect(() => {
    if (!isRecording) {
      setRecordSeconds(0);
      return;
    }
    const id = setInterval(() => {
      setRecordSeconds((value) => value + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  useEffect(() => {
    apiFetch("/v1/evidence")
      .then((data) => setRecent(data.items ?? []))
      .catch(() => setRecent([]));
  }, []);
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerIcon}>‹</Text>
        <Text style={[styles.headerTitle, { fontFamily: fontFamilyBold }]}>{t("capture")}</Text>
        <Text style={styles.headerIcon}>⋮</Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Tabs
          items={[t("photo"), t("video"), t("document")]}
          activeIndex={activeIndex}
          onSelect={(index) => {
            setActiveIndex(index);
            setAsset(null);
            setSegments([]);
            setExtendedMode(false);
          }}
        />
        {activeType === "VIDEO" ? (
          <Pressable
            style={[styles.captureBar, { backgroundColor: extendedMode ? colors.teal : colors.primaryNavy }]}
            onPress={() => setExtendedMode((prev) => !prev)}
          >
            <Text style={styles.uploadText}>
              {extendedMode ? "Extended mode ON (30 min segments)" : "Extended mode OFF"}
            </Text>
          </Pressable>
        ) : null}
        {cameraOpen ? (
          <View style={styles.cameraCard}>
            <CameraView ref={cameraRef} style={styles.cameraPreview} />
            <View style={styles.cameraControls}>
              {activeType === "VIDEO" ? (
                <>
                  <Text style={styles.timerText}>
                    {isRecording ? `Recording ${recordSeconds}s` : "Ready to record"}
                  </Text>
                  <Pressable
                    style={[styles.captureBar, { backgroundColor: isRecording ? "#ef4444" : colors.primaryNavy }]}
                    onPress={isRecording ? handleStopRecording : handleStartRecording}
                  >
                    <Text style={styles.uploadText}>{isRecording ? "Stop recording" : "Start recording"}</Text>
                  </Pressable>
                </>
              ) : (
                <Pressable style={styles.captureBar} onPress={handleTakePhoto}>
                  <Text style={styles.uploadText}>Capture photo</Text>
                </Pressable>
              )}
              <Pressable style={[styles.captureBar, styles.secondaryBar]} onPress={() => setCameraOpen(false)}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : (
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Include location metadata</Text>
          <Switch value={useLocation} onValueChange={setUseLocation} />
        </View>
        <View style={styles.preview}>
          <Text style={styles.previewText}>
            {activeType === "VIDEO" && extendedMode
              ? `Segments: ${segments.length} | Total ${(totalDuration / 1000 / 60).toFixed(1)} min`
              : asset
              ? "File selected"
              : "No file selected"}
          </Text>
        </View>
        <View style={styles.listCard}>
          {recent.length === 0 ? (
            <Text style={styles.previewText}>No evidence yet.</Text>
          ) : (
            recent.map((item) => (
              <ListRow
                key={item.id}
                title={item.type}
                subtitle={new Date(item.createdAt).toLocaleString()}
                badge={
                  item.status === "SIGNED" ? (
                    <Badge tone="signed" label={t("statusSigned")} />
                  ) : item.status === "PROCESSING" ? (
                    <Badge tone="processing" label={t("statusProcessing")} />
                  ) : (
                    <Badge tone="ready" label={t("statusReady")} />
                  )
                }
              />
            ))
          )}
        </View>
        <Pressable style={styles.captureBar} onPress={handlePick}>
          <View style={styles.captureCircle} />
        </Pressable>
        <Pressable
          style={[styles.captureBar, { backgroundColor: colors.teal }]}
          onPress={handleCapture}
          disabled={busy}
        >
          <Text style={styles.uploadText}>{busy ? "Uploading..." : "Upload & Sign"}</Text>
        </Pressable>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.lightBg
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    gap: spacing.md
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg
  },
  headerTitle: {
    fontSize: typography.size.h3,
    color: colors.textDark
  },
  headerIcon: {
    fontSize: 18,
    color: "#94A3B8"
  },
  preview: {
    height: 180,
    borderRadius: 18,
    backgroundColor: "#E2E8F0"
  },
  cameraCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border
  },
  cameraPreview: {
    height: 360,
    width: "100%"
  },
  cameraControls: {
    padding: spacing.md,
    gap: spacing.sm
  },
  timerText: {
    color: "#64748b",
    fontSize: 12,
    textAlign: "center"
  },
  secondaryBar: {
    backgroundColor: "#EEF2F7"
  },
  secondaryText: {
    color: colors.primaryNavy,
    fontWeight: "600"
  },
  previewText: {
    color: "#64748b",
    padding: spacing.md
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.white,
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  toggleLabel: {
    color: colors.textDark,
    fontSize: 14
  },
  listCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border
  },
  captureBar: {
    marginTop: spacing.md,
    borderRadius: 18,
    backgroundColor: colors.primaryNavy,
    paddingVertical: spacing.md,
    alignItems: "center"
  },
  captureCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.white
  },
  uploadText: {
    color: colors.white,
    fontWeight: "600"
  },
  errorText: {
    color: "#ef4444",
    paddingHorizontal: spacing.xl
  }
});
