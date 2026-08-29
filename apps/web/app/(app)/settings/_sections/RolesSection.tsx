"use client";

/**
 * PHASE 12 VERTICAL A (2026-07-30) — "What your role can do here".
 *
 * Wires `GET /v1/platform/rbac/matrix` — the API binary's OWN capability
 * catalog — into the account console, answering the question a member
 * actually asks about themselves: *what am I allowed to do in the workspace
 * I am currently in, and what would change if my role changed?*
 *
 * Why the catalog is fetched rather than bundled
 * ----------------------------------------------
 * The role→capability mapping is enforced by the backend. A copy compiled
 * into the web bundle drifts silently the moment a route's gate changes, and
 * a drifted copy that OVER-states a role is a security-relevant lie. This
 * surface therefore renders ONLY what the server sends and shows the catalog
 * version it came from.
 *
 * NO CLIENT-SIDE POLICY DECISION
 * ------------------------------
 * Nothing here decides access. The viewer's role is the SERVER-projected
 * `workspace.membership.role` from the platform-context envelope, used purely
 * to emphasise a column. Every allow/deny cell is the server's own answer;
 * the component never computes one from a role hierarchy of its own.
 */

import { useCallback, useEffect, useId, useState } from "react";

import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { captureException } from "../../../../lib/sentry";
import {
  usePlatformContext,
  useTenantGuard,
} from "../../../../lib/platform-context";

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
  /** 428 — the account is behind on a required policy version. */
  | { kind: "LEGAL_REQUIRED" }
  | { kind: "ERROR"; title: string; message: string };

const muted: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

function readStatus(err: unknown): number | null {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === "number" ? s : null;
}

function isLegalGate(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    readStatus(err) === 428 ||
    (typeof code === "string" && code.toUpperCase().includes("LEGAL_REACCEPT"))
  );
}

