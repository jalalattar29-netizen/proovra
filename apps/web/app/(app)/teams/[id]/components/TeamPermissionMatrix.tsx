"use client";

/**
 * Team permission matrix (read-only) — SERVER-SOURCED.
 *
 * PHASE 12 POINT 1 / A2 (2026-07-31) — migrated off the hand-maintained
 * client catalog onto `GET /v1/platform/rbac/matrix`, the API binary's own
 * capability catalog.
 *
 * Why the catalog is fetched rather than bundled
 * ----------------------------------------------
 * The role→capability mapping is enforced by the backend. A second copy
 * compiled into the web bundle drifts silently the moment a route gate
 * changes, and a drifted copy that OVER-states a role is a security-relevant
 * lie. This surface therefore renders ONLY what the server sends.
 *
 * Hard rules that survive the migration:
 *   - Wholly read-only. PROOVRA has no custom roles at the backend layer, so
 *     there is no "edit" affordance and the UI must not pretend otherwise.
 *   - No client-side policy decision. The viewer's role is used purely to
 *     emphasise a column; every allow/deny cell is the server's own answer.
 *   - The role columns come from the response's `roles[]` (ordered by the
 *     server's `rank`, strongest first), never from a local hierarchy.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { captureException } from "../../../../../lib/sentry";

type RoleId = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

type MatrixRole = { id: string; label: string; rank: number };

type MatrixCapability = {
  id: string;
  label: string;
  description?: string | null;
  roles: string[];
};

type MatrixCategory = {
  id: string;
  label: string;
  capabilities: MatrixCapability[];
};

type RbacMatrix = {
  roles: MatrixRole[];
  categories: MatrixCategory[];
  version?: string | null;
  generatedAt?: string | null;
};

type State =
  | { kind: "LOADING" }
  | { kind: "READY"; matrix: RbacMatrix }
  /** 403 — authenticated but not permitted to read the catalog. */
  | { kind: "DENIED" }
  | { kind: "ERROR"; title: string; message: string };

/**
 * Presentational tone per role id. Unknown ids (a future backend role the
 * bundle has not seen) fall back to the neutral tone rather than crashing —
 * the server, not this map, decides which columns exist.
 */
const ROLE_TONE: Record<string, { bg: string; border: string; fg: string }> = {
  OWNER: { bg: "#F2ECFE", border: "#D9C7FB", fg: "#6D28D9" },
  ADMIN: { bg: "#EAF7F1", border: "rgba(22,122,91,0.16)", fg: "#167A5B" },
  MEMBER: { bg: "#F1F5F9", border: "rgba(15,23,42,0.08)", fg: "#475569" },
  VIEWER: { bg: "#F1F5F9", border: "rgba(15,23,42,0.08)", fg: "#5F6B7D" },
};

const NEUTRAL_TONE = {
  bg: "#F1F5F9",
  border: "rgba(15,23,42,0.08)",
  fg: "#5F6B7D",
};

function toneFor(roleId: string) {
  return ROLE_TONE[roleId] ?? NEUTRAL_TONE;
}

function readStatus(err: unknown): number | null {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === "number" ? s : null;
}

function HeaderBadge({ role }: { role: MatrixRole }) {
  const t = toneFor(role.id);
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        background: t.bg,
        border: `1px solid ${t.border}`,
        color: t.fg,
      }}
    >
      {role.label}
    </span>
  );
}

function CapabilityCheckmark({
  allowed,
  role,
}: {
  allowed: boolean;
  role: MatrixRole;
}) {
  if (allowed) {
    const t = toneFor(role.id);
    return (
      <span
        data-permission-cell-allowed="true"
        data-permission-role={role.id}
        title={`${role.label} can perform this action`}
        style={{
          display: "inline-flex",
          width: 22,
          height: 22,
          borderRadius: 999,
          alignItems: "center",
          justifyContent: "center",
          background: t.bg,
          border: `1px solid ${t.border}`,
          color: t.fg,
          fontSize: 13,
          fontWeight: 700,
        }}
        aria-label={`${role.label} can perform this action`}
      >
        ✓
      </span>
    );
  }
  return (
    <span
      data-permission-cell-allowed="false"
      data-permission-role={role.id}
      title={`${role.label} cannot perform this action`}
      style={{
        display: "inline-block",
        width: 22,
        height: 22,
        borderRadius: 999,
        background: "rgba(0,0,0,0.04)",
        border: "1px dashed rgba(0,0,0,0.08)",
      }}
      aria-label={`${role.label} cannot perform this action`}
    />
  );
}

