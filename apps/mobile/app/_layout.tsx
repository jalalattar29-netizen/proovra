import { Stack } from "expo-router";
import { LocaleProvider } from "../src/locale-context";
import { AuthProvider } from "../src/auth-context";
import { ToastProvider } from "../src/toast-context";
import { initSentry } from "../src/sentry";
import { ErrorBoundary } from "../src/error-boundary";

export default function RootLayout() {
  initSentry();
  return (
    <ErrorBoundary>
      <LocaleProvider>
        <AuthProvider>
          <ToastProvider>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="(stack)/auth" />
              <Stack.Screen name="(stack)/capture" />
              <Stack.Screen name="(stack)/billing" />
              <Stack.Screen name="(stack)/case/[id]" />
              <Stack.Screen name="(stack)/evidence/[id]" />
              <Stack.Screen name="verify" />
            </Stack>
          </ToastProvider>
        </AuthProvider>
      </LocaleProvider>
    </ErrorBoundary>
  );
}
