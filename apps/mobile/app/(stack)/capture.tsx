import { Linking, Pressable, ScrollView, StyleSheet, Text, View, Switch } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { Badge, ListRow, Tabs } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { useToast } from "../../src/toast-context";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../src/api";
import { enqueueUpload, processQueue } from "../../src/upload-queue";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { ensureFileUri, uploadWithPut } from "../../src/upload-utils";

export default function CaptureScreen() {
  const { t, fontFamilyBold } = useLocale();
  const { addToast } = useToast();
  const [activeIndex, setActiveIndex] = useState(0);
  const typeMap = ["PHOTO", "VIDEO", "DOCUMENT"] as const;
  const activeType = typeMap[activeIndex];
  const [asset, setAsset] = useState<{
    uri: string;
    mimeType: string;
    durationMs?: number;
    sizeBytes?: number;
    originalFilename?: string;
  } | null>(null);
  const [segments, setSegments] = useState<
    Array<{ uri: string; mimeType: string; durationMs?: number; sizeBytes?: number; originalFilename?: string }>
  >([]);
  const [extendedMode, setExtendedMode] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showSettingsLink, setShowSettingsLink] = useState(false);
  const [useLocation, setUseLocation] = useState(false);
  const [recent, setRecent] = useState<
    Array<{ id: string; type: string; status: string; createdAt: string }>
  >([]);
  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const pollReport = async (evidenceId: string) => {
    const delays = [2000, 3000, 5000, 8000, 12000, 15000, 15000, 15000];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      try {
        await apiFetch(`/v1/evidence/${evidenceId}/report/latest`, { method: "GET" });
        setInfo(null);
        return;
      } catch {
        setInfo("Report still generating...");
        await sleep(delays[attempt]);
      }
    }
    setInfo("Report is still generating. Try again in a moment.");
  };
  const router = useRouter();

  const getFilename = (uri: string, fallback: string) => {
    const name = uri.split("/").pop();
    return name && name.length > 0 ? name : fallback;
  };

  const handlePick = async () => {
    setError(null);
    setInfo(null);
    setShowSettingsLink(false);
    try {
      addToast("Opening file picker...", "info");
      if (activeType === "DOCUMENT") {
        const result = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          type: "*/*"
        });
        if (!result.canceled && result.assets?.[0]) {
          const file = result.assets[0];
          const info = await FileSystem.getInfoAsync(file.uri);
          setAsset({
            uri: file.uri,
            mimeType: file.mimeType ?? "application/octet-stream",
            sizeBytes: file.size ?? (info.exists ? info.size : undefined),
            originalFilename: file.name ?? getFilename(file.uri, `document-${Date.now()}`)
          });
          addToast(`Document selected: ${file.name}`, "success");
        }
        return;
      }
      const cam = cameraPermission?.granted ?? false;
      const mic = micPermission?.granted ?? false;
      if (!cam) {
        const res = await requestCameraPermission();
        if (!res.granted) {
          setError("Camera permission denied");
          addToast("Camera permission denied", "error");
          setShowSettingsLink(true);
          return;
        }
      }
      if (activeType === "VIDEO" && !mic) {
        const res = await requestMicPermission();
        if (!res.granted) {
          setError("Microphone permission denied");
          addToast("Microphone permission denied", "error");
          setShowSettingsLink(true);
          return;
        }
      }
      addToast(`Opening ${activeType.toLowerCase()} camera...`, "info");
      setCameraOpen(true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to open camera";
      setError(errorMsg);
      addToast(errorMsg, "error");
    }
  };

  const handleTakePhoto = async () => {
    if (!cameraRef.current) return;
    setError(null);
    setInfo(null);
    addToast("Capturing photo...", "info");
    try {
      const result = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (result?.uri) {
        const info = await FileSystem.getInfoAsync(result.uri);
        setAsset({
          uri: result.uri,
          mimeType: "image/jpeg",
          sizeBytes: info.exists ? info.size : undefined,
          originalFilename: getFilename(result.uri, `photo-${Date.now()}.jpg`)
        });
        addToast("Photo captured successfully", "success");
        setCameraOpen(false);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to capture photo";
      setError(errorMsg);
      addToast(errorMsg, "error");
    }
  };

  const handleStartRecording = async () => {
    if (!cameraRef.current) return;
    setError(null);
    setInfo(null);
    setIsRecording(true);
    addToast("Recording started...", "info");
    try {
      const startedAt = Date.now();
      const result = await cameraRef.current.recordAsync();
      const r = result as { uri?: string; duration?: number };
      const durationMs =
        typeof r?.duration === "number"
          ? Math.max(0, Math.round(r.duration * 1000))
          : Math.max(0, Date.now() - startedAt);
      if (result?.uri) {
        const info = await FileSystem.getInfoAsync(result.uri);
        const next = {
          uri: result.uri,
          mimeType: "video/mp4",
          durationMs,
          sizeBytes: info.exists ? info.size : undefined,
          originalFilename: getFilename(result.uri, `video-${Date.now()}.mp4`)
        };
        if (extendedMode) {
          setSegments((prev) => [...prev, next]);
          addToast("Segment recorded successfully", "success");
        } else {
          setAsset(next);
          addToast("Video recorded successfully", "success");
        }
        setCameraOpen(false);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to record video";
      setError(errorMsg);
      addToast(errorMsg, "error");
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
        addToast("Record at least one segment", "error");
        return;
      }
    } else if (!asset) {
      setError("Please capture or select a file first.");
      addToast("Please capture or select a file first", "error");
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    addToast("Creating evidence record...", "info");
    try {
      let gps: { lat: number; lng: number; accuracyMeters?: number } | undefined;
      const deviceTimeIso = new Date().toISOString();
      if (useLocation) {
        addToast("Requesting location...", "info");
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!permission.granted) {
          setError("Location permission denied");
          addToast("Location permission denied", "error");
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
        addToast("Location captured", "success");
      }
      if (activeType === "VIDEO" && extendedMode) {
        const baseFilename = `video-${Date.now()}.mp4`;
        const created = await apiFetch("/v1/evidence", {
          method: "POST",
          body: JSON.stringify({
            type: activeType,
            mimeType: "video/mp4",
            originalFilename: baseFilename,
            deviceTimeIso,
            gps
          })
        });
        const segmentSizes: number[] = [];
        for (let i = 0; i < segments.length; i += 1) {
          addToast(`Uploading segment ${i + 1}/${segments.length}...`, "info");
          const seg = segments[i];
          const segUri = await ensureFileUri(seg.uri);
          if (!seg.sizeBytes) {
            const info = await FileSystem.getInfoAsync(segUri);
            segmentSizes.push(info.exists ? info.size ?? 0 : 0);
          } else {
            segmentSizes.push(seg.sizeBytes ?? 0);
          }
          const part = await apiFetch(`/v1/evidence/${created.id}/parts`, {
            method: "POST",
            body: JSON.stringify({
              partIndex: i,
              mimeType: seg.mimeType,
              durationMs: seg.durationMs
            })
          });
          await uploadWithPut({
            putUrl: part.upload.putUrl,
            uri: segUri,
            mimeType: seg.mimeType
          });
        }
        addToast("Finalizing evidence...", "info");
        await apiFetch(`/v1/evidence/${created.id}/complete`, {
          method: "POST",
          body: JSON.stringify({
            sizeBytes: segmentSizes.reduce((sum, value) => sum + value, 0),
            durationMs: segments.reduce((sum, seg) => sum + (seg.durationMs ?? 0), 0),
            originalFilename: baseFilename
          })
        });
        await pollReport(created.id);
        addToast("Evidence captured successfully!", "success", 2000);
        router.push(`/evidence/${created.id}`);
      } else {
        addToast("Uploading file...", "info");
        enqueueUpload({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: activeType,
          uri: asset!.uri,
          mimeType: asset!.mimeType,
          originalFilename: asset!.originalFilename,
          sizeBytes: asset!.sizeBytes,
          durationMs: asset!.durationMs,
          deviceTimeIso,
          gpsLat: gps?.lat ?? null,
          gpsLng: gps?.lng ?? null,
          gpsAccuracyMeters: gps?.accuracyMeters ?? null
        });
        await processQueue();
        addToast("Evidence captured successfully!", "success", 2000);
        router.push("/(tabs)");
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Upload failed";
      setError(errorMsg);
      addToast(errorMsg, "error");
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
              {extendedMode ? "Segmented mode ON (stop to add a segment)" : "Segmented mode OFF"}
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
                  {isRecording && recordSeconds >= 1800 ? (
                    <Text style={styles.warningText}>
                      Recording for long durations may consume battery & storage.
                    </Text>
                  ) : null}
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
        <>
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
        {showSettingsLink ? (
          <Pressable style={[styles.captureBar, styles.secondaryBar]} onPress={() => Linking.openSettings()}>
            <Text style={styles.secondaryText}>Open Settings</Text>
          </Pressable>
        ) : null}
        {info ? <Text style={styles.infoText}>{info}</Text> : null}
        </>
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
  warningText: {
    color: "#f59e0b",
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
  },
  infoText: {
    color: "#0f172a",
    paddingHorizontal: spacing.xl
  }
});
