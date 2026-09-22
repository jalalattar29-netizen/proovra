import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Linking, Pressable, Share, View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { EvidenceOutputState } from "@proovra/shared";
import { apiFetch } from "../../../src/api";
import { EvidenceInternalMaterials } from "../../../src/ui/evidence-internal-materials";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { formatUserDateTime } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraConfirmSheet,
  ProovraInput,
  ProovraFormField,
  ProovraFilterChips,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../../src/ui";
import {
  evidenceStatusDisplay,
  evidenceTypeLabel,
  verificationStatusDisplay,
  humanizeEnum,
} from "../../../src/product/domain-display";
import {
  DUPLICATE_LIMITATION,
  REGENERATE_CONSEQUENCE,
  buildDuplicatesPath,
  buildRegeneratePath,
  duplicateMatchSummary,
  generationActionLabel,
  generationNeedsConfirmation,
  parseDuplicateReport,
  readGenerationOutcome,
  type DuplicateReport,
  projectCustodyEvents,
  projectPreservation,
  projectRelationships,
  EVIDENCE_COMMENT_VISIBILITIES,
  buildCommentBody,
  buildCommentsPath,
  commentVisibilityLabel,
  isSendableComment,
  projectComments,
  type EvidenceComment,
  type EvidenceCommentVisibility,
  projectMaterials,
  materialBlockedReason,
  type MaterialItem,
  projectProvenance,
  projectTechnical,
  projectCertifications,
  type CustodyEvent,
  type PreservationView,
  type RelationshipView,
  type ProvenanceView,
  type TechnicalView,
  type CertificationView,
} from "../../../src/product/evidence-detail";
import { isDerivedReviewEligible } from "../../../src/product/derived-review";
import { DerivedReviewTab } from "../../../src/ui/derived-review-tab";
import { usePlatformContext } from "../../../src/product/platform-context";

/**
 * P2-3 CLOSURE — one sentence per canonical output state. TOTAL over
 * EvidenceOutputState (from @proovra/shared — mobile holds no vocabulary of its
 * own). `null` is the honest "could not read status" case. Preserved verbatim.
 */
function reportStateMessage(state: EvidenceOutputState | null): string {
  switch (state) {
    case null:
      return "Report status is unavailable right now. Pull to refresh, or open this record on the web app.";
    case "READY":
      return "The report is ready. Open this record on the web app to download it.";
    case "NOT_INCLUDED":
      return "A report and verification package are not included for this record. Its integrity materials and public verification are unaffected.";
    case "NOT_APPLICABLE":
      return "A report becomes available once this record is finalized.";
    case "ELIGIBLE_NOT_GENERATED":
      return "No report has been generated for this record yet. Generate one from the web app.";
    case "QUEUED":
    case "GENERATING":
      return "The report is being generated. It will be available here shortly.";
    case "RETRYABLE_FAILURE":
      return "The last attempt to generate the report did not complete. The evidence record and its integrity state are unaffected.";
    case "TERMINAL_FAILURE":
      return "Report generation stopped for this record. Open it on the web app for the reason.";
    case "BLOCKED":
      return "Report generation is blocked for this record by a governance or lifecycle decision.";
  }
}

type Tab =
  | "overview"
  | "integrity"
  | "custody"
  | "technical"
  | "links"
  | "materials"
  | "discussion"
  | "artifacts"
  | "duplicates"
  | "internal"
  | "derived";
type LoadState = "loading" | "ready" | "error" | "notfound";

interface Core {
  status: string;
  statusLabel: string | null;
  verificationStatus: string | null;
  verificationStatusLabel: string | null;
  displayTitle: string | null;
  originalFileName: string | null;
  createdAt: string | null;
  type: string;
  fileSha256: string | null;
  fingerprintHash: string | null;
}

