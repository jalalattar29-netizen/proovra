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
 * Open-redirect rule: an external/absolute/protocol-relative destination is
 * NEVER navigated from here — this chokepoint serves internal destinations
 * only. Public/signed share links do not come through here (they are
 * unauthenticated surfaces with their own signed-token authority).
 *
 * Denials are indistinguishable (server 404 anti-enumeration) — the caller
 * gets `{ status: "denied" }` and shows a generic "not available" affordance;
 * nothing about existence, membership, lifecycle, or capability leaks.
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { resolveDeepLinkPath } from "../api/deep-link";
import { getDirtyWorkLabels } from "../platform-context/dirtyWorkRegistry";

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
  return !trimmed.startsWith("/");
}

export function useDeepLinkNavigation() {
  const router = useRouter();
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
        // 3. Server authority. For a tenant-resource path this calls
        //    POST /v1/deep-link/resolve; for a plain internal path it
        //    returns null and we navigate the (already internal-safe) href.
        const resolved = await resolveDeepLinkPath(
          href,
          opts?.declaredWorkspaceId ?? null,
        );

        // 4. Stale-response rejection — a newer open() supersedes this one;
        //    the late result is discarded and NOTHING navigates or mutates.
        if (generation !== generationRef.current) return { status: "stale" };

        if (resolved !== null) {
          // Server-approved resource destination (workspace re-derived from
          // persistence). Navigation happens ONLY now — after approval.
          router.push(resolved);
          return { status: "navigated", path: resolved };
        }

        // Not a resource deep-link at all → plain internal navigation
        // (still guarded by step 1 against leaving the app). A DENIED
        // resource link also returns null from the resolver — distinguish
        // by re-parsing: if the path names a resource, it was denied.
        const looksLikeResource = /^\/(evidence|cases|investigation|evidence-requests|reports|review|audit-transparency)\//.test(
          href.trim(),
        );
        if (looksLikeResource) return { status: "denied" };

        router.push(href);
        return { status: "navigated", path: href };
      } finally {
        if (generation === generationRef.current) setPending(false);
      }
    },
    [router],
  );

  return { open, pending };
}
