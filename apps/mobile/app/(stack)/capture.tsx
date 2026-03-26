import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
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
  useMicrophonePermissions,
} from "expo-camera";
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

type PendingAsset = {
  uri: string;
  mimeType: string;
  durationMs?: number;
  sizeBytes?: number;
  originalFilename?: string;
};

export default function CaptureScreen() {
  const { t, fontFamilyBold } = useLocale();
  const { addToast } = useToast();
  const router = useRouter();

  const [activeIndex, setActiveIndex] = useState(0);
  const typeMap = ["PHOTO", "VIDEO", "DOCUMENT"] as const;
  const activeType = typeMap[activeIndex];

  const [sessionEvidenceId, setSessionEvidenceId] = useState<string | null>(null);
  const [sessionItems, setSessionItems] = useState<CapturedItem[]>([]);
  const [sessionCreatingEvidence, setSessionCreatingEvidence] = useState(false);
  const [sessionCompletingEvidence, setSessionCompletingEvidence] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionInfo, setSessionInfo] = useState<string | null>(null);

  const [asset, setAsset] = useState<PendingAsset | null>(null);

  const [segments, setSegments] = useState<
    Array<{
      uri: string;
      mimeType: string;
      durationMs?: number;
      sizeBytes?: number;
      originalFilename?: string;
    }>
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

  const getFilename = (uri: string, fallback: string) => {
    const name = uri.split("/").pop();
    return name && name.length > 0 ? name : fallback;
  };

  const resetSingleAssetState = () => {
    setAsset(null);
    setError(null);
    setInfo(null);
  };

  const resetSession = () => {
    setSessionEvidenceId(null);
    setSessionItems([]);
    setSessionCreatingEvidence(false);
    setSessionCompletingEvidence(false);
    setSessionError(null);
    setSessionInfo(null);
  };

  const addToSession = useCallback(
    async (assetToAdd: PendingAsset | null) => {
      if (!assetToAdd) return;

      setSessionError(null);
      setSessionInfo(null);

      const itemId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const nextPartIndex = sessionItems.length;

      try {
        let evidenceId = sessionEvidenceId;

        if (!evidenceId) {
          setSessionCreatingEvidence(true);
          setSessionInfo("Creating evidence record...");

          let gps:
            | {
                lat: number;
                lng: number;
                accuracyMeters?: number;
              }
            | undefined;

          if (useLocation) {
            try {
              const permission = await Location.requestForegroundPermissionsAsync();
              if (permission.granted) {
                const pos = await Location.getCurrentPositionAsync({
                  accuracy: Location.Accuracy.Balanced,
                });

                gps = {
                  lat: pos.coords.latitude,
                  lng: pos.coords.longitude,
                  accuracyMeters: pos.coords.accuracy ?? undefined,
                };
              } else {
                addToast("Location permission denied, continuing without GPS", "warning");
              }
            } catch {
              addToast("Could not get location, continuing without GPS", "warning");
            }
          }

          const created = await apiFetch("/v1/evidence", {
            method: "POST",
            body: JSON.stringify({
              type: activeType,
              mimeType: assetToAdd.mimeType,
              deviceTimeIso: new Date().toISOString(),
              gps: gps ?? undefined,
            }),
          });

          evidenceId = created.id as string;
          setSessionEvidenceId(evidenceId);
          addToast("Evidence session created", "success");
        }

        const newItem: CapturedItem = {
          id: itemId,
          uri: assetToAdd.uri,
          mimeType: assetToAdd.mimeType,
          durationMs: assetToAdd.durationMs,
          sizeBytes: assetToAdd.sizeBytes,
          originalFilename: assetToAdd.originalFilename,
          partIndex: nextPartIndex,
          uploadProgress: 0,
          uploading: false,
          error: null,
        };

        setSessionItems((prev) => [...prev, newItem]);
        setSessionInfo(`${nextPartIndex + 1} item${nextPartIndex === 0 ? "" : "s"} in session`);
        setAsset(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to add item to session";
        setSessionError(msg);
        addToast(msg, "error");
      } finally {
        setSessionCreatingEvidence(false);
      }
    },
    [activeType, addToast, sessionEvidenceId, sessionItems.length, useLocation]
  );

  const removeFromSession = useCallback(
    (itemId: string) => {
      setSessionItems((prev) => {
        const filtered = prev.filter((item) => item.id !== itemId);
        return filtered.map((item, index) => ({
          ...item,
          partIndex: index,
        }));
      });

      addToast("Item removed from session", "info");
    },
    [addToast]
  );

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

    const completeEvidenceId = sessionEvidenceId;

    try {
      let totalUploaded = 0;
      const totalItems = sessionItems.length;

      for (const item of sessionItems) {
        const progressStart = Math.round((totalUploaded / totalItems) * 80);
        setSessionInfo(`Uploading item ${totalUploaded + 1} of ${totalItems}...`);
        setUploadProgress(progressStart);

        setSessionItems((prev) =>
          prev.map((row) =>
            row.id === item.id ? { ...row, uploading: true, error: null } : row
          )
        );

        try {
          const part = await apiFetch(`/v1/evidence/${completeEvidenceId}/parts`, {
            method: "POST",
            body: JSON.stringify({
              partIndex: item.partIndex,
              mimeType: item.mimeType,
              durationMs: item.durationMs ?? undefined,
            }),
          });

          const fileUri = await ensureFileUri(item.uri);

          await uploadWithPut({
            putUrl: part.upload.putUrl,
            uri: fileUri,
            mimeType: item.mimeType,
          });

          totalUploaded += 1;

          setSessionItems((prev) =>
            prev.map((row) =>
              row.id === item.id
                ? { ...row, uploading: false, uploadProgress: 100, error: null }
                : row
            )
          );
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : `Upload failed for item ${totalUploaded + 1}`;
          setSessionItems((prev) =>
            prev.map((row) =>
              row.id === item.id ? { ...row, uploading: false, error: msg } : row
            )
          );
          throw new Error(`${msg} (item ${totalUploaded + 1}/${totalItems})`);
        }
      }

      setSessionInfo("Finalizing evidence...");
      setUploadProgress(90);

      await apiFetch(`/v1/evidence/${completeEvidenceId}/complete`, {
        method: "POST",
        body: JSON.stringify({
          sizeBytes:
            sessionItems.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0) || undefined,
          durationMs:
            sessionItems.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) || undefined,
        }),
      });

      setSessionInfo("Waiting for report generation...");
      await pollReport(completeEvidenceId);

      setUploadProgress(100);
      addToast("Evidence session finalized successfully!", "success", 2000);

      resetSession();
      resetSingleAssetState();
      setSegments([]);
      setCameraOpen(false);

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
  }, [addToast, router, sessionEvidenceId, sessionItems]);

  const handlePick = async () => {
    setError(null);
    setInfo(null);
    setShowSettingsLink(false);

    try {
      if (activeType === "DOCUMENT") {
        addToast("Opening file picker...", "info");

        const result = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          type: "*/*",
        });

        if (!result.canceled && result.assets?.[0]) {
          const file = result.assets[0];
          const fileInfo = await FileSystem.getInfoAsync(file.uri);

          const selectedAsset: PendingAsset = {
            uri: file.uri,
            mimeType: file.mimeType ?? "application/octet-stream",
            sizeBytes: file.size ?? (fileInfo.exists ? fileInfo.size : undefined),
            originalFilename: file.name ?? getFilename(file.uri, `document-${Date.now()}`),
          };

          setAsset(selectedAsset);
          await addToSession(selectedAsset);
        }

        return;
      }

      const camGranted = cameraPermission?.granted ?? false;
      const micGranted = micPermission?.granted ?? false;

      if (!camGranted) {
        const res = await requestCameraPermission();
        if (!res.granted) {
          setError("Camera permission denied");
          addToast("Camera permission denied", "error");
          setShowSettingsLink(true);
          return;
        }
      }

      if (activeType === "VIDEO" && !micGranted) {
        const res = await requestMicPermission();
        if (!res.granted) {
          setError("Microphone permission denied");
          addToast("Microphone permission denied", "error");
          setShowSettingsLink(true);
          return;
        }
      }

      setCameraOpen(true);
      addToast(`Opening ${activeType.toLowerCase()} camera...`, "info");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to open camera";
      setError(errorMsg);
      addToast(errorMsg, "error");
    }
  };

  const handleTakePhoto = async () => {
    if (!cameraRef.current || sessionCreatingEvidence || sessionCompletingEvidence) return;

    setError(null);
    setInfo(null);

    try {
      const result = await cameraRef.current.takePictureAsync({ quality: 0.9 });

      if (result?.uri) {
        const fileInfo = await FileSystem.getInfoAsync(result.uri);

        const newAsset: PendingAsset = {
          uri: result.uri,
          mimeType: "image/jpeg",
          sizeBytes: fileInfo.exists ? fileInfo.size : undefined,
          originalFilename: getFilename(result.uri, `photo-${Date.now()}.jpg`),
        };

        setAsset(newAsset);
        await addToSession(newAsset);
        addToast("Photo added to session", "success");
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to capture photo";
      setError(errorMsg);
      addToast(errorMsg, "error");
    }
  };

  const handleStartRecording = async () => {
    if (!cameraRef.current || sessionCreatingEvidence || sessionCompletingEvidence) return;

    setError(null);
    setInfo(null);
    setIsRecording(true);
    addToast("Recording started...", "info");

    try {
      const startedAt = Date.now();
      const result = await cameraRef.current.recordAsync();
      const typedResult = result as { uri?: string; duration?: number };

      const durationMs =
        typeof typedResult?.duration === "number"
          ? Math.max(0, Math.round(typedResult.duration * 1000))
          : Math.max(0, Date.now() - startedAt);

      if (result?.uri) {
        const fileInfo = await FileSystem.getInfoAsync(result.uri);

        const nextAsset: PendingAsset = {
          uri: result.uri,
          mimeType: "video/mp4",
          durationMs,
          sizeBytes: fileInfo.exists ? fileInfo.size : undefined,
          originalFilename: getFilename(result.uri, `video-${Date.now()}.mp4`),
        };

        if (extendedMode) {
          setSegments((prev) => [...prev, nextAsset]);
          addToast("Segment recorded successfully", "success");
          setCameraOpen(false);
        } else {
          setAsset(nextAsset);
          await addToSession(nextAsset);
          addToast("Video added to session", "success");
        }
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

      setBusy(true);
      setUploadProgress(0);
      setError(null);
      setInfo(null);
      addToast("Creating evidence record...", "info");

      try {
        let gps:
          | {
              lat: number;
              lng: number;
              accuracyMeters?: number;
            }
          | undefined;

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
                deviceTimeIso,
                gps,
              }),
            });

            const segmentSizes: number[] = [];

            for (let i = 0; i < segments.length; i += 1) {
              const pct = 10 + Math.round(((i + 1) / Math.max(segments.length, 1)) * 70);
              setUploadProgress(pct);

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
              }),
            });

            await pollReport(created.id);

            setUploadProgress(100);
            addToast("Evidence captured successfully!", "success", 2000);
            setSegments([]);
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

      return;
    }

    if (activeType === "DOCUMENT") {
      if (!asset) {
        setError("Please select a file first.");
        addToast("Please select a file first", "error");
        return;
      }

      await addToSession(asset);
      return;
    }

    setCameraOpen(true);
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

  const previewText = useMemo(() => {
    if (activeType === "VIDEO" && extendedMode) {
      return `Segments: ${segments.length} | Total ${(totalDuration / 1000 / 60).toFixed(1)} min`;
    }

    if (sessionItems.length > 0) {
      return `${sessionItems.length} item${sessionItems.length === 1 ? "" : "s"} in session`;
    }

    if (asset) {
      return "Ready to add";
    }

    return "No file selected";
  }, [activeType, asset, extendedMode, segments.length, sessionItems.length, totalDuration]);

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
            setError(null);
            setInfo(null);
          }}
        />

        {activeType === "VIDEO" ? (
          <Pressable
            style={[
              styles.captureBar,
              { backgroundColor: extendedMode ? colors.teal : colors.primaryNavy },
            ]}
            onPress={() => setExtendedMode((prev) => !prev)}
          >
            <Text style={styles.uploadText}>
              {extendedMode
                ? "Segmented mode ON (stop to add a segment)"
                : "Segmented mode OFF"}
            </Text>
          </Pressable>
        ) : null}

        {cameraOpen ? (
          <View style={styles.cameraCard}>
            <View style={styles.cameraPreviewWrap}>
              <CameraView ref={cameraRef} style={styles.cameraPreview} />

              <View style={styles.counterOverlay}>
                <Text style={styles.counterOverlayText}>
                  {sessionItems.length} item{sessionItems.length === 1 ? "" : "s"} in session
                </Text>
              </View>

              {sessionItems.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.thumbnailStrip}
                >
                  {sessionItems.map((item) => (
                    <View key={item.id} style={styles.thumbnailWrap}>
                      {item.mimeType.startsWith("image/") ? (
                        <Image source={{ uri: item.uri }} style={styles.thumbnail} />
                      ) : (
                        <View style={[styles.thumbnail, styles.thumbnailVideo]}>
                          <Text style={styles.thumbnailVideoText}>VIDEO</Text>
                        </View>
                      )}
                    </View>
                  ))}
                </ScrollView>
              ) : null}
            </View>

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
                      {
                        backgroundColor: isRecording ? "#ef4444" : colors.primaryNavy,
                      },
                    ]}
                    onPress={isRecording ? handleStopRecording : handleStartRecording}
                  >
                    <Text style={styles.uploadText}>
                      {isRecording ? "Stop & Add" : "Record & Add"}
                    </Text>
                  </Pressable>
                </>
              ) : (
                <Pressable style={styles.captureBar} onPress={handleTakePhoto}>
                  <Text style={styles.uploadText}>Capture & Add</Text>
                </Pressable>
              )}

              <Pressable
                style={[styles.captureBar, styles.secondaryBar]}
                onPress={() => setCameraOpen(false)}
              >
                <Text style={styles.secondaryText}>Done Capturing</Text>
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
              <Text style={styles.previewText}>{previewText}</Text>

              {sessionItems.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.previewThumbStrip}
                >
                  {sessionItems.map((item) => (
                    <View key={item.id} style={styles.previewThumbWrap}>
                      {item.mimeType.startsWith("image/") ? (
                        <Image source={{ uri: item.uri }} style={styles.previewThumb} />
                      ) : (
                        <View style={[styles.previewThumb, styles.thumbnailVideo]}>
                          <Text style={styles.thumbnailVideoText}>VIDEO</Text>
                        </View>
                      )}
                    </View>
                  ))}
                </ScrollView>
              ) : null}
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

            {sessionItems.length > 0 ? (
              <>
                <View style={styles.sessionCard}>
                  <Text style={[styles.sessionTitle, { fontFamily: fontFamilyBold }]}>
                    Capture Session ({sessionItems.length} item
                    {sessionItems.length !== 1 ? "s" : ""})
                  </Text>

                  {sessionItems.map((item, index) => (
                    <View key={item.id} style={styles.sessionItemRow}>
                      <View style={styles.sessionItemLeft}>
                        {item.mimeType.startsWith("image/") ? (
                          <Image source={{ uri: item.uri }} style={styles.sessionThumb} />
                        ) : (
                          <View style={[styles.sessionThumb, styles.thumbnailVideo]}>
                            <Text style={styles.thumbnailVideoText}>VIDEO</Text>
                          </View>
                        )}

                        <View style={{ flex: 1 }}>
                          <Text style={styles.sessionItemText}>
                            {index + 1}. {item.originalFilename || `Item ${index + 1}`}
                          </Text>

                          {!!item.error && <Text style={styles.sessionItemError}>{item.error}</Text>}
                        </View>
                      </View>

                      <Pressable
                        onPress={() => removeFromSession(item.id)}
                        disabled={sessionCompletingEvidence}
                      >
                        <Text style={styles.removeButton}>✕</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>

                {activeType !== "DOCUMENT" ? (
                  <Pressable
                    style={[styles.captureBar, { backgroundColor: colors.primaryNavy }]}
                    onPress={() => setCameraOpen(true)}
                    disabled={sessionCreatingEvidence || sessionCompletingEvidence}
                  >
                    <Text style={styles.uploadText}>Open Camera</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={[styles.captureBar, { backgroundColor: colors.primaryNavy }]}
                    onPress={handlePick}
                    disabled={sessionCreatingEvidence || sessionCompletingEvidence}
                  >
                    <Text style={styles.uploadText}>Add Another Document</Text>
                  </Pressable>
                )}

                <Pressable
                  style={[styles.captureBar, { backgroundColor: "#10b981" }]}
                  onPress={completeSession}
                  disabled={sessionCompletingEvidence || sessionCreatingEvidence}
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
                  disabled={busy || sessionCreatingEvidence}
                >
                  <Text style={styles.uploadText}>
                    {activeType === "DOCUMENT"
                      ? "Select & Add"
                      : activeType === "VIDEO" && extendedMode
                        ? busy
                          ? `Uploading... ${uploadProgress}%`
                          : "Upload & Sign"
                        : "Start Capture Session"}
                  </Text>
                </Pressable>

                {error ? <Text style={styles.errorText}>{error}</Text> : null}

                {showSettingsLink ? (
                  <Pressable
                    style={[styles.captureBar, styles.secondaryBar]}
                    onPress={() => Linking.openSettings()}
                  >
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
    backgroundColor: "#050b18",
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  headerTitle: {
    fontSize: typography.size.h3,
    color: "rgba(245,251,255,0.96)",
  },
  headerIcon: {
    fontSize: 18,
    color: "rgba(219,235,248,0.70)",
  },

  preview: {
    minHeight: 180,
    borderRadius: 18,
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)",
    paddingBottom: spacing.md,
  },

  previewText: {
    color: "rgba(219,235,248,0.74)",
    padding: spacing.md,
  },

  previewThumbStrip: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  previewThumbWrap: {
    borderRadius: 12,
    overflow: "hidden",
  },
  previewThumb: {
    width: 68,
    height: 68,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
  },

  cameraCard: {
    backgroundColor: "rgba(7, 20, 38, 0.92)",
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.18)",
  },
  cameraPreviewWrap: {
    position: "relative",
  },
  cameraPreview: {
    height: 420,
    width: "100%",
  },
  counterOverlay: {
    position: "absolute",
    top: 12,
    left: 12,
    backgroundColor: "rgba(5, 11, 24, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.18)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  counterOverlayText: {
    color: "rgba(245,251,255,0.94)",
    fontSize: 12,
    fontWeight: "700",
  },
  thumbnailStrip: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 12,
    paddingHorizontal: 12,
    gap: 8,
  },
  thumbnailWrap: {
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  thumbnail: {
    width: 56,
    height: 56,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  thumbnailVideo: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15,23,42,0.92)",
  },
  thumbnailVideoText: {
    color: "rgba(245,251,255,0.90)",
    fontSize: 10,
    fontWeight: "800",
  },

  cameraControls: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  timerText: {
    color: "rgba(219,235,248,0.72)",
    fontSize: 12,
    textAlign: "center",
  },
  warningText: {
    color: "rgba(245, 158, 11, 0.92)",
    fontSize: 12,
    textAlign: "center",
  },

  secondaryBar: {
    backgroundColor: "rgba(6, 13, 31, 0.52)",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)",
  },
  secondaryText: {
    color: "rgba(245,251,255,0.92)",
    fontWeight: "700",
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
    borderColor: "rgba(101,235,255,0.16)",
  },
  toggleLabel: {
    color: "rgba(245,251,255,0.90)",
    fontSize: 14,
  },

  listCard: {
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderRadius: 18,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)",
  },

  captureBar: {
    marginTop: spacing.md,
    borderRadius: 18,
    backgroundColor: "rgba(6, 13, 31, 0.62)",
    paddingVertical: spacing.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.18)",
  },
  captureCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(101,235,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.35)",
  },
  uploadText: {
    color: "rgba(245,251,255,0.92)",
    fontWeight: "700",
  },

  errorText: {
    color: "rgba(239, 68, 68, 0.95)",
    paddingHorizontal: spacing.xl,
  },
  infoText: {
    color: "rgba(219,235,248,0.80)",
    paddingHorizontal: spacing.xl,
  },

  sessionCard: {
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderRadius: 18,
    padding: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)",
  },
  sessionTitle: {
    color: "rgba(245,251,255,0.92)",
    fontSize: typography.size.h4,
    marginBottom: spacing.sm,
  },
  sessionItemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(101,235,255,0.08)",
    gap: spacing.sm,
  },
  sessionItemLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flex: 1,
  },
  sessionThumb: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
  },
  sessionItemText: {
    color: "rgba(219,235,248,0.80)",
    fontSize: 13,
    flex: 1,
  },
  sessionItemError: {
    color: "rgba(239, 68, 68, 0.95)",
    fontSize: 11,
    marginTop: 2,
  },
  removeButton: {
    color: "rgba(239, 68, 68, 0.95)",
    fontSize: 18,
    marginLeft: spacing.md,
  },
});