import React from "react";
import { Text, View, StyleSheet } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { captureException } from "./sentry";

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    captureException(error, { feature: "mobile_global_error" });
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.subtitle}>Please reopen the app and try again.</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    backgroundColor: colors.lightBg
  },
  title: {
    fontSize: typography.size.h3,
    color: colors.textDark,
    marginBottom: 8
  },
  subtitle: {
    fontSize: typography.size.body,
    color: "#64748b",
    textAlign: "center"
  }
});
