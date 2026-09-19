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
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraEmptyState,
} from "../../src/ui";
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
import {
  completeDirectCapture,
  openDirectCaptureSession,
  reserveDirectCaptureEvidence,
  uploadDirectCaptureItem,
  type DirectCaptureItemSource,
  type DirectCaptureSession,
} from "../../src/direct-capture";
import { formatUserDateTime } from "../../src/lib/date";
// UC-0 — every item goes through ONE server-issued direct-capture session
// (src/direct-capture.ts): the record is reserved by the session, each file's
// digest is declared to it, the bytes go to storage, and the server re-hashes
// and seals. The former second, base64 "trust ingest" upload is gone.
// PHASE 10 CLOSURE FIX 3 (2026-07-23) — no-Personal client gate. The
// citizen-capture app has no workspace switcher/alternative target, so a
// disallowed Personal Space blocks capture outright (never a silent
// Personal fallback) with a bounded explanation.
import { usePersonalSpaceAllowed } from "../../src/usePersonalSpaceAllowed";
import { setCaptureActive } from "../../src/capture/active-capture";
import {
  PERSONAL_SPACE_UNAVAILABLE_MESSAGE,
  PERSONAL_SPACE_UNAVAILABLE_TITLE,
  shouldBlockMobileCapture,
} from "../../src/personal-space";

// UC-0 — the former chips ("Signed at source", "Device trust verified") are
// gone: device attestation is never verified by the server, and an item is
// only preserved once the session completes.

type CaptureKind = "PHOTO" | "VIDEO" | "DOCUMENT";

