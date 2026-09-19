import { Tabs } from "expo-router";
import { theme } from "../../src/theme/theme";

/**
 * Tabs group. The expo-router tab bar is hidden; navigation is the canonical
 * ProovraShell (phone bottom bar / tablet rail). Lifecycle scopes (archived /
 * trash / locked) are canonical Evidence Library scopes, and the pseudo Reports
 * screen was removed (Phase 12) — report actions live on Evidence.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: "none" },
        sceneStyle: { backgroundColor: theme.color.surface.app },
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="evidence" />
      <Tabs.Screen name="notifications" />
      <Tabs.Screen name="cases" />
      <Tabs.Screen name="teams" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}
