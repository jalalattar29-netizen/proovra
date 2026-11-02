/**
 * WHERE THIS CAPTURE WILL BE FILED, said before it is filed (MOBILE-003).
 *
 * A capture screen showed no workspace at all, so a record could land in the
 * wrong one without anybody having been told where it was going.
 */
import { View } from "react-native";

import {
  refreshPlatformContext,
  WORKSPACE_UNCONFIRMED_MESSAGE,
  type WorkspaceResolution,
} from "../product/platform-context";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraText } from "./index";

export function CaptureDestination({ workspace }: { workspace: WorkspaceResolution }) {
  if (workspace.state === "resolved") {
    return (
      <ProovraText variant="label" color={theme.color.ink.secondary} testID="capture-destination">
        {`Saving to ${workspace.name ?? "this workspace"}`}
      </ProovraText>
    );
  }
  if (workspace.state === "resolving") {
    return (
      <ProovraText variant="label" color={theme.color.ink.muted} testID="capture-destination-pending">
        Confirming your workspace…
      </ProovraText>
    );
  }
  return (
    <View style={{ gap: theme.space.s2 }} testID="capture-destination-unavailable">
      <ProovraText variant="label" color={theme.color.status.risk.fg}>
        {WORKSPACE_UNCONFIRMED_MESSAGE}
      </ProovraText>
      <ProovraButton label="Check workspace again" variant="secondary" fullWidth={false} onPress={refreshPlatformContext} />
    </View>
  );
}
