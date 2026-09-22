import {
  Image,
  Linking,
  Platform,
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
  ProovraSheet,
  ProovraFormField,
  ProovraInput,
} from "../../src/ui";
import { useLocale } from "../../src/locale-context";
import { useToast } from "../../src/toast-context";
import {
  CapturePlanSections,
  useIntakeTemplates,
} from "../../src/ui/capture-plan-sections";
import {
  roleForStep,
  type CollectionPlanTemplate,
  type PlannedItem,
} from "../../src/product/capture-plan";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../src/api";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Location from "expo-location";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { useFocusEffect, useRouter } from "expo-router";
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions
} from "expo-camera";
import {
  completeDirectCapture,
  openDirectCaptureSession,
  reserveDirectCaptureEvidence,
  discardDirectCaptureSession,
  uploadDirectCaptureItem,
  type DirectCaptureItemSource,
  type DirectCaptureSession,
} from "../../src/direct-capture";
import {
  openCaptureDraft,
  updateCaptureDraft,
  discardCaptureDraft,
  deriveBatchEvidenceType,
  primaryItem,
} from "../../src/capture/capture-draft";
import { usePlatformContext } from "../../src/product/platform-context";
import { formatUserDateTime } from "../../src/lib/date";
import { evidenceStatusDisplay, evidenceTypeLabel } from "../../src/product/domain-display";
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
  saveCaptureSession,
  loadCaptureSession,
  clearCaptureSession,
  isSessionResumable,
  type PersistedCaptureSession,
} from "../../src/capture/capture-session-store";
import {
  PERSONAL_SPACE_UNAVAILABLE_MESSAGE,
  PERSONAL_SPACE_UNAVAILABLE_TITLE,
  shouldBlockMobileCapture,
} from "../../src/personal-space";

// UC-0 — the former chips ("Signed at source", "Device trust verified") are
// gone: device attestation is never verified by the server, and an item is
// only preserved once the session completes.

type CaptureKind = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

