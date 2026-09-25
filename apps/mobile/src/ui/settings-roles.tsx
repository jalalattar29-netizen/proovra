/**
 * SETTINGS › ROLES & PERMISSIONS — the native port of
 * `apps/web/app/(app)/settings/_sections/RolesSection.tsx`.
 *
 * Offered where the web offers the pane: an ORGANIZATION workspace whose actor
 * holds `SETTINGS_VIEW` (settingsNavigation.ts). Every line is counted from the
 * server's own catalog (`GET /v1/platform/rbac/matrix`) — nothing here is a
 * hand-written description of a role, because a drifted description that
 * over-states a role is a security-relevant lie.
 *
 * Touch adaptation: the per-role summaries render as cards; the detailed
 * role × capability matrix stays closed behind the same disclosure the web
 * uses, and each capability lists its per-role answer (✓ / —) instead of a
 * wide table.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import { RBAC_MATRIX_PATH, parseRbacMatrix, type RbacMatrix } from "../product/rbac-matrix";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraText } from "./index";
import { ProovraSheet } from "./patterns";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; matrix: RbacMatrix }
  | { kind: "denied" }
  | { kind: "legal" }
  | { kind: "error"; title: string; message: string };

function isLegalGate(err: unknown): boolean {
  const e = (err ?? {}) as { statusCode?: unknown; code?: unknown };
  return e.statusCode === 428 || (typeof e.code === "string" && e.code.toUpperCase().includes("LEGAL_REACCEPT"));
}

/** Per role: how many capabilities it holds, and in which areas. Counted, never described. */
export function roleSummaries(matrix: RbacMatrix): Array<{ id: string; label: string; granted: number; total: number; areas: string[] }> {
  const total = matrix.categories.reduce((n, c) => n + c.capabilities.length, 0);
  return matrix.roles.map((role) => ({
    id: role.id,
    label: role.label,
    granted: matrix.categories.flatMap((c) => c.capabilities.filter((cap) => cap.roles.includes(role.id))).length,
    total,
    areas: matrix.categories.filter((c) => c.capabilities.some((cap) => cap.roles.includes(role.id))).map((c) => c.label),
  }));
}

export function SettingsRolesSheet({ visible, myRole, onClose }: { visible: boolean; myRole: string | null; onClose: () => void }) {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [matrixOpen, setMatrixOpen] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", matrix: parseRbacMatrix(await apiFetch(RBAC_MATRIX_PATH)) });
    } catch (err) {
      if ((err as { statusCode?: number } | null)?.statusCode === 403) setState({ kind: "denied" });
      else if (isLegalGate(err)) setState({ kind: "legal" });
      else {
        const safe = toSafeUserError(err, { message: "The role reference could not be loaded." });
        setState({ kind: "error", title: safe.title, message: safe.message });
      }
    }
  }, []);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  return (
    <ProovraSheet visible={visible} title="Roles & permissions" onClose={onClose}>
      <View style={{ gap: theme.space.s3 }} testID={`settings-roles-${state.kind}`}>
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          Understand workspace roles and what each role can do.
        </ProovraText>

        {state.kind === "loading" ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Loading the role reference from the server…</ProovraText>
        ) : state.kind === "denied" ? (
          <ProovraCard>
            <ProovraText variant="bodySm" weight="semibold">This reference is not available to you</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              Your account is not permitted to read the capability catalog. Ask a workspace administrator what your role includes.
            </ProovraText>
          </ProovraCard>
        ) : state.kind === "legal" ? (
          <ProovraCard>
            <ProovraText variant="bodySm" weight="semibold">Accept the current policies to continue</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              This reference stays locked until your account accepts the latest policies — see Privacy &amp; legal records.
            </ProovraText>
          </ProovraCard>
        ) : state.kind === "error" ? (
          <ProovraCard>
            <ProovraText variant="bodySm" weight="semibold">{state.title}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{state.message}</ProovraText>
            <ProovraButton label="Try again" variant="secondary" fullWidth={false} onPress={() => void load()} />
          </ProovraCard>
        ) : state.matrix.roles.length === 0 || state.matrix.categories.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>
            The server returned no capability catalog for this deployment.
          </ProovraText>
        ) : (
          <>
            {roleSummaries(state.matrix).map((r) => (
              <ProovraCard key={r.id} testID={`role-summary-${r.id}`}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}>
                  <ProovraText variant="bodySm" weight="semibold" style={{ flex: 1 }}>{r.label}</ProovraText>
                  {r.id === myRole ? <ProovraBadge label="Your role" tone="info" /> : null}
                </View>
                <ProovraText variant="label" color={theme.color.ink.secondary}>{`Permissions: ${r.granted} of ${r.total}`}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {`Areas: ${r.areas.length > 0 ? r.areas.join(" · ") : "No permissions in this workspace"}`}
                </ProovraText>
              </ProovraCard>
            ))}

            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`Roles are changed by a workspace administrator. Every permission below is answered by the API itself — if it is not granted, the action is refused no matter what the interface shows.${state.matrix.version ? ` Catalog ${state.matrix.version}.` : ""}`}
            </ProovraText>

            <ProovraButton
              label={`${matrixOpen ? "Hide" : "View"} detailed permission matrix`}
              variant="ghost"
              fullWidth={false}
              onPress={() => setMatrixOpen((v) => !v)}
            />

            {matrixOpen
              ? state.matrix.categories.map((category) => (
                  <View key={category.id} style={{ gap: theme.space.s1 }} testID={`roles-category-${category.id}`}>
                    <ProovraText variant="bodySm" weight="semibold">{category.label}</ProovraText>
                    {category.capabilities.map((cap) => (
                      <View key={cap.id} style={{ paddingVertical: theme.space.s1, gap: 2 }}>
                        <ProovraText variant="label">{cap.label}</ProovraText>
                        {cap.description ? (
                          <ProovraText variant="label" color={theme.color.ink.muted}>{cap.description}</ProovraText>
                        ) : null}
                        <ProovraText variant="label" color={theme.color.ink.secondary}>
                          {state.matrix.roles.map((role) => `${role.label} ${cap.roles.includes(role.id) ? "✓" : "—"}`).join(" · ")}
                        </ProovraText>
                      </View>
                    ))}
                  </View>
                ))
              : null}
          </>
        )}
      </View>
    </ProovraSheet>
  );
}
