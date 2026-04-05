import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View
} from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { Badge, ListRow, Tabs } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { useToast } from "../../src/toast-context";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../src/api";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions
} from "expo-camera";
import { ensureFileUri, uploadWithPut } from "../../src/upload-utils";

type CaptureKind = "PHOTO" | "VIDEO" | "DOCUMENT";

type CapturedItem = {
  id: string;
  uri: string;
  mimeType: string;
  durationMs?: number;
  sizeBytes?: number;
  originalFilename?: string;
  partIndex: number;
  uploadProgress: number;
  uploading: boolean;
  uploaded: boolean;
  error?: string | null;
};

type RecentEvidenceItem = {
  id: string;
  type: string;
  status: string;
  createdAt: string;
};

export default function CaptureScreen() {
  const { t, fontFamilyBold } = useLocale();
  const { addToast } = useToast();
  const router = useRouter();

  const [activeIndex, setActiveIndex] = useState(0);
  const typeMap: CaptureKind[] = ["PHOTO", "VIDEO", "DOCUMENT"];
  const activeType = typeMap[activeIndex];

  const [cameraOpen, setCameraOpen] = useState(false);
  const [useLocation, setUseLocation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showSettingsLink, setShowSettingsLink] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [recent, setRecent] = useState<RecentEvidenceItem[]>([]);

  const [sessionEvidenceId, setSessionEvidenceId] = useState<string | null>(null);
  const [sessionItems, setSessionItems] = useState<CapturedItem[]>([]);
  const [sessionCreatingEvidence, setSessionCreatingEvidence] = useState(false);
  const [sessionCompletingEvidence, setSessionCompletingEvidence] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const cameraRef = useRef<CameraView | null>(null);
  const sessionEvidenceIdRef = useRef<string | null>(null);
  const sessionItemsRef = useRef<CapturedItem[]>([]);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const isSessionActive = Boolean(sessionEvidenceId) || sessionItems.length > 0;

  const setSessionState = useCallback((items: CapturedItem[]) => {
    sessionItemsRef.current = items;
    setSessionItems(items);
  }, []);

  const refreshRecent = useCallback(async () => {
    try {
      const data = await apiFetch("/v1/evidence?scope=active");
      setRecent(Array.isArray(data?.items) ? data.items : []);
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  useEffect(() => {
    sessionEvidenceIdRef.current = sessionEvidenceId;
  }, [sessionEvidenceId]);

  useEffect(() => {
    if (!isRecording) {
      setRecordSeconds(0);
      return;
    }

    const timer = setInterval(() => {
      setRecordSeconds((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [isRecording]);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const pollReport = useCallback(async (evidenceId: string) => {
    const delays = [2000, 3000, 5000, 8000, 12000, 15000, 15000];
    for (let i = 0; i < delays.length; i += 1) {
      try {
        await apiFetch(`/v1/evidence/${evidenceId}/report/latest`, { method: "GET" });
        setInfo(null);
        return;
      } catch {
        setInfo("Report still generating...");
        await sleep(delays[i]);
      }
    }
    setInfo("Report is still generating. Try again shortly.");
  }, []);

  const getFilename = useCallback((uri: string, fallback: string) => {
    const name = uri.split("/").pop();
    return name && name.length > 0 ? name : fallback;
  }, []);

  const getGps = useCallback(async () => {
    if (!useLocation) return undefined;

    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      addToast("Location permission denied. Continuing without GPS.", "warning");
      return undefined;
    }

    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced
      });

      return {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyMeters: pos.coords.accuracy ?? undefined
      };
    } catch {
      addToast("Could not get location. Continuing without GPS.", "warning");
      return undefined;
    }
  }, [useLocation, addToast]);

  const ensureSessionEvidence = useCallback(
    async (firstMimeType: string) => {
      if (sessionEvidenceIdRef.current) {
        return sessionEvidenceIdRef.current;
      }

      setSessionCreatingEvidence(true);
      setInfo("Creating evidence session...");

      const gps = await getGps();

      const created = await apiFetch("/v1/evidence", {
        method: "POST",
        body: JSON.stringify({
          type: activeType,
          mimeType: firstMimeType,
          deviceTimeIso: new Date().toISOString(),
          gps
        })
      });

      const createdId = created?.id as string;
      sessionEvidenceIdRef.current = createdId;
      setSessionEvidenceId(createdId);
      setSessionCreatingEvidence(false);
      setInfo(null);

      return createdId;
    },
    [activeType, getGps]
  );

  const addCapturedItemToSession = useCallback(
    async (input: {
      uri: string;
      mimeType: string;
      durationMs?: number;
      sizeBytes?: number;
      originalFilename?: string;
    }) => {
      setError(null);
      setInfo(null);

      try {
        await ensureSessionEvidence(input.mimeType);

        const nextItem: CapturedItem = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          uri: input.uri,
          mimeType: input.mimeType,
          durationMs: input.durationMs,
          sizeBytes: input.sizeBytes,
          originalFilename: input.originalFilename,
          partIndex: sessionItemsRef.current.length,
          uploadProgress: 0,
          uploading: false,
          uploaded: false,
          error: null
        };

        const nextItems = [...sessionItemsRef.current, nextItem];
        setSessionState(nextItems);

        addToast(
          `${nextItems.length} item${nextItems.length === 1 ? "" : "s"} added`,
          "success"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to add item";
        setError(msg);
        addToast(msg, "error");
        setSessionCreatingEvidence(false);
        setInfo(null);
      }
    },
    [ensureSessionEvidence, setSessionState, addToast]
  );

  const removeFromSession = useCallback(
    (itemId: string) => {
      if (sessionCompletingEvidence) return;

      const filtered = sessionItemsRef.current
        .filter((item) => item.id !== itemId)
        .map((item, index) => ({
          ...item,
          partIndex: index
        }));

      setSessionState(filtered);

      if (filtered.length === 0) {
        sessionEvidenceIdRef.current = null;
        setSessionEvidenceId(null);
      }

      addToast("Item removed", "info");
    },
    [sessionCompletingEvidence, setSessionState, addToast]
  );

  const discardSession = useCallback(() => {
    if (sessionCompletingEvidence) return;
    sessionEvidenceIdRef.current = null;
    setSessionEvidenceId(null);
    setSessionState([]);
    setError(null);
    setInfo(null);
    setUploadProgress(0);
    addToast("Session discarded", "info");
  }, [sessionCompletingEvidence, setSessionState, addToast]);

  const ensureCameraReady = useCallback(async () => {
    setShowSettingsLink(false);

    const camGranted = cameraPermission?.granted ?? false;
    if (!camGranted) {
      const res = await requestCameraPermission();
      if (!res.granted) {
        setError("Camera permission denied");
        setShowSettingsLink(true);
        addToast("Camera permission denied", "error");
        return false;
      }
    }

    if (activeType === "VIDEO") {
      const micGranted = micPermission?.granted ?? false;
      if (!micGranted) {
        const res = await requestMicPermission();
        if (!res.granted) {
          setError("Microphone permission denied");
          setShowSettingsLink(true);
          addToast("Microphone permission denied", "error");
          return false;
        }
      }
    }

    return true;
  }, [
    activeType,
    cameraPermission?.granted,
    micPermission?.granted,
    requestCameraPermission,
    requestMicPermission,
    addToast
  ]);

  const openPickerOrCamera = useCallback(async () => {
    setError(null);
    setInfo(null);

    try {
      if (activeType === "DOCUMENT") {
        const result = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          multiple: false,
          type: "*/*"
        });

        if (result.canceled || !result.assets?.[0]) {
          return;
        }

        const file = result.assets[0];
        const fileInfo = await FileSystem.getInfoAsync(file.uri);

        await addCapturedItemToSession({
          uri: file.uri,
          mimeType: file.mimeType ?? "application/octet-stream",
          sizeBytes: file.size ?? (fileInfo.exists ? fileInfo.size : undefined),
          originalFilename: file.name ?? getFilename(file.uri, `document-${Date.now()}`)
        });

        return;
      }

      const ready = await ensureCameraReady();
      if (!ready) return;

      setCameraOpen(true);
      addToast(`${activeType.toLowerCase()} camera ready`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to open picker/camera";
      setError(msg);
      addToast(msg, "error");
    }
  }, [activeType, addCapturedItemToSession, ensureCameraReady, getFilename, addToast]);

  const handleTakePhoto = useCallback(async () => {
    if (!cameraRef.current || busy || sessionCompletingEvidence) return;

    try {
      setBusy(true);
      setError(null);
      setInfo("Capturing photo...");

      const result = await cameraRef.current.takePictureAsync({
        quality: 0.9
      });

      if (!result?.uri) {
        setBusy(false);
        setInfo(null);
        return;
      }

      const fileInfo = await FileSystem.getInfoAsync(result.uri);

      await addCapturedItemToSession({
        uri: result.uri,
        mimeType: "image/jpeg",
        sizeBytes: fileInfo.exists ? fileInfo.size : undefined,
        originalFilename: getFilename(result.uri, `photo-${Date.now()}.jpg`)
      });

      setInfo(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to capture photo";
      setError(msg);
      addToast(msg, "error");
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    sessionCompletingEvidence,
    addCapturedItemToSession,
    getFilename,
    addToast
  ]);

  const handleStartRecording = useCallback(async () => {
    if (!cameraRef.current || busy || sessionCompletingEvidence || isRecording) return;

    try {
      setError(null);
      setInfo(null);
      setIsRecording(true);
      addToast("Recording started", "info");

      const startedAt = Date.now();
      const result = await cameraRef.current.recordAsync();
      const recordResult = result as { uri?: string; duration?: number };

      if (recordResult?.uri) {
        const fileInfo = await FileSystem.getInfoAsync(recordResult.uri);
        const durationMs =
          typeof recordResult.duration === "number"
            ? Math.max(0, Math.round(recordResult.duration * 1000))
            : Math.max(0, Date.now() - startedAt);

        await addCapturedItemToSession({
          uri: recordResult.uri,
          mimeType: "video/mp4",
          durationMs,
          sizeBytes: fileInfo.exists ? fileInfo.size : undefined,
          originalFilename: getFilename(recordResult.uri, `video-${Date.now()}.mp4`)
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to record video";
      setError(msg);
      addToast(msg, "error");
    } finally {
      setIsRecording(false);
    }
  }, [
    busy,
    sessionCompletingEvidence,
    isRecording,
    addCapturedItemToSession,
    getFilename,
    addToast
  ]);

  const handleStopRecording = useCallback(() => {
    cameraRef.current?.stopRecording();
  }, []);

  const completeSession = useCallback(async () => {
    const evidenceId = sessionEvidenceIdRef.current;
    const items = sessionItemsRef.current;

    if (!evidenceId || items.length === 0) {
      setError("No items in session");
      addToast("No items in session", "error");
      return;
    }

    setSessionCompletingEvidence(true);
    setBusy(true);
    setError(null);
    setInfo("Uploading session...");
    setUploadProgress(0);

    try {
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];

        setSessionState(
          sessionItemsRef.current.map((current) =>
            current.id === item.id
              ? { ...current, uploading: true, error: null, uploadProgress: 0 }
              : current
          )
        );

        const part = await apiFetch(`/v1/evidence/${evidenceId}/parts`, {
          method: "POST",
          body: JSON.stringify({
            partIndex: item.partIndex,
            mimeType: item.mimeType,
            durationMs: item.durationMs ?? undefined
          })
        });

        const fileUri = await ensureFileUri(item.uri);

setSessionState(
  sessionItemsRef.current.map((current) =>
    current.id === item.id
      ? { ...current, uploading: true, uploadProgress: 10 }
      : current
  )
);

await uploadWithPut({
  putUrl: part.upload.putUrl,
  uri: fileUri,
  mimeType: item.mimeType
});

setSessionState(
  sessionItemsRef.current.map((current) =>
    current.id === item.id
      ? { ...current, uploading: true, uploadProgress: 100 }
      : current
  )
);
        setSessionState(
          sessionItemsRef.current.map((current) =>
            current.id === item.id
              ? { ...current, uploading: false, uploaded: true, uploadProgress: 100 }
              : current
          )
        );

        setUploadProgress(Math.round(((i + 1) / items.length) * 85));
      }

      setInfo("Finalizing evidence...");
      setUploadProgress(92);

      await apiFetch(`/v1/evidence/${evidenceId}/complete`, {
        method: "POST",
        body: JSON.stringify({
          sizeBytes:
            sessionItemsRef.current.reduce(
              (sum, item) => sum + (item.sizeBytes ?? 0),
              0
            ) || undefined,
          durationMs:
            sessionItemsRef.current.reduce(
              (sum, item) => sum + (item.durationMs ?? 0),
              0
            ) || undefined
        })
      });

      setUploadProgress(96);
      await pollReport(evidenceId);
      setUploadProgress(100);

      addToast("Evidence created successfully", "success", 2000);

      sessionEvidenceIdRef.current = null;
      setSessionEvidenceId(null);
      setSessionState([]);
      setInfo(null);
      setError(null);
      setBusy(false);
      setSessionCompletingEvidence(false);
      setUploadProgress(0);

      await refreshRecent();
      router.push(`/evidence/${evidenceId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to finish session";
      setError(msg);
      addToast(msg, "error");
    } finally {
      setBusy(false);
      setSessionCompletingEvidence(false);
    }
  }, [addToast, pollReport, refreshRecent, router, setSessionState]);

  const sessionCountLabel = useMemo(() => {
    const count = sessionItems.length;
    return `${count} item${count === 1 ? "" : "s"} added`;
  }, [sessionItems.length]);

  const totalDurationText = useMemo(() => {
    const totalMs = sessionItems.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
    if (!totalMs) return null;
    return `${(totalMs / 1000).toFixed(1)}s total`;
  }, [sessionItems]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerIcon}>‹</Text>
        <Text style={[styles.headerTitle, { fontFamily: fontFamilyBold }]}>
          {t("capture")}
        </Text>
        <Text style={styles.headerIcon}>⋮</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Tabs
          items={[t("photo"), t("video"), t("document")]}
          activeIndex={activeIndex}
          onSelect={(index) => {
            if (isSessionActive) {
              addToast("Finish or discard the current session before changing type", "warning");
              return;
            }

            setActiveIndex(index);
            setCameraOpen(false);
            setError(null);
            setInfo(null);
            setShowSettingsLink(false);
          }}
        />

        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Include location metadata</Text>
          <Switch value={useLocation} onValueChange={setUseLocation} />
        </View>

        {cameraOpen && activeType !== "DOCUMENT" ? (
          <View style={styles.cameraCard}>
            <View>
              <CameraView ref={cameraRef} style={styles.cameraPreview} />

              <View style={styles.overlayTopLeft}>
                <Text style={styles.overlayBadge}>
                  Auto-add mode
                </Text>
              </View>

              <View style={styles.overlayTopRight}>
                <Text style={styles.counterBadge}>
                  {sessionItems.length}
                </Text>
              </View>
            </View>

            <View style={styles.cameraControls}>
              {activeType === "PHOTO" ? (
                <>
                  <Text style={styles.timerText}>Take photos continuously. Each shot is added automatically.</Text>

                  <Pressable
                    style={[styles.captureBar, styles.primaryAction]}
                    onPress={handleTakePhoto}
                    disabled={busy || sessionCompletingEvidence || sessionCreatingEvidence}
                  >
                    <Text style={styles.uploadText}>
                      {busy || sessionCreatingEvidence ? "Capturing..." : "Capture Photo"}
                    </Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.timerText}>
                    {isRecording ? `Recording ${recordSeconds}s` : "Record video. It will be auto-added to the session."}
                  </Text>

                  <Pressable
                    style={[
                      styles.captureBar,
                      isRecording ? styles.stopAction : styles.primaryAction
                    ]}
                    onPress={isRecording ? handleStopRecording : handleStartRecording}
                    disabled={busy || sessionCompletingEvidence || sessionCreatingEvidence}
                  >
                    <Text style={styles.uploadText}>
                      {isRecording ? "Stop Recording" : "Start Recording"}
                    </Text>
                  </Pressable>
                </>
              )}

              <Pressable
                style={[styles.captureBar, styles.secondaryBar]}
                onPress={() => setCameraOpen(false)}
                disabled={isRecording}
              >
                <Text style={styles.secondaryText}>Close Camera</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable style={[styles.captureBar, styles.primaryAction]} onPress={openPickerOrCamera}>
            <Text style={styles.uploadText}>
              {activeType === "DOCUMENT" ? "Pick Document" : "Open Camera"}
            </Text>
          </Pressable>
        )}

        <View style={styles.preview}>
          <Text style={styles.previewText}>
            {isSessionActive
              ? `Session active • ${sessionCountLabel}${totalDurationText ? ` • ${totalDurationText}` : ""}`
              : "No active capture session"}
          </Text>
        </View>

        {sessionItems.length > 0 ? (
          <View style={styles.sessionCard}>
            <Text style={[styles.sessionTitle, { fontFamily: fontFamilyBold }]}>
              Capture Session
            </Text>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbStrip}>
              {sessionItems.map((item, index) => {
                const isImage = item.mimeType.startsWith("image/");
                const isVideo = item.mimeType.startsWith("video/");

                return (
                  <View key={item.id} style={styles.thumbCard}>
                    <View style={styles.thumbPreview}>
                      {isImage ? (
                        <Image source={{ uri: item.uri }} style={styles.thumbImage} />
                      ) : (
                        <View style={styles.thumbFallback}>
                          <Text style={styles.thumbFallbackText}>{isVideo ? "VIDEO" : "DOC"}</Text>
                        </View>
                      )}

                      <View style={styles.thumbIndexBadge}>
                        <Text style={styles.thumbIndexText}>{index + 1}</Text>
                      </View>
                    </View>

                    <Text numberOfLines={1} style={styles.thumbLabel}>
                      {item.originalFilename || `Item ${index + 1}`}
                    </Text>

                    {item.uploading ? (
                      <Text style={styles.thumbMeta}>{item.uploadProgress}%</Text>
                    ) : item.uploaded ? (
                      <Text style={styles.thumbMeta}>Uploaded</Text>
                    ) : (
                      <Text style={styles.thumbMeta}>Ready</Text>
                    )}

                    <Pressable
                      onPress={() => removeFromSession(item.id)}
                      disabled={sessionCompletingEvidence}
                      style={styles.removePill}
                    >
                      <Text style={styles.removePillText}>Remove</Text>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>

            <View style={styles.sessionActions}>
              {activeType === "DOCUMENT" ? (
                <Pressable
                  style={[styles.captureBar, styles.secondaryBar, styles.sessionActionButton]}
                  onPress={openPickerOrCamera}
                  disabled={sessionCompletingEvidence}
                >
                  <Text style={styles.secondaryText}>Add Another Document</Text>
                </Pressable>
              ) : !cameraOpen ? (
                <Pressable
                  style={[styles.captureBar, styles.secondaryBar, styles.sessionActionButton]}
                  onPress={openPickerOrCamera}
                  disabled={sessionCompletingEvidence}
                >
                  <Text style={styles.secondaryText}>
                    {activeType === "PHOTO" ? "Open Camera for More Photos" : "Open Camera for More Videos"}
                  </Text>
                </Pressable>
              ) : null}

              <Pressable
                style={[styles.captureBar, styles.finishAction, styles.sessionActionButton]}
                onPress={completeSession}
                disabled={sessionCompletingEvidence || sessionCreatingEvidence}
              >
                <Text style={styles.uploadText}>
                  {sessionCompletingEvidence
                    ? `Finishing... ${uploadProgress}%`
                    : `Finish & Sign (${sessionItems.length})`}
                </Text>
              </Pressable>

              <Pressable
                style={[styles.captureBar, styles.dangerAction, styles.sessionActionButton]}
                onPress={discardSession}
                disabled={sessionCompletingEvidence}
              >
                <Text style={styles.uploadText}>Discard Session</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {info ? <Text style={styles.infoText}>{info}</Text> : null}

        {showSettingsLink ? (
          <Pressable
            style={[styles.captureBar, styles.secondaryBar]}
            onPress={() => Linking.openSettings()}
          >
            <Text style={styles.secondaryText}>Open Settings</Text>
          </Pressable>
        ) : null}

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
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#050b18"
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
    color: "rgba(245,251,255,0.96)"
  },
  headerIcon: {
    fontSize: 18,
    color: "rgba(219,235,248,0.70)"
  },
  preview: {
    minHeight: 60,
    borderRadius: 18,
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)",
    justifyContent: "center"
  },
  previewText: {
    color: "rgba(219,235,248,0.74)",
    padding: spacing.md
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)"
  },
  toggleLabel: {
    color: "rgba(245,251,255,0.90)",
    fontSize: 14
  },
  cameraCard: {
    backgroundColor: "rgba(7, 20, 38, 0.92)",
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.18)"
  },
  cameraPreview: {
    height: 380,
    width: "100%"
  },
  overlayTopLeft: {
    position: "absolute",
    top: 12,
    left: 12
  },
  overlayTopRight: {
    position: "absolute",
    top: 12,
    right: 12
  },
  overlayBadge: {
    backgroundColor: "rgba(6,13,31,0.78)",
    color: "rgba(245,251,255,0.96)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: "700",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.20)"
  },
  counterBadge: {
    minWidth: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(16,185,129,0.94)",
    color: "#fff",
    textAlign: "center",
    textAlignVertical: "center",
    fontSize: 14,
    fontWeight: "800",
    overflow: "hidden",
    paddingTop: 7
  },
  cameraControls: {
    padding: spacing.md,
    gap: spacing.sm
  },
  timerText: {
    color: "rgba(219,235,248,0.72)",
    fontSize: 12,
    textAlign: "center"
  },
  listCard: {
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderRadius: 18,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)"
  },
  captureBar: {
    marginTop: spacing.md,
    borderRadius: 18,
    paddingVertical: spacing.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.18)"
  },
  primaryAction: {
    backgroundColor: colors.primaryNavy
  },
  finishAction: {
    backgroundColor: "#10b981"
  },
  dangerAction: {
    backgroundColor: "#b91c1c"
  },
  stopAction: {
    backgroundColor: "#ef4444"
  },
  secondaryBar: {
    backgroundColor: "rgba(6, 13, 31, 0.52)"
  },
  uploadText: {
    color: "rgba(245,251,255,0.92)",
    fontWeight: "700"
  },
  secondaryText: {
    color: "rgba(245,251,255,0.92)",
    fontWeight: "700"
  },
  errorText: {
    color: "rgba(239, 68, 68, 0.95)",
    paddingHorizontal: spacing.xl
  },
  infoText: {
    color: "rgba(219,235,248,0.80)",
    paddingHorizontal: spacing.xl
  },
  sessionCard: {
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderRadius: 18,
    padding: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)"
  },
  sessionTitle: {
    color: "rgba(245,251,255,0.92)",
    fontSize: typography.size.h4,
    marginBottom: spacing.sm
  },
  thumbStrip: {
    gap: 12,
    paddingVertical: 8
  },
  thumbCard: {
    width: 120,
    backgroundColor: "rgba(6,13,31,0.48)",
    borderRadius: 14,
    padding: 8,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.12)"
  },
  thumbPreview: {
    width: "100%",
    height: 90,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "rgba(15,23,42,0.9)",
    position: "relative"
  },
  thumbImage: {
    width: "100%",
    height: "100%"
  },
  thumbFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center"
  },
  thumbFallbackText: {
    color: "rgba(245,251,255,0.92)",
    fontWeight: "800",
    fontSize: 12
  },
  thumbIndexBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: "rgba(6,13,31,0.82)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999
  },
  thumbIndexText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "800"
  },
  thumbLabel: {
    color: "rgba(245,251,255,0.92)",
    marginTop: 8,
    fontSize: 12
  },
  thumbMeta: {
    color: "rgba(148,163,184,0.96)",
    marginTop: 4,
    fontSize: 11
  },
  removePill: {
    marginTop: 8,
    backgroundColor: "rgba(127,29,29,0.9)",
    paddingVertical: 6,
    borderRadius: 999,
    alignItems: "center"
  },
  removePillText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700"
  },
  sessionActions: {
    marginTop: 8
  },
  sessionActionButton: {
    marginTop: 10
  }
});