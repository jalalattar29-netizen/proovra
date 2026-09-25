/**
 * ORGANIZATION SETTINGS (T-14) — the web org page's Settings card
 * (organizations/[id]/page.tsx): identity metadata, ORG_ADMIN+ only, saved
 * with PATCH /v1/orgs/:id and re-read so the header shows the stored values.
 */
import React, { useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserTime } from "../lib/date";
import { theme } from "../theme/theme";
import {
  ORG_SETTINGS_COPY as COPY,
  buildOrgPath,
  buildOrgSettingsBody,
  canEditOrgSettings,
  orgSettingsDraft,
  type OrgDetail,
  type OrgSettingsDraft,
} from "../product/organizations";
import { ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraText } from "./index";
import { ProovraPageSection } from "./patterns";

const FIELDS: ReadonlyArray<{ key: keyof OrgSettingsDraft; label: string; optional: boolean; keyboard?: "email-address" | "url"; placeholder?: string }> = [
  { key: "name", label: "Name", optional: false },
  { key: "legalName", label: "Legal name", optional: true },
  { key: "legalEmail", label: "Legal email", optional: true, keyboard: "email-address" },
  { key: "address", label: "Mailing address", optional: true },
  { key: "timezone", label: "Timezone (IANA, e.g. America/Los_Angeles)", optional: false },
  { key: "logoUrl", label: "Logo URL", optional: true, keyboard: "url", placeholder: "https://" },
];

export function OrgSettings({ orgId, org, onSaved }: { orgId: string; org: OrgDetail; onSaved: () => void | Promise<void> }) {
  const [draft, setDraft] = useState<OrgSettingsDraft>(() => orgSettingsDraft(org));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // A re-read replaces the draft with what the server stored.
  useEffect(() => {
    setDraft(orgSettingsDraft(org));
  }, [org]);

  const save = async () => {
    if (!draft.name.trim()) {
      setError(COPY.nameRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(buildOrgPath(orgId), { method: "PATCH", body: JSON.stringify(buildOrgSettingsBody(draft)) });
      setSavedAt(new Date().toISOString());
      await onSaved();
    } catch (err) {
      setError(toSafeUserError(err, { message: COPY.failed }).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProovraPageSection title={COPY.title} description={COPY.subtitle}>
      <ProovraCard testID="org-settings">
        {!canEditOrgSettings(org) ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.forbidden}</ProovraText>
        ) : (
          <View style={{ gap: theme.space.s2 }}>
            {FIELDS.map((f) => (
              <ProovraFormField key={f.key} label={f.optional ? `${f.label} (optional)` : f.label}>
                <ProovraInput
                  value={draft[f.key]}
                  onChangeText={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                  keyboardType={f.keyboard ?? "default"}
                  autoCapitalize={f.keyboard ? "none" : "sentences"}
                  placeholder={f.placeholder}
                />
              </ProovraFormField>
            ))}
            {error ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{error}</ProovraText> : null}
            {savedAt && !error ? (
              <ProovraText variant="label" color={theme.color.status.verified.fg}>{`Saved at ${formatUserTime(savedAt)}.`}</ProovraText>
            ) : null}
            <ProovraButton
              label={busy ? COPY.saving : COPY.save}
              accessibilityLabel={COPY.save}
              fullWidth={false}
              disabled={busy || !draft.name.trim()}
              onPress={() => void save()}
            />
          </View>
        )}
      </ProovraCard>
    </ProovraPageSection>
  );
}
