/**
 * PHASE 11 §5 — the REAL mobile universal/deep-link consumer.
 *
 * Mounted once at the app root. Listens for incoming universal/app links and
 * routes them through the canonical client authority (`resolveMobileDeepLink`),
 * which parses ONLY the closed link shape, blocks unsafe transitions during
 * active capture/upload, and asks the SERVER (POST /v1/deep-link/resolve) to
 * authorize + re-derive the workspace before any navigation. Unsupported links
 * are ignored; denials show one generic toast (anti-enumeration preserved).
 */

import { useEffect } from "react";
import { Alert } from "react-native";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";

import { apiFetch } from "./api";
import { listQueue } from "./upload-queue";
import { resolveMobileDeepLink } from "./deep-link";

function hasActiveWork(): boolean {
  try {
    return listQueue().some(
      (item) =>
        item.status === "PENDING" ||
        item.status === "UPLOADING" ||
        item.status === "COMPLETING",
    );
  } catch {
    // If the queue store is unavailable, fail SAFE: treat as busy so a link
    // can never force a context change past an unknown capture state.
    return true;
  }
}

export function DeepLinkGate() {
  const url = Linking.useURL();
  const router = useRouter();

  useEffect(() => {
    if (!url) return;
    let disposed = false;
    void resolveMobileDeepLink(url, {
      resolve: (input) =>
        apiFetch("/v1/deep-link/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }) as Promise<{ ok?: boolean; workspaceId?: string } | null>,
      hasActiveWork,
    }).then((outcome) => {
      if (disposed) return;
      if (outcome.status === "navigate") {
        // The workspace came from the SERVER; the URL never carried tenant truth.
        router.push(outcome.route as never);
      } else if (outcome.status === "denied") {
        // Anti-enumeration: one generic message for every denial cause.
        Alert.alert("Not available", "This item is not available.");
      } else if (outcome.status === "blocked_busy") {
        Alert.alert(
          "Capture in progress",
          "Finish or pause the current capture before opening links.",
        );
      }
      // "unsupported" / "stale" → ignored safely, no navigation, no message.
    });
    return () => {
      disposed = true;
    };
  }, [url, router]);

  return null;
}
