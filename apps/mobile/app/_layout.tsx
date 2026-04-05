import { Tabs } from "expo-router";
import React from "react";

export default function TabsLayout() {
  return (
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
        name="home"
        options={{
          title: "Home",
        }}
      />

      <Tabs.Screen
        name="archive"
        options={{
          title: "Archived Evidence",
        }}
      />

      <Tabs.Screen
        name="deleted"
        options={{
          title: "Deleted Evidence",
        }}
      />
    </Tabs>
  );
}