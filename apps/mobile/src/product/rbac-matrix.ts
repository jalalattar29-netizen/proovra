/**
 * ROLE PERMISSIONS — "Who can do what" (T-15) — the native port of
 * `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx`.
 *
 * GET /v1/platform/rbac/matrix is the API binary's own capability catalog.
 * Rendered verbatim and read-only: roles in the server's rank order
 * (strongest first), every allow/deny the server's answer; a role id this
 * build has never seen is still shown, never dropped. No client policy.
 */
export const RBAC_MATRIX_PATH = "/v1/platform/rbac/matrix";

export interface MatrixRole {
  id: string;
  label: string;
  rank: number;
}
export interface MatrixCapability {
  id: string;
  label: string;
  description: string | null;
  roles: string[];
}
export interface MatrixCategory {
  id: string;
  label: string;
  capabilities: MatrixCapability[];
}
export interface RbacMatrix {
  roles: MatrixRole[];
  categories: MatrixCategory[];
  version: string | null;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseRbacMatrix(payload: unknown): RbacMatrix {
  const d = o(payload);
  const roles = (Array.isArray(d["roles"]) ? d["roles"] : [])
    .map((r) => o(r))
    .filter((r) => s(r.id))
    .map((r) => ({ id: s(r.id) as string, label: s(r.label) ?? (s(r.id) as string), rank: typeof r.rank === "number" ? (r.rank as number) : 0 }))
    .sort((a, b) => b.rank - a.rank);
  const categories = (Array.isArray(d["categories"]) ? d["categories"] : [])
    .map((c) => o(c))
    .filter((c) => s(c.id))
    .map((c) => ({
      id: s(c.id) as string,
      label: s(c.label) ?? (s(c.id) as string),
      capabilities: (Array.isArray(c.capabilities) ? c.capabilities : [])
        .map((x) => o(x))
        .filter((x) => s(x.id))
        .map((x) => ({
          id: s(x.id) as string,
          label: s(x.label) ?? (s(x.id) as string),
          description: s(x.description),
          roles: (Array.isArray(x.roles) ? x.roles : []).filter((r): r is string => typeof r === "string"),
        })),
    }));
  return { roles, categories, version: s(d["version"]) };
}

/** Touch adaptation of the grid: the roles allowed, in the server's order. */
export function allowedRoleLabels(cap: MatrixCapability, roles: MatrixRole[]): string[] {
  return roles.filter((r) => cap.roles.includes(r.id)).map((r) => r.label);
}

export const RBAC_COPY = {
  trigger: "Role permissions",
  title: "Who can do what",
  intro: "What each role on this team can do. This list comes from the API — if a cell isn't checked, the action is blocked for that role.",
  loading: "Loading the role reference from the server…",
  denied: "Your account is not permitted to read the capability catalog. Ask a workspace administrator what your role includes.",
  failed: "The role reference could not be loaded.",
  empty: "The server returned no capability catalog for this deployment.",
  noRole: "No role can do this.",
} as const;
