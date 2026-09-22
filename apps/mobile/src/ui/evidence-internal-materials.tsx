/**
 * INTERNAL MATERIALS — legal notes and annotations on an evidence record.
 *
 * Ports `LegalNotesPanel` and `AnnotationPanel` from
 * `apps/web/app/(app)/evidence/components/`.
 *
 * THE BOUNDARY IS RENDERED FIRST, NOT LAST
 * These are internal workspace materials: not in public verification, not in
 * the fixed PDF report, not in the verification package. A note sitting beside
 * hashes and custody events reads as part of the evidence record unless
 * something says it is not, so the sentence leads the section rather than
 * trailing it.
 *
 * Shown only when the SERVER-projected enterprise gate says so — the same
 * `isPlatformAdmin || isEnterpriseWorkspace` the web reads. Absent is false,
 * which withholds rather than offers.
 *
 * A phone writes TEXT annotations with a TIME_ONLY anchor and READS every
 * type. A coordinate guessed from a thumbnail would be a claim about where in
 * the evidence something is; this product does not invent those.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { formatUserDateTime } from "../lib/date";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import {
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraFormField,
  ProovraListRow,
  ProovraSection,
  ProovraSheet,
  ProovraLoadingState,
  ProovraEmpty,
} from "./index";
import {
  ANNOTATION_BODY_MAX,
  INTERNAL_MATERIALS_BOUNDARY,
  LEGAL_NOTE_MAX,
  annotationAnchorLabel,
  annotationTypeLabel,
  buildAnnotationBody,
  buildAnnotationPath,
  buildAnnotationsPath,
  buildLegalNoteBody,
  buildLegalNotePath,
  buildLegalNotesPath,
  legalNoteIsPrivileged,
  legalNoteTypeLabel,
  parseAnnotations,
  parseLegalNotes,
  validateAnnotation,
  validateLegalNote,
  type EvidenceAnnotation,
  type LegalNote,
} from "../product/evidence-detail";
import { EVIDENCE_LEGAL_NOTE_TYPES } from "../product/domain-enums.generated";

export function EvidenceInternalMaterials({ evidenceId }: { evidenceId: string }) {
  const [notes, setNotes] = useState<LegalNote[] | null>(null);
  const [annotations, setAnnotations] = useState<EvidenceAnnotation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [noteDraft, setNoteDraft] = useState("");
  const [noteType, setNoteType] = useState<string>("GENERAL");
  const [typePicker, setTypePicker] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState("");

  const load = useCallback(async () => {
    // Independent: a refusal on one must not hide the other.
    await Promise.all([
      apiFetch(buildLegalNotesPath(evidenceId))
        .then((d) => setNotes(parseLegalNotes(d)))
        .catch(() => setNotes(null)),
      apiFetch(buildAnnotationsPath(evidenceId))
        .then((d) => setAnnotations(parseAnnotations(d)))
        .catch(() => setAnnotations(null)),
    ]);
  }, [evidenceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addNote = useCallback(async () => {
    const invalid = validateLegalNote(noteDraft);
    if (invalid) {
      setMessage(invalid);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(buildLegalNotesPath(evidenceId), {
        method: "POST",
        body: JSON.stringify(buildLegalNoteBody(noteDraft, noteType)),
      });
      setNoteDraft("");
      await load();
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [evidenceId, noteDraft, noteType, load]);

  const deleteNote = useCallback(
    async (note: LegalNote) => {
      setBusy(true);
      setMessage(null);
      try {
        await apiFetch(buildLegalNotePath(evidenceId, note.id), { method: "DELETE" });
        await load();
      } catch (err) {
        setMessage(toSafeUserError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [evidenceId, load],
  );

  const addAnnotation = useCallback(async () => {
    const invalid = validateAnnotation(annotationDraft);
    if (invalid) {
      setMessage(invalid);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(buildAnnotationsPath(evidenceId), {
        method: "POST",
        body: JSON.stringify(buildAnnotationBody(annotationDraft)),
      });
      setAnnotationDraft("");
      await load();
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [evidenceId, annotationDraft, load]);

  const deleteAnnotation = useCallback(
    async (a: EvidenceAnnotation) => {
      setBusy(true);
      setMessage(null);
      try {
        await apiFetch(buildAnnotationPath(evidenceId, a.id), { method: "DELETE" });
        await load();
      } catch (err) {
        setMessage(toSafeUserError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [evidenceId, load],
  );

  return (
    <ProovraSection title="Internal materials">
      {/* Leads the section. A note beside hashes reads as part of the record. */}
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {INTERNAL_MATERIALS_BOUNDARY}
      </ProovraText>

      {message ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {message}
        </ProovraText>
      ) : null}

      {/* -------------------------------------------------------- legal notes */}
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
        Legal notes
      </ProovraText>

      {notes === null ? (
        <ProovraEmpty
          presence="inline"
          title="Legal notes are not available for this record."
        />
      ) : (
        <>
          <ProovraCard>
            <ProovraListRow
              title="Note type"
              subtitle={legalNoteTypeLabel(noteType)}
              onPress={() => setTypePicker(true)}
            />
            <ProovraFormField label="Note">
              <ProovraInput
                value={noteDraft}
                onChangeText={setNoteDraft}
                placeholder={`Up to ${LEGAL_NOTE_MAX} characters`}
                autoCapitalize="sentences"
                multiline
                accessibilityLabel="Legal note"
              />
            </ProovraFormField>
            <ProovraButton
              label="Add legal note"
              loading={busy}
              disabled={validateLegalNote(noteDraft) !== null}
              onPress={() => void addNote()}
            />
          </ProovraCard>

          {notes.length === 0 ? (
            <ProovraEmpty presence="inline" title="No legal notes on this record." />
          ) : (
            <ProovraCard>
              {notes.map((n) => (
                <View key={n.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: theme.space.s2,
                    }}
                  >
                    {/*
                      Privilege is a claim with consequences, so it is on the
                      ROW rather than only in a header somebody scrolled past.
                    */}
                    <ProovraBadge
                      label={legalNoteTypeLabel(n.noteType)}
                      tone={legalNoteIsPrivileged(n.noteType) ? "risk" : "governance"}
                    />
                    <ProovraButton
                      label="Delete"
                      variant="ghost"
                      fullWidth={false}
                      loading={busy}
                      onPress={() => void deleteNote(n)}
                    />
                  </View>
                  <ProovraText variant="bodySm">{n.body}</ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {[
                      // A raw user id is not an author.
                      n.authorLabel,
                      n.createdAtIso ? formatUserDateTime(n.createdAtIso) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </ProovraText>
                </View>
              ))}
            </ProovraCard>
          )}
        </>
      )}

      {/* -------------------------------------------------------- annotations */}
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
        Annotations
      </ProovraText>

      {annotations === null ? (
        <ProovraEmpty
          presence="inline"
          title="Annotations are not available for this record."
        />
      ) : (
        <>
          <ProovraCard>
            <ProovraFormField label="Annotation">
              <ProovraInput
                value={annotationDraft}
                onChangeText={setAnnotationDraft}
                placeholder={`Up to ${ANNOTATION_BODY_MAX} characters`}
                autoCapitalize="sentences"
                multiline
                accessibilityLabel="Annotation"
              />
            </ProovraFormField>
            {/*
              A phone writes a TEXT annotation about the record. Placing a
              point or a box needs the media rendered at a known scale, and a
              coordinate guessed from a thumbnail would be a claim about WHERE
              in the evidence something is. Every type is read and shown.
            */}
            <ProovraText variant="label" color={theme.color.ink.muted}>
              An annotation written here is about the record, not a point on the media.
            </ProovraText>
            <ProovraButton
              label="Add annotation"
              loading={busy}
              disabled={validateAnnotation(annotationDraft) !== null}
              onPress={() => void addAnnotation()}
            />
          </ProovraCard>

          {annotations.length === 0 ? (
            <ProovraEmpty presence="inline" title="No annotations on this record." />
          ) : (
            <ProovraCard>
              {annotations.map((a) => (
                <View key={a.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: theme.space.s2,
                    }}
                  >
                    <ProovraBadge label={annotationTypeLabel(a.annotationType)} tone="neutral" />
                    <ProovraButton
                      label="Delete"
                      variant="ghost"
                      fullWidth={false}
                      loading={busy}
                      onPress={() => void deleteAnnotation(a)}
                    />
                  </View>
                  {a.body ? <ProovraText variant="bodySm">{a.body}</ProovraText> : null}
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {[
                      annotationAnchorLabel(a),
                      a.authorLabel,
                      a.createdAtIso ? formatUserDateTime(a.createdAtIso) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </ProovraText>
                </View>
              ))}
            </ProovraCard>
          )}
        </>
      )}

      {notes === null && annotations === null ? (
        <ProovraLoadingState label="Loading internal materials" />
      ) : null}

      <ProovraSheet visible={typePicker} title="Note type" onClose={() => setTypePicker(false)}>
        {EVIDENCE_LEGAL_NOTE_TYPES.map((t) => (
          <ProovraListRow
            key={t}
            title={legalNoteTypeLabel(t)}
            subtitle={t === noteType ? "Current" : undefined}
            onPress={() => {
              setNoteType(t);
              setTypePicker(false);
            }}
          />
        ))}
      </ProovraSheet>
    </ProovraSection>
  );
}
