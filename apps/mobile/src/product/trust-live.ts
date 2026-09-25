/**
 * TRUST CENTER — LIVE DATA (T-15) — the native port of the web's
 * `/trust-center/status` (GET /v1/trust/status) and
 * `/trust-center/subprocessors` (GET /v1/trust/subprocessors, per-vendor
 * GET /v1/trust/subprocessors/:id/versions).
 *
 * Native listed "Status" and "Subprocessors" ARTICLES; the web shows the live
 * status projection (overall health, components, incidents, maintenance,
 * limitations) and the subprocessor REGISTRY (region, data categories,
 * effective date, documentation, change history). A `degraded` answer is
 * shown as degraded with its reason — never as "nothing here".
 */
import type {
  MaintenanceWindowProjection,
  StatusComponentProjection,
  StatusIncidentProjection,
  StatusPageProjection,
  SubprocessorProjection,
} from "@proovra/shared";

export const TRUST_STATUS_PATH = "/v1/trust/status";
export const TRUST_SUBPROCESSORS_PATH = "/v1/trust/subprocessors";
export function buildSubprocessorVersionsPath(id: string): string {
  return `/v1/trust/subprocessors/${encodeURIComponent(id)}/versions`;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export type LiveRead<T> = { phase: "loaded"; value: T } | { phase: "empty" } | { phase: "degraded"; reason: string };

/** `{ status, degraded, reason }` → loaded / empty / degraded (page.tsx:46-71). */
export function parseTrustStatus(payload: unknown): LiveRead<StatusPageProjection> {
  const d = o(payload);
  if (d["degraded"] === true) return { phase: "degraded", reason: s(d["reason"]) ?? "SCHEMA_NOT_READY" };
  const p = o(d["status"]);
  if (!Array.isArray(p["components"])) return { phase: "empty" };
  const components = arr(p["components"]).map((c) => o(c)).filter((c) => s(c["key"])) as unknown as StatusComponentProjection[];
  const incidents = (v: unknown) =>
    arr(v)
      .map((i) => o(i))
      .filter((i) => s(i["id"]))
      .map((i) => ({ ...i, componentKeys: arr(i["componentKeys"]), updates: arr(i["updates"]).map((u) => o(u)) })) as unknown as StatusIncidentProjection[];
  return {
    phase: "loaded",
    value: {
      ...(p as unknown as StatusPageProjection),
      components,
      activeIncidents: incidents(p["activeIncidents"]),
      recentIncidents: incidents(p["recentIncidents"]),
      maintenanceWindows: arr(p["maintenanceWindows"])
        .map((w) => o(w))
        .filter((w) => s(w["id"]))
        .map((w) => ({ ...w, componentKeys: arr(w["componentKeys"]) })) as unknown as MaintenanceWindowProjection[],
      limitations: arr(p["limitations"]).filter((l): l is string => typeof l === "string"),
    },
  };
}

export function parseSubprocessorRegistry(payload: unknown): LiveRead<SubprocessorProjection[]> {
  const d = o(payload);
  if (d["degraded"] === true) return { phase: "degraded", reason: s(d["reason"]) ?? "SUBPROCESSOR_READ_FAILED" };
  const rows = arr(d["subprocessors"])
    .map((r) => o(r))
    .filter((r) => s(r["id"]))
    .map((r) => ({ ...r, dataCategories: arr(r["dataCategories"]).filter((c): c is string => typeof c === "string") })) as unknown as SubprocessorProjection[];
  return rows.length ? { phase: "loaded", value: rows } : { phase: "empty" };
}

export interface SubprocessorVersion {
  id: string;
  version: number;
  state: string | null;
  effectiveAt: string | null;
  summary: string;
  region: string | null;
  dataCategories: string[];
}

/** `_version-history.tsx` SubprocessorVersionHistory, newest first. */
export function parseSubprocessorVersions(payload: unknown): SubprocessorVersion[] {
  return arr(o(payload)["versions"])
    .map((raw) => {
      const v = o(raw);
      const snap = o(v["snapshot"]);
      const id = s(v["id"]);
      if (!id || typeof v["version"] !== "number") return null;
      return {
        id,
        version: v["version"] as number,
        state: s(snap["state"]),
        effectiveAt: s(snap["effectiveAtUtc"]) ?? s(v["effectiveAtUtc"]) ?? s(v["effectiveAt"]),
        summary: s(v["changeSummary"]) ?? s(v["changeNote"]) ?? "No change summary was recorded.",
        region: s(snap["region"]),
        dataCategories: arr(snap["dataCategories"]).filter((c): c is string => typeof c === "string"),
      };
    })
    .filter((v): v is SubprocessorVersion => v !== null)
    .sort((a, b) => b.version - a.version);
}

/** `SOME_IDENTIFIER` → "Some identifier" (the web's identifierLabel). */
export function identifierLabel(id: string): string {
  const t = String(id ?? "").replace(/_/g, " ").trim().toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "—";
}

/** subprocessors/page.tsx degradedMessage, verbatim. */
export function subprocessorDegradedMessage(code: string): string {
  switch (code) {
    case "SCHEMA_NOT_READY":
      return "The Subprocessor Registry is temporarily degraded because the required backend schema is not ready yet.";
    case "DB_UNAVAILABLE":
      return "The Subprocessor Registry is temporarily degraded because the database is unavailable.";
    case "SUBPROCESSOR_AUTO_SEED_FAILED":
      return "The Subprocessor Registry is temporarily degraded because the canonical vendor seed could not be prepared.";
    default:
      return "The Subprocessor Registry is temporarily degraded because subprocessors could not be loaded safely.";
  }
}

export const TRUST_LIVE_COPY = {
  statusFailed: "Status page could not be loaded. Press Retry to try again.",
  statusDegraded: "Status page is degraded.",
  statusEmpty: "No status components configured for this workspace yet.",
  subprocessorsFailed: "Subprocessors could not be loaded. Press Refresh to try again.",
  subprocessorsEmpty: "No subprocessors registered.",
  historyFailed: "The change history could not be loaded.",
} as const;
