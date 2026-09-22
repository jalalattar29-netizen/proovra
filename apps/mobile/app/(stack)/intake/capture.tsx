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
import { useCallback, useState } from "react";
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
} from "../../../src/ui";
import {
  buildIntakePartBody,
  buildIntakePartsPath,
  buildIntakeSubmitBody,
  buildIntakeSubmitPath,
  canAddIntakePart,
  classifyIntakeFailure,
  intakeFailureMessage,
  parseIntakePartUpload,
  INTAKE_MAX_PARTS,
} from "../../../src/product/external-intake";

type Staged = {
  uri: string;
  name: string;
  mimeType: string;
  size: number | null;
  /** null until the part has been sent. */
  sent: boolean;
};

export default function IntakeCaptureScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[]; sid?: string | string[] }>();
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const token = one(params.token);
  const sessionId = one(params.sid);

  const [staged, setStaged] = useState<Staged[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

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
    }));
    setStaged((prev) => [...prev, ...next]);
  }, [staged.length]);

  const send = useCallback(async () => {
    if (!token || !sessionId || staged.length === 0) return;
    setBusy(true);
    setError(null);
    try {
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
            }),
          ),
        });

        const upload = parseIntakePartUpload(declared);
        if (upload.uploadUrl) {
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

        setStaged((prev) => prev.map((s, idx) => (idx === i ? { ...s, sent: true } : s)));
      }

      await publicFetch(buildIntakeSubmitPath(token, sessionId), {
        method: "POST",
        // No location is offered here: this link's template decides whether a
        // position is wanted, and asking for one the workspace never requested
        // is a request for data it cannot justify holding.
        body: JSON.stringify(buildIntakeSubmitBody({ location: null })),
      });
      setSubmitted(true);
    } catch (err) {
      setError(intakeFailureMessage(classifyIntakeFailure(err)));
    } finally {
      setBusy(false);
    }
  }, [token, sessionId, staged]);

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
                  <View
                    key={`${s.uri}-${i}`}
                    style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}
                  >
                    <ProovraText variant="bodySm" numberOfLines={1}>
                      {s.name}
                    </ProovraText>
                    <ProovraBadge label={s.sent ? "Sent" : "Ready"} tone={s.sent ? "verified" : "neutral"} />
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

          {error ? (
            <ProovraText variant="label" color={theme.color.status.risk.fg}>
              {error}
            </ProovraText>
          ) : null}

          <ProovraButton
            label="Send"
            loading={busy}
            disabled={staged.length === 0}
            onPress={() => void send()}
          />
        </>
      )}
    </ProovraScreen>
  );
}
