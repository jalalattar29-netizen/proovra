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
  PRIVATE_NOTES_BOUNDARY,
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

/**
 * Loading, failed and empty are three different things.
 *
 * Collapsing them onto one `null` made the section state "not available for
 * this record" while the first fetch was still in flight, and made an
 * authorization refusal look the same as a record that genuinely has no
 * notes. In an evidence product the difference between "none" and "we could
 * not read them" is the whole point of showing it.
 */
type ListState<T> =
  | { status: "loading" }
  | { status: "failed"; reason: string }
  | { status: "ready"; items: T[] };

export function EvidenceInternalMaterials({ evidenceId }: { evidenceId: string }) {
  const [notes, setNotes] = useState<ListState<LegalNote>>({ status: "loading" });
  const [annotations, setAnnotations] = useState<ListState<EvidenceAnnotation>>({
    status: "loading",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [noteDraft, setNoteDraft] = useState("");
  const [noteType, setNoteType] = useState<string>("GENERAL");
  // Which draft the type sheet sets: the new note or the one being edited.
  const [typePicker, setTypePicker] = useState<"new" | "edit" | null>(null);
  // T-12 — editing an existing note (LegalNotesPanel.tsx:112; PATCH …/legal-notes/:id).
  const [editing, setEditing] = useState<{ id: string; body: string; noteType: string } | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState("");

  const load = useCallback(async () => {
    setNotes({ status: "loading" });
    setAnnotations({ status: "loading" });
    // Independent: a refusal on one must not hide the other.
    await Promise.all([
      apiFetch(buildLegalNotesPath(evidenceId))
        .then((d) => setNotes({ status: "ready", items: parseLegalNotes(d) }))
        // Covers an authorization refusal, a transport failure AND a response
        // this build cannot read - parseLegalNotes throws on an envelope that
        // is not the contract rather than reporting an empty list.
        .catch((err) => setNotes({ status: "failed", reason: toSafeUserError(err).message })),
      apiFetch(buildAnnotationsPath(evidenceId))
        .then((d) => setAnnotations({ status: "ready", items: parseAnnotations(d) }))
        .catch((err) =>
          setAnnotations({ status: "failed", reason: toSafeUserError(err).message }),
        ),
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

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    const invalid = validateLegalNote(editing.body);
    if (invalid) {
      setMessage(invalid);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(buildLegalNotePath(evidenceId, editing.id), {
        method: "PATCH",
        body: JSON.stringify(buildLegalNoteBody(editing.body, editing.noteType)),
      });
      setEditing(null);
      await load();
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [evidenceId, editing, load]);

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
      {/* The web's Boundary callout on private notes (EvidenceReviewTab.tsx:287). */}
      <View testID="private-notes-boundary">
        <ProovraText variant="label" weight="semibold">Boundary</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>{PRIVATE_NOTES_BOUNDARY}</ProovraText>
      </View>
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
      <ProovraText variant="label" color={theme.color.ink.muted}>
        Legal notes are internal workspace notes. They do not determine legal outcome or evidentiary weight.
      </ProovraText>

      {notes.status === "loading" ? null : notes.status === "failed" ? (
        <ProovraEmpty
          presence="inline"
          title="Legal notes could not be loaded."
          purpose={notes.reason}
          action={
            <ProovraButton
              label="Try again"
              variant="secondary"
              fullWidth={false}
              onPress={() => void load()}
            />
          }
        />
      ) : (
        <>
          <ProovraCard>
            <ProovraListRow
              title="Note type"
              subtitle={legalNoteTypeLabel(noteType)}
              onPress={() => setTypePicker("new")}
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

          {notes.items.length === 0 ? (
            <ProovraEmpty presence="inline" title="No legal notes on this record." />
          ) : (
            <ProovraCard>
              {notes.items.map((n) => (
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
                    <View style={{ flexDirection: "row", gap: theme.space.s1 }}>
                      <ProovraButton
                        label="Edit"
                        accessibilityLabel={`Edit legal note: ${legalNoteTypeLabel(n.noteType)}`}
                        variant="ghost"
                        fullWidth={false}
                        disabled={busy}
                        onPress={() => setEditing({ id: n.id, body: n.body, noteType: n.noteType })}
                      />
                      <ProovraButton
                        label="Delete"
                        variant="ghost"
                        fullWidth={false}
                        loading={busy}
                        onPress={() => void deleteNote(n)}
                      />
                    </View>
                  </View>
                  {editing?.id === n.id ? (
                    <View style={{ gap: theme.space.s2 }}>
                      <ProovraListRow
                        title="Legal note type"
                        subtitle={legalNoteTypeLabel(editing.noteType)}
                        onPress={() => setTypePicker("edit")}
                      />
                      <ProovraInput
                        value={editing.body}
                        onChangeText={(t) => setEditing((e) => (e ? { ...e, body: t } : e))}
                        multiline
                        accessibilityLabel="Edit legal note text"
                      />
                      <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
                        <ProovraButton
                          label="Save"
                          fullWidth={false}
                          loading={busy}
                          disabled={validateLegalNote(editing.body) !== null}
                          onPress={() => void saveEdit()}
                        />
                        <ProovraButton label="Cancel" variant="ghost" fullWidth={false} onPress={() => setEditing(null)} />
                      </View>
                    </View>
                  ) : (
                    <ProovraText variant="bodySm">{n.body}</ProovraText>
                  )}
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
      <ProovraText variant="label" color={theme.color.ink.muted}>
        Annotations are reviewer notes layered over the review surface. They do not modify preserved evidence.
      </ProovraText>

      {annotations.status === "loading" ? null : annotations.status === "failed" ? (
        <ProovraEmpty
          presence="inline"
          title="Annotations could not be loaded."
          purpose={annotations.reason}
          action={
            <ProovraButton
              label="Try again"
              variant="secondary"
              fullWidth={false}
              onPress={() => void load()}
            />
          }
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
              label="Add Text Annotation"
              loading={busy}
              disabled={validateAnnotation(annotationDraft) !== null}
              onPress={() => void addAnnotation()}
            />
          </ProovraCard>

          {annotations.items.length === 0 ? (
            <ProovraEmpty presence="inline" title="No annotations on this record." />
          ) : (
            <ProovraCard>
              {annotations.items.map((a) => (
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

      {notes.status === "loading" || annotations.status === "loading" ? (
        <ProovraLoadingState label="Loading internal materials" />
      ) : null}

      <ProovraSheet visible={typePicker !== null} title="Note type" onClose={() => setTypePicker(null)}>
        {EVIDENCE_LEGAL_NOTE_TYPES.map((t) => {
          const current = typePicker === "edit" ? editing?.noteType : noteType;
          return (
            <ProovraListRow
              key={t}
              title={legalNoteTypeLabel(t)}
              subtitle={t === current ? "Current" : undefined}
              onPress={() => {
                if (typePicker === "edit") setEditing((e) => (e ? { ...e, noteType: t } : e));
                else setNoteType(t);
                setTypePicker(null);
              }}
            />
          );
        })}
      </ProovraSheet>
    </ProovraSection>
  );
}