type CapturedItem = {
  id: string;
  uri: string;
  mimeType: string;
  durationMs?: number;
  sizeBytes?: number;
  originalFilename?: string;
  partIndex: number;
  /** Where the app took the item from — client-reported, recorded as such. */
  source: DirectCaptureItemSource;
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
  const { t } = useLocale();
  const { addToast } = useToast();
  const router = useRouter();

  const [activeIndex, setActiveIndex] = useState(0);
  const typeMap: CaptureKind[] = ["PHOTO", "VIDEO", "DOCUMENT"];
  const activeType = typeMap[activeIndex];

  // PHASE 10 CLOSURE FIX 3 — client-hiding hint only; the server
  // independently rejects any personal-scope mutation regardless. The
  // blocked decision also depends on whether a local capture session is
  // active (see isSessionActive + shouldBlockMobileCapture below), so the
  // final `personalSpaceBlocked` is computed after that flag is known.
  const personalSpace = usePersonalSpaceAllowed();

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
  const captureSessionRef = useRef<DirectCaptureSession | null>(null);
  const sessionItemsRef = useRef<CapturedItem[]>([]);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const isSessionActive = Boolean(sessionEvidenceId) || sessionItems.length > 0;

  // PHASE 10 CLOSURE FIX 3 — behavior E. Only block a FRESH capture surface;
  // never yank an in-progress local draft off the screen when the policy
  // flips to disallowed mid-session (the operator keeps their staged items
  // to finish or discard; the server independently blocks a disallowed
  // finalize). No workspace switch exists on mobile, so there is nothing to
  // silently switch to.
  const personalSpaceBlocked = shouldBlockMobileCapture({
    loading: personalSpace.loading,
    allowed: personalSpace.allowed,
    hasActiveDraft: isSessionActive,
  });

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

  // Report a live capture session so the deep-link gate can block unsafe
  // context switches during capture (canonical durability signal).
  useEffect(() => {
    setCaptureActive(isSessionActive);
    return () => setCaptureActive(false);
  }, [isSessionActive]);

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

      // UC-0 — the server issues the session, then reserves the record for
      // it; the record's acquisition is the session's (PROOVRA mobile app).
      try {
        const session = await openDirectCaptureSession();
        captureSessionRef.current = session;
        const createdId = await reserveDirectCaptureEvidence(session, {
          type: activeType,
          mimeType: firstMimeType,
          deviceTimeIso: new Date().toISOString(),
          gps
        });
        sessionEvidenceIdRef.current = createdId;
        setSessionEvidenceId(createdId);
        setSessionCreatingEvidence(false);
        setInfo(null);
        return createdId;
      } catch (err) {
        captureSessionRef.current = null;
        throw err;
      }
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
      source: DirectCaptureItemSource;
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
          source: input.source,
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
        captureSessionRef.current = null;
        setSessionEvidenceId(null);
      }

      addToast("Item removed", "info");
    },
    [sessionCompletingEvidence, setSessionState, addToast]
  );

  const discardSession = useCallback(() => {
    if (sessionCompletingEvidence) return;
    sessionEvidenceIdRef.current = null;
    captureSessionRef.current = null;
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
          originalFilename: file.name ?? getFilename(file.uri, `document-${Date.now()}`),
          source: "FILE_PICKER"
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
        originalFilename: getFilename(result.uri, `photo-${Date.now()}.jpg`),
        source: "CAMERA"
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
          originalFilename: getFilename(recordResult.uri, `video-${Date.now()}.mp4`),
          source: "CAMERA"
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
    const captureSession = captureSessionRef.current;
    const items = sessionItemsRef.current;

    if (!evidenceId || !captureSession || items.length === 0) {
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

        setSessionState(
          sessionItemsRef.current.map((current) =>
            current.id === item.id
              ? { ...current, uploading: true, uploadProgress: 10 }
              : current
          )
        );

        // Declare the digest to the session, then upload the bytes through
        // the canonical part presign (never as JSON).
        await uploadDirectCaptureItem(captureSession, evidenceId, {
          partIndex: item.partIndex,
          uri: item.uri,
          mimeType: item.mimeType,
          durationMs: item.durationMs,
          originalFilename: item.originalFilename,
          source: item.source
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

      // The server re-hashes every stored item, compares each with its
      // declared digest, and only then signs and binds the session.
      await completeDirectCapture(captureSession);

      setUploadProgress(96);
      await pollReport(evidenceId);
      setUploadProgress(100);

      addToast("Evidence created successfully", "success", 2000);

      sessionEvidenceIdRef.current = null;
      captureSessionRef.current = null;
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
    <ProovraScreen>
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>

      <ProovraSection title={t("capture")}>
        {personalSpaceBlocked ? (
          <View testID="personal-space-blocked">
            <ProovraEmptyState title={PERSONAL_SPACE_UNAVAILABLE_TITLE} message={PERSONAL_SPACE_UNAVAILABLE_MESSAGE} />
          </View>
        ) : (
          <>
            <View style={styles.typeRow}>
              {[t("photo"), t("video"), t("document")].map((label, index) => {
                const active = index === activeIndex;
                return (
                  <Pressable
                    key={label}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
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
                    style={[styles.typeChip, { borderColor: active ? theme.color.accent.a500 : theme.color.border.default, backgroundColor: active ? theme.color.accent.a050 : theme.color.surface.card }]}
                  >
                    <ProovraText variant="label" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.secondary}>{label}</ProovraText>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.toggleRow}>
              <ProovraText variant="body">Include location metadata</ProovraText>
              <Switch value={useLocation} onValueChange={setUseLocation} accessibilityLabel="Include location metadata" />
            </View>

            {cameraOpen && activeType !== "DOCUMENT" ? (
              <ProovraCard style={styles.cameraCard}>
                <View>
                  <CameraView ref={cameraRef} style={styles.cameraPreview} />
                  <View style={styles.overlayTopLeft}><Text style={styles.overlayBadge}>Auto-add mode</Text></View>
                  <View style={styles.overlayTopRight}><Text style={styles.counterBadge}>{sessionItems.length}</Text></View>
                </View>
                <View style={styles.cameraControls}>
                  {activeType === "PHOTO" ? (
                    <>
                      <ProovraText variant="label" color={theme.color.ink.muted} center>Take photos continuously. Each shot is added automatically.</ProovraText>
                      <ProovraButton label="Capture Photo" loading={busy || sessionCreatingEvidence} disabled={sessionCompletingEvidence} onPress={handleTakePhoto} />
                    </>
                  ) : (
                    <>
                      <ProovraText variant="label" color={theme.color.ink.muted} center>{isRecording ? `Recording ${recordSeconds}s` : "Record video. It will be auto-added to the session."}</ProovraText>
                      <ProovraButton label={isRecording ? "Stop Recording" : "Start Recording"} variant={isRecording ? "danger" : "primary"} disabled={busy || sessionCompletingEvidence || sessionCreatingEvidence} onPress={isRecording ? handleStopRecording : handleStartRecording} />
                    </>
                  )}
                  <ProovraButton label="Close Camera" variant="ghost" disabled={isRecording} onPress={() => setCameraOpen(false)} />
                </View>
              </ProovraCard>
            ) : (
              <ProovraButton label={activeType === "DOCUMENT" ? "Pick Document" : "Open Camera"} onPress={openPickerOrCamera} />
            )}

            <ProovraText variant="bodySm" color={theme.color.ink.secondary} style={styles.previewLine}>
              {isSessionActive
                ? `Session active • ${sessionCountLabel}${totalDurationText ? ` • ${totalDurationText}` : ""}`
                : "No active capture session"}
            </ProovraText>

            {sessionItems.length > 0 ? (
              <ProovraCard style={styles.sessionCard}>
                <ProovraText variant="h3" weight="semibold">Capture Session</ProovraText>
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
                            <View style={styles.thumbFallback}><Text style={styles.thumbFallbackText}>{isVideo ? "VIDEO" : "DOC"}</Text></View>
                          )}
                          <View style={styles.thumbIndexBadge}><Text style={styles.thumbIndexText}>{index + 1}</Text></View>
                        </View>
                        <ProovraText variant="label" numberOfLines={1} style={styles.thumbLabel}>{item.originalFilename || `Item ${index + 1}`}</ProovraText>
                        <ProovraText variant="label" color={theme.color.ink.muted}>{item.uploading ? `${item.uploadProgress}%` : item.uploaded ? "Uploaded" : "Ready"}</ProovraText>
                        <Pressable onPress={() => removeFromSession(item.id)} disabled={sessionCompletingEvidence} style={styles.removePill}>
                          <Text style={styles.removePillText}>Remove</Text>
                        </Pressable>
                      </View>
                    );
                  })}
                </ScrollView>
                <View style={styles.sessionActions}>
                  {activeType === "DOCUMENT" ? (
                    <ProovraButton label="Add Another Document" variant="secondary" disabled={sessionCompletingEvidence} onPress={openPickerOrCamera} />
                  ) : !cameraOpen ? (
                    <ProovraButton
                      label={activeType === "PHOTO" ? "Open Camera for More Photos" : "Open Camera for More Videos"}
                      variant="secondary"
                      disabled={sessionCompletingEvidence}
                      onPress={openPickerOrCamera}
                    />
                  ) : null}
                  <ProovraButton
                    label={sessionCompletingEvidence ? `Finishing… ${uploadProgress}%` : `Finish & Sign (${sessionItems.length})`}
                    loading={sessionCompletingEvidence}
                    disabled={sessionCreatingEvidence}
                    onPress={completeSession}
                  />
                  <ProovraButton label="Discard Session" variant="danger" disabled={sessionCompletingEvidence} onPress={discardSession} />
                </View>
              </ProovraCard>
            ) : null}

            {error ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{error}</ProovraText> : null}
            {info ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{info}</ProovraText> : null}
            {showSettingsLink ? <ProovraButton label="Open Settings" variant="secondary" onPress={() => Linking.openSettings()} /> : null}
          </>
        )}
      </ProovraSection>

      <ProovraSection title={t("recentEvidence")}>
        {recent.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>No evidence yet.</ProovraText>
        ) : (
          <ProovraCard>
            {recent.map((item) => (
              <ProovraListRow
                key={item.id}
                title={item.type}
                subtitle={formatUserDateTime(item.createdAt)}
                trailing={
                  <ProovraBadge
                    tone={item.status === "SIGNED" ? "verified" : item.status === "PROCESSING" ? "pending" : "neutral"}
                    label={item.status === "SIGNED" ? t("statusSigned") : item.status === "PROCESSING" ? t("statusProcessing") : t("statusReady")}
                  />
                }
              />
            ))}
          </ProovraCard>
        )}
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  typeRow: { flexDirection: "row", gap: theme.space.s2, marginBottom: theme.space.s3 },
  typeChip: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 40, borderRadius: theme.radius.pill, borderWidth: 1 },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.color.surface.card,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    paddingHorizontal: theme.space.s3,
    paddingVertical: theme.space.s3,
    marginBottom: theme.space.s3,
  },
  cameraCard: { padding: 0, overflow: "hidden", marginBottom: theme.space.s3 },
  cameraPreview: { height: 380, width: "100%" },
  overlayTopLeft: { position: "absolute", top: 12, left: 12 },
  overlayTopRight: { position: "absolute", top: 12, right: 12 },
  overlayBadge: { backgroundColor: "rgba(15,23,42,0.78)", color: "#FFFFFF", paddingHorizontal: 10, paddingVertical: 6, borderRadius: theme.radius.pill, fontSize: 12, fontWeight: "700", overflow: "hidden" },
  counterBadge: { minWidth: 34, height: 34, borderRadius: 17, backgroundColor: theme.color.semantic.success, color: "#FFFFFF", textAlign: "center", fontSize: 14, fontWeight: "800", overflow: "hidden", paddingTop: 7 },
  cameraControls: { padding: theme.space.s3, gap: theme.space.s2 },
  previewLine: { marginBottom: theme.space.s3 },
  sessionCard: { gap: theme.space.s2, marginBottom: theme.space.s3 },
  thumbStrip: { gap: 12, paddingVertical: 8 },
  thumbCard: { width: 120, backgroundColor: theme.color.surface.muted, borderRadius: theme.radius.md, padding: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.border.subtle },
  thumbPreview: { width: "100%", height: 90, borderRadius: theme.radius.sm, overflow: "hidden", backgroundColor: theme.color.surface.muted, position: "relative" },
  thumbImage: { width: "100%", height: "100%" },
  thumbFallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  thumbFallbackText: { color: theme.color.ink.secondary, fontWeight: "800", fontSize: 12 },
  thumbIndexBadge: { position: "absolute", top: 6, right: 6, backgroundColor: "rgba(15,23,42,0.82)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: theme.radius.pill },
  thumbIndexText: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" },
  thumbLabel: { marginTop: 8 },
  removePill: { marginTop: 8, backgroundColor: theme.color.status.risk.solid, paddingVertical: 6, borderRadius: theme.radius.pill, alignItems: "center" },
  removePillText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  sessionActions: { marginTop: 8, gap: theme.space.s2 },
});