export default function EvidenceDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? "";

  const [tab, setTab] = useState<Tab>("overview");

  const [duplicates, setDuplicates] = useState<DuplicateReport | null>(null);
  const [duplicatesPhase, setDuplicatesPhase] = useState<"idle" | "loading" | "failed">("idle");
  const [generating, setGenerating] = useState(false);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [generationNote, setGenerationNote] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [core, setCore] = useState<Core | null>(null);
  const [reportState, setReportState] = useState<EvidenceOutputState | null>(null);
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  // Real review-workspace projections (bound from the CURRENT documented shape).
  const [custody, setCustody] = useState<{ forensic: CustodyEvent[]; access: CustodyEvent[] }>({ forensic: [], access: [] });
  const [preservation, setPreservation] = useState<PreservationView | null>(null);
  const [relationships, setRelationships] = useState<RelationshipView[]>([]);
  const [provenance, setProvenance] = useState<ProvenanceView | null>(null);
  // UC-4 reads are workspace-scoped, so the derived tab needs the active team.
  // ONE call: the module is the single reader of /v1/platform/context, and a
  // second hook here would be a second fetch of the same envelope.
  const platform = usePlatformContext();
  // The SERVER gate for reviewer-ops surfaces, read exactly as the web reads
  // it. Nothing native derives "enterprise" from a plan name; absent is false,
  // which withholds rather than offers.
  const enterpriseSurfaces = platform.context?.enterpriseSurfaces === true;
  const [technical, setTechnical] = useState<TechnicalView | null>(null);
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [comments, setComments] = useState<EvidenceComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [visibility, setVisibility] = useState<EvidenceCommentVisibility>("INTERNAL");
  const [commentBusy, setCommentBusy] = useState(false);
  const [certifications, setCertifications] = useState<CertificationView[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    setState("loading");
    setError(null);
    try {
      const data = await apiFetch(`/v1/evidence/${id}`);
      const ev = (data.evidence ?? {}) as Record<string, unknown>;
      setCore({
        status: (ev.status as string) ?? "SIGNED",
        statusLabel: (ev.statusLabel as string) ?? null,
        verificationStatus: (ev.verificationStatus as string) ?? null,
        verificationStatusLabel: (ev.verificationStatusLabel as string) ?? null,
        displayTitle: (ev.displayTitle as string) ?? (ev.displayFileName as string) ?? null,
        originalFileName: (ev.originalFileName as string) ?? null,
        createdAt: (ev.createdAt as string) ?? null,
        type: (ev.type as string) ?? "Evidence",
        fileSha256: (ev.fileSha256 as string) ?? null,
        fingerprintHash: (ev.fingerprintHash as string) ?? null,
      });
      setState("ready");
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.kind === "notFound") {
        setState("notfound");
      } else {
        setError(safe);
        setState("error");
      }
      return;
    }

    // STATUS BEFORE URL — side-effect-free status first; only mint the report
    // URL (which records a custody/audit download) once the server says READY.
    try {
      const st = await apiFetch(`/v1/evidence/${id}/artifacts/status`);
      const next = (st?.outputs?.report?.state ?? null) as EvidenceOutputState | null;
      setReportState(next);
      if (next === "READY") {
        try {
          const report = await apiFetch(`/v1/evidence/${id}/report/latest`);
          setReportUrl((report.url as string) ?? null);
        } catch {
          setReportUrl(null);
        }
      } else {
        setReportUrl(null);
      }
    } catch {
      setReportState(null);
      setReportUrl(null);
    }

    // Rich review-workspace projection — bind the REAL documented shape
    // (custody events, TSA/OTS, signature, relationships, provenance). Defensive:
    // render only what is present; never fabricate integrity/custody facts.
    try {
      const rw = await apiFetch(`/v1/evidence/${id}/review-workspace`);
      setCustody(projectCustodyEvents(rw));
      setPreservation(projectPreservation(rw));
      setRelationships(projectRelationships(rw));
      setProvenance(projectProvenance(rw));
      setMaterials(projectMaterials(rw));
    } catch {
      setCustody({ forensic: [], access: [] });
      setPreservation(null);
      setRelationships([]);
      setProvenance(null);
    }

    // Technical metadata + EXIF (separate endpoint; Personal/PRO-applicable).
    try {
      setTechnical(projectTechnical(await apiFetch(`/v1/evidence/${id}/technical-metadata`)));
    } catch {
      setTechnical(null);
    }

    // Declarations / certifications (separate endpoint; read = read-access only).
    try {
      setCertifications(projectCertifications(await apiFetch(`/v1/evidence/${id}/certifications`)));
    } catch {
      setCertifications([]);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Duplicates load when the tab is opened, for the same reason the comments
  // do: a reader who never asks should not pay for the scan.
  const loadDuplicates = useCallback(async () => {
    if (!id) return;
    setDuplicatesPhase("loading");
    try {
      setDuplicates(parseDuplicateReport(await apiFetch(buildDuplicatesPath(String(id)))));
      setDuplicatesPhase("idle");
    } catch {
      setDuplicates(null);
      setDuplicatesPhase("failed");
    }
  }, [id]);

  const requestGeneration = useCallback(async () => {
    if (!id) return;
    setConfirmingRegenerate(false);
    setGenerating(true);
    setGenerationNote(null);
    try {
      // READ THE OUTCOME, NOT THE BOOLEAN. Six server answers used to collapse
      // into one sentence on the web, and two of them described work that was
      // never going to happen.
      const read = readGenerationOutcome(
        await apiFetch(buildRegeneratePath(String(id)), { method: "POST" }),
      );
      setGenerationNote(read.message);
      // Only reload when work was actually accepted; a refusal has nothing new
      // to show and a reload would imply something changed.
      if (read.acceptedWork) await load();
    } catch (err) {
      setGenerationNote(toSafeUserError(err).message);
    } finally {
      setGenerating(false);
    }
  }, [id, load]);

    // Comments load when the tab is opened rather than with the record: a
  // reviewer who never opens the discussion should not pay for it.
  const loadComments = useCallback(async () => {
    if (!id) return;
    try {
      setComments(projectComments(await apiFetch(buildCommentsPath(String(id)))));
    } catch {
      setComments([]);
    }
  }, [id]);

  useEffect(() => {
    if (tab === "discussion" && comments === null) void loadComments();
  }, [tab, comments, loadComments]);

  const postComment = useCallback(async () => {
    if (!id || !isSendableComment(draft)) return;
    setCommentBusy(true);
    try {
      await apiFetch(buildCommentsPath(String(id)), {
        method: "POST",
        body: JSON.stringify(buildCommentBody(draft, visibility)),
      });
      setDraft("");
      await loadComments();
    } catch (err) {
      Alert.alert("Could not post comment", toSafeUserError(err).message);
    } finally {
      setCommentBusy(false);
    }
  }, [id, draft, visibility, loadComments]);

  // Share the PUBLIC verification link — only the server-provided publicUrl is
  // ever shared (never an invented URL). If public verification isn't published,
  // say so honestly rather than fabricating a link.
  const [sharingVerify, setSharingVerify] = useState(false);
  const shareVerification = useCallback(async () => {
    setSharingVerify(true);
    try {
      const res = (await apiFetch(`/public/verify/${id}`)) as { publicUrl?: string | null };
      const url = typeof res?.publicUrl === "string" && res.publicUrl ? res.publicUrl : null;
      if (!url) {
        Alert.alert("Not published", "Public verification isn’t published for this record. Publish it in the web app to share a verification link.");
        return;
      }
      await Share.share({ url, message: `Verify this PROOVRA record: ${url}` });
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.kind === "notFound") Alert.alert("Not published", "Public verification isn’t published for this record.");
      else Alert.alert("Could not share", safe.message);
    } finally {
      setSharingVerify(false);
    }
  }, [id]);

  const runAction = useCallback(
    (label: string, opts: { path?: string; method?: "POST" | "DELETE"; body?: object; destructive?: boolean }) => {
      Alert.alert(label, `${label} this record?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: label,
          style: opts.destructive ? "destructive" : "default",
          onPress: () => {
            void (async () => {
              setActionBusy(true);
              try {
                const suffix = opts.path ? `/${opts.path}` : "";
                await apiFetch(`/v1/evidence/${id}${suffix}`, {
                  method: opts.method ?? "POST",
                  body: opts.body ? JSON.stringify(opts.body) : undefined,
                });
                await load(); // reconcile after mutation
              } catch (err) {
                Alert.alert("Action failed", toSafeUserError(err).message);
              } finally {
                setActionBusy(false);
              }
            })();
          },
        },
      ]);
    },
    [id, load],
  );

  const custodyEvents = useMemo(
    () => [...custody.forensic, ...custody.access].sort((a, b) => a.sequence - b.sequence),
    [custody],
  );

  if (state === "loading") {
    return (
      <ProovraScreen scroll={false}>
        <ProovraLoadingState label="Loading record" />
      </ProovraScreen>
    );
  }
  if (state === "notfound") {
    return (
      <ProovraScreen scroll={false}>
        <ProovraEmptyState title="Record not found" message="This evidence record is no longer available." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} />
      </ProovraScreen>
    );
  }
  if (state === "error" && error) {
    return (
      <ProovraScreen scroll={false}>
        <ProovraErrorState message={error.message} onRetry={load} />
      </ProovraScreen>
    );
  }

  const c = core!;
  const TABS: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "integrity", label: "Integrity" },
    { key: "custody", label: "Custody" },
    { key: "technical", label: "Technical" },
    ...(relationships.length > 0 ? ([{ key: "links", label: "Links" }] as Array<{ key: Tab; label: string }>) : []),
    ...(materials.length > 0
      ? ([{ key: "materials", label: "Files" }] as Array<{ key: Tab; label: string }>)
      : []),
    { key: "discussion", label: "Discussion" },
    { key: "artifacts", label: "Artifacts" },
    { key: "duplicates", label: "Duplicates" },
    ...(enterpriseSurfaces
      ? ([{ key: "internal", label: "Internal" }] as Array<{ key: Tab; label: string }>)
      : []),
    // UC-4 — Derived Review is a RECORD property (screen-capture originals
    // only), never a workspace-kind gate, exactly as the web states it. The
    // category comes from the provenance projection this screen already loads,
    // so eligibility has one source.
    ...(isDerivedReviewEligible(provenance?.category ?? null)
      ? ([{ key: "derived", label: "Derived" }] as Array<{ key: Tab; label: string }>)
      : []),
  ];

  return (
    <ProovraScreen>
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>

      <ProovraCard style={styles.hero}>
        <View style={styles.badgeRow}>
          <ProovraBadge tone={evidenceStatusDisplay(c.status).tone} label={c.statusLabel?.trim() || evidenceStatusDisplay(c.status).label} />
          {c.verificationStatus ? (
            <ProovraBadge
              tone={verificationStatusDisplay(c.verificationStatus).tone}
              label={c.verificationStatusLabel?.trim() || verificationStatusDisplay(c.verificationStatus).label}
            />
          ) : null}
        </View>
        <ProovraText variant="h1" weight="bold" style={styles.heroTitle}>
          {c.displayTitle?.trim() || c.originalFileName?.trim() || evidenceTypeLabel(c.type)}
        </ProovraText>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {[evidenceTypeLabel(c.type), c.createdAt ? `Created ${formatUserDateTime(c.createdAt)}` : null].filter(Boolean).join(" · ")}
        </ProovraText>
      </ProovraCard>

      <View style={styles.tabs}>
        {TABS.map((tb) => {
          const active = tb.key === tab;
          return (
            <Pressable
              key={tb.key}
              onPress={() => {
                setTab(tb.key);
                if (tb.key === "duplicates" && duplicates === null) void loadDuplicates();
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles.tab, { borderColor: active ? theme.color.accent.a500 : theme.color.border.default, backgroundColor: active ? theme.color.accent.a050 : "transparent" }]}
            >
              <ProovraText variant="label" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.secondary}>
                {tb.label}
              </ProovraText>
            </Pressable>
          );
        })}
      </View>

      {tab === "overview" ? (
        <ProovraSection>
          <ProovraCard>
            <Row k="Type" v={evidenceTypeLabel(c.type)} />
            <Row k="Status" v={c.statusLabel?.trim() || evidenceStatusDisplay(c.status).label} />
            {c.verificationStatus ? (
              <Row k="Verification" v={c.verificationStatusLabel?.trim() || verificationStatusDisplay(c.verificationStatus).label} />
            ) : null}
            <Row k="Created" v={c.createdAt ? formatUserDateTime(c.createdAt) : "—"} />
            {provenance?.label ? <Row k="Source" v={provenance.label} /> : null}
          </ProovraCard>
          {provenance?.statement ? (
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.note}>{provenance.statement}</ProovraText>
          ) : null}
          <View style={styles.actions}>
            <ProovraButton label="Lock" variant="secondary" loading={actionBusy} onPress={() => runAction("Lock", { path: "lock" })} />
            <ProovraButton label="Archive" variant="secondary" loading={actionBusy} onPress={() => runAction("Archive", { path: "archive" })} />
            <ProovraButton label="Move to Trash" variant="danger" loading={actionBusy} onPress={() => runAction("Move to Trash", { method: "DELETE", destructive: true })} />
          </View>
        </ProovraSection>
      ) : null}

      {tab === "integrity" ? (
        <ProovraSection title="Integrity">
          <ProovraCard>
            <Row k="SHA-256" v={c.fileSha256 ?? "—"} mono />
            <Row k="Ed25519 fingerprint" v={c.fingerprintHash ?? "—"} mono />
            {preservation ? (
              <>
                {preservation.signature.recorded ? <Row k="Signature" v={preservation.signature.valid === false ? "Recorded (invalid)" : "Recorded"} /> : null}
                <Row k="Trusted timestamp (TSA)" v={preservation.tsa.status ? `${humanizeEnum(preservation.tsa.status)}${preservation.tsa.provider ? ` · ${preservation.tsa.provider}` : ""}` : "Not timestamped"} />
                <Row k="Blockchain anchor (OTS)" v={preservation.ots.effectiveStatus || preservation.ots.status ? humanizeEnum((preservation.ots.effectiveStatus || preservation.ots.status) as string) : "Not anchored"} />
                {preservation.ots.bitcoinTxid ? <Row k="Bitcoin tx" v={preservation.ots.bitcoinTxid} mono /> : null}
                {preservation.custodyChain.valid !== null ? <Row k="Custody chain" v={preservation.custodyChain.valid ? "Valid" : `Broken${preservation.custodyChain.reason ? ` — ${preservation.custodyChain.reason}` : ""}`} /> : null}
              </>
            ) : null}
          </ProovraCard>
          {certifications.length > 0 ? (
            <ProovraCard style={styles.stackCard}>
              <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Declarations</ProovraText>
              {certifications.map((cert) => (
                <ProovraListRow
                  key={cert.id}
                  title={humanizeEnum(cert.declarationType)}
                  subtitle={[cert.attestorName, cert.attestedAtUtc ? formatUserDateTime(cert.attestedAtUtc) : null].filter(Boolean).join(" · ") || undefined}
                  trailing={<ProovraBadge tone={cert.revoked ? "risk" : cert.status === "ATTESTED" ? "verified" : "neutral"} label={cert.revoked ? "Revoked" : humanizeEnum(cert.status)} />}
                />
              ))}
            </ProovraCard>
          ) : null}
          <ProovraText variant="label" color={theme.color.ink.muted} style={styles.note}>
            Integrity is computed and sealed by the server; this view reflects that record, it does not recompute it.
          </ProovraText>
          <View style={styles.actions}>
            <ProovraButton label="Share verification link" variant="secondary" loading={sharingVerify} onPress={() => void shareVerification()} />
          </View>
        </ProovraSection>
      ) : null}

      {tab === "custody" ? (
        <ProovraSection title="Custody & access">
          {custodyEvents.length === 0 ? (
            <ProovraEmptyState title="No custody events yet" message="The forensic and access timeline for this record will appear here." />
          ) : (
            <ProovraCard>
              {custodyEvents.map((ev) => (
                <ProovraListRow
                  key={`${ev.category}-${ev.sequence}`}
                  title={humanizeEnum(ev.eventType)}
                  subtitle={[ev.summary, ev.atUtc ? formatUserDateTime(ev.atUtc) : null].filter(Boolean).join(" · ") || undefined}
                  trailing={<ProovraBadge tone={ev.category === "forensic" ? "governance" : "neutral"} label={ev.category === "forensic" ? "Forensic" : "Access"} />}
                />
              ))}
            </ProovraCard>
          )}
        </ProovraSection>
      ) : null}

      {tab === "technical" ? (
        <ProovraSection title="Technical metadata">
          {!technical ? (
            <ProovraEmptyState title="No technical metadata" message="Technical metadata for this record isn’t available." />
          ) : (
            <>
              <ProovraCard>
                {technical.primaryMediaType ? <Row k="Media type" v={humanizeEnum(technical.primaryMediaType)} /> : null}
                {technical.resolutionSummary ? <Row k="Resolution" v={technical.resolutionSummary} /> : null}
                {technical.filesTotal !== null ? <Row k="Files analyzed" v={`${technical.filesAnalyzed ?? 0}/${technical.filesTotal}`} /> : null}
                {technical.capture.captureMethod ? <Row k="Capture method" v={humanizeEnum(technical.capture.captureMethod)} /> : null}
                {technical.capture.deviceClass ? <Row k="Device" v={humanizeEnum(technical.capture.deviceClass)} /> : null}
                {technical.capture.osName ? <Row k="OS" v={technical.capture.osName} /> : null}
                {technical.capture.timezone ? <Row k="Timezone" v={technical.capture.timezone} /> : null}
              </ProovraCard>
              {technical.exif && technical.exif.present ? (
                <ProovraCard style={styles.stackCard}>
                  <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>EXIF</ProovraText>
                  {technical.exif.camera ? <Row k="Camera" v={technical.exif.camera} /> : null}
                  {technical.exif.lensModel ? <Row k="Lens" v={technical.exif.lensModel} /> : null}
                  {technical.exif.originalCaptureTime ? <Row k="Captured" v={technical.exif.originalCaptureTime} /> : null}
                  {technical.exif.iso ? <Row k="ISO" v={technical.exif.iso} /> : null}
                  {technical.exif.aperture ? <Row k="Aperture" v={technical.exif.aperture} /> : null}
                  {technical.exif.exposureTime ? <Row k="Exposure" v={technical.exif.exposureTime} /> : null}
                  <Row k="GPS" v={technical.exif.gpsPresent ? "Present" : "Not present"} />
                </ProovraCard>
              ) : null}
            </>
          )}
        </ProovraSection>
      ) : null}

      {tab === "links" ? (
        <ProovraSection title="Related evidence">
          <ProovraCard>
            {relationships.map((rel) => (
              <ProovraListRow
                key={rel.id}
                title={rel.linkedTitle}
                subtitle={[humanizeEnum(rel.relationshipType), rel.direction].filter(Boolean).join(" · ") || undefined}
                trailing={<ProovraBadge tone={evidenceStatusDisplay(rel.linkedStatus).tone} label={evidenceStatusDisplay(rel.linkedStatus).label} />}
                onPress={() => router.push(`/evidence/${rel.linkedId}`)}
              />
            ))}
          </ProovraCard>
        </ProovraSection>
      ) : null}

      {tab === "artifacts" ? (
        <ProovraSection title="Report & artifacts">
          {reportState === "READY" && reportUrl ? (
            <ProovraButton label="Download report" onPress={() => void Linking.openURL(reportUrl)} />
          ) : (
            <ProovraCard>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                {reportStateMessage(reportState)}
              </ProovraText>
            </ProovraCard>
          )}

          {/*
            ONE request produces BOTH artifacts: the verification package is
            built inside the report job. The verb follows the record's state —
            a first generation and a retry produce what the customer is already
            owed, and only a REGENERATION asks first, because only that one
            creates a new immutable version beside an existing one.
          */}
          <ProovraButton
            label={generationActionLabel(reportState === "READY" ? "REGENERATE" : "GENERATE")}
            variant="secondary"
            loading={generating}
            onPress={() => {
              if (generationNeedsConfirmation(reportState === "READY" ? "REGENERATE" : "GENERATE")) {
                setConfirmingRegenerate(true);
              } else {
                void requestGeneration();
              }
            }}
          />

          {generationNote ? (
            // The SERVER's sentence for the outcome it actually returned.
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {generationNote}
            </ProovraText>
          ) : null}
        </ProovraSection>
      ) : null}

      {tab === "internal" && enterpriseSurfaces ? (
        <EvidenceInternalMaterials evidenceId={String(id)} />
      ) : null}

      {tab === "duplicates" ? (
        <ProovraSection title="Duplicate detection">
          {/*
            Shown whether or not anything matched: "no duplicates found"
            without this sentence reads as "there are none", which is a
            stronger claim than the check can support.
          */}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {duplicates?.limitation ?? DUPLICATE_LIMITATION}
          </ProovraText>

          {duplicatesPhase === "loading" ? (
            <ProovraLoadingState label="Checking accessible records" />
          ) : null}

          {duplicatesPhase === "failed" ? (
            <ProovraErrorState
              message="Duplicate detection is unavailable."
              onRetry={() => void loadDuplicates()}
            />
          ) : null}

          {duplicates && duplicates.matches.length === 0 && duplicatesPhase === "idle" ? (
            <ProovraCard>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                No other accessible record matched this one.
              </ProovraText>
            </ProovraCard>
          ) : null}

          {duplicates && duplicates.matches.length > 0 ? (
            <ProovraCard>
              {/*
                Each record appears ONCE, from the grouped view. The legacy
                per-category arrays repeated a record across categories and
                once per matching part, so a single duplicate with eight
                matching parts produced eight identical rows.
              */}
              {duplicates.matches.map((m) => (
                <ProovraListRow
                  key={m.evidenceId}
                  title={m.title}
                  subtitle={[
                    duplicateMatchSummary(m),
                    m.createdAtIso ? formatUserDateTime(m.createdAtIso) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  onPress={() => router.push(`/(stack)/evidence/${m.evidenceId}` as never)}
                />
              ))}
            </ProovraCard>
          ) : null}
        </ProovraSection>
      ) : null}

      <ProovraConfirmSheet
        visible={confirmingRegenerate}
        title="Regenerate the report and package?"
        consequence={REGENERATE_CONSEQUENCE}
        confirmLabel="Regenerate"
        tone="warning"
        busy={generating}
        onConfirm={() => void requestGeneration()}
        onCancel={() => setConfirmingRegenerate(false)}
      />

      {tab === "materials" ? (
        <ProovraSection title="Files in this record">
          {/*
            The record's preserved files. The screen had custody, integrity and
            technical metadata but never listed the files themselves, so on a
            multi-part record — which is what every mixed-media capture
            produces — there was no way to see what was actually in it.

            `downloadable` is the SERVER's decision. A control the server has
            already refused is not offered, and when it cannot be offered the
            reason is shown rather than a button that silently does nothing.
          */}
          <ProovraCard>
            {materials.map((m) => (
              <View key={m.id} style={styles.detailRow}>
                <ProovraText variant="bodySm" weight="semibold">
                  {m.label}
                </ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {[m.kind, m.mimeType, m.sizeLabel].filter(Boolean).join(" · ")}
                </ProovraText>
                {m.representationNote ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {m.representationNote}
                  </ProovraText>
                ) : null}
                {m.sha256 ? (
                  <ProovraText variant="label" mono numberOfLines={1} color={theme.color.ink.muted}>
                    {m.sha256}
                  </ProovraText>
                ) : null}
                {materialBlockedReason(m) ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {materialBlockedReason(m)}
                  </ProovraText>
                ) : (
                  <ProovraButton
                    label="Open file"
                    variant="secondary"
                    fullWidth={false}
                    onPress={() => void Linking.openURL(m.viewUrl as string)}
                  />
                )}
              </View>
            ))}
          </ProovraCard>
        </ProovraSection>
      ) : null}

      {tab === "discussion" ? (
        <ProovraSection title="Reviewer comments">
          {/*
            A record under review is discussed by the people reviewing it, and
            that conversation lived only on the web — a reviewer on a phone
            could read every hash and custody event and not a single word
            anyone had said about them.

            Visibility defaults to workspace-only. A comment that turns out to
            be wider than its author intended cannot be un-seen, so the default
            is the narrow one and the choice is explicit.
          */}
          {comments === null ? (
            <ProovraLoadingState label="Loading comments" />
          ) : comments.length === 0 ? (
            <ProovraCard>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                No comments on this record yet.
              </ProovraText>
            </ProovraCard>
          ) : (
            <ProovraCard>
              {comments.map((c) => (
                <View key={c.id} style={styles.detailRow}>
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {[
                      c.authorName,
                      c.createdAtIso ? formatUserDateTime(c.createdAtIso) : null,
                      commentVisibilityLabel(c.visibility),
                      c.edited ? "edited" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </ProovraText>
                  <ProovraText variant="bodySm">{c.body}</ProovraText>
                </View>
              ))}
            </ProovraCard>
          )}

          <ProovraCard>
            <ProovraFormField label="Add a comment">
              <ProovraInput
                value={draft}
                onChangeText={setDraft}
                placeholder="What should a reviewer know?"
                multiline
                autoCapitalize="sentences"
                accessibilityLabel="Add a comment"
              />
            </ProovraFormField>
            <ProovraFilterChips
              label="Visible to"
              value={visibility}
              onChange={(v: string) => setVisibility(v as EvidenceCommentVisibility)}
              options={EVIDENCE_COMMENT_VISIBILITIES.map((v) => ({
                value: v,
                label: commentVisibilityLabel(v),
              }))}
            />
            <ProovraButton
              label="Post comment"
              loading={commentBusy}
              disabled={!isSendableComment(draft)}
              onPress={() => void postComment()}
            />
          </ProovraCard>
        </ProovraSection>
      ) : null}

      {tab === "derived" ? (
        <DerivedReviewTab evidenceId={String(id)} teamId={platform.context?.activeTeamId ?? null} />
      ) : null}
    </ProovraScreen>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {k}
      </ProovraText>
      <ProovraText variant="bodySm" mono={mono} numberOfLines={mono ? 2 : 1} style={styles.detailValue}>
        {v}
      </ProovraText>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  hero: { marginBottom: theme.space.s4 },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  heroTitle: { marginTop: theme.space.s2 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s4 },
  tab: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 36, justifyContent: "center" },
  detailRow: { paddingVertical: theme.space.s2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.subtle, gap: 2 },
  detailValue: { marginTop: 2 },
  actions: { marginTop: theme.space.s4, gap: theme.space.s2 },
  note: { marginTop: theme.space.s3 },
  stackCard: { marginTop: theme.space.s3, gap: theme.space.s1 },
});
