/**
 * PHASE R6 — Canonical hub context orchestrator.
 *
 * Pure function. Given a hub id + optional capability map, returns
 * the bounded hub context (definition + quick actions). Future
 * surfaces (hub-specific empty states, sidebar group highlights,
 * dashboard cross-links) consume this same resolver so the hub
 * vocabulary stays single-sourced.
 *
 * Hard rules:
 *
 *   1. Pure. No fetches. No await. No authorization decisions.
 *
 *   2. Quick actions are NEVER filtered by capability — that would
 *      be a permission fork. They are presentation shortcuts; the
 *      destination route's own PageRouteGate handles unauthorized
 *      clicks.
 */

import { HUB_DEFINITIONS, HUB_QUICK_ACTIONS_MAX } from "./hubDefinitions";
import type {
  HubContextResult,
  HubDefinition,
  HubId,
  ResolveHubContextInput,
} from "./types";

export function resolveHubContext(
  input: ResolveHubContextInput,
): HubContextResult {
  const definition: HubDefinition | undefined = HUB_DEFINITIONS[input.hubId];
  if (!definition) {
    // Defensive: an unrecognized hub id falls back to the
    // investigation hub (a generic operational entry point).
    return resolveHubContext({ hubId: "investigation" });
  }
  // Defensive bound — rules file enforces this at definition time;
  // the slice protects against future drift.
  const quickActions = definition.quickActions.slice(
    0,
    HUB_QUICK_ACTIONS_MAX,
  );
  return {
    definition,
    quickActions,
  };
}

/** Type-safe lookup of a definition without going through the resolver. */
export function getHubDefinition(hubId: HubId): HubDefinition | undefined {
  return HUB_DEFINITIONS[hubId];
}
