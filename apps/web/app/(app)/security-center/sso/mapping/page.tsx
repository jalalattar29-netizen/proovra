"use client";

/**
 * Phase P1.1 — Visual SAML Attribute Mapping Builder.
 *
 * Operator-facing UI to edit the SAML attribute mapping for a single
 * SsoConnection. Drives four backend endpoints (P1.1):
 *
 *   GET  /v1/saml/mapping/schema          — describes mapping fields
 *   GET  /v1/saml/mapping/current         — current persisted mapping
 *   POST /v1/saml/mapping/preview         — diff + warnings + sample
 *   PUT  /v1/saml/mapping                 — persist; step-up if priv
 *
 * Hard rules:
 *   * No save without preview.
 *   * Privilege-affecting saves (group→OWNER/ADMIN, external ID
 *     override, default role downgrade) route through step-up.
 *   * Operator-facing warnings, no raw assertion contents.
 *   * SCIM overlap warning when SCIM is authoritative for this
 *     connection (mapping changes are inert).
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { AccessGate } from "../../../../../components/access/AccessGate";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import {
  badgeStyle,
  cardStyle,
  errorBoxStyle,
  ghostButtonStyle,
  headerRowStyle,
  inputStyle,
  mutedStyle,
  pageStyle,
  primaryButtonStyle,
  sectionTitleStyle,
  selectStyle,
  subtitleStyle,
  successBoxStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "../../../admin/identity/ui-tokens";

type SamlMappingFieldDescriptor = {
  key: string;
  label: string;
  description: string;
  kind: "string" | "enum" | "group_role_map";
  required: boolean;
  suggestions: ReadonlyArray<string>;
  enumValues?: ReadonlyArray<string>;
  privilegeAffecting: boolean;
};

type SamlMappingSchema = {
  version: 1;
  fields: ReadonlyArray<SamlMappingFieldDescriptor>;
  notes: ReadonlyArray<string>;
};

type GroupRoleEntry = {
  group: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
};

type MappingPayload = {
  email?: string | null;
  name?: string | null;
  externalId?: string | null;
  groupClaim?: string | null;
  defaultRole?: "MEMBER" | "VIEWER" | null;
  groupRoleMap?: ReadonlyArray<GroupRoleEntry> | null;
};

type CurrentSamlMapping = {
  connectionId: string;
  teamId: string;
  provider: string;
  status: string;
  scimManaged: boolean;
  mapping: MappingPayload;
  jitDefaultRole: string | null;
};

type SamlMappingPreview = {
  privilegeAffecting: boolean;
  changes: ReadonlyArray<{
    field: string;
    before: string | null;
    after: string | null;
  }>;
  warnings: ReadonlyArray<{
    code:
      | "GROUP_ROLE_INCLUDES_OWNER_OR_ADMIN"
      | "GROUP_ROLE_OVERLAPS_SCIM"
      | "DEFAULT_ROLE_DOWNGRADED"
      | "EMAIL_MAPPING_REMOVED"
      | "EXTERNAL_ID_OVERRIDE_RISKY";
    message: string;
  }>;
  sampleResolution: {
    email: string | null;
    name: string | null;
    externalId: string | null;
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
    matchedGroup: string | null;
  } | null;
};

type SsoProvider = {
  id: string;
  provider: string;
};

export default function SamlMappingPage() {
  return (
    <PageRouteGate routeId="workspace.security_center">
      <SamlMappingContent />
    </PageRouteGate>
  );
}

function SamlMappingContent() {
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });
  const [providers, setProviders] = useState<SsoProvider[] | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [schema, setSchema] = useState<SamlMappingSchema | null>(null);
  const [current, setCurrent] = useState<CurrentSamlMapping | null>(null);
  const [mapping, setMapping] = useState<MappingPayload>({});
  const [preview, setPreview] = useState<SamlMappingPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [sampleAttrs, setSampleAttrs] = useState<Record<string, string>>({});
  const [sampleRaw, setSampleRaw] = useState("");

  // Load schema once.
  useEffect(() => {
    apiFetch("/v1/saml/mapping/schema", { method: "GET" })
      .then((r: { schema: SamlMappingSchema }) => setSchema(r.schema))
      .catch((err: { message?: string }) =>
        setError(err?.message ?? "Could not load mapping schema."),
      );
  }, []);

  // Load workspace providers — filtered to SAML-capable (GENERIC_SAML).
  useEffect(() => {
    if (!teamId) return;
    apiFetch(
      `/v1/admin/identity/sso/providers?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: { providers: Array<{ id: string; provider: string }> }) => {
        const samlOnly = (r.providers ?? []).filter(
          (p) => p.provider === "GENERIC_SAML",
        );
        setProviders(samlOnly);
        if (samlOnly.length > 0 && !connectionId)
          setConnectionId(samlOnly[0].id);
      })
      .catch(() => setProviders([]));
  }, [teamId, connectionId]);

  // Load current mapping when connection changes.
  const loadCurrent = useCallback(() => {
    if (!teamId || !connectionId) return;
    apiFetch(
      `/v1/saml/mapping/current?teamId=${encodeURIComponent(
        teamId,
      )}&connectionId=${encodeURIComponent(connectionId)}`,
      { method: "GET" },
    )
      .then((r: { current: CurrentSamlMapping }) => {
        setCurrent(r.current);
        setMapping({
          email: r.current.mapping.email ?? null,
          name: r.current.mapping.name ?? null,
          externalId: r.current.mapping.externalId ?? null,
          groupClaim: r.current.mapping.groupClaim ?? null,
          defaultRole: r.current.mapping.defaultRole ?? "MEMBER",
          groupRoleMap: r.current.mapping.groupRoleMap ?? [],
        });
        setPreview(null);
        setError(null);
        setSuccess(null);
      })
      .catch((err: { message?: string }) =>
        setError(err?.message ?? "Could not load current mapping."),
      );
  }, [teamId, connectionId]);

  useEffect(() => {
    loadCurrent();
  }, [loadCurrent]);

  // Parse a sample assertion JSON paste into a flat map.
  useEffect(() => {
    if (!sampleRaw.trim()) {
      setSampleAttrs({});
      return;
    }
    try {
      const parsed = JSON.parse(sampleRaw);
      if (parsed && typeof parsed === "object") {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (typeof v === "string") flat[k] = v;
          else if (typeof v === "number" || typeof v === "boolean")
            flat[k] = String(v);
        }
        setSampleAttrs(flat);
      }
    } catch {
      // Soft-fail — operator sees no resolution; explicit error not
      // helpful here since they may still be typing.
    }
  }, [sampleRaw]);

  const runPreview = useCallback(async () => {
    if (!teamId || !connectionId) return;
    setPreviewing(true);
    setError(null);
    setSuccess(null);
    try {
      const r = (await apiFetch("/v1/saml/mapping/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          connectionId,
          mapping,
          sampleAttributes: sampleAttrs,
        }),
      })) as { preview: SamlMappingPreview };
      setPreview(r.preview);
    } catch (err) {
      setError(
        (err as { message?: string })?.message ?? "Preview failed.",
      );
    } finally {
      setPreviewing(false);
    }
  }, [teamId, connectionId, mapping, sampleAttrs]);

  const save = useCallback(async () => {
    if (!teamId || !connectionId) return;
    if (!preview) {
      setError("Run preview before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await stepUp.runStepUpAction(async (headers) => {
        return await apiFetch("/v1/saml/mapping", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(headers ?? {}),
          },
          body: JSON.stringify({
            teamId,
            connectionId,
            mapping,
            acknowledgePrivilegeImpact: preview.privilegeAffecting,
          }),
        });
      });
      setSuccess(
        "Mapping saved. Applies to future logins only — existing sessions keep their current role.",
      );
      setPreview(null);
      loadCurrent();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setError("Step-up cancelled — mapping was not saved.");
      } else {
        setError((err as { message?: string })?.message ?? "Save failed.");
      }
    } finally {
      setSaving(false);
    }
  }, [teamId, connectionId, mapping, preview, stepUp, loadCurrent]);

  const updateField = (key: keyof MappingPayload, value: unknown) =>
    setMapping((prev) => ({ ...prev, [key]: value }));

  const groupRoleMap = useMemo(
    () => mapping.groupRoleMap ?? [],
    [mapping.groupRoleMap],
  );

  if (!teamId) {
    return (
      <main style={pageStyle}>
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="SAML Mapping"
          headline="Switch to a team workspace to configure SAML attribute mapping"
          reason="SAML attribute mappings are per-connection. Open a team workspace that owns a SAML SSO connection."
          actions={[
            { label: "Open team workspaces", href: "/teams", variant: "primary" },
          ]}
          testid="saml-mapping-access-gate-no-workspace"
        />
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>SAML Attribute Mapping</h1>
          <p style={subtitleStyle}>
            Visual builder for SAML attribute → operator-field mappings.
            Preview shows the diff vs. the current mapping and surfaces
            privilege-impact warnings. Saves that grant OWNER/ADMIN via
            group claims or change the external subject attribute
            require step-up.
          </p>
        </div>
        <div>
          <label style={{ ...mutedStyle, marginRight: 8 }}>Connection</label>
          <select
            style={selectStyle}
            value={connectionId ?? ""}
            onChange={(e) => setConnectionId(e.target.value || null)}
          >
            {providers === null ? (
              <option value="">Loading…</option>
            ) : providers.length === 0 ? (
              <option value="">No SAML connections</option>
            ) : (
              providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.provider} · {p.id.slice(0, 8)}…
                </option>
              ))
            )}
          </select>
        </div>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {success ? <div style={successBoxStyle}>{success}</div> : null}

      {current?.scimManaged ? (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            background: "#fef3c7",
            border: "1px solid #fde68a",
            borderRadius: 6,
            fontSize: 13,
            color: "#78350f",
          }}
        >
          <strong>SCIM is authoritative</strong> for this connection. SAML
          group claims are ignored at assertion time — group role mappings
          below are inert until SCIM is disabled.
        </div>
      ) : null}

      {!schema || !current ? (
        <p style={{ ...mutedStyle, marginTop: 16 }}>
          {connectionId
            ? "Loading mapping…"
            : "Select a SAML connection above."}
        </p>
      ) : (
        <>
          <section style={{ ...cardStyle, marginTop: 16 }}>
            <h3 style={sectionTitleStyle}>Attribute fields</h3>
            <div style={{ display: "grid", gap: 16 }}>
              {schema.fields
                .filter((f) => f.kind !== "group_role_map")
                .map((f) => (
                  <FieldEditor
                    key={f.key}
                    descriptor={f}
                    value={
                      (mapping as Record<string, unknown>)[f.key] as
                        | string
                        | null
                        | undefined
                    }
                    onChange={(v) =>
                      updateField(f.key as keyof MappingPayload, v)
                    }
                  />
                ))}
            </div>
          </section>

          <section style={{ ...cardStyle, marginTop: 12 }}>
            <h3 style={sectionTitleStyle}>Group → Role mapping</h3>
            <p style={{ ...mutedStyle, marginTop: 0 }}>
              Per-group role override. The first matching group wins; if no
              group claim matches, the default role is used. Adding
              OWNER/ADMIN mappings requires step-up at save time.
            </p>
            <GroupRoleMapEditor
              entries={groupRoleMap}
              onChange={(next) => updateField("groupRoleMap", next)}
            />
          </section>

          <section style={{ ...cardStyle, marginTop: 12 }}>
            <h3 style={sectionTitleStyle}>Sample assertion (optional)</h3>
            <p style={{ ...mutedStyle, marginTop: 0 }}>
              Paste a JSON object of attribute → value pairs from a real IdP
              assertion. The preview will resolve email / role using the
              current mapping. Sample is never persisted.
            </p>
            <textarea
              style={{
                ...inputStyle,
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: 12,
                minHeight: 80,
                resize: "vertical",
              }}
              value={sampleRaw}
              onChange={(e) => setSampleRaw(e.target.value)}
              placeholder='{"email": "ops@acme.com", "groups": "platform-admins"}'
            />
          </section>

          <section
            style={{
              ...cardStyle,
              marginTop: 12,
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              style={ghostButtonStyle}
              onClick={runPreview}
              disabled={previewing}
            >
              {previewing ? "Previewing…" : "Preview changes"}
            </button>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={save}
              disabled={!preview || saving}
            >
              {saving
                ? "Saving…"
                : preview?.privilegeAffecting
                  ? "Save (requires step-up)"
                  : "Save mapping"}
            </button>
            <span style={{ ...mutedStyle, marginLeft: "auto" }}>
              {preview
                ? preview.privilegeAffecting
                  ? "⚠ Privilege-affecting change detected"
                  : "Preview ready"
                : "Preview required before save"}
            </span>
          </section>

          {preview ? <PreviewPanel preview={preview} /> : null}
        </>
      )}

      <StepUpModal control={stepUp} />
    </main>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function FieldEditor({
  descriptor,
  value,
  onChange,
}: {
  descriptor: SamlMappingFieldDescriptor;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <label style={{ fontWeight: 600, fontSize: 13 }}>
          {descriptor.label}
        </label>
        {descriptor.privilegeAffecting ? (
          <span
            style={badgeStyle({
              bg: "#fef3c7",
              fg: "#78350f",
              border: "#fde68a",
            })}
          >
            PRIV
          </span>
        ) : null}
      </div>
      <p style={{ ...mutedStyle, marginTop: 0, marginBottom: 6 }}>
        {descriptor.description}
      </p>
      {descriptor.kind === "enum" && descriptor.enumValues ? (
        <select
          style={selectStyle}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">— default —</option>
          {descriptor.enumValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <input
          style={inputStyle}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder={descriptor.suggestions[0] ?? ""}
          list={`suggestions-${descriptor.key}`}
        />
      )}
      {descriptor.suggestions.length > 0 && descriptor.kind !== "enum" ? (
        <datalist id={`suggestions-${descriptor.key}`}>
          {descriptor.suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

function GroupRoleMapEditor({
  entries,
  onChange,
}: {
  entries: ReadonlyArray<GroupRoleEntry>;
  onChange: (next: GroupRoleEntry[]) => void;
}) {
  const update = (idx: number, patch: Partial<GroupRoleEntry>) => {
    const next = entries.map((e, i) => (i === idx ? { ...e, ...patch } : e));
    onChange(next);
  };
  const remove = (idx: number) =>
    onChange(entries.filter((_, i) => i !== idx));
  const add = () =>
    onChange([...entries, { group: "", role: "MEMBER" as const }]);

  return (
    <div>
      {entries.length === 0 ? (
        <p style={mutedStyle}>No group → role mappings configured.</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Group claim value</th>
              <th style={thStyle}>Role</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td style={tdStyle}>
                  <input
                    style={inputStyle}
                    value={e.group}
                    onChange={(ev) => update(i, { group: ev.target.value })}
                  />
                </td>
                <td style={tdStyle}>
                  <select
                    style={selectStyle}
                    value={e.role}
                    onChange={(ev) =>
                      update(i, {
                        role: ev.target.value as GroupRoleEntry["role"],
                      })
                    }
                  >
                    <option value="OWNER">OWNER</option>
                    <option value="ADMIN">ADMIN</option>
                    <option value="MEMBER">MEMBER</option>
                    <option value="VIEWER">VIEWER</option>
                  </select>
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    style={ghostButtonStyle}
                    onClick={() => remove(i)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button
        type="button"
        style={{ ...ghostButtonStyle, marginTop: 8 }}
        onClick={add}
      >
        Add mapping
      </button>
    </div>
  );
}

function PreviewPanel({ preview }: { preview: SamlMappingPreview }) {
  return (
    <section style={{ ...cardStyle, marginTop: 12 }}>
      <h3 style={sectionTitleStyle}>Preview</h3>
      {preview.warnings.length > 0 ? (
        <ul style={{ margin: "0 0 12px", padding: "0 0 0 18px" }}>
          {preview.warnings.map((w) => (
            <li key={w.code} style={{ marginBottom: 6 }}>
              <span
                style={badgeStyle({
                  bg:
                    w.code === "GROUP_ROLE_INCLUDES_OWNER_OR_ADMIN" ||
                    w.code === "EXTERNAL_ID_OVERRIDE_RISKY"
                      ? "#fef2f2"
                      : "#fef3c7",
                  fg:
                    w.code === "GROUP_ROLE_INCLUDES_OWNER_OR_ADMIN" ||
                    w.code === "EXTERNAL_ID_OVERRIDE_RISKY"
                      ? "#991b1b"
                      : "#78350f",
                  border:
                    w.code === "GROUP_ROLE_INCLUDES_OWNER_OR_ADMIN" ||
                    w.code === "EXTERNAL_ID_OVERRIDE_RISKY"
                      ? "#fecaca"
                      : "#fde68a",
                })}
              >
                {w.code}
              </span>{" "}
              <span style={{ fontSize: 13 }}>{w.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ ...mutedStyle, marginTop: 0 }}>
          No warnings. Mapping change is operationally safe.
        </p>
      )}

      <h4 style={{ ...sectionTitleStyle, marginTop: 16 }}>Diff</h4>
      {preview.changes.length === 0 ? (
        <p style={mutedStyle}>No changes vs. current mapping.</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Field</th>
              <th style={thStyle}>Before</th>
              <th style={thStyle}>After</th>
            </tr>
          </thead>
          <tbody>
            {preview.changes.map((c) => (
              <tr key={c.field}>
                <td style={tdStyle}>
                  <code style={{ fontFamily: "monospace", fontSize: 12 }}>
                    {c.field}
                  </code>
                </td>
                <td style={tdStyle}>
                  <span style={{ fontSize: 12 }}>{c.before ?? "—"}</span>
                </td>
                <td style={tdStyle}>
                  <span style={{ fontSize: 12, color: TOKENS.ink }}>
                    {c.after ?? "—"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {preview.sampleResolution ? (
        <>
          <h4 style={{ ...sectionTitleStyle, marginTop: 16 }}>
            Sample resolution
          </h4>
          <table style={tableStyle}>
            <tbody>
              <tr>
                <td style={tdStyle}>email</td>
                <td style={tdStyle}>
                  {preview.sampleResolution.email ?? "—"}
                </td>
              </tr>
              <tr>
                <td style={tdStyle}>name</td>
                <td style={tdStyle}>
                  {preview.sampleResolution.name ?? "—"}
                </td>
              </tr>
              <tr>
                <td style={tdStyle}>externalId</td>
                <td style={tdStyle}>
                  {preview.sampleResolution.externalId ?? "—"}
                </td>
              </tr>
              <tr>
                <td style={tdStyle}>resolved role</td>
                <td style={tdStyle}>
                  <strong>{preview.sampleResolution.role}</strong>
                  {preview.sampleResolution.matchedGroup ? (
                    <span style={{ ...mutedStyle, marginLeft: 8 }}>
                      (via group {preview.sampleResolution.matchedGroup})
                    </span>
                  ) : (
                    <span style={{ ...mutedStyle, marginLeft: 8 }}>
                      (default fallback)
                    </span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
