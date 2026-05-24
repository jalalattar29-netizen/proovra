/**
 * PHASE R6 — Canonical hubs package entry point.
 *
 * Pure orchestration. No fetches. No authorization.
 */

export {
  HUB_IDS,
  type HubId,
  type HubDefinition,
  type HubQuickAction,
  type HubContextResult,
  type ResolveHubContextInput,
} from "./types";

export {
  HUB_DEFINITIONS,
  HUB_QUICK_ACTIONS_MAX,
} from "./hubDefinitions";

export {
  resolveHubContext,
  getHubDefinition,
} from "./resolveHubContext";
