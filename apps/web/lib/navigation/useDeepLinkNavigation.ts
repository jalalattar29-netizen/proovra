"use client";

/**
 * PHASE 11 §4 — THE ONE web click-time deep-link navigation chokepoint.
 *
 * Every authenticated product surface that OPENS a destination which may name
 * a tenant resource (notification rows, email-landing hrefs, audit resource
 * links, stale internal links) navigates through this hook. It composes the
 * existing canonical authorities — it decides NOTHING itself:
 *
 *   destination string
 *     → classify (internal resource? plain internal? external?)
 *     → resource links: POST /v1/deep-link/resolve (server re-derives the
 *       workspace from PERSISTence + canonical authorization; anti-enum 404)
 *     → Phase-7 dirty-work guard (block while dirty; explicit release proceeds)
 *     → stale-response rejection (generation counter — a resolution that
 *       returns after a newer open began is DISCARDED, never navigated)
 *     → router.push ONLY after server approval. No context mutation before.
 *
 * B2A-F-07 (Free-user audit 0ea0) — the approval now STEERS the navigation:
 *   - the resolver's \`workspaceId\` is the record's owning workspace; when it
 *     is not the active one, the canonical context switch runs FIRST
 *     (PlatformContext \`switchWorkspace\`, after the dirty-work guard above),
 *     so the record never opens under another workspace's header;
 *   - the ORIGINAL destination is opened — sub-path, query and hash kept
 *     (\`?tab=discussion#note\` used to be dropped);
 *   - only the app's real record routes are resolved
 *     (\`lib/navigation/deep-link-target.ts\`): \`/investigation/cases/:id/…\`
 *     resolves its case, and section pages under \`/reports\`, \`/review\`,
 *     \`/audit-transparency\` open as plain in-app paths instead of being
 *     "denied" for an id they do not carry.
 *
 * Open-redirect rule: an external/absolute/protocol-relative destination is
 * NEVER navigated from here — this chokepoint serves internal destinations
 * only. Public/signed share links do not come through here (they are
 * unauthenticated surfaces with their own signed-token authority).
 *
 * Denials are indistinguishable (server 404 anti-enumeration) — the caller
 * gets `{ status: "denied" }` and shows a generic "not available" affordance;
 * nothing about existence, membership, lifecycle, or capability leaks.
 */

import { isSafeRedirectAfter } from "@proovra/shared";
import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { resolveDeepLink } from "../api/deep-link";
import { getDirtyWorkLabels } from "../platform-context/dirtyWorkRegistry";
import { useOptionalPlatformContext } from "../platform-context/PlatformContextProvider";
import { parseDeepLinkTarget } from "./deep-link-target";

/**
 * Record families the server authority cannot resolve yet: it carries no
 * default read capability for them, so EVERY such link is concealed as 404
 * (CROSS-LANE request filed). Until it can, a denial of one of these opens the
 * page in the current workspace — the page enforces its own access — instead
 * of telling every recipient the item is unavailable.
 */
const SERVER_UNRESOLVED_TYPES = new Set(["cases", "evidence-requests"]);

export type DeepLinkOpenResult =
  | { status: "navigated"; path: string }
  | { status: "blocked_dirty"; labels: readonly string[] }
  | { status: "denied" }
  | { status: "stale" }
  | { status: "rejected_external" };

/** True when the destination is NOT an internal app path (open-redirect risk). */
function isExternalDestination(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) return true;
  // Absolute URLs, protocol-relative (//host), and scheme-ish (javascript:)
  // destinations are refused outright — this chokepoint never leaves the app.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return true;
  if (trimmed.startsWith("//")) return true;
  // PRO-PW-11 — and the ONE return-path contract: `/\host`, control
  // characters and anything a browser would resolve to another origin.
  return !trimmed.startsWith("/") || !isSafeRedirectAfter(trimmed);
}

export function useDeepLinkNavigation() {
  const router = useRouter();
  const ctx = useOptionalPlatformContext();
  // Read through a ref: the open() callback stays stable across renders.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  // Generation counter — each open() invalidates every in-flight resolution.
  const generationRef = useRef(0);
  const [pending, setPending] = useState(false);

  const open = useCallback(
    async (
      href: string,
      opts?: {
        /** Explicit dirty-work release confirmed by the user. */
        releaseDirtyWork?: boolean;
        /** Declared workspace hint (server validates; never authoritative). */
        declaredWorkspaceId?: string | null;
      },
    ): Promise<DeepLinkOpenResult> => {
      // 1. Open-redirect refusal — before ANY other step.
      if (isExternalDestination(href)) return { status: "rejected_external" };

      // 2. Phase-7 dirty-work guard — BEFORE any navigation or resolution
      //    side effect. Blocked unless the caller passes an explicit release.
      const dirty = getDirtyWorkLabels();
      if (dirty.length > 0 && !opts?.releaseDirtyWork) {
        return { status: "blocked_dirty", labels: dirty };
      }

      const generation = ++generationRef.current;
      setPending(true);
      try {
        const target = parseDeepLinkTarget(href);

        // Not a record route → plain internal navigation (still guarded by
        // step 1 against leaving the app; the page gates itself).
        if (!target.resource) {
          router.push(target.path);
          return { status: "navigated", path: target.path };
        }

        // 3. Server authority: POST /v1/deep-link/resolve re-derives the
        //    record's workspace from persistence and authorizes the actor.
        const resolved = await resolveDeepLink({
          resourceType: target.resource.type,
          resourceId: target.resource.id,
          declaredWorkspaceId: opts?.declaredWorkspaceId ?? null,
        });

        // 4. Stale-response rejection — a newer open() supersedes this one;
        //    the late result is discarded and NOTHING navigates or mutates.
        if (generation !== generationRef.current) return { status: "stale" };

        if (resolved === null) {
          if (SERVER_UNRESOLVED_TYPES.has(target.resource.type)) {
            router.push(target.path);
            return { status: "navigated", path: target.path };
          }
          return { status: "denied" };
        }

        // 5. B2A-F-07 — open it IN its workspace: switch first when the
        //    owning workspace is not the active one.
        const live = ctxRef.current;
        if (live && resolved.workspaceId && resolved.workspaceId !== live.activeWorkspaceId) {
          const personalId =
            live.envelope?.contextOptions?.personalSpace?.workspaceId ??
            live.envelope?.personalSpace?.id ??
            null;
          await live.switchWorkspace(resolved.workspaceId === personalId ? null : resolved.workspaceId);
          if (generation !== generationRef.current) return { status: "stale" };
        }

        // Server-approved destination. Navigation happens ONLY now — after
        // approval (and the switch) — to the original path, remainder kept.
        router.push(target.path);
        return { status: "navigated", path: target.path };
      } finally {
        if (generation === generationRef.current) setPending(false);
      }
    },
    [router],
  );

  return { open, pending };
}
