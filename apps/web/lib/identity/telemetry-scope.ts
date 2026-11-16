/**
 * B1-F-003 (free-audit 0ea0) — WHOSE SECURITY TELEMETRY THIS LIST IS.
 *
 * `GET /v1/identity-security/devices` and `/sessions` now answer a read-only
 * role (VIEWER, MEMBER) with ONLY the caller's own rows and say so with
 * `scope: "self"`; an identity administrator (OWNER / ADMIN) gets
 * `scope: "team"`. The revoke routes behind every "Revoke" button need the
 * administrator permission, so a "self" list must never offer them.
 *
 * An older API sends no `scope` and served the team list to everyone; that is
 * `"legacy"`, rendered exactly as before (the server still refuses a revoke a
 * role may not perform).
 */
export type TelemetryScope = "team" | "self" | "legacy";

export function readTelemetryScope(body: unknown): TelemetryScope {
  const scope = (body as { scope?: unknown } | null | undefined)?.scope;
  if (scope === "self") return "self";
  if (scope === "team") return "team";
  return "legacy";
}

/** Revoke / remove-trust controls are offered only on a team-wide list. */
export function telemetryOffersRevoke(scope: TelemetryScope): boolean {
  return scope !== "self";
}
