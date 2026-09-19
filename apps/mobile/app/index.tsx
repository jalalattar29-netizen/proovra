import { Redirect } from "expo-router";
import { useAuth } from "../src/auth-context";
import { bootDestination } from "../src/bootstrap/bootstrap-machine";
import { ProovraScreen, ProovraLoadingState } from "../src/ui";

/**
 * Boot gate. Root navigation is driven by the deterministic bootstrap machine's
 * decision function — an expired/invalid token can never land in the main app
 * (it is cleared → gateway), and an offline session opens the app rather than
 * being treated as invalid credentials.
 */
export default function Index() {
  const { token, bootPhase } = useAuth();
  const dest = bootDestination({ phase: bootPhase, hasToken: !!token });

  if (dest === "pending") {
    return (
      <ProovraScreen scroll={false}>
        <ProovraLoadingState label="Restoring your session" />
      </ProovraScreen>
    );
  }
  if (dest === "gateway") {
    return <Redirect href="/(stack)/auth" />;
  }
  return <Redirect href="/(tabs)" />;
}