export function RolesSection() {
  const { stamp, isStale } = useTenantGuard();
  const { envelope } = usePlatformContext();
  // SERVER-projected role for the ACTIVE space. Emphasis only — nothing here
  // decides access.
  //
  // PHASE 12 POINT 1 (2026-07-31) — migrated onto the canonical `activeSpace`
  // projection, off the deprecated single-workspace compatibility field.
  // Personal Space is always Owner; an organization space carries the server's
  // own role label.
  const activeSpace = envelope?.activeSpace ?? null;
  const myRole: string | null =
    activeSpace?.type === "PERSONAL" ? "OWNER" : activeSpace?.roleLabel ?? null;

  const [state, setState] = useState<State>({ kind: "LOADING" });

  const load = useCallback(async () => {
    const captured = stamp();
    setState({ kind: "LOADING" });
    try {
      const data = (await apiFetch("/v1/platform/rbac/matrix")) as RbacMatrix;
      if (isStale(captured)) return;
      setState({
        kind: "READY",
        matrix: {
          roles: Array.isArray(data?.roles) ? data.roles : [],
          categories: Array.isArray(data?.categories) ? data.categories : [],
          version: data?.version ?? null,
          generatedAt: data?.generatedAt ?? null,
        },
      });
    } catch (err) {
      if (isStale(captured)) return;
      if (readStatus(err) === 403) {
        setState({ kind: "DENIED" });
        return;
      }
      if (isLegalGate(err)) {
        setState({ kind: "LEGAL_REQUIRED" });
        return;
      }
      captureException(err, { feature: "settings_rbac_matrix" });
      const safe = toSafeUserError(err, {
        message: "The role reference could not be loaded.",
      });
      setState({ kind: "ERROR", title: safe.title, message: safe.message });
    }
  }, [stamp, isStale]);

  const [matrixOpen, setMatrixOpen] = useState(false);
  const matrixPanelId = useId();

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "LOADING") {
    return (
      <Card variant="admin" padding="comfortable" data-cc-roles-section="LOADING">
        <p style={muted}>Loading the role reference from the server…</p>
      </Card>
    );
  }

  if (state.kind === "DENIED") {
    return (
      <Card variant="admin" padding="comfortable" data-cc-roles-section="DENIED">
        <p style={{ ...muted, color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
          This reference is not available to you
        </p>
        <p style={{ ...muted, marginTop: 4 }}>
          Your account is not permitted to read the capability catalog. Ask a
          workspace administrator what your role includes.
        </p>
      </Card>
    );
  }

  if (state.kind === "LEGAL_REQUIRED") {
    return (
      <Card variant="admin" padding="comfortable" data-cc-roles-section="LEGAL_REQUIRED">
        <p style={{ ...muted, color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
          Accept the current policies to continue
        </p>
        <p style={{ ...muted, marginTop: 4 }}>
          This reference stays locked until your account accepts the latest
          policies — see Privacy &amp; legal records above.
        </p>
      </Card>
    );
  }

  if (state.kind === "ERROR") {
    return (
      <Card variant="admin" padding="comfortable" data-cc-roles-section="ERROR">
        <p style={{ ...muted, color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
          {state.title}
        </p>
        <p style={{ ...muted, marginTop: 4 }}>{state.message}</p>
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => void load()} data-cc-roles-retry>
            Try again
          </Button>
        </div>
      </Card>
    );
  }

  const { matrix } = state;

  if (matrix.roles.length === 0 || matrix.categories.length === 0) {
    return (
      <Card variant="admin" padding="comfortable" data-cc-roles-section="EMPTY">
        <p style={muted}>
          The server returned no capability catalog for this deployment.
        </p>
      </Card>
    );
  }

  return (
    <div className="set-roles" data-cc-roles-section="READY">
      {/* WHAT EACH ROLE CAN DO, in the reader's terms.
          Every line below is COUNTED FROM THE SERVER'S OWN CATALOG — the
          number of capabilities the API grants that role, and the categories
          it grants them in. Nothing here is a hand-written description of a
          role, because a hand-written description drifts the moment a gate
          changes and a drifted description that over-states a role is a
          security-relevant lie. */}
      <div className="set-grid set-grid--links" data-cc-roles-summaries>
        {matrix.roles.map((role) => {
          const granted = matrix.categories.flatMap((c) =>
            c.capabilities.filter((cap) => cap.roles.includes(role.id)),
          );
          const areas = matrix.categories.filter((c) =>
            c.capabilities.some((cap) => cap.roles.includes(role.id)),
          );
          const mine = role.id === myRole;
          return (
            <section
              key={role.id}
              className="set-card"
              data-cc-roles-summary-role={role.id}
              data-cc-roles-summary-mine={mine ? "true" : "false"}
            >
              <header className="set-card__head">
                <h3>{role.label}</h3>
                {mine ? (
                  <span className="set-state" data-tone="accent" data-cc-roles-my-role>
                    Your role
                  </span>
                ) : null}
              </header>
              <dl className="set-facts">
                <div>
                  <dt>Permissions</dt>
                  <dd>
                    {granted.length} of{" "}
                    {matrix.categories.reduce(
                      (n, c) => n + c.capabilities.length,
                      0,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Areas</dt>
                  <dd>
                    {areas.length > 0
                      ? areas.map((a) => a.label).join(" · ")
                      : "No permissions in this workspace"}
                  </dd>
                </div>
              </dl>
            </section>
          );
        })}
      </div>

      <p className="set-note">
        Roles are changed by a workspace administrator. Every permission below
        is answered by the API itself — if it is not granted, the action is
        refused no matter what the interface shows.
        {matrix.version ? ` Catalog ${matrix.version}.` : ""}
      </p>

      {/* THE DETAILED MATRIX — SECONDARY, AND CLOSED.
          Seven role x capability tables used to render expanded on the
          Settings landing page. They are the densest thing in the product and
          almost nobody arriving at Settings wants them, so they now live one
          deliberate click away, on this destination only. The data is
          unchanged: the same server catalog, the same cells. */}
      <button
        type="button"
        className="set-disclosure"
        aria-expanded={matrixOpen}
        aria-controls={matrixPanelId}
        onClick={() => setMatrixOpen((open) => !open)}
        data-cc-roles-matrix-toggle
      >
        {matrixOpen ? "Hide" : "View"} detailed permission matrix
      </button>

      {matrixOpen ? (
        <div id={matrixPanelId} className="set-matrix" data-cc-roles-matrix>
          {matrix.categories.map((category) => (
            <section
              key={category.id}
              className="set-matrix__group"
              data-cc-roles-category={category.id}
            >
              <h4>{category.label}</h4>

              <div className="set-matrix__scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Capability</th>
                      {matrix.roles.map((role) => (
                        <th
                          key={role.id}
                          scope="col"
                          data-cc-roles-column={role.id}
                          data-cc-roles-column-mine={role.id === myRole ? "true" : "false"}
                        >
                          {role.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {category.capabilities.map((capability) => (
                      <tr key={capability.id} data-cc-roles-capability={capability.id}>
                        <th scope="row">
                          {capability.label}
                          {capability.description ? (
                            <span>{capability.description}</span>
                          ) : null}
                        </th>
                        {matrix.roles.map((role) => {
                          const granted = capability.roles.includes(role.id);
                          return (
                            <td
                              key={role.id}
                              data-cc-roles-cell={granted ? "granted" : "denied"}
                            >
                              <span
                                aria-label={
                                  granted
                                    ? `${role.label} can ${capability.label}`
                                    : `${role.label} cannot ${capability.label}`
                                }
                              >
                                {granted ? "✓" : "—"}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
