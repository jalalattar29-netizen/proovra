/**
 * SHELL GATES (T-09e / RC-10) — what the shell renders INSTEAD of a screen.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * `AppShellV2.tsx:146-159,241-247` swaps the page for a recovery surface in two
 * cases, on EVERY authenticated route:
 *
 *   1. `envelope.recoveryActions` is non-empty — the server could not assemble
 *      a healthy workspace (`platform-context.service.ts` buildRecoveryActions).
 *      The web renders `WorkspaceRecoveryPanel`: never a blank or broken shell.
 *   2. The managed-Organization policy forbids Personal Space and the ACTIVE
 *      space is Personal (`personalSpaceGate.ts` resolvePersonalSpaceGate). The
 *      web renders `PersonalSpaceUnavailablePanel` so Personal content is never
 *      shown against policy.
 *
 * Native checked neither in the shell. Case 2 was enforced on the three capture
 * screens alone, so Home, Evidence, Cases and Reports went on rendering
 * Personal content the policy forbids; case 1 was not handled anywhere, so a
 * broken workspace rendered as a screen of failed requests.
 *
 * PURE — no React, no fetch — so the decision is testable against the web's.
 */
import { NATIVE_NAV_ROUTES } from "./navigation";

export interface RecoveryAction {
  readonly id: string;
  readonly label: string;
  /** Native route to open, or null for Retry (which re-reads the envelope). */
  readonly href: string | null;
}

export type ShellGate =
  | { readonly kind: "none" }
  | { readonly kind: "recovery"; readonly actions: readonly RecoveryAction[]; readonly requestId: string | null }
  | { readonly kind: "personal-unavailable"; readonly switchAvailable: boolean };

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Web recovery hrefs → native routes. The server writes WEB paths; each is
 * mapped to the native screen that does the same job. An href with no native
 * screen yields NO action: a button that leads nowhere is worse than none.
 */
const WEB_TO_NATIVE_HREF: Readonly<Record<string, string>> = {
  ...Object.fromEntries(NATIVE_NAV_ROUTES.map((r) => [r.webHref, r.href])),
  "/settings": "/settings",
  // next.config.js: `/teams` 308s to `/collaboration-teams`, which natively is `/teams`.
  "/teams": "/teams",
  "/workspaces": "/spaces",
  "/support": "/support",
};

export function nativeHrefForWebPath(href: string): string | null {
  return WEB_TO_NATIVE_HREF[href] ?? null;
}

/** `firstAvailableNonPersonalWorkspaceId` (personalSpaceGate.ts) — is there anywhere to go? */
function hasNonPersonalWorkspace(contextOptions: unknown): boolean {
  const co = obj(contextOptions);
  const owned = co["ownedWorkspaces"];
  if (Array.isArray(owned) && owned.some((w) => typeof obj(w)["workspaceId"] === "string")) return true;
  const orgs = co["organizations"];
  if (Array.isArray(orgs)) {
    for (const g of orgs) {
      const ws = obj(g)["workspaces"];
      if (Array.isArray(ws) && ws.some((w) => typeof obj(w)["workspaceId"] === "string")) return true;
    }
  }
  return false;
}

/**
 * The gate for an envelope. Recovery takes precedence, exactly as on the web:
 * a broken envelope cannot be gated on a field it may not even carry.
 * `null` (not loaded yet, or unreadable) is "none" — the screens' own error
 * states handle a failed read; the shell must not invent a recovery state.
 */
export function resolveShellGate(envelope: unknown): ShellGate {
  if (envelope == null) return { kind: "none" };
  const env = obj(envelope);

  const raw = Array.isArray(env["recoveryActions"]) ? (env["recoveryActions"] as unknown[]) : [];
  if (raw.length > 0) {
    const actions: RecoveryAction[] = [];
    for (const a of raw) {
      const o = obj(a);
      const id = typeof o["id"] === "string" ? o["id"] : null;
      const label = typeof o["label"] === "string" ? o["label"] : null;
      if (!id || !label) continue;
      if (id === "retry") {
        actions.push({ id, label, href: null });
        continue;
      }
      const href = typeof o["href"] === "string" ? nativeHrefForWebPath(o["href"]) : null;
      if (href) actions.push({ id, label, href });
    }
    // Retry is always offered even if the server omitted it: it is the one
    // action that cannot lead anywhere wrong.
    if (!actions.some((a) => a.id === "retry")) actions.push({ id: "retry", label: "Retry", href: null });
    const requestId = obj(env["diagnostics"])["requestId"];
    return { kind: "recovery", actions, requestId: typeof requestId === "string" ? requestId : null };
  }

  if (env["personalSpaceAllowed"] === false && obj(env["activeSpace"])["type"] === "PERSONAL") {
    return { kind: "personal-unavailable", switchAvailable: hasNonPersonalWorkspace(env["contextOptions"]) };
  }
  return { kind: "none" };
}

/** Web copy, verbatim (WorkspaceRecoveryPanel.tsx / PersonalSpaceUnavailablePanel.tsx). */
export const RECOVERY_COPY = {
  statusLabel: "Workspace setup required",
  title: "Let's get you back into the product",
  message: "Workspace setup is required to continue. Pick an option below or retry the request.",
} as const;

export const PERSONAL_UNAVAILABLE_COPY = {
  statusLabel: "Personal Space",
  title: "Personal Space isn't available right now",
  message:
    "Personal Space is unavailable under managed Organization policy. Your existing Personal evidence is preserved and untouched. Ask your organization administrator to assign you an Organization workspace to continue.",
  /**
   * The web switches automatically when another workspace exists
   * (`usePersonalSpaceGate` heal). Native offers the same move as an explicit
   * action through the ONE switching surface, `/spaces`, rather than growing a
   * second writer of the active-workspace pointer inside the shell.
   */
  switchLabel: "Switch workspace",
  supportLabel: "Help & support",
} as const;
