import { Redirect } from "expo-router";
import { View, ActivityIndicator } from "react-native";
import { useAuth } from "../src/auth-context";
import { colors } from "@proovra/ui";

export default function Index() {
  const { token, authReady } = useAuth();
  if (!authReady) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.primaryNavy} />
      </View>
    );
  }
  if (!token) {
    return <Redirect href="/(stack)/auth" />;
  }
  return <Redirect href="/(tabs)" />;
}
