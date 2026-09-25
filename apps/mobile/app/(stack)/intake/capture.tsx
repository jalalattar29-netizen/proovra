/**
 * EXTERNAL INTAKE CAPTURE — the native port of
 * `apps/web/app/intake/[token]/capture`.
 *
 * The contributor picks files and sends them. Two things make this different
 * from the app's own Capture, and both are deliberate:
 *
 *   - it does NOT run the authenticated capture orchestration. The web page
 *     says so: uploads go straight to storage via presigned PUT URLs from the
 *     public API. Routing a contributor through the signed-in lifecycle would
 *     attribute their upload to whoever is logged in on this device;
 *   - it opens no capture DRAFT. There is no Evidence record to hold, because
 *     the workspace creates one when the session is submitted.
 *
 * The integrity digest is still computed on device, through the same
 * `computeFileIntegrity` the app uses everywhere, so a contributor's file
 * carries a hash from the moment it leaves their phone.
 */
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";

import { publicFetch } from "../../../src/api";
import { computeFileIntegrity, uploadWithPut } from "../../../src/upload-utils";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraPageHeader,
  ProovraEmpty,
  ProovraFilterChips,
} from "../../../src/ui";
import {
  buildIntakePartBody,
  buildIntakePartsPath,
  buildIntakePartStepPath,
  buildIntakeSubmitBody,
  buildIntakeSubmitPath,
  canAddIntakePart,
  intakeSendFailureMessage,
  intakeSubmitFailureMessage,
  intakeSupportId,
  intakeCaptureContext,
  intakeRequiredStepsMissing,
  parseIntakeCaptureSteps,
  parseIntakePartUpload,
  INTAKE_MAX_PARTS,
  INTAKE_LOCATION_COPY as LOC,
  intakeDeviceTime,
  intakeLocationBody,
  type IntakeLocationState,
} from "../../../src/product/external-intake";
import * as Location from "expo-location";

type Staged = {
  uri: string;
  name: string;
  mimeType: string;
  size: number | null;
  /** null until the part has been sent. */
  sent: boolean;
  /** The server's part id once declared — what a later step change PATCHes. */
  partId: string | null;
  /** The checklist step this file is assigned to (web StagedPart.checklistStepId). */
  stepId: string | null;
};

