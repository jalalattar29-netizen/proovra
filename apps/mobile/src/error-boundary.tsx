import React from "react";
import { Pressable, Text, View, StyleSheet } from "react-native";
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

  handleReset = () => {
    // Recover in place — no dead-end that requires killing the app (audit §I15).
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.subtitle}>You can try again without reopening the app.</Text>
          <Pressable
            onPress={this.handleReset}
            accessibilityRole="button"
            accessibilityLabel="Try again"
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
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
  },
  button: {
    marginTop: spacing.lg,
    minHeight: 44,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.navy,
    alignItems: "center",
    justifyContent: "center"
  },
  buttonPressed: { opacity: 0.9 },
  buttonText: {
    fontSize: typography.size.body,
    color: colors.navy
  }
});
