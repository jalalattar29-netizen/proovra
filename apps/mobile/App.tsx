import { registerRootComponent } from "expo";
import { ExpoRoot } from "expo-router";

export function App() {
  return <ExpoRoot context={(require as any).context("./app")} />;
}

registerRootComponent(App);