export default function IntakeCaptureScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    token?: string | string[];
    sid?: string | string[];
    loc?: string | string[];
    plan?: string | string[];
    steps?: string | string[];
  }>();
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const token = one(params.token);
  const sessionId = one(params.sid);
  // The LINK's location policy, handed over by the landing screen. The server
  // enforces it at submit either way; this only decides what to ask.
  const policy: "REQUIRED" | "OPTIONAL" | "NONE" = (() => {
    const v = (one(params.loc) ?? "").toUpperCase();
    return v === "REQUIRED" || v === "OPTIONAL" ? v : "NONE";
  })();
  // The link's checklist, handed over by the landing (it cannot be re-read here:
  // validating the token again would open a second session).
  const planMode = one(params.plan) ?? null;
  const stepsParam = one(params.steps);
  const steps = useMemo(() => parseIntakeCaptureSteps(stepsParam), [stepsParam]);
  const [location, setLocation] = useState<IntakeLocationState>({ phase: "idle" });
  const locationBlocksSubmit = policy === "REQUIRED" && location.phase !== "granted";

  // The device is asked ONLY from this tap — never on screen load (web page.tsx:527-531).
  const shareLocation = useCallback(async () => {
    setLocation({ phase: "requesting" });
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        setLocation({ phase: "denied" });
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setLocation({
        phase: "granted",
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyMeters: typeof pos.coords.accuracy === "number" ? pos.coords.accuracy : null,
        capturedAt: new Date(pos.timestamp || Date.now()).toISOString(),
      });
    } catch {
      setLocation({ phase: "unavailable", reason: LOC.unavailable });
    }
  }, []);

  const [staged, setStaged] = useState<Staged[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Offered only for a genuine server fault, never for a refusal (web SupportReference). */
  const [supportId, setSupportId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const fail = useCallback((message: string, err: unknown) => {
    setError(message);
    setSupportId(intakeSupportId(err));
  }, []);

  // The web's requiredStepsMissing: a CHECKLIST_REQUIRED link refuses a submit
  // whose required steps have no file, so Send says so before the server does.
  const requiredMissing = intakeRequiredStepsMissing(planMode, steps, staged.map((s) => s.stepId));

  const pick = useCallback(async () => {
    if (!canAddIntakePart(staged.length)) return;
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (res.canceled) return;

    const room = INTAKE_MAX_PARTS - staged.length;
    const next = res.assets.slice(0, room).map((a) => ({
      uri: a.uri,
      name: a.name ?? "file",
      mimeType: a.mimeType ?? "application/octet-stream",
      size: typeof a.size === "number" ? a.size : null,
      sent: false,
      partId: null,
      stepId: null,
    }));
    setStaged((prev) => [...prev, ...next]);
  }, [staged.length]);

  // Assigning a file to a step: an unsent file carries it in its parts POST; a
  // sent one is re-mapped with the web's PATCH …/parts/:partId (setPartStep).
  const assignStep = useCallback(
    async (index: number, stepId: string) => {
      const item = staged[index];
      if (!item || !token || !sessionId) return;
      const next = stepId || null;
      if (item.sent && item.partId) {
        try {
          await publicFetch(buildIntakePartStepPath(token, sessionId, item.partId), {
            method: "PATCH",
            body: JSON.stringify({ checklistStepId: next }),
          });
        } catch (err) {
          fail(intakeSendFailureMessage(err), err);
          return;
        }
      }
      setStaged((prev) => prev.map((s, idx) => (idx === index ? { ...s, stepId: next } : s)));
    },
    [staged, token, sessionId, fail],
  );

  const send = useCallback(async () => {
    if (!token || !sessionId || staged.length === 0 || locationBlocksSubmit || requiredMissing.length > 0) return;
    setBusy(true);
    setError(null);
    setSupportId(null);
    let submitting = false;
    try {
      const context = intakeCaptureContext();
      for (let i = 0; i < staged.length; i++) {
        const item = staged[i];
        if (item.sent) continue;

        // The same on-device digest the app computes everywhere else, so a
        // contributor's file carries a hash from the moment it leaves their
        // phone rather than being hashed only after it arrives.
        const integrity = await computeFileIntegrity(item.uri);

        const declared = await publicFetch(buildIntakePartsPath(token, sessionId), {
          method: "POST",
          body: JSON.stringify(
            buildIntakePartBody({
              partIndex: i,
              mimeType: item.mimeType,
              originalFileName: item.name,
              checksumSha256Base64: integrity.checksumSha256Base64,
              contentMd5Base64: integrity.contentMd5Base64,
              checklistStepId: item.stepId,
              captureTimezone: context.captureTimezone,
              captureLocale: context.captureLocale,
            }),
          ),
        });

        const upload = parseIntakePartUpload(declared);
        // No upload URL is a failure, never a silent skip: marking an item
        // "sent" without its bytes, then submitting, filed an empty submission.
        if (!upload.uploadUrl) throw new Error("The upload could not be started for this file.");
        {
          // Straight to storage, outside the authenticated orchestration —
          // through the SAME canonical PUT helper the app uses for its own
          // uploads, so a contributor's bytes travel the one path that has
          // been proven to stream a large file without loading it into memory.
          await uploadWithPut({
            putUrl: upload.uploadUrl,
            uri: item.uri,
            mimeType: item.mimeType,
            checksumSha256Base64: integrity.checksumSha256Base64,
            contentMd5Base64: integrity.contentMd5Base64,
          });
        }

        setStaged((prev) => prev.map((s, idx) => (idx === i ? { ...s, sent: true, partId: upload.partId } : s)));
      }

      submitting = true;
      await publicFetch(buildIntakeSubmitPath(token, sessionId), {
        method: "POST",
        // The link's policy decides: NONE sends no location at all; OPTIONAL and
        // REQUIRED send the consent state (+ coordinates only when granted).
        body: JSON.stringify(buildIntakeSubmitBody({ location: intakeLocationBody(policy, location), deviceTime: intakeDeviceTime() })),
      });
      setSubmitted(true);
    } catch (err) {
      // The server's own reason, not a link-level guess (see intakeSendFailureMessage);
      // a refused submit names the missing steps (intakeSubmitFailureMessage).
      fail(submitting ? intakeSubmitFailureMessage(err, steps) : intakeSendFailureMessage(err), err);
    } finally {
      setBusy(false);
    }
  }, [token, sessionId, staged, locationBlocksSubmit, requiredMissing.length, policy, location, steps, fail]);

  if (!token || !sessionId) {
    return (
      <ProovraScreen testID="intake-capture">
        <ProovraPageHeader title="Add files" eyebrow="Secure intake" />
        <ProovraEmpty
          presence="page"
          title="This step is not open"
          purpose="Open the link you were sent and start again from there."
        />
      </ProovraScreen>
    );
  }

  return (
    <ProovraScreen testID="intake-capture">
      <ProovraPageHeader
        title="Add files"
        eyebrow="Secure intake"
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {submitted ? (
        <ProovraCard>
          <ProovraText variant="body">
            Thank you — what you sent has been received and preserved.
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            You can close this now. The organization that asked for it will be in touch if they
            need anything else.
          </ProovraText>
          <ProovraButton label="Done" onPress={() => router.replace("/")} />
        </ProovraCard>
      ) : (
        <>
          <ProovraCard>
            {staged.length === 0 ? (
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Nothing added yet.
              </ProovraText>
            ) : (
              <View style={{ gap: theme.space.s2 }}>
                {staged.map((s, i) => (
                  <View key={`${s.uri}-${i}`} style={{ gap: theme.space.s1 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
                      <ProovraText variant="bodySm" numberOfLines={1}>
                        {s.name}
                      </ProovraText>
                      <ProovraBadge label={s.sent ? "Sent" : "Ready"} tone={s.sent ? "verified" : "neutral"} />
                    </View>
                    {/* The web's per-file "Map to step…" select, as chips. */}
                    {steps.length > 0 ? (
                      <ProovraFilterChips
                        label={`Step for ${s.name}`}
                        value={s.stepId ?? ""}
                        disabled={busy}
                        onChange={(v) => void assignStep(i, v)}
                        options={[
                          { value: "", label: "Map to step…" },
                          ...steps.map((st) => ({ value: st.id, label: `${st.purposeLabel}${st.required ? " *" : ""}` })),
                        ]}
                      />
                    ) : null}
                  </View>
                ))}
              </View>
            )}

            <ProovraButton
              label="Choose files"
              variant="secondary"
              disabled={busy || !canAddIntakePart(staged.length)}
              onPress={() => void pick()}
            />
            {!canAddIntakePart(staged.length) ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {`You can send up to ${INTAKE_MAX_PARTS} files in one submission.`}
              </ProovraText>
            ) : null}
          </ProovraCard>

          {/* The web LocationCard — only when the link asks (NONE shows nothing). */}
          {policy !== "NONE" ? (
            <ProovraCard testID="intake-location-card">
              <ProovraText variant="bodySm" weight="semibold">{policy === "REQUIRED" ? LOC.requiredTitle : LOC.optionalTitle}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{policy === "REQUIRED" ? LOC.requiredBody : LOC.optionalBody}</ProovraText>
              {location.phase === "idle" ? (
                <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }}>
                  <ProovraButton label={LOC.share} variant="secondary" fullWidth={false} onPress={() => void shareLocation()} />
                  {policy !== "REQUIRED" ? <ProovraButton label={LOC.skip} variant="ghost" fullWidth={false} onPress={() => setLocation({ phase: "denied" })} /> : null}
                </View>
              ) : null}
              {location.phase === "requesting" ? <ProovraText variant="label" color={theme.color.ink.muted}>{LOC.requesting}</ProovraText> : null}
              {location.phase === "granted" ? (
                <ProovraText variant="label" color={theme.color.status.verified.fg}>
                  {`${LOC.captured}${location.accuracyMeters != null ? ` (accuracy ${Math.round(location.accuracyMeters)} m).` : "."}`}
                </ProovraText>
              ) : null}
              {location.phase === "denied" ? (
                <View style={{ gap: theme.space.s1 }}>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>{policy === "REQUIRED" ? LOC.deniedRequired : LOC.deniedOptional}</ProovraText>
                  {policy === "REQUIRED" ? <ProovraButton label={LOC.share} variant="secondary" fullWidth={false} onPress={() => void shareLocation()} /> : null}
                </View>
              ) : null}
              {location.phase === "unavailable" ? <ProovraText variant="label" color={theme.color.ink.secondary}>{location.reason}</ProovraText> : null}
            </ProovraCard>
          ) : null}

          {requiredMissing.length > 0 ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {`Still needed: ${requiredMissing.map((m) => m.purposeLabel).join(", ")}`}
            </ProovraText>
          ) : null}

          {error ? (
            <ProovraText variant="label" color={theme.color.status.risk.fg}>
              {error}
            </ProovraText>
          ) : null}
          {supportId ? (
            <ProovraText variant="label" mono selectable color={theme.color.ink.muted} testID="intake-support-id">
              {`Support ID: ${supportId}`}
            </ProovraText>
          ) : null}
          {requiredMissing.length > 0 && staged.length > 0 ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {`Assign a file to: ${requiredMissing.map((m) => m.purposeLabel).join(", ")}.`}
            </ProovraText>
          ) : null}
          {locationBlocksSubmit && staged.length > 0 ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>{LOC.blocksSubmit}</ProovraText>
          ) : null}

          <ProovraButton
            label="Send"
            loading={busy}
            disabled={staged.length === 0 || locationBlocksSubmit || requiredMissing.length > 0}
            onPress={() => void send()}
          />
        </>
      )}
    </ProovraScreen>
  );
}
