import "react-native-get-random-values";
import { Buffer } from "buffer";

global.Buffer = Buffer;
import { registerRootComponent } from "expo";
import { ExpoRoot } from "expo-router";

export function App() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- require.context is Metro/bundler-specific
return <ExpoRoot context={(require as any).context("./app")} />;
}

registerRootComponent(App);
