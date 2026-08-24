// D:\digital-witness\apps\mobile\app\(tabs)\_layout.tsx
import { Tabs } from "expo-router";
import { appTheme } from "../../src/app-theme";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: "none" },
        sceneStyle: { backgroundColor: appTheme.bg },
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="cases" />
      <Tabs.Screen name="reports" />
      <Tabs.Screen name="teams" />
      <Tabs.Screen name="settings" />

      <Tabs.Screen
        name="archive"
        options={{ title: "Archived Evidence" }}
      />

      {/* EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — "Deleted Evidence"
          described an operation this tab never performed: nothing in it is
          deleted, every record is physically present and every one is
          restorable. The ROUTE name stays `deleted` (renaming it would break
          deep links); the label a person reads does not. */}
      <Tabs.Screen
        name="deleted"
        options={{ title: "Trash" }}
      />

      <Tabs.Screen
        name="locked"
        options={{ title: "Locked Evidence" }}
      />
    </Tabs>
  );
}