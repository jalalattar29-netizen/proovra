import { Linking, Pressable, ScrollView, StyleSheet, Text, View, Switch, FlatList } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { Badge, ListRow, Tabs } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { useToast } from "../../src/toast-context";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { apiFetch } from "../../src/api";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { ensureFileUri, uploadWithPut } from "../../src/upload-utils";

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
  error?: string | null;
};

export default function CaptureScreen() {
  const { t, fontFamilyBold } = useLocale();
  const { addToast } = useToast();
  const [activeIndex, setActiveIndex] = useState(0);
  const typeMap = ["PHOTO", "VIDEO", "DOCUMENT"] as const;
  const activeType = typeMap[activeIndex];
  
  // Session-based state for multi-capture
  const [sessionEvidenceId, setSessionEvidenceId] = useState<string | null>(null);
  const [sessionItems, setSessionItems] = useState<CapturedItem[]>([]);
  const [sessionCreatingEvidence, setSessionCreatingEvidence] = useState(false);
  const [sessionCompletingEvidence, setSessionCompletingEvidence] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionInfo, setSessionInfo] = useState<string | null>(null);
  
  // Single capture state (for asset preview before adding to session)
  const [asset, setAsset] = useState<{
    uri: string;
    mimeType: string;
    durationMs?: number;
    sizeBytes?: number;
    originalFilename?: string;
  } | null>(null);
  
  // Video segments mode (existing segmented mode)
  const [segments, setSegments] = useState<
    Array<{ uri: string; mimeType: string; durationMs?: number; sizeBytes?: number; originalFilename?: string }>
  >([]);
  const [extendedMode, setExtendedMode] = useState(false);
  
  const [cameraOpen, setCameraOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
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

  // Session-based capture helpers
  const addToSession = useCallback(async (assetToAdd: CapturedItem["uri"] | typeof asset) => {
    if (!assetToAdd) return;
    
    setSessionError(null);
    setSessionInfo(null);
    const assetObj = typeof assetToAdd === "string" ? asset! : assetToAdd;
    if (!assetObj) return;

    const itemId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    try {
      // Create evidence on first item
      if (!sessionEvidenceId) {
        setSessionCreatingEvidence(true);
        setSessionInfo("Creating evidence record...");
        
        let gps: { lat: number; lng: number; accuracyMeters?: number } | undefined;
        
        if (useLocation) {
          setSessionInfo("Getting location for session...");
          const permission = await Location.requestForegroundPermissionsAsync();
          if (permission.granted) {
            try {
              const pos = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.Balanced,
              });
              gps = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracyMeters: pos.coords.accuracy ?? undefined,
              };
            } catch {
              addToast("Could not get location, continuing without GPS", "warning");
            }
          }
        }
        
        const created = await apiFetch("/v1/evidence", {
          method: "POST",
          body: JSON.stringify({
            type: activeType,
            mimeType: assetObj.mimeType,
            originalFilename: assetObj.originalFilename ?? undefined,
            deviceTimeIso: new Date().toISOString(),
            gps: gps ?? undefined,
          }),
        });

        setSessionEvidenceId(created.id);
        setSessionInfo(null);
        addToast("Evidence session created", "success");
      }

      // Add item to session
      const newItem: CapturedItem = {
        id: itemId,
        uri: assetObj.uri,
        mimeType: assetObj.mimeType,
        durationMs: assetObj.durationMs,
        sizeBytes: assetObj.sizeBytes,
        originalFilename: assetObj.originalFilename,
        partIndex: sessionItems.length,
        uploadProgress: 0,
        uploading: false,
      };

      setSessionItems((prev) => [...prev, newItem]);
      addToast(`Item added to session (${sessionItems.length + 1})`, "success");
      setAsset(null);
      setSessionCreatingEvidence(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add item to session";
      setSessionError(msg);
      addToast(msg, "error");
      setSessionCreatingEvidence(false);
    }
  }, [sessionEvidenceId, sessionItems.length, activeType, useLocation, addToast]);

  const removeFromSession = useCallback((itemId: string) => {
    setSessionItems((prev) => {
      const idx = prev.findIndex((i) => i.id === itemId);
      if (idx === -1) return prev;
      // Renumber partIndex for all items after this one
      const updated = prev.filter((_, i) => i !== idx);
      return updated.map((item, index) => ({ ...item, partIndex: index }));
    });
    addToast("Item removed from session", "info");
  }, [addToast]);

  const completeSession = useCallback(async () => {
    if (!sessionEvidenceId || sessionItems.length === 0) {
      setSessionError("No items in session");
      addToast("No items in session", "error");
      return;
    }

    setSessionCompletingEvidence(true);
    setSessionError(null);
    setSessionInfo(null);
    setUploadProgress(0);

    const completeEvidenceId = sessionEvidenceId; // Save ID before clearing state

    try {
      let totalUploaded = 0;
      const totalItems = sessionItems.length;

      // Upload all items as parts
      for (const item of sessionItems) {
        const baseProgress = Math.round((totalUploaded / totalItems) * 80);
        
        setSessionInfo(`Uploading item ${totalUploaded + 1} of ${totalItems}...`);
        setUploadProgress(baseProgress);

        try {
          // Request part upload URL
          const part = await apiFetch(`/v1/evidence/${completeEvidenceId}/parts`, {
            method: "POST",
            body: JSON.stringify({
              partIndex: item.partIndex,
              mimeType: item.mimeType,
              durationMs: item.durationMs ?? undefined,
            }),
          });

          // Upload file to presigned URL
          const fileUri = await ensureFileUri(item.uri);
          await uploadWithPut({
            putUrl: part.upload.putUrl,
            uri: fileUri,
            mimeType: item.mimeType,
          });

          totalUploaded += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Upload failed for item";
          throw new Error(`${msg} (item ${totalUploaded + 1}/${totalItems})`);
        }
      }

      setSessionInfo("Finalizing evidence...");
      setUploadProgress(90);

      // Complete the evidence
      await apiFetch(`/v1/evidence/${completeEvidenceId}/complete`, {
        method: "POST",
        body: JSON.stringify({
          sizeBytes: sessionItems.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0) || undefined,
          durationMs: sessionItems.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) || undefined,
        }),
      });

      setSessionInfo("Waiting for report generation...");
      await pollReport(completeEvidenceId);

      setUploadProgress(100);
      addToast("Evidence session finalized successfully!", "success", 2000);

      // Clear session and navigate
      setSessionEvidenceId(null);
      setSessionItems([]);
      setAsset(null);
      setSegments([]);
      
      router.push(`/evidence/${completeEvidenceId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to complete session";
      setSessionError(msg);
      addToast(msg, "error");
    } finally {
      setSessionCompletingEvidence(false);
      setUploadProgress(0);
      setSessionInfo(null);
    }
  }, [sessionEvidenceId, sessionItems, addToast, router]);

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
      // Existing segmented mode - keep it as-is for backward compatibility
      if (segments.length === 0) {
        setError("Record at least one segment.");
        addToast("Record at least one segment", "error");
        return;
      }

      setBusy(true);
      setUploadProgress(0);
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
            accuracy: Location.Accuracy.Balanced,
          });
          gps = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyMeters: pos.coords.accuracy ?? undefined,
          };
          addToast("Location captured", "success");
        }

        const MAX_ATTEMPTS = 2;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          try {
            setUploadProgress(10);

            const baseFilename = `video-${Date.now()}.mp4`;
            const created = await apiFetch("/v1/evidence", {
              method: "POST",
              body: JSON.stringify({
                type: activeType,
                mimeType: "video/mp4",
                originalFilename: baseFilename,
                deviceTimeIso,
                gps,
              }),
            });

            const segmentSizes: number[] = [];
            for (let i = 0; i < segments.length; i += 1) {
              const pct = 10 + Math.round(((i + 1) / Math.max(segments.length, 1)) * 70);
              setUploadProgress(pct);

              addToast(`Uploading segment ${i + 1}/${segments.length}...`, "info");
              const seg = segments[i];
              const segUri = await ensureFileUri(seg.uri);

              if (!seg.sizeBytes) {
                const info2 = await FileSystem.getInfoAsync(segUri);
                segmentSizes.push(info2.exists ? info2.size ?? 0 : 0);
              } else {
                segmentSizes.push(seg.sizeBytes ?? 0);
              }

              const part = await apiFetch(`/v1/evidence/${created.id}/parts`, {
                method: "POST",
                body: JSON.stringify({
                  partIndex: i,
                  mimeType: seg.mimeType,
                  durationMs: seg.durationMs,
                }),
              });

              await uploadWithPut({
                putUrl: part.upload.putUrl,
                uri: segUri,
                mimeType: seg.mimeType,
              });
            }

            setUploadProgress(90);
            addToast("Finalizing evidence...", "info");
            await apiFetch(`/v1/evidence/${created.id}/complete`, {
              method: "POST",
              body: JSON.stringify({
                sizeBytes: segmentSizes.reduce((sum, value) => sum + value, 0),
                durationMs: segments.reduce((sum, seg) => sum + (seg.durationMs ?? 0), 0),
                originalFilename: baseFilename,
              }),
            });

            await pollReport(created.id);

            setUploadProgress(100);
            addToast("Evidence captured successfully!", "success", 2000);
            router.push(`/evidence/${created.id}`);
            break;
          } catch (err) {
            if (attempt === MAX_ATTEMPTS) throw err;
            addToast(`Upload failed, retrying (${attempt}/${MAX_ATTEMPTS})...`, "warning");
          }
        }
      } catch (err) {
        const baseMsg = err instanceof Error ? err.message : "Upload failed";
        const reqId = (err as { requestId?: string }).requestId;

        const msg =
          reqId && typeof baseMsg === "string" && !baseMsg.includes("requestId:")
            ? `${baseMsg} (requestId: ${reqId})`
            : baseMsg;

        setError(msg);
        addToast(msg, "error");
      } finally {
        setBusy(false);
        setUploadProgress(0);
      }
    } else {
      // Single-file flow: add to session instead of immediate upload
      if (!asset) {
        setError("Please capture or select a file first.");
        addToast("Please capture or select a file first", "error");
        return;
      }

      await addToSession(asset);
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
            style={[
              styles.captureBar,
              { backgroundColor: extendedMode ? colors.teal : colors.primaryNavy }
            ]}
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
                    style={[
                      styles.captureBar,
                      { backgroundColor: isRecording ? "#ef4444" : colors.primaryNavy }
                    ]}
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

            {sessionEvidenceId && sessionItems.length > 0 ? (
              <>
                <View style={styles.sessionCard}>
                  <Text style={[styles.sessionTitle, { fontFamily: fontFamilyBold }]}>
                    Capture Session ({sessionItems.length} item{sessionItems.length !== 1 ? "s" : ""})
                  </Text>
                  <FlatList
                    data={sessionItems}
                    keyExtractor={(item) => item.id}
                    scrollEnabled={false}
                    renderItem={({ item, index }) => (
                      <View style={styles.sessionItemRow}>
                        <Text style={styles.sessionItemText}>
                          {index + 1}. {item.originalFilename || `Item ${index + 1}`}
                        </Text>
                        <Pressable
                          onPress={() => removeFromSession(item.id)}
                          disabled={sessionCompletingEvidence}
                        >
                          <Text style={styles.removeButton}>✕</Text>
                        </Pressable>
                      </View>
                    )}
                  />
                </View>

                <Pressable
                  style={[styles.captureBar, { backgroundColor: colors.teal }]}
                  onPress={handleCapture}
                  disabled={busy || !asset}
                >
                  <Text style={styles.uploadText}>
                    {busy ? "Adding to session..." : "Add Another Item"}
                  </Text>
                </Pressable>

                <Pressable
                  style={[styles.captureBar, { backgroundColor: "#10b981" }]}
                  onPress={completeSession}
                  disabled={sessionCompletingEvidence}
                >
                  <Text style={styles.uploadText}>
                    {sessionCompletingEvidence ? `Finalizing... ${uploadProgress}%` : "Finish & Sign"}
                  </Text>
                </Pressable>

                {sessionError ? <Text style={styles.errorText}>{sessionError}</Text> : null}
                {sessionInfo ? <Text style={styles.infoText}>{sessionInfo}</Text> : null}
              </>
            ) : (
              <>
                <Pressable
                  style={[styles.captureBar, { backgroundColor: colors.teal }]}
                  onPress={handleCapture}
                  disabled={busy}
                >
                  <Text style={styles.uploadText}>
                    {busy ? `Uploading... ${uploadProgress}%` : "Upload & Sign"}
                  </Text>
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
          </>
        )}
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

  // Preview = مكان رمادي كان، صار dark glass
  preview: {
    height: 180,
    borderRadius: 18,
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)"
  },

  cameraCard: {
    backgroundColor: "rgba(7, 20, 38, 0.92)",
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.18)"
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
    color: "rgba(219,235,248,0.72)",
    fontSize: 12,
    textAlign: "center"
  },
  warningText: {
    color: "rgba(245, 158, 11, 0.92)",
    fontSize: 12,
    textAlign: "center"
  },

  // Secondary buttons = glass, مو أبيض
  secondaryBar: {
    backgroundColor: "rgba(6, 13, 31, 0.52)",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)"
  },
  secondaryText: {
    color: "rgba(245,251,255,0.92)",
    fontWeight: "700"
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

  listCard: {
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderRadius: 18,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)"
  },

  // Main bars (Pick / Upload / etc)
  captureBar: {
    marginTop: spacing.md,
    borderRadius: 18,
    backgroundColor: "rgba(6, 13, 31, 0.62)",
    paddingVertical: spacing.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.18)"
  },
  captureCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(101,235,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.35)"
  },
  uploadText: {
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
  sessionItemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(101,235,255,0.08)"
  },
  sessionItemText: {
    color: "rgba(219,235,248,0.80)",
    fontSize: 13,
    flex: 1
  },
  removeButton: {
    color: "rgba(239, 68, 68, 0.95)",
    fontSize: 18,
    marginLeft: spacing.md
  }
});