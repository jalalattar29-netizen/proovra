/**
 * ROLE PERMISSIONS SHEET (T-15) — see src/product/rbac-matrix.ts.
 * Touch adaptation: the web's role × capability grid becomes, per capability,
 * the list of roles allowed (in the server's rank order), with the web's
 * Details toggle for the description.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import { RBAC_COPY as COPY, RBAC_MATRIX_PATH, allowedRoleLabels, parseRbacMatrix, type RbacMatrix } from "../product/rbac-matrix";
import { ProovraButton, ProovraText } from "./index";
import { ProovraSheet } from "./patterns";

type Load = { kind: "loading" } | { kind: "ready"; matrix: RbacMatrix } | { kind: "denied" } | { kind: "error"; message: string };

export function RolePermissionsSheet({ visible, currentRole, onClose }: { visible: boolean; currentRole: string | null; onClose: () => void }) {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", matrix: parseRbacMatrix(await apiFetch(RBAC_MATRIX_PATH)) });
    } catch (err) {
      if ((err as { statusCode?: number } | null)?.statusCode === 403) setState({ kind: "denied" });
      else setState({ kind: "error", message: toSafeUserError(err, { message: COPY.failed }).message });
    }
  }, []);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const currentLabel =
    state.kind === "ready" && currentRole ? state.matrix.roles.find((r) => r.id === currentRole)?.label ?? currentRole : currentRole;

  return (
    <ProovraSheet visible={visible} title={COPY.title} onClose={onClose}>
      <View style={{ gap: theme.space.s3 }} testID={`role-permissions-${state.kind}`}>
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {`${COPY.intro}${currentLabel ? ` Your role here is ${currentLabel}.` : ""}`}
        </ProovraText>
        {state.kind === "loading" ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.loading}</ProovraText>
        ) : state.kind === "denied" ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.denied}</ProovraText>
        ) : state.kind === "error" ? (
          <>
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{state.message}</ProovraText>
            <ProovraButton label="Try again" variant="secondary" fullWidth={false} onPress={() => void load()} />
          </>
        ) : state.matrix.roles.length === 0 || state.matrix.categories.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.empty}</ProovraText>
        ) : (
          state.matrix.categories.map((c) => (
            <View key={c.id} style={{ gap: theme.space.s1 }}>
              <ProovraText variant="bodySm" weight="semibold">{c.label}</ProovraText>
              {c.capabilities.map((cap) => {
                const allowed = allowedRoleLabels(cap, state.matrix.roles);
                const open = expanded === cap.id;
                return (
                  <Pressable
                    key={cap.id}
                    onPress={() => cap.description && setExpanded(open ? null : cap.id)}
                    accessibilityRole={cap.description ? "button" : "text"}
                    accessibilityLabel={`${cap.label}: ${allowed.length ? allowed.join(", ") : COPY.noRole}`}
                    style={{ paddingVertical: theme.space.s1, gap: 2 }}
                  >
                    <ProovraText variant="label">{cap.label}</ProovraText>
                    <ProovraText variant="label" color={theme.color.ink.muted}>{allowed.length ? allowed.join(" · ") : COPY.noRole}</ProovraText>
                    {cap.description ? (
                      <ProovraText variant="label" color={theme.color.accent.a600}>{open ? "Hide details ▴" : "Details ▾"}</ProovraText>
                    ) : null}
                    {open && cap.description ? <ProovraText variant="label" color={theme.color.ink.secondary}>{cap.description}</ProovraText> : null}
                  </Pressable>
                );
              })}
            </View>
          ))
        )}
        {state.kind === "ready" && state.matrix.version ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>{`catalog ${state.matrix.version}`}</ProovraText>
        ) : null}
      </View>
    </ProovraSheet>
  );
}