const CAPTURE_TYPES: CaptureKind[] = ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"];

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
  /*
   * THE PLAN FIELDS.
   *
   * Readiness reads checklistStepId, role, privateNote, sourceLabel and the
   * location signal, and every one of them is something the operator sets. A
   * template without these on the staged items is a list of headings.
   */
  checklistStepId?: string | null;
  role?: string | null;
  privateNote?: string | null;
  itemSourceLabel?: string | null;
  locationIncluded?: boolean;
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
  const activeType = CAPTURE_TYPES[activeIndex];

  // PHASE 10 CLOSURE FIX 3 — client-hiding hint only; the server
  // independently rejects any personal-scope mutation regardless. The
  // blocked decision also depends on whether a local capture session is
  // active (see isSessionActive + shouldBlockMobileCapture below), so the
  // final `personalSpaceBlocked` is computed after that flag is known.
  const personalSpace = usePersonalSpaceAllowed();
  const platform = usePlatformContext();
  const teamId = platform.context?.activeTeamId ?? null;

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
  const [discarding, setDiscarding] = useState(false);

  // The collection plan. The catalogue is the SERVER's; nothing is seeded here.
  const templates = useIntakeTemplates();
  const [template, setTemplate] = useState<CollectionPlanTemplate | null>(null);
  const [planningItem, setPlanningItem] = useState<CapturedItem | null>(null);
  const templateRef = useRef<CollectionPlanTemplate | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  /**
   * The staged session, in the shape the plan reads.
   *
   * `useLocation` is the session-wide switch this screen already owns, so it
   * IS the location signal for every item — not a per-item guess.
   */
  useEffect(() => {
    templateRef.current = template;
  }, [template]);

  const plannedItems: PlannedItem[] = sessionItems.map((i) => ({
    checklistStepId: i.checklistStepId ?? null,
    role: i.role ?? null,
    privateNote: i.privateNote ?? null,
    sourceLabel: i.itemSourceLabel ?? null,
    locationIncluded: useLocation,
    // The device has no duplicate check at capture time, and a null here says
    // "not checked" rather than "no duplicates" — the criterion is satisfied
    // because nothing is FLAGGED, which is the same reading the web uses.
    duplicateStatus: null,
  }));

  const applyPlan = useCallback(
    (itemId: string, patch: Partial<CapturedItem>) => {
      setSessionItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, ...patch } : i)));
    },
    [],
  );
  /** The canonical /v1/capture/sessions DRAFT id — the session, before commit. */
  /*
   * WRITE-ONLY STATE, retired.
   *
   * `draftId` was set in four places and read in none: every reader goes
   * through `draftIdRef`, which is what the callbacks need. A state variable
   * nothing reads is a re-render on every draft transition for no effect, and
   * the next person to touch this file has to prove it is dead before moving
   * anything. Both the state and its four writes are gone.
   */

  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const audioStartedAtRef = useRef<number | null>(null);
  /**
   * True only between `record()` and `stop()`. Read by the blur handler so it
   * can stop the recorder WITHOUT touching the native object to ask — see the
   * lifecycle note on the blur effect below.
   */
  const recorderLiveRef = useRef(false);

  const cameraRef = useRef<CameraView | null>(null);
  const sessionEvidenceIdRef = useRef<string | null>(null);
  const captureSessionRef = useRef<DirectCaptureSession | null>(null);
  const draftIdRef = useRef<string | null>(null);
  const sessionItemsRef = useRef<CapturedItem[]>([]);
  const activeTypeRef = useRef<CaptureKind>(activeType);
  activeTypeRef.current = activeType;

  // M5 — an interrupted session recovered from durable storage awaiting the
  // operator's Resume/Discard choice (null once decided).
  const [resumable, setResumable] = useState<PersistedCaptureSession | null>(null);
  const [staleRecovered, setStaleRecovered] = useState(false);
  const [resuming, setResuming] = useState(false);

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
hasActiveDraft: isSessionActive || isRecording,
  });

  const setSessionState = useCallback((items: CapturedItem[]) => {
    sessionItemsRef.current = items;
    setSessionItems(items);
  }, []);

  /**
   * Persist the staged session in the TWO places it has to live.
   *
   * The canonical DRAFT is the durable record of the session — it survives a
   * reinstall and is what Discard deletes. But it cannot hold the local file
   * URIs, because the bytes are still only on this device; that is a genuine
   * platform concern, so the AsyncStorage record stays as the local half.
   *
   * This is not two sources of truth: the draft owns the SESSION, the local
   * record owns the on-device FILE LOCATIONS, and neither can answer the
   * other's question.
   *
   * Both writes are best-effort — a failed persist must never break live
   * capture.
   */
  const persistSession = useCallback(() => {
    const items = sessionItemsRef.current;
    const draft = draftIdRef.current;
    if (items.length === 0) return;

    if (draft) {
      void updateCaptureDraft(draft, {
        items: items.map((it) => ({
          clientItemId: it.id,
          fileName: it.originalFilename ?? `${it.id}`,
          mimeType: it.mimeType,
          sizeBytes: it.sizeBytes ?? 0,
          durationMs: it.durationMs ?? null,
          sourceLabel: it.itemSourceLabel ?? it.source,
          uploadState: it.uploaded ? "uploaded" : "pending",
          // The operator's words about what this item IS and why it was
          // taken. The canonical item schema has always accepted them; the
          // native draft was not sending them, so they were lost at unmount
          // and the readiness had nothing to read.
          role: it.role ?? null,
          privateNote: it.privateNote ?? null,
          checklistStepId: it.checklistStepId ?? null,
        })),
        // null clears a plan the operator un-chose; undefined would leave a
        // stale one recorded on the session.
        templateId: templateRef.current?.id ?? null,
      }).catch(() => undefined);
    }

    const session = captureSessionRef.current;
    void saveCaptureSession({
      captureSessionId: session?.captureSessionId ?? draft ?? "",
      expiresAtUtc: session?.expiresAtUtc ?? "",
      evidenceId: sessionEvidenceIdRef.current ?? draft ?? "",
      type: deriveBatchEvidenceType(items.map((i) => i.mimeType)),
      items: items.map((it) => ({
        id: it.id,
        uri: it.uri,
        mimeType: it.mimeType,
        partIndex: it.partIndex,
        originalFilename: it.originalFilename,
        source: it.source,
        sizeBytes: it.sizeBytes,
        durationMs: it.durationMs,
        uploaded: it.uploaded,
      })),
    });
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
    setCaptureActive(isSessionActive || isRecording);
    return () => setCaptureActive(false);
  }, [isSessionActive, isRecording]);

  useEffect(() => {
    sessionEvidenceIdRef.current = sessionEvidenceId;
  }, [sessionEvidenceId]);

  // M5 — persist on every meaningful session change (items added/removed, upload
  // state advanced). Captures the latest per-item `uploaded` flags so a resumed
  // completion never re-uploads an item already sealed at storage.
  useEffect(() => {
    if (isSessionActive) persistSession();
  }, [sessionItems, sessionEvidenceId, isSessionActive, persistSession]);

  // M5 — on mount, recover an interrupted session. Resumable → offer Resume/
  // Discard; stale/expired → auto-clear and inform (it can't be completed).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const persisted = await loadCaptureSession();
      if (!alive || !persisted) return;
      // Don't offer to resume the session that is already live on this screen.
      if (sessionEvidenceIdRef.current) return;
      if (isSessionResumable(persisted)) {
        setResumable(persisted);
      } else {
        setStaleRecovered(true);
        await clearCaptureSession();
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const resumeSession = useCallback(
    async (persisted: PersistedCaptureSession) => {
      setResuming(true);
      try {
        // A not-yet-uploaded item whose local file is gone (cache cleared) cannot
        // be resumed — drop it honestly. Already-uploaded parts live server-side,
        // so they keep their partIndex and are preserved regardless of the file.
        const kept: CapturedItem[] = [];
        for (const it of persisted.items) {
          if (!it.uploaded) {
            const info = await FileSystem.getInfoAsync(it.uri);
            if (!info.exists) continue;
          }
          kept.push({
            id: it.id,
            uri: it.uri,
            mimeType: it.mimeType,
            durationMs: it.durationMs,
            sizeBytes: it.sizeBytes,
            originalFilename: it.originalFilename,
            source: it.source as CapturedItem["source"],
            partIndex: it.partIndex, // preserve — server already knows uploaded parts
            uploadProgress: it.uploaded ? 100 : 0,
            uploading: false,
            uploaded: it.uploaded,
            error: null,
          });
        }
        const dropped = persisted.items.length - kept.length;
        captureSessionRef.current = {
          captureSessionId: persisted.captureSessionId,
          expiresAtUtc: persisted.expiresAtUtc,
        };
        sessionEvidenceIdRef.current = persisted.evidenceId;
        setSessionEvidenceId(persisted.evidenceId);
        const idx = CAPTURE_TYPES.indexOf(persisted.type);
        if (idx >= 0) setActiveIndex(idx);
        setSessionState(kept);
        setResumable(null);
        if (kept.length === 0) {
          // Nothing recoverable — clear and start fresh.
          sessionEvidenceIdRef.current = null;
          captureSessionRef.current = null;
          setSessionEvidenceId(null);
          await clearCaptureSession();
          addToast("The interrupted capture could not be recovered", "warning");
        } else if (dropped > 0) {
          addToast(`Resumed — ${dropped} item${dropped === 1 ? "" : "s"} were no longer available`, "warning");
        } else {
          addToast("Capture session resumed", "success");
        }
      } finally {
        setResuming(false);
      }
    },
    [setSessionState, addToast],
  );

  /**
   * Discarding a RECOVERED session has the same server obligation as discarding
   * a live one: the reservation it restored was made before the interruption
   * and is still open. Dropping only the durable local record would leave the
   * record stranded with nothing left that could ever reach it.
   */
  const discardRecovered = useCallback(async () => {
    const recovered = resumable;
    setResumable(null);
    if (recovered?.captureSessionId) {
      await discardDirectCaptureSession({
        captureSessionId: recovered.captureSessionId,
        expiresAtUtc: recovered.expiresAtUtc,
      }).catch(() => undefined);
    }
    await clearCaptureSession();
    addToast("Interrupted capture discarded", "info");
  }, [resumable, addToast]);

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

  /**
   * RECORDER LIFECYCLE — stop on BLUR, never on unmount.
   *
   * `useAudioRecorder` wraps `useReleasingSharedObject`, whose unmount cleanup
   * RELEASES the native shared object. React runs cleanups in declaration
   * order, so that release happens BEFORE any cleanup declared later in this
   * component. The previous version read `audioRecorder.isRecording` — a getter
   * on the native object — and called `.stop()` from an unmount cleanup, i.e.
   * after the release. That threw
   *
   *   FunctionCallException: Calling the 'get' function has failed
   *   NativeSharedObjectNotFoundException
   *
   * on EVERY exit from Capture, in every mode, not just after recording. (The
   * message names the 'get' function because `isRecording` is a getter.) A
   * synchronous native throw also means `.catch()` was never attached.
   *
   * The fix is to own the ordering rather than suppress the error: stop while
   * the screen is merely BLURRED, when the object is still alive, and let
   * unmount do nothing but release the audio mode — a module-level call that
   * touches no shared object. `recorderLiveRef` is a plain JS ref, so the blur
   * handler never has to ask the native object whether it is recording.
   */
  useFocusEffect(
    useCallback(() => {
      return () => {
        if (recorderLiveRef.current) {
          recorderLiveRef.current = false;
          try {
            void Promise.resolve(audioRecorder.stop()).catch(() => undefined);
          } catch {
            // The object may already be gone if blur and unmount coincide;
            // the recording is abandoned either way and must not crash exit.
          }
        }
        setIsRecording(false);
        void setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
        }).catch(() => undefined);
      };
    }, [audioRecorder]),
  );

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

  /**
   * Open the CANONICAL capture draft on the first staged item.
   *
   * This replaces `ensureSessionEvidence`, which opened a UC-0 direct-session
   * and RESERVED an Evidence record here — before any bytes existed. That is
   * why Discard left an orphan and why the session was locked to one media
   * type: the record's `type` was fixed by the first item.
   *
   * A `/v1/capture/sessions` DRAFT holds items and no Evidence. Nothing is
   * committed until Finalize, which is what the canonical lifecycle already
   * specified ("Finalization is initiated by the existing Evidence routes").
   */
  const ensureDraft = useCallback(async () => {
    if (draftIdRef.current) return draftIdRef.current;
    setSessionCreatingEvidence(true);
    setInfo("Starting capture session...");
    try {
      const draft = await openCaptureDraft({
        teamId,
        useLocation,
        templateId: templateRef.current?.id ?? null,
      });
      draftIdRef.current = draft.id;
      return draft.id;
    } finally {
      setSessionCreatingEvidence(false);
      setInfo(null);
    }
  }, [teamId, useLocation]);

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
        await ensureDraft();

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
    [ensureDraft, setSessionState, addToast]
  );

  const removeFromSession = useCallback(
    (itemId: string) => {
      if (sessionCompletingEvidence || isRecording) return;

      const filtered = sessionItemsRef.current
        .filter((item) => item.id !== itemId)
        .map((item, index) => ({
          ...item,
          partIndex: index
        }));

      setSessionState(filtered);

      if (filtered.length === 0) {
        // Removing the LAST staged item abandons the session just as surely as
        // pressing Discard, and the reservation is already on the server. Route
        // it through the same server transition rather than only clearing local
        // state, or this becomes a second way to strand an empty record.
        const session = captureSessionRef.current;
        const draft = draftIdRef.current;
        sessionEvidenceIdRef.current = null;
        captureSessionRef.current = null;
        draftIdRef.current = null;
        setSessionEvidenceId(null);
        if (draft) void discardCaptureDraft(draft).catch(() => undefined);
        if (session) void discardDirectCaptureSession(session).catch(() => undefined);
        void clearCaptureSession();
      } else {
        persistSession();
      }

      addToast("Item removed", "info");
    },
    [sessionCompletingEvidence, isRecording, setSessionState, addToast]
  );

  /**
   * DISCARD IS A SERVER LIFECYCLE TRANSITION, NOT A LOCAL STATE RESET.
   *
   * `ensureSessionEvidence` reserves a real Evidence record on the FIRST staged
   * item — the server runs the canonical `createEvidence()` and writes an
   * EVIDENCE_CREATED custody event before any bytes exist. This used to clear
   * refs, local state and AsyncStorage and make NO network call, so every
   * discarded capture left a permanent, custody-logged, empty record in the
   * owner's Active library. That is the "record audio → Discard → the evidence
   * is still there" defect.
   *
   * The local state is only cleared once the server has released the
   * reservation, so a failed discard leaves the session recoverable rather than
   * stranding a record nothing can reach any more.
   */
  const discardSession = useCallback(async () => {
    if (sessionCompletingEvidence || isRecording || discarding) return;
    const session = captureSessionRef.current;

    setDiscarding(true);
    setError(null);
    try {
      /*
       * Discard the canonical DRAFT. This is correct BY CONSTRUCTION: a draft
       * holds items and no Evidence, so there is nothing to release and no
       * custody chain to terminate. Staging on the canonical session is what
       * fixes the orphan-evidence defect at its root.
       *
       * The direct-session discard is still called when one exists, which
       * happens only if a FINALIZE failed part-way and left a reservation.
       */
      if (draftIdRef.current) {
        await discardCaptureDraft(draftIdRef.current);
        draftIdRef.current = null;
      }
      if (session) {
        await discardDirectCaptureSession(session);
      }
    } catch (err) {
      // Keep the session: the operator can retry the discard or finish it.
      const msg = err instanceof Error ? err.message : "Could not discard the session";
      setError(msg);
      addToast(msg, "error");
      setDiscarding(false);
      return;
    }

    sessionEvidenceIdRef.current = null;
    captureSessionRef.current = null;
    setSessionEvidenceId(null);
    setSessionState([]);
    setInfo(null);
    setUploadProgress(0);
    await clearCaptureSession(); // M5 — drop the durable record on explicit discard
    setDiscarding(false);
    addToast("Session discarded", "info");
  }, [sessionCompletingEvidence, isRecording, discarding, setSessionState, addToast]);

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


  const handleStartAudioRecording = useCallback(async () => {
    if (busy || sessionCompletingEvidence || sessionCreatingEvidence || isRecording) return;

    try {
      setError(null);
      setInfo(null);
      setShowSettingsLink(false);

      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError("Microphone permission denied");
        setShowSettingsLink(true);
        addToast("Microphone permission denied", "error");
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await audioRecorder.prepareToRecordAsync();
      audioStartedAtRef.current = Date.now();
      audioRecorder.record();
      recorderLiveRef.current = true;
      setIsRecording(true);
      addToast("Audio recording started", "info");
    } catch (err) {
      recorderLiveRef.current = false;
      audioStartedAtRef.current = null;
      setIsRecording(false);
      void setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => undefined);
      const msg = err instanceof Error ? err.message : "Failed to start audio recording";
      setError(msg);
      addToast(msg, "error");
    }
  }, [
    audioRecorder,
    busy,
    sessionCompletingEvidence,
    sessionCreatingEvidence,
    isRecording,
    addToast,
  ]);

  const handleStopAudioRecording = useCallback(async () => {
if (!isRecording || busy) return;

    try {
      setBusy(true);
      setError(null);
      setInfo("Preparing audio recording...");

      const startedAt = audioStartedAtRef.current;
      // Read the duration from the LIVE object at stop time. This used to come
      // from `useAudioRecorderState(audioRecorder, 250)`, which polled
      // `getStatus()` four times a second for the whole life of the screen in
      // EVERY capture mode, and whose interval was cleared only AFTER the
      // shared object had been released — so a queued tick could call into a
      // freed object. One read, while it is certainly alive, is all the screen
      // ever needed.
      const statusDurationMs = audioRecorder.getStatus().durationMillis;

      recorderLiveRef.current = false;

      await audioRecorder.stop();

      const uri = audioRecorder.uri;
      const durationMs =
        typeof statusDurationMs === "number" && statusDurationMs > 0
          ? Math.max(0, Math.round(statusDurationMs))
          : startedAt
            ? Math.max(0, Date.now() - startedAt)
            : undefined;

      if (!uri) {
        throw new Error("Audio recording did not produce a local file");
      }

      const fileInfo = await FileSystem.getInfoAsync(uri);

      await addCapturedItemToSession({
        uri,
        mimeType: "audio/mp4",
        durationMs,
        sizeBytes: fileInfo.exists ? fileInfo.size : undefined,
        originalFilename: getFilename(uri, `audio-${Date.now()}.m4a`),
        source: "UNKNOWN",
      });

      setInfo(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to record audio";
      setError(msg);
      addToast(msg, "error");
    } finally {
      audioStartedAtRef.current = null;
      setIsRecording(false);
      setBusy(false);
      void setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => undefined);
    }
  }, [
    audioRecorder,

    isRecording,
    busy,
    addCapturedItemToSession,
    getFilename,
    addToast,
  ]);

  /**
   * FINALIZE — the one point at which Evidence comes into existence.
   *
   * Staging produced a DRAFT and nothing else. Here the canonical acquisition
   * ingress runs once for the whole session:
   *
   *   open direct-session   → server nonce, acquisition = PROOVRA_MOBILE_APP
   *   reserve(rootType)     → ONE Evidence for the session
   *   declare + PUT each item as a PART of that record
   *   complete              → server re-hashes, compares, seals, binds
   *   close the draft       → the session records that it finalized
   *
   * One Evidence with many parts is the canonical shape — the web does exactly
   * this (`deriveBatchEvidenceType` + `POST /v1/evidence` once, remaining items
   * uploaded as parts), and `CaptureSession.finalizedEvidenceId` is unique, so
   * the model permits nothing else.
   *
   * The type is DERIVED from what was actually staged rather than fixed by the
   * first item, which is what makes a mixed-media session expressible: a
   * uniform session keeps its kind, a mixed one is DOCUMENT.
   *
   * UC-0 is used HERE and only here. It is the native ingress and sealing
   * primitive — POST /v1/evidence hardcodes PROOVRA_WEB_UPLOAD, so submitting
   * a phone capture through it would record a false provenance claim.
   */
  const completeSession = useCallback(async () => {
    if (isRecording) {
      addToast("Stop the current recording before finishing the session", "warning");
      return;
    }

    const items = sessionItemsRef.current;
    if (items.length === 0) {
      setError("No items in session");
      addToast("No items in session", "error");
      return;
    }

    setSessionCompletingEvidence(true);
    setBusy(true);
    setError(null);
    setInfo("Preserving evidence...");
    setUploadProgress(0);

    let captureSession = captureSessionRef.current;
    let evidenceId = sessionEvidenceIdRef.current;

    try {
      if (!captureSession || !evidenceId) {
        const gps = await getGps();
        const rootType = deriveBatchEvidenceType(items.map((i) => i.mimeType));
        const primary = primaryItem(items);
        captureSession = await openDirectCaptureSession();
        captureSessionRef.current = captureSession;
        evidenceId = await reserveDirectCaptureEvidence(captureSession, {
          type: rootType,
          mimeType: primary?.mimeType ?? "application/octet-stream",
          deviceTimeIso: new Date().toISOString(),
          gps,
        });
        sessionEvidenceIdRef.current = evidenceId;
        setSessionEvidenceId(evidenceId);
      }

      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];

        // M5 — a resumed item already declared + PUT to storage is skipped, so
        // completion never re-uploads it (no duplicate parts / artifacts).
        if (item.uploaded) {
          setUploadProgress(Math.round(((i + 1) / items.length) * 85));
          continue;
        }

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

      // M5 — completion confirmed: drop the durable record so it can never be
      // offered for resume again.
      // The draft has done its job; closing it records the session as
      // finalized rather than leaving an orphan DRAFT behind.
      if (draftIdRef.current) {
        await discardCaptureDraft(draftIdRef.current).catch(() => undefined);
        draftIdRef.current = null;
      }
      await clearCaptureSession();
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
  }, [addToast, pollReport, refreshRecent, router, setSessionState, isRecording]);

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
        <ProovraButton label="Back" variant="ghost" fullWidth={false} disabled={isRecording} onPress={() => router.back()} />
      </View>

      <ProovraSection title={t("capture")}>
        {resumable ? (
          <ProovraCard style={styles.resumeCard} testID="capture-resume-banner">
            <ProovraText variant="h3" weight="semibold">Resume your capture?</ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              An unfinished capture with {resumable.items.length} item{resumable.items.length === 1 ? "" : "s"} was recovered. Resume to finish it, or discard it.
            </ProovraText>
            <View style={styles.resumeActions}>
              <ProovraButton label="Resume" loading={resuming} onPress={() => void resumeSession(resumable)} />
              <ProovraButton label="Discard" variant="danger" disabled={resuming} onPress={() => void discardRecovered()} />
            </View>
          </ProovraCard>
        ) : null}
        {staleRecovered ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted} style={styles.staleNote}>
            An earlier unfinished capture expired and was cleared. Start a new capture below.
          </ProovraText>
        ) : null}
        {personalSpaceBlocked ? (
          <View testID="personal-space-blocked">
            <ProovraEmptyState title={PERSONAL_SPACE_UNAVAILABLE_TITLE} message={PERSONAL_SPACE_UNAVAILABLE_MESSAGE} />
          </View>
        ) : (
          <>
            <View style={styles.typeRow}>
              {[t("photo"), t("video"), "Audio", t("document")].map((label, index) => {
                const active = index === activeIndex;
                return (
                  <Pressable
                    key={label}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      if (isRecording) {
                        addToast("Stop the current recording before changing type", "warning");
                        return;
                      }
                      /*
                       * Switching source mid-session is now allowed.
                       *
                       * It was refused because UC-0 fixed the Evidence
                       * record's type when the FIRST item was staged, so a
                       * second kind could not be attached. Staging into the
                       * canonical draft removes that constraint: the type is
                       * derived from what was actually staged, at finalize —
                       * a uniform session keeps its kind, a mixed one is
                       * DOCUMENT, exactly as the web derives it.
                       */
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

            {/*
             * NATIVE ACQUISITION SOURCES (UC-2 / UC-3 / UC-5).
             *
             * These used to sit in Home's hero as "Direct Screen Capture" /
             * "Continuous Screen Capture" buttons, which made the landing page
             * a list of platform capabilities rather than the canonical
             * PROOVRA Home. They are SOURCES — a way of recording something —
             * so they belong beside the photo/video/audio/document chooser,
             * which is where a user decides how to capture.
             *
             * They open their own screens because each drives a protected
             * native engine (ReplayKit on iOS, MediaProjection on Android)
             * with its own permission ceremony and its own session. Making
             * them a fifth chip here would promise they behave like the other
             * four, and they do not yet — that convergence is a separate,
             * larger piece of work recorded in the ledger.
             */}
            <View style={styles.sourcesBlock}>
              <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
                Other capture sources
              </ProovraText>
              {Platform.OS === "android" ? (
                <>
                  <ProovraButton
                    label="Screen capture"
                    variant="secondary"
                    disabled={isSessionActive || isRecording}
                    onPress={() => router.push("/screen-capture")}
                  />
                  <ProovraButton
                    label="Continuous screen capture"
                    variant="secondary"
                    disabled={isSessionActive || isRecording}
                    onPress={() => router.push("/continuous-capture")}
                  />
                </>
              ) : (
                <ProovraButton
                  label="Screen capture"
                  variant="secondary"
                  disabled={isSessionActive || isRecording}
                  onPress={() => router.push("/continuous-capture")}
                />
              )}
              {isSessionActive || isRecording ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  Finish or discard the current session to use another source.
                </ProovraText>
              ) : null}
            </View>
            </View>

            {activeType === "AUDIO" ? (
              <ProovraCard style={styles.audioCard}>
                <ProovraText variant="h3" weight="semibold">Microphone Capture</ProovraText>
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                  {isRecording
                    ? `Recording ${recordSeconds}s`
                    : "Record audio evidence with this device microphone. The recording is added to the current evidence session after you stop it."}
                </ProovraText>
                <ProovraButton
                  label={isRecording ? "Stop Audio Recording" : "Start Audio Recording"}
                  variant={isRecording ? "danger" : "primary"}
loading={busy}
disabled={sessionCompletingEvidence || sessionCreatingEvidence || busy}
                  onPress={isRecording ? handleStopAudioRecording : handleStartAudioRecording}
                />
              </ProovraCard>
            ) : cameraOpen && activeType !== "DOCUMENT" ? (
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
              <CapturePlanSections
                items={plannedItems}
                templates={templates}
                template={template}
                onSelectTemplate={setTemplate}
              />
            ) : null}

            {sessionItems.length > 0 ? (
              <ProovraCard style={styles.sessionCard}>
                <ProovraText variant="h3" weight="semibold">Capture Session</ProovraText>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbStrip}>
                  {sessionItems.map((item, index) => {
                    const isImage = item.mimeType.startsWith("image/");
                    const isVideo = item.mimeType.startsWith("video/");
                    const isAudio = item.mimeType.startsWith("audio/");
                    return (
                      <View key={item.id} style={styles.thumbCard}>
                        <View style={styles.thumbPreview}>
                          {isImage ? (
                            <Image source={{ uri: item.uri }} style={styles.thumbImage} />
                          ) : (
                            <View style={styles.thumbFallback}><Text style={styles.thumbFallbackText}>{isVideo ? "VIDEO" : isAudio ? "AUDIO" : "DOC"}</Text></View>
                          )}
                          <View style={styles.thumbIndexBadge}><Text style={styles.thumbIndexText}>{index + 1}</Text></View>
                        </View>
                        <ProovraText variant="label" numberOfLines={1} style={styles.thumbLabel}>{item.originalFilename || `Item ${index + 1}`}</ProovraText>
                        <ProovraText variant="label" color={theme.color.ink.muted}>{item.uploading ? `${item.uploadProgress}%` : item.uploaded ? "Uploaded" : "Ready"}</ProovraText>
                        {/*
                          What this item IS, and why it was captured. The plan
                          reads both; without them a template is headings.
                        */}
                        <ProovraText variant="label" color={theme.color.ink.muted} numberOfLines={1}>
                          {item.role ?? "No role set"}
                        </ProovraText>
                        <Pressable
                          onPress={() => {
                            setNoteDraft(item.privateNote ?? "");
                            setPlanningItem(item);
                          }}
                          disabled={sessionCompletingEvidence || isRecording}
                          style={styles.removePill}
                        >
                          <Text style={styles.removePillText}>Describe</Text>
                        </Pressable>
                        <Pressable onPress={() => removeFromSession(item.id)} disabled={sessionCompletingEvidence || isRecording} style={styles.removePill}>
                          <Text style={styles.removePillText}>Remove</Text>
                        </Pressable>
                      </View>
                    );
                  })}
                </ScrollView>
                <View style={styles.sessionActions}>
                  {activeType === "DOCUMENT" ? (
                    <ProovraButton label="Add Another Document" variant="secondary" disabled={sessionCompletingEvidence || isRecording} onPress={openPickerOrCamera} />
                  ) : activeType === "AUDIO" ? (
                    <ProovraButton
                      label="Record Another Audio"
                      variant="secondary"
                      disabled={sessionCompletingEvidence || sessionCreatingEvidence || isRecording || busy}
                      onPress={handleStartAudioRecording}
                    />
                  ) : !cameraOpen ? (
                    <ProovraButton
                      label={activeType === "PHOTO" ? "Open Camera for More Photos" : "Open Camera for More Videos"}
                      variant="secondary"
                      disabled={sessionCompletingEvidence || isRecording}
                      onPress={openPickerOrCamera}
                    />
                  ) : null}
                  <ProovraButton
                    label={sessionCompletingEvidence ? `Finishing… ${uploadProgress}%` : `Finish & Sign (${sessionItems.length})`}
                    loading={sessionCompletingEvidence}
                    disabled={sessionCreatingEvidence || isRecording}
                    onPress={completeSession}
                  />
                  <ProovraButton label={discarding ? "Discarding…" : "Discard Session"} variant="danger" disabled={sessionCompletingEvidence || isRecording || discarding} onPress={() => void discardSession()} />
                </View>
              </ProovraCard>
            ) : null}

            <ProovraSheet
              visible={planningItem !== null}
              title={planningItem?.originalFilename ?? "This item"}
              onClose={() => setPlanningItem(null)}
            >
              {template && template.steps.length > 0 ? (
                <>
                  <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
                    What is this item?
                  </ProovraText>
                  {template.steps.map((step) => (
                    <ProovraListRow
                      key={step.id}
                      title={step.title}
                      subtitle={step.description || undefined}
                      onPress={() => {
                        if (!planningItem) return;
                        // The ROLE string is what readiness reads first: a
                        // template whose step ids do not follow primary_*
                        // would otherwise never satisfy the criterion.
                        applyPlan(planningItem.id, {
                          checklistStepId: step.id,
                          role: roleForStep(step),
                        });
                        setPlanningItem((cur) =>
                          cur ? { ...cur, checklistStepId: step.id, role: roleForStep(step) } : cur,
                        );
                      }}
                      trailing={
                        planningItem?.checklistStepId === step.id ? (
                          <ProovraBadge label="Chosen" tone="verified" />
                        ) : undefined
                      }
                    />
                  ))}
                </>
              ) : (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  Choose a collection plan to give items a role.
                </ProovraText>
              )}

              <ProovraFormField label="Context note">
                <ProovraInput
                  value={noteDraft}
                  onChangeText={setNoteDraft}
                  placeholder="Why this was captured, in your words"
                  autoCapitalize="sentences"
                  multiline
                  accessibilityLabel="Context note"
                />
              </ProovraFormField>
              <ProovraButton
                label="Save"
                onPress={() => {
                  if (planningItem) {
                    applyPlan(planningItem.id, { privateNote: noteDraft.trim() || null });
                  }
                  setPlanningItem(null);
                }}
              />
            </ProovraSheet>

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
            {recent.map((item) => {
              const status = evidenceStatusDisplay(item.status);
              return (
                <ProovraListRow
                  key={item.id}
                  title={evidenceTypeLabel(item.type)}
                  subtitle={formatUserDateTime(item.createdAt)}
                  trailing={<ProovraBadge tone={status.tone} label={status.label} />}
                />
              );
            })}
          </ProovraCard>
        )}
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  resumeCard: { gap: theme.space.s2, marginBottom: theme.space.s3, borderColor: theme.color.accent.a500 },
  resumeActions: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s2 },
  staleNote: { marginBottom: theme.space.s3 },
  typeRow: { flexDirection: "row", gap: theme.space.s2, marginBottom: theme.space.s3 },
  sourcesBlock: { gap: theme.space.s2, marginTop: theme.space.s3, paddingTop: theme.space.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.subtle },
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
  audioCard: { gap: theme.space.s2, marginBottom: theme.space.s3 },
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
