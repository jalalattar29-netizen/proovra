// D:\digital-witness\apps\mobile\app\(tabs)\_layout.tsx
import { Tabs } from "expo-router";
import { appTheme } from "../../src/app-theme";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: "none" },
        sceneStyle: { backgroundColor: appTheme.bg }
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="cases" />
      <Tabs.Screen name="reports" />
      <Tabs.Screen name="teams" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}