export function TeamPermissionMatrix({
  currentRole,
}: {
  /** The current viewer's role in this team, for "your access" emphasis. */
  currentRole?: RoleId | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: "LOADING" });

  const load = useCallback(async () => {
    setState({ kind: "LOADING" });
    try {
      const data = (await apiFetch("/v1/platform/rbac/matrix")) as RbacMatrix;
      const roles = Array.isArray(data?.roles) ? [...data.roles] : [];
      // Strongest role first — the server owns the ordering via `rank`.
      roles.sort((a, b) => (b?.rank ?? 0) - (a?.rank ?? 0));
      setState({
        kind: "READY",
        matrix: {
          roles,
          categories: Array.isArray(data?.categories) ? data.categories : [],
          version: data?.version ?? null,
          generatedAt: data?.generatedAt ?? null,
        },
      });
    } catch (err) {
      if (readStatus(err) === 403) {
        setState({ kind: "DENIED" });
        return;
      }
      captureException(err, { feature: "team_permission_matrix" });
      const safe = toSafeUserError(err, {
        message: "The role reference could not be loaded.",
      });
      setState({ kind: "ERROR", title: safe.title, message: safe.message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currentRoleLabel =
    state.kind === "READY" && currentRole
      ? state.matrix.roles.find((r) => r.id === currentRole)?.label ??
        currentRole
      : currentRole ?? null;

  const header = (
    <header className="mb-4">
      {/* Phase IA-self-serve-completion — "Permission matrix" reads
          as SOC2-audit vocabulary to a 3-person law office. Renamed
          to plain-language "Who can do what" without changing the
          grid semantics or the underlying RBAC mapping. */}
      <h2 className="m-0 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#172033]">
        Who can do what
      </h2>
      <p className="m-0 mt-1 text-[12.5px] leading-snug text-[#5F6B7D]">
        What each role on this team can do. This list comes from the API —
        if a cell isn&apos;t checked, the action is blocked for that role.{" "}
        {currentRoleLabel ? (
          <>
            Your role here is{" "}
            <strong data-permission-matrix-current-role>
              {currentRoleLabel}
            </strong>
            .
          </>
        ) : null}
      </p>
    </header>
  );

  if (state.kind === "LOADING") {
    return (
      <section
        data-team-permission-matrix
        data-permission-matrix-state="LOADING"
        className="cases-panel p-5 md:p-6"
      >
        {header}
        <p className="m-0 text-[12.5px] text-[#5F6B7D]">
          Loading the role reference from the server…
        </p>
      </section>
    );
  }

  if (state.kind === "DENIED") {
    return (
      <section
        data-team-permission-matrix
        data-permission-matrix-state="DENIED"
        className="cases-panel p-5 md:p-6"
      >
        {header}
        <p className="m-0 text-[12.5px] text-[#5F6B7D]">
          Your account is not permitted to read the capability catalog. Ask a
          workspace administrator what your role includes.
        </p>
      </section>
    );
  }

  if (state.kind === "ERROR") {
    return (
      <section
        data-team-permission-matrix
        data-permission-matrix-state="ERROR"
        className="cases-panel p-5 md:p-6"
      >
        {header}
        <p className="m-0 text-[12.5px] font-semibold text-[#172033]">
          {state.title}
        </p>
        <p className="m-0 mt-1 text-[12.5px] text-[#5F6B7D]">{state.message}</p>
        <button
          type="button"
          onClick={() => void load()}
          data-permission-matrix-retry
          className="mt-3 rounded-full border border-[rgba(15,23,42,0.12)] bg-white px-3 py-1.5 text-[12px] font-medium text-[#172033]"
        >
          Try again
        </button>
      </section>
    );
  }

  const { matrix } = state;

  if (matrix.roles.length === 0 || matrix.categories.length === 0) {
    return (
      <section
        data-team-permission-matrix
        data-permission-matrix-state="EMPTY"
        className="cases-panel p-5 md:p-6"
      >
        {header}
        <p className="m-0 text-[12.5px] text-[#5F6B7D]">
          The server returned no capability catalog for this deployment.
        </p>
      </section>
    );
  }

  return (
    <section
      data-team-permission-matrix
      data-permission-matrix-state="READY"
      data-permission-matrix-version={matrix.version ?? undefined}
      className="cases-panel p-5 md:p-6"
    >
      {header}

      <div className="overflow-x-auto">
        <table
          data-permission-matrix-table
          style={{
            borderCollapse: "collapse",
            width: "100%",
            fontSize: 13.5,
          }}
        >
          <thead>
            <tr>
              <th
                scope="col"
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  fontWeight: 600,
                  color: "#172033",
                  borderBottom: "1px solid rgba(15,23,42,0.08)",
                  width: "55%",
                }}
              >
                Capability
              </th>
              {matrix.roles.map((r) => (
                <th
                  key={r.id}
                  scope="col"
                  data-permission-matrix-column={r.id}
                  data-permission-matrix-column-mine={
                    r.id === currentRole ? "true" : "false"
                  }
                  style={{
                    textAlign: "center",
                    padding: "8px 10px",
                    fontWeight: 600,
                    borderBottom: "1px solid rgba(15,23,42,0.08)",
                  }}
                >
                  <HeaderBadge role={r} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.categories.flatMap((category) => [
              <tr key={`cat-${category.id}`}>
                <td
                  colSpan={matrix.roles.length + 1}
                  data-permission-matrix-category={category.id}
                  style={{
                    padding: "12px 10px 6px",
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    color: "#5F6B7D",
                  }}
                >
                  {category.label}
                </td>
              </tr>,
              ...category.capabilities.map((cap) => (
                <tr
                  key={cap.id}
                  data-permission-matrix-row={cap.id}
                  style={{
                    background:
                      expanded === cap.id ? "#F2ECFE" : "transparent",
                  }}
                >
                  <td
                    style={{
                      padding: "8px 10px",
                      borderBottom: "1px solid rgba(15,23,42,0.05)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => (prev === cap.id ? null : cap.id))
                      }
                      data-permission-matrix-expand={cap.id}
                      style={{
                        background: "transparent",
                        border: 0,
                        padding: 0,
                        font: "inherit",
                        color: "#172033",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                      aria-expanded={expanded === cap.id}
                    >
                      <span style={{ fontWeight: 500 }}>{cap.label}</span>
                      {cap.description ? (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 11,
                            color: "#8793A6",
                          }}
                        >
                          {expanded === cap.id ? "Hide details ▴" : "Details ▾"}
                        </span>
                      ) : null}
                    </button>
                    {expanded === cap.id && cap.description ? (
                      <div
                        data-permission-matrix-detail={cap.id}
                        style={{
                          marginTop: 6,
                          padding: "8px 10px",
                          background: "rgba(255,255,255,0.55)",
                          borderRadius: 8,
                          fontSize: 12.5,
                          color: "#475569",
                          lineHeight: 1.5,
                        }}
                      >
                        {cap.description}
                      </div>
                    ) : null}
                  </td>
                  {matrix.roles.map((r) => (
                    <td
                      key={r.id}
                      style={{
                        textAlign: "center",
                        padding: "8px 10px",
                        borderBottom: "1px solid rgba(15,23,42,0.05)",
                      }}
                    >
                      <CapabilityCheckmark
                        allowed={cap.roles.includes(r.id)}
                        role={r}
                      />
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>

      <p
        className="m-0 mt-3 text-[11.5px] text-[#5F6B7D]"
        data-permission-matrix-footnote
      >
        Custom roles are not supported on the current plan. Workspace
        capabilities are defined and enforced by the API
        {matrix.version ? ` (catalog ${matrix.version})` : ""} — see Security
        Center for org-wide policy controls.
      </p>
    </section>
  );
}
