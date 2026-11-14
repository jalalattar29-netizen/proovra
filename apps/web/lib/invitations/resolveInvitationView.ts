/**
 * THE ONE render authority for the workspace invitation now lives in
 * @proovra/shared (`workspace-invitation-view.ts`) so the web /invite/[token]
 * page and the native invite screen resolve the SAME view from the same
 * inputs. This module re-exports it unchanged for existing web imports.
 */
export {
  resolveInvitationView,
  isRetryableRefusal,
  classifyWorkspaceEntryRefusal,
} from "@proovra/shared";
export type {
  InvitationEntryBlock,
  InvitationEntryOutcome,
  InvitationAuthState,
  InvitationLookupOutcome,
  InvitationAcceptOutcome,
  ResolveInvitationInput,
  InvitationViewKind,
  InvitationAction,
  InvitationView,
} from "@proovra/shared";
