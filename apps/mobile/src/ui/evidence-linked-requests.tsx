/**
 * LINKED EVIDENCE REQUESTS (T-12 / RC-13) — see
 * src/product/evidence-linked-requests.ts for the contract.
 *
 * Touch adaptations: the create dialog becomes a bottom sheet; listboxes
 * become chips; each request row opens the native request screen, which
 * carries the per-request actions the web panel renders inline.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import { requestStatusDisplay } from "../product/evidence-requests";
import {
  EVIDENCE_REQUESTS_CREATE_PATH,
  LINKED_REQUESTS_COPY,
  RECIPIENT_MODE_OPTIONS,
  REQUEST_PRIORITY_OPTIONS,
  REQUEST_TYPE_OPTIONS,
  buildLinkedRequestsPath,
  buildRequestCreateBody,
  emptyRequestDraft,
  isRequestsFeatureDisabled,
  linkedRequestSubtitle,
  parseLinkedRequests,
  requestDraftError,
  type LinkedRequest,
  type RequestDraft,
} from "../product/evidence-linked-requests";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraListRow, ProovraSection, ProovraText } from "./index";
import { ProovraFilterChips, ProovraSheet } from "./patterns";

export function EvidenceLinkedRequests({
  evidenceId,
  teamId,
  workspaceName,
}: {
  evidenceId: string;
  teamId: string;
  workspaceName: string | null;
}) {
  const router = useRouter();
  const [requests, setRequests] = useState<LinkedRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setRequests(parseLinkedRequests(await apiFetch(buildLinkedRequestsPath(teamId, evidenceId))));
      setError(null);
      setDisabled(false);
    } catch (err) {
      if (isRequestsFeatureDisabled(err)) {
        setDisabled(true);
        setRequests([]);
        return;
      }
      setError(toSafeUserError(err, { message: LINKED_REQUESTS_COPY.loadFailed }).message);
    }
  }, [teamId, evidenceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The feature is off at the server: the record stays clean, nothing else is blocked.
  if (disabled) return null;

  return (
    <ProovraSection title={LINKED_REQUESTS_COPY.title}>
      <ProovraCard>
        <View style={{ gap: theme.space.s3 }} testID="evidence-linked-requests">
          <ProovraButton label="New request" fullWidth={false} onPress={() => setCreating(true)} />
          {error ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{error}</ProovraText> : null}
          {requests !== null && requests.length === 0 && !error ? (
            <ProovraText variant="bodySm" color={theme.color.ink.muted}>{LINKED_REQUESTS_COPY.empty}</ProovraText>
          ) : null}
          {requests?.map((r) => {
            const st = requestStatusDisplay(r.status);
            return (
              <ProovraListRow
                key={r.id}
                title={r.title}
                subtitle={[linkedRequestSubtitle(r), r.dueAtUtc ? `Due ${formatUserDateTime(r.dueAtUtc)}` : null].filter(Boolean).join(" · ")}
                trailing={<ProovraBadge tone={st.tone} label={st.label} />}
                onPress={() => router.push(`/(stack)/evidence-request/${encodeURIComponent(r.id)}`)}
              />
            );
          })}
        </View>
      </ProovraCard>
      {creating ? (
        <CreateRequestSheet
          teamId={teamId}
          evidenceId={evidenceId}
          workspaceName={workspaceName}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await load();
          }}
        />
      ) : null}
    </ProovraSection>
  );
}

function CreateRequestSheet({
  teamId,
  evidenceId,
  workspaceName,
  onClose,
  onCreated,
}: {
  teamId: string;
  evidenceId: string;
  workspaceName: string | null;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [d, setD] = useState<RequestDraft>(emptyRequestDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof RequestDraft>(k: K) => (v: RequestDraft[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const draftError = requestDraftError(d);

  const updateDeliverable = (idx: number, patch: Partial<RequestDraft["deliverables"][number]>) =>
    setD((prev) => ({ ...prev, deliverables: prev.deliverables.map((x, i) => (i === idx ? { ...x, ...patch } : x)) }));

  const submit = async () => {
    if (busy || draftError) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(EVIDENCE_REQUESTS_CREATE_PATH, {
        method: "POST",
        body: JSON.stringify(buildRequestCreateBody(teamId, evidenceId, d, Date.now())),
      });
      await onCreated();
    } catch (err) {
      setError(toSafeUserError(err, { message: LINKED_REQUESTS_COPY.createFailed }).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProovraSheet visible title={LINKED_REQUESTS_COPY.dialogTitle} onClose={onClose}>
      <View style={{ gap: theme.space.s3 }} testID="create-request-sheet">
        {workspaceName ? (
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`${LINKED_REQUESTS_COPY.workspacePrefix} ${workspaceName}`}
          </ProovraText>
        ) : null}
        {error ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{error}</ProovraText> : null}
        <ProovraFormField label="Title">
          <ProovraInput value={d.title} onChangeText={set("title")} autoCapitalize="sentences" />
        </ProovraFormField>
        <ProovraFormField label="Instructions">
          <ProovraInput value={d.instructions} onChangeText={set("instructions")} multiline autoCapitalize="sentences" />
        </ProovraFormField>
        <ProovraFilterChips<string> label="Request type" options={REQUEST_TYPE_OPTIONS} value={d.requestType} onChange={set("requestType")} />
        <ProovraFilterChips<string> label="Priority" options={REQUEST_PRIORITY_OPTIONS} value={d.priority} onChange={set("priority")} />
        <ProovraFilterChips<string> label="Recipient" options={RECIPIENT_MODE_OPTIONS} value={d.recipientMode} onChange={set("recipientMode")} />
        <ProovraFormField label="Recipient label (optional)">
          <ProovraInput value={d.recipientLabel} onChangeText={(v) => set("recipientLabel")(v.slice(0, 180))} placeholder="e.g. John Smith — claim 4842" autoCapitalize="words" />
        </ProovraFormField>
        {d.recipientMode === "EXTERNAL_CONTRIBUTOR" ? (
          <ProovraFormField label="Recipient email (optional)">
            <ProovraInput value={d.recipientEmail} onChangeText={(v) => set("recipientEmail")(v.slice(0, 320))} keyboardType="email-address" autoComplete="email" />
          </ProovraFormField>
        ) : null}
        <ProovraFormField label="Due in (hours)">
          <ProovraInput value={d.dueInHours} onChangeText={set("dueInHours")} keyboardType="number-pad" />
        </ProovraFormField>

        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Deliverables</ProovraText>
        {d.deliverables.map((x, idx) => (
          <ProovraCard key={idx}>
            <View style={{ gap: theme.space.s2 }}>
              <ProovraInput
                value={x.title}
                onChangeText={(v) => updateDeliverable(idx, { title: v.slice(0, 180) })}
                placeholder="Title (e.g. Damage close-up)"
                accessibilityLabel={`Deliverable ${idx + 1} title`}
                autoCapitalize="sentences"
              />
              <ProovraInput
                value={x.description}
                onChangeText={(v) => updateDeliverable(idx, { description: v.slice(0, 2000) })}
                placeholder="Description (optional)"
                accessibilityLabel={`Deliverable ${idx + 1} description`}
                autoCapitalize="sentences"
              />
              <Pressable
                onPress={() => updateDeliverable(idx, { required: !x.required })}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: x.required }}
                accessibilityLabel={`Deliverable ${idx + 1} required`}
                style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}
              >
                <View
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    borderWidth: 2,
                    borderColor: x.required ? theme.color.accent.a500 : theme.color.border.strong,
                    backgroundColor: x.required ? theme.color.accent.a500 : "transparent",
                  }}
                />
                <ProovraText variant="bodySm">Required</ProovraText>
              </Pressable>
            </View>
          </ProovraCard>
        ))}
        <ProovraButton
          label="Add deliverable"
          variant="secondary"
          fullWidth={false}
          onPress={() => setD((prev) => ({ ...prev, deliverables: [...prev.deliverables, { title: "", description: "", required: false }] }))}
        />

        {draftError ? <ProovraText variant="label" color={theme.color.ink.muted}>{draftError}</ProovraText> : null}
        <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
          <ProovraButton label="Cancel" variant="ghost" fullWidth={false} disabled={busy} onPress={onClose} />
          <ProovraButton label={busy ? "Creating…" : "Create request"} fullWidth={false} disabled={busy || !!draftError} onPress={() => void submit()} />
        </View>
      </View>
    </ProovraSheet>
  );
}
