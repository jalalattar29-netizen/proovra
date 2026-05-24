/**
 * PHASE R5 — Per-mode disclosure help copy.
 *
 * Consumes the R1.5B `helpAudience` discriminator and the R4
 * canonical product-language vocabulary to author a small, bounded
 * dictionary of help / empty-state copy for each experience mode.
 *
 * Hard rules:
 *
 *   1. Each mode has at most ONE primary hint + ONE secondary hint.
 *      Bounded surface; no help-text explosion.
 *
 *   2. Copy follows R4 tone rules: operational, calm, no marketing
 *      fluff, no panic, no developer slang.
 *
 *   3. Mentions of "advanced governance tools" / "lifecycle tools"
 *      etc. must use the R4 canonical terms.
 *
 *   4. The dictionary is presentation-only. Surfaces that need
 *      mode-specific help copy import from here.
 */

import type { WorkspaceExperienceMode } from "../workspace-experience/types";

export interface DisclosureHelpCopy {
  /** Primary operationally-meaningful action hint. */
  readonly primary: string;
  /**
   * Secondary hint reassuring the user that advanced tools remain
   * discoverable when the workspace needs them.
   */
  readonly secondary: string;
}

export const DISCLOSURE_HELP_BY_MODE: Record<
  WorkspaceExperienceMode,
  DisclosureHelpCopy
> = {
  PERSONAL: {
    primary: "Start with a capture or review your recent evidence.",
    secondary:
      "Advanced governance, lifecycle, and reviewer tools remain available when your workspace needs them.",
  },
  ORGANIZATION: {
    primary:
      "Review queues, escalations, and intake operations from your operational workspace.",
    secondary:
      "Governance posture, retention policy, and lifecycle reviews are available for workspace oversight.",
  },
  REVIEW_OPS: {
    primary:
      "Open the reviewer queue and triage escalations to keep operational pressure in track.",
    secondary:
      "Governance posture and lifecycle reviews remain available for the workspace oversight you support.",
  },
  GOVERNANCE: {
    primary:
      "Review governance posture, retention policy, and lifecycle reviews to keep the workspace compliant.",
    secondary:
      "Reviewer operations and case operations remain available for cross-functional oversight.",
  },
};

/**
 * Resolve the help copy for a given experience mode. Falls back to
 * PERSONAL when an unrecognized mode is supplied — same neutral
 * default policy as `resolveWorkspaceExperience`.
 */
export function resolveDisclosureHelp(
  mode: WorkspaceExperienceMode,
): DisclosureHelpCopy {
  return DISCLOSURE_HELP_BY_MODE[mode] ?? DISCLOSURE_HELP_BY_MODE.PERSONAL;
}
