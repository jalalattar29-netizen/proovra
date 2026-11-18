/**
 * PRO-NA-04 — ONE WAY TO OPEN A RECORD LINK, SIGNED IN NOW OR AFTER SIGN-IN.
 *
 * A record link tapped while signed in is resolved on the server, the app
 * switches to the record's workspace and only then navigates (DeepLinkGate,
 * B2A-F-07). The same link opened while signed out was replayed after sign-in
 * as a raw route, in whatever workspace happened to be active, and showed "not
 * available" for a record the person can open. The post-sign-in replay now runs
 * through this helper: the same server resolve, the same switch (applied to the
 * request header at once, PRO-NA-06) and the same announcement (PRO-NA-07).
 */
import { Alert } from "react-native";

import { apiFetch } from "../api";
import { resolveMobileDeepLink } from "../deep-link";
import { adoptSwitchedWorkspace } from "../product/platform-context";
import { SWITCH_WORKSPACE_PATH, buildSwitchWorkspaceBody } from "../product/spaces";

export const RECORD_LINK_SWITCH_NOTICE = "Opened in the record's workspace — you are now working there.";

export async function openRecordLinkInItsWorkspace(
  url: string,
  deps: {
    navigate: (route: string) => void;
    hasActiveWork: () => boolean;
    activeTeamId: string | null;
    notify?: (message: string) => void;
  },
): Promise<"navigated" | "denied" | "offline" | "blocked_busy" | "unsupported" | "stale"> {
  const outcome = await resolveMobileDeepLink(url, {
    resolve: (input) =>
      apiFetch("/v1/deep-link/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }) as Promise<{ ok?: boolean; workspaceId?: string } | null>,
    hasActiveWork: deps.hasActiveWork,
  });
  if (outcome.status === "navigate") {
    const target = outcome.workspaceId;
    if (target && target !== deps.activeTeamId) {
      try {
        const switched = await apiFetch(SWITCH_WORKSPACE_PATH, {
          method: "POST",
          body: JSON.stringify(buildSwitchWorkspaceBody(target)),
        });
        adoptSwitchedWorkspace(switched, target);
        deps.notify?.(RECORD_LINK_SWITCH_NOTICE);
      } catch {
        Alert.alert("Not available", "This item is not available.");
        return "denied";
      }
    }
    deps.navigate(outcome.route);
    return "navigated";
  }
  if (outcome.status === "denied") Alert.alert("Not available", "This item is not available.");
  else if (outcome.status === "offline") Alert.alert("You appear to be offline", "Connect to the internet, then open the link again.");
  else if (outcome.status === "blocked_busy") Alert.alert("Capture in progress", "Finish or pause the current capture before opening links.");
  return outcome.status;
}
