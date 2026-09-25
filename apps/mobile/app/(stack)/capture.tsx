import {
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View
} from "react-native";
import { theme } from "../../src/theme/theme";
import { toSafeUserError } from "../../src/errors/safe-error";
import {
  mixedOriginPrompt,
  resolveDraftAcquisition,
  wouldMixOrigins,
  type MixedOriginPrompt,
} from "../../src/capture/screen-acquisition";
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
  ProovraConfirmSheet,
} from "../../src/ui";
import { useLocale } from "../../src/locale-context";
import { useToast } from "../../src/toast-context";
import {
  CaptureIntakeRail,
  CaptureReadinessPanel,
  CaptureSuggestionsPanel,
  useIntakeTemplates,
} from "../../src/ui/capture-plan-sections";
import { CaptureIntakeStructure, CaptureRequirements } from "../../src/ui/capture-requirements";
import { CaptureHero } from "../../src/ui/capture-intro";
import { CaptureDraftReattachNotice, CaptureDraftsBanner } from "../../src/ui/capture-drafts";
import {
  CaptureFinalReadiness,
  CaptureFinishHeading,
  CaptureMaterialsBoard,
  CaptureOperationalSummary,
  type DraftSaveState,
} from "../../src/ui/capture-materials";
import { CaptureAiReview } from "../../src/ui/capture-ai-review";
import { CaptureSessionStatus } from "../../src/ui/capture-session-status";
import { CaptureActivityDisclosure } from "../../src/ui/capture-activity";
import {
  appendCaptureActivity,
  FINALIZATION_STARTED,
  LOCATION_RECORDED,
  LOCATION_UNAVAILABLE,
  removedActivity,
  stagedActivity,
  type CaptureActivityEvent,
  type CaptureActivityInput,
} from "../../src/product/capture-activity";
import {
  DEFAULT_TEMPLATE_ID,
  assignRequiredStep,
  buildSessionReadiness,
  computeCaptureReadiness,
  formatCaptureSessionId,
  type CapturePlanMode,
  type CollectionPlanTemplate,
  type PlannedItem,
} from "../../src/product/capture-plan";
import { useCallback, useEffect, useRef, useState } from "react";
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
  completeAcquisition,
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
  listCaptureDrafts,
  primaryItem,
  readCaptureDraft,
  type CaptureDraftDetail,
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
import type { ScreenAcquisitionMode } from "../../src/capture/screen-acquisition";
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
  /**
   * The operator's "Source (optional)" words (web capture/page.tsx:1332),
   * sent as EvidencePart.sourceLabel at finalize. Distinct from
   * `itemSourceLabel`, which carries the acquisition ORIGIN the mixed-origin
   * guard reads — free text there would defeat that guard.
   */
  sourceNote?: string | null;
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
  const templateRef = useRef<CollectionPlanTemplate | null>(null);
  /** The operator chose (or un-chose) a plan, or a resume named one: no default applies. */
  const planChosenRef = useRef(false);
  /** A plan id a resumed draft named, applied once the catalogue has loaded. */
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  // Web "Intake structure": Guided (CHECKLIST_REQUIRED) or Flexible.
  const [planMode, setPlanMode] = useState<CapturePlanMode>("FLEXIBLE");
  const planModeRef = useRef<CapturePlanMode>("FLEXIBLE");
  planModeRef.current = planMode;
  const useLocationRef = useRef(false);
  useLocationRef.current = useLocation;
  const [locationDenied, setLocationDenied] = useState(false);
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>("idle");
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  // Web "Unfinished capture sessions" (useCaptureDraftList): the server DRAFTs.
  const [serverDrafts, setServerDrafts] = useState<CaptureDraftDetail[]>([]);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);
  const [resumedDraft, setResumedDraft] = useState<CaptureDraftDetail | null>(null);
  const [reattachDismissed, setReattachDismissed] = useState(false);

  const selectTemplate = useCallback((t: CollectionPlanTemplate | null) => {
    planChosenRef.current = true;
    setTemplate(t);
  }, []);

  // The web opens on its canonical default plan (general-evidence-record) and
  // always has one; the default applies only until the operator chooses.
  useEffect(() => {
    if (!templates) return;
    if (pendingTemplateId) {
      setTemplate(templates.find((t) => t.id === pendingTemplateId) ?? null);
      setPendingTemplateId(null);
      return;
    }
    if (planChosenRef.current) return;
    const fallback = templates.find((t) => t.id === DEFAULT_TEMPLATE_ID);
    if (fallback) setTemplate(fallback);
  }, [templates, pendingTemplateId]);

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

  // T-14 — the web session readiness; its blockers gate Finish exactly as the web's finishDisabled.
  const sessionReadiness = buildSessionReadiness({
    items: sessionItems.map((i) => ({ id: i.id, mimeType: i.mimeType, checklistStepId: i.checklistStepId ?? null })),
    plan: template,
    useLocation,
    planMode,
  });
  const captureReadiness = computeCaptureReadiness(plannedItems);
  const stepItemCounts: Record<string, number> = {};
  for (const i of sessionItems) {
    if (i.checklistStepId) stepItemCounts[i.checklistStepId] = (stepItemCounts[i.checklistStepId] ?? 0) + 1;
  }
  // A plan change drops mappings to steps the new plan does not have (web capture/page.tsx:296).
  useEffect(() => {
    const valid = new Set(template?.steps.map((s) => s.id) ?? []);
    const cur = sessionItemsRef.current;
    if (cur.some((i) => i.checklistStepId && !valid.has(i.checklistStepId))) {
      const next = cur.map((i) => (i.checklistStepId && !valid.has(i.checklistStepId) ? { ...i, checklistStepId: null } : i));
      sessionItemsRef.current = next;
      setSessionItems(next);
    }
  }, [template]);
  // The web labels a session by the local date it started; it starts with the first staged item.
  const [sessionStartedAt, setSessionStartedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (sessionItems.length === 0) setSessionStartedAt(null);
    else setSessionStartedAt((prev) => prev ?? new Date());
  }, [sessionItems.length]);
  // T-14 — the session's local activity log (web CaptureActivityDisclosure). A new session starts a new log.
  const [activity, setActivity] = useState<CaptureActivityEvent[]>([]);
  const recordActivity = useCallback((input: CaptureActivityInput) => setActivity((prev) => appendCaptureActivity(prev, input)), []);
  useEffect(() => {
    if (sessionItems.length === 0) setActivity([]);
  }, [sessionItems.length]);

  /*
   * Through the REF as well as state. `persistSession` and Finish both read
   * `sessionItemsRef`; updating only state meant a role, note or mapping set
   * here never reached the draft PATCH or the part created at finalize.
   */
  const applyPlan = useCallback(
    (itemId: string, patch: Partial<CapturedItem>) => {
      const next = sessionItemsRef.current.map((i) => (i.id === itemId ? { ...i, ...patch } : i));
      sessionItemsRef.current = next;
      setSessionItems(next);
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
  /**
   * What acquired the live session, when a screen engine did.
   *
   * Null for an ordinary phone capture. It decides which completion route
   * Finish & Sign calls, and it arrives either from the screen surface that
   * staged the session or from the durable record on resume — never from a
   * guess about the items.
   */
  const acquisitionRef = useRef<{ mode: ScreenAcquisitionMode; manifestJson: string } | null>(null);
  /**
   * The explanation shown when two acquisition origins meet in one draft.
   *
   * Held in state rather than thrown, because the answer is a product
   * statement with an action, not a failure: nothing has gone wrong, and
   * nothing staged is lost.
   */
  const [mixedOrigin, setMixedOrigin] = useState<MixedOriginPrompt | null>(null);
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
      setDraftSaveState("saving");
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
        planMode: planModeRef.current,
        useLocation: useLocationRef.current,
      })
        .then(() => setDraftSaveState("saved"))
        .catch(() => setDraftSaveState("error"));
    }

    const session = captureSessionRef.current;
    void saveCaptureSession({
      captureSessionId: session?.captureSessionId ?? draft ?? "",
      expiresAtUtc: session?.expiresAtUtc ?? "",
      evidenceId: sessionEvidenceIdRef.current ?? draft ?? "",
      draftId: draft,
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
  // The plan, mode and location choice are draft metadata too (web scheduleSave).
  useEffect(() => {
    if (isSessionActive) persistSession();
  }, [sessionItems, sessionEvidenceId, isSessionActive, persistSession, template, planMode, useLocation]);

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
        /*
         * A session that never reached finalize has NO direct session and NO
         * reservation: the local record stores the DRAFT id in both slots
         * (persistSession: `session?.captureSessionId ?? draft`). Restoring
         * that id as a direct session made Finish skip open + reserve and
         * declare parts against an id the acquisition routes do not know.
         */
        const draftOnly = persisted.captureSessionId === persisted.evidenceId;
        const draftId = persisted.draftId ?? (draftOnly ? persisted.captureSessionId : null);
        draftIdRef.current = draftId;
        if (draftId) {
          // The draft holds what the local record does not: the plan, the
          // mode, the location choice and each item's role, note and mapping.
          const detail = await readCaptureDraft(draftId);
          if (detail && detail.status === "DRAFT") {
            planChosenRef.current = true;
            setPendingTemplateId(detail.templateId);
            if (detail.planMode) setPlanMode(detail.planMode);
            setUseLocation(detail.useLocation);
            const byId = new Map(detail.items.map((i) => [i.clientItemId, i]));
            for (let k = 0; k < kept.length; k += 1) {
              const snap = byId.get(kept[k].id);
              if (snap) kept[k] = { ...kept[k], checklistStepId: snap.checklistStepId, role: snap.role, privateNote: snap.privateNote };
            }
          }
        }
        captureSessionRef.current = draftOnly
          ? null
          : { captureSessionId: persisted.captureSessionId, expiresAtUtc: persisted.expiresAtUtc };
        sessionEvidenceIdRef.current = draftOnly ? null : persisted.evidenceId;
        // A resumed screen acquisition must seal through ITS route. Without
        // this a continuous recording resumed after a restart would complete
        // as a frame capture and lose the completeness that says whether it
        // was interrupted.
        acquisitionRef.current = persisted.acquisition ?? null;
        setSessionEvidenceId(sessionEvidenceIdRef.current);
        const idx = CAPTURE_TYPES.indexOf(persisted.type);
        if (idx >= 0) setActiveIndex(idx);
        setSessionState(kept);
        setResumable(null);
        if (kept.length === 0) {
          // Nothing recoverable — clear and start fresh.
          sessionEvidenceIdRef.current = null;
          captureSessionRef.current = null;
          acquisitionRef.current = null;
          draftIdRef.current = null;
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

  // The operator's unfinished DRAFTs on the server (web useCaptureDraftList). A read.
  const refreshDrafts = useCallback(async () => {
    try {
      setServerDrafts(await listCaptureDrafts());
    } catch {
      setServerDrafts([]);
    }
  }, []);
  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);

  /**
   * RESUME A SERVER DRAFT — apply everything it persists, then say what is left.
   *
   * The web resume (capture/page.tsx:338-375): template, plan mode, location.
   * The bytes never left the device that staged them, so the files themselves
   * have to be added again; the re-attach notice lists them by name and
   * mapping. This session ADOPTS the draft, so staging updates it and Finish
   * closes it, instead of opening a second draft beside it.
   */
  const resumeServerDraft = useCallback(
    async (draft: CaptureDraftDetail) => {
      setDraftBusyId(draft.id);
      try {
        const detail = await readCaptureDraft(draft.id);
        if (!detail || detail.status !== "DRAFT") {
          addToast("Draft could not be restored.", "error");
          return;
        }
        planChosenRef.current = true;
        setPendingTemplateId(detail.templateId);
        if (detail.planMode) setPlanMode(detail.planMode);
        setUseLocation(detail.useLocation);
        draftIdRef.current = detail.id;
        setResumedDraft(detail);
        setReattachDismissed(false);
        setDraftsOpen(false);
        const pending = detail.items.length;
        addToast(
          pending > 0 ? `Draft restored. Re-attach ${pending} file${pending === 1 ? "" : "s"} before Review & Sign.` : "Draft restored.",
          "success",
        );
      } finally {
        setDraftBusyId(null);
      }
    },
    [addToast],
  );

  const deleteServerDraft = useCallback(
    async (draft: CaptureDraftDetail) => {
      setDraftBusyId(draft.id);
      try {
        await discardCaptureDraft(draft.id);
        if (draftIdRef.current === draft.id) {
          draftIdRef.current = null;
          setResumedDraft(null);
        }
        setServerDrafts((prev) => prev.filter((d) => d.id !== draft.id));
      } catch (err) {
        addToast(toSafeUserError(err, { message: "The draft could not be deleted." }).message, "error");
      } finally {
        setDraftBusyId(null);
      }
    },
    [addToast],
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
    // A session that never reached finalize holds only a DRAFT (both slots
    // carry its id); discarding it is a draft transition, not a direct one.
    const draftOnly = !!recovered && recovered.captureSessionId === recovered.evidenceId;
    const draftId = recovered?.draftId ?? (draftOnly ? recovered?.captureSessionId ?? null : null);
    if (draftId) {
      await discardCaptureDraft(draftId).catch(() => undefined);
      setServerDrafts((prev) => prev.filter((d) => d.id !== draftId));
    }
    if (recovered?.captureSessionId && !draftOnly) {
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

  /**
   * Wait for the report, WITHOUT minting its URL.
   *
   * ===========================================================================
   * THIS POLLED A CUSTODY-RECORDING ENDPOINT
   * ===========================================================================
   * It called `GET /v1/evidence/:id/report/latest` in a retry loop to find out
   * whether the report was ready. That route's success path does this:
   *
   *     await appendCustodyEvent({
   *       eventType: prismaPkg.CustodyEventType.REPORT_DOWNLOADED, ...
   *     })
   *
   * So the first poll that succeeded wrote REPORT_DOWNLOADED into the custody
   * chain of the record — during a background wait, with nobody having
   * downloaded anything. Every record captured on a phone carried a download
   * event that never happened, in the one log whose whole purpose is to be an
   * accurate account of what was done to the evidence.
   *
   * `GET /v1/evidence/:id/artifacts/status` answers the same question and
   * appends nothing. It is the endpoint the Evidence Detail screen already
   * uses, under a comment stating the rule this loop was breaking: "STATUS
   * BEFORE URL — side-effect-free status first; only mint the report URL
   * (which records a custody/audit download) once the server says READY."
   *
   * The URL is minted where a person asks for the file, and nowhere else.
   */
  const pollReport = useCallback(async (evidenceId: string) => {
    const delays = [2000, 3000, 5000, 8000, 12000, 15000, 15000];
    for (let i = 0; i < delays.length; i += 1) {
      try {
        const st = await apiFetch(`/v1/evidence/${evidenceId}/artifacts/status`);
        if (st?.outputs?.report?.state === "READY") {
          setInfo(null);
          return;
        }
        setInfo("Report still generating...");
      } catch {
        setInfo("Report still generating...");
      }
      await sleep(delays[i]);
    }
    setInfo("Report is still generating. Try again shortly.");
  }, []);

  const getFilename = useCallback((uri: string, fallback: string) => {
    const name = uri.split("/").pop();
    return name && name.length > 0 ? name : fallback;
  }, []);

  const getGps = useCallback(async () => {
    if (!useLocation) return undefined;
    // A plan that REQUIRES location cannot finish without it (web orchestration :611-625).
    const locationRequired = templateRef.current?.locationRequirement === "required";

    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      recordActivity(LOCATION_UNAVAILABLE);
      setLocationDenied(true);
      if (locationRequired) {
        throw new Error("Location metadata is required by the selected plan, but device location was not granted.");
      }
      addToast("Location permission denied. Continuing without GPS.", "warning");
      return undefined;
    }

    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced
      });

      recordActivity(LOCATION_RECORDED);
      setLocationDenied(false);
      return {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyMeters: pos.coords.accuracy ?? undefined
      };
    } catch {
      recordActivity(LOCATION_UNAVAILABLE);
      setLocationDenied(true);
      if (locationRequired) {
        throw new Error("Location metadata is required by the selected plan. Enable location and grant permission before finishing.");
      }
      addToast("Could not get location. Continuing without GPS.", "warning");
      return undefined;
    }
  }, [useLocation, addToast, recordActivity]);

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
        planMode: planModeRef.current,
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

      /*
       * ONE RECORD, ONE ORIGIN — checked before the item is staged.
       *
       * A staged screen recording and a camera photo cannot become one
       * Evidence record: the server stamps the origin from the session it
       * issued, and a record that claimed "captured from an Android screen"
       * for a photograph would be a false statement about how it was made.
       *
       * Asked HERE rather than at finalize so the answer arrives while the
       * person is still holding the camera.
       */
      const staged = sessionItemsRef.current.map((i) => ({
        sourceLabel: i.itemSourceLabel ?? i.source,
      }));
      if (wouldMixOrigins(staged, input.source)) {
        setMixedOrigin(mixedOriginPrompt(resolveDraftAcquisition(staged)));
        return;
      }

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
          error: null,
          // Guided mode maps an incoming item onto the open required step it fits.
          checklistStepId: assignRequiredStep({
            planMode: planModeRef.current,
            plan: templateRef.current,
            stagedStepIds: sessionItemsRef.current.map((i) => i.checklistStepId),
            mimeType: input.mimeType,
          }),
        };

        const nextItems = [...sessionItemsRef.current, nextItem];
        setSessionState(nextItems);
        recordActivity(stagedActivity(input));

        addToast(
          `${nextItems.length} item${nextItems.length === 1 ? "" : "s"} added`,
          "success"
        );
      } catch (err) {
        const msg = toSafeUserError(err, { message: "Failed to add item" }).message;
        setError(msg);
        addToast(msg, "error");
        setSessionCreatingEvidence(false);
        setInfo(null);
      }
    },
    [ensureDraft, setSessionState, addToast, recordActivity]
  );

  const removeFromSession = useCallback(
    (itemId: string) => {
      if (sessionCompletingEvidence || isRecording) return;

      recordActivity(removedActivity(sessionItemsRef.current.find((item) => item.id === itemId)?.originalFilename));
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
        acquisitionRef.current = null;
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
    [sessionCompletingEvidence, isRecording, setSessionState, addToast, recordActivity]
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
      const msg = toSafeUserError(err, { message: "Could not discard the session" }).message;
      setError(msg);
      addToast(msg, "error");
      setDiscarding(false);
      return;
    }

    sessionEvidenceIdRef.current = null;
    captureSessionRef.current = null;
        acquisitionRef.current = null;
    setSessionEvidenceId(null);
    setSessionState([]);
    setInfo(null);
    setUploadProgress(0);
    await clearCaptureSession(); // M5 — drop the durable record on explicit discard
    setDiscarding(false);
    addToast("Session discarded", "info");
  }, [sessionCompletingEvidence, isRecording, discarding, setSessionState, addToast]);

  const ensureCameraReady = useCallback(async (kind: CaptureKind) => {
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

    if (kind === "VIDEO") {
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
    cameraPermission?.granted,
    micPermission?.granted,
    requestCameraPermission,
    requestMicPermission,
    addToast
  ]);

  const openPickerOrCamera = useCallback(async (kind: CaptureKind = activeTypeRef.current) => {
    setError(null);
    setInfo(null);

    try {
      if (kind === "DOCUMENT") {
        // Web "Files — Photos, video, audio, PDFs": several at once, one item each.
        const result = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          multiple: true,
          type: "*/*"
        });

        if (result.canceled || !result.assets?.length) {
          return;
        }

        for (const file of result.assets) {
          const fileInfo = await FileSystem.getInfoAsync(file.uri);
          await addCapturedItemToSession({
            uri: file.uri,
            mimeType: file.mimeType ?? "application/octet-stream",
            sizeBytes: file.size ?? (fileInfo.exists ? fileInfo.size : undefined),
            originalFilename: file.name ?? getFilename(file.uri, `document-${Date.now()}`),
            source: "FILE_PICKER"
          });
        }

        return;
      }

      const ready = await ensureCameraReady(kind);
      if (!ready) return;

      setCameraOpen(true);
      addToast(`${kind.toLowerCase()} camera ready`, "info");
    } catch (err) {
      const msg = toSafeUserError(err, { message: "Failed to open picker/camera" }).message;
      setError(msg);
      addToast(msg, "error");
    }
  }, [addCapturedItemToSession, ensureCameraReady, getFilename, addToast]);

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
      const msg = toSafeUserError(err, { message: "Failed to capture photo" }).message;
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
      const msg = toSafeUserError(err, { message: "Failed to record video" }).message;
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
      const msg = toSafeUserError(err, { message: "Failed to start audio recording" }).message;
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

  // The stopped recording awaiting Add to Session / Discard (web audioRecorderState "preview_ready").
  const [audioPending, setAudioPending] = useState<{
    uri: string;
    durationMs?: number;
    sizeBytes?: number;
    originalFilename: string;
  } | null>(null);

  const addAudioToSession = useCallback(async () => {
    const rec = audioPending;
    if (!rec) return;
    setAudioPending(null);
    await addCapturedItemToSession({ ...rec, mimeType: "audio/mp4", source: "UNKNOWN" });
  }, [audioPending, addCapturedItemToSession]);

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

      // Web recorder: Stop leaves a recording READY; the operator adds or discards it.
      setAudioPending({
        uri,
        durationMs,
        sizeBytes: fileInfo.exists ? fileInfo.size : undefined,
        originalFilename: getFilename(uri, `audio-${Date.now()}.m4a`),
      });

      setInfo(null);
    } catch (err) {
      const msg = toSafeUserError(err, { message: "Failed to record audio" }).message;
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
    recordActivity(FINALIZATION_STARTED);

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
          source: item.source,
          privateRole: item.role,
          privateNote: item.privateNote,
          checklistStepId: item.checklistStepId,
          sourceLabel: item.sourceNote,
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
      //
      // ONE finalization for every acquisition method. A screen session seals
      // through the route its manifest belongs to; an ordinary phone capture
      // through /complete. The screens no longer decide this for themselves —
      // that is what made the product have two endings.
      //
      // THE SECOND GATE. The add-path refuses a mixing item, but that is a UI
      // affordance; this is the claim itself. A draft that is mixed by any
      // route — a resumed session, a future caller — must not be sealed under
      // one origin.
      const sealing = resolveDraftAcquisition(
        sessionItemsRef.current.map((i) => ({ sourceLabel: i.itemSourceLabel ?? i.source })),
      );
      if (sealing.kind === "MIXED_ORIGIN") {
        setMixedOrigin(mixedOriginPrompt(sealing));
        throw new Error("This session mixes capture origins.");
      }

      await completeAcquisition(captureSession, acquisitionRef.current);

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
        acquisitionRef.current = null;
      acquisitionRef.current = null;
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
      const msg = toSafeUserError(err, { message: "Failed to finish session" }).message;
      setError(msg);
      addToast(msg, "error");
    } finally {
      setBusy(false);
      setSessionCompletingEvidence(false);
    }
  }, [addToast, pollReport, refreshRecent, router, setSessionState, isRecording, recordActivity]);

  // The camera's own controls (web CaptureCameraOverlay): which lens, and the light.
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [flashOn, setFlashOn] = useState(false);

  const formatRecordingTime = (seconds: number) =>
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  /**
   * WEB INTAKE ACTIONS (CaptureDropzone): Files, Photo, Video, Audio.
   *
   * Switching source mid-session is allowed: staging into the canonical draft
   * derives the record's type from what was actually staged at finalize — a
   * uniform session keeps its kind, a mixed one is DOCUMENT, exactly as the
   * web derives it. The web's "Folder" action has no phone equivalent: the
   * system document picker cannot select a directory.
   */
  const runIntakeAction = (kind: CaptureKind) => {
    if (isRecording) {
      addToast("Stop the current recording before changing type", "warning");
      return;
    }
    setActiveIndex(CAPTURE_TYPES.indexOf(kind));
    setCameraOpen(false);
    setError(null);
    setInfo(null);
    setShowSettingsLink(false);
    if (kind !== "AUDIO") void openPickerOrCamera(kind);
  };

  const totalBytes = sessionItems.reduce((sum, i) => sum + (i.sizeBytes ?? 0), 0);
  const hasItems = sessionItems.length > 0;
  const visibleDrafts = serverDrafts.filter(
    (d) =>
      d.id !== draftIdRef.current &&
      d.id !== resumable?.draftId &&
      !(resumable && resumable.captureSessionId === resumable.evidenceId && d.id === resumable.captureSessionId),
  );

  const INTAKE_ACTIONS: ReadonlyArray<{ kind: CaptureKind; label: string; helper: string }> = [
    { kind: "DOCUMENT", label: "Files", helper: "Photos, video, audio, PDFs" },
    { kind: "PHOTO", label: "Photo", helper: "Camera capture" },
    { kind: "VIDEO", label: "Video", helper: "Record clip" },
    { kind: "AUDIO", label: "Audio", helper: "Record note" },
  ];

  return (
    <ProovraScreen>
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} disabled={isRecording} onPress={() => router.back()} />
      </View>

      {/* Web order: the intake rail, the drafts, then the page's own title. */}
      <CaptureIntakeRail items={plannedItems} templateSelected={template !== null} readiness={captureReadiness} />

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
      {!hasItems && !personalSpaceBlocked ? (
        <CaptureDraftsBanner
          drafts={visibleDrafts}
          open={draftsOpen}
          onOpen={() => setDraftsOpen(true)}
          onClose={() => setDraftsOpen(false)}
          onResume={(d) => void resumeServerDraft(d)}
          onDelete={(d) => void deleteServerDraft(d)}
          busyId={draftBusyId}
        />
      ) : null}

      <CaptureHero />

      {personalSpaceBlocked ? (
        <View testID="personal-space-blocked">
          <ProovraEmptyState title={PERSONAL_SPACE_UNAVAILABLE_TITLE} message={PERSONAL_SPACE_UNAVAILABLE_MESSAGE} />
        </View>
      ) : (
        <>
          <CaptureReadinessPanel readiness={captureReadiness} itemCount={sessionItems.length} />
          {hasItems ? <CaptureSuggestionsPanel readiness={captureReadiness} /> : null}

          <View style={styles.block}>
            <CaptureIntakeStructure
              planMode={planMode}
              onPlanMode={setPlanMode}
              useLocation={useLocation}
              onUseLocation={setUseLocation}
              busy={sessionCompletingEvidence}
              hasSessionItems={hasItems}
            />
          </View>

          <View style={styles.block}>
            <CaptureRequirements
              templates={templates}
              plan={template}
              onSelectPlan={selectTemplate}
              readiness={sessionReadiness}
              stepItemCounts={stepItemCounts}
              busy={sessionCompletingEvidence}
              hasSessionItems={hasItems}
            />
          </View>

          {resumedDraft && !reattachDismissed && !hasItems ? (
            <CaptureDraftReattachNotice detail={resumedDraft} plan={template} onDismiss={() => setReattachDismissed(true)} />
          ) : null}

          {/* Web CaptureDropzone — "Evidence capture · Add source files". */}
          <ProovraCard style={styles.block} testID="capture-intake-actions">
            <View style={styles.dropHead}>
              <View style={{ flex: 1, gap: 2 }}>
                <ProovraText variant="label" weight="bold" color={theme.color.ink.muted} style={styles.upper}>Evidence capture</ProovraText>
                <ProovraText variant="h3" weight="semibold">Add source files</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary}>Upload, capture, or record materials for this session.</ProovraText>
              </View>
              <ProovraBadge label={hasItems ? "Session in progress" : "Ready for intake"} tone={hasItems ? "pending" : "neutral"} />
            </View>
            <View style={styles.actionGrid} accessibilityLabel="Evidence intake actions">
              {INTAKE_ACTIONS.map((a, idx) => {
                const active = activeType === a.kind && (a.kind === "AUDIO" || cameraOpen);
                return (
                  <Pressable
                    key={a.kind}
                    accessibilityRole="button"
                    accessibilityLabel={a.label}
                    accessibilityState={{ selected: active, disabled: sessionCompletingEvidence }}
                    disabled={sessionCompletingEvidence}
                    onPress={() => runIntakeAction(a.kind)}
                    style={[
                      styles.actionTile,
                      idx === 0 ? styles.actionTilePrimary : null,
                      active ? styles.actionTileActive : null,
                    ]}
                  >
                    <ProovraText variant="bodySm" weight="semibold" color={idx === 0 ? theme.color.accent.a600 : theme.color.ink.primary}>{a.label}</ProovraText>
                    <ProovraText variant="label" color={theme.color.ink.secondary}>{a.helper}</ProovraText>
                  </Pressable>
                );
              })}
            </View>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              Mapping, integrity checks, and readiness warnings update as soon as materials are staged.
            </ProovraText>

            {/*
             * NATIVE ACQUISITION SOURCES (UC-2 / UC-3 / UC-5). They open their
             * own screens because each drives a protected native engine
             * (ReplayKit on iOS, MediaProjection on Android) with its own
             * permission ceremony; what they acquire comes back here to be
             * reviewed and finished by the one Finish & Sign.
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
                /*
                 * T-19 / RC-19 — iOS has no single-shot screen capture: ReplayKit
                 * records through Apple's system broadcast, which is the
                 * CONTINUOUS flow, and the control is named for the flow it opens.
                 */
                <>
                  <ProovraButton
                    label="Continuous screen capture"
                    variant="secondary"
                    disabled={isSessionActive || isRecording}
                    onPress={() => router.push("/continuous-capture")}
                  />
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    On iPhone and iPad, screen capture records continuously through Apple's screen broadcast until you stop it.
                  </ProovraText>
                </>
              )}
              {isSessionActive || isRecording ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  Finish or discard the current session to use another source.
                </ProovraText>
              ) : null}
            </View>
          </ProovraCard>

          {activeType === "AUDIO" ? (
            /* Web "Audio Recorder" card: Start Recording / Stop / Discard / Add to Session. */
            <ProovraCard style={styles.audioCard} testID="capture-audio-recorder">
              <View style={styles.dropHead}>
                <ProovraText variant="h3" weight="semibold">Audio Recorder</ProovraText>
                {!isRecording ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close audio recorder"
                    hitSlop={8}
                    onPress={() => {
                      setAudioPending(null);
                      setActiveIndex(CAPTURE_TYPES.indexOf("DOCUMENT"));
                    }}
                  >
                    <ProovraText variant="h3" color={theme.color.ink.muted}>×</ProovraText>
                  </Pressable>
                ) : null}
              </View>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                {isRecording
                  ? `Recording ${formatRecordingTime(recordSeconds)}`
                  : audioPending
                    ? `Recording ready${audioPending.durationMs ? ` · ${formatRecordingTime(Math.round(audioPending.durationMs / 1000))}` : ""}. Add it to the session or discard it.`
                    : "Record audio evidence with this device microphone. Stop, then add the recording to the current evidence session."}
              </ProovraText>
              <View style={styles.audioActions}>
                <ProovraButton
                  label="Start Recording"
                  fullWidth={false}
                  loading={busy && !isRecording}
                  disabled={sessionCompletingEvidence || sessionCreatingEvidence || busy || isRecording || !!audioPending}
                  onPress={handleStartAudioRecording}
                />
                <ProovraButton label="Stop" variant="secondary" fullWidth={false} disabled={!isRecording} onPress={handleStopAudioRecording} />
                <ProovraButton label="Discard" variant="secondary" fullWidth={false} disabled={isRecording || !audioPending} onPress={() => setAudioPending(null)} />
                <ProovraButton label="Add to Session" fullWidth={false} disabled={!audioPending || sessionCompletingEvidence} onPress={() => void addAudioToSession()} />
              </View>
            </ProovraCard>
          ) : cameraOpen && activeType !== "DOCUMENT" ? (
            /* Web CaptureCameraOverlay. */
            <ProovraCard style={styles.cameraCard} testID="capture-camera">
              <View>
                <CameraView
                  ref={cameraRef}
                  style={styles.cameraPreview}
                  facing={facing}
                  mode={activeType === "VIDEO" ? "video" : "picture"}
                  flash={flashOn ? "on" : "off"}
                />
                <View style={styles.overlayTopLeft}>
                  <Text style={styles.overlayBadge}>
                    {activeType === "PHOTO" ? "Capture Photo" : isRecording ? `REC ${formatRecordingTime(recordSeconds)}` : "Record Video"}
                  </Text>
                </View>
                <View style={styles.overlayTopRight}>
                  <Text style={styles.counterBadge}>{`${sessionItems.length} added`}</Text>
                </View>
              </View>
              <View style={styles.cameraControls}>
                <ProovraText variant="label" color={theme.color.ink.muted} center>
                  {activeType === "PHOTO"
                    ? "Capture repeatedly to add multiple photos into one evidence record."
                    : isRecording
                      ? `Recording… ${formatRecordingTime(recordSeconds)}`
                      : "Record a clip, it will be auto-added to the same evidence session."}
                </ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary} center>
                  {facing === "back" ? "Rear camera" : "Front camera"}
                </ProovraText>
                {activeType === "PHOTO" ? (
                  <ProovraButton label="Add to Evidence Session" loading={busy || sessionCreatingEvidence} disabled={sessionCompletingEvidence} onPress={handleTakePhoto} />
                ) : (
                  <ProovraButton
                    label={isRecording ? "Stop & Add" : "Record"}
                    variant={isRecording ? "danger" : "primary"}
                    disabled={busy || sessionCompletingEvidence || sessionCreatingEvidence}
                    onPress={isRecording ? handleStopRecording : handleStartRecording}
                  />
                )}
                <View style={styles.audioActions}>
                  {activeType === "PHOTO" ? (
                    <ProovraButton label={flashOn ? "Flash on" : "Flash"} accessibilityLabel="Flash" variant="secondary" fullWidth={false} disabled={busy} onPress={() => setFlashOn((v) => !v)} />
                  ) : null}
                  <ProovraButton label="Flip" variant="secondary" fullWidth={false} disabled={busy || isRecording} onPress={() => setFacing((f) => (f === "back" ? "front" : "back"))} />
                  <ProovraButton label="Close" accessibilityLabel="Close camera" variant="ghost" fullWidth={false} disabled={isRecording || busy} onPress={() => setCameraOpen(false)} />
                </View>
              </View>
            </ProovraCard>
          ) : null}

          {hasItems ? (
            <CaptureMaterialsBoard
              items={sessionItems}
              plan={template}
              planMode={planMode}
              readiness={sessionReadiness}
              busy={sessionCompletingEvidence}
              locked={isRecording}
              draftSaveState={draftSaveState}
              hasDraft={!!draftIdRef.current}
              onClearMappings={() => setSessionState(sessionItemsRef.current.map((i) => ({ ...i, checklistStepId: null })))}
              onRemovePending={() =>
                sessionItemsRef.current.filter((i) => !i.uploaded && !i.uploading).forEach((i) => removeFromSession(i.id))
              }
              onRemove={removeFromSession}
              onMap={(id, patch) => applyPlan(id, patch)}
              onUpdate={(id, patch) => applyPlan(id, patch)}
            />
          ) : null}

          <CaptureOperationalSummary readiness={captureReadiness} itemCount={sessionItems.length} />

          {hasItems ? <CaptureActivityDisclosure events={activity} /> : null}

          {hasItems ? (
            <ProovraCard style={styles.sessionCard} testID="capture-finish">
              <CaptureFinalReadiness readiness={sessionReadiness} busy={sessionCompletingEvidence} />
              <CaptureFinishHeading busy={sessionCompletingEvidence} progress={uploadProgress} />
              <View style={styles.sessionActions} accessibilityLabel="Session final actions">
                <ProovraButton
                  label={sessionCompletingEvidence ? `Finishing… ${uploadProgress}%` : `Finish & Sign (${sessionItems.length})`}
                  loading={sessionCompletingEvidence}
                  disabled={sessionCreatingEvidence || isRecording || !sessionReadiness.canFinalize}
                  onPress={completeSession}
                />
                <ProovraButton
                  label={discarding ? "Clearing…" : "Clear Session"}
                  variant="secondary"
                  disabled={sessionCompletingEvidence || isRecording || discarding}
                  onPress={() => setClearConfirmOpen(true)}
                />
              </View>
            </ProovraCard>
          ) : null}

          {hasItems ? (
            <CaptureSessionStatus
              readiness={sessionReadiness}
              busy={sessionCompletingEvidence}
              itemCount={sessionItems.length}
              sessionId={formatCaptureSessionId(sessionStartedAt ?? new Date())}
              plan={template}
              totalBytes={totalBytes}
              useLocation={useLocation}
              planMode={planMode}
              locationPermissionDenied={locationDenied}
            />
          ) : null}

          {/* T-15 — metadata-only AI QA of the staged session (CaptureSessionPanel.tsx:283). */}
          {hasItems ? (
            <CaptureAiReview
              plan={template}
              useLocation={useLocation}
              planMode={planMode}
              recommended={sessionReadiness.aiRecommendedReview}
              items={sessionItems.map((i) => ({
                id: i.id,
                fileName: i.originalFilename ?? i.id,
                mimeType: i.mimeType,
                sizeBytes: i.sizeBytes ?? 0,
                checklistStepId: i.checklistStepId ?? null,
                role: i.role ?? null,
                sourceLabel: i.sourceNote ?? null,
                // The session-wide switch IS each item's location signal, as the plan reads it.
                locationIncluded: useLocation,
              }))}
            />
          ) : null}

          {/*
            TWO ORIGINS MET IN ONE DRAFT.
            A statement with a next step, not a silent refusal. Nothing staged
            is discarded by either action here.
          */}
          <ProovraSheet
            visible={mixedOrigin !== null}
            title={mixedOrigin?.title ?? ""}
            onClose={() => setMixedOrigin(null)}
          >
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              {mixedOrigin?.message ?? ""}
            </ProovraText>
            <ProovraButton
              label={mixedOrigin?.finishLabel ?? "Finish this capture first"}
              onPress={() => {
                setMixedOrigin(null);
                void completeSession();
              }}
            />
            <ProovraButton
              label={mixedOrigin?.cancelLabel ?? "Not now"}
              variant="ghost"
              onPress={() => setMixedOrigin(null)}
            />
          </ProovraSheet>

          {/* Web "Clear this evidence session?" — Clear is a server transition (discardSession). */}
          <ProovraConfirmSheet
            visible={clearConfirmOpen}
            title="Clear this evidence session?"
            consequence="This will remove all staged materials, mapping, private notes, and local review progress. No evidence record has been created yet."
            cancelLabel="Keep Session"
            confirmLabel="Clear Session"
            tone="danger"
            busy={discarding}
            onCancel={() => setClearConfirmOpen(false)}
            onConfirm={() => {
              setClearConfirmOpen(false);
              void discardSession();
            }}
          />

          {error ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{error}</ProovraText> : null}
          {info ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{info}</ProovraText> : null}
          {showSettingsLink ? <ProovraButton label="Open Settings" variant="secondary" onPress={() => Linking.openSettings()} /> : null}
        </>
      )}

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
                  onPress={() => router.push(`/evidence/${item.id}`)}
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
  headerRow: { flexDirection: "row", marginTop: theme.space.s2, marginBottom: theme.space.s2 },
  resumeCard: { gap: theme.space.s2, marginBottom: theme.space.s3, borderColor: theme.color.accent.a500 },
  resumeActions: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s2 },
  staleNote: { marginBottom: theme.space.s3 },
  block: { marginBottom: theme.space.s3 },
  upper: { textTransform: "uppercase", letterSpacing: 0.4 },
  dropHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: theme.space.s2 },
  actionGrid: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginVertical: theme.space.s3 },
  actionTile: {
    flexBasis: "47%",
    flexGrow: 1,
    borderWidth: 1,
    borderColor: theme.color.border.default,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface.card,
    padding: theme.space.s3,
    gap: 2,
  },
  actionTilePrimary: { borderColor: theme.color.accent.a500, backgroundColor: theme.color.accent.a050 },
  actionTileActive: { borderColor: theme.color.accent.a600, borderWidth: 2 },
  sourcesBlock: { gap: theme.space.s2, marginTop: theme.space.s3, paddingTop: theme.space.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.subtle },
  cameraCard: { padding: 0, overflow: "hidden", marginBottom: theme.space.s3 },
  audioCard: { gap: theme.space.s2, marginBottom: theme.space.s3 },
  audioActions: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  cameraPreview: { height: 380, width: "100%" },
  overlayTopLeft: { position: "absolute", top: 12, left: 12 },
  overlayTopRight: { position: "absolute", top: 12, right: 12 },
  overlayBadge: { backgroundColor: "rgba(15,23,42,0.78)", color: "#FFFFFF", paddingHorizontal: 10, paddingVertical: 6, borderRadius: theme.radius.pill, fontSize: 12, fontWeight: "700", overflow: "hidden" },
  counterBadge: { backgroundColor: theme.color.semantic.success, color: "#FFFFFF", paddingHorizontal: 10, paddingVertical: 6, borderRadius: theme.radius.pill, fontSize: 12, fontWeight: "800", overflow: "hidden" },
  cameraControls: { padding: theme.space.s3, gap: theme.space.s2 },
  sessionCard: { gap: theme.space.s2, marginBottom: theme.space.s3 },
  sessionActions: { marginTop: 8, gap: theme.space.s2 },
});
