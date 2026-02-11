import { registerRootComponent } from "expo";
import { ExpoRoot } from "expo-router";

export function App() {
  return <ExpoRoot context={(require as unknown as (path: string) => { keys: () => string[] }).context("./app")} />;
}

registerRootComponent(App);
