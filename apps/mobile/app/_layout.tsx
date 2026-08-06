import { Tabs } from "expo-router";
import React from "react";

import { DeepLinkGate } from "../src/DeepLinkGate";
import { ErrorBoundary } from "../src/error-boundary";

export default function TabsLayout() {
  return (
    /* Phase 12 Point 4 (Pass E) — the global crash boundary. It existed
       with a Sentry report path (`mobile_global_error`) but was never
       mounted, so an unhandled render error in any screen produced a
       blank/crashed app and reported nothing. The Expo Router root
       layout is the ONE mount point that covers every route. */
    <ErrorBoundary>
    {/* PHASE 11 §5 — the ONE universal/deep-link consumer (server-resolved). */}
    <DeepLinkGate />
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: "#8ae9ff",
        tabBarInactiveTintColor: "#7c8aa5",
        tabBarStyle: {
          backgroundColor: "#050b18",
          borderTopColor: "rgba(101,235,255,0.14)",
          height: 66,
          paddingTop: 8,
          paddingBottom: 8,
        },
        sceneStyle: {
          backgroundColor: "#050b18",
        },
      }}
    >
<Tabs.Screen
  name="archive"
  options={{ title: "Archived Evidence" }}
/>

<Tabs.Screen
  name="deleted"
  options={{ title: "Deleted Evidence" }}
/>

<Tabs.Screen
  name="locked"
  options={{ title: "Locked Evidence" }}
/>
    </Tabs>
    </ErrorBoundary>
  );
}
